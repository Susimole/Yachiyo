/**
 * 拖动时面朝方向跟鼠标同步 —— 2026-10-12 最后一项的验收。
 *
 * 他要的：「拖动桌宠时桌宠面朝方向和鼠标移动方向同步，落地后保留同步后的面朝方向」。
 *
 * ⚠️ 用 CDP 的**真鼠标**走一遍：按下 → 一路往右 → 松手 → 再按下 → 一路往左 →
 *    松手，每一步都量 `facing` 和 `rig.flip`（这两个必须永远一致，
 *    不然就是「脸和腿分家」）。
 *
 * 跑法：node scripts/probe-dragface.cjs
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9366;
const HOME = path.join(ROOT, '_probe-drag-home');
const RUN_MS = Number(process.env.PROBE_MS || 90000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pend = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pend.has(m.id)) {
        const { res, rej } = this.pend.get(m.id);
        this.pend.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  static async attach() {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl
      && !/(menu|panel|chat|ask)\.html/.test(t.url || ''));
    if (!p) throw new Error('没找到主窗口');
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连不上')), { once: true });
    });
    const c = new CDP(ws);
    await c.send('Runtime.enable');
    try { await c.send('Page.enable'); } catch { /* */ }
    return c;
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pend.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pend.has(id)) { this.pend.delete(id); rej(new Error(method + ' 超时')); } }, 15000);
    });
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  }
  async mouse(type, x, y, button = 'none', buttons = 0) {
    await this.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1, buttons });
  }
}

let child = null;
const fail = [];
const ok = (cond, msg, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '   ' + extra : ''}`);
  if (!cond) fail.push(msg);
};

async function killElectron() {
  try { child?.kill(); } catch { /* 没了 */ }
  try {
    execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\')}*' } | ` +
      'ForEach-Object { $_.Kill() }"', { stdio: 'ignore' });
  } catch { /* 干净退了 */ }
}

const STATE = `return { facing: window.__yachiyo.facing, flip: window.__yachiyo.rig.flip,
                       x: Math.round(window.__yachiyo.pos.x) };`;

/**
 * 从她身上按下，往某个方向拖 `total` 像素后松手。
 * ⚠️ 每一步都要「发两次」—— CDP 的 mouseMoved 大概每三次丢一次（实测），
 *    拖拽这种靠一串位移累积的东西，丢一步就少走一截。
 */
async function dragBy(m, from, dir, total, step = 20, onStep = null) {
  await m.mouse('mouseMoved', from.x, from.y);
  await m.mouse('mousePressed', from.x, from.y, 'left', 1);
  await sleep(80);
  let moved = 0;
  while (moved < total) {
    moved = Math.min(total, moved + step);
    const x = from.x + dir * moved;
    await m.mouse('mouseMoved', x, from.y, 'none', 1);
    await m.mouse('mouseMoved', x, from.y, 'none', 1);
    await sleep(45);
    if (onStep) await onStep(moved, x);
  }
  await m.mouse('mouseReleased', from.x + dir * total, from.y, 'left', 0);
  await sleep(250);
}

async function main() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  // ⚠️ moveEnabled:false —— 别让她自己在测试中间走掉，位置一变 hitProbe 就失效了
  fs.writeFileSync(path.join(HOME, 'config.json'),
    JSON.stringify({ petSize: 100, moveEnabled: false, moveSpeed: 100 }, null, 2), 'utf8');

  await killElectron();
  await sleep(500);

  child = spawn(electronPath, [`--remote-debugging-port=${CDP_PORT}`, ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, YACHIYO_MS: String(RUN_MS), YACHIYO_HOME: HOME },
    stdio: 'ignore',
  });

  let m = null;
  for (let i = 0; i < 50 && !m; i++) { await sleep(500); try { m = await CDP.attach(); } catch { /* 还没起来 */ } }
  if (!m) { await killElectron(); throw new Error('Electron 没起来'); }

  try {
    await sleep(3000);
    // 钉住状态机 + 把她放到屏幕中间，两边都留出拖的余地
    await m.evalJs(`const r = window.__yachiyo.rig; r.locked = true; r.setMode('idle');
      window.__yachiyo.place(500); return 1;`);
    await sleep(400);

    const start = await m.evalJs(STATE);
    console.log(`\n起点：facing=${start.facing} flip=${start.flip} x=${start.x}`);
    console.log(`（约定：facing=1 朝右 = 原立绘朝向；这一条是从 rig.json 的鼻子/瞳孔/后发位置量出来的）`);

    /* ---- ① 往右拖 ---- */
    console.log('\n[1] 按住她，一路往**右**拖');
    const hit = await m.evalJs(`return window.__yachiyo.hitProbe();`);
    const seen = [];
    await dragBy(m, hit, 1, 160, 20, async (moved) => {
      const s = await m.evalJs(STATE);
      seen.push({ moved, ...s });
    });
    console.log('   过程:', seen.map((s) => `${s.moved}px→f${s.facing}`).join(' '));
    const right = await m.evalJs(STATE);
    ok(right.facing === 1, '往右拖 → 她朝右（facing = 1）', `facing=${right.facing}`);
    ok(right.flip === 1, 'rig.flip 跟着一起是 1（不然脸和腿分家）', `flip=${right.flip}`);
    ok(right.x > start.x, '位置也真的往右走了（这条是基线）', `${start.x} → ${right.x}`);
    ok(seen.length >= 3 && seen[seen.length - 1].facing === 1,
      '是**拖的过程中**就转过去的，不是松手才补', seen.map((s) => s.facing).join(','));

    /* ---- ② 松手 → 保留 ---- */
    console.log('\n[2] 松手，方向要**保留**');
    await sleep(900);                      // 等她（可能被点击逻辑）做点什么
    const afterRelease = await m.evalJs(STATE);
    ok(afterRelease.facing === 1,
      '松手之后还是朝右（没有被弹回默认）', `facing=${afterRelease.facing}`);
    ok(afterRelease.flip === 1, 'flip 也留着', `flip=${afterRelease.flip}`);

    /* ---- ③ 再按住，往左拖 ---- */
    console.log('\n[3] 再按住，一路往**左**拖');
    const hit2 = await m.evalJs(`return window.__yachiyo.hitProbe();`);
    const seen2 = [];
    await dragBy(m, hit2, -1, 200, 20, async (moved) => {
      seen2.push(await m.evalJs(STATE));
    });
    console.log('   过程:', seen2.map((s, i) => `${(i + 1) * 20}px→f${s.facing}`).join(' '));
    const left = await m.evalJs(STATE);
    ok(left.facing === -1, '往左拖 → 她朝左（facing = -1）', `facing=${left.facing}`);
    ok(left.flip === -1, 'flip 跟着是 -1', `flip=${left.flip}`);
    ok(left.x < right.x, '位置往左走了', `${right.x} → ${left.x}`);

    /* ---- ④ 抖动不该让她甩头 ---- */
    console.log('\n[4] 手抖（±3px 来回）不该让她甩头');
    const hit3 = await m.evalJs(`return window.__yachiyo.hitProbe();`);
    await m.mouse('mouseMoved', hit3.x, hit3.y);
    await m.mouse('mousePressed', hit3.x, hit3.y, 'left', 1);
    await sleep(80);
    const jitter = [3, -3, 3, -3, 3, -3, 3, -3];
    for (let i = 0; i < jitter.length; i++) {
      // 累积位移在 ±3 之间来回，远不到 12px 的翻身阈值
      await m.mouse('mouseMoved', hit3.x + (jitter[i] > 0 ? 3 : 0), hit3.y, 'none', 1);
      await sleep(40);
    }
    const jit = await m.evalJs(STATE);
    await m.mouse('mouseReleased', hit3.x, hit3.y, 'left', 0);
    await sleep(200);
    ok(jit.facing === -1, '抖了几下方向没变（迟滞起作用了）', `facing=${jit.facing}`);
  } finally {
    await killElectron();
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
}

main().catch(async (e) => { console.error(e); await killElectron(); process.exit(1); });
