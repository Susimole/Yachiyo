#!/usr/bin/env node
/**
 * selfcheck-gamedetect-spawn —— 探测进程**起不来**时会不会把主进程带走
 *
 * ★ 2026-10-22 新建，对应外部审查 **YCH-005**（确定复现）。
 *
 *   现象：`powershell.exe` 起不来（被安全软件拦 / 路径没了 / 权限不够）时，
 *        `spawn` 的同步 try/catch **抓不到** —— 那是异步的 `'error'` 事件。
 *        没人接 ⇒ Node 抛未捕获异常 ⇒ **主进程直接崩**。
 *        紧接着 `child.stdout.setEncoding(...)` 又是一记 TypeError（起失败时 stdout 是 null）。
 *
 *   ⚠️ 判据怎么定：**这个自检本身就是判据** —— 如果 `'error'` 没人接，
 *      进程会带着未捕获异常退出（run.cjs 会看到非 0），根本走不到最后的汇总。
 *      所以这里只补几条"事后的状态对不对"。
 *
 *   ⚠️ gamedetect 里是 `const { spawn } = require('node:child_process')` ——
 *      **解构发生在加载那一刻**，所以必须**先**改 `cp.spawn`、**再** require 它。
 *      顺序反了怎么打桩都没用（这里踩过一次）。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { EventEmitter } = require('node:events');

/* ---------- 隔离（config 也是模块加载时算目录的）---------- */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-gamespawn-'));
process.env.YACHIYO_HOME = HOME;

let pass = 0, fail = 0;
const chk = (n, ok, d) => {
  if (ok) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d !== undefined ? '   → ' + d : '')); }
};

/* ---------- 假进程 ---------- */
class FakeProc extends EventEmitter {
  constructor(withStdio = true) {
    super();
    this.killed = false;
    this.stdout = withStdio ? new EventEmitter() : null;
    this.stderr = withStdio ? new EventEmitter() : null;
    if (this.stdout) this.stdout.setEncoding = () => {};
    if (this.stderr) this.stderr.setEncoding = () => {};
  }
  kill() { this.killed = true; this.emit('exit', 0); }
}

let nextWithStdio = true;
let spawned = 0;
const spawnedList = [];
cp.spawn = () => {
  spawned++;
  const p = new FakeProc(nextWithStdio);
  spawnedList.push(p);
  return p;
};

/* 现在才允许加载产品代码 */
const g = require(path.join(__dirname, '..', '..', 'src', 'core', 'gamedetect.cjs'));

console.log('selfcheck-gamedetect-spawn —— 探测进程起不来时');
console.log('家目录：' + HOME);
console.log('');

const CFG = () => ({ enabled: true, exclude: [] });

/* ── ① 异步 error：不许崩、不许多留引用 ── */
console.log('── ① spawn 异步失败（ENOENT 那种）──');
const n0 = fail;
const okStart = g.start(() => {}, CFG);
chk('start() 说它起起来了', okStart === true, String(okStart));
chk('确实 spawn 了一次', spawned === 1, String(spawned));

const proc1 = spawnedList[0];
proc1.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }));
chk('★ 收到 error 之后进程没崩（能执行到这一行就说明没人漏接）', fail === n0);
chk('★ 内部引用被清掉了（_state().running=false，下一拍能重起）',
  g._state().running === false, JSON.stringify(g._state()));

/* ── ② error 之后还能再起一个 ── */
console.log('');
console.log('── ② 出错之后能重起 ──');
const okStart2 = g.start(() => {}, CFG);
chk('★ 再 start() 一次起得来（不是一辈子卡死）', okStart2 === true && spawned === 2,
  `spawned=${spawned}`);

/* ── ③ 没有 stdio 的半死孩子：判空，不许 TypeError ── */
console.log('');
console.log('── ③ spawn 回来但 stdout 是 null ──');
g.stop();
nextWithStdio = false;
const okStart3 = g.start(() => {}, CFG);
chk('★ 没有输出流时直接返回 false（不再往下 setEncoding）', okStart3 === false, String(okStart3));
chk('★ 也没把它留在 running 里', g._state().running === false);

/* ── ④ stop() 之后，挂着的那次重试不许把它偷偷叫起来 ── */
console.log('');
console.log('── ④ stop() 之后的定时重试 ──');
nextWithStdio = true;
g.start(() => {}, CFG);
const before = spawned;
g.stop();
chk('stop() 之后 running=false', g._state().running === false);
/* ⚠️ 不去等那 10 秒 —— 只钉住"重试回调里必须再看一眼 handler"这个事实 */
const srcTxt = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'core', 'gamedetect.cjs'), 'utf8');
chk('★ 重试回调里带了 handler 判空（否则 stop 之后还会自己爬起来）',
  /setTimeout\(\(\) => \{ if \(handler && !child\)/.test(srcTxt));
chk('   spawned 没被偷偷加过', spawned === before, `${before} → ${spawned}`);

/* ---------- 收尾 ---------- */
g.stop();
fs.rmSync(HOME, { recursive: true, force: true });

console.log('');
console.log('─'.repeat(52));
console.log(`  ${pass}/${pass + fail} 通过${fail ? '  ✗ ' + fail + ' 项没过' : '  ✓ 全过'}`);
console.log('─'.repeat(52));
process.exit(fail ? 1 : 0);
