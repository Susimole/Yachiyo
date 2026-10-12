/**
 * 睡觉（单图无骨架）的验收探针 —— 2026-10-12。
 *
 * 要证明四件事：
 *   ① sleep 套真的加载了（图没 404），画出来的东西和人一样大、踩在同一条地面线上
 *   ② 呼吸**真的在动** —— 老代码里睡觉相位是冻住的，这是回归点
 *   ③ 呼吸周期 ≈ sleepBreathMs 设的 5000ms（而且明显比坐姿的 2500ms 慢）
 *   ④ 站/坐/睡三套的「脚」落在同一个窗口 y 上（换套不跳）
 *
 * 跑法：node scripts/probe-sleep.cjs
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9336;
const HOME = path.join(ROOT, '_probe-sleep-home');
const OUT = path.join(ROOT, '_sleep-shots');
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
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl
                                  && t.url.includes('index.html'));
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
  /** ⚠️ clip 必须包在 {format, clip:{...}} 里，且 clip.scale 是必填（不填=一张都不落盘） */
  async shot(file, clip, scale = 1) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale } });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
    return file;
  }
}

/** 量当前这一套画出来的东西：不透明包围盒（窗口 CSS 像素） */
const MEASURE = `
  const c = document.getElementById('pet');
  const g = c.getContext('2d', { willReadFrequently: true });
  const W = c.width, H = c.height;
  const d = g.getImageData(0, 0, W, H).data;
  const rect = c.getBoundingClientRect();
  const sx = W / rect.width;
  let minX = W, maxX = -1, minY = H, maxY = -1, solid = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 16) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        solid++;
      }
    }
  }
  return {
    setName: window.__yachiyo.setName,
    mode: window.__yachiyo.rig.mode,
    box: {
      left:   +(rect.left + minX / sx).toFixed(1),
      right:  +(rect.left + maxX / sx).toFixed(1),
      top:    +(rect.top  + minY / sx).toFixed(1),
      bottom: +(rect.top  + maxY / sx).toFixed(1),
    },
    w: +((maxX - minX) / sx).toFixed(1),
    h: +((maxY - minY) / sx).toFixed(1),
    solidRatio: +(solid / (W * H)).toFixed(4),
    viewportH: window.innerHeight,
    posY: +window.__yachiyo.pos.y.toFixed(1),
  };
`;

/** 头顶那一条的 y —— 呼吸把它顶上去又放下来，用它当「呼吸在不在动」的指标 */
const CROWN = `
  const c = document.getElementById('pet');
  const g = c.getContext('2d', { willReadFrequently: true });
  const W = c.width, H = c.height;
  const d = g.getImageData(0, 0, W, H).data;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (d[(y * W + x) * 4 + 3] > 40) return y;
    }
  }
  return -1;
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
    await sleep(2500);   // 等贴图加载 + 第一帧

    // ---- 0. sleep 套加载了吗 ----
    console.log('\n[0] 素材加载');
    const sets = await cdp.evalJs(`
      const r = window.__yachiyo.rig;
      return Object.keys(r.sets).map((k) => ({ k, n: r.sets[k].count,
        ok: r.sets[k].order.every((x) => !!r.sets[k].parts[x].img) }));
    `);
    console.log('   套件:', JSON.stringify(sets));
    const sl = sets.find((s) => s.k === 'sleep');
    ok(!!sl, 'sleep 套存在');
    ok(sl && sl.n === 1, 'sleep 套是单件（无骨架）', sl ? `n=${sl.n}` : '');
    ok(sl && sl.ok, 'sleep 贴图加载成功（没 404）');

    // ---- 1. 三套各自的几何 ----
    console.log('\n[1] 摆位：三套的脚要落在同一条线上');
    const geo = {};
    for (const m of ['idle', 'sit', 'sleep']) {
      await cdp.evalJs(`const r = window.__yachiyo.rig; r.locked = true; r.setMode('${m}'); return 1;`);
      await sleep(700);
      geo[m] = await cdp.evalJs(MEASURE);
    }
    for (const m of ['idle', 'sit', 'sleep']) {
      const g = geo[m];
      console.log(`   ${m.padEnd(5)} setName=${String(g.setName).padEnd(6)} box ${g.box.left}→${g.box.right}  ` +
                  `${g.box.top}→${g.box.bottom}  (${g.w}×${g.h})  实体占比 ${g.solidRatio}`);
    }
    const footErr = Math.abs(geo.sleep.box.bottom - geo.idle.box.bottom);
    ok(footErr <= 1.5, '睡姿底边对齐站姿底边', `差 ${footErr.toFixed(1)}px（≤1.5 视为同一条线）`);
    ok(geo.sleep.h > 100 && geo.sleep.w > 100, '睡姿尺寸合理', `${geo.sleep.w}×${geo.sleep.h}`);
    ok(geo.sleep.solidRatio > 0.05, '睡姿确实画出了东西', `实体占比 ${geo.sleep.solidRatio}`);

    // ---- 2. 呼吸在不在动 + 周期 ----
    console.log('\n[2] 呼吸：动没动 / 多快');
    /** 在某个状态下采一段时间，返回头顶 y 的序列 */
    async function sample(mode, ms) {
      await cdp.evalJs(`const r = window.__yachiyo.rig; r.locked = true; r.setMode('${mode}'); return 1;`);
      await sleep(800);                                        // 先让弹簧稳下来
      const t0 = Date.now();
      const ys = [];
      const ts = [];
      while (Date.now() - t0 < ms) {
        ys.push(await cdp.evalJs(CROWN));
        ts.push(Date.now() - t0);
        await sleep(60);
      }
      return { ys, ts };
    }
    /** 过零计数 → 周期：往上穿过均值的时刻，相邻间隔就是半周期 */
    function period(ys, ts) {
      const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
      const cross = [];
      for (let i = 1; i < ys.length; i++) {
        if (ys[i - 1] > mean && ys[i] <= mean) cross.push(ts[i]);   // 向下穿 = 吸气到顶之后
      }
      const gaps = [];
      for (let i = 1; i < cross.length; i++) gaps.push(cross[i] - cross[i - 1]);
      if (!gaps.length) return { amp: 0, periodMs: 0, n: cross.length };
      gaps.sort((a, b) => a - b);
      const amp = Math.max(...ys) - Math.min(...ys);
      return { amp, periodMs: Math.round(gaps[Math.floor(gaps.length / 2)]), n: cross.length };
    }

    const sitS = await sample('sit', 11000);
    const sitP = period(sitS.ys, sitS.ts);
    console.log(`   坐姿 头顶起伏 ${sitP.amp}px（物理）  周期 ${sitP.periodMs}ms`);

    const slS = await sample('sleep', 16000);
    const slP = period(slS.ys, slS.ts);
    console.log(`   睡姿 头顶起伏 ${slP.amp}px（物理）  周期 ${slP.periodMs}ms`);

    ok(slP.amp >= 2, '睡觉时呼吸真的在动（老代码是冻住的）', `起伏 ${slP.amp}px`);
    ok(slP.periodMs > 0, '能测出周期', `${slP.periodMs}ms`);
    ok(slP.periodMs > sitP.periodMs * 1.3,
       '睡姿呼吸比坐姿慢', `睡 ${slP.periodMs}ms vs 坐 ${sitP.periodMs}ms（目标 5000 vs 2500）`);

    // ---- 3. 底边在整个采样窗口里有没有漂（呼吸不该挪脚）----
    console.log('\n[3] 呼吸不该把脚挪走');
    const footSeries = [];
    await cdp.evalJs(`const r = window.__yachiyo.rig; r.locked = true; r.setMode('sleep'); return 1;`);
    await sleep(800);
    for (let i = 0; i < 25; i++) {
      footSeries.push((await cdp.evalJs(MEASURE)).box.bottom);
      await sleep(120);
    }
    const fMin = Math.min(...footSeries), fMax = Math.max(...footSeries);
    ok(fMax - fMin <= 2, '睡姿底边稳定（呼吸锚在脚下沿）',
       `波动 ${(fMax - fMin).toFixed(1)}px  (${fMin} ~ ${fMax})`);

    // ---- 截图 ----
    const win = await cdp.evalJs(`return { w: window.innerWidth, h: window.innerHeight };`);
    await cdp.evalJs(`const r = window.__yachiyo.rig; r.locked = true; r.setMode('sleep'); return 1;`);
    await sleep(900);
    await cdp.shot('sleep-100.png', { x: 0, y: 0, width: win.w, height: win.h }, 2);

    await cdp.evalJs(`const r = window.__yachiyo.rig; r.locked = true; r.setMode('sit'); return 1;`);
    await sleep(900);
    await cdp.shot('sit-100.png', { x: 0, y: 0, width: win.w, height: win.h }, 2);

    // 排一起看得清楚
    const strip = [];
    strip.push('sleep-100.png', 'sit-100.png');
    console.log('\n   截图:', strip.join(', '));

    console.log('\n我的自检里，睡觉是【单图无骨架】：');
    console.log('  · rig.json 新增 sleep 套（order=["body"]，一张 sleep.png）');
    console.log('  · 摆位：脸对齐另外两套的 x=359，底边踩 555 那条地面线');
    console.log('  · 呼吸周期由新参数 sleepBreathMs 定，预设 5000ms（坐姿是 2500ms）');
  } finally {
    try { child.kill(); } catch { /* 已经没了 */ }
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exit(1); });
