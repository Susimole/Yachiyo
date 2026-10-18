/**
 * 主进程 · 穿透（鼠标）—— 2026-10-18 从 index.cjs 拆出来的第三块
 *
 * ⚠️⚠️ **这个模块绝不决定"要不要穿透"**。她该不该被点到，只有渲染层说了算
 *       （`app.js` 的 `mouseTick()`）。这里只干三件事：
 *         ① 把页面发来的 `ignoreMouse(v)` **忠实设下去**并记账
 *         ② 把窗口的真实状态报出去（`win:state`，自检和探针靠它对账）
 *         ③ 光标守望：每 120ms 查一次光标，**只发事件**（`win:cursor-pos` / `win:cursor-out`）
 *
 *   历史教训（2026-10-17）：主进程曾经在 `win.on('show')` 里加了一句"保险"，
 *   自己调 `setIgnoreMouseEvents(true)` —— 结果跟页面手里的 `wantMouse` 失配，
 *   而页面**不会知道** ⇒ 显示之后永久"点不动、拖不动"。
 *   ⇒ **一改穿透就只有这一个控制点：页面。** 主进程这边只允许"照页面说的做"。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

let deps = null;

/**
 * @param {object} d
 * @param {() => import('electron').BrowserWindow|null} d.getWin
 * @param {(s:string)=>void} d.plog
 * @param {import('electron').Screen} d.screen
 * @param {string} d.probeRoot  探针日志目录（`_ignore.log` 落这儿）
 * @param {number} d.probeMs    0 = 正常跑；>0 = 探针模式（才落 `_ignore.log`）
 * @param {() => number} d.sysIdleSeconds  他多久没碰键鼠（秒）
 */
function attach(d) { deps = d; }

/* ---------- ① 记账 ---------- */

/**
 * 主进程这边**最后一次真的设下去**的值。
 * ⚠️ 它记的是"我说了什么"，**不是** "Windows 上真的生效了" —— 2026-10-18
 *    查 #6 时就是把这俩当成了同一件事，白查一轮。系统层面的真相只能问 Win32
 *    （WS_EX_TRANSPARENT），见 `_dsh020\verify\style-watch.ps1`。
 */
let lastIgnore = null;
let lastIgnoreLogged = null;
const ignoreLog = [];

function lastIgnoreValue() { return lastIgnore; }

function register(ipcMain) {
  ipcMain.on('win:ignore-mouse', (_e, on) => {
    const win = deps.getWin();
    const v = !!on;
    lastIgnore = v;
    ignoreLog.push({ t: Date.now(), on: v });
    if (ignoreLog.length > 20) ignoreLog.shift();

    /*
     * ★★ 2026-10-18：**每一条 IPC 都落盘**（不去重），只给探针用。
     *   为什么非要有：`plog` 那条是"变了才记"，于是「页面根本没发」和
     *   「发了、Shell 没收」在日志里长得一模一样 —— 查了五轮就栽在这儿。
     */
    if (deps.probeMs > 0) {
      try {
        fs.appendFileSync(path.join(deps.probeRoot, '_ignore.log'),
          `${Date.now()} ${v ? 1 : 0}\n`, 'utf8');
      } catch { /* 日志写不了不该影响主流程 */ }
    }

    win?.setIgnoreMouseEvents(v, { forward: true });
    if (lastIgnoreLogged !== v) {
      lastIgnoreLogged = v;
      deps.plog(`[鼠标] 穿透 ${on ? '打开（鼠标会穿过去）' : '收回（她能点着了）'}`);
    }
  });

  /* 窗口的真实状态 —— 自检要拿它对账「页面改了配置，主进程到底落没落地」 */
  ipcMain.handle('win:state', () => {
    const win = deps.getWin();
    if (!win) return null;
    return {
      visible: win.isVisible(),
      alwaysOnTop: win.isAlwaysOnTop(),
      focusable: win.isFocusable(),
      bounds: win.getBounds(),
      sysIdleSeconds: deps.sysIdleSeconds(),
      /*
       * ★ 穿透状态（2026-10-18 加的，为 #6）。
       *   `ignore` = 主进程**最后一次真的设下去**的值；`ignoreLog` = 最近 20 次原始 IPC。
       *   ⚠️ 这两个是**诊断口**，不是控制口 —— 别拿它当状态机去读着改东西。
       */
      ignore: lastIgnore,
      ignoreLog: ignoreLog.slice(-20),
    };
  });
}

/* ---------- ③ 光标守望 ---------- */

let cursorWatch = null;
let cursorWasInside = null;

/**
 * 每 120ms 查一次光标，**只发事件、不改穿透**。
 *
 * 两条事件：
 *   `win:cursor-pos`  每一拍都发（0~1 的相对比例 + inside）—— 页面靠它更新"鼠标在哪"
 *   `win:cursor-out`  只在**从内到外**那一下发（让页面赶紧开穿透，桌面才点得动）
 *
 * ★ 为什么非要喂坐标：#6 的真机日志实锤 `setIgnoreMouseEvents(true,{forward:true})`
 *   在 Windows 上**只转发 `mouseup`，`mousemove` 会断**。页面靠 mousemove 更新位置，
 *   一断就冻住 ⇒ 永远判"不在她身上" ⇒ 穿透永远开着 ⇒ 再也点不着，而且自己解不开。
 *
 * ⚠️ 坐标发的是 **0~1 的相对比例**，不是绝对坐标 ——
 *    绝对坐标在"主进程 / 渲染层 / 无头脚本"之间单位对不上（实测差 150~500px）。
 */
function startCursorWatch() {
  if (cursorWatch) return;
  cursorWatch = setInterval(() => {
    const win = deps.getWin();
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    try {
      const b = win.getBounds();
      const p = deps.screen.getCursorScreenPoint();
      const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
      win.webContents.send('win:cursor-pos', {
        rx: b.width ? (p.x - b.x) / b.width : -1,
        ry: b.height ? (p.y - b.y) / b.height : -1,
        inside,
        /* 诊断用：把原始数字一并带上，单位对不上一眼就看出来 */
        raw: { x: p.x, y: p.y },
        bounds: { x: b.x, y: b.y, w: b.width, h: b.height },
        sf: (deps.screen.getDisplayNearestPoint(p) || {}).scaleFactor || 1,
      });
      if (inside === cursorWasInside) return;
      cursorWasInside = inside;
      if (!inside) win.webContents.send('win:cursor-out');
      // ⚠️ 光标**进来**时什么都不做：收不收回由页面判定（她走动了就不该收）
    } catch { /* 窗口正在销毁，下一秒就没了 */ }
  }, 120);
  if (typeof cursorWatch.unref === 'function') cursorWatch.unref();
}

function stopCursorWatch() {
  if (cursorWatch) { clearInterval(cursorWatch); cursorWatch = null; }
}

module.exports = { attach, register, startCursorWatch, stopCursorWatch, lastIgnoreValue };
