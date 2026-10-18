#!/usr/bin/env node
/*
 * ⚠️ 本文件 2026-10-18 由 `桌面\八千代AI桌宠工作留痕\` / `_dsh020\verify\` 搬进仓库。
 *    搬的时候只改了一件事：把写死的 `D:/AI_work/Git` 换成 `path.resolve(__dirname,'..','..')`。
 *    逻辑一行没动 —— 这些探针每天都在用，改逻辑就是给自己找麻烦。
 *
 *    跑之前要先有一个**带 CDP 的实例**（`YACHIYO_CDP=9222 npm start`），
 *    否则会报"没连上主窗口"。见 tests/e2e/README.md。
 */
/**
 * probe-panelresize —— 「设置面板拖不动边框」的真验证（2026-10-17）
 *
 * 为什么非测得这么笨：`will-resize` 里 `preventDefault()` 到底拦不拦得住
 * **Windows 自己**发起的边框拖拽，是 Electron 的行为，读代码看不出来。
 * 而这条正是他那个「拖设置窗边框 → 边框视觉闪回」bug 的根治手段 ——
 * 尺寸只要真的改不动，那一下缩放重绘就整个不存在了。
 *
 * 做法：真鼠标（`mouse_event` 绝对移动 + 按下/抬起，走正常输入栈）
 *   · 开面板，量 `innerWidth`
 *   · 光标移到**右边缘的缩放热区**，按住 → 往右拖 140px → 松开
 *   · 再量 `innerWidth`
 *   → 没变 = 那一刀真的生效了；变了 = 没拦住，得换方案
 *
 * ⚠️ 坐标全是**逻辑（DIP）**：`powershell.exe` 是 DPI-unaware 进程，
 *    `Cursor.Position` 读数、以及 `mouse_event` 绝对坐标的换算基数，都按逻辑坐标来。
 *    （乘了 devicePixelRatio 会把鼠标指到屏幕外 —— 我在这上面栽过一次。）
 *
 * 用法：node probe-panelresize.cjs
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (o) => JSON.stringify(o);
const PSH = { encoding: 'utf8', windowsHide: true };
const psCmd = (c) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', c], PSH);

let pass = 0, fail = 0;
const chk = (n, ok, d) => { if (ok) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d !== undefined ? '   → ' + d : '')); } };

/* 把「按下 → 分步拖 → 松开」写成一个 .ps1，一次进程里做完 */
const PS_DRAG = `
param([double]$x1, [double]$y1, [double]$x2, [double]$y2, [int]$physW, [int]$physH, [int]$steps)
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);' -Name U -Namespace W
$MOVE=0x0001; $ABS=0x8000; $LDOWN=0x0002; $LUP=0x0004
function MoveAbs($lx, $ly) {
  $nx = [int][math]::Round($lx / ($physW - 1) * 65535)
  $ny = [int][math]::Round($ly / ($physH - 1) * 65535)
  [W.U]::mouse_event(($MOVE -bor $ABS), $nx, $ny, 0, [IntPtr]::Zero)
}
MoveAbs $x1 $y1
Start-Sleep -Milliseconds 250
[W.U]::mouse_event($LDOWN, 0, 0, 0, [IntPtr]::Zero)
Start-Sleep -Milliseconds 150
for ($i = 1; $i -le $steps; $i++) {
  MoveAbs ($x1 + ($x2 - $x1) * $i / $steps) ($y1 + ($y2 - $y1) * $i / $steps)
  Start-Sleep -Milliseconds 60
}
Start-Sleep -Milliseconds 150
[W.U]::mouse_event($LUP, 0, 0, 0, [IntPtr]::Zero)
`;

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && waiting.has(msg.id)) {
        const { res, rej } = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
      }
    });
    ws.addEventListener('error', (e) => reject(new Error('WS: ' + (e.message || e.type))));
    ws.addEventListener('open', () => resolve({
      send(m, p) {
        const mid = ++id;
        return new Promise((res, rej) => { waiting.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method: m, params: p || {} })); });
      },
      close() { try { ws.close(); } catch {} },
    }));
  });
}
async function evalIn(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}
const targets = async () => (await (await fetch('http://127.0.0.1:9222/json/list')).json());

(async () => {
  console.log('probe-panelresize —— 设置面板边框拖得动吗');
  console.log('');

  let main = null;
  for (let i = 0; i < 25 && !main; i++) {
    try { main = (await targets()).find((t) => /index\.html/.test(t.url)); } catch {}
    if (!main) await sleep(400);
  }
  if (!main) { console.log('✗ 没连上主窗口'); process.exit(1); }
  const mc = await connect(main.webSocketDebuggerUrl);
  await mc.send('Runtime.enable');

  const geo = JSON.parse(await evalIn(mc, 'JSON.stringify({dpr: devicePixelRatio, sw: screen.width, sh: screen.height})'));
  const physW = Math.round(geo.sw * geo.dpr);
  const physH = Math.round(geo.sh * geo.dpr);

  const cfgFile = path.join(process.env.APPDATA || '', 'Yachiyo', 'config.json');
  const readGeom = () => {
    try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')).winGeom.panel; } catch { return null; }
  };
  const g = readGeom();
  if (!g) { console.log('✗ config.json 里没有 winGeom.panel'); process.exit(1); }
  console.log('面板 bounds（逻辑坐标）= ' + J(g));
  console.log('');

  /* 开面板 + 连它 */
  await evalIn(mc, `window.yachiyo.ov.open('panel'); 1`);
  await sleep(1500);
  const panel = (await targets()).find((t) => /panel\.html/.test(t.url));
  if (!panel) { console.log('✗ 面板没开出来'); process.exit(1); }
  const pc = await connect(panel.webSocketDebuggerUrl);
  await pc.send('Runtime.enable');
  await sleep(400);

  const before = JSON.parse(await evalIn(pc, 'JSON.stringify({w: innerWidth, h: innerHeight})'));
  console.log('拖之前：面板页面 ' + J(before));

  /* 光标先挪开（别在面板里），量一个「拖之前」的指针位置，最后要放回去 */
  const startOut = psCmd('Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)"');
  const [sx, sy] = startOut.trim().split(',').map(Number);
  const startPos = { x: sx, y: sy };

  /*
   * 右边缘的缩放热区：x ≈ 窗口右边界，y 取窗口中间。
   * ⚠️ 热区在窗口**外沿 1-8px**，往里偏 1px 就落进页面、拖不动窗口了。
   */
  const gripX = g.x + g.width - 2;
  const gripY = g.y + Math.round(g.height * 0.4);
  const dragToX = gripX + 140;

  console.log('按住右边缘 (' + gripX + ',' + gripY + ') 往右拖 140px → (' + dragToX + ',' + gripY + ')');

  const psPath = path.join(os.tmpdir(), 'yachiyo-drag.ps1');
  fs.writeFileSync(psPath, PS_DRAG, 'utf8');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath,
    '-x1', String(gripX * geo.dpr), '-y1', String(gripY * geo.dpr),
    '-x2', String(dragToX * geo.dpr), '-y2', String(gripY * geo.dpr),
    '-physW', String(physW), '-physH', String(physH), '-steps', '12'], PSH);
  fs.unlinkSync(psPath);
  await sleep(600);

  const after = JSON.parse(await evalIn(pc, 'JSON.stringify({w: innerWidth, h: innerHeight})'));
  const geomAfter = readGeom();
  console.log('拖之后：面板页面 ' + J(after) + '　winGeom.panel ' + J(geomAfter));
  console.log('');

  chk('★ 往右拖了 140px，面板宽度**纹丝不动**（will-resize 那一刀拦住了）',
    after.w === before.w, before.w + ' → ' + after.w);
  chk('   高度也没变', after.h === before.h, before.h + ' → ' + after.h);
  chk('   存下来的尺寸也没被改写', !!geomAfter && geomAfter.width === g.width && geomAfter.height === g.height,
    J(g) + ' → ' + J(geomAfter));

  await evalIn(mc, `window.yachiyo.ov.closeKind('panel'); 1`);
  await sleep(300);
  psCmd(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${startPos.x}, ${startPos.y})`);
  console.log('');
  console.log('指针已放回 ' + J(startPos));
  console.log((fail === 0 ? '★ 全绿' : '✗ 有红') + `　${pass} 通过 / ${fail} 失败`);
  mc.close(); pc.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('炸了：' + e.message + '\n' + e.stack); process.exit(1); });
