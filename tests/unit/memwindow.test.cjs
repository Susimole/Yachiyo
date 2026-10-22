#!/usr/bin/env node
/**
 * selfcheck-memwindow —— 主动消息能不能把她真说的话挤没
 *
 * ★ 2026-10-22 新建，对应外部审查 **YCH-007 / YCH-008**。
 *
 *   实测（改前，见下）：聊 5 轮真话 → 再塞 60 条主动消息（识屏 / 自言语）
 *   ⇒ 喂模型的历史 **0 条**；他再说一句，模型只看到**这一句**。
 *   文件里一条没丢（chat.jsonl 71 条都在），丢的是**内存窗口**：
 *   `push()` / `load()` 用一个 60 条的窗口，把主动消息也算在里面。
 *
 *   ⚠️ 判据必须成对：
 *     ① 喂模型那路 —— 主动消息再多，真话一条都不能少；
 *     ② 给界面那路 —— 要**完整记录**（带 kind / ts），而且能翻到比 60 条更早。
 *   两条混用就是这次的 bug，所以这里分开量。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-memwin-'));
process.env.YACHIYO_HOME = HOME;

let pass = 0, fail = 0;
const chk = (n, ok, d) => {
  if (ok) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d !== undefined ? '   → ' + d : '')); }
};
const sleep = () => 0;

const ROOT = path.resolve(__dirname, '..', '..');
const memory = require(path.join(ROOT, 'src/core/memory.cjs'));

console.log('selfcheck-memwindow —— 真话不该被主动消息挤没');
console.log('家目录：' + HOME);
console.log('');

/* ── ① 聊 5 轮，再塞 60 条主动消息 ── */
console.log('── ① 5 轮真话 + 60 条主动消息 ──');
memory.clear();
for (let i = 1; i <= 5; i++) {
  memory.push('user', `第${i}轮 他说的`);
  memory.push('assistant', `第${i}轮 她回的`);
}
chk('  先确认基线：5 轮 = 10 条', memory.recent(30, { skipProactive: true }).length === 10,
  String(memory.recent(30, { skipProactive: true }).length));

for (let i = 1; i <= 60; i++) {
  memory.push('assistant', `主动第${i}条：屏幕上是个编辑器`, { kind: i % 2 ? '识屏' : '自言语' });
}
const kept = memory.recent(30, { skipProactive: true });
chk('★ 主动消息灌满之后，真话**还是 10 条**（改前是 0）', kept.length === 10, String(kept.length));
chk('★ 而且确实是那 5 轮，没被替换',
  kept[0].content === '第1轮 他说的' && kept[9].content === '第5轮 她回的',
  kept[0].content + ' … ' + kept[9].content);

/* ── ② 他再说一句：前面 5 轮还在 ── */
console.log('');
console.log('── ② 他再说一句 ──');
memory.push('user', '这轮他问了句真话');
const after = memory.recent(30, { skipProactive: true });
chk('★ 捡到 11 条（5 轮 + 这一句）', after.length === 11, String(after.length));
chk('★ 最后一条是他刚说的', after[after.length - 1].content === '这轮他问了句真话',
  after[after.length - 1].content);
chk('★ 开头那轮还在（这就是"她还记得"）', after[0].content === '第1轮 他说的', after[0].content);

/* ── ③ 喂模型的 DTO 不许夹带字段 ── */
console.log('');
console.log('── ③ 喂模型那份还是干净的 ──');
const modelMsgs = memory.recent(30, { skipProactive: true });
const extraKeys = [...new Set(modelMsgs.flatMap((m) => Object.keys(m)))].filter((k) => k !== 'role' && k !== 'content');
chk('★ 每条只有 role / content（多带字段有些服务端会挑）', extraKeys.length === 0,
  extraKeys.join(','));

/* ── ④ 给界面那份：完整记录 + 能翻更早 ── */
console.log('');
console.log('── ④ 聊天窗那份（historyForDisplay）──');
const disp = memory.historyForDisplay(200);
chk('★ 能拿到比 60 条更早的记录（内存窗口装不下的也读得到）', disp.length === 71, String(disp.length));
chk('★ 带 ts（能显示时间）', disp.every((m) => typeof m.ts === 'number'));
chk('★ 带 kind（识屏 / 自言语分得出来）',
  disp.filter((m) => m.kind === '识屏').length === 30 && disp.filter((m) => m.kind === '自言语').length === 30,
  `识屏 ${disp.filter((m) => m.kind === '识屏').length} / 自言语 ${disp.filter((m) => m.kind === '自言语').length}`);
chk('  一问一答那几条没有 kind（不被误标成主动）',
  disp.filter((m) => !m.kind).length === 11, String(disp.filter((m) => !m.kind).length));
chk('  max 参数有效（historyForDisplay(5) 只给 5 条）', memory.historyForDisplay(5).length === 5,
  String(memory.historyForDisplay(5).length));

/* ── ⑤ 内存窗口不会无限长 ── */
console.log('');
console.log('── ⑤ 内存窗口有上限（不然跑几天就几十万条）──');
memory.clear();
for (let i = 1; i <= 40; i++) { memory.push('user', `真${i}`); memory.push('assistant', `回${i}`); }
for (let i = 1; i <= 400; i++) memory.push('assistant', `主动${i}`, { kind: '识屏' });
const win = memory.load().length;
chk('★ 窗口被裁过（≤ 60 + 90 + 一点余量）', win <= 150 + 2, '现在 ' + win + ' 条');
/*
 * ⚠️ 这里要传个大一点的 `maxTurns` —— `recent(n)` 的 n 是**条数上限**，
 *    写 recent(30) 永远只回 30 条，量不出"窗口里还剩多少真话"（第一版就写错了）。
 */
const talkLeft = memory.recent(500, { skipProactive: true }).length;
chk('★ 真话留着 60 条（真话那桶的额度），并且都是最新的',
  talkLeft === 60, String(talkLeft));

/* ── ⑥ 重启之后（load 那条路）── */
console.log('');
console.log('── ⑥ 重启之后还认得（load 走的是同一个两桶规则）──');
memory.clear();
for (let i = 1; i <= 3; i++) { memory.push('user', `重启前 他说${i}`); memory.push('assistant', `重启前 她回${i}`); }
for (let i = 1; i <= 60; i++) memory.push('assistant', `重启前 主动${i}`, { kind: '识屏' });

/* ⚠️ config/store 是模块级缓存，同进程换不了家 → 必须另起子进程 */
const probe = path.join(HOME, '_reload.cjs');
fs.writeFileSync(probe, `
const m = require(${JSON.stringify(path.join(ROOT, 'src/core/memory.cjs'))});
const r = m.recent(30, { skipProactive: true });
console.log(JSON.stringify({ n: r.length, first: (r[0] || {}).content || '' }));
`, 'utf8');
const child = spawnSync(process.execPath, [probe], {
  env: { ...process.env, YACHIYO_HOME: HOME }, encoding: 'utf8', windowsHide: true,
});
let reloaded = { n: -1, first: '' };
try { reloaded = JSON.parse((child.stdout || '').trim() || '{}'); } catch { /* 下面报红 */ }
chk('★ 重启后喂模型仍有 6 条真话（改前是 0）', reloaded.n === 6, JSON.stringify(reloaded));
chk('★ 而且是重启前那几轮', reloaded.first === '重启前 他说1', reloaded.first);

/* ── ⑦ 接线：两个入口各走各的 ── */
console.log('');
console.log('── ⑦ 接线（静态）──');
const idx = fs.readFileSync(path.join(ROOT, 'src/main/index.cjs'), 'utf8');
chk('★ chat:history 走的是 historyForDisplay（不是 recent）',
  /ipcMain\.handle\('chat:history',\s*\(\)\s*=>\s*memory\.historyForDisplay\(/.test(idx));
chk('★ brain 喂模型的还是 recent + skipProactive',
  /memory\.recent\(c\.memShortCount \|\| 30, \{ skipProactive: true \}\)/.test(
    fs.readFileSync(path.join(ROOT, 'src/core/brain.cjs'), 'utf8')));
const chatjs = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/chat.js'), 'utf8');
chk('★ 聊天窗按 kind 分行画（识屏那几条不再当气泡）', /function rowFor\(m\)/.test(chatjs) && /rowFor\(m\)/.test(chatjs));
chk('  配套样式在（.c-note.pro）',
  /\.c-note\.pro/.test(fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf8')));

/* ---------- 收尾 ---------- */
fs.rmSync(HOME, { recursive: true, force: true });
console.log('');
console.log('─'.repeat(52));
console.log(`  ${pass}/${pass + fail} 通过${fail ? '  ✗ ' + fail + ' 项没过' : '  ✓ 全过'}`);
console.log('─'.repeat(52));
process.exit(fail ? 1 : 0);
