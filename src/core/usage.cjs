/**
 * 用量与花费 —— 他说「用量与成本功能最好也要加入」。
 *
 * 存 `%APPDATA%\Yachiyo\data\usage.json`。
 * 记「今天」和「这个月」两档；跨天了、跨月了自动归零。
 *
 * ⚠️ 跨天不能靠「定时器到点就清零」—— 她是桌宠，可能开着开了三天，
 *    也可能今天压根没启动。所以要**每次读写时比对日期戳**，对不上就重置。
 *    这个坑旧工程踩过：日志里某天的花费算进了前一天。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DATA, ensureDir } = require('./config.cjs');

const FILE = path.join(DATA, 'usage.json');

const EMPTY = {
  day: '',           // '2026-10-11'
  month: '',         // '2026-10'
  todayCalls: 0,
  todayTokens: 0,    // 输入 + 输出
  todayCost: 0,      // 元
  monthCalls: 0,
  monthTokens: 0,
  monthCost: 0,
  totalCalls: 0,
  totalCost: 0,
  lastAt: 0,
  /*
   * ★ 历史明细（2026-10-17 加的，给设置面板那张「日/周/月」图用）。
   *
   *   ⚠️ 读盘那句是 `data = { ...EMPTY, ...raw }` —— 所以**老账本会自动补上
   *      这两个空对象**：他那本账里没这俩字段，读进来就是 {}，不清零、不报错。
   *
   *     hourly: { '2026-10-17T03': {calls, tokens, cost} }   最近 24 小时，按小时
   *     daily:  { '2026-10-17':    {calls, tokens, cost} }   最近 30 天，按天
   *
   *   粒度是他 2026-10-17 亲自定的：日 = 近 24 小时（按小时）· 周 = 近 7 天 · 月 = 近 30 天。
   *   所以 hourly 至少要留满 24 格、daily 要留满 30 格 —— 见 pruneBuckets()。
   *
   *   ⚠️ 这也是**唯一**要留历史的地方。todayX / monthX 那几个字段照旧只存"当前那格"，
   *      别拿它们去画图（一跨天就全变 0，图会当场塌掉）。
   */
  hourly: {},
  daily: {},
};

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function thisMonth() { return today().slice(0, 7); }

let data = null;

function load() {
  if (data) return data;
  ensureDir();
  let raw = {};
  if (fs.existsSync(FILE)) {
    try {
      /*
       * ⚠️ 读之前**先去 BOM**（2026-10-15 修的）。
       *    带 BOM 的 JSON 会让 JSON.parse 当场抛错，下面那条 catch 就把
       *    **整本账清零**（实测：手改成 UTF-8 带 BOM → todayCalls 42→0、
       *    totalCalls 999→0）。store.readText 一直是这么干的，这里漏了。
       */
      raw = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      /*
       * ⚠️ 读坏了**先留一份副本再重来**（2026-10-15 加的）——
       *    config.cjs 的 catch 就是这么干的，这里原来只打一行日志、
       *    直接 `raw = {}`，**什么都没留**，账本当场蒸发。
       *    留着副本他还能自己看；不留就真的没了。
       */
      const bad = `${FILE}.bad-${Date.now()}`;
      try { fs.copyFileSync(FILE, bad); } catch { /* 复制不了也只能算了 */ }
      console.error(`[usage] 账本读坏了，原文件备份到 ${bad}：` + err.message);
      raw = {};
    }
  }
  data = { ...EMPTY, ...raw };
  roll();
  return data;
}

/* ---------- 历史桶（2026-10-17 加）----------

   这两个键是**本地时间**，跟 today() 同一套口径 —— 别用 toISOString()，
   那个是 UTC，凌晨 0-8 点会差一天（这个坑账本自己踩过一次，见 today()）。
   -------------------------------------------------------------------- */

/** 本地小时键：'2026-10-17T03' */
function hourKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}`;
}

/** 本地日期键：'2026-10-17' —— 跟 today() 一致 */
function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 往一个桶里加一笔 */
function bump(bucket, key, tok, yuan, calls = 1) {
  const b = bucket[key] || (bucket[key] = { calls: 0, tokens: 0, cost: 0 });
  b.calls += Math.max(1, Math.round(Number(calls) || 1));
  b.tokens += tok;
  b.cost += yuan;
}

/**
 * 把过期的桶扔掉。
 * ⚠️ 不扔的话这文件只会一直长（他天天用，一年后就是上万个小格子）——
 *    而图上最多只看 24 格 / 30 格，多留的纯属占地方。
 * ⚠️ 留的比要用的**多一档**（hourly 留 24、daily 留 30），正好够画满整张图，
 *    不留富余：他半夜 3 点看"近 24 小时"，要的正是**现在往前数 24 格**。
 */
function pruneBuckets() {
  const now = Date.now();
  const keepH = new Set();
  for (let i = 0; i < 24; i++) keepH.add(hourKey(new Date(now - i * 3600e3)));
  let dropped = 0;
  for (const k of Object.keys(data.hourly)) {
    if (!keepH.has(k)) { delete data.hourly[k]; dropped++; }
  }
  const keepD = new Set();
  for (let i = 0; i < 30; i++) keepD.add(dayKey(new Date(now - i * 86400e3)));
  for (const k of Object.keys(data.daily)) {
    if (!keepD.has(k)) { delete data.daily[k]; dropped++; }
  }
  return dropped;
}

/** 跨天 / 跨月归零 —— 每次读写都过一遍 */
function roll() {
  const d = today();
  const m = thisMonth();
  let changed = false;
  if (data.day !== d) {
    data.day = d;
    data.todayCalls = 0;
    data.todayTokens = 0;
    data.todayCost = 0;
    changed = true;
  }
  if (data.month !== m) {
    data.month = m;
    data.monthCalls = 0;
    data.monthTokens = 0;
    data.monthCost = 0;
    changed = true;
  }
  // ⚠️ 桶也要跟着过期清理（顺便把"跨天"那一下多出来的旧格子清掉）
  if (pruneBuckets() > 0) changed = true;
  if (changed) save();
}

function save() {
  try {
    ensureDir();
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (err) {
    // 账记不上不该拦住她说话
    console.error('[usage] 账本写盘失败：' + err.message);
  }
}

/**
 * 记一笔。
 * @param {object} usage  provider 返回的原始 usage
 * @param {number} yuan   这一笔花了多少钱（provider.cost 算好的）
 * @param {number} [calls] 这一笔记**几次调用**（默认 1）
 *
 * ★ 2026-10-21 加 `calls`（外部审查 YCH-003）：
 *   一轮对话里**可能打两次模型**（她调了 look_screen：第一次带工具、第二次带结果）。
 *   原来 `add()` 不管里面几次都只 `+1`，于是调用次数和成本一起少记。
 *   现在由调用方把两次的 usage 合并、次数一起传进来 —— 一次落盘、一次 bump。
 */
function add(usage, yuan, calls = 1) {
  load();
  roll();
  const n = Math.max(1, Math.round(Number(calls) || 1));
  const tok = (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0);
  data.todayCalls += n;
  data.todayTokens += tok;
  data.todayCost += yuan;
  data.monthCalls += n;
  data.monthTokens += tok;
  data.monthCost += yuan;
  data.totalCalls += n;
  data.totalCost += yuan;
  data.lastAt = Date.now();
  // ★ 同时进历史桶（图就是靠这两个画的）
  bump(data.hourly, hourKey(), tok, yuan, n);
  bump(data.daily, data.day || today(), tok, yuan, n);
  save();
  return { ...data };
}

function all() { load(); roll(); return { ...data }; }

/**
 * 给设置面板那张图用的时间序列。
 *
 * 粒度是他 2026-10-17 定的：
 *   日 = 近 **24 小时**（按小时）· 周 = 近 **7 天** · 月 = 近 **30 天**（都按天）
 *
 * ⚠️ **空档必须补 0** —— 图上缺一格会看着像"程序坏了"，
 *    补成 0 才是"那会儿没用"这个真实信息。
 *
 * @param {'day'|'week'|'month'} range
 * @returns {{range:string, points:Array, sum:object, peak:number}}
 */
function series(range = 'day') {
  load();
  roll();
  const now = Date.now();
  const out = [];
  if (range === 'day') {
    for (let i = 23; i >= 0; i--) {
      const t = new Date(now - i * 3600e3);
      const k = hourKey(t);
      const b = data.hourly[k] || { calls: 0, tokens: 0, cost: 0 };
      out.push({ key: k, label: String(t.getHours()).padStart(2, '0') + ':00', calls: b.calls, tokens: b.tokens, cost: b.cost });
    }
  } else {
    const n = range === 'week' ? 7 : 30;
    for (let i = n - 1; i >= 0; i--) {
      const t = new Date(now - i * 86400e3);
      const k = dayKey(t);
      const b = data.daily[k] || { calls: 0, tokens: 0, cost: 0 };
      out.push({ key: k, label: `${t.getMonth() + 1}-${t.getDate()}`, calls: b.calls, tokens: b.tokens, cost: b.cost });
    }
  }
  const sum = out.reduce((a, x) => ({ calls: a.calls + x.calls, tokens: a.tokens + x.tokens, cost: a.cost + x.cost }),
    { calls: 0, tokens: 0, cost: 0 });
  return { range, points: out, sum, peak: out.reduce((m, x) => (x.cost > m ? x.cost : m), 0) };
}

/** 今天花超了没有（设置里那个「花超了提醒我」用） */
function overLimit(limitYuan) {
  load();
  return limitYuan > 0 && data.monthCost >= limitYuan;
}

function reset() {
  data = { ...EMPTY, day: today(), month: thisMonth() };
  save();
  return { ...data };
}

module.exports = { FILE, load, add, all, overLimit, reset, series, hourKey, dayKey };
