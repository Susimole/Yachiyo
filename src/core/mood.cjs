/**
 * 情绪 —— 她的心情：高兴 / 平常 / 低落。
 *
 * 存 `data/她的心事.json` 的 `情绪` 字段（跟旧工程同一个文件、同一个位置）。
 *
 * ⚠️⚠️ 三条硬规矩，全是从旧工程抄过来的，**每一条都别省**：
 *
 *   ① **必须写原因**，高兴也要。
 *      原因是给**她自己下次看的** —— 没有原因的情绪，下一轮接不上，
 *      她只会莫名其妙地忽冷忽热。旧工程的判据是「去空格后 < 2 字 → 不收」，
 *      而且不收的时候**要记日志**，不然她会以为存进去了，一直重复尝试。
 *   ② **不变就不记**。一样的心情反复写，只会把「一天 3 次」的额度白白烧掉。
 *   ③ **一天最多 3 次**（`MoodMaxChangesPerDay`）。不封顶的话她能在十分钟里
 *      从高兴摆到低落再摆回来 —— 那不叫有情绪，叫抽搐。
 *
 * 另外一条**回**设计：距上次变化 ≥ `MoodDecayHours`（默认 18）小时 →
 * 自动淡回「平常」。不定时回落的话，一次难过会一直挂在那儿，
 * 三天后她还阴沉着，而"为什么"早就过期了。
 */

'use strict';

const path = require('node:path');
const cfg = require('./config.cjs');
const store = require('./store.cjs');
const T = require('./text.cjs');

/** 跟心事 / 认错 / 小日子**同一个文件**（旧工程就是一份 `她的心事.json`） */
const FILE = path.join(store.DATA, '她的心事.json');

/** 三档。⚠️ 用中文存 —— 跟旧工程的文件格式对齐，他能直接看 */
const MOODS = ['高兴', '平常', '低落'];
const DEFAULT = '平常';

/** 流水最多留几条（旧工程 20） */
const LOG_MAX = 20;

/* ── 读 / 写 ────────────────────────────────────────────── */

/**
 * 读整个文件。
 * ⚠️ 这个文件**同时装着情绪 / 心事 / 认错 / 小日子**（见 heritems.cjs），
 *    所以读写都要**整份来**，别只覆盖自己的那一段 —— 那会把别人的抹掉。
 */
function readAll() {
  const v = store.readJson(FILE, null);
  return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
}

function writeAll(obj) {
  return store.writeJson(FILE, obj);
}

/** 当前情绪对象（永远返回一个**结构完整**的，缺字段就补默认） */
function read() {
  const m = readAll().情绪;
  const o = (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  return {
    现在: MOODS.includes(o.现在) ? o.现在 : DEFAULT,
    为什么: typeof o.为什么 === 'string' ? o.为什么 : '',
    变了于: typeof o.变了于 === 'string' ? o.变了于 : '',
    哪条: typeof o.哪条 === 'string' ? o.哪条 : '',
    记录: Array.isArray(o.记录) ? o.记录 : [],
  };
}

/* ── 改情绪 ─────────────────────────────────────────────── */

/** 今天已经改了几次（按 `记录` 里今天的条数算） */
function changesToday(now = new Date()) {
  const d = T.day(now);
  /*
   * ⚠️ **回落不算**（2026-10-16 修的）。
   *
   *    回落是**系统按时间自动淡回去**的（见 `decay()`），不是"她今天心情变了一次"。
   *    它自己在下限检查里是被排除的（:100 那句 `o.from !== '回落'`），
   *    可**计数时又把它算进去了** —— 两边口径不一致。
   *
   *    实测：`set(对话)` → 回落 → `set(对话)`，changesToday 就是 3；
   *    第四次真变化被拦「今天已经变过 3 次了，压住」——
   *    而他实际只看到 2 次变化。有过回落的那天，真实变化只能发生 2 次。
   */
  return read().记录.filter((r) => r && r.哪条 !== '回落'
    && String(r.t || '').startsWith(d)).length;
}

/**
 * 设一个新心情。
 *
 * @param {string} mood  '高兴' | '平常' | '低落'
 * @param {string} why   为什么 —— **必填**，去空格后要 ≥2 字
 * @param {object} [o]
 * @param {string} [o.from]  哪条链来的（'回顾' | '对话' | '回落'），只进日志
 * @returns {{ok:boolean, why:string}} 失败时说人话，**调用方要用它记日志**
 */
function set(mood, why, o = {}) {
  const v = String(mood || '').trim();
  const reason = String(why || '').trim().replace(/[\r\n]+/g, ' ');

  // ① 档位不认 —— 直接拒（旧工程也是这个规矩）
  if (!MOODS.includes(v)) return { ok: false, why: `不认识的档位「${v}」` };

  // ② 没写原因 —— 高兴也要写
  if (reason.length < 2) return { ok: false, why: `${v} 但没写原因，不收` };

  const cur = read();
  // ③ 没变就不记（不然白烧额度）
  if (cur.现在 === v) return { ok: false, why: `本来就是${v}，不用记` };

  // ④ 一天上限
  const max = Math.max(1, Number(cfg.get('MoodMaxChangesPerDay')) || 3);
  if (o.from !== '回落' && changesToday() >= max) {
    return { ok: false, why: `今天已经变过 ${max} 次了，压住` };
  }

  const now = new Date();
  const stamp = T.stamp(now);

  const next = {
    现在: v,
    为什么: reason,
    变了于: stamp,
    哪条: String(o.from || ''),
    记录: [...cur.记录, { t: stamp, 变成: v, 因为: reason, 哪条: String(o.from || '') }].slice(-LOG_MAX),
  };

  const all = readAll();
  all.情绪 = next;
  if (!writeAll(all)) return { ok: false, why: '写盘失败' };

  console.log(`[mood] ${cur.现在} → ${v}（${reason}）· ${o.from || '?'}`);
  return { ok: true, why: '' };
}

/**
 * 回落：距上次变化 ≥ `MoodDecayHours` 小时 → 淡回「平常」。
 *
 * ⚠️ 回落**不占**一天 3 次的额度（`from: '回落'` 会跳过那道闸）——
 *    不然她今天难过完，明天连"淡掉"都记不进去，会一直挂着。
 *
 * @returns {boolean} 这次真的回落了吗（调用方按需要打日志）
 */
function decay(now = Date.now()) {
  const cur = read();
  if (cur.现在 === DEFAULT) return false;
  if (!cur.变了于) return false;                 // 没有时间戳 → 不猜，留着

  const t = T.parseStamp(cur.变了于);
  if (!t) return false;
  const hours = Math.max(1, Number(cfg.get('MoodDecayHours')) || 18);
  if ((now - t) < hours * 3600000) return false;

  const r = set(DEFAULT, '过了一天多，淡了', { from: '回落' });
  return r.ok;
}

/* ── 提示词那一段 ───────────────────────────────────────── */

/**
 * 情绪怎么写进提示词。
 *
 * ⚠️⚠️ 「平常」**整个不出现** —— 这是旧工程的设计，理由很实在：
 *    大多数时候她都是平常，天天在提示词里写一句「你现在心情平常」，
 *    除了占地方、让她莫名其妙提一句心情之外没有任何用。
 *    只在**真的高兴/低落**时才提醒她 —— 那时候这句话才影响语气。
 */
function buildBlock() {
  if (cfg.get('mood') === false) return '';
  const cur = read();
  if (cur.现在 === DEFAULT) return '';

  const lines = [];
  if (cur.现在 === '高兴') {
    lines.push('【你现在心情不错】');
    if (cur.为什么) lines.push(`（因为：${cur.为什么}）`);
    lines.push(
      '话可以多一点、愿意闹一点。但**别打报告** —— 不要说「我今天心情很好」，'
      + '也不要说「因为你我才高兴」。心情是背景，不是话题。');
  } else if (cur.现在 === '低落') {
    lines.push('【你现在的情绪有点低】');
    if (cur.为什么) lines.push(`（因为：${cur.为什么}）`);
    lines.push(
      '话少一点，不呛他，也不闹。**不许猜他的动机**，更不许拿这个跟他要东西'
      + '（不要说「你都不理我」这种）。不想说话就短一点回。');
  }
  return lines.join(T.CRLF);
}

/* ── 自查用 ─────────────────────────────────────────────── */

function _state() {
  return { file: FILE, ...read(), 今天改了几次: changesToday() };
}

module.exports = {
  FILE, MOODS,
  read, readAll, writeAll, set, decay, changesToday, buildBlock, _state,
  _reset() { const a = readAll(); delete a.情绪; writeAll(a); },
};
