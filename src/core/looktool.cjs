/**
 * 「看屏幕」这个工具的实现（方案「乙」，2026-10-17 他定的）。
 *
 * 他要的规格（原话口径）：
 *   ① 优先用**对话模型**看（如果它有视觉模块）
 *   ② 对话模型没有视觉 / 视觉不可用 ⇒ 用**识图模型**（`screenModel`）
 *   ③ 识图模型**留空 / 超时 / 不可用** ⇒ 输出固定文案：
 *      `什么都没看见...（当前对话模型无视觉模块/识图模型不可用）`
 *   ④ 看完的描述要**进聊天记录**
 *
 * ⚠️⚠️ 「对话模型有没有视觉」**没有标准判断方法** —— 没有 `supports_vision` 这种字段。
 *    唯一可靠的做法是**带图发一次，报错就降级**。所以第一次看屏幕可能会白花一次
 *    被拒的请求（通常不花钱），之后就正常了。
 *    ⚠️ 这里**故意不做缓存**（不记"上次哪个能用"）：配置随时会被他改
 *       （换模型、换平台），缓存反而会出现"明明填了识图模型却还用旧的"。
 *       一次白试的代价很小，行为可预测更重要。
 *
 * ⚠️ 超时是**单独**的（25 秒），不走 `provider.chat` 那个总时长 ——
 *    识屏只是"顺手看一眼"，不该跟一句正经对话耗一样久。
 *    而且他明确要求"识图模型调用超时"要进降级链。
 */
'use strict';

const cfg = require('./config.cjs');
const capture = require('./capture.cjs');
const provider = require('./provider.cjs');

/** 单次"看图"最多等多久（他的降级链里有"超时"这一档，所以必须有个明确的数） */
const TIMEOUT_MS = 25000;

/** 三级都失败时的固定文案（他给的原话，别改字） */
const BLIND = '什么都没看见...（当前对话模型无视觉模块/识图模型不可用）';

/**
 * 让模型看图要说什么。
 * ⚠️ 要求"一两句话、不要寒暄、不要 markdown" —— 这段文本会**塞回对话**当工具结果，
 *    长了会把上下文撑爆，带格式又会污染她自己那句话。
 */
const ASK = '这是一张屏幕截图。请用中文、一两句话说清楚画面里最显眼的东西、他在干什么（用的是哪个软件、大概在做什么）。'
  + '不要寒暄，不要评价，不要用 markdown，不要分点。';

/** 给 `provider.chat` 套一个总时长上限（它自己那个 total 是给正经对话用的） */
function withTimeout(p, ms) {
  return Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('超时'), { tag: 'timeout' })), ms)),
  ]);
}

/**
 * 用指定模型看一次图。
 * @returns {Promise<string>} 描述（空串 = 它什么都没说）
 */
async function askOnce(model, shot, c) {
  const r = await withTimeout(provider.chat({
    base: c.apiBase,
    key: c.apiKey,
    model,
    messages: [
      { role: 'system', content: '你是一个只看图的助手，只回答你看到的东西。' },
      {
        role: 'user',
        content: [
          { type: 'text', text: ASK },
          // ⚠️ 顺序：**文字在前、图在后** —— 反过来有些服务会挑刺（跟 peeker 那边一致）
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + shot.buffer.toString('base64') } },
        ],
      },
    ],
    // ⚠️ 看图**不开思考模式**：要快；开了拖十几秒，而他的降级链只给 25 秒
    thinking: false,
    thinkingStyle: c.thinkingStyle,
    temperature: 0.3,
  }), TIMEOUT_MS);
  return String(r.text || '').trim();
}

/**
 * 真去看一眼屏幕，返回一段描述。
 *
 * @param {{fromChat?:boolean}} [o] 从聊天里触发（只影响日志措辞）
 * @returns {Promise<{text:string, via:string, why?:string}>}
 *          `via` = `chat` / `vision` / `blind`（他要知道"是谁看见的"）
 */
async function describe(o = {}) {
  const c = cfg.all();
  if (!c.apiKey) return { text: BLIND, via: 'blind', why: '没填 API Key' };

  /* ① 截屏 */
  let shot;
  try { shot = await capture.grab(cfg.get('screenCapture')); }
  catch (err) { return { text: BLIND, via: 'blind', why: '截屏出错：' + err.message }; }
  if (!shot || !shot.ok) return { text: BLIND, via: 'blind', why: '截屏没成：' + (shot && shot.why) };
  /*
   * ⚠️ 全黑**不算错**，是"没东西可看"（锁屏 / 屏幕关了 / 独占全屏）。
   *    但也别报"我看不见"那种话 —— 按他的固定文案走，语义一致。
   */
  if (shot.blank) return { text: BLIND, via: 'blind', why: '全黑' };

  /* ② 先让**对话模型**看（他排的第一优先） */
  const tried = [];
  try {
    const t = await askOnce(c.model, shot, c);
    if (t) return { text: t, via: 'chat' };
    tried.push('对话模型没说话');
  } catch (err) {
    tried.push('对话模型：' + err.message);
  }

  /* ③ 降级到**识图模型**（留空就直接走最后一步） */
  const vm = String(c.screenModel || '').trim();
  if (!vm) {
    return { text: BLIND, via: 'blind', why: tried.join(' / ') + ' / 识图模型留空' };
  }
  if (vm === c.model) {
    // 配成同一个模型就没必要再试一次（同样的错会再来一遍，白等 25 秒）
    return { text: BLIND, via: 'blind', why: tried.join(' / ') + ' / 识图模型跟对话模型是同一个' };
  }
  try {
    const t = await askOnce(vm, shot, c);
    if (t) return { text: t, via: 'vision' };
    tried.push('识图模型没说话');
  } catch (err) {
    tried.push('识图模型：' + err.message);
  }

  return { text: BLIND, via: 'blind', why: tried.join(' / ') };
}

/**
 * 工具定义（OpenAI 的 `tools` 格式）。
 * ⚠️ description 写得**具体**很重要 —— 模型靠它决定"该不该看"。
 *    他明确要求「必须是我明确说明需要看屏幕时才能看，避免出现关键词就去瞟一眼」，
 *    所以这里反复强调"只有他明确要求"。
 */
const TOOL = {
  type: 'function',
  function: {
    name: 'look_screen',
    description: '看一眼他现在的屏幕并告诉你上面有什么。'
      + '**只在他明确要求你看屏幕时使用**（比如"看看我屏幕""我屏幕上是什么""我这会在干嘛"）。'
      + '他只是在提到屏幕/聊天/工作而已的时候**不要**调用。一次对话最多调一次。',
    parameters: { type: 'object', properties: {}, required: [] },
  },
};

module.exports = { TIMEOUT_MS, BLIND, ASK, TOOL, describe, askOnce };
