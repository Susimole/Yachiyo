/**
 * 游戏检测 —— 判断「他现在是不是在全屏游戏里」。
 *
 * 他 2026-10-17 定的口径：**全屏检测 + 进程检测**，两者结合才准
 * （原话「这样更准」）。他要的效果：打游戏时她**保持坐着**，
 * 识屏和自言自语照旧（那两条链不动）。
 *
 * ---------------------------------------------------------------
 * 为什么走 PowerShell，而不是引个原生依赖：
 *   · `core/` 的规矩是纯 node、不装依赖（装了就进 dist、要跟着 Electron 升级）
 *   · Electron 没有「前台窗口是谁 / 多大」这种 API（`screen` 只给显示器信息）
 *   · 而 Windows 这几个 API 就三个：GetForegroundWindow / GetWindowRect /
 *     GetWindowThreadProcessId —— PowerShell 里 Add-Type 一句 P/Invoke 就够
 *   ⇒ 用 **一个常驻的 PowerShell 进程**（自己 while 循环吐行），node 这边只读 stdout。
 *
 * ⚠️⚠️ **每次 spawn 一个 PowerShell 是不行的**：它有 200–400ms 的启动开销，
 *    每 2 秒起一次就是 10%+ 的单核占用 —— 绝对会招他烦。所以**只起一次**，让它自己循环。
 * ⚠️ **纯 ASCII 脚本**：PowerShell 5.1 读 `.ps1` 是按 ANSI 解码的，
 *    文件里只要有一个中文字符，整段就会乱码报 "Unexpected token"（本轮实测栽过一次）。
 * ⚠️ 输出用**竖线分隔的纯文本**，不用 JSON —— 在 PowerShell 里拼 JSON 的转义太容易出错
 *    （`\"` 在 PS 里不是转义符），而 node 侧 `split('|')` 一行就搞定。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

/** 探测间隔（毫秒）—— 2 秒够用了：他切进游戏到切换完成本来就要一两秒 */
const INTERVAL_MS = 2000;

/**
 * 全屏判定容差：窗口矩形比屏幕小几像素很常见（DPI 取整、无边框窗口的 1px 边框）。
 * ⚠️ 收紧到 0 会漏判，放宽太多会把「最大化窗口」误判成全屏。
 */
const EDGE_TOL = 8;

/**
 * 默认「就算全屏也不当游戏」的进程名（小写，不含 .exe）。
 *
 * 为什么要这张表：**浏览器全屏放视频**、**播放器全屏看电影** 全都是"全屏窗口"，
 * 但那不是打游戏 —— 他要的是「打游戏时坐着」，看视频时她照常走动才自然。
 * ⚠️ 这只是**默认值**，存在 config 的 `gameExclude` 里，他自己能改。
 */
const DEFAULT_EXCLUDE = [
  'explorer', 'chrome', 'msedge', 'firefox', 'brave', 'opera',
  'code', 'devenv', 'notepad', 'notepad++', 'sublime_text',
  'potplayermini64', 'potplayermini', 'vlc', 'mpv', 'mpc-hc64',
  'bilibili', 'iqiyi', 'youku', 'qqmusic', 'cloudmusic',
  'aweSun', 'todesk', 'sunloginclient', 'teamviewer',
  'windowsterminal', 'cmd', 'powershell', 'pwsh',
];

/* ============================================================
   纯函数部分（自检直接测这些，不用起进程）
   ============================================================ */

/**
 * 解析 PowerShell 吐的一行。
 * @param {string} line 形如 `FG|pid|proc|l|t|w|h|caption` 或 `SCREEN|w|h`
 * @returns {{kind:string, v:any}|null}
 */
function parseLine(line) {
  const s = String(line == null ? '' : line).trim();
  if (!s) return null;
  const p = s.split('|');
  if (p[0] === 'SCREEN' && p.length >= 3) {
    return { kind: 'screen', w: Number(p[1]) || 0, h: Number(p[2]) || 0 };
  }
  if (p[0] === 'FG' && p.length >= 8) {
    return {
      kind: 'fg',
      pid: Number(p[1]) || 0,
      proc: String(p[2] || '').toLowerCase(),
      l: Number(p[3]) || 0,
      t: Number(p[4]) || 0,
      w: Number(p[5]) || 0,
      h: Number(p[6]) || 0,
      caption: p[7] === '1',
    };
  }
  return null;
}

/**
 * 这一帧算不算「在打游戏」。
 *
 * 他定的是**两条都要**：全屏 **且** 进程不是"非游戏"那类。
 * @param {{w:number,h:number}} screen 主屏尺寸
 * @param {object} fg parseLine 的 fg 结果
 * @param {string[]} exclude 排除名单（小写）
 * @returns {{isGame:boolean, why:string}}
 */
function judge(screen, fg, exclude) {
  if (!screen || !fg) return { isGame: false, why: '没数据' };
  if (!fg.proc || fg.proc === '?') return { isGame: false, why: '拿不到进程名' };

  const fullX = fg.w >= screen.w - EDGE_TOL;
  const fullY = fg.h >= screen.h - EDGE_TOL;
  if (!(fullX && fullY)) {
    return { isGame: false, why: `不是全屏（${fg.w}×${fg.h} < ${screen.w}×${screen.h}）` };
  }
  /*
   * ⚠️ 无标题栏也当一条佐证，但**不作为必要条件**：
   *    有些游戏窗口化全屏（borderless）确实没标题栏，可也有游戏**带**标题栏还占满屏。
   *    这里只用它来说"更像全屏游戏"，判定主体仍是尺寸。
   */
  const list = Array.isArray(exclude) ? exclude.map((x) => String(x || '').toLowerCase()) : [];
  if (list.some((x) => x && (fg.proc === x || fg.proc.startsWith(x)))) {
    return { isGame: false, why: `${fg.proc} 在"不当游戏"名单里` };
  }
  return { isGame: true, why: `全屏 ${fg.w}×${fg.h} · ${fg.proc}${fg.caption ? ' · 有标题栏' : ''}` };
}

/* ============================================================
   常驻 PowerShell
   ============================================================ */

/** 那个 while 循环脚本（**纯 ASCII**，注释用 #） */
function psScript() {
  return [
    '# game detection probe: prints one FG line + one SCREEN line every 2s',
    'Add-Type -TypeDefinition @\"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'public class Win32g {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);',
    '  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }',
    '  public static string Q() {',
    '    IntPtr h = GetForegroundWindow();',
    '    if (h == IntPtr.Zero) return "0|none|0|0|0|0|1";',
    '    RECT r; GetWindowRect(h, out r);',
    '    uint pid; GetWindowThreadProcessId(h, out pid);',
    '    int style = GetWindowLong(h, -16);',
    '    bool cap = (style & 0x00C00000) != 0;',
    '    string n = "?";',
    '    try { n = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }',
    '    return pid + "|" + n + "|" + r.Left + "|" + r.Top + "|" + (r.Right - r.Left) + "|" + (r.Bottom - r.Top) + "|" + (cap ? 1 : 0);',
    '  }',
    '}',
    '"@',
    'Add-Type -AssemblyName System.Windows.Forms',
    '$sw = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width',
    '$sh = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height',
    'while ($true) {',
    '  [Console]::Out.WriteLine("FG|" + [Win32g]::Q())',
    '  [Console]::Out.WriteLine("SCREEN|" + $sw + "|" + $sh)',
    '  [Console]::Out.Flush()',
    '  Start-Sleep -Milliseconds ' + INTERVAL_MS,
    '}',
  ].join('\r\n');   // ⚠️ PowerShell 的脚本用 CRLF 更保险（LF 也能跑，但 CRLF 不会踩任何怪事）
}

let child = null;
let scriptPath = null;
let buf = '';
let screen = null;
let lastGame = null;
let handler = null;
let failing = 0;

function emit(isGame, why) {
  if (isGame === lastGame) return;
  lastGame = isGame;
  try { handler && handler(isGame, why); } catch { /* 回调自己炸了不该拖垮探测 */ }
}

/**
 * 起探测。幂等 —— 重复调用不会起第二个进程。
 * @param {(isGame:boolean, why:string)=>void} onGame 状态**变化**时才回调（不是每 2 秒都叫）
 * @param {()=>{enabled:boolean, exclude:string[]}} getCfg
 */
function start(onGame, getCfg) {
  handler = onGame;
  if (child) return true;

  try {
    const dir = path.join(os.tmpdir(), 'yachiyo-gamedetect');
    fs.mkdirSync(dir, { recursive: true });
    scriptPath = path.join(dir, 'probe.ps1');
    fs.writeFileSync(scriptPath, psScript(), 'utf8');   // 纯 ASCII ⇒ 无 BOM 也不会乱码
  } catch (err) {
    console.error('[game] 写探测脚本失败：' + err.message);
    return false;
  }

  try {
    child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    console.error('[game] 起 PowerShell 失败：' + err.message);
    child = null;
    return false;
  }

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() || '';
    for (const ln of lines) {
      const p = parseLine(ln);
      if (!p) continue;
      if (p.kind === 'screen') { screen = { w: p.w, h: p.h }; continue; }
      if (p.kind !== 'fg') continue;
      failing = 0;
      let cfgNow = { enabled: true, exclude: DEFAULT_EXCLUDE };
      try { cfgNow = getCfg ? (getCfg() || cfgNow) : cfgNow; } catch { /* 用默认 */ }
      if (cfgNow.enabled === false) { emit(false, '关掉了'); continue; }
      const r = judge(screen, p, cfgNow.exclude && cfgNow.exclude.length ? cfgNow.exclude : DEFAULT_EXCLUDE);
      emit(r.isGame, r.why);
    }
  });

  child.stderr.on('data', (d) => {
    // ⚠️ PowerShell 的怪毛病：脚本能跑但会吐几行"不是 cmdlet"的噪声，别当成故障
    const s = String(d).trim();
    if (s) failing++;
    if (failing === 1) console.error('[game] PowerShell 说：' + s.slice(0, 200));
  });

  child.on('exit', (code) => {
    child = null;
    /*
     * ⚠️ 退出就重起一次（PowerShell 被杀、休眠唤醒后失联都可能）。
     *    但要**留个闸**：每 10 秒最多重起一次，不然它要是稳定崩，就成了无限重启风暴。
     */
    if (handler) {
      setTimeout(() => { if (!child) { try { start(handler, getCfg); } catch { /* 下次再说 */ } } }, 10000);
    }
  });

  return true;
}

function stop() {
  handler = null;
  if (child) {
    try { child.kill(); } catch { /* 已经没了 */ }
    child = null;
  }
  if (scriptPath) {
    try { fs.unlinkSync(scriptPath); } catch { /* 删不掉也不影响 */ }
    scriptPath = null;
  }
}

module.exports = {
  INTERVAL_MS, EDGE_TOL, DEFAULT_EXCLUDE,
  parseLine, judge,
  start, stop,
  _state: () => ({ running: !!child, screen, lastGame }),
};
