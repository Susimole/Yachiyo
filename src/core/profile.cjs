/**
 * 长期记忆 · 人物画像（「他心里关于你的那张纸」）。
 *
 * 跟习惯库的区别：
 *   · 习惯库是**一条一条攒**的，攒到几十条，永远在那儿。
 *   · 画像是**整份重写**的 —— 她隔几天坐下来，把攒的东西重新看一遍，
 *     自己写一段「他是个什么样的人」。所以它是会**变**的，
 *     而且旧版本要留档（他自己会说「你以前不是这么写我的」）。
 *
 * ⚠️ 三个硬闸（旧工程实测出来的）：
 *   ① 模型吐 **< 40 字** 当失败 —— 那多半是一句「好的，我写好了」这种
 *      对话式回复，不是画像。直接覆盖会把上一版好好的画像毁了。
 *   ② **> 4000 字** 截断 —— 她写嗨了会写成小作文，塞不进提示词。
 *   ③ **写之前先备份** —— 覆盖是不可逆的，备份是为了他能翻回去。
 */

'use strict';

const path = require('node:path');
const cfg = require('./config.cjs');
const store = require('./store.cjs');
const T = require('./text.cjs');
const { listForPrompt } = require('./habits.cjs');

const FILE = path.join(store.DATA, 'profile.md');

const HEAD = `# 他 · 人物画像

> 这是八千代自己一天天写下来的 —— 你是什么样的人、你们怎么相处。
> 她会隔几天重写一遍。直接改这个文件也行，改完她就照新的来。

`;

/** 提示词。⚠️ 这段是新工程自己写的 —— 旧工程的原文没挖到，别当逐字复刻。 */
const PROMPT = `你在给一个跟你一起过日子的人写一份「画像」——不是档案，是你心里关于他这个人是什么样。

把下面这些材料看一遍，然后**整个重写一遍**。

上一版画像（可能还准，也可能已经过时了，你自己判断该留什么该扔什么）：
--- 上版开始 ---
{prev}
--- 上版结束 ---

你平时注意到的事（一条一条攒下来的）：
--- 习惯开始 ---
{habits}
--- 习惯结束 ---

你们上次聊到的地方：
--- 近况开始 ---
{recent}
--- 近况结束 ---

要求：
- 用**小标题 + 短句**，像随手记的，不像简历。三级标题以内。
- 写你**真的看得出来**的东西。材料里没有的，宁可空着也别编。
- 可以写你在意但还拿不准的（写「好像」「可能是」），别写成定论。
- 别写场面话，别夸他，也别替他谦虚。你觉得他哪儿别扭，就写哪儿别扭。
- 称呼一律用「他」。不要用「你」「用户」「助手」。
- 只写**已经发生的事**，不要写「待确认」「接下来要」这种待办腔。
- 全文 **300~800 字**。不要在开头写「好的」或者复述我这番话。
- 直接给正文，第一行就是 Markdown 标题。

现在开始写。`;

/**
 * 读画像原文（没剔空槽的）。
 *
 * ⚠️ 剥文件头用的是**整段精确前缀比对**，不是正则。
 *    一开始我用正则 `^# 他 · 人物画像[\s\S]*?\n\n` —— 非贪婪会停在**第一个**
 *    空行上，也就是只剥掉了标题那一行，底下那两行「> 说明」全都当正文留下了，
 *    最后混进提示词里。
 *    而改成「遇到 # 或 > 就往下剥」也不行 —— 画像正文自己就带 `## 小标题`，
 *    会被一起剥掉。
 *    精确前缀是唯一没有歧义的做法（两边都先归一成 LF 再比）。
 */
function readRaw() {
  const t = store.readText(FILE);
  if (t == null) return '';
  const norm = t.replace(/\r\n/g, '\n');
  const head = HEAD.replace(/\r\n/g, '\n');
  return (norm.startsWith(head) ? norm.slice(head.length) : norm).trim();
}

/**
 * 给她看的那份：**剔掉空槽行**。
 *
 * 实际场景：模型重写时会写出 `- 他在意什么：` 这种只有标题没内容的行。
 * 原样喂回去，她读到的是「他在意的东西 = 空的」，说话就不敢碰这个话题了。
 */
function read() {
  return T.stripEmptySlots(readRaw());
}

/** 能不能用了 —— 画像还没写出来的时候别往提示词里塞一句空标题 */
function usable() {
  return read().length >= 20;
}

/**
 * 拼注入块。格式从旧工程逐字对的。
 * ⚠️ 标题和正文之间是**一个**换行（`T.CRLF`），不是空行。
 */
function buildBlock() {
  if (cfg.get('profileEnabled') === false) return '';
  if (!usable()) return '';

  return [
    '【你心里关于「他这个人」的画像】（是你自己这些天慢慢写下来、还会接着改的东西 —— 当背景用，别照着念、也别一条条报给他听）',
    read(),
  ].join(T.CRLF);
}

/**
 * 到没到该重写的日子。
 * 判据 = 文件最后修改时间超过 `profileRefreshDays` 天。文件不存在 → 该写。
 */
function due(now = Date.now()) {
  if (cfg.get('profileEnabled') === false) return false;
  const days = Number(cfg.get('profileRefreshDays')) || 3;
  const t = store.mtime(FILE);
  if (!t) return true;
  return (now - t) / 86400000 >= days;
}

/**
 * 重写一份。
 *
 * @param {object} o
 * @param {function} o.chat        provider.chat（传进来是为了让这个模块不直接依赖网络层，好测）
 * @param {object}   o.cfg        已经取好的配置（base/key/model/thinking/…）
 * @param {string}   [o.recent]   跨会话「最近发生的事」的文本
 * @returns {Promise<{ok:boolean, why?:string, backup?:string, chars?:number}>}
 */
async function rewrite({ chat, cfg: c, recent = '' }) {
  // ⚠️ 素材太少就别写。硬写出来的画像全是「他是个普通人」这种废话，
  //    而且会把上一版（也许还有内容）覆盖掉。
  const habits = listForPrompt().habits;
  if (habits.length < 3 && String(recent).trim().length < 200) {
    return { ok: false, why: `素材太少（习惯 ${habits.length} 条、近况 ${recent.length} 字），先攒攒` };
  }

  const prev = read() || '（还没有，这是第一版）';
  const body = PROMPT
    .replace('{prev}', prev)
    .replace('{habits}', habits.length ? habits.map((h) => `- ${h}`).join('\n') : '（还没有）')
    .replace('{recent}', recent.trim() || '（没有记录）');

  const out = await chat({
    base: c.apiBase, key: c.apiKey, model: c.model,
    messages: [{ role: 'user', content: body }],
    thinking: c.thinking, reasoningEffort: c.thinkingDepth, temperature: c.temperature,
  });

  let text = String(out.text || '').trim();

  // 闸①：太短 = 没写成，别覆盖
  if (text.length < 40) {
    return { ok: false, why: `只写出来 ${text.length} 字，太短，当作没写成` };
  }

  // 闸②：太长就截（截在行边界上，别把一句话劈两半）
  if (text.length > 4000) {
    const cut = text.slice(0, 4000);
    const nl = cut.lastIndexOf('\n');
    text = (nl > 2000 ? cut.slice(0, nl) : cut) + '\n\n（太长，截住了）';
  }

  // 闸③：写前备份
  let backup = '';
  if (store.readText(FILE) != null) {
    const stamp = T.stamp().replace(/[: ]/g, '-');
    backup = path.join(store.ARCHIVE, `profile-${stamp}.md`);
    store.writeText(backup, T.toCRLF(readRaw()) + '\n');
  }

  // 写盘统一 CRLF —— 他可能用记事本打开看，纯 LF 会显示成一大坨
  store.writeText(FILE, T.toCRLF(HEAD + text + '\n'));
  return { ok: true, backup, chars: text.length };
}

module.exports = { FILE, HEAD, read, readRaw, usable, buildBlock, due, rewrite, PROMPT };
