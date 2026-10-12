/**
 * 三个 bug 的实测探针（2026-10-11 他报的）。
 *
 *   ① 低倍率（<50%）下锯齿
 *   ② 点她会不停换动作
 *   ③ 她跟任务栏不贴合
 *
 * 只量、不改。产出截图 + 数字，让方案有据可依。
 *
 * 跑法：node scripts/probe-bugs.cjs
 */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9334;
const HOME = path.join(ROOT, '_probe-home');
const OUT = path.join(ROOT, '_bug-shots');
const RUN_MS = Number(process.env.PROBE_MS || 60000);

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
  async mouse(type, x, y, button = 'none') {
    await this.send('Input.dispatchMouseEvent', {
      type, x, y, button, clickCount: 1, buttons: button === 'left' ? 1 : 0,
    });
  }
  /**
   * ⚠️ scale 必须给 dpr，不能给 1 ——
   *    clip 的坐标是【CSS 像素】，scale:1 输出的就是 CSS 像素大小的图，
   *    相当于把设备像素又降采样了一次。低倍率下这一降
   *    正好把要看的锯齿抹平，看着「挺平滑」——我第一版就是这么被自己骗过去的。
   */
  async shot(file, clip, scale = 1) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale } });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
    return file;
  }
}

/**
 * 在页面里量她：不透明像素的包围盒（换算成**窗口 CSS 像素**）。
 * 顺带数一下边缘过渡带的分布 —— 锯齿的量化指标。
 */
const MEASURE = `
  const c = document.getElementById('pet');
  const g = c.getContext('2d', { willReadFrequently: true });
  const W = c.width, H = c.height;
  const d = g.getImageData(0, 0, W, H).data;
  const rect = c.getBoundingClientRect();
  const sx = W / rect.width;                 // 物理px ÷ 这个 = CSS px

  let minX = W, maxX = -1, minY = H, maxY = -1, solid = 0;
  // 每行最左/最右的不透明像素 —— 用来量边缘过渡带
  const edgeRun = [];
  for (let y = 0; y < H; y++) {
    let rowMin = -1, rowMax = -1;
    for (let x = 0; x < W; x++) {
      const a = d[(y * W + x) * 4 + 3];
      if (a > 16) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        if (rowMin < 0) rowMin = x; rowMax = x;
        solid++;
      }
    }
    // 从 rowMin 往右数「半透明到实心」的宽度 = 抗锯齿过渡带
    if (rowMin >= 0) {
      let t = 0;
      for (let x = rowMin; x < W && d[(y * W + x) * 4 + 3] < 250; x++) t++;
      edgeRun.push(t);
    }
  }
  edgeRun.sort((a, b) => a - b);
  const pick = (p) => edgeRun.length ? edgeRun[Math.floor(edgeRun.length * p)] : 0;

  return {
    dpr: window.devicePixelRatio,
    canvasPx: { w: W, h: H },
    canvasCss: { w: +rect.width.toFixed(2), h: +rect.height.toFixed(2) },
    stage: { x: +window.__yachiyo.pos.x.toFixed(1), y: +window.__yachiyo.pos.y.toFixed(1) },
    petSize: window.__yachiyo.cfg.petSize,
    // 她的包围盒（窗口 CSS 像素）
    box: {
      left:   +(rect.left + minX / sx).toFixed(1),
      right:  +(rect.left + maxX / sx).toFixed(1),
      top:    +(rect.top  + minY / sx).toFixed(1),
      bottom: +(rect.top  + maxY / sx).toFixed(1),
    },
    // 她脚下沿在框内的相对位置（0=框顶 1=框底）
    footRatio: +((maxY / (H - 1))).toFixed(4),
    solidRatio: +(solid / (W * H)).toFixed(4),
    // 抗锯齿过渡带（物理px）：中位/90分位。越接近 0 = 硬边 = 锯齿
    aa: { p50: pick(0.5), p90: pick(0.9) },
    workAreaH: window.innerHeight,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'),
    JSON.stringify({ petSize: 100, moveEnabled: false, roam: 'quiet' }, null, 2), 'utf8');

  try {
    const { execSync } = require('node:child_process');
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
  for (let i = 0; i < 40 && !cdp; i++) {
    await sleep(500);
    try { cdp = await CDP.attach(); } catch { /* 还没起来 */ }
  }
  if (!cdp) { console.error('窗口起不来'); child.kill(); process.exit(1); }

  await sleep(3000);
  console.log('\n连上了。\n');

  /* ═══ ① 低倍率锯齿 ═══ */
  console.log('【① 低倍率锯齿】');
  console.log('  倍率   画布物理      画布CSS    她占画面   边缘过渡带 p50/p90   底部(窗口内)');
  const shots = [];
  for (const size of [100, 50, 25, 15]) {
    await cdp.evalJs(`await window.yachiyo.cfg.set('petSize', ${size}); return 1;`);
    await sleep(700);
    // 冻住状态机 + 收掉气泡，截图才可比（不然一张站一张坐一张被气泡挡脸）
    await cdp.evalJs(`window.__yachiyo.rig.locked = true; window.__yachiyo.rig.setMode('idle'); return 1;`);
    await sleep(250);
    const m = await cdp.evalJs(MEASURE);

    // 裁她周围，看锯齿
    const pad = 30;
    const clip = {
      x: Math.max(0, Math.round(m.box.left - pad)),
      y: Math.max(0, Math.round(m.box.top - pad)),
      width: Math.round(m.box.right - m.box.left + pad * 2),
      height: Math.round(m.box.bottom - m.box.top + pad * 2),
    };
    if (clip.width > 4 && clip.height > 4) {
      const f = `放大率${String(size).padStart(3)}%.png`;
      await cdp.shot(f, clip, m.dpr);
      shots.push(f);
    }

    console.log(
      `  ${String(size).padStart(3)}%   ${String(m.canvasPx.w).padStart(4)}×${String(m.canvasPx.h).padEnd(4)}  ` +
      `${String(m.canvasCss.w).padStart(7)}  ${(m.solidRatio * 100).toFixed(1).padStart(6)}%   ` +
      `${String(m.aa.p50).padStart(4)} / ${String(m.aa.p90).padStart(4)}      ` +
      `${String(m.box.bottom).padStart(7)}  (窗口高 ${m.workAreaH})`
    );
  }

  /* ═══ ①-b 对照实验：把采样质量调高有没有用 ═══ */
  console.log('\n【①-b 对照 · imageSmoothingQuality = high】');
  console.log('  （这决定修法是「一行改设置」还是「得预生成多级缩略图」）\n');
  for (const size of [100, 50, 25, 15]) {
    await cdp.evalJs(`await window.yachiyo.cfg.set('petSize', ${size}); return 1;`);
    await sleep(600);
    const before = await cdp.evalJs(MEASURE);

    await cdp.evalJs(`
      document.getElementById('pet').getContext('2d').imageSmoothingQuality = 'high';
      return 1;
    `);
    await sleep(400);
    const after = await cdp.evalJs(MEASURE);

    // 数一下「硬边」（过渡带 ≤1 像素）在她轮廓上占多少
    const hardPct = (m) => {
      const c = m.canvasPx.w;
      return m.aa.p50;
    };
    console.log(`  ${String(size).padStart(3)}%   ` +
      `默认 low: p50=${before.aa.p50} p90=${before.aa.p90}   →   ` +
      `high: p50=${after.aa.p50} p90=${after.aa.p90}   ` +
      (after.aa.p50 > before.aa.p50 ? '← 有改善' : '← 没变'));
  }

  /* ═══ ③ 贴不贴任务栏 ═══ */
  console.log('\n【③ 跟任务栏贴不贴】');
  console.log('  任务栏上沿 = 窗口底边 = window.innerHeight\n');
  for (const size of [200, 100, 50, 25]) {
    await cdp.evalJs(`await window.yachiyo.cfg.set('petSize', ${size}); return 1;`);
    await sleep(600);
    const m = await cdp.evalJs(MEASURE);
    const gap = m.workAreaH - m.box.bottom;
    console.log(`  ${String(size).padStart(3)}%   她的脚 = ${String(m.box.bottom).padStart(7)}   ` +
      `窗口底 = ${m.workAreaH}   ` +
      (gap > 1 ? `悬空 ${gap.toFixed(1)}px` : gap < -1 ? `扎进任务栏 ${(-gap).toFixed(1)}px` : '贴合 ✓') +
      `   （框内落点 ${(m.footRatio * 100).toFixed(1)}%）`);
  }

  /* ═══ ② 点她会不会换动作 ═══ */
  console.log('\n【② 点她换不换动作】');
  await cdp.evalJs(`await window.yachiyo.cfg.set('petSize', 100); return 1;`);
  await sleep(800);

  const before = await cdp.evalJs(`const r = window.__yachiyo.rig; return { mode: r.mode, state: r.state.name };`);
  console.log(`  点之前：${before.mode} / ${before.state}`);

  const seq = [];
  for (let i = 0; i < 6; i++) {
    const hit = await cdp.evalJs(`return window.__yachiyo.hitProbe();`);
    if (!hit) { console.log('  找不到她，停'); break; }
    await cdp.mouse('mousePressed', hit.x, hit.y, 'left');
    await cdp.mouse('mouseMoved', hit.x, hit.y, 'left');
    await sleep(60);
    await cdp.mouse('mouseReleased', hit.x, hit.y, 'left');
    await sleep(320);
    const st = await cdp.evalJs(`
      const r = window.__yachiyo.rig;
      return { mode: r.mode, state: r.state.name, y: +window.__yachiyo.pos.y.toFixed(1) };
    `);
    seq.push(st.mode);
    console.log(`  第 ${i + 1} 次点击 → ${st.mode} / ${st.state}`);
  }
  const uniq = [...new Set(seq)];
  console.log(`\n  6 次点击出现 ${uniq.length} 种动作：${uniq.join(' / ')}` +
    (uniq.length > 1 ? '   ← 他说的「不断切换」' : '   ← 没换'));

  /* ═══ ④ 呼吸：脚动不动 ═══ */
  console.log('\n【④ 呼吸 —— 脚到底动不动】');
  console.log('  （squash 的卖点就是「脚踩死、上半身伸缩」；shift 是老做法，整体平移）\n');

  async function sampleBreath(label) {
    const tops = [], feet = [];
    for (let i = 0; i < 45; i++) {
      const m = await cdp.evalJs(`
        const c = document.getElementById('pet');
        const g = c.getContext('2d', { willReadFrequently: true });
        const W = c.width, H = c.height;
        const d = g.getImageData(0, 0, W, H).data;
        let minY = H, maxY = -1;
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          if (d[(y * W + x) * 4 + 3] > 16) { if (y < minY) minY = y; if (y > maxY) maxY = y; }
        }
        const rect = c.getBoundingClientRect();
        const sx = W / rect.width;
        return { top: rect.top + minY / sx, foot: rect.top + maxY / sx };
      `);
      tops.push(m.top); feet.push(m.foot);
      await sleep(100);
    }
    const rng = (a) => Math.max(...a) - Math.min(...a);
    return { top: rng(tops), foot: rng(feet) };
  }

  for (const style of ['squash', 'shift']) {
    await cdp.evalJs(`
      await window.yachiyo.cfg.set('breathStyle', '${style}');
      const r = window.__yachiyo.rig;
      r.breathStyle = '${style}';
      r.locked = true; r.setMode('idle');
      return 1;
    `);
    await sleep(1500);
    const r = await sampleBreath(style);
    console.log(`  ${style.padEnd(7)} 头顶起伏 ${r.top.toFixed(1).padStart(5)}px   ` +
      `脚下起伏 ${r.foot.toFixed(1).padStart(5)}px   ` +
      // 判据用【头顶:脚】的比值 —— 绝对像素里混着抗锯齿边缘的测量噪声（约 0.8px），
      // 卡绝对阈值会把噪声当成「脚在动」。squash 的比值该远大于 1，shift 该接近 1。
      (r.top / Math.max(r.foot, 0.1) > 4 ? '← 脚踩死了 ✓' : '← 脚跟着一起动') +
      `  （头顶:脚 = ${(r.top / Math.max(r.foot, 0.1)).toFixed(1)}:1）`);
  }

  console.log(`\n截图在 ${OUT}\n`);
  for (const f of shots) console.log('  ' + f);

  child.kill();
  await sleep(400);
  process.exit(0);
}

main().catch((err) => { console.error('\n探针炸了：', err.message); process.exit(1); });
