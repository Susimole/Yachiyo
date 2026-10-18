/**
 * 目标 —— 她想为你做成一件事，会一直记着，试过几次会写进展。
 *
 * 存 `data/她的目标.json`。
 *
 * ⚠️⚠️ 一条**铁规矩**，别为了让数据好看而放松它：
 *
 *      **「出处」少于 2 字 → 整条丢掉。**
 *
 *      出处 = 「这句话是从哪儿来的」（他说过的话 / 聊天里提过一次 / 她看见的）。
 *      没有出处的目标，是模型**凭空编出来**的 —— 表现就是她某天突然开始
 *      坚持一件谁也没说过的事，而且怎么问都说不清为什么。
 *      旧工程是被这个坑教育过的，所以宁可少攒，也不收没根的目标。
 *
 * ⚠️ 目标**不进「待确认」**。别的记忆（习惯/梗）拿不准会挂起来问一句；
 *    目标要是也走那条路，她会天天来请示「我猜你想减肥，对吗」—— 烦人。
 *    所以：**要么有出处直接收，要么丢了**。
 *
 * ⚠️ 键名一律用**英文**。旧工程那边是中文键（为了 PowerShell 好读），
 *    新工程是 JS，英文键不会被编码 / 转义咬到。文件他照样能打开看。
 */

'use strict';

const path = require('node:path');
const cfg = require('./config.cjs');
const store = require('./store.cjs');
const T = require('./text.cjs');

const FILE = path.join(store.DATA, '她的目标.json');

/** 目标的类型 —— 决定它能活多久（见 LIFE） */
const TYPES = ['关心', '渴望', '好奇', '约定', '其它'];

/**
 * 各类目标的寿命（天）。
 * ⚠️ 「关心」（想让他少熬夜这种）给最长 21 天 —— 那是需要时间才看得出来的事，
 *    一周就过期等于没提。「好奇」「约定」短，那些本来就是一时兴起。
 */
const LIFE = { 关心: 21, 渴望: 30, 好奇: 7, 约定: 7, 其它: 21 };

/** 注入提示词最多带几条（旧工程 2 —— 带多了她会像是在念待办清单） */
const HINT_MAX = 2;

/* ── 读写 ───────────────────────────────────────────────── */

function readAll() {
  const v = store.readJson(FILE, null);
  if (!v || typeof v !== 'object') return { goals: [] };
  if (!Array.isArray(v.goals)) v.goals = [];
  return v;
}

function writeAll(o) { return store.writeJson(FILE, o); }

/*
 * ⚠️ 秒级时间戳**不够**（2026-10-16 修的）—— 同一秒加两条会撞 ID，
 *    之后按 id 去改状态就改到错的那条上（跟 heritems.cjs 的 stampId 同一个坑）。
 *    补毫秒 + 进程内自增序号。
 */
let idSeq = 0;
function stamp(now = new Date()) {
  const base = `${T.day(now).replace(/-/g, '')}${T.pad2(now.getHours())}${T.pad2(now.getMinutes())}${T.pad2(now.getSeconds())}`;
  return `${base}${String(now.getMilliseconds()).padStart(3, '0')}${String(++idSeq % 1000).padStart(3, '0')}`;
}

/* ── 加一条 ─────────────────────────────────────────────── */

/**
 * @param {object} o
 * @param {string} o.want   想要什么（≥2 字）
 * @param {string} o.from   出处（**≥2 字，否则整条丢**）
 * @param {string} [o.type] 类型，不认就当「其它」
 * @param {string} [o.who]  '他的' | '我的'
 * @returns {{ok:boolean, why:string, id?:string}}
 */
function add(o = {}) {
  const want = String(o.want || '').trim().replace(/[\r\n]+/g, ' ');
  const from = String(o.from || '').trim().replace(/[\r\n]+/g, ' ');

  // ★ 这两条是硬闸，别动
  if (want.length < 2) return { ok: false, why: '「想要」太短，不要' };
  if (from.length < 2) return { ok: false, why: '没有出处 —— 不收（会变成凭空冒出来的执念）' };

  const all = readAll();

  // 完全一样的去重（旧工程按字面比，不做相似度 —— 目标宁可有两条近似的，
  // 也别把"想让他早点睡"和"想让他别熬夜"当成一条给合了）
  if (all.goals.some((g) => g && g.want === want)) {
    return { ok: false, why: '已经有了，不重复记' };
  }

  const type = TYPES.includes(o.type) ? o.type : '其它';
  const now = new Date();
  const id = 'g' + stamp(now);
  const days = LIFE[type] || 21;

  const g = {
    id,
    written: T.stamp(now),
    who: o.who === '我的' ? '我的' : '他的',
    want,
    type,
    from,
    tries: [],
    saidTimes: 0,
    lastSaid: '',
    due: T.day(new Date(now.getTime() + days * 86400000)),
    status: '进行中',            // 进行中 | 淡了 | 搁下了 | 达成
  };

  all.goals.push(g);
  if (!writeAll(all)) return { ok: false, why: '写盘失败' };

  console.log(`[goals] + ${type}「${want}」（出处：${from}）· ${days} 天后到期`);
  return { ok: true, why: '', id };
}

/* ── 推进 / 改状态 ──────────────────────────────────────── */

/** 记一次「试过了」。`useful` = 有没有用（没用的也要记，她知道哪条路走不通） */
function addTry(id, o = {}) {
  const all = readAll();
  const g = all.goals.find((x) => x && x.id === id);
  if (!g) return false;
  if (!Array.isArray(g.tries)) g.tries = [];
  g.tries.push({
    at: T.stamp(new Date()),
    what: String(o.what || '').slice(0, 60),
    result: String(o.result || '').slice(0, 60),
    useful: !!o.useful,
  });
  if (g.tries.length > 6) g.tries = g.tries.slice(-6);
  writeAll(all);
  return true;
}

function setStatus(id, status) {
  const OK = ['进行中', '淡了', '搁下了', '达成'];
  if (!OK.includes(status)) return false;
  const all = readAll();
  const g = all.goals.find((x) => x && x.id === id);
  if (!g) return false;
  g.status = status;
  writeAll(all);
  return true;
}

/* ── 每天判一次 ─────────────────────────────────────────── */

/**
 * 过期的搁下。
 *
 * ⚠️ 旧工程还有一条「关心类目标 → 看他有没有熬到凌晨 → 判达成」，
 *    那条**依赖「最后活动时间」**（那是心跳/在场那条链的东西，第 4 步才有）。
 *    所以这里**只做到期搁下**，熬夜判定等第 4 步接上「最后活动」再补。
 *    宁可少判，也别拿一个不准的数字去判她"达成了"。
 */
function tick(now = new Date()) {
  const all = readAll();
  const today = T.day(now);
  let n = 0;
  for (const g of all.goals) {
    if (!g || g.status !== '进行中' || !g.due) continue;
    if (g.due < today) { g.status = '搁下了'; n++; }
  }
  if (n) { writeAll(all); console.log(`[goals] ${n} 条过期搁下了`); }
  return n;
}

/* ── 注入 ───────────────────────────────────────────────── */

/**
 * 挑最多 2 条活跃的进提示词。
 * ⚠️ 挑的是**最新的**（数组末尾），不是最老的 —— 刚记下的最相关。
 */
function active(n = HINT_MAX) {
  const all = readAll();
  return all.goals.filter((g) => g && g.status === '进行中').slice(-n);
}

function buildBlock() {
  if (cfg.get('goalEnabled') === false) return '';
  const list = active();
  if (!list.length) return '';

  const lines = ['【你心里惦记着的事】'];
  for (const g of list) {
    let s = `- ${g.want}`;
    if (g.from) s += `（起因：${g.from}）`;
    if (Array.isArray(g.tries) && g.tries.length) {
      const last = g.tries[g.tries.length - 1];
      s += ` · 上次试过：${last.what}${last.result ? '→' + last.result : ''}`;
    }
    lines.push(s);
  }
  lines.push(
    '⚠️ 这些是你**自己**记着的，不是待办清单：别一条条报给他听，'
    + '也别每轮都提。**最多一次说一件**，而且只在聊到相关的时候自然带出来。'
    + '他没接话就说明现在不想聊这个，放着，别追。');
  return lines.join(T.CRLF);
}

module.exports = {
  FILE, TYPES, LIFE,
  readAll, active, add, addTry, setStatus, tick, buildBlock,
  _reset() { writeAll({ goals: [] }); },
};
