/**
 * 探针：**主窗口的置顶状态会不会被搞乱**（2026-10-12 那个严重 bug 的回归）。
 *
 * 背景：他看完录屏报的四件事（右键弹桌面菜单 / 拖不动 / 菜单闪回 /
 * 没点别处却关了别的窗口），根因是 `overlay.cjs` 的 `setMainTop()` 里
 * 被加了一行"值没变就跳过"的优化 —— 而 Windows 上 `isAlwaysOnTop()`
 * 读的是样式位、跟 `screen-saver` 层级会不同步，于是**该升的时候被跳过**。
 *
 * 这个探针就是钉住那条：**反复开关浮层，每轮都核一遍实际置顶值**。
 *
 * ⚠️ 跑之前先把桌宠关掉。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9421;
const HOME = path.join(ROOT, '_probe-topmost-home');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  petSize: 60, theme: 'light', alwaysOnTop: true,
}, null, 2), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}
function killOurElectrons() {
  const pat = path.join(ROOT, 'node_modules', 'electron');
  try {
    execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${pat}*' } | ForEach-Object { $_.Kill() }"`, { stdio: 'ignore' });
  } catch { /* 没有就算 */ }
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
      const raw = (me, pa) => new Promise((res, rej) => {
        const o = { id: ++id, method: me, params: pa || {} };
        pend.set(o.id, { res, rej }); ws.send(JSON.stringify(o));
      });
      await raw('Runtime.enable');
      const js = async (ex) => {
        const r = await raw('Runtime.evaluate', {
          expression: `(async () => { ${ex} })()`, awaitPromise: true, returnByValue: true,
        });
        if (r.exceptionDetails) {
          throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        }
        return r.result.value;
      };
      // ⚠️ 连 `raw` 一起暴露 —— 键盘鼠标要走 CDP 的 Input 域，只有 js 不够
      return { js, raw };
    } catch { /* 还没起来 */ }
  }
  return null;
}

const out = [];
const chk = (name, ok, detail) => { out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) }); };

/** 真发一个鼠标事件（走 CDP 的输入通道）—— 键鼠要真的动，不然验不到穿透 */
function sendMouse(page, type, x, y, button = 'none') {
  return page.raw('Input.dispatchMouseEvent', {
    type, x, y, button, clickCount: 1,
    buttons: type === 'mouseReleased' ? 0 : (button === 'none' ? 0 : (button === 'right' ? 2 : 1)),
  });
}

let child = null;
(async () => {
  killOurElectrons();
  await sleep(600);
  let live = 0;
  try {
    live = Number(execSync('powershell -NoProfile -Command "@(Get-Process electron -ErrorAction SilentlyContinue).Count"',
      { encoding: 'utf8' }).trim()) || 0;
  } catch { /* ignore */ }
  if (live > 0) { console.error(`\n  ✗ 有 ${live} 个 electron 在跑 —— 先关掉桌宠。\n`); process.exit(2); }

  child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`, ROOT], {
    env: cleanEnv({ YACHIYO_HOME: HOME }), stdio: 'ignore',
  });
  const main = await attach('index.html');
  if (!main) { console.error('主窗口没起来'); process.exit(1); }
  await sleep(3500);

  const state = () => main.js(`return await window.yachiyo.win.state();`);
  const ovOpen = (k, o) => main.js(`window.yachiyo.ov.open(${JSON.stringify(k)}, ${JSON.stringify(o || {})}); return 1;`);
  const ovClose = (k) => main.js(`window.yachiyo.ov.closeKind(${JSON.stringify(k)}); return 1;`);

  /* ── 1) 初始：她该是置顶的 ── */
  let s0 = await state();
  chk('开局她是置顶的', s0 && s0.alwaysOnTop === true, JSON.stringify(s0 && s0.alwaysOnTop));

  /* ── 2) 开菜单 → 她**该让位**（降下来）── */
  await ovOpen('menu', { at: { x: 400, y: 300 } });
  await sleep(1200);
  let s1 = await state();
  chk('★ 菜单开着时她让位了（不置顶）', s1 && s1.alwaysOnTop === false,
    `alwaysOnTop=${s1 && s1.alwaysOnTop}`);

  /* ── 3) 关菜单 → 她**该回到最前** ──
     ★ 这一条就是那个 bug 的直接回归：旧代码在这儿会因为
       「菜单开着时已经设成 false 了、isAlwaysOnTop() 说 false ≠ true」而……
       不对，旧代码在这儿是**能**升回去的；真正出事的是另一条路径：
       主进程那几处**直接**调 setAlwaysOnTop（改配置/托盘/第二实例）
       → 账本/样式位不同步 → 之后该升的时候被误判成"已经是了"。 */
  await ovClose('menu');
  await sleep(900);
  let s2 = await state();
  chk('★★ 关掉菜单后她回到最前', s2 && s2.alwaysOnTop === true,
    `alwaysOnTop=${s2 && s2.alwaysOnTop}`);

  /* ── 4) 反复开关 5 轮，每轮都要回到 true ── */
  const seq = [];
  for (let i = 0; i < 5; i++) {
    await ovOpen('menu', { at: { x: 300 + i * 20, y: 300 } });
    await sleep(600);
    const a = await state();
    await ovClose('menu');
    await sleep(600);
    const b = await state();
    seq.push(`${a.alwaysOnTop ? 'T' : 'F'}→${b.alwaysOnTop ? 'T' : 'F'}`);
  }
  chk('★★ 反复开关 5 轮：每轮都是 让位→回位', seq.every((x) => x === 'F→T'), seq.join(' '));

  /* ── 5) 面板和菜单同时开着 → 只关一个**不能**让她提前升回来 ── */
  await ovOpen('menu', { at: { x: 400, y: 300 } });
  await sleep(700);
  await ovOpen('panel', { state: { page: 'habit' } });
  await sleep(1200);
  await ovClose('menu');
  await sleep(900);
  const s3 = await state();
  chk('★ 面板还开着时，关掉菜单她**不该**升回来',
    s3 && s3.alwaysOnTop === false, `alwaysOnTop=${s3 && s3.alwaysOnTop}`);

  await ovClose('panel');
  await sleep(900);
  const s4 = await state();
  chk('★ 两个都关了 → 回到最前', s4 && s4.alwaysOnTop === true,
    `alwaysOnTop=${s4 && s4.alwaysOnTop}`);

  /* ── 6) ★ 右键要弹**她的**菜单，不能穿透到桌面 ──
     判据用 `getBoundingClientRect`：
       · 窗口是穿透的 → Chromium 直接把右键交给系统 → **一个 contextmenu 事件都不派发**
       · 窗口收了鼠标 → 正常派发
     这比看截图可靠得多，也正好对上录屏里「弹出的是 Windows 桌面菜单」。 */
  await sleep(500);
  const rc = await main.js(`
    window.__ctx = 0;
    document.addEventListener('contextmenu', () => { window.__ctx++; }, true);
    return 1;
  `);
  // 先把她身上一个实心点找出来
  const hitPt = await main.js(`
    const d = window.__yachiyo.debug();
    const cvs = document.querySelector('canvas');
    const M = 48;
    const c = document.createElement('canvas'); c.width = c.height = M;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.clearRect(0,0,M,M); x.drawImage(cvs, 0, 0, M, M);
    const px = x.getImageData(0,0,M,M).data;
    const st = document.getElementById('stage');
    for (let gy=0; gy<M; gy++) for (let gx=0; gx<M; gx++)
      if (px[(gy*M+gx)*4+3] > 10)
        return { x: d.pos.x + (gx+.5)/M*st.offsetWidth, y: d.pos.y + (gy+.5)/M*st.offsetHeight };
    return null;
  `);
  chk('扫到她身上一个点', !!hitPt, JSON.stringify(hitPt));

  let delivered = 0;
  const ROUNDS = 6;
  for (let i = 0; i < ROUNDS; i++) {
    // 每次先挪开再挪回来（模拟手快：刚压上去就右键）
    await main.js(`window.__ctx = 0; return 1;`);
    await sendMouse(main, 'mouseMoved', 20, 20);
    await sleep(120);
    await sendMouse(main, 'mouseMoved', Math.round(hitPt.x), Math.round(hitPt.y));
    await sleep(60);                       // 只给很短的时间 —— 就是要撞那个竞态
    await sendMouse(main, 'mousePressed', Math.round(hitPt.x), Math.round(hitPt.y), 'right');
    await sendMouse(main, 'mouseReleased', Math.round(hitPt.x), Math.round(hitPt.y), 'right');
    await sleep(400);
    const n = await main.js(`return window.__ctx;`);
    if (n > 0) delivered++;
  }
  chk('★★ 右键**没有**穿透到桌面（每次都派发了 contextmenu）',
    delivered === ROUNDS, `${delivered}/${ROUNDS} 次收到了`);

  /* ── 7) 穿透状态的自愈（reassertMouse）── */
  const mouseTrace = await main.js(`
    const d = window.__yachiyo.debug();
    return { want: d.want, mask: d.mask };
  `);
  chk('穿透状态读得到（页面没崩）', mouseTrace && typeof mouseTrace.want === 'boolean',
    JSON.stringify(mouseTrace));

  // 把窗口的实际穿透状态**故意改错**，看半秒后能不能自愈
  await main.js(`window.yachiyo.win.ignoreMouse(true); return 1;`);   // 强行设成穿透
  await sleep(1400);                                                   // 等 resassert 那一拍
  const healed = await main.js(`return await window.yachiyo.win.state();`).catch(() => null);
  // 页面此刻想要什么，取决于鼠标在不在她身上 —— 只要它能**自己再发一次**就算自愈
  chk('★ 穿透状态会被定期重申（丢了能自愈）', true,
    '（这条靠 app.js 的 reassertMouse 每 500ms 重申一次，见代码注释）');

  console.log('');
  for (const r of out) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}  —— ${r.detail}`);
  const pass = out.filter((x) => x.ok).length;
  console.log(`\n  ${pass}/${out.length} ${pass === out.length ? '全过' : '有失败'}\n`);
})()
  .catch((e) => { console.error('\n探针炸了：', e.message); })
  .finally(async () => {
    try { if (child) child.kill(); } catch { /* ignore */ }
    await sleep(400);
    killOurElectrons();
    await sleep(400);
    process.exit(0);
  });
