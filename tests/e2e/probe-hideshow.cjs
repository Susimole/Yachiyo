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
 * probe-hideshow —— 「隐藏后再显示就点不动她」（2026-10-17 他报的）
 *
 * 他的原话：「隐藏后再唤出（显示）桌宠就点不动桌宠了，桌宠进入睡觉状态时才互动」。
 * ★ **后半句是钥匙**：睡着 = 她站着不动 ⇒ 页面手里那个"最后一次鼠标坐标"
 *   还落在她身上，`hitPet` 就还能中；她一走动，旧坐标落到空气里，就点不着了。
 *   ⇒ 说明**页面收不到 mousemove**。
 *
 * 怀疑：Windows 上 `hide()` / `show()` 会把
 *   `setIgnoreMouseEvents(true, { forward: true })` 的**转发**弄丢 ——
 *   窗口还在"忽略鼠标"，可 move 不再转给页面，于是 `lastMouse` 永远停在
 *   开机那一刻的坐标（probe-interact 里就量到过这种"定格值"）。
 *
 * 判据（硬）：用**真实输入注入**把鼠标从别处挪到她身上，看 `debug().last` 跟不跟。
 *   · hide/show 之前 —— 应该跟（基线）
 *   · hide/show 之后 —— 改前**不跟**（复现），改后应该照样跟
 *
 * 用法：node probe-hideshow.cjs
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

const PS_MOVE = `
param([double]$ax, [double]$ay, [double]$bx, [double]$by, [int]$physW, [int]$physH, [int]$steps)
Add-Type -MemberDefinition '[DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, IntPtr e);' -Name U -Namespace W
$MOVE=0x0001; $ABS=0x8000
for ($i = 1; $i -le $steps; $i++) {
  $px = $ax + ($bx - $ax) * $i / $steps
  $py = $ay + ($by - $ay) * $i / $steps
  [W.U]::mouse_event(($MOVE -bor $ABS), [int][math]::Round($px / ($physW - 1) * 65535), [int][math]::Round($py / ($physH - 1) * 65535), 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 45
}`;

let pass = 0, fail = 0;
const chk = (n, ok, d) => { if (ok) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d !== undefined ? '   → ' + d : '')); } };

function connect(u) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(u); let i = 0; const w = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && w.has(m.id)) { const { res: r, rej: j } = w.get(m.id); w.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
    });
    ws.addEventListener('open', () => res({
      send: (me, p) => { const id = ++i; return new Promise((r, j) => { w.set(id, { res: r, rej: j }); ws.send(JSON.stringify({ id, method: me, params: p || {} })); }); },
      close: () => ws.close(),
    }));
    ws.addEventListener('error', () => rej(new Error('ws error')));
  });
}
const ev = async (c, e) => {
  const r = await c.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};
const ts = async () => (await (await fetch('http://127.0.0.1:9222/json/list')).json());

(async () => {
  console.log('probe-hideshow —— 隐藏后再显示，鼠标消息还进得来吗');
  console.log('');

  let main = null;
  for (let i = 0; i < 25 && !main; i++) {
    try { main = (await ts()).find((t) => /index\.html/.test(t.url)); } catch {}
    if (!main) await sleep(400);
  }
  if (!main) { console.log('✗ 没连上主窗口'); process.exit(1); }
  const mc = await connect(main.webSocketDebuggerUrl);
  await mc.send('Runtime.enable');

  const geo = JSON.parse(await ev(mc, 'JSON.stringify({screenX:screenX,screenY:screenY,dpr:devicePixelRatio,screenW:screen.width,screenH:screen.height})'));
  const physW = Math.round(geo.screenW * geo.dpr), physH = Math.round(geo.screenH * geo.dpr);

  /* 挂一个 mousemove 计数器 —— 比看 last 更直接 */
  await ev(mc, `(() => { window.__mv = 0; window.addEventListener('mousemove', () => window.__mv++, true); return 1; })()`);

  const probe = JSON.parse(await ev(mc, 'JSON.stringify(window.__yachiyo.hitProbe())'));
  if (!probe) { console.log('✗ hitProbe() null'); process.exit(1); }
  const tgt = { x: geo.screenX + probe.x, y: geo.screenY + probe.y };

  const psPath = path.join(os.tmpdir(), 'yachiyo-hideshow.ps1');
  fs.writeFileSync(psPath, PS_MOVE, 'utf8');
  const sweep = async (label) => {
    // 先挪到一个远离她的地方，再挪过去 —— 保证中间一定有 mousemove
    const away = { x: Math.max(20, tgt.x - 400), y: Math.max(20, tgt.y - 300) };
    await ev(mc, `window.__mv = 0; 1`);
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psPath,
      '-ax', String(away.x * geo.dpr), '-ay', String(away.y * geo.dpr),
      '-bx', String(tgt.x * geo.dpr), '-by', String(tgt.y * geo.dpr),
      '-physW', String(physW), '-physH', String(physH), '-steps', '8'], PSH);
    await sleep(450);
    const mv = await ev(mc, `window.__mv`);
    const dbg = JSON.parse(await ev(mc, 'JSON.stringify(window.__yachiyo.debug())'));
    const off = Math.hypot(dbg.last.x - probe.x, dbg.last.y - probe.y);
    console.log(`   ${label}：mousemove ${mv} 条 · last=${J(dbg.last)}（离她 ${off.toFixed(0)}px）· want=${dbg.want} hit=${dbg.hit}`);
    return { mv, dbg, off };
  };

  console.log('── ① 基线（还没隐藏过）──');
  const a = await sweep('隐藏之前');
  chk('★ 隐藏之前：鼠标消息进得来（last 跟到她身上）', a.mv > 0 && a.off < 40, `mv=${a.mv} off=${a.off.toFixed(0)}`);
  chk('   而且她收回了穿透（want=true，说明点得着）', a.dbg.want === true, String(a.dbg.want));

  console.log('');
  console.log('── ② 隐藏 → 再显示 ──');
  /*
   * ⚠️⚠️ 判据换成「**藏起来的时候收不到鼠标消息**」。
   *    上一版看 `document.visibilityState`，可它在 Electron 里没跟着变
   *    （hide() 之后读到还是 visible）—— 拿它当前提会让我以为"藏过了"，
   *    其实整个实验是空的。而"藏着时收不到消息"这件事本身**既是前提又是判据**：
   *    · 藏着时 0 条 ⇒ 证明真藏了
   *    · 再显示后有 >0 条 ⇒ 转发回来了（他报的 bug 就是这一步收不到）
   */
  await ev(mc, `window.yachiyo.win.hide()`);
  await sleep(1200);
  const hidden = await sweep('藏起来的时候');
  chk('★ 前提：藏起来的时候**确实收不到**鼠标消息（0 条）', hidden.mv === 0, `mv=${hidden.mv}`);

  await ev(mc, `window.yachiyo.cfg.set('petVisible', true)`);
  await sleep(1500);

  /* 连开关 3 次，看看会不会"用着用着才坏" */
  for (let i = 0; i < 3; i++) {
    await ev(mc, `window.yachiyo.win.hide()`);
    await sleep(800);
    await ev(mc, `window.yachiyo.cfg.set('petVisible', true)`);
    await sleep(900);
  }

  console.log('');
  console.log('── ③ 再量一次 ──');
  const b = await sweep('隐藏/显示之后');
  chk('★★ 隐藏再显示之后，鼠标消息**照样进得来**（这就是那个 bug 的判据）',
    b.mv > 0 && b.off < 40, `mv=${b.mv} off=${b.off.toFixed(0)}`);
  chk('★★ 她照样能收回穿透（want=true ⇒ 点得着）', b.dbg.want === true, String(b.dbg.want));

  fs.unlinkSync(psPath);
  psCmd(`Add-Type -AssemblyName System.Windows.Forms; $p=[System.Windows.Forms.Cursor]::Position; "$($p.X),$($p.Y)" | Out-Null`);
  console.log('');
  console.log((fail === 0 ? '★ 全绿' : '✗ 有红（就是复现了）') + `　${pass} 通过 / ${fail} 失败`);
  mc.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('炸了：' + e.message + '\n' + e.stack); process.exit(1); });
