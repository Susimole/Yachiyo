/**
 * 自检 · 边界与输入（第 13 套）
 *
 * 管 2026-10-16 修的那一批「边角情况」—— 平时不犯，一犯就很难查：
 *
 *   #51 追加 .md 时文件末尾没换行 → 新条目粘在上一行屁股上（糊成一条 / 整行丢掉）
 *   #55 `replace(找, 值)` 里的 `$&` `$'` 被当特殊序列展开 → 提示词被撑坏
 *   #63 `/^\s*[\r\n]/gm` 遇 CRLF 只吃掉 \n，留一个游离的 \r
 *   #64 `.slice(0,N)` 按 UTF-16 码元切，把 emoji 劈成半个
 *   #53 心事合并时不看 status → 新担心被吞进「已解决」的旧条目
 *   #54 ID 用秒级时间戳 → 同一秒两条撞车
 *
 * ⚠️ 跑在隔离目录里（`YACHIYO_HOME`）。
 * 跑法：node scripts/selfcheck-edge.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.join(ROOT, '_selfcheck-home-edge');

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

const store = fresh('store.cjs');
const T = fresh('text.cjs');
const MARK = '﻿';

/* ══════════ #51 追加前先补换行 ══════════ */
console.log('\n【#51 追加 .md：文件末尾没换行时不许粘行】');

const f1 = path.join(HOME, 'a.md');
fs.writeFileSync(f1, '- 熬夜', 'utf8');                 // 末尾**故意没有**换行
store.appendText(f1, '- 爱喝可乐\n');
chk('★ 末行是条目、且没换行 → 不粘成一行',
  fs.readFileSync(f1, 'utf8') === '- 熬夜\n- 爱喝可乐\n',
  JSON.stringify(fs.readFileSync(f1, 'utf8')));

const f2 = path.join(HOME, 'b.md');
fs.writeFileSync(f2, HEAD_LIKE(), 'utf8');              // 末尾是注释、没换行
function HEAD_LIKE() { return '# 习惯\n> 我的手写备注：这条别删'; }
store.appendText(f2, '- 新条目\n');
const bTxt = fs.readFileSync(f2, 'utf8');
chk('★ 末行是注释、且没换行 → 新条目还是一整行',
  bTxt.split('\n').includes('- 新条目'),
  JSON.stringify(bTxt));

const f3 = path.join(HOME, 'c.md');
fs.writeFileSync(f3, '- 已有\n', 'utf8');               // 末尾**已经有**换行
store.appendText(f3, '- 追加\n');
chk('末尾本来就有换行 → 不重复补一个空行',
  fs.readFileSync(f3, 'utf8') === '- 已有\n- 追加\n',
  JSON.stringify(fs.readFileSync(f3, 'utf8')));

const f4 = path.join(HOME, 'd.md');
store.appendText(f4, '- 第一条\n');                      // 文件还不存在
chk('文件还不存在 → 开头不许凭空多一个空行',
  fs.readFileSync(f4, 'utf8') === '- 第一条\n',
  JSON.stringify(fs.readFileSync(f4, 'utf8')));

/* ══════════ #55 $& 不许被展开 ══════════ */
console.log('\n【#55 提示词模板替换：用户文本里的 $ 序列不许被解释】');

const TMPL = '前{slot}后';
const evil = '正文 $& 和 $\' 和 $` 和 $1';
const safe = TMPL.replace('{slot}', () => evil);
chk('★ `() => 值` 的写法：$& 原样保留', safe === '前' + evil + '后', JSON.stringify(safe));
const naive = TMPL.replace('{slot}', evil);
chk('对照：不包函数的话 $& 会被展开（说明这个坑是真的）', naive !== safe, JSON.stringify(naive));

/* ══════════ #63 CRLF 不留游离 \r ══════════ */
console.log('\n【#63 剥标记：CRLF 正文不许留下孤零零的回车】');

const markers = fresh('markers.cjs');
const m1 = markers.parse('第一行\r\n[心情 不错]\r\n第二行', { chain: '自检' });
chk('★ CRLF 正文剥完没有 \\r', !m1.text.includes('\r'), JSON.stringify(m1.text));
chk('  正文内容还在', m1.text === '第一行\n第二行', JSON.stringify(m1.text));

const m2 = markers.parse('第一行\n[心情 不错]\n第二行', { chain: '自检' });
chk('对照：LF 正文结果一样', m2.text === m1.text, JSON.stringify(m2.text));

/* ══════════ #64 截断不许切半个 emoji ══════════ */
console.log('\n【#64 截断按码点，不按 UTF-16 码元】');

const long = 'x'.repeat(39) + '😀' + '尾巴';
chk('★ T.cut 截 40：末位不是半个代理对',
  !/[\uD800-\uDBFF]$/.test(T.cut(long, 40)) && [...T.cut(long, 40)].length === 40,
  JSON.stringify(T.cut(long, 40).slice(-3)));

chk('对照：裸 .slice(0,40) 会切出半个（说明这个坑是真的）',
  /[\uD800-\uDBFF]$/.test(long.slice(0, 40)), JSON.stringify(long.slice(0, 40).slice(-2)));

chk('★ T.clip 也是按码点（超长才补省略号）',
  T.clip(long, 40).endsWith('…') && !/[\uD800-\uDBFF]…$/.test(T.clip(long, 40)),
  JSON.stringify(T.clip(long, 40).slice(-3)));

chk('  T.clip 没超长时原样返回', T.clip('短', 40) === '短', T.clip('短', 40));

/* ══════════ #53 心事合并要看 status ══════════ */
console.log('\n【#53 已解决的心事不该再吞新担心】');

const her = fresh('heritems.cjs');
function seedWorry(list) {
  fs.mkdirSync(path.dirname(her.FILE_WORRY), { recursive: true });
  fs.writeFileSync(her.FILE_WORRY, JSON.stringify({ worry: list }, null, 2), 'utf8');
}
function worries() { return JSON.parse(fs.readFileSync(her.FILE_WORRY, 'utf8')).worry; }

seedWorry([{ id: 'w1', about: '工作太累了', status: '解决了', rank: '重要', seenTimes: 1 }]);
her.addWorry({ about: '工作太累了' });
const after1 = worries();
chk('★ 已解决的旧条目**不吞**新担心（条数 1 → 2）', after1.length === 2, `${after1.length} 条`);
chk('  旧条目的 status 还是「解决了」',
  after1[0].status === '解决了' && after1[0].seenTimes === 1,
  JSON.stringify({ status: after1[0].status, seenTimes: after1[0].seenTimes }));

seedWorry([{ id: 'w2', about: '工作太累了', status: '挂着', rank: '重要', seenTimes: 1 }]);
her.addWorry({ about: '工作太累了' });
const after2 = worries();
chk('对照：还挂着的那条**照常合并**（条数还是 1）', after2.length === 1, `${after2.length} 条`);
chk('  合并时 seenTimes +1', after2[0].seenTimes === 2, String(after2[0].seenTimes));

/* ══════════ #54 ID 不许撞车 ══════════ */
console.log('\n【#54 同一秒加的条目 ID 不能撞】');

seedWorry([]);
her.addWorry({ about: '工作太累了' });
her.addWorry({ about: '想吃松饼' });
her.addWorry({ about: '天气转凉了' });
const ids = worries().map((w) => w.id);
chk('★ 连加三条，ID 互不相同', new Set(ids).size === ids.length, ids.join(' / '));
chk('  ID 还是「前缀 + 14 位秒级时间戳」开头（格式没被破坏）',
  ids.every((i) => /^[a-z]\d{14}\d{6}$/.test(i)), ids[0]);

/* ══════════ 隔离 ══════════ */
console.log('\n【隔离检查】');
chk('跑在隔离目录里', HOME.includes('_selfcheck-home-edge'), HOME);

console.log('\n' + '─'.repeat(52));
const pass = out.filter((x) => x.ok).length;
console.log(`  ${pass}/${out.length} 通过  ${pass === out.length ? '✓ 全过' : '✗ 有失败'}`);
console.log('─'.repeat(52) + '\n');
const bad = out.filter((x) => !x.ok);
if (bad.length) { console.log('失败明细：'); for (const b of bad) console.log(`  - ${b.name}: ${b.detail}`); }
process.exit(pass === out.length ? 0 : 1);
