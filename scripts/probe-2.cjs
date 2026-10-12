/**
 * 第二批问题的实测探针（2026-10-12 他报的）。
 *
 *   ④ 朝左时眼动跟随是反的
 *   ①② 菜单/面板打开时，后面整块屏幕都点不到
 *   ③ 菜单页有透明度
 *
 * 跑法：node scripts/probe-2.cjs
 */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');
const CDP_PORT = 9335;
const HOME = path.join(ROOT, '_probe-home');
const RUN_MS = Number(process.env.PROBE_MS || 70000);

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
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (!page) throw new Error('没找到页面');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连不上')), { once: true });
    });
    const c = new CDP(ws);
    await c.send('Runtime.enable');
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
  async mouse(type, x, y, button = 'none') {
    await this.send('Input.dispatchMouseEvent', {
      type, x, y, button, clickCount: 1, buttons: button === 'left' ? 1 : 0,
    });
  }
}

async function main() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'),
    JSON.stringify({ petSize: 100, moveEnabled: false }, null, 2), 'utf8');

  try {
    require('node:child_process').execSync(
      'powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\')}*' } | ` +
      'ForEach-Object { $_.Kill() }"', { stdio: 'ignore' });
  } catch { /* 没有就算了 */ }
  await sleep(500);

  const child = spawn(electronPath, [`--remote-debugging-port=${CDP_PORT}`, ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, YACHIYO_MS: String(RUN_MS), YACHIYO_HOME: HOME },
    stdio: 'ignore',
  });

  let cdp = null;
  for (let i = 0; i < 40 && !cdp; i++) {
    await sleep(500);
    try { cdp = await CDP.attach(); } catch { /* 还没起来 */ }
  }
  if (!cdp) { console.error('窗口起不来'); child.kill(); process.exit(1); }

  await sleep(3000);
  console.log('\n连上了。\n');

  /* ═══════ ④ 眼动跟随方向 ═══════ */
  console.log('【④ 眼动跟随的方向】');
  console.log('  鼠标放她头【右边】，头应该往右偏（hx > 0）；放左边应该往左偏（hx < 0）\n');

  for (const flip of [1, -1]) {
    await cdp.evalJs(`
      const r = window.__yachiyo.rig;
      r.locked = true; r.setMode('idle'); r.flip = ${flip}; r.mouse.on = true;
      return 1;
    `);
    await sleep(200);

    const probe = await cdp.evalJs(`
      const r = window.__yachiyo.rig;
      const out = {};
      // 直接喂画布坐标，绕开鼠标事件 —— 只验数学
      for (const [name, dx] of [['右', 200], ['左', -200]]) {
        r.mouse = { x: 460.8 / 2 + dx, y: 300, on: true };
        for (let i = 0; i < 90; i++) r._updateGaze(1 / 60, 1);   // 让弹簧收敛
        out[name] = +r.gaze.hx.toFixed(2);
      }
      return { flip: r.flip, hx: out, ang: out };
    `);

    const okRight = probe.hx['右'] > 1;
    const okLeft = probe.hx['左'] < -1;
    console.log(`  flip=${String(flip).padStart(2)}（${flip === 1 ? '朝左' : '朝右'}）  ` +
      `鼠标在右 → hx=${String(probe.hx['右']).padStart(7)}   ` +
      `鼠标在左 → hx=${String(probe.hx['左']).padStart(7)}   ` +
      (okRight && okLeft ? '方向对 ✓' : '★ 方向反了'));
  }

  /* ═══════ ①② 菜单打开时的可点范围 ═══════ */
  console.log('\n【①② 菜单/面板打开时，窗口还穿不穿透】');
  console.log('  （她只占屏幕一小块，但如果整窗变成可点，后面整块屏幕就点不到了）\n');

  async function probeHit(label) {
    const st = await cdp.evalJs(`
      const d = window.__yachiyo.debug();
      return {
        want: d.want,
        menu: typeof menuOpen === 'function' ? undefined : undefined,
      };
    `);
    const win = await cdp.evalJs(`return window.yachiyo.win ? await window.yachiyo.win.state() : null;`);
    console.log(`  ${label.padEnd(14)} 页面要可点 = ${String(st.want).padEnd(5)}  ` +
      `主进程 ignoreMouseEvents = ${win ? win.ignoreMouseEvents : '?'}`);
    return st;
  }

  await cdp.evalJs(`return 1;`);
  let s = await probeHit('开局');
  const winState = s;

  // 打开右键菜单
  const hit = await cdp.evalJs(`return window.__yachiyo.hitProbe();`);
  await cdp.mouse('mousePressed', hit.x, hit.y, 'right');
  await cdp.mouse('mouseReleased', hit.x, hit.y, 'right');
  await sleep(500);
  s = await probeHit('右键菜单开着');

  // 量菜单实际占多大
  const menuBox = await cdp.evalJs(`
    const m = document.getElementById('menu');
    const r = m.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             vw: window.innerWidth, vh: window.innerHeight,
             opacity: getComputedStyle(m).opacity,
             bg: getComputedStyle(m).backgroundColor };
  `);
  const areaPct = ((menuBox.w * menuBox.h) / (menuBox.vw * menuBox.vh) * 100).toFixed(2);
  console.log(`\n  菜单本身只有 ${menuBox.w}×${menuBox.h}px，占全屏 ${areaPct}%`);

  // 关菜单，开设置面板
  await cdp.mouse('mousePressed', 20, 20, 'left');
  await cdp.mouse('mouseReleased', 20, 20, 'left');
  await sleep(300);
  await cdp.evalJs(`window.__yachiyo.openChat && 1; return 1;`);
  await cdp.evalJs(`document.getElementById('panel').classList.add('open'); return 1;`);
  await sleep(400);
  s = await probeHit('面板开着');

  const panelBox = await cdp.evalJs(`
    const p = document.getElementById('panel');
    const r = p.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height),
             opacity: getComputedStyle(p).opacity,
             bg: getComputedStyle(p).backgroundColor };
  `);
  console.log(`  面板 ${panelBox.w}×${panelBox.h}px  ` +
    `占全屏 ${((panelBox.w * panelBox.h) / (menuBox.vw * menuBox.vh) * 100).toFixed(2)}%`);

  /* ═══════ ③ 不透明度 ═══════ */
  console.log('\n【③ 菜单 / 面板 的不透明度】');
  for (const [name, box] of [['右键菜单', menuBox], ['设置面板', panelBox]]) {
    console.log(`  ${name}  opacity=${box.opacity}  背景=${box.bg}`);
  }

  /* ═══════ B 锁任务栏那条线 ═══════ */
  console.log('\n【B · 只能沿任务栏那条线平移】');

  const geo = await cdp.evalJs(`
    const d = window.__yachiyo.debug();
    return {
      winW: window.innerWidth, winH: window.innerHeight,
      pos: { x: +window.__yachiyo.pos.x.toFixed(1), y: +window.__yachiyo.pos.y.toFixed(1) },
      pet: window.__yachiyo.size,
    };
  `);
  console.log(`  窗口 ${geo.winW}×${geo.winH}　她 ${geo.pet.toFixed(1)}px　` +
    `她在窗口内的位置 (${geo.pos.x}, ${geo.pos.y})`);

  // 她的脚该正好落在窗口底边 = 任务栏上沿
  const feet = await cdp.evalJs(`
    const c = document.getElementById('pet');
    const g = c.getContext('2d', { willReadFrequently: true });
    const W = c.width, H = c.height;
    const d = g.getImageData(0, 0, W, H).data;
    let maxY = -1;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 16) { if (y > maxY) maxY = y; }
    }
    const rect = c.getBoundingClientRect();
    const sx = W / rect.width;
    return +(rect.top + maxY / sx).toFixed(1);
  `);
  console.log(`  她的脚在窗口 y=${feet}，窗口底边=${geo.winH}  →  ` +
    (Math.abs(feet - geo.winH) <= 2 ? '踩在线上 ✓' : `差 ${(geo.winH - feet).toFixed(1)}px ✗`));

  // ⚠️ 拖动测试之前**必须把面板关掉** ——
  //    mousedown 里有一句 `if (panelOpen()) return`，面板开着拖动会被直接吞掉，
  //    量出来是「她纹丝不动」，看着像纵向锁死生效了，其实是压根没开始拖。
  //    第一版就是这么误判的（横向那项显示差了 -200px）。
  await cdp.evalJs(`document.getElementById('panel').classList.remove('open'); return 1;`);
  await sleep(300);

  // ⚠️⚠️ 拖之前必须**冻住状态机**。
  //    不冻的话她自己会走，量「拖了多远」的时候把走的那段也算进去 ——
  //    第一版就是这么量出「横向差了 174px」的：拖动本身是准的，
  //    是她一边被拖一边自己又走了 26px。
  await cdp.evalJs(`const r = window.__yachiyo.rig; r.locked = true; r.setMode('idle'); return 1;`);
  await sleep(400);

  const readPos = () => cdp.evalJs(
    `return { x: +window.__yachiyo.pos.x.toFixed(1), y: +window.__yachiyo.pos.y.toFixed(1) };`);

  // ---- 纵向拖 260px：应该纹丝不动 ----
  const b0 = await readPos();
  const hitB = await cdp.evalJs(`return window.__yachiyo.hitProbe();`);
  await cdp.mouse('mousePressed', hitB.x, hitB.y, 'left');
  for (let dy = -40; dy >= -260; dy -= 40) {          // 往上拖 260px
    await cdp.mouse('mouseMoved', hitB.x, hitB.y + dy, 'left');
    await sleep(70);
  }
  await cdp.mouse('mouseReleased', hitB.x, hitB.y - 260, 'left');
  await sleep(500);
  const b1 = await readPos();
  console.log(`  往上拖 260px：(y ${b0.y} → ${b1.y})　` +
    (Math.abs(b1.y - b0.y) <= 1 ? '纵向没动 ✓' : `纵向跑了 ${(b1.y - b0.y).toFixed(1)}px ✗`));

  // ---- 横向拖 200px：应该跟手 ----
  const c0 = await readPos();
  const hitC = await cdp.evalJs(`return window.__yachiyo.hitProbe();`);
  await cdp.mouse('mousePressed', hitC.x, hitC.y, 'left');
  // ⚠️ 每一步发**两遍** —— CDP 的 mouseMoved 实测约每三次丢一次，
  //    分 5 步拖 200px 的时候丢掉一两步，量出来就是「移动了 105px」，
  //    看着像拖动算错了，其实是输入根本没送到。
  //    （同一个坑在 selfcheck.cjs 的 mouseTo 里也踩过。）
  for (let dx = -40; dx >= -200; dx -= 40) {
    await cdp.mouse('mouseMoved', hitC.x + dx, hitC.y, 'left');
    await sleep(50);
    await cdp.mouse('mouseMoved', hitC.x + dx, hitC.y, 'left');
    await sleep(50);
  }
  await cdp.mouse('mouseReleased', hitC.x - 200, hitC.y, 'left');
  await sleep(500);
  const c1 = await readPos();

  // 量的东西对不上时，中间量必须打出来 —— 只看首尾两个数猜不出是哪一环错的
  const mid = await cdp.evalJs(`return ({
    mode: window.__yachiyo.rig.mode,
    locked: window.__yachiyo.rig.locked,
    moveEnabled: window.__yachiyo.cfg.moveEnabled,
    petX: window.__yachiyo.cfg.petX,
  })`);

  const moved = c0.x - c1.x;
  console.log(`  往左拖 200px：(x ${c0.x} → ${c1.x})　实际移动 ${moved.toFixed(1)}px　` +
    (Math.abs(moved - 200) <= 6 ? '横向跟手 ✓' : `差了 ${(moved - 200).toFixed(1)}px ✗`));
  console.log(`    （她身上那个点 hitC.x=${hitC.x}　` +
    `状态=${mid.mode} locked=${mid.locked} moveEnabled=${mid.moveEnabled} 存的petX=${mid.petX}）`);

  /* ═══════ 窗口本身多大 ═══════ */
  const w = await cdp.evalJs(`
    return { w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio };
  `);
  console.log(`\n  窗口 = ${w.w}×${w.h} CSS px —— 菜单只占一小块，` +
    `但整窗一旦变成可点，**整块屏幕**都点不到后面的东西\n`);

  child.kill();
  await sleep(400);
  process.exit(0);
}

main().catch((err) => { console.error('\n探针炸了：', err.message); process.exit(1); });
