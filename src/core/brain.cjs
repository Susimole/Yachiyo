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
/*
 * ★ 「看屏幕」这个工具（2026-10-17 加的，方案乙 —— 他选工具调用而不是"标记 + 二次请求"）。
 * ⚠️ 它内部自己做三级降级：对话模型 → 识图模型 → 固定文案「什么都没看见...」。
 */
const looktool = require('./looktool.cjs');

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

  /*
   * ⚠️⚠️ **这三段的顺序是有讲究的**（2026-10-17 修的，清单 #10 #11）：
   *
   *   ① 先组提示词 —— 因为 `buildSystem` 要问 memory
   *      「他上次跟你说话是多久前」（`timeSense`）和「今天说了几句」（`todayCount`）。
   *      改前是**先 push、后组提示词**，于是这两个问题拿到的都是
   *      「刚推的这句话」：
   *        · 久别分支**一次都打不出来** —— 隔了 8 小时、3 天，提示词里
   *          都写「你俩刚还在说话」；
   *        · `todayCount` 每轮多报 1。
   *      实测改前：上次说话 8 小时前，推之前是「已经 8.0 小时了（是昨天）」，
   *      推之后变成「你俩刚还在说话。今天他已经跟你说过 1 句话。」
   *
   *   ② 再入库 —— 必须在组提示词之后、组 messages 之前。
   *
   *   ③ 最后组 messages —— 因为 `memory.recent()` 就是模型看到
   *      「他这一句」的**唯一来源**。所以入库必须发生在 recent() 之前，
   *      否则她收到的消息里根本没有他刚说的话（那就修出更大的毛病了）。
   */
  const sysPrompt = prompt.buildSystem({ userText: text, chain: o.chain || 'chat' });
  memory.push('user', text);

  const messages = [
    { role: 'system', content: sysPrompt },
    /*
     * ⚠️ 用 `=== false` 不用 `!memShort` —— 老配置升级上来时这个键可能不存在，
     *    取到 undefined，`!undefined` 会把对话历史整个清掉。
     *
     * ⚠️⚠️ 但**关掉短期记忆 ≠ 把他这句话也丢掉**（2026-10-17 修的，清单 #10）。
     *    改前这一支只给 `[system]` + 一个空列表 ⇒ **一条 user 消息都没有**，
     *    模型根本没收到他这一轮，只能答非所问。
     *    而 config 里那句注释写的是「关了就不带对话历史（**她只看得到今天这一句**）」——
     *    代码跟注释是反的。实测改前：messages 里 roles = [system]，0 条 user。
     *    ⇒ 关掉历史，就只带**当前这一句**。
     */
    ...(c.memShort === false
      ? [{ role: 'user', content: text }]
      : memory.recent(c.memShortCount || 30)),
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
      /*
       * ★ 只有**聊天链**才挂「看屏幕」这个工具（2026-10-17 加的）。
       *   ⚠️ 识屏 / 自言语 / 睡前那几条链**不该**有这个能力 —— 它们本来就看不见屏幕
       *      （识屏链自己会截图），给了工具反而会让她在自言自语里突然说"我看看"。
       */
      tools: (o.chain || 'chat') === 'chat' ? [looktool.TOOL] : undefined,
    });
  } catch (err) {
    // ⚠️ 失败了要把刚记下的那句【撤回来】。
    //    不撤的话，下一轮她看到「你说了一句话、我没有回」，
    //    会莫名其妙地道歉或者接错茬。
    memory.popLast('user');
    throw err;
  }

  /*
   * ★★ 模型要「看屏幕」（2026-10-17 加的，方案乙）。
   *
   *   流程：它说要调 `look_screen` ⇒ 我们**真截一次屏**（三级降级在 looktool 里）
   *         ⇒ 把描述当成 `role:'tool'` 的结果塞回去 ⇒ **再问一次**（这次不带 tools，
   *         免得它看完又要看、循环起来）。
   *
   *   ⚠️ 描述**也进聊天记录**（他明确要求：看完的描述要进记录）。
   *      挂在那条 assistant 消息的 `extra.look` 上 —— 她说的那句话照旧是正文，
   *      而"她当时看到了什么"就在旁边，翻记录时能对上。
   *   ⚠️ 工具调用本身不算"她开口"：`out.text` 可能是空的（只有 tool_calls），
   *      所以下面剥标记/入库那段要拿**第二次**的 `out`。
   */
  let lookDesc = '';
  /*
   * ★ 2026-10-18：**她是怎么看见的**也要记下来。
   *   原来只留 `lookDesc`（一段文字），可 `describe()` 明明还返回了
   *   `via`（chat / vision / blind）和耗时 —— 全被扔了。
   *   于是"我看见了"和"我说了一句固定文案"在记录里**长得一模一样**，
   *   这就是最难查的那种假成功。
   */
  let lookMeta = null;   // { desc, via, ms }
  if (Array.isArray(out.toolCalls) && out.toolCalls.length) {
    const call = out.toolCalls.find((t) => t.name === 'look_screen');
    if (call) {
      try {
        const r = await looktool.describe({ fromChat: true });
        lookDesc = r.text || looktool.BLIND;
        lookMeta = { desc: lookDesc, via: r.via || '', ms: r.ms || 0 };
      } catch (err) {
        lookDesc = looktool.BLIND;
        lookMeta = { desc: lookDesc, via: 'blind', ms: 0, why: 'describe 抛异常：' + err.message };
      }
      messages.push({
        role: 'assistant',
        content: out.text || null,
        tool_calls: out.toolCalls.map((t) => ({
          id: t.id || ('call_' + Math.random().toString(36).slice(2)),
          type: 'function',
          function: { name: t.name, arguments: t.args || '{}' },
        })),
      });
      messages.push({
        role: 'tool',
        tool_call_id: call.id || '',
        content: lookDesc,
      });
      try {
        // ⚠️ 第二次**不再带 tools**：看完就该说话，别再让它循环调工具
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
        // 第二次失败：至少把她看到了什么说出来，别让他白等
        out = { text: lookDesc, usage: out.usage, toolCalls: [] };
      }
    }
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

  /*
   * ⚠️ 只吐了标记、没吐正文时**别入库**（2026-10-16 修的）。
   *    否则 memory / chat.jsonl 里会攒下一堆 `content:""` 的空回合 ——
   *    实测 `markers.parse('[心情 不错]')` 之后 text 是空串。
   *    （提示词那边因为「开头必须是 user」会把它 shift 掉，所以看不见，
   *      但记录确实落盘了，而且会挤占 history 的条数窗口。）
   */
  if (out.text) {
    /*
     * ⚠️ 用了「看屏幕」的那一轮，把**她看到的**一起存下来（`extra.look`）——
     *    他要求「看完的描述要进聊天记录」。
     *    正文仍然是她说的话；描述挂在旁边，翻记录时能对上"她当时看到了什么"，
     *    而且**不污染对话流**（下一轮模型读到的是 `content`，不会把描述当成她说的话）。
     *
     * ★ 2026-10-18：`look` 从"一段文字"升级成 `{ desc, via, ms }`。
     *   ⚠️ 读老记录的人要兼容字符串（`typeof look === 'string'`）——
     *      2026-10-18 之前写进去的全是字符串。
     */
    memory.push('assistant', out.text, lookMeta ? { look: lookMeta } : {});
  }

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
