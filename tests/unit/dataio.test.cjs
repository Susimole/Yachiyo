/**
 * 自检 · 落盘这条路（第 12 套）
 *
 * 管两件**会真的把数据弄没**的事，都是 2026-10-15 修的：
 *
 *   ① **`popLast` 不能拿内存那份覆盖整份文件**
 *      `history` 是内存窗口（load 只装 60 条、push 还砍到 30），
 *      覆盖那个一直在追加的 chat.jsonl = 把窗口以外的全删了。
 *      实测过：100 行的文件，一次聊天失败后剩 **59** 行。
 *
 *   ② **读 JSON 之前必须去 BOM**
 *      `config.json` / `usage.json` 带 BOM 时 JSON.parse 当场抛错，
 *      回落分支把**整份配置 / 整本账**写回默认值。
 *
 * ⚠️ 跑在隔离目录里（`YACHIYO_HOME`），不碰他真实数据。
 * 跑法：node scripts/selfcheck-dataio.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const STARTED = Date.now();
const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.join(ROOT, '_selfcheck-home-dataio');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.YACHIYO_HOME = HOME;

const out = [];
const chk = (name, ok, detail) => {
  out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail != null ? '  —— ' + detail : ''}`);
};

/** 清掉模块缓存重新 require —— 让它按**当前磁盘状态**重新读一遍 */
function fresh(rel) {
  const p = path.join(ROOT, 'src/core', rel);
  delete require.cache[require.resolve(p)];
  return require(p);
}

const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').filter((s) => s.trim());
const BOM = '﻿';

/**
 * 「今天」= **本地日期**（跟 `usage.cjs` 的 `today()` 一个口径）。
 *
 * ⚠️ **别拿 `toISOString()` 当今天**（2026-10-17 修的）—— 它永远是 **UTC**。
 *    本地 00:00–08:00 之间（UTC+8）两者差一天，而被测代码会把写进去的
 *    `day` 当成「隔天的旧账」当场归零 ⇒ 这条断言**假红**，
 *    可白天跑又是绿的 —— 最坑的那种"只在凌晨红"。
 *    实测：2026-10-17 00:40 跑它红；同一份代码白天跑它绿。
 */
const localDay = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/* ══════════ ① popLast 不能吃掉历史 ══════════ */
console.log('\n【① 撤销一句话，不许连坐历史】');

const mem = fresh('memory.cjs');
fs.mkdirSync(path.dirname(mem.FILE), { recursive: true });

const ORIG = [];
for (let i = 0; i < 100; i++) {
  ORIG.push(JSON.stringify({ role: i % 2 ? 'assistant' : 'user', content: 'm' + i, ts: 1000 + i }));
}
fs.writeFileSync(mem.FILE, ORIG.join('\n') + '\n', 'utf8');
chk('底稿：文件里 100 行', lines(mem.FILE).length === 100, lines(mem.FILE).length + ' 行');

mem.push('user', '这一句要被撤掉');
chk('push 之后 101 行', lines(mem.FILE).length === 101, lines(mem.FILE).length + ' 行');

const gone = mem.popLast('user');
const after = lines(mem.FILE);
chk('★ 撤销之后仍然是 100 行（改前会只剩 ~59）', after.length === 100, after.length + ' 行');
chk('撤掉的正是刚推的那句', gone && gone.content === '这一句要被撤掉', gone && gone.content);
chk('★ 原来那 100 行一条不少、顺序不变',
  after.length >= 100 && after.slice(0, 100).join('\n') === ORIG.join('\n'),
  after.length >= 100 ? '' : '行数就不对');

// 原子写：临时文件不该留在目录里
const strays = fs.readdirSync(path.dirname(mem.FILE)).filter((f) => f.endsWith('.tmp'));
chk('写盘是原子的（没留下 .tmp）', strays.length === 0, strays.join(', ') || '干净');

// 认的是「最后一个匹配 role 的行」，不是「最后一行」
fs.writeFileSync(mem.FILE,
  [JSON.stringify({ role: 'user', content: 'A', ts: 1 }),
   JSON.stringify({ role: 'assistant', content: 'B', ts: 2 })].join('\n') + '\n', 'utf8');
const mem2 = fresh('memory.cjs');
const gone2 = mem2.popLast('user');
const rest2 = lines(mem2.FILE);
chk('最后一行不是 user 时，撤的是最后那条 user 而不是末行',
  gone2 && gone2.content === 'A' && rest2.length === 1 && JSON.parse(rest2[0]).content === 'B',
  JSON.stringify(rest2));

// 坏行不能挡路、也不能被误删
fs.writeFileSync(mem.FILE,
  ['这一行不是 JSON', JSON.stringify({ role: 'user', content: 'X', ts: 1 })].join('\n') + '\n', 'utf8');
const mem3 = fresh('memory.cjs');
mem3.popLast('user');
const rest3 = lines(mem3.FILE);
chk('文件里有坏行时，撤销照样认得准、坏行原样留着',
  rest3.length === 1 && rest3[0] === '这一行不是 JSON', JSON.stringify(rest3));

/* ══════════ ② BOM 不能把配置/账本清零 ══════════ */
console.log('\n【② 文件带 BOM，不许把内容当成"坏了"】');

const cfgMod = fresh('config.cjs');
fs.mkdirSync(path.dirname(cfgMod.FILE), { recursive: true });
fs.writeFileSync(cfgMod.FILE, BOM + JSON.stringify({ apiKey: 'sk-测试用的假key', petSize: 77 }, null, 2), 'utf8');
const cfg2 = fresh('config.cjs');
cfg2.load();
chk('★ config.json 带 BOM → apiKey 还在（改前会被清成空串）',
  cfg2.get('apiKey') === 'sk-测试用的假key', JSON.stringify(cfg2.get('apiKey')));
chk('  petSize 也还在', cfg2.get('petSize') === 77, String(cfg2.get('petSize')));

const usage = fresh('usage.cjs');
fs.mkdirSync(path.dirname(usage.FILE), { recursive: true });
fs.writeFileSync(usage.FILE, BOM + JSON.stringify({
  day: localDay(), month: localDay().slice(0, 7),
  todayCalls: 42, totalCalls: 999,
}), 'utf8');
const usage2 = fresh('usage.cjs');
usage2.load();
chk('★ usage.json 带 BOM → 账目还在（改前 todayCalls 42→0）',
  usage2.all().todayCalls === 42, JSON.stringify({ todayCalls: usage2.all().todayCalls }));

const memB = fresh('memory.cjs');
fs.writeFileSync(memB.FILE, BOM + JSON.stringify({ role: 'user', content: '第一条', ts: 1 }) + '\n'
  + JSON.stringify({ role: 'assistant', content: '第二条', ts: 2 }) + '\n', 'utf8');
const memB2 = fresh('memory.cjs');
const hist = memB2.recent(10);
chk('★ chat.jsonl 带 BOM → 第一条不被丢掉（改前首行会被判坏）',
  hist.length === 2 && hist[0].content === '第一条', JSON.stringify(hist.map((m) => m.content)));

/* ══════════ ③ 真坏了要留证，不能静默清空 ══════════ */
console.log('\n【③ 真读坏了：留副本，别静默蒸发】');

fs.writeFileSync(usage.FILE, BOM + '{ 这不是合法 JSON', 'utf8');
const usage3 = fresh('usage.cjs');
usage3.load();
const badUsage = fs.readdirSync(path.dirname(usage.FILE)).filter((f) => f.includes('.bad-'));
chk('★ usage 读坏了 → 留一份 .bad 副本（改前什么都不留）', badUsage.length >= 1, badUsage.join(', '));

fs.writeFileSync(cfgMod.FILE, '{ 这也不是合法 JSON', 'utf8');
const cfg3 = fresh('config.cjs');
cfg3.load();
const badCfg = fs.readdirSync(path.dirname(cfgMod.FILE)).filter((f) => f.includes('.bad-'));
chk('config 读坏了 → 也留 .bad（原有行为，防回归）', badCfg.length >= 1, badCfg.join(', '));

/* ══════════ 隔离 ══════════ */
console.log('\n【隔离检查】');
chk('跑在隔离目录里', HOME.includes('_selfcheck-home-dataio'), HOME);
const REAL = 'C:\\Users\\Susim\\AppData\\Roaming\\Yachiyo';
chk('  他真那份 data 目录没被这次自检写过',
  !fs.existsSync(path.join(REAL, 'data', 'chat.jsonl'))
  || fs.statSync(path.join(REAL, 'data', 'chat.jsonl')).mtimeMs < STARTED, '');

console.log('\n' + '─'.repeat(52));
const pass = out.filter((x) => x.ok).length;
console.log(`  ${pass}/${out.length} 通过  ${pass === out.length ? '✓ 全过' : '✗ 有失败'}`);
console.log('─'.repeat(52) + '\n');
const bad = out.filter((x) => !x.ok);
if (bad.length) { console.log('失败明细：'); for (const b of bad) console.log(`  - ${b.name}: ${b.detail}`); }
process.exit(pass === out.length ? 0 : 1);
