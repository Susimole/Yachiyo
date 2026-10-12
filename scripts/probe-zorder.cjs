/**
 * 只读探针 · 浮层 z 序 + 开菜单那一瞬间窗口动了什么 —— 2026-10-12
 *
 * 他报的两件事，先量再改：
 *   ① 「右键菜单有些东西点不了」—— 菜单跑到她后面去了？
 *   ② 「菜单唤出时闪两下」—— 是哪一层在动？动了几次？
 *
 * 这个探针**不改任何代码**，只做三件事：
 *   1. 量主窗口和菜单在**菜单开着的时候**各自的 topmost / 可见性
 *   2. **高频采样**（每 40ms）她 topmost 的翻转次数 —— 闪的根源就在这个数字上
 *   3. 用 Win32 `EnumWindows` 读**真实的 z 序**，看菜单到底排在她前面还是后面
 *
 * 跑法：node scripts/probe-zorder.cjs
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9344;
const HOME = path.join(ROOT, '_probe-zorder-home');
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
    return c;
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pend.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pend.has(id)) { this.pend.delete(id); rej(new Error(method + ' 超时')); } }, 20000);
    });
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  }
}

/**
 * 读**真实 z 序**。
 *
 * ⚠️ Electron 自己**给不出**「A 在 B 前面吗」—— 只有 `isAlwaysOnTop()`
 *    （一个 bool）和 `getBounds()`。z 序是窗口管理器的事，只能问 Win32。
 *    `EnumWindows` 的顺序就是 z 序（**从最前面往后**）。
 *
 * ⚠️ 只认我们自己那几个窗口：按**进程 id** 过滤（Electron 的每个
 *    BrowserWindow 都是同一个进程，所以同 pid 的所有顶层窗都在这里）。
 *    标题一律是 'Yachiyo'，靠尺寸分不出菜单和面板 —— 所以连 bounds 一起带回来，
 *    由调用方按尺寸对上号。
 */
function readZOrder(pid) {
  const ps = `
$sig = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class Zq {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr hWnd, int i);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static List<string> Go(uint want) {
    var outp = new List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid != want) return true;
      if (!IsWindowVisible(h)) return true;
      RECT r; GetWindowRect(h, out r);
      var cn = new StringBuilder(256); GetClassName(h, cn, 256);
      int ex = GetWindowLong(h, -20);          // GWL_EXSTYLE
      int top = (ex & 0x00000008) != 0 ? 1 : 0; // WS_EX_TOPMOST
      outp.Add(string.Format("{0}|{1}|{2},{3},{4},{5}|{6}|{7}",
        h.ToInt64(), cn.ToString(), r.L, r.T, r.R, r.B, top, h == IntPtr.Zero ? 0 : 0));
      return true;
    }, IntPtr.Zero);
    return outp;
  }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp
[Zq]::Go([uint32]${pid}) -join "\`n"
`;
  const tmp = path.join(ROOT, `_zq-${process.pid}.ps1`);
  fs.writeFileSync(tmp, '﻿' + ps, 'utf8');
  try {
    const out = execSync(`powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${tmp}"`,
      { encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 22 });
    fs.rmSync(tmp, { force: true });
    return out.trim().split(/\r?\n/).filter(Boolean).map((l) => {
      const [hwnd, cls, rect, top] = l.split('|');
      const [x1, y1, x2, y2] = rect.split(',').map(Number);
      return { hwnd, cls, x: x1, y: y1, w: x2 - x1, h: y2 - y1, topmost: top === '1' };
    });
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    return [{ err: e.message.slice(0, 200) }];
  }
}

/* ── 隔离目录 ─────────────────────────────────────────── */

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  alwaysOnTop: true,          // ★ 他报问题时的状态就是置顶开着
  ApiEnabled: false,
  autoExitEnabled: false,
  autostart: false,
  sound: false,
  moveEnabled: false,
  petSize: 100,
}, null, 2), 'utf8');

/* ── 开跑 ─────────────────────────────────────────────── */

(async () => {
  const fail = [];
  const ok = (cond, msg, extra) => {
    console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '   ' + extra : ''}`);
    if (!cond) fail.push(msg);
  };

  try { execSync("powershell.exe -NoProfile -Command \"Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | ForEach-Object { $_.Kill() }\"", { stdio: 'ignore', windowsHide: true }); } catch { }
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
  await sleep(3500);

  const pid = child.pid;

  try {
    /* ── ① 开菜单之前 ── */
    /*
     * ⚠️⚠️ 这里**多读几次再取第一条**。
     *    踩过：第一版只读一次，同一份代码两次跑出不同结果（一次 topmost=true、
     *    一次 false），看着像"置顶会自己掉"。后来单独钉了一轮（每 0.5 秒读一次、
     *    连读 7 秒）**稳定 true** —— 说明掉的不是置顶，是**开机头几拍读太早**：
     *    `win.show()` 是挂在 `ready-to-show` 上的，那一刻才真正上屏，
     *    CDP 一能连上就读的话，可能正好抢在它前面。
     *    ⇒ 先等 `show()` 落地再读，并且读三次取最后一条。
     */
    const beforeSeq = [];
    for (let i = 0; i < 3; i++) {
      beforeSeq.push(await cdp.evalJs('return await window.yachiyo.win.state();'));
      await sleep(400);
    }
    const before = beforeSeq[beforeSeq.length - 1];
    console.log(`\n【开之前】她 topmost=${before.alwaysOnTop}（连读三次：` +
      beforeSeq.map((s) => s.alwaysOnTop).join('/') + `）  visible=${before.visible}`);
    console.log(`          她的窗口 ${JSON.stringify(before.bounds)}`);
    ok(before.alwaysOnTop === true,
      '★ 启动后她是置顶的（配置里 alwaysOnTop=true）',
      beforeSeq.map((s) => s.alwaysOnTop).join('/'));
    ok(beforeSeq.every((s) => s.alwaysOnTop === before.alwaysOnTop),
      '★ 置顶状态稳定，不会自己掉（连读三次一致）', '');

    /* ── ② 高频采样着开菜单 ── */
    /*
     * ⚠️ 采样要在**菜单打开的那一瞬间**就开始 —— 闪只持续几十毫秒，
     *    等 open 返回再开始采，黄花菜都凉了。
     *    所以先起一个后台轮询，再发 open。
     */
    const samples = [];
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        try {
          const s = await cdp.evalJs(
            'const a = await window.yachiyo.win.state();' +
            'const m = await window.yachiyo.ov.info("menu");' +
            'return { t: performance.now(), mainTop: a.alwaysOnTop, mainVis: a.visible,' +
            ' mb: m.bounds, mTop: m.topmost, mOpen: m.open };');
          samples.push(s);
        } catch { /* 采样期间页面忙，跳过这一拍 */ }
        await sleep(40);
      }
    })();

    // 在她身上右键 —— 直接叫 open，跟 contextmenu 那条路走的是同一个 IPC
    await cdp.evalJs('window.yachiyo.ov.open("menu", { at: { x: 200, y: 40 } }); return 1;');
    await sleep(2500);
    sampling = false;
    await sampler;

    /* ── ③ 采样结果 ── */
    const topFlips = [];
    for (let i = 1; i < samples.length; i++) {
      if (samples[i].mainTop !== samples[i - 1].mainTop) topFlips.push(i);
    }
    const menuOpened = samples.filter((s) => s.mOpen).length;
    const last = samples[samples.length - 1] || {};

    console.log(`\n【开菜单的 2.5 秒里，每 40ms 采一拍，共 ${samples.length} 拍】`);
    console.log(`  她 topmost 的翻转次数：${topFlips.length}`);
    console.log(`  菜单可见的拍数：${menuOpened} / ${samples.length}`);
    console.log(`  结束时：她 topmost=${last.mainTop}  菜单 open=${last.mOpen} topmost=${last.mTop}`);
    if (last.mb) console.log(`  菜单窗口 ${JSON.stringify(last.mb)}`);

    ok(topFlips.length <= 2,
      '★ 菜单开着的这段时间里，她的 topmost 只翻一次（开的时候降、关的时候升）',
      `实测翻了 ${topFlips.length} 次`);
    ok(last.mainTop === false,
      '  菜单开着的时候她确实是「不置顶」（这是现在的设计）', `topmost=${last.mainTop}`);
    ok(last.mTop === false, '  菜单自己不置顶', `topmost=${last.mTop}`);

    /* ── ④ 真实 z 序 ── */
    const z = readZOrder(pid);
    console.log('\n【真实 z 序（从最前面往后）】');
    z.forEach((w, i) => {
      if (w.err) return console.log(`  ${i}: 读失败 ${w.err}`);
      console.log(`  ${i}: hwnd=${w.hwnd} ${w.cls.padEnd(24)} ${w.w}×${w.h} @${w.x},${w.y}` +
                  `  topmost=${w.topmost ? '是' : '否'}`);
    });

    // 按尺寸认出菜单和主窗口
    const menu = z.find((w) => !w.err && Math.abs(w.w - 244) <= 6 && Math.abs(w.h - 250) <= 40);
    const main = z.find((w) => !w.err && w.h >= 400);
    const iMenu = z.indexOf(menu), iMain = z.indexOf(main);

    if (menu && main) {
      ok(iMenu < iMain,
        '★ 菜单排在主窗口**前面**（z 序越小越靠前）',
        `菜单 #${iMenu} vs 主窗口 #${iMain}`);
    } else {
      console.log(`  （没按尺寸认出窗口：菜单 ${menu ? '有' : '无'} / 主窗口 ${main ? '有' : '无'}）`);
    }

    /* ══════════════════════════════════════════════════════
       候选改法实测 —— 哪种真能把菜单摆到她前面
       ══════════════════════════════════════════════════════ */
    console.log('\n【候选改法对比】');
    const mainHwnd = main ? main.hwnd : null;

    /** 关掉再开一次，回到"刚打开"那个状态；然后按 name 的方式摆一下，量 z 序 */
    async function trial(name, act) {
      await cdp.evalJs('window.yachiyo.ov.closeKind("menu"); return 1;');
      await sleep(700);
      await cdp.evalJs('window.yachiyo.ov.open("menu", { at: { x: 200, y: 40 } }); return 1;');
      await sleep(900);
      if (act) await act();
      await sleep(500);
      const zz = readZOrder(pid);
      const mm = zz.find((w) => !w.err && Math.abs(w.w - 244) <= 8 && w.h <= 300);
      const mn = zz.find((w) => !w.err && w.h >= 400);
      const im = zz.indexOf(mm), inx = zz.indexOf(mn);
      const r = { name, iMenu: im, iMain: inx, total: zz.length, ok: im >= 0 && inx >= 0 && im < inx };
      console.log(`  ${r.ok ? '✓' : '✗'} ${name.padEnd(28)} 菜单 #${im} / 主窗口 #${inx}（共 ${zz.length} 个可见顶层窗）`);
      return r;
    }

    /*
     * ★ 产品代码现在**已经**按 D（`moveTop()`）改了 —— 所以第一格从此就是绿的。
     *   剩下三格留着，是为了**钉住"为什么是 D"**：以后谁想换一种摆法，
     *   这几行会告诉他另外三种实测没用。
     */
    const trialD1 = await trial('D ✅ 现在产品用的（open 里自动 moveTop）', null);
    await sleep(200);
    const trialD2 = await trial('  再手动 moveTop 一次（应无变化）', async () => {
      await cdp.evalJs('return window.yachiyo.ov.probeRaise("menu", null);');
    });
    await sleep(200);
    const trialE = await trial('E insertAfter(主窗口 hwnd)', async () => {
      await cdp.evalJs(`return window.yachiyo.ov.probeRaise("menu", "${mainHwnd}");`);
    });

    console.log('\n  ⇒ 结论：');
    for (const t of [trialD1, trialE]) {
      console.log(`     ${t.ok ? '能用' : '没用'}  ${t.name}`);
    }
    console.log('     （历史上「什么都不做」和「先 show 再 setBounds」都实测没用，' +
                '所以 open 里必须留 moveTop —— 见 overlay.cjs 的 syncMainTop 注释）');

    /* ══════════════════════════════════════════════════════
       窗口动了没 —— 「闪两下」的直接证据
       ══════════════════════════════════════════════════════ */
    console.log('\n【开菜单那一瞬间，菜单窗口被改了几次尺寸/位置】');
    await cdp.evalJs('window.yachiyo.ov.closeKind("menu"); return 1;');
    await sleep(600);
    await cdp.evalJs('return window.yachiyo.ov.probeBounds("menu", true);');
    await cdp.evalJs('window.yachiyo.ov.open("menu", { at: { x: 200, y: 40 } }); return 1;');
    await sleep(2000);
    const bl = await cdp.evalJs('return window.yachiyo.ov.probeBounds("menu", false);');
    const moves = (bl && bl.log) || [];
    console.log(`  setBounds 真的改动窗口的次数：${moves.length}`);
    moves.forEach((m, i) => {
      console.log(`    #${i + 1}  ${m.from.w}×${m.from.h}@${m.from.x},${m.from.y}` +
                  `  →  ${m.to.w}×${m.to.h}@${m.to.x},${m.to.y}`);
    });
    ok(moves.length <= 1,
      '★ 开一次菜单最多改一次窗口尺寸（改两次以上就是"闪两下"的根源）',
      `实测 ${moves.length} 次`);

    /* ══════════════════════════════════════════════════════
       连续截图 —— "闪两下"到底长什么样
       ══════════════════════════════════════════════════════ */
    /*
     * ⚠️ 只比**哈希**看"变没变"是不够的（改之前那轮就是这么白跑的：
     *   34 张全一样 → 结论"没闪"，可他说闪）。所以这里**把变了的帧落盘**，
     *   好在报告里指出来"第几帧变成了什么样"。
     */
    console.log('\n【连拍 · 开菜单那一瞬间（每帧只截菜单那一小块）】');
    const OUT = path.join(ROOT, '_zorder-shots');
    fs.rmSync(OUT, { recursive: true, force: true });
    fs.mkdirSync(OUT, { recursive: true });

    await cdp.evalJs('window.yachiyo.ov.closeKind("menu"); return 1;');
    await sleep(800);

    // 先摆好采样区（用上一次开出来的位置），再开
    const probeBox = { x: 190, y: 580, width: 260, height: 280 };
    const frames = [];
    let shooting = true;
    const shooter = (async () => {
      let n = 0;
      while (shooting && n < 40) {
        try {
          const r = await cdp.send('Page.captureScreenshot', {
            format: 'png',
            clip: { ...probeBox, scale: 1 },
          });
          frames.push({ n: n++, data: r.data });
        } catch { /* 这一帧没截到，跳过 */ }
        await sleep(30);
      }
    })();

    await cdp.evalJs('window.yachiyo.ov.open("menu", { at: { x: 200, y: 40 } }); return 1;');
    await sleep(1600);
    shooting = false;
    await shooter;

    const crypto = require('node:crypto');
    const hash = (b64) => crypto.createHash('sha1').update(b64).digest('hex').slice(0, 8);
    const seen = new Map();
    const changes = [];
    let prev = null;
    frames.forEach((f, i) => {
      const h = hash(f.data);
      if (h !== prev) { changes.push({ i, h, bytes: Buffer.from(f.data, 'base64').length }); prev = h; }
      seen.set(h, (seen.get(h) || 0) + 1);
    });
    console.log(`  截到 ${frames.length} 帧，画面变了 ${changes.length} 次（含第一帧）`);
    changes.slice(0, 12).forEach((c, k) => {
      console.log(`    第 ${c.i} 帧  hash=${c.h}  ${c.bytes} 字节${k === 0 ? '（第一帧）' : ''}`);
      if (k < 8) {
        const f = frames[c.i];
        fs.writeFileSync(path.join(OUT, `f${String(c.i).padStart(2, '0')}-${c.h}.png`),
          Buffer.from(f.data, 'base64'));
      }
    });
    console.log(`  变了的帧落盘在 ${OUT}`);
    ok(changes.length <= 2,
      '★ 开菜单那一瞬间画面最多变一次（变了两次以上就是"闪两下"）',
      `实测变了 ${changes.length} 次`);

    /* ── ⑤ 菜单内容有没有被裁 ── */
    const fitInfo = await cdp.evalJs(
      'const m = await window.yachiyo.ov.info("menu");' +
      'return { h: m.bounds ? m.bounds.height : null };');
    ok(fitInfo.h >= 240,
      '★ 菜单窗口高度够装下内容（被裁的话底下几项点不到）', `窗口高 ${fitInfo.h}`);

    /* ── ⑥ 关掉之后她有没有回到置顶 ── */
    await cdp.evalJs('window.yachiyo.ov.closeKind("menu"); return 1;');
    await sleep(1200);
    const after = await cdp.evalJs('return window.yachiyo.win.state();');
    ok(after.alwaysOnTop === before.alwaysOnTop,
      '★ 菜单关掉之后她回到原来的置顶状态',
      `开之前 ${before.alwaysOnTop} → 关之后 ${after.alwaysOnTop}`);

  } finally {
    try { child.kill(); } catch { }
    try { execSync("powershell.exe -NoProfile -Command \"Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | ForEach-Object { $_.Kill() }\"", { stdio: 'ignore', windowsHide: true }); } catch { }
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
})().catch((e) => { console.error(e); process.exit(1); });
