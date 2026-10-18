/**
 * 自检 · 行为与计数（第 14 套）
 *
 * 管 2026-10-16 修的 P2 那一批 —— 都是「数错了 / 顺序错了 / 共用引用」这种，
 * 不报错、不崩，就是**结果悄悄不对**：
 *
 *   #22 心情的"自然回落"占了每日变化配额 → 真实变化被提前拦下
 *   #23 聊天历史的截断两处单位不一致（条 vs 轮）→ 长跑和重启后看到的条数不一样
 *   #24 最新一条太长 → `recent()` 返回**空**，请求里没有用户消息
 *   #12 回顾那条链要「只看今天」，得有带 ts 的取法
 *   #43 「自言语带不带时间」开关只管了一半（系统提示词里照样有）
 *   #56 默认配置和运行时配置**共用同一个对象引用**，改一个等于改两个
 *   #7  写盘要原子（临时文件 + rename），二进制也一样
 *
 * ⚠️ 跑在隔离目录里（`YACHIYO_HOME`）。跑法：node scripts/selfcheck-p2.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.join(ROOT, '_selfcheck-home-p2');

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
const store = fresh('store.cjs');
const T = fresh('text.cjs');

/* ══════════ #22 心情配额 ══════════ */
console.log('\n【#22 自然回落不该占每日变化配额】');

const mood = fresh('mood.cjs');
mood._reset();
chk('起始：今天 0 次变化', mood.changesToday() === 0, String(mood.changesToday()));

mood.set('高兴', '他夸我了', { from: '对话' });
mood.decay(Date.now() + 20 * 3600 * 1000);          // 20 小时后 → 自动回落
mood.set('低落', '有点闷', { from: '对话' });

chk('★ set + 回落 + set 之后，计数是 2 而不是 3（回落不算）',
  mood.changesToday() === 2, String(mood.changesToday()));

const third = mood.set('高兴', '又开心了', { from: '对话' });
chk('★ 第 3 次**真**变化还能成功（改前会被"已经变过 3 次"拦住）',
  third.ok === true, third.ok ? '' : third.why);

const fourth = mood.set('低落', '第四次', { from: '对话' });
chk('对照：第 4 次确实被拦（上限还是 3，没被放宽）',
  fourth.ok === false, fourth.ok ? '★ 上限失效了' : fourth.why);

/* ══════════ #23 / #24 聊天历史 ══════════ */
console.log('\n【#23/#24 历史窗口】');

const mem = fresh('memory.cjs');
fs.rmSync(mem.FILE, { force: true });
for (let i = 0; i < 100; i++) mem.push(i % 2 ? 'assistant' : 'user', 'm' + i);
chk('★ 塞 100 条之后，内存窗口是 60 而不是 30（跟重启后一致）',
  mem.count() === 60, String(mem.count()));

const mem2 = fresh('memory.cjs');
chk('  重启重新 load 之后也是 60（两边对得上）', mem2.count() === 60, String(mem2.count()));

fs.rmSync(mem2.FILE, { force: true });
const LONG = '长'.repeat(13000);
mem2.push('user', LONG);
const picked = mem2.recent(30);
chk('★ 最新一条 13000 字超预算 → 仍然拿得到（改前返回空列表）',
  picked.length >= 1, `${picked.length} 条`);
chk('  超预算的会被截断，不是整条丢',
  picked.length >= 1 && picked[0].content.length <= 12000 && picked[0].content.length > 0,
  picked.length ? `${picked[0].content.length} 字` : '');
chk('  截断后开头还是原来的内容（没截错头）',
  picked.length >= 1 && picked[0].content.startsWith('长长长'), '');

/* ══════════ #12 「只看今天」的取法 ══════════ */
console.log('\n【#12 带 ts 的历史取法】');

const mem3 = fresh('memory.cjs');
fs.rmSync(mem3.FILE, { force: true });
const DAY = 86400000;
mem3.push('user', '三天前说的', { ts: Date.now() - 3 * DAY });
mem3.push('user', '今天说的');

const dayStart = new Date();
dayStart.setHours(0, 0, 0, 0);
const today = mem3.since(dayStart.getTime());
chk('★ since(今天零点) 只返回今天那条', today.length === 1, `${today.length} 条`);
chk('  返回的记录**带 ts**（recent() 是不带的）',
  today.length === 1 && typeof today[0].ts === 'number', today.length ? typeof today[0].ts : '');
chk('  取全部（since(0)）能拿到两条', mem3.since(0).length === 2, String(mem3.since(0).length));

/* ══════════ #43 时间开关要管两处 ══════════ */
console.log('\n【#43 「自言语带不带时间」要管到系统提示词】');

const prompt = fresh('prompt.cjs');
const withTime = prompt.buildSystem({ userText: '测试', now: new Date() });
chk('默认（不传 noTime）→ 系统提示词里**有**【现在的时间】',
  withTime.includes('【现在的时间】'), `${withTime.length} 字`);

const noTime = prompt.buildSystem({ userText: '测试', now: new Date(), noTime: true });
chk('★ 传 noTime:true → 系统提示词里**没有**【现在的时间】',
  !noTime.includes('【现在的时间】'), `${noTime.length} 字`);

/* ══════════ #56 默认值不许共用引用 ══════════ */
console.log('\n【#56 默认配置和运行时配置不许共用对象】');

const c = fresh('config.cjs');
c.load();
chk('★ DEFAULTS.winGeom 和 cfg.all().winGeom **不是同一个对象**',
  c.DEFAULTS.winGeom !== c.all().winGeom, '');

const before = JSON.stringify(c.DEFAULTS.winGeom);
c.set('winGeom', { ...(c.all().winGeom || {}), menu: { x: 12345, y: 999 } });
chk('★ 改运行时配置**不会**污染 DEFAULTS',
  JSON.stringify(c.DEFAULTS.winGeom) === before, JSON.stringify(c.DEFAULTS.winGeom));

/* ══════════ #7 原子写 ══════════ */
console.log('\n【#7 写盘要原子（临时文件 + rename）】');

const dir = path.join(HOME, 'tmp-check');
const tf = path.join(dir, 'a.txt');
chk('writeText 成功', store.writeText(tf, '正文') === true, '');
chk('  内容对', fs.readFileSync(tf, 'utf8') === '正文', JSON.stringify(fs.readFileSync(tf, 'utf8')));
chk('  目录里没有留下 .tmp', !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')),
  fs.readdirSync(dir).join(','));

const bf = path.join(dir, 'b.bin');
const buf = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0x1a]);
chk('writeFile（二进制）成功', store.writeFile(bf, buf) === true, '');
chk('★ 二进制**逐字节**对（没被当字符串拼坏）',
  Buffer.compare(fs.readFileSync(bf), buf) === 0,
  fs.readFileSync(bf).toString('hex'));
chk('  也没留下 .tmp', !fs.readdirSync(dir).some((f) => f.endsWith('.tmp')),
  fs.readdirSync(dir).join(','));

/* ══════════ 隔离 ══════════ */
console.log('\n【隔离检查】');
chk('跑在隔离目录里', HOME.includes('_selfcheck-home-p2'), HOME);

console.log('\n' + '─'.repeat(52));
const pass = out.filter((x) => x.ok).length;
console.log(`  ${pass}/${out.length} 通过  ${pass === out.length ? '✓ 全过' : '✗ 有失败'}`);
console.log('─'.repeat(52) + '\n');
const bad = out.filter((x) => !x.ok);
if (bad.length) { console.log('失败明细：'); for (const b of bad) console.log(`  - ${b.name}: ${b.detail}`); }
process.exit(pass === out.length ? 0 : 1);
