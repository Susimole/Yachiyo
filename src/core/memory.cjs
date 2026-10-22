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

/**
 * 内存窗口里**主动消息**（识屏 / 自言语 / 睡前…）单独留多少条。
 *
 * ★★ 2026-10-22（外部审查 YCH-008，实测复现）：
 *
 *    改前只有一个窗口 —— `MAX_TURNS * 2 = 60` 条，**主动消息也算在里面**。
 *    实测：聊 5 轮真话之后，再塞 60 条主动消息 ⇒ `recent(skipProactive)` 返回 **0 条**，
 *    他再说一句，模型只看得到**他这一句**（前面 5 轮全被挤出内存窗口了）。
 *    文件里一条没丢（chat.jsonl 71 条都在），丢的是内存窗口。
 *
 *    ⚠️ 注意：真凶**不是** `recent()` 的过滤顺序（它就是在捡的循环里过滤的）。
 *       光改过滤救不了 —— 过滤得再干净，窗口里没剩下真话也是空的。
 *
 *    现在分两桶：真话 `MAX_TURNS * 2` 条、主动消息 `MAX_PROACTIVE` 条，各截各的。
 */
const MAX_PROACTIVE = 90;

/**
 * 她「主动说的」= 对话流里带 `kind` 且不是一问一答的那些。
 * （`记忆` 里 kind 只有写入方知道，这里只做分类）
 */
function isProactive(m) {
  return !!m && !!m.kind && m.kind !== '对话' && m.kind !== '快速问答';
}

/**
 * 按两类各自的额度裁剪内存窗口，**保持原来的先后顺序**。
 * ⚠️ 用对象引用做集合来挑（每条记录都是独立对象，没有重复引用）；
 *    拼接会打乱顺序 —— 顺序错了她读起来就是"倒着聊天"。
 */
function trimWindow(arr) {
  const talk = [];
  const pro = [];
  for (const m of arr) (isProactive(m) ? pro : talk).push(m);
  const keepTalk = talk.slice(-MAX_TURNS * 2);
  const keepPro = pro.slice(-MAX_PROACTIVE);
  if (keepTalk.length === talk.length && keepPro.length === pro.length) return arr;
  const keep = new Set([...keepTalk, ...keepPro]);
  return arr.filter((m) => keep.has(m));
}

/* ═══════════════ 短期 ═══════════════ */

function load() {
  if (loaded) return history;
  loaded = true;
  store.ensure();
  if (!fs.existsSync(FILE)) return history;

  try {
    // ⚠️ 先去 BOM —— 首行带 BOM 的话那一条会被下面判成坏行、静默跳过（白丢一句）
    const lines = fs.readFileSync(FILE, 'utf8').replace(/^﻿/, '').split('\n');
    const out = [];
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        const o = JSON.parse(ln);
        if (o && o.role && typeof o.content === 'string') out.push(o);
      } catch { /* 单行坏了跳过，不让一行毁掉整份历史 */ }
    }
    /*
     * ★ 2026-10-22：装载也走**两桶**（原来 `slice(-60)` 一刀切 ——
     *   重启一次，前面攒的主动消息就能把真话整个顶掉）。
     */
    history = trimWindow(out);
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
  /*
   * ⚠️ 截到 `MAX_TURNS * 2`，跟 `load()` 那边**同一个常数**（2026-10-16 修的）。
   *    原来这里写的是 `slice(-MAX_TURNS)` —— 一个「轮」一个「条」，
   *    跑久了内存里只剩 30 条，重启之后又是 60 条，
   *    于是学习 / 回顾 / 今日计数**长跑和重启后看到的历史不一样**。
   *    （`recent(30)` 两边都是 30 所以看不出来，只有 `recent(200)` 那种调用方会发现。）
   *
   * ★ 2026-10-22：改成**两桶各留各的**（真话 60 / 主动 90）——
   *   主动消息再多也挤不掉他真说的话（YCH-008）。
   *   ⚠️ **每次 push 都裁**：一开始写成"超过 60+90=150 才裁"，结果跑久了窗口是
   *     100 条、重启之后变 60 条 —— 「长跑和重启看到的不一样」那个老毛病又回来了
   *     （p2 那套自检当场逮到）。窗口上限就 150 条，每 push 扫一遍的开销可以忽略。
   */
  history = trimWindow(history);

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
 *
 * ★★ 2026-10-20 加了第二个参数 `opt`：
 *    `{ skipProactive: true }` = **跳过她主动说的那些**（识屏 / 自言自语 / 睡前…）。
 *
 *    他 2026-10-20 拍板的口径：「那些话**要留在聊天窗里给我看**，但**别喂进提示词**」。
 *    理由：识屏 20 分钟一条、自言语半小时一条，一天几十条 ——
 *    它们会把真正的对话挤出 60 条那个窗口，她聊着聊着就把刚才的对话忘了。
 *    ⇒ 记录照旧进对话流（`chat:history` 走的是不带这个参数的 `recent()`，能看到），
 *      只有**喂模型**那一路过滤。
 *
 *    ⚠️ 过滤是在**捡的循环里**做的，不是事后 filter —— 否则字符预算先被那些话吃掉，
 *       真正该给模型的对话反而被挤没了。
 */
function recent(maxTurns = MAX_TURNS, opt = {}) {
  load();
  const picked = [];
  let chars = 0;
  const skipProactive = opt && opt.skipProactive === true;
  /* ⚠️ `isProactive` 已提到模块顶层（窗口裁剪也要用同一套判定 —— 两处口径必须一致） */

  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (picked.length >= maxTurns) break;
    if (skipProactive && isProactive(m)) continue;

    /*
     * ⚠️⚠️ **最新那条不管多长都得留下**（2026-10-16 修的）。
     *
     *    原来一视同仁地卡字符预算：他往输入框里粘一大段日志（>12000 字），
     *    最新那条自己就超预算 → 一条都捡不到 → `recent()` 返回**空列表**
     *    → **请求里根本没有用户消息**，她的回答跟问题完全对不上。
     *
     *    所以：超预算就**截断**留下，别整条丢。截断按码点（`T.cut`），
     *    免得把一个 emoji 劈成半个（见 text.cjs）。
     *    ⚠️ 只对「最新这条」破例 —— 更早的还是该按预算停。
     */
    const room = MAX_CHARS - chars;
    if (m.content.length > room) {
      if (picked.length) break;                       // 已经捡到东西了，这条就算了
      picked.unshift({ role: m.role, content: T.cut(m.content, Math.max(200, room)) });
      break;
    }
    picked.unshift({ role: m.role, content: m.content });
    chars += m.content.length;
  }

  while (picked.length && picked[0].role !== 'user') picked.shift();
  return picked;
}

/**
 * ★★ 2026-10-22 新增（外部审查 YCH-007）：**给聊天窗看的那份历史**。
 *
 *   原来聊天窗走的是 `memory.recent(60)` —— 那是**喂模型**的 DTO，只有
 *   `{role, content}` 两个字段。于是聊天窗：
 *     · **分不出**哪句是聊天、哪句是识屏 / 自言语（`kind` 被丢了）；
 *     · 看不到时间（`ts` 被丢了），也点不开"她当时看到了什么"（`look` 也被丢了）；
 *     · 只能看到内存窗口那 60 条（`recent(60)` 的上限），翻不到更早的。
 *
 *   这里改成**从 chat.jsonl 尾部读**（文件里是全量，一条不少），
 *   返回完整记录：`{ role, content, ts, kind?, look? }`。
 *
 *   ⚠️ 刻意**不复用** `recent()`：一个给模型（字段越少越好）、一个给界面（字段越全越好）。
 *     两件事混用，就是这次这个 bug。
 *   ⚠️ 文件读不了就退回内存窗口 —— 聊天空白比"报错"更糟。
 *
 * @param {number} [max=200] 最多拿多少条（从最新往回数）
 */
function historyForDisplay(max = 200) {
  const n = Math.max(1, Number(max) || 200);
  try {
    if (fs.existsSync(FILE)) {
      const lines = fs.readFileSync(FILE, 'utf8').replace(/^﻿/, '').split('\n');
      const out = [];
      for (const ln of lines) {
        if (!ln.trim()) continue;
        try {
          const o = JSON.parse(ln);
          if (o && o.role && typeof o.content === 'string') out.push(o);
        } catch { /* 坏行跳过，别让一行毁掉整个聊天记录 */ }
      }
      if (out.length) return out.slice(-n);
    }
  } catch (err) {
    console.error('[memory] 展示历史读不了，退回内存窗口：' + err.message);
  }
  load();
  return history.slice(-n).map((m) => ({ ...m }));
}

/**
 * 某个时刻**之后**的消息 —— **带 ts** 的原始记录。
 *
 * ⚠️ 为什么另开一个：`recent()` 返回的 `{role, content}` 是**直接喂给模型的
 *    messages**，不敢多塞字段（有些服务端对未知字段很挑）。可回顾那条链
 *    需要"只看今天"，那就得有 `ts`。所以这条给的是**本地用的记录**。
 *
 * ⚠️ 它只看**内存窗口**（真话 60 + 主动 90，见 trimWindow）—— 他要是今天一口气聊了
 *    100 句，更早的那 40 句看不到。要全量得走 `historyForDisplay()`。
 */
function since(ms) {
  load();
  const t = Number(ms) || 0;
  return history.filter((m) => Number(m.ts) >= t);
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
      dropFromFile(role);
      return gone;
    }
  }
  return null;
}

/**
 * 从 `chat.jsonl` 里**只摘掉那一条**。
 *
 * ⚠️⚠️ 别改回「拿内存那份重写整份文件」（2026-10-15 修的，血泪）：
 *
 *    `history` 是**内存窗口**，不是全文 —— `load()` 只装最后 60 条（:51），
 *    `push()` 超过 60 还会一刀砍到 30（:64）。
 *    拿这个窗口去覆盖那个**一直在追加**的文件，等于把窗口以外的一次清光。
 *
 *    实测：手写 100 行 chat.jsonl → 一次聊天失败 → 文件只剩 **59** 行，
 *    **永久丢 41 条**。而触发条件就是最平常的那几个：
 *    key 错 / 超时 / 限流 / 他点「停止」—— 全走 brain.cjs:68 这一条。
 *    备份模块还把这个文件当主记录，丢了就真没了。
 *
 *    现在：**读全文 → 只摘一条 → 原子写回**。全文一行不多、一行不少。
 *    （`store.writeText` 是 tmp+rename，写一半崩了也不会留半截文件 ——
 *      原来那个 `fs.writeFileSync` 直写最终名，断电就废。）
 *
 * ⚠️ 认「最后一个匹配 role 的行」，不是「最后一行」——
 *    `push('user')` 之后可能还夹了别的，别想当然。
 */
function dropFromFile(role) {
  try {
    store.ensure();
    if (!fs.existsSync(FILE)) return;

    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter((s) => s.trim());
    for (let i = lines.length - 1; i >= 0; i--) {
      let o;
      try { o = JSON.parse(lines[i]); } catch { continue; }   // 坏行跳过，不让它挡路
      if (!role || o.role === role) { lines.splice(i, 1); break; }
    }
    store.writeText(FILE, lines.length ? lines.join('\n') + '\n' : '');
  } catch (err) {
    console.error('[memory] 撤销那一句写盘失败：' + err.message);
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
  FILE, FILE_SESSION, FILE_SPOKEN, MAX_TURNS, MAX_PROACTIVE,
  load, push, popLast, recent, since, historyForDisplay, todayCount, lastSeen, count, clear,
  saveSession, readSession, buildSessionBlock,
  addSpoken, readSpoken, recentSpoken, buildSpokenBlock,
  timeSense, saveLastExit, readLastExit,
};
