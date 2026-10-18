/**
 * 抓屏 —— 截一张屏，附带"他现在在用什么窗口"。
 *
 * ── ★★ 两条路，实测都行（2026-10-13 在他 ELDEN RING 全屏里量的）────
 *
 *   桌面状态下三条路截出来一模一样，**分不出高下**；只有真在全屏游戏里才验得出来。
 *   实测结果：
 *     · **GDI**（PowerShell `CopyFromScreen`）   2048×1152，25/25 采样点亮 ✅
 *     · **desktopCapturer**（Electron 自带）     1280×720， 24/25 点亮 ✅
 *     · 两张图里都是真游戏画面（黄金树、字幕、血条、指南针）—— **不是全黑**
 *
 *   ⚠️ 旧工程认了「独占全屏游戏抓出来全黑，认出来就跳过」。**在你这儿不成立** ——
 *      你的游戏多半是**无边框全屏**。所以这一版不用 DXGI、不用 WGC，两条路够了。
 *   ⚠️ **万一哪天真遇到独占全屏抓黑了**：`sample()` 会判成全黑、直接跳过这一轮
 *      （不会拿黑图去花钱）。那时候再考虑上 DXGI 桌面复制（OBS/ShareX 用的那个）。
 *
 * ── 为什么默认走 desktopCapturer ─────────────────────────
 *   · 它是 Electron 自带的，**不用起子进程** —— GDI 那条路每次都要
 *     `powershell.exe` 冷启动，几百毫秒起，而且要在临时目录写脚本
 *   · 它给的是 `NativeImage`，能直接 `getBitmap()` 拿像素 ——
 *     取样、算哈希**全在内存里做完**，不用再读一遍文件
 *
 * ⚠️ **core 层不直接 require electron**（那玩意儿在 node 里跑不起来）。
 *    由主进程 `attach({ desktopCapturer, screen })` 塞进来 —— 跟 heartbeat 一个路子。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const cfg = require('./config.cjs');
const log = require('./log.cjs');

/** 抓来的图缩到这个宽度（够看，又省 token 省上传时间） */
const MAX_W = 1280;

/** 取样网格 5×5 —— 25 个点，避开最边上（边上常是任务栏/黑边） */
const GRID = [0.06, 0.28, 0.5, 0.72, 0.94];

/** 一个点三个通道全部 ≤ 这个值 → 算这个点是黑的 */
const BLANK_LEVEL = 12;

/** desktopCapturer / screen / nativeImage，由主进程塞进来 */
let electron = { desktopCapturer: null, screen: null, nativeImage: null };

function attach(o = {}) {
  if (o.desktopCapturer) electron.desktopCapturer = o.desktopCapturer;
  if (o.screen) electron.screen = o.screen;
  if (o.nativeImage) electron.nativeImage = o.nativeImage;
}

/* ══════════════ 解码（只为了取样判黑）══════════════ */

/**
 * 把一张 **JPEG 字节**解出像素来，好取样判黑。
 *
 * ⚠️⚠️ 为什么要这么绕：本机**没有任何 JPEG 解码器**
 *    （sharp / jpeg-js / pngjs / jimp / canvas 一个都没装，也不能为了这点事引一个）。
 *    但 **Electron 自带** `nativeImage` —— `createFromBuffer()` 能解 JPEG，
 *    `toBitmap()` 给 BGRA。够了。
 *
 * ⚠️ **只给 GDI 那条路用**。desktopCapturer 那条本来就拿得到 `NativeImage`，
 *    直接 `toBitmap()`，不用重新解一遍（解一次要几十毫秒）。
 *
 * ⚠️ 拿不到 `nativeImage` 时返回 null —— 调用方**当"判不了"处理**，
 *    不要当"全黑"（那会把好好的截图白白扔掉）。
 */
function decodeJpeg(buf) {
  if (!electron.nativeImage) return null;
  try {
    const img = electron.nativeImage.createFromBuffer(buf);
    if (!img || img.isEmpty()) return null;
    const size = img.getSize();
    const bmp = img.toBitmap();               // BGRA
    if (!bmp || !size.width) return null;
    return { bmp, w: size.width, h: size.height };
  } catch { return null; }
}

/* ══════════════ 取样 / 哈希（纯函数，好测）══════════════ */

/**
 * 从一张 BGRA 位图里取样，判"是不是全黑"。
 *
 * ⚠️ **为什么非要 25 个点、阈值 12**（旧工程 O80 的教训）：
 *    原来 3×3 九个点、阈值 24，对 2560×1440 太稀疏 ——
 *    **深色主题的编辑器铺满、或者电影暗场景**，有可能凑满"全黑"，
 *    被判成"独占全屏游戏"，于是她整轮不说话，日志里只留一行
 *    "全黑，跳过"，极难查。加密取样点 + 降阈值之后才稳。
 *
 * @param {Buffer} bmp  BGRA 位图
 * @param {number} w
 * @param {number} h
 * @returns {{blank:boolean, max:number, lit:number}}
 */
function sample(bmp, w, h) {
  let max = 0, lit = 0;
  if (!bmp || !w || !h) return { blank: true, max: 0, lit: 0 };
  for (const fx of GRID) {
    for (const fy of GRID) {
      let px = Math.round(w * fx);
      let py = Math.round(h * fy);
      if (px >= w) px = w - 1;
      if (py >= h) py = h - 1;
      const i = (py * w + px) * 4;
      if (i + 2 >= bmp.length) continue;
      // BGRA
      const v = Math.max(bmp[i], bmp[i + 1], bmp[i + 2]);
      if (v > max) max = v;
      if (v > BLANK_LEVEL) lit++;
    }
  }
  return { blank: lit === 0, max, lit };
}

/** 两张图是不是一模一样（同一次里省一张图钱、跨轮判"画面没变"） */
function hashOf(buf) {
  return crypto.createHash('md5').update(buf).digest('base64');
}

/* ══════════════ 前台窗口（不截图也知道他在干嘛）══════════════ */

/**
 * 读前台窗口的标题 + 进程名。
 *
 * ⚠️ **这条对独占全屏 100% 有效**，而且不吃显卡、不花钱 ——
 *    截图万一抓黑，她至少知道「他在玩 ELDEN RING」。
 *
 * ⚠️ 走 `powershell.exe -File`（脚本写临时文件），**不走 `-Command`** ——
 *    这东西里全是引号和 DLL 导入，塞进命令行会被转义撕碎。
 */
/**
 * 写 .ps1 时带的 BOM。
 * ⚠️ PowerShell 5.1 读**不带 BOM** 的 .ps1 会按系统 ANSI 解 ——
 *    脚本里只要出现非 ASCII（比如用户名是中文时 `C:\Users\张三\…` 那种路径）就会坏。
 *    （2026-10-16 加的，见 foreground / gdi 两处的 writeFileSync。）
 */
const PS_BOM = '\uFEFF';

function foreground() {
  const out = { title: '', proc: '', pid: 0, ok: false, why: '' };
  if (process.platform !== 'win32') { out.why = '只有 Windows 上有这道'; return out; }

  const dir = path.join(cfg.DIR, 'tmp');
  const f = path.join(dir, 'fg.ps1');
  try {
    fs.mkdirSync(dir, { recursive: true });
    /*
     * ⚠️ .ps1 要**带 BOM** 写（2026-10-16 修的）。
     *    PowerShell 5.1 读**不带 BOM** 的 .ps1 时按**系统 ANSI** 解，
     *    而下面 gdi 那个脚本里写着 `%APPDATA%` 展开出来的**绝对路径** ——
     *    用户名带中文的话（`C:\Users\张三\…`）路径会被解成乱码 ⇒ 截图直接失败。
     *    （这台机器用户名是 `Susim`、纯 ASCII，所以本地走不到；
     *      但中文用户名的中文 Windows 是常态。）
     */
    fs.writeFileSync(f, PS_BOM + FG_PS1, 'utf8');
    const raw = execFileSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', f],
      { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const line = String(raw).trim().split(/\r?\n/).filter(Boolean).pop() || '';

    /*
     * ⚠️⚠️ 从**右边**切（2026-10-16 修的）。
     *
     *    格式是 `标题|进程名|pid`，而**窗口标题本身可能含 `|`** ——
     *    比如 `首页 | 哔哩哔哩 - Google Chrome`。
     *    原来 `line.split('|')` 从左取 `parts[1]`/`parts[2]`：
     *    实测 `"A | B|chrome|123"` → proc="B"、**pid=0**（Number("B") 是 NaN）。
     *    pid 一错，`peeker` 里「这是不是我自己的窗口」那道守卫就失效了
     *    （它拿 `fg.pid === ownPid` 判），提示词里的「程序」也是错的残段。
     *
     *    后两段（进程名 / pid）是 PS 自己生成的，**不含 `|`**，
     *    所以从右往左切是稳的。
     */
    const p1 = line.lastIndexOf('|');
    const p2 = p1 > 0 ? line.lastIndexOf('|', p1 - 1) : -1;
    if (p2 < 0) { out.why = 'PS 回的东西认不出来：' + line.slice(0, 60); return out; }
    out.title = line.slice(0, p2).trim();
    out.proc  = line.slice(p2 + 1, p1).trim();
    out.pid   = Number(line.slice(p1 + 1)) || 0;
    out.ok = true;
  } catch (err) {
    out.why = err.message;
    log.warn('识屏', '读前台窗口失败：' + err.message);
  }
  return out;
}

/** ⚠️ 输出必须是**一行**：`标题|进程名|pid` —— 中文标题里可能有空格，所以用 `|` 分隔 */
const FG_PS1 = `$ErrorActionPreference = 'SilentlyContinue'
# ⚠️ 输出必须显式设成 UTF-8（2026-10-16 加的）——
#    powershell.exe 往管道里写默认走**系统 OEM 代码页**（中文机器上是 936），
#    而 Node 那边按 utf8 解 ⇒ 中文窗口标题全变乱码
#    （实测：记事本 → 解出来是 "���±�"）。
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
'@ -Name FgCap -Namespace YcCap -PassThru | Out-Null
$h = [YcCap.FgCap]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 512
[void][YcCap.FgCap]::GetWindowText($h, $sb, 512)
$pid2 = 0
[void][YcCap.FgCap]::GetWindowThreadProcessId($h, [ref]$pid2)
$pn = ''
try { $pn = (Get-Process -Id $pid2 -ErrorAction SilentlyContinue).ProcessName } catch { }
Write-Output ($sb.ToString() + '|' + $pn + '|' + $pid2)
`;

/* ══════════════ 抓 ══════════════ */

/** 我们自己那几个窗口的进程 id —— 抓到自己就说明他什么都没开（她不该吐槽自己） */
let ownPid = 0;
function setOwnPid(p) { ownPid = Number(p) || 0; }

/**
 * 抓一张。
 *
 * @param {string} [method] 'auto' | 'desktopCapturer' | 'gdi'
 * @returns {Promise<{ok:boolean, buffer:Buffer|null, w:number, h:number,
 *                    blank:boolean, max:number, lit:number, hash:string,
 *                    method:string, why:string}>}
 */
async function grab(method) {
  const m = String(method || cfg.get('screenCapture') || 'auto');
  const empty = (why) => ({ ok: false, buffer: null, w: 0, h: 0, blank: true, max: 0, lit: 0, hash: '', method: m, why });

  /*
   * ⚠️⚠️ **GDI 那条一律要过 `markBlank`** —— 它自己截完不判全黑。
   *    第一版写成 `if (m === 'gdi') return gdi();`，**直接返回、绕过了判定** ——
   *    症状是 `lit:0` 却 `blank:false`（等于不判），黑图会被照发出去。
   *    冒烟没逮到它，是因为探针只看 `blank`（false 也算"过"）。
   *    ⇒ 这里写成**只有一条出口**：先拿图，再统一判定。
   */
  if (m === 'gdi') {
    const g = gdi();
    return g.ok ? markBlank(g) : g;
  }
  if (m === 'desktopCapturer') return electronShot();

  // auto：先 Electron（不起子进程），拿不到再退 GDI
  const a = await electronShot();
  if (a.ok && !a.blank) return a;
  const b = gdi();
  if (b.ok) return markBlank(b);
  return a.ok ? a : b;              // 两条都不行就把 Electron 那条的失败原因带回去
}

/**
 * 补上「全黑」判定。
 *
 * ⚠️ GDI 那条**截完不判**（PS 里那个采样循环有怪癖，见 gdi() 里的注释），
 *    统一拿到这儿判：用 Electron 的 nativeImage 解一遍 JPEG 再 5×5 取样。
 * ⚠️ **解不开就不判**（`blank: false`）—— 「判不了」和「全黑」是两回事，
 *    前者该照常发，后者才该跳过。把判不了的当全黑会把好好的图白白扔掉。
 */
function markBlank(shot) {
  if (!shot || !shot.ok || !shot.buffer) return shot;
  const d = decodeJpeg(shot.buffer);
  if (!d) {
    log.warn('识屏', 'GDI 那张解不开（nativeImage 拿不到？）—— 跳过全黑判定，照常发');
    return { ...shot, blank: false, max: 0, lit: 0, decoded: false };
  }
  const s = sample(d.bmp, d.w, d.h);
  return { ...shot, blank: s.blank, max: s.max, lit: s.lit, decoded: true };
}

/** Electron 那条：不起子进程，像素和哈希全在内存里算完 */
async function electronShot() {
  const bad = (why) => ({ ok: false, buffer: null, w: 0, h: 0, blank: true, max: 0, lit: 0, hash: '', method: 'desktopCapturer', why });
  if (!electron.desktopCapturer || !electron.screen) return bad('主进程没把 desktopCapturer 塞进来');

  try {
    const d = electron.screen.getPrimaryDisplay();
    const sw = d.size.width, sh = d.size.height;
    const w = Math.min(MAX_W, sw);
    const h = Math.max(1, Math.round(sh * (w / sw)));

    const srcs = await electron.desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: w, height: h },
    });
    if (!srcs || !srcs.length) return bad('一个屏幕源都没拿到');

    /*
     * ⚠️⚠️ 要挑**主显示器那一份**，不能拿 `srcs[0]`（2026-10-14 修的）。
     *
     *    多屏时 `getSources()` 的顺序**不保证**把主屏放第一个 ——
     *    而上面那个 `thumbnailSize` 是**按主屏算的**。
     *    拿错源不只是「分析错屏幕」，缩略图的比例还对不上，
     *    非主屏那份会被**拉伸**着塞进主屏的尺寸里。
     *
     *    `display_id` 是 Electron 给的显示器编号，跟 `screen` 那边的 `id` 对得上。
     *    对不上就**退回第一个源**，但**必须记一笔日志** ——
     *    悄悄的降级就是「假成功」（本机单屏，这条降级路走不到）。
     */
    const wantId = d.id === undefined ? null : String(d.id);
    const picked = (wantId !== null && srcs.find((s) => String(s.display_id) === wantId)) || srcs[0];
    if (wantId !== null && String(picked.display_id) !== wantId) {
      log.warn('识屏', `没找到主显示器的源（主屏 id=${wantId}，拿到 ${srcs.map((s) => s.display_id).join('/')}）`
        + ' → 退回第一个源，抓到的可能不是主屏');
    }

    const img = picked.thumbnail;
    const size = img.getSize();
    const bmp = img.getBitmap();               // BGRA
    const s = sample(bmp, size.width, size.height);
    const jpeg = img.toJPEG(80);

    return {
      ok: true, buffer: jpeg, w: size.width, h: size.height,
      blank: s.blank, max: s.max, lit: s.lit,
      hash: hashOf(jpeg), method: 'desktopCapturer', why: '',
    };
  } catch (err) {
    log.warn('识屏', 'desktopCapturer 抓屏失败：' + err.message);
    return bad(err.message);
  }
}

/** GDI 那条：起 powershell 截一份出来（取样和哈希在 PS 里做完，回 JSON） */
let gdiWarned = false;
function gdi() {
  const bad = (why) => ({ ok: false, buffer: null, w: 0, h: 0, blank: true, max: 0, lit: 0, hash: '', method: 'gdi', why });
  if (process.platform !== 'win32') return bad('只有 Windows 上有这道');

  const dir = path.join(cfg.DIR, 'tmp');
  const out = path.join(dir, 'shot.jpg');
  const ps1 = path.join(dir, 'gdi.ps1');

  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ps1, PS_BOM + gdiScript(out, MAX_W), 'utf8');   // ⚠️ BOM 见 foreground 那边的注释
    const raw = execFileSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { encoding: 'utf8', windowsHide: true, timeout: 40000 });
    const line = String(raw).trim().split(/\r?\n/).filter(Boolean).pop() || '';
    if (!line.startsWith('OK|')) return bad(line.replace(/^ERR\|/, '') || 'PS 没回结果');

    const [, w, h] = line.split('|');
    const buffer = fs.readFileSync(out);
    return {
      ok: true, buffer, w: Number(w), h: Number(h),
      /*
       * ⚠️⚠️ `blank` **一律写 false**，取样和哈希全交给上面的判断做
       *      （见 `grab()` 里的 `markBlank`）。
       *
       *   为什么不在 PS 里采样了：2026-10-13 卡了半个多小时 ——
       *   同一段 5×5 采样循环，**单独跑 lit=23，塞在这个脚本里 lit=0**，
       *   逐行打印都正常（中心像素 255）、`$mx` 就是不出数。
       *   那是 PowerShell 的某种作用域/类型怪癖，**查它不划算**。
       *   ⇒ 原则：**PS 只负责"把图截下来"**，判断这种纯逻辑留在 Node ——
       *     跟 desktopCapturer 那条路共用同一套代码，也才测得住。
       */
      blank: false, max: 0, lit: 0,
      hash: hashOf(buffer), method: 'gdi', why: '',
    };
  } catch (err) {
    // ⚠️ 只警告一次 —— 每 12 分钟报一次同样的错会把日志刷爆
    if (!gdiWarned) { gdiWarned = true; log.warn('识屏', 'GDI 抓屏失败（以后不再重复报）：' + err.message); }
    return bad(err.message);
  } finally {
    try { fs.rmSync(ps1, { force: true }); } catch { /* 删不掉就算 */ }
    /*
     * ⚠️ **截图也要删**（2026-10-16 加的）。
     *    `shot.jpg` 是**整屏截图** —— 里面可能有他正在看的东西。
     *    原来它一直躺在 `%APPDATA%\Yachiyo\tmp` 里，直到下次抓屏才被覆盖。
     *    （buffer 上面已经 `readFileSync` 进内存了，删文件不影响它。）
     */
    try { fs.rmSync(out, { force: true }); } catch { /* 删不掉就算 */ }
  }
}

/**
 * GDI 那段 PowerShell。
 * ⚠️ 缩放要用 **HighQualityBicubic** —— 默认的低质量插值在缩到 1280 时
 *    文字会糊成一片，她看不清屏幕上写的是什么。
 */
function gdiScript(outFile, maxW) {
  const o = outFile.replace(/'/g, "''");
  return `$ErrorActionPreference = 'Stop'
try {
  [void][System.Reflection.Assembly]::LoadWithPartialName('System.Drawing')
  [void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $full = New-Object System.Drawing.Bitmap -ArgumentList $b.Width, $b.Height
  $g = [System.Drawing.Graphics]::FromImage($full)
  $g.CopyFromScreen($b.X, $b.Y, 0, 0, (New-Object System.Drawing.Size -ArgumentList $b.Width, $b.Height))
  $g.Dispose()

  $scale = 1.0
  if ($b.Width -gt ${maxW}) { $scale = [double]${maxW} / [double]$b.Width }
  $nw = [int]($b.Width * $scale); if ($nw -lt 1) { $nw = 1 }
  $nh = [int]($b.Height * $scale); if ($nh -lt 1) { $nh = 1 }

  $small = New-Object System.Drawing.Bitmap -ArgumentList $nw, $nh
  $g2 = [System.Drawing.Graphics]::FromImage($small)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($full, 0, 0, $nw, $nh)
  $g2.Dispose(); $full.Dispose()

  # 5x5 取样，判全黑（阈值 12，跟 capture.cjs 里的 BLANK_LEVEL 对齐）
  $sx = @(0.06, 0.28, 0.5, 0.72, 0.94)
  $lit = 0; $mx = 0
  foreach ($fx in $sx) { foreach ($fy in $sx) {
    $px = [int]($nw * $fx); $py = [int]($nh * $fy)
    if ($px -ge $nw) { $px = $nw - 1 }
    if ($py -ge $nh) { $py = $nh - 1 }
    $c = $small.GetPixel($px, $py)
    $v = [Math]::Max($c.R, [Math]::Max($c.G, $c.B))
    if ($v -gt $mx) { $mx = $v }
    if ($v -gt 12) { $lit++ }
  } }

  $ms = New-Object System.IO.MemoryStream
  $small.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
  $bytes = $ms.ToArray()
  $ms.Close(); $small.Dispose()
  $md5 = [System.Security.Cryptography.MD5]::Create()
  $hash = [Convert]::ToBase64String($md5.ComputeHash($bytes))
  [System.IO.File]::WriteAllBytes('${o}', $bytes)
  Write-Output ('OK|' + $nw + '|' + $nh + '|' + $lit + '|' + $mx + '|' + $hash)
} catch {
  Write-Output ('ERR|' + $_.Exception.Message)
}
`;
}

module.exports = {
  MAX_W, GRID, BLANK_LEVEL,
  attach, setOwnPid, sample, hashOf, foreground, grab,
  /** ⚠️ 导出**只为排查** —— 那段 PS 里的输出格式出过问题，得能单独跑它 */
  _gdiScript: (out, maxW) => gdiScript(out, maxW),
  /** ⚠️ 也是排查用 */
  _decodeJpeg: (b) => decodeJpeg(b),
  _markBlank: (s) => markBlank(s),
  _state: () => ({ hasElectron: !!(electron.desktopCapturer && electron.screen), ownPid, gdiWarned }),
};
