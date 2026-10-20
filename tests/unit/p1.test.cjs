/**
 * 自检 · 行为与闸门（第 15 套）
 *
 * 管 2026-10-16 修的 P1 那一批 —— 都是「他天天碰得到、但不会崩」的：
 *
 *   #9  「再等 30 分钟」实际只等了一拍（5 秒）
 *   #21 说一句「好热闹」会被当成在问天气 → 真联网查一次
 *   #36 联网开关 / key / 每日上限**挡不住**先冒的那句「我查一下…」
 *   #26 「花超了提醒我」全仓没人调，是个死旋钮
 *   #45 地名匹配口径：注释写"最长匹配"，实现却是"取最靠后的"
 *
 * ⚠️ 跑在隔离目录里（`YACHIYO_HOME`）。跑法：node scripts/selfcheck-p1.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.join(ROOT, '_selfcheck-home-p1');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.YACHIYO_HOME = HOME;

const out = [];
const chk = (name, ok, detail) => {
  out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail != null ? '  —— ' + detail : ''}`);
};

function fresh(rel) {
  const p = path.join(ROOT, 'src/core', rel);
  delete require.cache[require.resolve(p)];
  return require(p);
}

const cfg = fresh('config.cjs');
cfg.load();
const T = fresh('text.cjs');
const MIN = 60000;

/* ══════════ #9 晚点关 ══════════ */
console.log('\n【#9 「再等 30 分钟」要真的等 30 分钟】');

const autoexit = fresh('autoexit.cjs');
chk('还没说过要延时 → 截止时刻是 0',
  autoexit.lateDeadline(new Date()) === 0, String(autoexit.lateDeadline(new Date())));

/*
 * ⚠️⚠️ **时刻必须钉死，不能用「现在」**（2026-10-20 深夜踩到的，实测红）。
 *
 *   下面要验「同一天只让延一次」，做法是 t0 → t1 = t0 + 2 小时。
 *   原来 `t0 = new Date()`，于是 **22:00 之后跑，t1 就跨到第二天**，
 *   「同一天」这个前提自己就不成立了 ⇒ 断言必红。
 *   实测 23:59 跑：T.day(t0)=2026-10-20、T.day(t1)=2026-10-21，
 *   askLate 正常放行（这本来就是对的），测试却要求它拒绝。
 *
 *   ⇒ 钉在今天 **10:00**：±2 小时都还在同一天，白天夜里跑结果一样。
 *   （FACT 里已有同类教训：「凡是今天/昨天/几小时前的用例，都要问一句换个时刻跑还成立吗」。）
 */
const t0 = new Date();
t0.setHours(10, 0, 0, 0);
const r1 = autoexit.askLate(t0);
chk('askLate 成功', r1.ok === true, r1.why);
chk('  今天那次算"用掉了"', autoexit.lateUsedToday(t0) === true, '');

const dl = autoexit.lateDeadline(t0);
const mins = Math.round((dl - t0.getTime()) / MIN);
chk(`★ 截止时刻 ≈ 30 分钟后（实得 ${mins} 分钟）`, mins === autoexit.LATE_MINUTES, `${mins} 分钟`);

chk('★ 刚说完 5 秒时，还没到点（改前这时候就已经能关了）',
  t0.getTime() + 5000 < dl, `deadline - now = ${dl - (t0.getTime() + 5000)}ms`);
chk('  过了 31 分钟之后，确实过点了',
  t0.getTime() + 31 * MIN > dl, '');

const t1 = new Date(t0.getTime() + 2 * 60 * MIN);
const r2 = autoexit.askLate(t1);
chk('  同一天再要一次 → 拒绝（一天只让延一次）', r2.ok === false, r2.why);

/* ══════════ #21 天气误触发 ══════════ */
console.log('\n【#21 「好热闹」不该被当成在问天气】');

const weather = fresh('weather.cjs');
for (const w of ['好热闹', '好热情', '好冷清', '冷静一下', '这个游戏好热闹啊']) {
  chk(`★ 「${w}」不算问天气`, weather.isAsking(w) === false, String(weather.isAsking(w)));
}
for (const y of ['外面天气怎么样', '今天冷吗', '是不是要下雨', '该穿什么']) {
  chk(`对照：「${y}」算问天气`, weather.isAsking(y) === true, String(weather.isAsking(y)));
}

/* ══════════ #45 地名匹配口径 ══════════ */
console.log('\n【#45 地名按"最长匹配"挑，不是"取最靠后的"】');

const PROVIDERS = [
  { name: '青海' }, { name: '海南' }, { name: '海南藏族自治州' }, { name: '湖南' }, { name: '黑龙江' },
];
const pick = (text) => (weather._pickIn(PROVIDERS, text) || {}).name;

/*
 * ⚠️ 这里挑的是**省**。`海南州` 是青海省下面的自治州，不是海南省 ——
 *    所以正确答案是「青海」，改前（取最靠后的匹配）会错成「海南」。
 */
chk('★ 「青海省海南州」→ 挑中**青海**（改前会错成海南）',
  pick('青海省海南州') === '青海', String(pick('青海省海南州')));
chk('★ 「青海省海南藏族自治州」→ 挑中**长的那个**（全名就在表里）',
  pick('青海省海南藏族自治州') === '海南藏族自治州', String(pick('青海省海南藏族自治州')));
chk('  「海南省三亚」→ 还是挑海南（那条路没坏）',
  pick('海南省三亚') === '海南', String(pick('海南省三亚')));

const CITIES = [{ name: '北京' }, { name: '朝阳' }];
chk('★ 「北京市朝阳区」→ 挑中朝阳（保住原来就正确的那条）',
  pick0(CITIES, '北京市朝阳区') === '朝阳', String(pick0(CITIES, '北京市朝阳区')));
function pick0(list, text) { return (weather._pickIn(list, text) || {}).name; }

/* ══════════ #36 联网三道闸 ══════════ */
console.log('\n【#36 开关 / key / 上限要挡在「我查一下…」之前】');

const ws = fresh('websearch.cjs');
const QUESTION = '今年人工智能有什么新进展';

cfg.set('webEnabled', true);
cfg.set('apiKey', 'sk-测试用的假key');
cfg.set('webMaxPerDay', 20);
chk('对照：全开 + 新鲜事 → 判定要查', ws.shouldSearch(QUESTION) === true, String(ws.shouldSearch(QUESTION)));

cfg.set('webEnabled', false);
chk('★ 联网关掉 → 不查', ws.shouldSearch(QUESTION) === false, String(ws.shouldSearch(QUESTION)));

cfg.set('webEnabled', true);
cfg.set('apiKey', '');
chk('★ 没填 Key → 不查', ws.shouldSearch(QUESTION) === false, String(ws.shouldSearch(QUESTION)));

cfg.set('apiKey', 'sk-测试用的假key');
cfg.set('webMaxPerDay', 1);
ws._reset();
// 手工把今天的计数写成 1，让它正好撞到上限
const day = T.day(new Date());
fs.writeFileSync(ws.FILE, JSON.stringify({ day, n: 1 }), 'utf8');
chk('★ 今天的次数已经用满 → 不查', ws.shouldSearch(QUESTION) === false, String(ws.shouldSearch(QUESTION)));

fs.writeFileSync(ws.FILE, JSON.stringify({ day, n: 0 }), 'utf8');
cfg.set('webMaxPerDay', 20);
chk('  改名成昨天 → 计数归零，又能查', (() => {
  fs.writeFileSync(ws.FILE, JSON.stringify({ day: '2000-01-01', n: 99 }), 'utf8');
  return ws.shouldSearch(QUESTION) === true;
})(), '');

/* ══════════ #26 花钱提醒接上了 ══════════ */
console.log('\n【#26 「花超了提醒我」得有人真去看账】');

const usage = fresh('usage.cjs');
usage.reset();
chk('对照：没花钱时不算超限', usage.overLimit(50) === false, '');
usage.add({ prompt_tokens: 1000, completion_tokens: 1000 }, 60);
chk('  花了 60 块、上限 50 → 算超限', usage.overLimit(50) === true, JSON.stringify(usage.all().monthCost));
chk('  上限设成 0（= 没设）→ 不算超限', usage.overLimit(0) === false, '');

const hb = fresh('heartbeat.cjs');
let spendRan = 0;
hb.on('spend', () => { spendRan++; });
hb._setIdleMinutes(() => 0);
hb.tick(new Date());
chk('★ 心跳里**真的会叫** `spend` 这一拍（注册表里有这个键）',
  spendRan === 1, `${spendRan} 次`);
chk('  而且它出现在 tick 的 ran 列表里',
  hb.tick(new Date()).ran.includes('spend'), JSON.stringify(hb.tick(new Date()).ran));

/* ══════════ 隔离 ══════════ */
console.log('\n【隔离检查】');
chk('跑在隔离目录里', HOME.includes('_selfcheck-home-p1'), HOME);

console.log('\n' + '─'.repeat(52));
const pass = out.filter((x) => x.ok).length;
console.log(`  ${pass}/${out.length} 通过  ${pass === out.length ? '✓ 全过' : '✗ 有失败'}`);
console.log('─'.repeat(52) + '\n');
const bad = out.filter((x) => !x.ok);
if (bad.length) { console.log('失败明细：'); for (const b of bad) console.log(`  - ${b.name}: ${b.detail}`); }
process.exit(pass === out.length ? 0 : 1);
