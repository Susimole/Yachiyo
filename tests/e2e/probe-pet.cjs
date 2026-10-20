/*
 * 探针：主窗口「她真的画出来了吗」（2026-10-21 新加，拆 app.js 的安全网）
 *
 * 为什么非要有：`probe-settings` 只验设置面板；`app.js`（她走动/坐/睡那条主循环）
 * 以前**一张渲染基线都没有**。拆 app.js 前必须先有"她还画得出来"这个底。
 *
 * 判据挑的都是**行为**，不是数行数：
 *   1. `window.__yachiyo` 在（app.js 跑完了，不是半路抛死）
 *   2. rig 加载出 N 个件（她那套骨架真读进来了）
 *   3. `hitProbe()` 能扫到**一块落在她身上的实心像素** —— 这条最硬：
 *      它扫的是画布 alpha，画不出来就扫不到。坐姿/站姿都成立，
 *      因为它只找"最靠重心的一块实心像素"，不猜固定比例。
 *   4. canvas 尺寸 > 0、气泡元素在
 *   5. 页面里没有 JS 异常
 *
 * 跑法：node tests/e2e/probe-pet.cjs（自己起 Electron，跑完自己关，隔离 HOME）
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..', '..');
const HOME = path.join(os.tmpdir(), 'yachiyo-pet-probe');
const PORT = 9367;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pass = [];
const fail = [];
const chk = (name, ok, extra) => {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra !== undefined ? '   → ' + JSON.stringify(extra) : ''}`);
};

function killAll() {
  try {
    execSync('powershell.exe -NoProfile -Command "Get-Process electron,Yachiyo -ErrorAction SilentlyContinue | Stop-Process -Force"',
      { stdio: 'ignore', windowsHide: true });
  } catch { /* 没有正好 */ }
}

const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

async function connect(t, tries = 6) {
  const target = (t && typeof t === 'object') ? t.webSocketDebuggerUrl : t;
  if (typeof target !== 'string' || !/^ws/.test(target)) throw new Error('connect 参数不对');
  let ws = null;
  for (let i = 0; i < tries; i++) {
    try {
      ws = new WebSocket(target);
      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
        setTimeout(() => rej(new Error('ws timeout')), 4000);
      });
      break;
    } catch { ws = null; await sleep(800); }
  }
  if (!ws) throw new Error('连不上 CDP');
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const ev = async (expression) => {
    const id = ++seq;
    const p = new Promise((r) => pending.set(id, r));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    const r = await p;
    if (r.result && r.result.exceptionDetails) {
      return { __err: String(((r.result.exceptionDetails.exception || {}).description) || '').slice(0, 300) };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  return { ws, ev };
}

async function main() {
  console.log('探针：主窗口渲染基线（拆 app.js 的安全网）\n');
  killAll();
  await sleep(600);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.YACHIYO_HOME = HOME;

  const child = spawn(require('electron'), ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, windowsHide: true });

  let mainT = null;
  for (let i = 0; i < 30 && !mainT; i++) {
    await sleep(900);
    try { mainT = (await list()).find((t) => t.type === 'page' && t.url.includes('index.html')); } catch { /* 还没起 */ }
  }
  chk('主窗口起来了', !!mainT, mainT && mainT.url);
  if (!mainT) { try { child.kill(); } catch { } process.exit(1); }

  const M = await connect(mainT);
  await sleep(2000);   // 等她加载立绘、画第一帧

  await M.ev(`(() => { window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message || e))); return true; })()`);

  const hook = await M.ev(`typeof window.__yachiyo === 'object' && window.__yachiyo !== null`);
  chk('★ app.js 跑到底了（window.__yachiyo 在）', hook === true, hook);

  const info = await M.ev(`(() => {
    const y = window.__yachiyo;
    const c = document.getElementById('pet');
    let parts = null;
    try {
      const r = y && y.rig;
      parts = r ? (Array.isArray(r.parts) ? r.parts.length : (r.pieces ? r.pieces.length : Object.keys(r).length)) : null;
    } catch (e) { parts = 'err:' + e.message; }
    return {
      hasRig: !!(y && y.rig),
      setName: y ? String(y.setName || '') : '',
      parts,
      cfgModel: y && y.cfg ? String(y.cfg.model || '') : '',
      cvsW: c ? c.width : -1,
      cvsH: c ? c.height : -1,
      hasBubble: !!document.getElementById('bubble'),
      size: y ? Number(y.size) || 0 : 0,
    };
  })()`);
  chk('★ 骨架加载了（rig 在 + 有件数）', !!info && info.hasRig && info.parts > 0,
    info && { setName: info.setName, parts: info.parts });
  chk('配置读进来了（cfg.model 非空）', !!info && !!info.cfgModel, info && info.cfgModel);
  chk('canvas 尺寸 > 0', !!info && info.cvsW > 0 && info.cvsH > 0, info && [info.cvsW, info.cvsH]);
  chk('气泡元素在', !!info && info.hasBubble === true, '');

  // ★ 最硬的一条：扫画布 alpha，找一块落在她身上的实心像素
  const hit = await M.ev(`(() => {
    try {
      const p = window.__yachiyo.hitProbe();
      return p ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
    } catch (e) { return { err: e.message }; }
  })()`);
  chk('★ 她真的画出来了（画布 alpha 里扫到实心像素）', !!hit && !hit.err && typeof hit.x === 'number', hit);

  // 挪一下位置：证明主循环还活着（不是画了一帧就死）
  const moved = await M.ev(`(() => {
    const y = window.__yachiyo;
    const before = y.pos.x;
    y.place(Math.round(before) + 60);
    return { before, after: y.pos.x };
  })()`);
  chk('★ 还能被挪动（主循环没死）', !!moved && moved.after !== moved.before, moved);

  const errs = await M.ev(`JSON.stringify(window.__errs || [])`);
  chk('页面没有 JS 异常', errs === '[]' || errs === undefined, errs);

  try { child.kill(); } catch { }
  await sleep(400);
  killAll();

  console.log('');
  console.log('─'.repeat(52));
  console.log(`  ${pass.length}/${pass.length + fail.length} 通过  ${fail.length ? '✗ 有失败' : '✓ 全过'}`);
  console.log('─'.repeat(52));
  if (fail.length) { console.log('失败明细：'); for (const f of fail) console.log('  - ' + f); }
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error('探针自己炸了：', e.message); try { killAll(); } catch { } process.exit(1); });
