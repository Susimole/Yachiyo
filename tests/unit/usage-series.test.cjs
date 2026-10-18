#!/usr/bin/env node
/**
 * selfcheck-usage-series —— 账本的历史桶 + 日/周/月序列（第 40 轮 · 批次 C）
 *
 * 两件事必须成立：
 *   ① **老账本不能清零** —— 他手里那本 `usage.json` 只有 todayX / monthX 那几个字段，
 *      没有 hourly/daily。读进来要自动补空、数字一个都不能少。
 *   ② 序列的格数要跟他定的粒度一致：日 24 格（按小时）· 周 7 格 · 月 30 格，
 *      而且**空档补 0**（缺格会看着像程序坏了）。
 *
 * ⚠️⚠️ 第一版把「过期清理」那节写错了：`usage.cjs` 里的 `data` 是**模块级缓存**，
 *    我往盘上写了新桶再调 `all()`，它压根不重读 —— 于是"25 小时前那个被清了"
 *    是**假通过**（内存里从来就没那个桶）。
 *    ⇒ 那一节改成**另起一个进程**验（新进程重新 require ⇒ 重新读盘 ⇒ 真跑一遍 roll）。
 *      家目录用 `SELFCHECK_HOME` 传过去，保证父子看的是同一个。
 *
 * 用法：node selfcheck-usage-series.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/* ---------- 隔离（子进程复用主进程那个家目录）---------- */
const HOME = process.env.SELFCHECK_HOME || fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-usage-'));
process.env.YACHIYO_HOME = HOME;
const SELF = path.resolve(__filename);

let pass = 0;
let fail = 0;
const chk = (n, ok, d) => {
  if (ok) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d !== undefined ? '   → ' + d : '')); }
};

const DATA = path.join(HOME, 'data');
const LEDGER = path.join(DATA, 'usage.json');
const writeLedger = (o) => fs.writeFileSync(LEDGER, JSON.stringify(o, null, 2), 'utf8');
const readLedger = () => JSON.parse(fs.readFileSync(LEDGER, 'utf8'));

const now = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const todayStr = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
const monthStr = todayStr.slice(0, 7);

/* ---------- 子进程模式：验过期清理 ---------- */
if (process.argv.includes('--phase=prune')) {
  const usage = require('../../src/core/usage.cjs');
  const a = usage.all();                       // ← 这一步会跑 roll() / pruneBuckets()
  const hk = (h) => usage.hourKey(new Date(Date.now() - h * 3600e3));
  const dk = (d) => usage.dayKey(new Date(Date.now() - d * 86400e3));
  console.log('PRUNE ' + JSON.stringify({
    h25: !!a.hourly[hk(25)],
    h2: !!a.hourly[hk(2)],
    d31: !!a.daily[dk(31)],
    d3: !!a.daily[dk(3)],
    dayPoints: usage.series('day').points.length,
    monthPoints: usage.series('month').points.length,
  }));
  process.exit(0);
}

/* ---------- 主进程：先铺一本「他的老账本」---------- */
fs.mkdirSync(DATA, { recursive: true });
writeLedger({
  day: todayStr,
  month: monthStr,
  todayCalls: 7,
  todayTokens: 1234,
  todayCost: 0.05,
  monthCalls: 29,
  monthTokens: 102573,
  monthCost: 0.09982944,
  totalCalls: 29,
  totalCost: 0.09982944,
  lastAt: Date.now() - 60000,
});

const usage = require('../../src/core/usage.cjs');

console.log('selfcheck-usage-series —— 历史桶 + 日/周/月序列');
console.log('家目录：' + HOME);
console.log('');

/* ---------- ① 老账本不能坏 ---------- */
console.log('── ① 老账本（没有 hourly/daily）读进来 ──');
const a0 = usage.all();
chk('★ todayCalls 还是 7（没被清零）', a0.todayCalls === 7, String(a0.todayCalls));
chk('★ totalCalls 还是 29', a0.totalCalls === 29, String(a0.totalCalls));
chk('★ monthCost 还是 0.09982944', a0.monthCost === 0.09982944, String(a0.monthCost));
chk('hourly 在内存里补成了空对象（盘上没有也不影响）',
  a0.hourly && typeof a0.hourly === 'object' && Object.keys(a0.hourly).length === 0, JSON.stringify(a0.hourly));
chk('daily 同上', a0.daily && typeof a0.daily === 'object' && Object.keys(a0.daily).length === 0, JSON.stringify(a0.daily));
chk('★ 老字段一个都没少（读盘那份原样）',
  ['day', 'month', 'todayCalls', 'todayTokens', 'todayCost', 'monthCalls', 'monthTokens', 'monthCost', 'totalCalls', 'totalCost', 'lastAt']
    .every((k) => readLedger()[k] !== undefined),
  Object.keys(readLedger()).join(','));

/* ---------- ② 记一笔会同时进两个桶 ---------- */
console.log('');
console.log('── ② 记一笔 ──');
usage.add({ prompt_tokens: 10, completion_tokens: 20 }, 0.01);
const a1 = usage.all();
const hk = usage.hourKey();
const dk = usage.dayKey();
chk('今日计数 +1（老字段照旧工作）', a1.todayCalls === 8, String(a1.todayCalls));
chk('今天那格 daily 记上了：1 次 / 30 token / 0.01 元',
  a1.daily[dk] && a1.daily[dk].calls === 1 && a1.daily[dk].tokens === 30 && Math.abs(a1.daily[dk].cost - 0.01) < 1e-9,
  JSON.stringify(a1.daily[dk]));
chk('当前小时那格 hourly 也记上了（键长这样 ' + hk + '）',
  a1.hourly[hk] && a1.hourly[hk].calls === 1 && a1.hourly[hk].tokens === 30,
  JSON.stringify(a1.hourly[hk]));
chk('★ 盘上也写进去了', !!readLedger().hourly[hk] && !!readLedger().daily[dk]);

/* ---------- ③ 三种粒度的格数 ---------- */
console.log('');
console.log('── ③ 日 / 周 / 月 的格数 ──');
const sDay = usage.series('day');
const sWeek = usage.series('week');
const sMonth = usage.series('month');
chk('★ 日 = 近 24 小时 → 24 格', sDay.points.length === 24, String(sDay.points.length));
chk('★ 周 = 近 7 天 → 7 格', sWeek.points.length === 7, String(sWeek.points.length));
chk('★ 月 = 近 30 天 → 30 格', sMonth.points.length === 30, String(sMonth.points.length));
chk('日序列最后一格 = 当前小时', sDay.points[23].key === hk, sDay.points[23].key + ' vs ' + hk);
chk('周序列最后一格 = 今天', sWeek.points[6].key === dk, sWeek.points[6].key + ' vs ' + dk);
chk('月序列最后一格 = 今天', sMonth.points[29].key === dk, sMonth.points[29].key);

/* ---------- ④ 空档补 0 ---------- */
console.log('');
console.log('── ④ 空档补 0（缺格会看着像程序坏了）──');
const blanks = sDay.points.filter((x) => x.calls === 0);
chk('24 格里只有 1 格有记录，其余 23 格都是 0（不是 undefined）',
  blanks.length === 23 && blanks.every((x) => typeof x.cost === 'number' && x.cost === 0), String(blanks.length));
chk('每格都带 label（图上画横轴用）', sDay.points.every((x) => typeof x.label === 'string' && x.label.length > 0));
chk('日的 label 长这样：' + sDay.points[0].label + ' / ' + sDay.points[23].label, /^\d{2}:00$/.test(sDay.points[0].label));
chk('周的 label 长这样：' + sWeek.points[0].label, /^\d{1,2}-\d{1,2}$/.test(sWeek.points[0].label));

/* ---------- ⑤ 汇总 ---------- */
console.log('');
console.log('── ⑤ 汇总与峰值 ──');
chk('日的合计 = 刚记的那一笔（0.01）', Math.abs(sDay.sum.cost - 0.01) < 1e-9, String(sDay.sum.cost));
chk('日的合计次数 = 1', sDay.sum.calls === 1, String(sDay.sum.calls));
chk('峰值 = 0.01', Math.abs(sDay.peak - 0.01) < 1e-9, String(sDay.peak));
chk('token 合计 = 30', sDay.sum.tokens === 30, String(sDay.sum.tokens));

/* ---------- ⑥ 过期清理（⚠️ 另起进程验，见文件头）---------- */
console.log('');
console.log('── ⑥ 过期清理（不然文件只会一直长）──');
const raw = readLedger();
raw.hourly[usage.hourKey(new Date(Date.now() - 25 * 3600e3))] = { calls: 9, tokens: 9, cost: 9 };
raw.hourly[usage.hourKey(new Date(Date.now() - 2 * 3600e3))] = { calls: 1, tokens: 1, cost: 0.001 };
raw.daily[usage.dayKey(new Date(Date.now() - 31 * 86400e3))] = { calls: 9, tokens: 9, cost: 9 };
raw.daily[usage.dayKey(new Date(Date.now() - 3 * 86400e3))] = { calls: 2, tokens: 2, cost: 0.002 };
writeLedger(raw);

const out = execFileSync(process.execPath, [SELF, '--phase=prune'], {
  encoding: 'utf8', env: { ...process.env, SELFCHECK_HOME: HOME },
});
const R = JSON.parse(out.split('PRUNE ')[1].trim());
chk('★ 25 小时前的桶被清掉了', R.h25 === false);
chk('★ 2 小时前的桶**留着**（还在 24 格窗口里）', R.h2 === true);
chk('★ 31 天前的桶被清掉了', R.d31 === false);
chk('★ 3 天前的桶**留着**（还在 30 格窗口里）', R.d3 === true);
chk('★ 清完之后，日序列照样是 24 格', R.dayPoints === 24, String(R.dayPoints));
chk('★ 清完之后，月序列照样是 30 格', R.monthPoints === 30, String(R.monthPoints));

/* ---------- ⑦ 清干净 ---------- */
if (!process.env.SELFCHECK_HOME) fs.rmSync(HOME, { recursive: true, force: true });

console.log('');
console.log((fail === 0 ? '★ 全绿' : '✗ 有红') + `　${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
