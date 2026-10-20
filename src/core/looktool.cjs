/**
 * 「看屏幕」这个工具的实现（方案「乙」，2026-10-17 他定的；**2026-10-20 砍成两档**）。
 *
 * ★★ 2026-10-20 他拍板的改动。原话：「市面上大多数模型都有视觉模块，所以感觉单独拉
 *    一个视觉模型配置项有点不太方便」→ 他选「只删除识图地址/密钥/模型」。
 *
 *    于是：删掉 `screenBase` / `screenKey` / `screenModel` 三格，识图**永远跟对话模型走**；
 *    降级链从三级变两级 —— **对话模型 → 那句提示**。
 *
 *    判断"这个模型有没有视觉"仍然**只能真发一次**（没有 `supports_vision` 这种字段），
 *    被服务端明确拒绝时（`provider` 标的 `noVision`）用这句：
 *    `当前对话模型不具备视觉模块`（他给的原文，一个字别改）。
 *
 * ⚠️ 代价写在这儿，省得以后再讨论一遍：**想用另一家的模型看图，做不到了** ——
 *    要换平台只能整体切预设。这是有意的取舍：两套连接能各说各话，正是
 *    2026-10-18 那条 400「拿 kimi 的型号去问 deepseek」的根源。
 * ⚠️ 还有一件**技术上做不到**的事：认不出"收了图但瞎说"（`deepseek-v4-pro` 实测
 *    不报错，问颜色答「未知」）。那种只能靠 `look.log` 里 `via=chat` 但描述空/离谱看。
 *
 * ⚠️ 超时是**单独**的（25 秒），不走 `provider.chat` 那个总时长 ——
 *    识屏只是"顺手看一眼"，不该跟一句正经对话耗一样久。
 */
'use strict';

const cfg = require('./config.cjs');
const capture = require('./capture.cjs');
const provider = require('./provider.cjs');
const store = require('./store.cjs');
const path = require('node:path');

/** 单次"看图"最多等多久 */
const TIMEOUT_MS = 25000;

/**
 * 没看成（截屏失败 / 网络不通 / 模型没回话）时她说的那句。
 * ⚠️ 2026-10-20 改过措辞：原文里带着「识图模型不可用」，可那一档已经删了。
 */
const BLIND = '什么都没看见...（这次没看成：截屏失败 / 网络不通 / 模型没回话）';

/**
 * ★★ 2026-10-20：**他 2026-10-20 亲口给的文案，一个字都不能改**。
 *    触发条件 = 服务端明确拒绝图片（`provider` 的 `noVision`）。
 */
const NOVISION = '当前对话模型不具备视觉模块';

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
 * ★★ 2026-10-20：把"这台机器上的对话模型看不了图"**落一个文件**。
 *
 *   原来这件事只有一行日志（`log.error('识屏', …)`），而 `plog()` 那种日志
 *   在非探针模式下压根不写 —— 他又是**关掉客户端才想起来"她怎么不说话"**的人，
 *   所以光写日志等于没留证据。
 *   ⇒ 落 `data/state/vision.json`，设置面板「连接」那组拿它显示一行红字。
 *
 *   ⚠️ 只在**服务端明确拒绝**时写（`provider` 的 `noVision`）；网络错、超时不算。
 *   ⚠️ 不节流到"只写一次"：每次照写，节流在**显示那一侧**做（1 小时内只提示一次）。
 */
const VSTATE = path.join(store.DATA, 'state', 'vision.json');

function noteNoVision(why) {
  try {
    store.writeJson(VSTATE, {
      at: Date.now(),
      model: String(cfg.get('model') || ''),
      why: String(why || '').slice(0, 300),
    });
  } catch { /* 记不下来不该影响她看屏幕 */ }
}

/** 读那条"没视觉"的记录（没有就返回 null）；给 IPC 和设置面板用 */
function noVisionState() {
  try {
    const o = store.readJson(VSTATE, null);
    return o && typeof o === 'object' && o.at ? o : null;
  } catch { return null; }
}

/**
 * 每次看一眼都记一行 —— **这是唯一能证明"是哪一档给的"的东西**。
 *
 * ⚠️⚠️ 为什么非要有（2026-10-18）：`describe()` 明明返回 `via` / `why`，
 *    可 `brain.cjs` 只取了 `r.text`，两个都扔了。⇒ 跑完只知道她说了什么，
 *    不知道是**对话模型看见的**还是**那句固定文案**。
 *    这正是「假成功」最爱的土壤：文案一模一样，谁也分不出来。
 *
 * ⚠️ 不记密钥、不记 URL 的查询串，只留 host（地址本身不是秘密）。
 */
const LOG = path.join(store.DATA, 'look.log');

function logLook(fields) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const t = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  const parts = [t];
  for (const k of Object.keys(fields)) {
    const v = fields[k];
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${k}=${v}`);
  }
  try { store.appendText(LOG, parts.join(' ') + '\n'); } catch { /* 日志写不了不该影响她看屏幕 */ }
}

/** 地址只留 host + path，别把 token 之类的东西带进日志 */
function briefBase(b) {
  try { const u = new URL(b); return u.host + u.pathname; } catch { return String(b || '?'); }
}

/**
 * 用指定模型看一次图。
 * @returns {Promise<string>} 描述（空串 = 它什么都没说）
 */
async function askOnce(model, shot, conn) {
  const r = await withTimeout(provider.chat({
    base: conn.base,
    key: conn.key,
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
    /*
     * ⚠️ 看图**不开思考模式**：要快；开了拖十几秒，而他的降级链只给 25 秒。
     *
     * ★★ 2026-10-18：**不发 temperature**（原来是 0.3）。
     *    实测 `kimi-k2.6` 只认 1 —— 传 0.3 直接 400「only 1 is allowed」，
     *    而降级链里那条错误会被当成"识图模型不可用"，看着像没配。
     *    不传 = 各家自己默认，两边都吃得下。
     */
    thinking: false,
    thinkingStyle: conn.thinkingStyle,
  }), TIMEOUT_MS);
  return String(r.text || '').trim();
}

/**
 * 真去看一眼屏幕，返回一段描述。
 *
 * @param {{fromChat?:boolean}} [o] 从聊天里触发（只影响日志措辞）
 * @returns {Promise<{text:string, via:string, why?:string, ms:number, model?:string}>}
 *          `via` = `chat`（看见了）/ `noVision`（模型没视觉）/ `blind`（没看成）
 */
async function describe(o = {}) {
  const c = cfg.all();
  const t0 = Date.now();
  /*
   * ★ 2026-10-20：**只剩一套连接** —— 就是主对话那套。
   *   删掉三格之后这里不再有"回落到谁"的问题，也就没有"型号一套、地址另一套"的地雷。
   */
  const conn = {
    base: String(c.apiBase || ''),
    key: String(c.apiKey || ''),
    model: String(c.model || ''),
    thinkingStyle: c.thinkingStyle,   // 各家思考开关的字段名不一样，照主对话那套走
  };
  const shotInfo = (shot) => ({
    px: shot && shot.w ? `${shot.w}x${shot.h}` : '',
    kb: shot && shot.buffer ? Math.round(shot.buffer.length / 1024) + 'kb' : '',
  });
  const done = (res, extra) => {
    const s = shotInfo(extra && extra.shot);
    logLook({
      from: o.fromChat ? 'chat' : 'probe',
      via: res.via,
      model: res.model || '',
      base: briefBase(res.base || ''),
      ms: Date.now() - t0,
      px: s.px, kb: s.kb,
      why: res.why || '',
    });
    return Object.assign({ ms: Date.now() - t0 }, res);
  };

  if (!conn.key) return done({ text: BLIND, via: 'blind', why: '没填 API Key', base: conn.base });
  if (!conn.model) return done({ text: BLIND, via: 'blind', why: '没填模型名', base: conn.base });

  /* ① 截屏 */
  let shot;
  try { shot = await capture.grab(cfg.get('screenCapture')); }
  catch (err) { return done({ text: BLIND, via: 'blind', why: '截屏出错：' + err.message }); }
  if (!shot || !shot.ok) return done({ text: BLIND, via: 'blind', why: '截屏没成：' + (shot && shot.why) });
  /*
   * ⚠️ 全黑**不算错**，是"没东西可看"（锁屏 / 屏幕关了 / 独占全屏）。
   *    但也别报"我看不见"那种话 —— 按固定文案走，语义一致。
   */
  if (shot.blank) return done({ text: BLIND, via: 'blind', why: '全黑' }, { shot });

  /* ② 就用**对话模型**看（2026-10-20 起没有第二档了） */
  try {
    const t = await askOnce(conn.model, shot, conn);
    if (t) return done({ text: t, via: 'chat', model: conn.model, base: conn.base }, { shot });
    return done({
      text: BLIND, via: 'blind', model: conn.model, base: conn.base, why: '模型没说话',
    }, { shot });
  } catch (err) {
    /*
     * ★★ 服务端明确拒绝图片 ⇒ 就是「这个模型没有视觉」。
     *    ⚠️ 这是**唯一**能被自动认出来的情况；"收了图但瞎说"认不出来（见文件头）。
     */
    if (err && err.noVision) {
      noteNoVision(err.message);
      return done({
        text: NOVISION, via: 'noVision', model: conn.model, base: conn.base, why: err.message,
      }, { shot });
    }
    return done({
      text: BLIND, via: 'blind', model: conn.model, base: conn.base, why: err.message,
    }, { shot });
  }
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

module.exports = {
  TIMEOUT_MS, BLIND, NOVISION, ASK, TOOL, describe, askOnce,
  noteNoVision, noVisionState, VSTATE, LOG,
};
