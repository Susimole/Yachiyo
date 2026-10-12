/**
 * 探针：整体倾斜角（`lean`）真的生效了吗、各姿态歪多少。
 *
 * 背景（2026-10-12 他拍板「每个姿态各一个值」）：
 *   `lean` 这条线之前被砍断过（`bodyRTarget` 恒 0），连带待机/坐姿的倾斜都没了。
 *   恢复之后要确认两件事：
 *     ① 每个姿态真的取到了**自己的** lean（不是全 0、也不是全落 defaults）
 *     ② 肉眼上没歪过头（出图给他看）
 *
 * 出图在 `_tilt-shots\`。
 * ⚠️ 跑之前先把桌宠关掉。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9391;
const HOME = path.join(ROOT, '_probe-tilt-home');
const OUT = path.join(ROOT, '_tilt-shots');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  petSize: 100, city: '湖南省郴州市', theme: 'light', tiltDeg: 0,
}, null, 2), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

async function attach(part, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await sleep(500);
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = l.find((x) => x.type === 'page' && x.url.includes(part));
      if (!t) continue;
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => { ws.onopen = r; });
      let id = 0; const pend = new Map();
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pend.has(m.id)) {
          const p = pend.get(m.id); pend.delete(m.id);
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        }
      };
      const send = (me, pa) => new Promise((res, rej) => {
        const o = { id: ++id, method: me, params: pa || {} };
        pend.set(o.id, { res, rej }); ws.send(JSON.stringify(o));
      });
      await send('Runtime.enable');
      const js = async (ex) => {
        const r = await send('Runtime.evaluate', {
          expression: `(async () => { ${ex} })()`, awaitPromise: true, returnByValue: true,
        });
        if (r.exceptionDetails) {
          throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        }
        return r.result.value;
      };
      return { js };
    } catch { /* 还没起来 */ }
  }
  return null;
}


/**
 * 把**上次探针剩下的**本工程 electron 收干净。
 *
 * ⚠️ 不清的话单实例锁会挡下一次，而且会越攒越多（实测攒到过 7 个）。
 * ⚠️⚠️ **只杀本工程 `node_modules` 下的** —— 用 `$_.Path -like '<ROOT>\node_modules\electron*'`
 *    做前缀匹配。写成 `-like '*'` 就等于**把他正在用的那只也杀了**（我第一版
 *    自动生成的就坏成了这样，好在那个函数压根没被调用过）。改这里之前先想清楚。
 */
function killOurElectrons() {
  const pat = path.join(ROOT, 'node_modules', 'electron');
  try {
    execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${pat}*' } | ForEach-Object { $_.Kill() }"`, { stdio: 'ignore' });
  } catch { /* 没有就算 */ }
}

const reports = [];
const chk = (name, ok, detail) => { reports.push({ name, ok, detail }); };
let child = null;

(async () => {
  killOurElectrons();       // ⚠️ 先把上次剩下的收干净（不清的话单实例锁会挡）
  await sleep(600);

  let live = 0;
  try {
    live = Number(execSync('powershell -NoProfile -Command "@(Get-Process electron -ErrorAction SilentlyContinue).Count"',
      { encoding: 'utf8' }).trim()) || 0;
  } catch { /* ignore */ }
  if (live > 0) {
    console.error(`\n  ✗ 有 ${live} 个 electron 在跑（桌宠开着）—— 先关掉。\n`);
    process.exit(2);
  }

  child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`, ROOT], {
    env: cleanEnv({ YACHIYO_HOME: HOME }), stdio: 'ignore',
  });
  const main = await attach('index.html');
  if (!main) { console.error('主窗口没起来'); process.exit(1); }
  await sleep(4500);

  /* 各姿态的期望值 —— 直接读 rig.json，别在探针里写死 */
  const rig = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/renderer/assets/rig/rig.json'), 'utf8'));
  const expect = {};
  for (const [mode, pn] of [['idle', 'idle'], ['walk', 'walk'], ['run', 'run'], ['sit', 'sit'], ['sleep', 'sleep']]) {
    const p = rig.presets[pn];
    expect[mode] = (p && p.lean !== undefined) ? p.lean : rig.defaults.lean;
  }

  /*
   * ⚠️⚠️ **必须重试到「量的时候她还是那个状态」为止**。
   *
   *    我第一版是「setMode(walk) → sleep 2600ms → 量」——
   *    结果 [walk] 老是量到 -2°（那是 idle 的值）。查下来不是产品坏了：
   *    **她自己走回 idle 了**。状态机每 2~8 秒换一次动作，2600ms 的等待
   *    足够它从 walk 切走；而 `bodyRot` 是**弹簧**，切回去 0 点几秒就收敛了。
   *    量到的其实是"她那一刻是什么姿态"，不是"walk 该是多少"。
   *
   *    ⇒ 改成：**量和状态一起取，对不上就重来**（最多试 12 次）。
   *      这样测的是「walk 态下 bodyRot 是不是 1°」，而不是「2.6 秒后是什么」。
   */
  const seen = {};
  for (const mode of Object.keys(expect)) {
    let got = null;
    const want = expect[mode];
    for (let attempt = 0; attempt < 12; attempt++) {
      await main.js(`
        const r = window.__yachiyo.rig;
        r.state.left = 99999; r.state.cool = 0;
        r.setMode('${mode}');
        return 1;
      `);
      await sleep(420);       // 只要够弹簧起头 —— 关键是**别等太久**，等久了状态就跑了
      got = await main.js(`return { rot: window.__yachiyo.rig.bodyRot, mode: window.__yachiyo.rig.mode };`);
      if (got.mode === mode && Math.abs(got.rot - want) < 0.6) break;
      // 状态跑掉了（或者还没收敛）→ 再钉一次
      await sleep(160);
    }

    if (got) {
      const dataUrl = await main.js(`return document.querySelector('canvas').toDataURL('image/png');`);
      fs.writeFileSync(path.join(OUT, mode + '.png'),
        Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64'));
    }

    const ok = !!got && got.mode === mode && Math.abs(got.rot - want) < 0.6;
    seen[mode] = got ? got.rot : NaN;
    chk(`[${mode}] bodyRot = ${want}°`, ok,
      got ? `实测 ${got.rot.toFixed(2)}°（当时状态 ${got.mode}）· 期望 ${want}°` : '没量到');
  }

  chk('五个姿态不是同一个值（说明真的分姿态了）',
    new Set(Object.values(seen).map((v) => v.toFixed(1))).size >= 4,
    Object.entries(seen).map(([k, v]) => `${k}=${v.toFixed(1)}`).join(' '));

  /*
   * ★ 每个姿态单独调 —— 走 `win:set-tilts`（写 rig.json + 广播改内存）。
   *
   * ⚠️ 这里原来测的是一个**已经废掉的全局偏移**（`tiltDeg`）。
   *    他 2026-10-12 晚的口径是「每个状态单独调整」，
   *    那个总旋钮就没意义了 —— 探针要跟着改，别留一条永远红的。
   */
  const before = await main.js(`return window.__yachiyo.rig.data.presets.sit.lean;`);
  const setRes = await main.js(`
    return await window.yachiyo.rig.setTilts({ sit: -3.5 });
  `);
  chk('★ setTilts 改得动（写回 rig.json）', setRes && setRes.ok === true,
    JSON.stringify(setRes && setRes.why));
  await sleep(400);

  // 广播回来之后内存里那份也要变，而且**立刻**量得到
  await main.js(`const r=window.__yachiyo.rig; r.state.left=99999; r.state.cool=0; r.setMode('sit'); return 1;`);
  await sleep(700);
  const after = await main.js(`
    return { lean: window.__yachiyo.rig.data.presets.sit.lean,
             rot: window.__yachiyo.rig.bodyRot,
             mode: window.__yachiyo.rig.mode };
  `);
  chk('★ 内存里那份也改了（不用重启）', Math.abs(after.lean - (-3.5)) < 0.01,
    `presets.sit.lean = ${after.lean}（改前 ${before}）`);
  chk('★ 她当前姿态的 bodyRot 跟着变', Math.abs(after.rot - (-3.5)) < 0.8,
    `实测 ${after.rot.toFixed(2)}° · 期望 -3.50°`);

  // 复位（别把 rig.json 留成测试值）
  await main.js(`return await window.yachiyo.rig.setTilts({ sit: ${expect.sit} });`);
  await sleep(400);

  console.log('');
  for (const r of reports) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}  —— ${r.detail}`);
  const pass = reports.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${reports.length} ${pass === reports.length ? '全过' : '有失败'}`);
  console.log(`  出图：${OUT}\n`);
})()
  .catch((e) => { console.error('\n探针炸了：', e.message); })
  .finally(async () => {
    try { if (child) child.kill(); } catch { /* ignore */ }
    await sleep(400);
    try {
      execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object { $_.Kill() }"',
        { stdio: 'ignore' });
    } catch { /* ignore */ }
    await sleep(400);
    process.exit(0);
  });
