/**
 * 站坐过渡（C 方案「挤压展开」）的验收探针 —— 2026-10-12。
 *
 * 他选的是预览稿里的 C 项，参数直接照搬预览默认值。
 * 这里要证明落地版本跟预览是同一回事：
 *   ① 换套那一瞬间 `rig.xf` 起来了，约 transitionMs 之后自己消失（不会卡住）
 *   ② 过场**真的在画两层**（站立层还没淡完，坐姿层已经在进来）
 *   ③ 挤压：过渡中她比两端都矮（压扁 16%），但**底边一动不动**（踩在地上）
 *   ④ transitionMs = 0 时是硬切（老行为，一键回退的路还在）
 *
 * 跑法：node scripts/probe-transition.cjs
 * 产出：_sleep-shots/xf-00..05.png —— 一条过场胶片
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9337;
const HOME = path.join(ROOT, '_probe-xf-home');
// ⚠️ 出图目录跟 probe-sleep 错开 —— 两边都是 `rmSync(OUT)` 开头，
//    共用一个目录的话后跑的那个会把前一个的截图全清掉。
const OUT = path.join(ROOT, '_xf-shots');
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
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes('index.html'));
    if (!page) throw new Error('没找到主窗口页面');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连不上')), { once: true });
    });
    const c = new CDP(ws);
    await c.send('Runtime.enable');
    await c.send('Page.enable');
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
  async shot(file, clip, scale = 1) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale } });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  }
}

/** 画布上不透明像素的上下沿（画布物理像素） */
const EDGES = `
  const c = document.getElementById('pet');
  const g = c.getContext('2d', { willReadFrequently: true });
  const W = c.width, H = c.height;
  const d = g.getImageData(0, 0, W, H).data;
  let top = -1, bot = -1, solid = 0;
  for (let y = 0; y < H; y++) {
    let hit = 0;
    for (let x = 0; x < W; x++) { if (d[(y * W + x) * 4 + 3] > 16) { hit++; } }
    if (hit) { if (top < 0) top = y; bot = y; solid += hit; }
  }
  const r = window.__yachiyo.rig;
  return {
    top, bot, h: bot - top + 1, solid,
    t: r.xf ? +r.xf.t.toFixed(4) : null,
    from: r.xf ? r.xf.from.name : null,
    setName: r.setName,
    mode: r.mode,
  };
`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'),
    JSON.stringify({ petSize: 100, moveEnabled: false, roam: 'quiet', theme: 'light' }, null, 2), 'utf8');

  try {
    execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\')}*' } | ` +
      'ForEach-Object { $_.Kill() }"', { stdio: 'ignore' });
  } catch { /* 没有就算了 */ }
  await sleep(500);

  const child = spawn(electronPath, [`--remote-debugging-port=${CDP_PORT}`, ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, YACHIYO_MS: String(RUN_MS), YACHIYO_HOME: HOME },
    stdio: 'ignore',
  });

  let cdp = null;
  for (let i = 0; i < 50 && !cdp; i++) {
    await sleep(500);
    try { cdp = await CDP.attach(); } catch { /* 还没起来 */ }
  }
  if (!cdp) { child.kill(); throw new Error('Electron 没起来'); }

  const fail = [];
  const ok = (cond, msg, extra) => {
    console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '   ' + extra : ''}`);
    if (!cond) fail.push(msg);
  };

  try {
    await sleep(2500);
    const win = await cdp.evalJs(`return { w: window.innerWidth, h: window.innerHeight };`);

    // ---- 1. 起来 / 落下去 / 时长 ----
    console.log('\n[1] 过场的生命周期');
    await cdp.evalJs(`const r = window.__yachiyo.rig; r.locked = true; r.transitionMs = 420; r.setMode('idle'); return 1;`);
    await sleep(900);
    const idleH = (await cdp.evalJs(EDGES)).h;

    await cdp.evalJs(`window.__yachiyo.rig.setMode('sit'); return 1;`);
    const t0 = Date.now();
    const live0 = await cdp.evalJs(EDGES);
    ok(live0.t !== null, '换套的瞬间 xf 起来了', `t=${live0.t}`);
    const seen = [];
    let goneAt = -1;
    for (let i = 0; i < 60; i++) {
      const e = await cdp.evalJs(EDGES);
      seen.push({ ms: Date.now() - t0, ...e });
      if (e.t === null) { goneAt = Date.now() - t0; break; }
      await sleep(25);
    }
    ok(goneAt > 0, '过场自己结束了（不会卡住）', `${goneAt}ms`);
    ok(goneAt >= 350 && goneAt <= 900, '过场时长 ≈ 420ms', `${goneAt}ms`);
    ok(seen.some((s) => s.t !== null && s.t > 0.3 && s.t < 0.7), '采到了中间帧（不是一步跳完）',
       seen.filter((s) => s.t !== null).map((s) => s.t).join(' '));

    // ---- 2. 真的在画两层 ----
    console.log('\n[2] 两层同时在画（重叠段 0.3 ~ 0.455）');
    const overlap = seen.find((s) => s.t !== null && s.t > 0.30 && s.t < 0.45);
    ok(!!overlap, '存在「站立还没淡完、坐姿已经进来」的那几帧',
       overlap ? `t=${overlap.t} 实体 ${overlap.solid}px` : '没采到');

    // ---- 3. 挤压：中间比两端矮，底边不动 ----
    console.log('\n[3] 挤压展开：压扁 + 脚不动');
    await sleep(900);
    const sitE = await cdp.evalJs(EDGES);
    const mid = seen.filter((s) => s.t !== null && s.t > 0.35 && s.t < 0.75);
    const midH = mid.length ? mid.map((s) => s.h).reduce((a, b) => a + b, 0) / mid.length : 0;
    console.log(`   站立高 ${idleH}px · 坐姿高 ${sitE.h}px · 过场中段平均高 ${midH.toFixed(1)}px`);
    ok(midH > 0 && midH < Math.min(idleH, sitE.h) * 0.995,
       '过场里被压扁了（比两端都矮）', `中段 ${midH.toFixed(1)} vs 两端 ${Math.min(idleH, sitE.h)}`);

    const bots = seen.map((s) => s.bot);
    const bMin = Math.min(...bots), bMax = Math.max(...bots);
    ok(bMax - bMin <= 4, '整个过场里底边没动（踩在地上）',
       `波动 ${bMax - bMin}px  (${bMin}~${bMax})`);

    // ---- 4. 关掉 = 硬切 ----
    console.log('\n[4] transitionMs = 0 = 硬切（一键回退）');
    await cdp.evalJs(`const r = window.__yachiyo.rig; r.transitionMs = 0; r.setMode('idle'); return 1;`);
    await sleep(700);
    await cdp.evalJs(`window.__yachiyo.rig.setMode('sit'); return 1;`);
    const hard = await cdp.evalJs(EDGES);
    ok(hard.t === null, '关掉之后 xf 压根没起来', `t=${hard.t}`);

    // ---- 胶片 ----
    console.log('\n[5] 出胶片');
    await cdp.evalJs(`const r = window.__yachiyo.rig; r.transitionMs = 420; r.setMode('idle'); return 1;`);
    await sleep(900);
    await cdp.shot('xf-00.png', { x: 0, y: 0, width: win.w, height: win.h }, 2);
    await cdp.evalJs(`window.__yachiyo.rig.setMode('sit'); return 1;`);
    for (let i = 1; i <= 5; i++) {
      await sleep(85);
      await cdp.shot(`xf-0${i}.png`, { x: 0, y: 0, width: win.w, height: win.h }, 2);
    }
    await sleep(700);
    await cdp.shot('xf-06.png', { x: 0, y: 0, width: win.w, height: win.h }, 2);
    console.log('   xf-00..06.png（每 ~85ms 一格）');
  } finally {
    try { child.kill(); } catch { /* 已经没了 */ }
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exit(1); });
