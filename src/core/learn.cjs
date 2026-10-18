/**
 * 自动学习 —— 从聊天里提炼「习惯」和「梗」，这是长期记忆**唯一的写入途径**。
 *
 * 没有这个模块，习惯库和梗库就只能靠他手改 md 文件。
 *
 * ── 为什么不是「聊一句学一句」 ──
 * 每轮都提炼的话，一句「今天好累」会被记成「他容易累」这种垃圾。
 * 攒够 `autoLearnEveryRounds` 轮（默认 30）才动一次，样本够，提炼出来的
 * 才是**规律**不是**状态**。
 *
 * ── ⚠️ 提示词里必须把已有清单摆给模型看 ──
 * 旧工程踩得最惨的一个坑：「家常菜」滚成 9 条、「熬夜」11 条、《塔科夫》3 条 ——
 * 因为模型不知道已经记过什么，每学一次就换个说法再记一遍。
 * 所以 buildPrompt() 里把现有习惯/梗**全量列出来**，并明说不要重复。
 */

'use strict';

const path = require('node:path');
const cfg = require('./config.cjs');
const store = require('./store.cjs');
const T = require('./text.cjs');
const memory = require('./memory.cjs');
const habits = require('./habits.cjs');
const usage = require('./usage.cjs');
const provider = require('./provider.cjs');

const FILE = path.join(store.STATE, 'learn.json');
const FILE_PENDING = path.join(store.DATA, 'pending.md');

const PENDING_HEAD = `# 待确认

> 她从聊天里学到的东西先放这儿，你点头才会进习惯库 / 梗库。
> 想采纳：把行留下。不想采纳：**直接删掉那一行**。
> 格式：\`- [H] 习惯内容 [日期]\`（H = 习惯，M = 梗）

`;

/* ═══════════════ 轮次计数 ═══════════════ */

function state() {
  const v = store.readJson(FILE, null);
  return { rounds: 0, lastAt: '', ...(v && typeof v === 'object' ? v : {}) };
}

function saveState(s) { store.writeJson(FILE, s); }

/** 每轮对话调一次。返回「现在该不该学」。 */
function tick() {
  if (cfg.get('autoLearnEnabled') === false) return false;
  const s = state();
  s.rounds = (s.rounds || 0) + 1;
  saveState(s);
  const every = Number(cfg.get('autoLearnEveryRounds')) || 30;
  return s.rounds >= every;
}

/**
 * 攒够轮数了没有 —— `run()` 和退出那条路都该用**这一个**判据。
 *
 * ⚠️ 原来退出的判断写的是 `autoLearnEnabled`（总开关），
 *    于是 `autoLearnOnClose` 这个键**从来没被读过**：
 *    它默认是 true，可关掉之后行为一点不变 —— 一个拧不动的假旋钮。
 *    这里新开一个名字把两件事分开：
 *      · 总开关 `autoLearnEnabled` = "到底学不学"
 *      · `autoLearnOnClose`       = "关窗的时候要不要补一次"
 */
function due() {
  if (cfg.get('autoLearnEnabled') === false) return false;
  const s = state();
  const every = Number(cfg.get('autoLearnEveryRounds')) || 30;
  return (s.rounds || 0) >= every;
}

function resetRounds() {
  const s = state();
  s.rounds = 0;
  s.lastAt = T.stamp();
  saveState(s);
}

/* ═══════════════ 提炼 ═══════════════ */

const PROMPT = `下面是你们两个最近聊的一段。

从里面挑出**值得长期记住**的东西，一条一行，严格按这个格式：

习惯|<一句话>
梗|<词> = <意思>

什么算「习惯」：他**长期**是什么样 —— 作息、口味、脾气、口头禅、在意什么、说话方式。
  不要记这一次发生的事。「他今天加班到十点」不算，「他常加班到很晚」才算。

什么算「梗」：他说某个词是什么意思，或者你们之间某个说法的由来。

硬性要求：
- 每条**一句话**，20 字以内。不要编号，不要解释，不要写日期。
- **最多各 3 条。没有就一行都别写** —— 宁可什么都不输出，也**不许硬凑**。
- 不要记隐私（密码、住址、身份证、账号、公司内部信息）。
- 不要记工具噪音（正在装什么软件、报了什么错、在跑什么命令）。
- 不确定的，在内容最前面加 \`[?]\`，比如 \`习惯|[?]他好像不太爱吃甜的\`。

⚠️ 下面这些**已经记过了**，一个字都不要重复：
--- 已有习惯 ---
{habits}
--- 已有梗 ---
{memes}
---

最近的聊天：
--- 聊天开始 ---
{chat}
--- 聊天结束 ---

直接给结果。不要写「好的」「以下是」。

现在开始。`;

/** 把聊天记录拼成给模型看的样子 —— 只带**他说的**和**她回的**，别人没有 */
function recentChat(max = 60) {
  memory.load();
  const all = [];
  for (const m of memoryLoadRaw()) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const who = m.role === 'user' ? '他' : '八千代';
    all.push(`${who}：${String(m.content || '').trim()}`);
  }
  return all.slice(-max).join('\n');
}

/** memory 模块没导出原始数组，从 recent 的大窗口里拿 */
function memoryLoadRaw() {
  return memory.recent(200);
}

function buildPrompt() {
  const { habits: hs, memes: ms } = habits.listForPrompt();
  /*
   * ⚠️ 替换值包成函数 —— 见 profile.cjs 同款注释：
   *    直接传字符串的话，他聊到钱、或正文里带 `$&` `$'` 这类序列时，
   *    `replace` 会把它们**当特殊序列展开**，提示词当场被撑坏。
   */
  return PROMPT
    .replace('{habits}', () => (hs.length ? hs.map((h) => `- ${h}`).join('\n') : '（还没有）'))
    .replace('{memes}', () => (ms.length ? ms.map((m) => `- ${m}`).join('\n') : '（还没有）'))
    .replace('{chat}', () => recentChat());
}

/* ═══════════════ 解析 ═══════════════ */

/**
 * 解析模型输出。**宽松** —— 多一行空行、多一句废话都不该让整次学习作废。
 * 只认行首是 `习惯|` 或 `梗|` 的行，别的全忽略。
 */
function parse(text) {
  const out = { habits: [], memes: [] };
  const seen = new Set();

  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim().replace(/^[-*]\s+/, '');
    const m = /^(习惯|梗)\s*[|｜]\s*(.+)$/.exec(line);
    if (!m) continue;

    let body = m[2].trim().replace(/^\[[?？]\]\s*/, '');
    const unsure = /^\[[?？]\]/.test(m[2].trim());
    if (body.length < 2 || body.length > 60) continue;

    const key = `${m[1]}|${body}`;
    if (seen.has(key)) continue;      // 模型自己写重了
    seen.add(key);

    if (m[1] === '习惯') {
      if (out.habits.length >= 3) continue;
      out.habits.push({ text: body, unsure });
    } else {
      if (out.memes.length >= 3) continue;
      const i = body.indexOf('=');
      if (i < 0) continue;
      const left = body.slice(0, i).trim();
      const mean = body.slice(i + 1).trim();
      const parts = left.split('/').map((x) => x.trim()).filter(Boolean);
      if (!parts.length || !mean) continue;
      out.memes.push({ word: parts[0], aliases: parts.slice(1), mean, unsure });
    }
  }
  return out;
}

/* ═══════════════ 落库 / 待确认 ═══════════════ */

/** 待确认文件的每一行 → 结构化 */
function readPending() {
  const txt = store.readText(FILE_PENDING);
  if (txt == null) return [];
  const out = [];
  for (const rawLine of txt.split(/\r?\n/)) {
    const m = /^[-*]\s*\[([HM])\]\s*(.+?)\s*$/.exec(rawLine.trim());
    if (!m) continue;
    out.push({ kind: m[1] === 'H' ? 'habits' : 'memes', body: m[2] });
  }
  return out;
}

function addPending(items) {
  if (!items.length) return 0;
  if (store.readText(FILE_PENDING) == null) store.writeText(FILE_PENDING, PENDING_HEAD);

  const lines = items.map((x) => x.kind === 'habits'
    ? `- [H] ${x.body} [${T.day()}]`
    : `- [M] ${x.body}`);
  store.appendText(FILE_PENDING, lines.join('\n') + '\n');
  return lines.length;
}

/** 真的写进库 */
function commit(parsed) {
  let n = 0;
  for (const h of parsed.habits) if (habits.addHabit(h.text)) n++;
  for (const m of parsed.memes) if (habits.addMeme(m.word, m.aliases, m.mean)) n++;
  return n;
}

/**
 * 学到的结果怎么处理。
 * `learnNeedConfirm` 打开 → 全进待确认（他点头才进库）；关掉 → 直接进库。
 * ⚠️ 模型自己标了 `[?]` 的，**不管开关怎么设都进待确认** ——
 *    它自己都不确定的东西，不该悄悄变成她的记忆。
 */
function apply(parsed) {
  const needConfirm = cfg.get('learnNeedConfirm') !== false;

  const sure = { habits: [], memes: [] };
  const unsureItems = [];

  for (const h of parsed.habits) {
    (h.unsure ? unsureItems : sure.habits).push({ kind: 'habits', body: h.text });
  }
  for (const m of parsed.memes) {
    const body = `${m.word}${m.aliases.length ? ' / ' + m.aliases.join(' / ') : ''} = ${m.mean}`;
    (m.unsure ? unsureItems : sure.memes).push({ kind: 'memes', body });
  }

  let wrote = 0, pending = 0;

  if (needConfirm) {
    const all = [...sure.habits, ...sure.memes, ...unsureItems];
    pending = addPending(all);
  } else {
    wrote = commit(sure);
    pending = addPending(unsureItems);
  }

  return { wrote, pending, unsure: unsureItems.length, needConfirm };
}

/**
 * 跑一次完整的学习。
 * @param {object} o
 * @param {function} o.chat  provider.chat
 * @param {object}   o.cfg   取好的配置
 */
async function run({ chat, cfg: c }) {
  const chatText = recentChat();
  if (chatText.length < 200) return { ok: false, why: '聊天太少，没什么可学的' };

  const out = await chat({
    base: c.apiBase, key: c.apiKey, model: c.model,
    messages: [{ role: 'user', content: buildPrompt() }],
    thinking: c.thinking, reasoningEffort: c.thinkingDepth, temperature: c.temperature,
  });

  /*
   * ⚠️ 记账（2026-10-16 补的）。
   *
   *    这是**真花钱**的一次调用，可原来 `out.usage` 直接被丢掉了 ——
   *    `usage.add` 全仓只在 brain / peeker / review / selftalk 里调过。
   *    后果有两层：「用量与成本」长期偏低；而「花超了提醒我」
   *    （`usage.overLimit`，见 #26）就是按这本账判的，也算不准。
   *    口径跟 brain.cjs 的记账那段保持一致。
   */
  try {
    usage.add(out.usage, provider.cost(out.usage, {
      in: c.priceIn, out: c.priceOut, hit: c.priceCacheHit,
    }));
  } catch { /* 记不上账不该拦住学习 */ }

  const parsed = parse(out.text);
  const n = parsed.habits.length + parsed.memes.length;
  if (!n) { resetRounds(); return { ok: true, learned: 0, why: '这次没挑出该记的' }; }

  const res = apply(parsed);
  resetRounds();
  return { ok: true, learned: n, ...res, raw: out.text };
}

/* ═══════════════ 待确认面板要用的两个动作 ═══════════════ */

/** 全部采纳 */
function acceptPending() {
  const items = readPending();
  let n = 0;
  for (const it of items) {
    if (it.kind === 'habits') {
      if (habits.addHabit(it.body.replace(/\s*\[\d{4}-\d{2}-\d{2}\]\s*$/, ''))) n++;
    } else {
      const i = it.body.indexOf('=');
      if (i < 0) continue;
      const parts = it.body.slice(0, i).split('/').map((x) => x.trim()).filter(Boolean);
      if (habits.addMeme(parts[0], parts.slice(1), it.body.slice(i + 1).trim())) n++;
    }
  }
  store.writeText(FILE_PENDING, PENDING_HEAD);
  habits.flushHits();
  return n;
}

/** 全部丢掉 */
function dropPending() {
  const n = readPending().length;
  store.writeText(FILE_PENDING, PENDING_HEAD);
  return n;
}

module.exports = {
  FILE, FILE_PENDING, PENDING_HEAD, PROMPT,
  tick, resetRounds, state, due,
  buildPrompt, parse, apply, run,
  readPending, addPending, acceptPending, dropPending,
};
