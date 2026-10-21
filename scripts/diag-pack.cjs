#!/usr/bin/env node
/**
 * scripts/diag-pack.cjs —— 一键把"现场"收成一份诊断包
 *
 * 为什么要有这个：
 *   出问题的时候，最耗时间的不是修，是**确认是哪个环节**。
 *   而她大部分活（识屏 / 回顾 / 自言语 / 备份）都是后台静默跑的 ——
 *   他在屏幕前只能看到"她今天不说话"，看不到是门槛没过、模型挂了、还是压根没触发。
 *
 *   于是每次排查我都要问他：日志在哪、截图呢、你改过什么、是哪个版本……
 *   这个脚本把那一串问答变成**一条命令**。
 *
 * 用法：
 *   node scripts/diag-pack.cjs              → 打包到 桌面\八千代AI诊断包\
 *   node scripts/diag-pack.cjs <输出目录>    → 指定落哪儿
 *
 * 收什么：见下面 ITEMS。**只读复制，一个字节都不改他的真数据。**
 * 安全：
 *   - apiKey / token / key / secret 这类字段一律打码（`sk-****（35 字）`）
 *   - 不联网、不上报、不弹窗
 *   - 日志只取尾部 N 行（整月日志可能几 MB，没必要全带走）
 *
 * ⚠️ 这个脚本只用 node 内置模块，不 require electron、不 require core ——
 *    坏了半个工程也能跑。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TAIL_LINES = 400;

/* ───────────── 落哪儿 ───────────── */

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
         `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const outArg = process.argv[2];
const OUT = outArg
  ? path.resolve(outArg)
  : path.join(os.homedir(), 'Desktop', '八千代AI诊断包', 'Yachiyo-diag-' + stamp());

/** 数据家（跟 src/core/config.cjs 同一套判断：env 优先） */
const APP = process.env.YACHIYO_HOME ||
  path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Yachiyo');

/* ───────────── 小工具 ───────────── */

const notes = [];   // 人读的摘要行

function say(s) { notes.push(s); console.log(s); }

function mkdirp(d) { fs.mkdirSync(d, { recursive: true }); }

function copyInto(rel, src, opt = {}) {
  if (!fs.existsSync(src)) { notes.push(`  · 缺 ${rel}（${src} 不存在）`); return false; }
  const dst = path.join(OUT, rel);
  mkdirp(path.dirname(dst));
  try {
    const st = fs.statSync(src);
    if (!st.isFile()) { notes.push(`  · 跳过 ${rel}（不是文件）`); return false; }
    if (opt.tail) {
      const txt = fs.readFileSync(src, 'utf8');
      const lines = txt.split('\n');
      const cut = lines.length > opt.tail ? lines.slice(-opt.tail) : lines;
      const head = lines.length > opt.tail
        ? `…（前面还有 ${lines.length - opt.tail} 行没带）\n` : '';
      fs.writeFileSync(dst, head + cut.join('\n'), 'utf8');
    } else if (opt.text != null) {
      fs.writeFileSync(dst, opt.text, 'utf8');
    } else {
      fs.copyFileSync(src, dst);
    }
    const size = fs.statSync(dst).size;
    notes.push(`  · ${rel}  ${size} B`);
    return true;
  } catch (e) {
    notes.push(`  · ${rel} 收失败：${e.message}`);
    return false;
  }
}

/** 打码：任何长得像密钥的字符串都只留头尾 */
function mask(s) {
  if (typeof s !== 'string' || !s) return s;
  if (s.length < 12) return '****';
  return s.slice(0, 4) + '****（' + s.length + ' 字）';
}

const SECRET_KEY = /^(api[_-]?key|key|token|secret|password|authorization|__cf_bm|cookie|session)$/i;

/** 深拷贝 + 打码（只在复制出来的对象上动手，绝不回写） */
function scrub(v, depth = 0) {
  if (depth > 8 || v == null) return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1));
  if (typeof v === 'object') {
    const o = {};
    for (const [k, val] of Object.entries(v)) {
      o[k] = SECRET_KEY.test(k) ? mask(val) : scrub(val, depth + 1);
    }
    return o;
  }
  // 值是长串且没有空格的，多半是密钥；但别误伤路径（含 \ 或 /）
  if (typeof v === 'string' && v.length >= 32 && !/\s/.test(v) && !/[\\/]/.test(v)) return mask(v);
  return v;
}

/** 收一个 json/jsonl：打码后写出去 */
function copyJson(rel, src) {
  if (!fs.existsSync(src)) { notes.push(`  · 缺 ${rel}`); return false; }
  const dst = path.join(OUT, rel);
  mkdirp(path.dirname(dst));
  try {
    const raw = fs.readFileSync(src, 'utf8');
    if (src.endsWith('.jsonl')) {
      const lines = raw.split('\n').filter((l) => l.trim());
      const kept = lines.slice(-200).map((l) => {
        try { return JSON.stringify(scrub(JSON.parse(l))); } catch { return l.slice(0, 400); }
      });
      fs.writeFileSync(dst,
        `…（共 ${lines.length} 行，只带最后 ${kept.length} 行）\n` + kept.join('\n') + '\n', 'utf8');
    } else {
      fs.writeFileSync(dst, JSON.stringify(scrub(JSON.parse(raw)), null, 2), 'utf8');
    }
    notes.push(`  · ${rel}  ${fs.statSync(dst).size} B（已打码）`);
    return true;
  } catch (e) {
    notes.push(`  · ${rel} 收失败：${e.message}`);
    return false;
  }
}

function sh(cmd) {
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { encoding: 'utf8', timeout: 15000, windowsHide: true });
    return ((r.stdout || '') + (r.stderr || '')).trim();
  } catch (e) { return '(取不到：' + e.message + ')'; }
}

function git(args) {
  try {
    const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 15000, windowsHide: true });
    return (r.stdout || '').trim();
  } catch { return ''; }
}

/* ───────────── 开工 ───────────── */

mkdirp(OUT);
say('诊断包 → ' + OUT);
say('');

/* ① 环境 */
say('【环境】');
let pkg = {};
try { pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch {}
const head = git(['rev-parse', '--short', 'HEAD']);
const dirty = git(['status', '--porcelain']);
const screen = sh('Add-Type -AssemblyName System.Windows.Forms; ' +
  '[System.Windows.Forms.Screen]::AllScreens | ForEach-Object { ' +
  '"$($_.Bounds.Width)x$($_.Bounds.Height) @$($_.Bounds.X),$($_.Bounds.Y) work=$($_.WorkingArea.Width)x$($_.WorkingArea.Height) primary=$($_.Primary)" }');
/* ⚠️ powershell.exe 是 **DPI-unaware** 的：上面拿到的是**缩放后**的逻辑尺寸。
   原生像素得问显卡驱动，两个一除就是缩放比（这台 2560/2048 = 125%）。 */
const gpus = sh("Get-CimInstance Win32_VideoController | ForEach-Object { " +
  "\"$($_.Name) $($_.CurrentHorizontalResolution)x$($_.CurrentVerticalResolution)\" }");
const nativeRes = (/(\d+)x(\d+)/.exec(gpus.split('\n').find((l) => /\dx\d/.test(l) && !/^\s*x/.test(l)) || '') || [])[0] || '';
const logicalRes = (/^(\d+)x(\d+)/.exec(screen) || [])[0] || '';
const zoom = (() => {
  const a = nativeRes.split('x').map(Number);
  const b = logicalRes.split('x').map(Number);
  if (!a[0] || !b[0]) return '';
  return Math.round((a[0] / b[0]) * 100) + '%（原生 ' + nativeRes + ' ÷ 逻辑 ' + logicalRes + '）';
})();
const procs = sh("Get-Process | Where-Object { $_.ProcessName -match 'Yachiyo|electron' } | " +
  'ForEach-Object { "$($_.ProcessName) pid=$($_.Id) path=$($_.Path)" }');
const dpi = sh('(Get-ItemProperty "HKCU:\\Control Panel\\Desktop\\WindowMetrics" -ErrorAction SilentlyContinue).AppliedDPI');

const envTxt = [
  '时间        ' + new Date().toString(),
  '工程目录    ' + ROOT,
  '数据家      ' + APP,
  '版本        ' + (pkg.version || '(读不到 package.json)'),
  'git HEAD    ' + (head || '(不是 git 仓库)'),
  '工作树      ' + (dirty ? '有 ' + dirty.split('\n').length + ' 项未提交' : '干净'),
  'node        ' + process.version,
  '平台        ' + process.platform + ' ' + process.arch + ' ' + os.release(),
  '内存        ' + Math.round(os.totalmem() / 1073741824 * 10) / 10 + ' GiB',
  'CPU         ' + os.cpus().length + ' 核 ' + (os.cpus()[0] || {}).model,
  '屏幕        ' + (screen || '(取不到)') + '  ← PowerShell 是 DPI-unaware，这是缩放后的逻辑尺寸',
  '显示缩放    ' + (zoom || '(算不出)'),
  '显卡        ' + (gpus.replace(/\n/g, ' | ') || '(取不到)'),
  'DPI 注册表  ' + (dpi || '(空)') + '  (96=100% / 120=125%；Win10 常读不到，以「显示缩放」那行为准)',
  '进程        ' + (procs || '(没在跑)'),
  'NODE_ENV    ' + (process.env.NODE_ENV || '(空)'),
  'ELECTRON_RUN_AS_NODE  ' + (process.env.ELECTRON_RUN_AS_NODE || '(空，正常)'),
  'YACHIYO_CDP / YACHIYO_MS  ' + (process.env.YACHIYO_CDP || '-') + ' / ' + (process.env.YACHIYO_MS || '-'),
].join('\r\n');
fs.writeFileSync(path.join(OUT, '01-环境.txt'), envTxt, 'utf8');
say('  · 01-环境.txt  ' + Buffer.byteLength(envTxt) + ' B');

/* ② 配置（打码）*/
say('');
say('【配置】');
copyJson('02-config.json', path.join(APP, 'config.json'));
copyJson('02-design.json', path.join(APP, 'design.json'));
copyJson('02-data-providers.json', path.join(APP, 'data', 'providers.json'));

/* ③ 日志 */
say('');
say('【日志】');
const logDir = path.join(APP, 'logs');
let logFile = null;
try {
  const list = fs.readdirSync(logDir).filter((f) => f.endsWith('.log')).sort();
  logFile = list.length ? path.join(logDir, list[list.length - 1]) : null;
} catch {}
if (logFile) copyInto('03-日志-' + path.basename(logFile), logFile, { tail: TAIL_LINES });
else notes.push('  · 缺 日志（logs 目录是空的）');
copyInto('03-识屏手记-look.log', path.join(APP, 'data', 'look.log'), { tail: 100 });
// 仓库里探针模式的临时日志（有就收，没有不算缺）
for (const f of ['_probe.log', '_ignore.log']) {
  copyInto('03-' + f, path.join(ROOT, f), { tail: TAIL_LINES });
}

/* ④ 数据（会话 / 记忆 / 用量 / 状态）*/
say('');
say('【数据】');
copyJson('04-chat.jsonl', path.join(APP, 'data', 'chat.jsonl'));
copyJson('04-usage.json', path.join(APP, 'data', 'usage.json'));
copyJson('04-state-spoken.json', path.join(APP, 'data', 'state', 'spoken.json'));
copyJson('04-state-session.json', path.join(APP, 'data', 'state', 'session.json'));
copyJson('04-state-last-exit.json', path.join(APP, 'data', 'state', 'last-exit.json'));
copyJson('04-state-selftalk.json', path.join(APP, 'data', 'state', 'selftalk.json'));
copyJson('04-state-screen.json', path.join(APP, 'data', 'state', 'screen.json'));
copyJson('04-state-vision.json', path.join(APP, 'data', 'state', 'vision.json'));
copyInto('04-profile.md', path.join(APP, 'data', 'profile.md'));

/* ⑤ 摘要（给"一眼看完"用）*/
say('');
const visionPath = path.join(APP, 'data', 'state', 'vision.json');
let visionNote = '(没有 vision.json —— 从没遇到过"模型没视觉")';
try {
  const v = JSON.parse(fs.readFileSync(visionPath, 'utf8'));
  visionNote = `模型=${v.model || '?'} 时间=${v.when || v.ts || '?'} 原因=${String(v.detail || v.why || '') .slice(0, 120)}`;
} catch {}
const sum = [
  '诊断摘要（' + new Date().toISOString() + '）',
  '',
  '版本      ' + (pkg.version || '?') + '  @ ' + (head || '?'),
  '数据家    ' + APP,
  '日志      ' + (logFile ? path.basename(logFile) : '(没有)'),
  '视觉状态  ' + visionNote,
  '',
  '收进来的东西：',
  ...notes.filter((n) => n.startsWith('  · ')),
  '',
  '⚠️ 本包只读收集，没有改动任何原文件；密钥类字段已打码。',
].join('\r\n');
fs.writeFileSync(path.join(OUT, '00-诊断摘要.txt'), sum, 'utf8');

say('');
say('=== 收完了：' + OUT);
say('=== 目录里 ' + fs.readdirSync(OUT).length + ' 个文件，先看 00-诊断摘要.txt');
