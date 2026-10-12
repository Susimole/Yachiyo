/**
 * 大脑 —— 把「她是谁 + 她记得什么 + 现在几点」拼成提示词，交给 provider。
 *
 * ⚠️ 提示词**不在这儿拼**，在 `prompt.cjs`。这个文件只管三件事：
 *    发问、记账、出错回滚。想加一段提示词就去改 `prompt.cjs`。
 *
 * ⚠️ 只在主进程跑。渲染进程连「她的人格长啥样」都不该知道 ——
 *    那是服务端的东西，而且 Key 也在这一侧。
 */

'use strict';

const cfg      = require('./config.cjs');
const memory   = require('./memory.cjs');
const usage    = require('./usage.cjs');
const provider = require('./provider.cjs');
const habits   = require('./habits.cjs');
const prompt   = require('./prompt.cjs');
const markers  = require('./markers.cjs');

/** 当前配置够不够发起一次对话 */
function ready() {
  const c = cfg.all();
  return { ok: !!c.apiKey, why: c.apiKey ? '' : '还没填 API Key' };
}

/**
 * 他说一句话，她去回。
 *
 * @param {string} text
 * @param {object} [o]
 * @param {function} [o.onDelta] 流式回调，收到一段新字就调一次
 * @param {string}   [o.chain]   哪条链（默认主对话）
 * @returns {Promise<{text:string, usage:object|null, cost:number, ms:number}>}
 */
async function reply(text, o = {}) {
  const c = cfg.all();
  const gate = ready();
  if (!gate.ok) throw new Error(gate.why + ' —— 右键菜单 → API 接入');

  memory.push('user', text);

  const messages = [
    { role: 'system', content: prompt.buildSystem({ userText: text, chain: o.chain || 'chat' }) },
    // ⚠️ 用 `=== false` 不用 `!memShort` —— 老配置升级上来时这个键可能不存在，
    //    取到 undefined，`!undefined` 会把对话历史整个清掉。
    ...(c.memShort === false ? [] : memory.recent(c.memShortCount || 30)),
  ];

  let out;
  try {
    out = await provider.chat({
      base: c.apiBase,
      key: c.apiKey,
      model: c.model,
      messages,
      thinking: c.thinking,
      reasoningEffort: c.thinkingDepth,
      temperature: c.temperature,
      thinkingStyle: c.thinkingStyle,
      onDelta: o.onDelta,
      signal: o.signal,
    });
  } catch (err) {
    // ⚠️ 失败了要把刚记下的那句【撤回来】。
    //    不撤的话，下一轮她看到「你说了一句话、我没有回」，
    //    会莫名其妙地道歉或者接错茬。
    memory.popLast('user');
    throw err;
  }

  /*
   * ★ 先把标记剥出来（3c）。
   *
   * ⚠️⚠️ 顺序不能反：**先剥标记，再入库、再显示**。
   *    标记是给她自己用的指令（比如 `[心情 差]`），
   *    要是先 push 了原文，那串方括号就永远留在对话历史里 ——
   *    下一轮她看见自己上一条带标记，会学着继续这么写；
   *    而且他翻开聊天窗也会看见那几个字。
   *
   * ⚠️ 流式那边（`onDelta`）推的已经是**没剥过的原文** —— 这是已知的：
   *    标记一般都在行首，等整段收完再剥、再覆盖显示就行。
   *    真要做好得做「行首缓冲」，那是后面几批标记变多了再说的事。
   */
  const parsed = markers.parse(out.text, { chain: o.chain || 'chat' });
  out.text = parsed.text;

  memory.push('assistant', out.text);

  // 这一轮梗库命中的热度，攒到现在一起落盘
  habits.flushHits();

  const yuan = provider.cost(out.usage, {
    in: c.priceIn, out: c.priceOut, hit: c.priceCacheHit,
  });
  usage.add(out.usage, yuan);

  return { ...out, cost: yuan };
}

module.exports = {
  ready, reply,
  // 人格相关的东西挪去 prompt.cjs 了，这儿转出去是为了不让老调用方断腿
  PERSONA_DIR: prompt.PERSONA_DIR,
  DEFAULT_PERSONA: prompt.DEFAULT_PERSONA,
  readPersona: prompt.readPersona,
  buildSystem: prompt.buildSystem,
};
