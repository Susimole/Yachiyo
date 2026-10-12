/**
 * 记忆层 —— 短期对话历史 + 跨会话 + 「我说过什么」。
 *
 * 三层都在这个文件里，因为它们共用同一份对话历史：
 *
 *   **短期**（chat.jsonl）—— 你俩正在聊的。重启还在。
 *   **跨会话**（state/session.json）—— 上一次聊到哪儿。**退出时机械取**，不调模型。
 *   **我说过什么**（state/spoken.json）—— 她最近**自己主动**说过的话，防复读。
 *
 * 长期（习惯 / 梗 / 画像）在 habits.cjs 和 profile.cjs 里。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config.cjs');
const store = require('./store.cjs');
const T = require('./text.cjs');

const FILE = path.join(store.DATA, 'chat.jsonl');
const FILE_SESSION = path.join(store.STATE, 'session.json');
const FILE_SPOKEN = path.join(store.STATE, 'spoken.json');

/** 内存里的当前会话 —— 只放真正要进提示词的那些 */
let history = [];
let loaded = false;

/** 提示词里最多塞多少条对话（条数 + 字符数两道闸） */
const MAX_TURNS = 30;
const MAX_CHARS = 12000;

/* ═══════════════ 短期 ═══════════════ */

function load() {
  if (loaded) return history;
  loaded = true;
  store.ensure();
  if (!fs.existsSync(FILE)) return history;

  try {
    const lines = fs.readFileSync(FILE, 'utf8').split('\n');
    const out = [];
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const o = JSON.parse(ln);
        if (o && o.role && typeof o.content === 'string') out.push(o);
      } catch { /* 单行坏了跳过，不让一行毁掉整份历史 */ }
    }
    history = out.slice(-MAX_TURNS * 2);
  } catch (err) {
    console.error('[memory] 对话历史读不了，当空的用：' + err.message);
    history = [];
  }
  return history;
}

/** 记一条。role = 'user' | 'assistant' */
function push(role, content, extra = {}) {
  load();
  const rec = { role, content, ts: Date.now(), ...extra };
  history.push(rec);
  if (history.length > MAX_TURNS * 2) history = history.slice(-MAX_TURNS);

  try {
    store.ensure();
    fs.appendFileSync(FILE, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    // 写不了盘不该让她开不了口 —— 内存里的那份还在，这一轮照样能聊
    console.error('[memory] 历史写盘失败：' + err.message);
  }
  return rec;
}

/**
 * 给她看的那段历史。
 *
 * ⚠️ 两道闸一起用：条数管「别把最近的事挤掉」，字符数管「别把上下文撑爆」。
 *    只按条数截，他发一篇长文进来就爆了；只按字符数截，她可能把
 *    「你刚才说啥」和「我回啥」截成不对称的一对。
 *    所以从最新往回捡，捡到任一闸满为止，**并且保证开头一定是 user**
 *    （assistant 开头有些模型会犯迷糊）。
 */
function recent(maxTurns = MAX_TURNS) {
  load();
  const picked = [];
  let chars = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (picked.length >= maxTurns || chars + m.content.length > MAX_CHARS) break;
    picked.unshift({ role: m.role, content: m.content });
    chars += m.content.length;
  }

  while (picked.length && picked[0].role !== 'user') picked.shift();
  return picked;
}

/**
 * 把最后一条撤回来。
 *
 * 场景：他发了句话，模型那边挂了（Key 过期 / 断网 / 超时）。
 * 那句「他说的话」已经写进历史了，**必须撤掉** ——
 * 不撤的话下一轮她看到的是「你说了一句、我没回」，
 * 她会莫名其妙地道歉，或者接一个不存在的茬。
 */
function popLast(role) {
  load();
  for (let i = history.length - 1; i >= 0; i--) {
    if (!role || history[i].role === role) {
      const [gone] = history.splice(i, 1);
      rewriteFile();
      return gone;
    }
  }
  return null;
}

/** 内存改了以后把文件重写一遍。只有「撤回」会走到这儿。 */
function rewriteFile() {
  try {
    store.ensure();
    const body = history.map((m) => JSON.stringify(m)).join('\n');
    fs.writeFileSync(FILE, body ? body + '\n' : '', 'utf8');
  } catch (err) {
    console.error('[memory] 历史重写失败：' + err.message);
  }
}

/** 今天聊了多少句 —— 「最近说话」那块用得上 */
function todayCount() {
  load();
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return history.filter((m) => m.ts >= d.getTime() && m.role === 'user').length;
}

/** 把最近一次对话的时间捞出来 —— 隔了很久见面要说「好久不见」 */
function lastSeen() {
  load();
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') return history[i].ts;
  }
  return null;
}

function count() { load(); return history.length; }

function clear() {
  history = [];
  try { if (fs.existsSync(FILE)) fs.unlinkSync(FILE); } catch { /* 删不掉就算了 */ }
}

/* ═══════════════ 跨会话「最近发生的事」 ═══════════════ */

/**
 * 退出时**本地机械取**，不调模型。
 *
 * 旧工程原来是用模型压缩的（把这段对话压成摘要）。改成机械取的理由：
 *   · 0 请求、0 花费、0 等待
 *   · **杀进程也不丢**（模型那条链没跑完就被关掉的话，什么都没留下）
 *   · 摘要会「重新组织语言」，机械取不会 —— 她说「你们上次聊到这儿」
 *     的时候，摆的就是他**原话**，接得上。
 *
 * 规则（跟旧工程逐条对齐）：
 *   · 只要 **他说的**（`role='user'`）—— 她的独白占聊天记录 83%，混进来会淹掉重点
 *   · 丢掉 < 4 个字的（「嗯」「好」「在吗」这种，取出来毫无信息量）
 *   · 从**新到旧**累加，到 200 字就停
 *   · 再**倒回时间序**（不然读起来是从后往前，很怪）
 *   · 整段截 240 字，每行前面加 `- `
 */
function saveSession() {
  load();
  const picked = [];
  let chars = 0;

  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'user') continue;
    const c = String(m.content || '').trim();
    if (c.length < 4) continue;
    if (chars >= 200) break;
    picked.push(c);
    chars += c.length;
  }

  if (!picked.length) return null;
  picked.reverse();

  let text = picked.map((c) => `- ${c}`).join(T.CRLF);
  if (text.length > 240) text = T.clip(text, 240);

  const rec = { At: T.stamp(), Source: '本地机械取（退出）', Text: text };
  store.writeJson(FILE_SESSION, rec);
  return rec;
}

function readSession() {
  const v = store.readJson(FILE_SESSION, null);
  return v && typeof v.Text === 'string' ? v : null;
}

/** 拼「你们上次聊到这儿」。格式从旧工程逐字对的。 */
function buildSessionBlock() {
  if (cfg.get('midTermEnabled') === false) return '';
  const s = readSession();
  if (!s || !s.Text.trim()) return '';
  return [
    '【你们上次聊到这儿】',
    T.toCRLF(s.Text),     // ⚠️ 老数据可能是 LF 存的，进提示词前统一
    '（这是上一次聊天整理出来的**背景资料**，不是他这次刚说的话；他要是接着聊，顺着往下接就行，别当成他现在说的。）',
  ].join(T.CRLF);
}

/* ═══════════════ 「我说过什么」 ═══════════════ */

const SPOKEN_MAX = 200;
const SPOKEN_DAYS = 7;
const SPOKEN_KEEP = 3;

/**
 * 记一条「她自己主动说过的」。
 *
 * ⚠️ 只记**她主动开口**的（`proactive`），过程提示和思考过程**不算**。
 *    旧工程踩过：全量记的话，3 条里有 2 条是「正在看屏幕…」这种，
 *    真正要防复读的那句话反而被挤掉了。
 */
function addSpoken(kind, text) {
  const s = String(text || '').replace(/\s*\n\s*/g, ' ').trim();
  if (s.length < 2) return false;

  const cur = readSpoken();
  cur.Items.push({ t: T.stamp(), k: kind || '主动', s: T.clip(s, 120, '') });

  const cutoff = Date.now() - SPOKEN_DAYS * 86400000;
  cur.Items = cur.Items
    .filter((x) => !x.t || T.parseStamp(x.t) >= cutoff || T.parseStamp(x.t) === 0)
    .slice(-SPOKEN_MAX);
  cur.At = T.stamp();

  store.writeJson(FILE_SPOKEN, cur);
  return true;
}

function readSpoken() {
  const v = store.readJson(FILE_SPOKEN, null);
  if (!v || !Array.isArray(v.Items)) return { At: T.stamp(), Items: [] };
  return { At: v.At || '', Items: v.Items.filter((x) => x && typeof x.s === 'string') };
}

/** 最近 N 条（从尾巴上取） */
function recentSpoken(max = SPOKEN_KEEP) {
  return readSpoken().Items.slice(-max);
}

/** 拼「你最近自己说过的话」。格式从旧工程逐字对的。 */
function buildSpokenBlock() {
  const items = recentSpoken(SPOKEN_KEEP);
  if (!items.length) return '';
  return [
    '【你最近自己说过的话】（这些你已经跟他说过了，别原样再说一遍）',
    ...items.map((x) => `- [${x.k || '主动'}] ${x.s}`),
  ].join(T.CRLF);
}

/* ═══════════════ 给「时间块」用的两个数 ═══════════════ */

/**
 * 「你俩隔了多久」。旧工程 Get-AiTimeSenseHint 的输出，逐条对齐：
 *   <1 分钟      → 你俩刚还在说话。
 *   1..59 分钟   → 他上一次跟你说话是 N 分钟前。
 *   ≥60 分钟     → 距他上次跟你说话已经 H 小时了（就是今天/是昨天/是前天/M月d日）。
 *   距上次退出 ≥0.5 小时 → 她上一次自己关掉是 M月d日 HH:mm，到现在 H 小时。（独立可并存）
 */
function timeSense(now = Date.now()) {
  const lines = [];

  const last = lastSeen();
  if (last) {
    const min = (now - last) / 60000;
    if (min < 1) {
      lines.push('- 你俩刚还在说话。');
    } else if (min < 60) {
      lines.push(`- 他上一次跟你说话是 ${Math.round(min)} 分钟前。`);
    } else {
      const h = min / 60;
      const d = new Date(last);
      const today = new Date(now); today.setHours(0, 0, 0, 0);
      const dayDiff = Math.round((today.getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86400000);
      const when = dayDiff === 0 ? '就是今天' : dayDiff === 1 ? '是昨天' : dayDiff === 2 ? '是前天'
        : `${d.getMonth() + 1}月${d.getDate()}日`;
      lines.push(`- 距他上次跟你说话已经 ${h.toFixed(1)} 小时了（${when}）。`);
    }
  }

  const ex = readLastExit();
  if (ex) {
    const h = (now - ex) / 3600000;
    if (h >= 0.5) {
      const d = new Date(ex);
      lines.push(`- 她上一次自己关掉是 ${d.getMonth() + 1}月${d.getDate()}日 ${T.pad2(d.getHours())}:${T.pad2(d.getMinutes())}，到现在 ${h.toFixed(1)} 小时。`);
    }
  }

  if (!lines.length) return '';
  return [
    '【你俩隔了多久】',
    ...lines,
    '（⚠️ 拿它判断该怎么开口：隔几分钟就接着聊；隔了大半天就先问问他去哪儿了，别装作没这回事。）',
  ].join(T.CRLF);
}

const FILE_EXIT = path.join(store.STATE, 'last-exit.json');

/** 退出时记一笔 —— 「她上次自己关掉是几点」 */
function saveLastExit() {
  store.writeJson(FILE_EXIT, { At: T.stamp() });
}

function readLastExit() {
  const v = store.readJson(FILE_EXIT, null);
  return v && v.At ? T.parseStamp(v.At) : 0;
}

module.exports = {
  FILE, FILE_SESSION, FILE_SPOKEN, MAX_TURNS,
  load, push, popLast, recent, todayCount, lastSeen, count, clear,
  saveSession, readSession, buildSessionBlock,
  addSpoken, readSpoken, recentSpoken, buildSpokenBlock,
  timeSense, saveLastExit, readLastExit,
};
