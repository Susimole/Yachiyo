/**
 * Yachiyo · 主进程
 *
 * 一个盖住「工作区」的透明无边框窗口 + 一个托盘。
 *
 * 窗口几条要点（都是第 0 步探路撞出来的）：
 *   · 盖【工作区】不盖整屏 —— 这样不跟任务栏打架
 *   · 默认整窗鼠标穿透，但开 forward，页面才知道鼠标在哪
 *   · 页面说「鼠标在我身上」→ 关穿透；说「走了」→ 恢复
 *   · alwaysOnTop 用 'screen-saver' 档，才压得住全屏游戏
 *
 * 探针模式（调试用）：设了 YACHIYO_MS 就跑够时间自动退出，中途每 3 秒截一张图。
 */
'use strict';

const { app, BrowserWindow, screen, ipcMain, shell, dialog, powerMonitor, desktopCapturer, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

// 排查用：环境不对时 require('electron') 会返回 exe 路径字符串而不是 API 对象。
// 正常启动由 scripts/start.cjs 保证（它显式摘掉了 ELECTRON_RUN_AS_NODE）。
if (typeof app === 'undefined') {
  console.error('[main] electron API 不可用 —— 是不是没走 scripts/start.cjs？');
  process.exit(1);
}

const cfg      = require('../core/config.cjs');
const brain    = require('../core/brain.cjs');
const memory   = require('../core/memory.cjs');
const store    = require('../core/store.cjs');
const usage    = require('../core/usage.cjs');
const provider = require('../core/provider.cjs');
const habits   = require('../core/habits.cjs');
const learn    = require('../core/learn.cjs');
const weather  = require('../core/weather.cjs');
const rigparams = require('../core/rigparams.cjs');
const heartbeat = require('../core/heartbeat.cjs');
const review   = require('../core/review.cjs');
const selftalk = require('../core/selftalk.cjs');
const autoexit = require('../core/autoexit.cjs');
const backup   = require('../core/backup.cjs');
const profiletool = require('../core/profiletool.cjs');
const autostart = require('../core/autostart.cjs');
const fonts = require('./fonts.cjs');
const ai = require('./ai.cjs');
const mouse = require('./mouse.cjs');
const websearch = require('../core/websearch.cjs');
const capture = require('../core/capture.cjs');
const peeker  = require('../core/peeker.cjs');
/* ★ 2026-10-20：只为了 `vision:state`（"这台机器看不了图"那条记录） */
const looktool = require('../core/looktool.cjs');
/* ★ 2026-10-21：只给探针开的 IPC，见 ./probe.cjs 顶上那段 */
const probes = require('./probe.cjs');
/*
 * ★ 游戏检测（2026-10-17 加的）：全屏 + 进程两条一起看，见 core/gamedetect.cjs 顶上那段。
 * ⚠️ 它只负责"判断"，不碰她的状态 —— 判断结果通过 `game:changed` 广播给页面，
 *    由页面自己决定"坐着还是照常走动"（状态机只有一个主人，别两头改）。
 */
const gamedetect = require('../core/gamedetect.cjs');
/*
 * AI 服务商预设（2026-10-17 加的）。
 * ⚠️ 它**不接管**任何读取方 —— 切预设只是把那份值写回 config，
 *    provider/peeker/profile/websearch 照样读 config（见 providers.cjs 顶上那段）。
 */
const providers = require('../core/providers.cjs');
const trayMod  = require('./tray.cjs');
const overlay  = require('./overlay.cjs');

/**
 * 挂一个**只给探针用**的 IPC 口 —— 打包版里**根本不注册**。
 *
 * ⚠️⚠️ 为什么要有这个（2026-10-14 加的）：
 *    `probe:sleep` / `ov:probe-raise` / `ov:probe-bounds` 三个口原来都是
 *    **无条件注册**的 —— preload 那边虽然给 `_probe` / `_sleep` 加了 DEV 闸，
 *    可 `probeRaise` / `probeBounds` 漏在闸外面，正式版里照样调得到
 *    （实测：打包版的 preload.cjs 里就搜得到这两个名字）。
 *    ⇒ **两侧一起挡**：这边不注册，那边不暴露，漏一个都还留着口子。
 *
 * ⚠️ 判据必须用**主进程这边的** `app.isPackaged` ——
 *    preload 跑在沙箱里没有 `app`（见 preload.cjs 文件头那段血泪）。
 *
 * 用法：`devOnly(() => ipcMain.handle('probe:xxx', ...))`
 */
function devOnly(fn) {
  if (app.isPackaged) return;
  fn();
}

/**
 * ⚠️ Electron 默认把 `userData` 放在 `%APPDATA%\Yachiyo\` —— 跟我们的
 *    `config.json` **同一个目录**。跑一趟下来 `Cache/` `GPUCache/` `DIPS`
 *    `Preferences` `Local Storage` 十几个系统文件全堆在那儿，跟用户配置
 *    混成一锅 —— 他打开目录想找 config.json，得先穿过一堆缓存文件。
 *
 *    挪到 `electron\` 子目录去。
 *    ⚠️ **必须在 app.whenReady() 之前设**，晚了 Electron 已经用旧路径建好
 *       缓存目录了，设了也不生效（而且不报错）。
 *    ⚠️ 旧的 `Cache/` 等目录**不删** —— 那是 Electron 自己建的，
 *       留着不影响，删了万一 Electron 还在用反而出事。
 */
app.setPath('userData', path.join(cfg.DIR, 'electron'));

const PROBE_MS = Number(process.env.YACHIYO_MS || 0);   // 0 = 正常跑

/**
 * 探针日志。
 *
 * ⚠️ Windows 上 electron.exe 是 GUI 子系统程序，它的 stdout 不接父进程的管道 ——
 *    console.log 打出去的东西在终端里一个字符都看不见。之前白折腾过一轮，
 *    以为进程没起来，其实跑得好好的。
 *    所以探针模式下所有输出都另写一份到 _probe.log。
 */
const PROBE_ROOT = path.join(__dirname, '..', '..');
const PROBE_LOG  = path.join(PROBE_ROOT, '_probe.log');

function plog(s) {
  if (PROBE_MS <= 0) return;
  const line = `[${new Date().toISOString().slice(11, 23)}] ${s}\n`;
  try { fs.appendFileSync(PROBE_LOG, line, 'utf8'); } catch { /* 日志写不了不该影响主流程 */ }
}

/** @type {BrowserWindow | null} */
let win = null;
let shotTimer = null;
let shotNo = 0;

/* ============================================================
   窗口
   ============================================================ */

/** 画布逻辑边长（拆件单位 640 × 0.72）—— 必须跟 renderer/rig/rig.js 的 CANVAS_PX 一致 */
const CANVAS_PX = 460.8;

/**
 * 窗口该多高。
 *
 * ⚠️⚠️ 2026-10-12 改的，原来窗口是**盖满整个工作区**的。
 *    那一条改动的直接原因是他在 2026-10-11 报的两个「严重」：
 *      · 全屏置顶窗横在桌面上 → 别的播放器做遮挡判定时认为自己的窗口被完全盖住，**视频不播**
 *      · 菜单一打开整窗变可点 → **整块屏幕**都点不到后面的窗口（菜单其实只占 2.4%）
 *    叠加上他新提的要求「只能在任务栏那条水平线上平移」——
 *    既然她只在那一条上活动，窗口就只需要盖住那一条。
 *    ⇒ 底部对齐工作区底边，高度 = 她的画布高。桌面其余部分不再被盖住。
 */
/**
 * 菜单 / 面板 / 聊天窗现在**还**是主窗口里的 DOM（拆成独立窗口是下一步），
 * 所以窗口必须至少装得下最高的那一个，否则打开面板会被窗口底边切掉一截。
 *
 * ⚠️ 这个数只是**过渡期**用的。等它们各自变成独立小窗，
 *    这个 max() 就要去掉 —— 那时候窗口高应该严格等于她的画布高。
 */
const OVERLAY_MIN_H = 560;   // 设置面板最高（760×560）

function stageHeight() {
  const wa = screen.getPrimaryDisplay().workArea;
  const k = (cfg.get('petSize') || 100) / 100;
  const mine = Math.round(CANVAS_PX * k);
  return Math.min(Math.max(mine, OVERLAY_MIN_H), wa.height);
}

/**
 * 窗口永远盖住主屏**底部的一条**，位置不动。
 *
 * 她在屏幕上的位置 = 页面里 #stage 的 left/top，拖她只动 DOM、不动窗口。
 * 每帧 setPosition 拖着一个透明窗跑在 Windows 上会闪，而且她走动时要一直调 ——
 * 那点开销省下来给渲染不好吗。config 里的 petX/petY 存的是【窗口内】坐标。
 */
function placeWindow() {
  const wa = screen.getPrimaryDisplay().workArea;
  const h = stageHeight();
  return { x: wa.x, y: wa.y + wa.height - h, width: wa.width, height: h };
}

/**
 * 她改大小了（设置里拖桌宠大小）→ 窗口跟着变。
 *
 * ⚠️ 只能由**渲染层**来叫。窗口高要跟画布高严格相等，而画布高是渲染层
 *    `applyScale()` 算出来的；主进程自己按 petSize 重算一份也行，
 *    但两处各算一次早晚会飘。渲染层算完直接叫这一声，主进程照做。
 */
function resizeStage() {
  if (!win || win.isDestroyed()) return placeWindow();
  const box = placeWindow();
  win.setBounds(box);
  win.webContents.send('win:stage', box);
  return box;
}

/**
 * ★★ 光标守望：**出了窗口那条带就通知页面把穿透打开**（2026-10-17 加的）。
 *
 *   治的是他报的：「托盘隐藏后再显示，就点不动她 / 拖不动她」。
 *   真机记录（`_dsh020\verify\arm-record.cjs`）抓到了确凿证据：
 *   **`mousedown` 一条都没进页面，`mouseup` 却进来了** ——
 *   说明按下那一刻窗口还在穿透，IPC 五十来毫秒后把穿透收回来，松开正好赶上。
 *
 *   为什么会"每次"都撞上：页面里 `mouseleave` 一响就把穿透打开，而
 *   **穿透状态下 Chromium 会误报 `mouseleave`** ⇒ 「收回 → 误报离开 → 又打开」死循环。
 *   页面自己分不清"真离开"和"穿透状态下的假离开"——**但主进程分得清**，
 *   它手里有窗口矩形、也能问光标真实位置。
 *
 *   ⚠️ 这里的做法是**只通知、不直接改穿透**：
 *      改穿透的唯一控制点仍然是页面（`wantInteractive` / `reassertMouse`），
 *      两边都改会互相打架（页面每 500ms 重申一次，会把主进程的改动顶回去）。
 *   ⚠️ 只在**从内到外**那一下发一次，不是每 120ms 都发（省 IPC、也好读日志）。
 */
/* 光标守望 2026-10-18 拆到 ./mouse.cjs 了（startCursorWatch）——
   它只发事件、不改穿透，所以跟穿透那几块放一起查最方便。 */

function createWindow() {
  const box = placeWindow();

  win = new BrowserWindow({
    ...box,
    transparent: true,
    frame: false,
    resizable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    fullscreenable: false,
    show: false,
    backgroundColor: '#00000000',
    title: 'Yachiyo',
    // 他给的图标（见 tray.cjs 的注释）。窗口是 skipTaskbar 的，平时看不见它，
    // 但打包成 exe 之后、以及鼠标悬停缩略图那一栏用的是这个。
    icon: path.join(__dirname, '..', 'renderer', 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,   // 窗口不可见时也别把计时器冻住
      /*
       * 开发版才挂探针口（`_probe` / `_sleep`）。
       *
       * ⚠️⚠️ 为什么非要**从主进程显式传**，而不是让 preload 自己判断：
       *    preload 跑在沙箱里，那里 `require('electron')` **没有 `app`**
       *    （写 `app.isPackaged` 会当场抛错，Electron 会把**整个 preload 静默丢掉**）；
       *    而 `process.execPath` 在沙箱里也不是你以为的那个值（实测判不出来）。
       *    主进程这边 `app.isPackaged` 是**可靠**的 —— 那就由它一句话告诉对面。
       */
      additionalArguments: app.isPackaged ? [] : ['--yachiyo-dev'],
    },
  });

  win.setAlwaysOnTop(!!cfg.get('alwaysOnTop'), 'screen-saver');
  // 告诉 overlay「主窗口本来该不该置顶」—— 菜单开着时它会临时把主窗口降下来
  overlay.mainTopValue(!!cfg.get('alwaysOnTop'));
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setIgnoreMouseEvents(true, { forward: true });

  /*
   * ⚠️⚠️ **这里千万不要再补 `setIgnoreMouseEvents`** —— 2026-10-17 血的教训。
   *
   *   我曾经因为「隐藏后再唤出就点不动她」在这里加了一句保险：
   *       win.on('show', () => win.setIgnoreMouseEvents(true, { forward: true }));
   *   **结果它自己就是元凶**：show 之后窗口被设成"忽略鼠标"，而页面那边
   *   `wantMouse` 仍然是 `true`（它早就认为该收回了）⇒ `wantInteractive(true)`
   *   被「状态没变就别发 IPC」那道闸挡住 ⇒ **再也不发** ⇒ 窗口一直忽略鼠标。
   *
   *   真机记录（`_dsh020\verify\arm-record.cjs`，他亲手点的）证据：
   *     隐藏/显示**之前**：PTR-down ✓ WD-down ✓ CVS-down ✓ 全在
   *     隐藏/显示**之后**：只有 WD-up，**一条 down 都没有**
   *   （up 能到是因为 `forward:true` 在忽略状态下仍会转发一部分消息。）
   *   ⇒ 表现就是他说的「点不动、更拖不动」（拖动必须有 mousedown 才能起手）。
   *
   *   ⇒ **结论：穿透只有一个控制点 —— 页面那边的 `wantInteractive` / `reassertMouse`。**
   *      主进程这边别再私自改它。一改就跟页面的 `wantMouse` 失配，而且页面**不会知道**。
   *
   *   ★ 现在"光标离开窗口就打开穿透"这件事，交给 `startCursorWatch()`：
   *     它**只发事件**通知页面（`win:cursor-out`），由页面去调，控制点仍然唯一。
   */

  // 告诉 overlay「主窗口是哪一个」—— 广播要发给它一份（见文件末尾那段注释：
  // 这行曾经写在模块作用域里，那时 win 还是 null）
  overlay.attach(win);

  /*
   * ★★ 2026-10-18：show / hide 的**观测点**（只记、只通知，**一律不改穿透状态**）。
   *
   *   为什么需要（#6「隐藏后再显示，左键拖不动」查了三轮还是没定因）：
   *     · `plog` 只在探针模式写 ⇒ 他日常那次一点痕迹都没有，只能靠回忆
   *     · 页面那边**根本不知道**窗口被显示过 —— 它手里只有 `wantMouse`，
   *       一旦主进程这边（曾经）私自改过穿透，页面永远发现不了
   *
   *   ⇒ 主进程把「我被显示了」这件事**通知给页面**（`win:shown`），
   *     由**页面**决定要不要重申穿透 —— 控制点仍然唯一，铁律不破。
   *   ⚠️ 下面这两个回调里**千万不要**再去写 `setIgnoreMouseEvents`（见上面那段血泪注释）。
   */
  win.on('show', () => {
    plog(`[窗口] show（visible=${win.isVisible()} ignore=${mouse.lastIgnoreValue()}）`);
    try { win.webContents.send('win:shown'); } catch { /* 页面还没加载完就算了 */ }
  });
  win.on('hide', () => {
    plog(`[窗口] hide（ignore=${mouse.lastIgnoreValue()}）`);
  });

  const url = process.env.YACHIYO_URL;
  if (url) win.loadURL(url);
  else win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 把页面的 console 转到主进程 —— 不然页面报错一个字都看不见
  // ⚠️ Electron 44 起是对象式回调；旧的位置参数写法会刷一屏 deprecation 警告
  win.webContents.on('console-message', (e) => {
    /*
     * ⚠️ 字段名是 **`sourceId`**，不是 `file`（2026-10-16 修的）。
     *    Electron 44 的 `WebContentsConsoleMessageEventParams` 只有
     *    `{ message, level, lineNumber, sourceId, frame }` ——
     *    读 `e.file` 永远是 undefined，文件名那一栏**恒显示 `?`**，白查。
     *    它是完整 URL（`file:///D:/…/app.js`），basename 一下就够看。
     */
    const src = String(e.sourceId || '');
    const file = src ? path.basename(src.split('?')[0]) : '?';
    const line = `[renderer] ${e.message}   (${file}:${e.lineNumber})`;
    console.log(line);
    plog(line);
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    plog(`[load] 页面加载失败 ${code} ${desc} ${url}`);
  });
  win.webContents.on('render-process-gone', (_e, d) => {
    plog(`[crash] 渲染进程没了：${d.reason} (exitCode=${d.exitCode})`);
  });

  /*
   * ⚠️⚠️ 启动时**要认已保存的 `petVisible`**（2026-10-16 修的）。
   *
   *    原来是无条件 `win.show()`。于是他上次把她隐藏了、重启之后
   *    **她自己又冒出来**，而托盘菜单上写的还是「显示八千代」
   *    （托盘是按 `cfg.petVisible` 画的，跟实际相反）。
   *    点一下反而把她藏起来，**要点两下才回来**。
   */
  win.once('ready-to-show', () => {
    if (cfg.get('petVisible') === false) return;    // 他上次是藏起来的，别自己冒出来
    win.show();
  });
  win.on('closed', () => { win = null; });
}

/* ============================================================
   IPC · 配置
   ============================================================ */

/**
 * 有几项配置页面改不了 —— 窗口置顶、显示隐藏是主进程的窗口属性，
 * 托盘菜单里的勾选也要跟着同步。页面改完在这儿落地。
 */
function applyMainSideEffect(k, v) {
  switch (k) {
    case 'autostart':
      // ★ 勾上了就往注册表写一条（HKCU\...\Run），取消就删掉
      autostart.set(!!v, app.isPackaged ? '' : app.getAppPath());
      break;
    case 'alwaysOnTop':
      win?.setAlwaysOnTop(!!v, 'screen-saver');
      // ⚠️ 也要告诉 overlay —— 菜单开着的时候主窗口是**临时**不置顶的，
      //    它得知道「本来该是什么样」，菜单关掉才能恢复正确的值
      overlay.mainTopValue(!!v);
      trayMod.refresh(cfg, trayApi);
      break;
    case 'petVisible':
      if (!win) break;
      if (v) {
        win.show();
        win.setAlwaysOnTop(!!cfg.get('alwaysOnTop'), 'screen-saver');
      } else {
        win.hide();
      }
      trayMod.refresh(cfg, trayApi);
      break;
    case 'petSize':          // 画布大了窗口也得大，不然她的头会被窗口顶边裁掉
      resizeStage();
      break;
    case 'sound': case 'theme': case 'moveEnabled':
      trayMod.refresh(cfg, trayApi);   // 托盘菜单里那几项的勾选状态
      break;
  }
}

/**
 * 发给页面的配置要把密钥抹掉。
 *
 * ⚠️ 页面拿明文 Key 有两个坏处：一是页面一旦被注入什么东西（比如她哪天开始
 *    渲染外部内容）Key 就漏了；二是他截图发群里时，设置面板里的 Key 明晃晃的。
 * 页面只需要知道「配没配」—— 非空就是配了。写的时候照样能写（他手输的那次）。
 */
const SECRET_KEYS = ['apiKey'];   // ★ 2026-10-20：`screenKey` 随三格一起删了
function maskForPage(c) {
  const out = { ...c };
  for (const k of SECRET_KEYS) {
    if (out[k]) out[k] = '••••••••';
  }
  return out;
}

/**
 * 配置写完以后，**把变化推回页面**。
 *
 * ⚠️ 之前漏了这一步，只有托盘那条路（trayApi.set）会推，IPC 这条路不推 ——
 *    结果是「页面自己改的能生效，别人改的页面不知道」：
 *      · 从设置面板改 → 页面自己先 `CFG[k]=v; apply(k)` 了，看着正常
 *      · 从托盘改     → 走 trayApi.set，推了，也正常
 *      · 从**任何其它地方**改（探针脚本、将来的心跳 / 自动开关）→ 主进程
 *        老老实实写盘了，页面还拿着旧值，**而且不报错**
 *    我就是拿探针改 petSize 想验锯齿，量到画布永远 576×576 才发现这条断的。
 *
 * ⚠️ apiKey 必须走 maskForPage —— 明文 Key 不能过桥进渲染进程。
 */
function broadcastCfg(keys) {
  const masked = maskForPage(cfg.all());
  // ⚠️ 要发给**所有**窗口（主窗口 + 菜单 + 面板 + 聊天窗）。
  //    只发给主窗口的话，会出现「在面板里切了深色，菜单还是浅色」这种对不上。
  for (const k of keys) overlay.broadcast('cfg:changed', { key: k, value: masked[k] });
}

/* ============================================================
   IPC · 浮层
   ============================================================ */

/**
 * 开一个浮层。
 *
 * ⚠️ `state.at` 是**发起方窗口内**的坐标（鼠标事件给的就是这个）。
 *    要换成屏幕坐标才能拿去摆窗口 —— 主窗口现在只是屏幕底部一条带，
 *    它的 (0,0) 在屏幕中下部，直接把窗口内坐标当屏幕坐标用，
 *    菜单会弹到屏幕上边去。
 */
ipcMain.handle('ov:open', (e, kind, state = {}) => {
  const from = BrowserWindow.fromWebContents(e.sender);
  let at = null;

  if (state.at && from && !from.isDestroyed()) {
    const b = from.getBounds();
    const d = screen.getDisplayNearestPoint({ x: b.x + state.at.x, y: b.y + state.at.y });
    // 贴着鼠标弹，但保证不越过工作区边界（overlay.placeAt 里还会再夹一次）
    at = { x: b.x + state.at.x, y: b.y + state.at.y };
    void d;
  }

  overlay.open(kind, { at, state });
  return true;
});

/** 按名字关一个（主窗口点她的时候收掉菜单） */
/** 浮层自己量好内容高，叫主进程把窗口收一收 */
ipcMain.on('ov:fit', (e, h) => {
  const from = BrowserWindow.fromWebContents(e.sender);
  for (const [kind, w] of overlay.list()) if (w === from) { overlay.fit(kind, h); return; }
});

ipcMain.on('ov:close-kind', (_e, kind) => {
  if (typeof kind === 'string') overlay.close(kind);
});

/**
 * 界面调试台：临时把面板窗口放大一点（底下要压一条参数栏）。
 * 详见 overlay.cjs 的 designMode —— 只放大不缩小、退出精确还原。
 */
ipcMain.on('ov:design', (_e, on) => { overlay.designMode(!!on); });

/**
 * ★★ 界面调试台 —— **改了就即时生效**（他 2026-10-13 要的）。
 *
 * 存在 `%APPDATA%\Yachiyo\design.json`，运行时覆盖源码里的默认值：
 *   结构（CSS 变量）/ 文字（各处的文案）/ 分组移动（哪个组摆在哪一页）
 *
 * ⚠️ 为什么不是「导出 JSON 交给辉夜改代码」：那是原来那套 ——
 *    他每改一个数都要等一轮。这个文件只是**覆盖**，源码一个字不动，
 *    所以他随时能「清除覆盖」一键回到出厂，我也可以随时把这些值合并回源码。
 *
 * ⚠️ 写盘是**防抖**的（页面那边 400ms），不然拖滑块会一路把磁盘刷爆。
 * ⚠️ 读失败（文件不存在 / JSON 坏了）一律当"没有覆盖" —— 绝不能因为
 *    一个坏文件把设置面板整个打不开。
 */
const DESIGN_FILE = () => path.join(cfg.DIR, 'design.json');

function readDesign() {
  try {
    const raw = fs.readFileSync(DESIGN_FILE(), 'utf8');
    const j = JSON.parse(raw);
    return (j && typeof j === 'object') ? j : null;
  } catch { return null; }
}

function writeDesign(data) {
  try {
    const dir = path.dirname(DESIGN_FILE());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DESIGN_FILE(), JSON.stringify(data, null, 2), 'utf8');
    return { ok: true, file: DESIGN_FILE(), bytes: Buffer.byteLength(JSON.stringify(data)) };
  } catch (err) {
    plog('[调试台] 存 design.json 失败：' + err.message);
    return { ok: false, why: err.message };
  }
}

/*
 * ⚠️⚠️ 调试台这一族 IPC 口**只在开发版注册**（2026-10-16 补的）。
 *
 *    它们是 2026-10-13 做调试台那批加的，当时**漏了这道闸** ——
 *    打包版里也注册着，而 preload 那边同样照样暴露
 *    （`designLoad/Put/Clear/Where/Save` 原来摆在 DEV 块**外面**）。
 *
 *    `design:put` 是个**写文件的通道**，产品流程一次都不调它
 *    （调试台在正式版压根不该出现）。跟 `probe:sleep` 那几个一个道理，套上闸。
 */
function designClear() {
  plog('[调试台] design:clear —— 覆盖文件被清掉了（「全部还原」走这条）');
  try { fs.rmSync(DESIGN_FILE(), { force: true }); } catch { /* 本来就没有 */ }
  return { ok: true };
}

/* 调试台那四个口子（design:load / put / clear / save）2026-10-21 搬到 ./probe.cjs */

/**
 * 界面调试台「保存成文件」—— 存到桌面，存完**在资源管理器里高亮它**。
 *
 * ⚠️⚠️ 为什么非要有这一条（他 2026-10-13 报「没找到 JSON 放在哪了」）：
 *    原来只有一个「导出 JSON」按钮，走 `navigator.clipboard.writeText` +
 *    `console.log`。问题是：
 *      · 剪贴板失败**不报错**（file:// 下可能被静默拒），我却在界面上
 *        先弹了「已复制到剪贴板」—— **假成功**，他 Ctrl+V 出来是空的；
 *      · 就算成功，他也**看不到内容**、更没法存成文件。
 *    ⇒ 现在点了直接落盘 + 弹资源管理器，文件在哪一目了然。
 *
 * ⚠️ 走 `dialog.showSaveDialog` 而不是硬写死路径 —— 他可能想存到别处。
 *    默认文件名带时间戳，连着导几次不会互相覆盖。
 */
async function designSave(_e, text) {
  const s = String(text == null ? '' : text);
  if (!s) return { ok: false, why: '没有内容' };
  const stamp = (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  })();
  try {
    const r = await dialog.showSaveDialog({
      title: '保存调试台的导出',
      defaultPath: path.join(app.getPath('desktop'), `八千代-界面调试-${stamp}.json`),
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (r.canceled || !r.filePath) return { ok: false, why: '取消了' };
    fs.writeFileSync(r.filePath, s, 'utf8');
    // 存完把它在资源管理器里点亮 —— 不然他还是得自己去找
    try { shell.showItemInFolder(r.filePath); } catch { /* 亮不了就算了，文件已经存下 */ }
    return { ok: true, file: r.filePath, bytes: Buffer.byteLength(s) };
  } catch (err) {
    plog('[调试台] 保存失败：' + err.message);
    return { ok: false, why: err.message };
  }
}

// ⚠️ 同样只在开发版注册 —— 见上面 design:load 那一族的注释

/**
 * ★ **只给探针用**：把「准备睡」掰过去 / 回来。
 *
 * 为什么需要（真机实测卡在这儿）：真实进睡的条件是「键鼠停够 55 分钟」——
 *   等不起；本机又没有可靠的办法伪造"用户活动"
 *   （`SetThreadExecutionState` / `SendKeys` 实测都重置不了系统空闲计时器）。
 *   要验证「睡着了到底还冒不冒气泡」这件事，只能有个直接拨开关的口子。
 *
 * ⚠️ 产品流程一次都不调它 —— 真实进出走心跳里的 `review.tick()`。
 *    跟 `ov:probe-raise` 是同一类东西：**为了不改产品代码就能量到真实行为**。
 */
/* probe:sleep（把"准备睡"掰过去）2026-10-21 搬到 ./probe.cjs */

/**
 * ★ **只给探针用**：把浮层往上顶一层，或者按 hwnd 插到某个窗口后面。
 *
 * 存在的原因：`setAlwaysOnTop(false)` 在 Windows 上会把窗口从"置顶带"
 * 挪到"不置顶带"，而**插进去的位置不是我们说了算的**（实测被排到了菜单前面）。
 * 候选改法有几种（`moveTop()` / `setAlwaysOnTop(true→false)` / `insertAfter(hwnd)`），
 * 到底哪种能把菜单摆在她前面，**只能真量**。
 * 探针要对比这几种，而产品代码里还一种都没落地 —— 所以开这个临时口子，
 * 免得为了量一次就先改产品代码（那就成了"改完了再验自己改得对"）。
 */
/**
 * ★★ 「她说过的每一句话，都记一笔」—— **唯一**的写入点。
 *
 * 为什么非要有这一步：`memory.buildSpokenBlock()` 那块
 * 「你最近自己说过的话」一直在提示词里，但**从来没人往里面写** ——
 * `memory.addSpoken` 写好了、导出了、一次都没被调用过。
 * 结果：那块永远是空的 → 她**没有任何依据知道自己刚才说过什么**
 * → 同一句话反复说（旧工程实测过「你 X 分钟没挪窝了」一小时说 8 遍）。
 *
 * ⚠️ 旧工程这里是 `Add-AiSaid`（她说每句话的唯一出口，副产物就是记下来）。
 *    新工程没有那个函数 —— 所以补这个等价物，并且：
 *    **以后新增任何"她开口"的链，都要从这儿走**，不然那条链的复读又没人管。
 *
 * ⚠️ 记的是**剥过标记的成品**（`brain.reply` 里已经剥完了），
 *    不是模型吐的原文 —— 原文里那些 `[心情 好]` 不该进她的"说过什么"。
 */
function recordSaid(text, kind) {
  const k = kind || '主动';
  try { memory.addSpoken(k, text); }
  catch (err) { console.error('[说] 记「我说过什么」失败：' + err.message); }

  /*
   * ★★ 她**主动说的**话也要进「对话流」（2026-10-17 他选的方案 A）。
   *
   *   他报的现象：「识屏后说的话和自言自语**不会同步进聊天框**」。
   *   病根是**两本账**：
   *     · 这本 `memory.addSpoken` = 「我说过什么」（防复读用）
   *     · 聊天窗拉历史用的是 `memory.recent()` = **对话流**
   *   ⇒ 识屏/自言语的话只进了前一本 ⇒ **聊天窗重开、看聊天记录时一个字都看不到**
   *     （当场能看到，是因为 `speak:say` 那条事件会让聊天窗追加一句）。
   *
   *   ⚠️⚠️ `对话` / `快速问答` 这两类**绝对不能**再 push ——
   *      `brain.reply` 自己已经 push 过 assistant 了（见 `brain.cjs:126`），
   *      这里再记一次，聊天记录里每条都会变两条。
   *      这两类也正好是"走 brain 的"，所以按 kind 分流最省事、也不用改调用点。
   *
   *   ⚠️ 带了 `{ kind }` 一起存 —— 以后要在聊天窗里给它们配个不一样的样式，
   *      或者过滤掉，都还有依据（不然就是糊成一片普通对话）。
   */
  if (k !== '对话' && k !== '快速问答') {
    try { memory.push('assistant', text, { kind: k }); }
    catch (err) { console.error('[说] 记进对话流失败：' + err.message); }
  }
}

/**
 * 在资源管理器里打开一个**我们自己的目录**（备份文件夹 / 配置文件夹）。
 *
 * ⚠️ 只允许打开「cfg.DIR 底下」的目录 —— 渲染层要是被 XSS 了，
 *    `shell.openPath` 能打开任意路径，那等于把整台机器的文件系统递出去。
 *    这道闸很便宜，加上。
 */
ipcMain.handle('app:reveal', async (_e, kind) => {
  const key = String(kind);
  const targets = {
    backup: backup.root(),
    config: cfg.DIR,
    data: cfg.DATA,
    logs: path.join(cfg.DIR, 'logs'),
  };
  const dir = targets[key];
  if (!dir) return { ok: false, why: '不认识的目录' };

  const full = path.resolve(dir);

  /*
   * ⚠️⚠️ 「在不在允许范围内」分两种判据（2026-10-16 定的口径）。
   *
   *   · **backup 是他在设置面板里自己配的目录** —— `backup.root()` 明确支持
   *     绝对路径（它自己的注释就写着 `D:\Yachiyo备份`「他想挪到别的盘就挪」）。
   *     所以这一项**不按 cfg.DIR 判**。以前一律按 cfg.DIR 判，
   *     备份一挪到别的盘，面板上那颗「打开备份文件夹」就直接报「越界了」。
   *   · 其余三项是我们自己的目录，仍然只允许 cfg.DIR 底下，而且前缀
   *     **必须带分隔符** —— 裸 `startsWith` 会把 `…\Yachiyo-别的东西` 也放行。
   *
   * ⚠️ 这条闸**能挡什么、挡不住什么**，说清楚，免得自己骗自己：
   *
   *   它挡的是「渲染层随手传个路径过来」—— `kind` 是白名单，
   *   真正打开的目录**全由主进程自己算**，渲染层够不着。
   *   （原来 backup 那一支写的是 `full === path.resolve(backup.root())` ——
   *    可 `full` 本来就是从 `backup.root()` 来的，**恒真**，等于没判。）
   *
   *   它**挡不住**「先改 `backupDir` 成任意绝对路径、再 reveal」——
   *   但那个口子在 `cfg:set`（任何配置键都能改）上，在这儿多拦一道是自欺欺人。
   *   真要紧的是 `shell.openPath` **只开目录、不执行**，所以这条风险本来就低。
   */
  const inCfgDir = full === path.resolve(cfg.DIR)
    || full.startsWith(path.resolve(cfg.DIR) + path.sep);
  if (key !== 'backup' && !inCfgDir) return { ok: false, why: '越界了' };

  try {
    fs.mkdirSync(full, { recursive: true });     // 还没备过的时候目录可能不存在
  } catch (err) {
    return { ok: false, why: err.message };
  }

  /*
   * ⚠️⚠️ `shell.openPath` 是**异步**的，返回一个字符串：
   *    空串 = 打开了；非空 = 错误信息。**打不开的时候它不抛异常**。
   *    原来没 await、接着就 `return { ok: true }` —— 系统没打开也报成功，
   *    他那边看到的是「点了按钮、界面说成功了，可资源管理器压根没出来」。
   */
  const why = await shell.openPath(full).catch((e) => e.message);
  if (why) return { ok: false, why };
  return { ok: true, dir: full };
});

/* ov:probe-raise（浮层上下顶）2026-10-21 搬到 ./probe.cjs */

/**
 * ★ **只给探针用**：记下每一次浮层窗口被挪/被改尺寸。
 *
 * 「菜单闪两下」查了两轮都没抓住 —— 因为**截图量不到**：
 *    CDP 的 `Page.captureScreenshot` 是跟渲染帧对齐的，开窗那几十毫秒里
 *    能截到的帧全是同一张（实测 25 帧一个样），而他的眼睛看得见。
 *    ⇒ 换个量法：**闪 = 窗口动了一次**。把每一次 `setBounds` 记下来，
 *      就能直接指出"第几次、从什么变成什么"，这比猜强。
 *
 * ⚠️ 只在**探针调过一次之后**才记，平时零开销。
 */
const probeBoundsLog = new Map();          // kind -> [{t, from, to}]
/* ov:probe-bounds（量 setBounds 的抖动）2026-10-21 搬到 ./probe.cjs */

/**
 * 某个浮层现在开着没有。
 *
 * ⚠️ 以前页面里 `document.getElementById('panel').classList.contains('open')`
 *    就能问出来 —— 那会儿面板就长在主窗口的 DOM 里。
 *    拆成独立窗口之后主窗口根本看不见它（另见 preload 的 on 白名单那套），
 *    只有主进程知道。自检和主窗口都需要这个答案。
 */
ipcMain.handle('ov:is-open', (_e, kind) => overlay.isOpen(kind));

/**
 * 某个浮层的真实窗口状态。
 *
 * ⚠️ 跟 `ov:is-open` 分开是因为那个的返回值被自检当**布尔**用了，
 *    往对象上改会把所有老断言悄悄变成「真」（对象永远 truthy）—— 假通过。
 *    这个新开一条，给自检量「菜单到底置没置顶」用。
 */
ipcMain.handle('ov:info', (_e, kind) => {
  const w = overlay.list().get(kind);
  if (!w || w.isDestroyed()) return { exists: false };
  return {
    exists: true,
    open: w.isVisible(),
    topmost: w.isAlwaysOnTop(),
    bounds: w.getBounds(),
  };
});

/** 浮层关自己 */
ipcMain.on('ov:close', (e) => {
  const from = BrowserWindow.fromWebContents(e.sender);
  for (const [kind, w] of overlay.list()) {
    if (w === from) { overlay.close(kind); return; }
  }
});

ipcMain.handle('cfg:all', () => maskForPage(cfg.all()));
ipcMain.handle('cfg:set', (_e, k, v) => {
  cfg.set(k, v);
  applyMainSideEffect(k, v);
  broadcastCfg([k]);
  return k === 'apiKey' ? maskForPage({ apiKey: v }).apiKey : v;
});
ipcMain.handle('cfg:patch', (_e, obj) => {
  cfg.patch(obj);
  const keys = Object.keys(obj || {});
  for (const k of keys) applyMainSideEffect(k, obj[k]);
  broadcastCfg(keys);
  return maskForPage(cfg.all());
});
ipcMain.handle('cfg:reset', () => {
  const fresh = cfg.reset();
  const keys = Object.keys(fresh);
  for (const k of keys) applyMainSideEffect(k, fresh[k]);
  broadcastCfg(keys);
  return maskForPage(fresh);
});
ipcMain.handle('cfg:dir',   () => cfg.DIR);

/* ============================================================
   IPC · 窗口
   ============================================================ */

/*
 * ★ 穿透状态变了就记一行（2026-10-17 加的，**为了逮那个"显示后点不动"**）。
 *
 *   ⚠️ 必须**去重**：页面那边每 500ms 无条件重申一次（`reassertMouse`），
 *      不去重的话 `_probe.log` 一天能涨十几万行。
 *   ⚠️ 只记"变了"的那一下，所以他下次复现的时候，这份日志能直接告诉我们：
 *      显示之后穿透到底**有没有被收回来**（`收回` 那条就是"能点着了"）。
 *
 * ★★ 2026-10-18 补：光有"变了才记"**不够诊断**（#6 复现不出来就是证据不足）。
 *    又加了两个抓手，都只读、不影响行为：
 *      ① `lastIgnore` —— 主进程这边**最后一次真的设下去的值**（`win:state` 里报出去）
 *      ② `ignoreLog` —— 最近 20 次 IPC 的**原始流水**（含时间戳、不去重）
 *         ⇒ 分辨「页面根本没发」和「发了但没生效」靠的就是这一份
 */
/* win:ignore-mouse 2026-10-18 拆到 ./mouse.cjs 了（含 lastIgnore / ignoreLog 记账） */
mouse.attach({
  getWin: () => win,
  plog,
  screen,
  probeRoot: PROBE_ROOT,
  probeMs: PROBE_MS,
  sysIdleSeconds: () => (heartbeat.idleMinutes() >= 0 ? heartbeat.idleMinutes() * 60 : null),
});
mouse.register(ipcMain);

/*
 * ★ 他碰她了 → 把她从「准备睡」里叫醒（2026-10-17 加的）。
 *
 *   他报的 #4 后来确认了：**她当时是睡着状态**。那状态有**两层**：
 *     · 视觉那层（rig 的 sleep 姿态）—— 批次 B 的 `wakeUp()` 管了
 *     · **气泡那层**（下面 review 的「准备睡」）—— `ui/bubble.js` 里
 *       「睡着了一个气泡都不冒」闸的就是它
 *   第二层不解决，点她还是"看着一点反应都没有"（人坐起来了，但不吭声）。
 *
 *   ⚠️ `review.wake()` **本来就有**（注释写着「被叫醒，退出准备睡」）——
 *      只是**全工程没有人调它**。这里就是把它接上，不是新造一个。
 *   ⚠️ 顺带把聊天那道闸也解了：`chat:send` 里 `if (review.isSleeping())` 会直接回
 *      「她睡了」，于是「打开聊天窗想跟她说话」也会被挡（同一个根因）。
 */
ipcMain.on('pet:wake', () => {
  try {
    const was = review.isSleeping();
    review.wake();
    if (was !== review.isSleeping()) overlay.broadcast('sleep:changed', review.isSleeping());
  } catch { /* 叫不醒也不能影响他点她 */ }
});

ipcMain.on('win:focus', () => {
  if (!win) return;
  win.show();
  win.setAlwaysOnTop(!!cfg.get('alwaysOnTop'), 'screen-saver');
});

/**
 * 收 / 放键盘焦点。
 *
 * 窗口平时是 focusable:false 的 —— 她不该抢走你在打游戏时的按键。
 * 但设置面板里有输入框（API Key、城市），focusable:false 下手都进不去，
 * 一个字都打不出来。所以面板开的时候临时放开，关掉立刻收回去。
 * ⚠️ 顺序不能反：focusable 还是 false 的时候调 focus() 是空操作。
 */
ipcMain.on('win:focusable', (_e, on) => {
  if (!win) return;
  win.setFocusable(!!on);
  if (on) win.focus();
  else win.blur();
});

ipcMain.on('win:hide', () => { if (win) { win.hide(); cfg.set('petVisible', false); trayMod.refresh(cfg, trayApi); } });

/*
 * ★ 只给探针用：走**托盘那条路**显示/隐藏（2026-10-17 加的）。
 *
 *   他报的：「托盘右键菜单的**显示/隐藏桌宠**，隐藏后再显示就点不动她了；
 *   但**右键点她仍然可以唤出菜单**」。
 *   ⚠️ `trayApi.toggleShow()` 跟 `cfg:set('petVisible')` 那条**不是同一段代码** ——
 *      托盘这条是 `win.show()` + `setAlwaysOnTop(...)` 两句。要复现就得走他那条。
 *   ⚠️ devOnly：正式版里这个 handler 不存在，页面那边 invoke 会 reject（无害）。
 */
/* probe:tray-toggle + probe:game 2026-10-21 搬到 ./probe.cjs */

/*
 * ★ 只给探针用：**假装**进了/退了游戏，把 `game:changed` 广播一次。
 *
 *   为什么要这个口子：真实触发要么真开一个全屏游戏（做不到），
 *   要么等他自己去打（等不起）。而这一条要验的是**页面那半**——
 *   "收到广播之后她是不是真的坐下了、并且钉住不走"。
 *   ⚠️ 判定逻辑本身（全屏 + 进程）由 `selfcheck-gamedetect` 的 25 项钉着，不靠这个。
 */
ipcMain.on('win:open-settings', () => win?.webContents.send('tray:open-settings'));
ipcMain.handle('win:screen', () => {
  const d = screen.getPrimaryDisplay();
  return {
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
    displays: screen.getAllDisplays().length,
    // ⚠️ 渲染层算「她踩在哪」必须知道**窗口**多大 —— 窗口现在只是底部的一条
    //    带，不再是整个工作区。拿 workArea 当窗口高的话，位置会整体偏上去。
    stage: placeWindow(),
  };
});

/** 渲染层改完大小叫这一声 —— 窗口跟着画布一起变 */
ipcMain.handle('win:setStage', () => resizeStage());

/* ============================================================
   IPC · 对话
   ============================================================ */

/** 正在回的那一轮 —— 他能连发，但不能同时开两条 */
let busy = null;

/* ============================================================
   自动学习（后台跑，不挡她说话）
   ============================================================ */

let learning = false;

/**
 * 攒够轮数就后台学一次 —— 从最近的聊天里提炼「习惯 / 梗」。
 *
 * ⚠️ 三条纪律：
 *   ① **不 await、不阻塞** —— 学习要调模型，几秒到几十秒；
 *      让他为了「学一次」干等，是不划算的。
 *   ② **同时只跑一个** —— 上一轮还没学完又开始下一轮，两边会拿
 *      同一份聊天重复提炼，学出一堆重复条目。
 *   ③ **失败只记日志** —— 学习挂了不该影响她说话。
 */
/**
 * 该学就学一次。
 *
 * @param {boolean} [onClose] 这是**退出前最后一次**（走 `autoLearnOnClose` 那条）。
 *   ⚠️ 退出那次**不能**走 `learn.tick()` —— 那个每叫一次就把轮次 +1，
 *      而他退出的时候可能只聊了 3 轮。那 3 轮不等于"该学了"，
 *      但**也不该白攒着**：退出是个天然的分界点，把没提炼的补上。
 *      所以退出这条路用 `learn.due()` 判（攒够了才学），不涨轮次。
 */
function maybeLearn(onClose) {
  if (learning) return;
  if (onClose ? !learn.due() : !learn.tick()) return;

  const c = cfg.all();
  if (!c.apiKey) return;

  learning = true;
  learn.run({ chat: provider.chat, cfg: c })
    .then((r) => plog(`[learn] ${r.ok ? `学到 ${r.learned} 条（写库 ${r.wrote} · 待确认 ${r.pending}）` : r.why}`))
    .catch((err) => plog('[learn] 出错：' + err.message))
    .finally(() => { learning = false; });
}

/**
 * 退出时落三件事。**必须同步写完再退。**
 *
 * ⚠️ 不能写成异步（Promise / setTimeout）—— 进程可能在写盘之前就没了，
 *    跨会话记忆直接丢。这里全程 `writeFileSync`，写完才返回。
 */
let exited = false;
function saveOnExit() {
  if (exited) return;
  exited = true;
  try { memory.saveSession(); }   catch (err) { plog('[exit] 跨会话没存上：' + err.message); }
  try { memory.saveLastExit(); }  catch (err) { plog('[exit] 退出时刻没存上：' + err.message); }
  try { habits.flushHits(); }     catch { /* 命中记录落不落盘无所谓 */ }

  /*
   * ★ 「收窗时也学一次」（）。
   *   ⚠️ 这个键原来**一次都没被读过** —— 默认 true，关掉行为一点不变。
   *   ⚠️ 学习要发请求，这里**没法同步等** —— 只能 fire-and-forget。
   *      它的写盘是异步的，所以**不保证**退出前一定写完。
   *      想真保证得让 `softExit` 等它（旧工程就是"等学习跑完，最多 30 秒"）——
   *      那是下一步的事，先把它接上、别让它是个假旋钮。
   *   ⚠️ 判据用 `learn.due()` 不是 `learn.tick()` —— 退出不该涨轮次（见 maybeLearn）。
   */
  try {
    if (cfg.get('autoLearnOnClose') !== false) maybeLearn(true);
  } catch { /* 学习挂了不该拦住她退出 */ }
}

/**
 * 说话**之前**要办的两件事：问到天气就现查一次、问到新鲜事就先联网。
 * 返回 `onDelta`（边收边推那个回调）。
 *
 * ⚠️ 为什么单独拎出来（2026-10-14）：
 *    这两段原来直接摊在 `runChat` 里，位置是 `busy = ctl` **之后**、
 *    主 try **之前** —— 抛了就绕过 finally，`busy` 永远清不掉。
 *    挪出来、调用点放进 try 里面，才不会「炸一次就再也说不了话」。
 *
 * @param {string} msg 他说的那句（已 trim）
 * @param {{delta:string, done:string, fail:string}} ev 三个事件名
 * @returns {Promise<(t:string)=>void>}
 */
async function preflight(msg, ev, signal = null) {
  // 边收边推 —— 不然要干等到整段生成完才出字
  const onDelta = (t) => overlay.broadcast(ev.delta, t);

  /*
   * ★★ 2026-10-21 修（外部审查 YCH-010）：
   *
   *    原来这段 preflight 完全**不受「停止」控制** —— `chat:abort` 只 abort
   *    `provider.chat`，而这里查天气（5 秒）/ 联网（最长 20 秒）照等不误。
   *    他点了停止，界面还挂在那儿，看着像按钮坏了；而且这段时间她还会
   *    真花掉一次联网请求。
   *
   *    ⇒ ① 把 runChat 那个 `ctl.signal` 传进来（`signal`）；
   *      ② 每走一步之前先看一眼 aborted，已经停了就一步都别再发起；
   *      ③ 把 signal 传进 weather / websearch 里每个 fetch（那两边各自接住了）。
   */
  const stopped = () => !!(signal && signal.aborted);

  /*
   * ★ 他这句话在问天气 → **现查一次**（旧工程 Invoke-AiWeatherRefreshNow 那套）。
   *
   * ⚠️ 为什么不在提示词总装里查：那是「她说每一句话之前都要跑」的地方，
   *    放那儿等于每句话都同步上网，网络一抖她整个人卡住（旧工程的老毛病 O07）。
   *    这里只在**他自己问到天气**时才等这一下，而且给 5 秒硬上限 ——
   *    查不动就不查了，用缓存那份，不能因为天气把他这句话卡死。
   */
  if (!stopped() && weather.isAsking(msg)) {
    try {
      /*
       * ⚠️⚠️ **不要传 `force: true`**（2026-10-16 修的）。
       *
       *    `force` 在 `fetchWeather` 里是**同时跳过缓存和退避**的 ——
       *    而这里原来写死了 force:true ⇒ 他每提一次天气就真联网一次。
       *    那条链的调用方只有两处，另一处是设置面板的「查一下」按钮
       *    （那个**该**强制，是他手点的）—— 也就是说**自动那条路一直是强制的**。
       *
       *    而 `weather.cjs` 文件头写着「缓存不能删，因为它是**防限流**的」。
       *    现在按正常口径来：新鲜就用缓存，过点了才真去查。
       *    5 秒硬上限照样留着（查不动就不等了）。
       */
      const r = await Promise.race([
        weather.fetchWeather({ signal }),
        new Promise((res) => setTimeout(() => res({ ok: false, why: '查得太慢，先不等了' }), 5000)),
      ]);
      plog('[weather] 他问到天气 → 查：' + (r.ok ? (r.cached ? '用缓存' : '拿到新的') : ('没查到 · ' + r.why)));
    } catch (err) {
      plog('[weather] 现查失败：' + err.message);
    }
  }

  /*
   * ★ 联网：他这句要是明显在问"新鲜事" → **先查好再让她答**。
   *
   * ⚠️ 顺序不能反。查到的东西要进**这一轮**的系统提示词
   *    （`websearch.buildBlock()` 在 `prompt.buildSystem` 里），
   *    查晚了就只能下一轮才用得上 —— 而他问的正是这一轮。
   *
   * ⚠️ 查不到就**默默继续**（她会说"我查不到"），别把整句卡住。
   *    这条链只该是"加分项"，不该是"她能不能回话的前提"。
   * ⚠️ 只在**主对话**这条链查（快速问答也查，它俩共用 runChat）；
   *    自言语 / 回顾那些链不查 —— 那些是她在自言自语，不是他问的。
   */
  if (!stopped() && websearch.shouldSearch(msg)) {
    /*
     * ⚠️ **先冒一句**。
     *    查一次要 4~9 秒（实测 8146ms，服务端搜了 4 次），
     *    这期间她那边**一点动静都没有** —— 看着像卡死了。
     *    先推一句短的，等真答案回来照常覆盖掉（`bubble:delta` 是累加的，
     *    但 `brain.reply` 一开始会重置缓冲，所以这句不会残留）。
     */
    overlay.broadcast(ev.delta, '我查一下…');
    const w = await websearch.search(msg, { signal }).catch((e) => ({ ok: false, why: e.message }));
    plog(`[联网] ${w.ok ? `查到 ${w.answer.length} 字（服务端搜了 ${w.uses} 次）` : '没查到：' + w.why}`);
  }

  return onDelta;
}

/**
 * 问一句、把回答流式推出去 —— 两个入口共用这一份。
 *
 * ⚠️⚠️ 别退回去用 `win.webContents.send(...)`。
 *    聊天窗拆成独立的 chat.html 之后，流只发给主窗口的话就送到没人看的地方去了：
 *    主窗口里没有聊天 DOM（收了也是空转），聊天窗里那条气泡**永远是空的**，
 *    而且不报错、`send` 还老老实实返回 ok —— 假成功。踩过一次。
 *
 * @param {string} text
 * @param {{delta:string, done:string, fail:string}} ev 三个事件名
 *        （聊天窗走 chat:*，快速问一句走 bubble:*）
 *        ⚠️ 2026-10-17：「快速问一句」那个入口（双击弹的输入条）**删了**
 *        —— 双击现在直接开聊天窗。所以 `bubble:*` 这条通道**暂时没有调用方**，
 *        留着备用（`chat:send-quick` 那条 IPC 也还在 preload 里）。
 */
async function runChat(text, ev) {
  /*
   * ⚠️⚠️ 这三条**早退**都带 `early: true`（2026-10-16 加的）。
   *
   *    它们**只 return、不广播 `ev.fail`** —— 聊天窗那条路自己会把
   *    `r.ok === false` 显示成一行提示，所以以前没露馅。
   *    可双击快问（ask.html）是「按下回车立刻收窗、不 await」的，
   *    于是他一按回车：框没了、气泡也没有，**什么都不知道**
   *    （没填 Key、上一句还没说完，都会这样）。
   *
   *    ⇒ 打上标记，让 `chat:send-quick` 那边知道"这条得替他广播一次"。
   *      （真·出错那条路已经自己广播过了，不能再补一次，否则气泡报两遍。）
   */
  const msg = String(text || '').trim();
  if (!msg) return { ok: false, error: '空的', early: true };

  /*
   * ⚠️ **他一开口就通知自言语让路**（2026-10-17 接上的，清单 #42）。
   *    这个函数一直存在、注释也写着「他说话了 —— 自言语让一让」，
   *    可**全仓没有任何地方调它** ⇒ 自言语不知道他刚开口，
   *    照样在他这句还没答完时插嘴，两边的话在同一个气泡里交错。
   *    ⚠️ 位置：确认"有内容"之后、别的早退**之前** —— 他说了就是说了，
   *      哪怕这一句因为正忙没发出去，那份"让路"也该生效。
   */
  selftalk.noteUserSpoke(msg);

  if (busy) return { ok: false, error: '上一句还没说完，等一下下', early: true };

  const gate = brain.ready();
  if (!gate.ok) return { ok: false, error: gate.why, needKey: true, early: true };

  const ctl = new AbortController();
  busy = ctl;

  /*
   * ⚠️⚠️ 从这儿到函数结尾，**放锁只有下面那一个 finally**（2026-10-14 修的）。
   *
   *    原来「说话前那两件事」（天气 / 联网）摊在 `busy = ctl` 之后、
   *    主 try **之前** —— 它们要是抛了（`overlay.broadcast` / `plog` 都够呛），
   *    就绕过了 finally，`busy` 永远清不掉 ⇒ **她再也不能回话，只能重启**。
   *    现在那两件事在 `preflight()` 里、调用点在 try 里面，怎么炸都会放锁。
   */
  try {
    /*
     * ★ 2026-10-21（YCH-010）：把 `ctl.signal` 一起传进去 —— preflight 里
     *   查天气 / 联网要真能被打断（原来只在这儿补判一次，等于等它自己跑完）。
     */
    const onDelta = await preflight(msg, ev, ctl.signal);

    /*
     * ⚠️ 补判一次：preflight 里那几步都 `.catch` 吞掉异常了，所以「已取消」
     *    不会自己抛到这儿；必须在这儿看一眼，否则她照样会接着往下发模型请求。
     */
    if (ctl.signal.aborted) throw Object.assign(new Error('取消了'), { hard: true });

    const out = await brain.reply(msg, { onDelta, signal: ctl.signal });
    overlay.broadcast(ev.done, {
      text: out.text, cost: out.cost, ms: out.ms, firstMs: out.firstMs,
      usage: usage.all(),
    });
    plog(`[chat] 回完了 · ${out.ms}ms（首字 ${out.firstMs ?? '?'}ms）· ¥${out.cost.toFixed(5)}`);
    /*
     * ★ 记下她刚说的这句（见 `recordSaid` 的注释）。
     * ⚠️ 放在**判成功之后** —— 出错那条路 `brain.reply` 已经把"他说的话"
     *    撤回去了，她没说话，自然也不该记。
     */
    recordSaid(out.text, ev.delta === 'bubble:delta' ? '快速问答' : '对话');
    maybeLearn();     // 攒够轮数就后台学一次，不等它
    return { ok: true, text: out.text, cost: out.cost, ms: out.ms };
  } catch (err) {
    overlay.broadcast(ev.fail, err.message);
    plog('[chat] 出错：' + err.message);
    return { ok: false, error: err.message };
  } finally {
    /*
     * ⚠️⚠️ **只放自己那把锁**（2026-10-14 修的）。无条件 `busy = null` 会出这种交错：
     *
     *   ① 他说 A        → busy = A
     *   ② 他点「停止」   → 旧代码在这里就 busy = null 了
     *   ③ 他马上说 B     → busy = B（闸门放行，因为已经被清空）
     *   ④ A 那边回来收尾 → 无条件 busy = null ⇒ **B 的锁被 A 清掉**
     *   ⑤ 他再说 C       → 本该被「上一句还没说完」挡住，实际**放行了** ⇒ 两条请求并发
     *   ⑥ 他再点「停止」 → abort 打到 C 上，**B 取消不掉了**
     *
     *    照抄那三行做的逻辑复现见 `留痕\工具脚本\repro-busy-race.cjs`。
     *
     *    配上 `chat:abort` 那边**不再提前清空**（它也改成只 abort），
     *    这把锁就从头到尾只由「它自己的发起者」释放。
     */
    if (busy === ctl) busy = null;
  }
}

/** 聊天窗那条路 —— 回答进聊天列表 */
ipcMain.handle('chat:send', (_e, text) => runChat(text, {
  delta: 'chat:delta', done: 'chat:done', fail: 'chat:error',
}));

/**
 * 双击她那条路 —— 回答冒在头顶的气泡上，聊天窗一个字都不进。
 *
 * ⚠️⚠️ 这条路**绕过了 `sayIt`**（它自己发 bubble:*，不走 speak:say），
 *    所以「准备睡」那道闸管不到它，得在这儿单独挡一次
 *    —— 他 2026-10-13 说的「睡着状态不会有任何气泡弹出」。
 *    挡在入口而不是 runChat 里：runChat 是聊天窗共用的，
 *    **他主动打开聊天窗打字时不该被挡**（那是显式交互，不是她"自己冒泡"）。
 */
ipcMain.handle('chat:send-quick', async (_e, text) => {
  if (review.isSleeping()) {
    plog('[说] 「准备睡」挡下一次双击提问：' + String(text || '').slice(0, 40));
    return { ok: false, error: '她睡了', sleeping: true };
  }
  const r = await runChat(text, {
    delta: 'bubble:delta', done: 'bubble:done', fail: 'bubble:error',
  });

  /*
   * ⚠️ 早退那几种替他把话**冒成气泡**（2026-10-16 修的）。
   *    ask.html 那边是「按下回车立刻收窗、不 await」的（他明确要求的交互），
   *    所以主进程不广播 = 他什么反馈都看不到。
   *    只给 `early` 的补 —— 真出错那条路 runChat 自己已经广播过了，补了会报两遍。
   *
   *    ⚠️ 睡着那条**故意不补** —— 那是他自己定的规矩
   *      （「睡着时不会有任何气泡弹出」），而且 app.js 那边还有第二道闸。
   */
  if (r && r.early) overlay.broadcast('bubble:error', r.error || '说不出来');

  return r;
});

/*
 * ⚠️⚠️ 这里**只 abort、不提前清空 `busy`**（2026-10-14 修的）。
 *
 *    原来还跟一句 `busy = null` —— 那就是竞态的口子：
 *    清空之后他马上发的新请求会被放行，而**旧请求收尾时又无条件再清一次**，
 *    把新请求的锁一起清掉 ⇒ 能并发、而且「停止」会打到别的请求上去。
 *    完整交错序列见 `runChat` 尾部 finally 的注释。
 *
 *    放锁交给**发起它的那个 `runChat` 自己** —— 它一定会在 finally 里放。
 */
ipcMain.on('chat:abort', () => { busy?.abort(); });

/*
 * ★ 2026-10-22（YCH-007）：**聊天窗要的是完整记录，不是喂模型那份**。
 *
 *   原来这行是 `memory.recent(60)` —— 那是给模型的 DTO，只有 `{role, content}`：
 *   聊天窗于是分不出识屏 / 自言语（`kind` 丢了）、看不到时间（`ts` 丢了）、
 *   也点不到"她当时看见了什么"（`look` 丢了），而且只能翻到内存窗口那 60 条。
 *
 *   ⇒ 换成 `historyForDisplay(200)`：从 chat.jsonl 尾部读全量记录。
 *     ⚠️ 别换回 `recent()` —— 那是"给模型"的口径，两件事混用就是这个 bug。
 */
ipcMain.handle('chat:history', () => memory.historyForDisplay(200));
// 同上：清空的通知也得广播 —— 收的是聊天窗，不是主窗口
ipcMain.on('chat:clear', () => { memory.clear(); overlay.broadcast('chat:cleared'); });

ipcMain.handle('usage:get',   () => usage.all());
ipcMain.handle('usage:reset', () => usage.reset());

/** 图的三种粒度（日=近24小时按小时 / 周=近7天 / 月=近30天）—— 见 usage.series() */
ipcMain.handle('usage:series', (_e, range) => usage.series(range === 'week' || range === 'month' ? range : 'day'));

/* ---------- AI 服务商预设（2026-10-17 加的）----------
 *
 * ⚠️ 这几条**只碰 `data/providers.json`**。唯一"越界"的是 `activate` ——
 *    它会把那个预设的值**写回 config**（`providers.activate()` 内部干），
 *    这样全工程读 config 的那一票模块**一行都不用改**。
 *
 * ⚠️ 切完预设要**广播**：config 是被写回了，可渲染层手里那份 CFG 是旧的
 *    —— 不广播的话他切完 Kimi，输入框里还显示着 DeepSeek 的地址。
 */
ipcMain.handle('providers:list',     () => providers.list());
ipcMain.handle('providers:current',  () => providers.current());
ipcMain.handle('providers:save',     (_e, id, patch) => providers.saveOne(String(id || ''), patch || {}));
ipcMain.handle('providers:add',      (_e, name) => providers.addCustom(name));
ipcMain.handle('providers:remove',   (_e, id) => {
  const r = providers.remove(String(id || ''));
  /*
   * ★ 2026-10-21 修（外部审查 YCH-001）：删掉**当前在用**那个预设时，config 变了
   *   ⇒ 必须像 activate 那样把变化推回页面。不推的话聊天窗手里那份 CFG 还是旧的
   *   —— "页面自己改的能生效、别人改的页面不知道"那条老坑（见 broadcastCfg 的注释）。
   *   ⚠️ 用 broadcastCfg 而不是手写：它会把 apiKey 走 maskForPage 打码。
   */
  if (r.ok && r.switched) {
    broadcastCfg(['apiBase', 'apiKey', 'model']);
    overlay.broadcast('providers:changed', providers.list());
  }
  return r;
});
ipcMain.handle('providers:activate', (_e, id) => {
  const r = providers.activate(String(id || ''));
  if (r.ok) {
    overlay.broadcast('cfg:changed', { key: 'apiBase', value: r.item.base || '' });
    overlay.broadcast('providers:changed', providers.list());
  }
  return r;
});

/**
 * 每个姿态各自的倾斜角 —— 设置面板那 5 个滑块。
 *
 * ⚠️⚠️ 这组值存在 **`rig.json` 的 presets 里**，不在 `config.json`。
 *    理由见 `core/rigparams.cjs` 顶部的长注释（一句话：那个文件本来就是
 *    "每个姿态那套参数"的唯一真源，另存一份必然对不上）。
 *
 * ⚠️ 改完**必须**再告诉渲染层一声（`win:tilts-changed`）——
 *    `rig.json` 是启动时 fetch 进来的，光改文件跑着的那份 data 不会变，
 *    他会看到「拖了滑块没反应，重启才生效」。
 */
ipcMain.handle('rig:tilts', () => rigparams.tilts());

ipcMain.handle('rig:set-tilts', (_e, patch) => {
  const r = rigparams.setTilts(patch || {});
  if (r.ok) overlay.broadcast('win:tilts-changed', r.tilts);
  return r;
});

/**
 * 天气 —— 设置面板那个「查一下」按钮，和自检用。
 *
 * ⚠️ `force` 的区别：不带 force 会吃缓存和退避（给面板看的常态），
 *    带 force 是真去网上打一次（他按了「查一下」就是想当场看到结果）。
 */
ipcMain.handle('weather:get', async (_e, force) => {
  try {
    const r = await weather.fetchWeather({ force: !!force });
    return { ok: r.ok, text: r.text, why: r.why, cached: !!r.cached, city: cfg.get('city') || '' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* 设置面板的「测试连接」+「检测模型」2026-10-18 拆到 ./ai.cjs 了 */
ai.register(ipcMain, cfg);

/*
 * ★ 2026-10-20：「这台机器上的对话模型看不了图」要给设置面板看。
 *   为什么需要：只有**真发一次**才知道模型有没有视觉（没有 supports_vision 字段），
 *   而失败那一瞬间他多半没在看日志 —— 关掉客户端就更没了。
 *   ⇒ `looktool` 在服务端明确拒绝图片时落一个 `state/vision.json`，这里只读。
 */
ipcMain.handle('vision:state', async () => {
  try { return { ok: true, state: looktool.noVisionState() }; }
  catch (err) { return { ok: false, error: err.message, state: null }; }
});

/* ============================================================
   字体
   ============================================================
   ⚠️ 整块（含上面那段 CORS 的血泪说明）2026-10-18 拆到 ./fonts.cjs 了。
   这里只留一行注册 —— 主进程不该再往里塞东西。
*/
/* 字体那一块（FONT_EXT / fontFile / 三个 IPC）2026-10-18 拆到 ./fonts.cjs 了 */
fonts.register(ipcMain, cfg);

/* win:state 2026-10-18 拆到 ./mouse.cjs 了 */

ipcMain.on('app:quit', () => { app.isQuitting = true; app.quit(); });

/* ============================================================
   托盘
   ============================================================ */

const trayApi = {
  toggleShow() {
    if (!win) return;
    const next = !win.isVisible();
    /*
     * ★ 2026-10-18 加的日志：**这就是他复现 #6 走的那条路**。
     *   ⚠️ 之前 `plog` 只在探针模式（`YACHIYO_MS > 0`）才写 —— 他日常那次什么都没留下。
     *   ⇒ 记「托盘要干什么 + 当时穿透是什么值 + 之后可见性是什么」，两行，够对齐时间线。
     */
    plog(`[托盘] ${next ? '显示' : '隐藏'}（之前 visible=${!next} ignore=${mouse.lastIgnoreValue()}）`);
    if (next) { win.show(); win.setAlwaysOnTop(!!cfg.get('alwaysOnTop'), 'screen-saver'); }
    else win.hide();
    cfg.set('petVisible', next);
    trayMod.refresh(cfg, trayApi);
    plog(`[托盘] ${next ? '显示' : '隐藏'}完成（visible=${win.isVisible()} bounds=${JSON.stringify(win.getBounds())}）`);
  },
  set(k, v) {
    cfg.set(k, v);
    /*
     * ⚠️ 要**广播给所有窗口**（2026-10-16 修的）。
     *
     *    原来只 `win.webContents.send('cfg:changed', …)` —— 只有主窗口收得到。
     *    可**设置面板 / 菜单是独立浮层窗口**，它们的本地配置缓存只靠
     *    `cfg:changed` 更新（见 host.js）。于是：从托盘切夜间模式或音效，
     *    再打开面板，显示的还是**旧主题、旧勾选** —— 跟 IPC 那条路
     *    （`broadcastCfg`）不是同一套。
     */
    broadcastCfg([k]);
    trayMod.refresh(cfg, trayApi);
  },
  // ⚠️ 托盘项现在开的是**独立浮层窗口**，不是主窗口里的 DOM
  //    （主窗口只盖屏幕底部一条带，面板 580px 根本塞不下）
  openSettings() { overlay.open('panel', { state: { page: 'habit' } }); },
  openChat()     { overlay.open('chat'); },
  quit()         { app.isQuitting = true; app.quit(); },
};

/*
 * ★ 2026-10-21：所有「只给探针用」的 IPC 都搬到 ./probe.cjs 了。
 *   ⚠️ 必须在这里注册 —— 上面 `win` / `trayApi` / 调试台那几个函数都得在这个作用域里，
 *      而且 `win` 是会重建的，所以传的是 getter 不是值。
 */
probes.register({
  ipcMain, devOnly, overlay, review, probeBoundsLog, trayApi,
  getWin: () => win,
  design: { readDesign, writeDesign, designClear, designSave, DESIGN_FILE },
});

/* ============================================================
   探针模式（只在 YACHIYO_MS 设了的时候跑）
   ============================================================ */

function startProbe() {
  plog(`=== 探针启动，跑 ${PROBE_MS} ms ===`);

  shotTimer = setInterval(async () => {
    if (!win) return;
    shotNo++;
    try {
      fs.writeFileSync(path.join(PROBE_ROOT, `_shot-${shotNo}.png`), (await win.capturePage()).toPNG());
    } catch (err) { plog(`[shot] 第 ${shotNo} 张失败：${err.message}`); }
  }, 3000);

  setTimeout(async () => {
    clearInterval(shotTimer);
    try {
      if (win) {
        fs.writeFileSync(path.join(PROBE_ROOT, '_probe-shot.png'), (await win.capturePage()).toPNG());
        plog(`连拍 ${shotNo} 张 _shot-1..${shotNo}.png + _probe-shot.png`);
      }
    } catch (err) {
      plog('[shot] 收尾截图失败: ' + err.message);
    }
    plog('=== 探针结束 ===');
    // ⚠️ 这里必须用 exit 不能用 quit：quit 是「客客气气地关」——
    //    它会等每个窗口的 beforeunload / 渲染进程握手。渲染进程要是卡住了，
    //    整个 Electron 就赖在后台不走（实测卡了三个多小时，还占着单实例锁，
    //    下一次探针直接静默退成 exit=0，看着像「什么事都没发生」）。
    //    探针是一次性的，日志已经同步落盘了，直接退。
    app.exit(0);
  }, PROBE_MS);
}

/* ============================================================
   启动
   ============================================================ */

process.on('uncaughtException', (err) => plog('[main] 未捕获异常：' + (err && err.stack || err)));

if (!app.requestSingleInstanceLock()) {
  // 已经开着一个了 —— 把那个叫到前面来，别开第二个
  // ⚠️ 探针模式下这个最常见：上一次的进程还没退干净，新的这一跑就静默退了，
  //    看着像「什么都没发生」。
  plog('[main] 已经有一个八千代在跑了，本次退出');
  app.quit();
} else {
  app.on('second-instance', () => {
    /*
     * ⚠️ 这条路径也要**把状态一起摆正**（2026-10-16 修的）。
     *
     *    原来只 show 窗口，不碰 `cfg.petVisible`、也不刷托盘 ⇒
     *    他把她隐藏过之后双击图标：窗口出来了，托盘还写着「显示八千代」，
     *    点一下反而又把她藏起来。
     *    双击图标本来就是"**他显式要她出来**"，所以顺手把配置和托盘一起纠正。
     */
    if (!win) return;
    win.show();
    win.setAlwaysOnTop(!!cfg.get('alwaysOnTop'), 'screen-saver');
    if (cfg.get('petVisible') === false) cfg.set('petVisible', true);
    trayMod.refresh(cfg, trayApi);
  });

  app.whenReady().then(() => {
    cfg.load();
    plog('配置目录：' + cfg.DIR);
    /*
     * ★ AI 服务商预设：首次运行把 config 里**正在用的那一套**搬进预设
     *   （他原来只有一份配置，不搬的话打开面板会看到预设全空，以为 key 丢了）。
     * ⚠️ 必须在 cfg.load() 之后 —— 它要读 apiBase / apiKey / model。
     * ⚠️ 失败也不能拦住启动：迁移只是"少填一次"，不是她能不能跑的前提。
     */
    try {
      if (providers.migrate()) plog('[providers] 把现有的一套 API 配置搬进预设了');
      /*
       * ★ 保险（2026-10-17 加的）：config 里那三项空着、而当前预设里还有值 ⇒ 补回去。
       *   实测撞出来的坑：切到 Kimi（它 Key 是空的）会把那份空值写进 config，
       *   关掉再启动就成了「我的 Key 丢了」。真身在 providers.json，config 只是副本。
       */
      if (providers.ensureConfig()) plog('[providers] config 里的接入配置是空的，已用当前预设补回');
    } catch (err) {
      plog('[providers] 迁移失败（不影响她用）：' + err.message);
    }
    createWindow();
    mouse.startCursorWatch();     // ★ 光标守望：出了那条带就通知页面打开穿透（见函数注释）

    /*
     * ★ 游戏检测（2026-10-17 加的）：他在全屏游戏里就让她坐着。
     *   他定的口径是**全屏 + 进程**两条一起看（「这样更准」），判定逻辑在
     *   `core/gamedetect.cjs` 的 `judge()` 里，自检钉了 25 项。
     *
     *   ⚠️ 回调**只在状态变化时**触发（模块里自己去了重）—— 页面那边不用再判一遍。
     *   ⚠️ 配置**每次现读**：他在设置里关掉能立刻生效，不用重启桌宠。
     *   ⚠️ 这里只广播「是不是在游戏」，**不碰她的状态机** ——
     *      状态只有一个主人（页面），两头改必然打架。
     */
    try {
      gamedetect.start((isGame, why) => {
        plog(`[游戏] ${isGame ? '进了游戏' : '退出游戏'}：${why}`);
        overlay.broadcast('game:changed', { on: isGame, why });
      }, () => ({
        enabled: cfg.get('gameDetect') !== false,
        exclude: (Array.isArray(cfg.get('gameExclude')) && cfg.get('gameExclude').length)
          ? cfg.get('gameExclude')
          : gamedetect.DEFAULT_EXCLUDE,
      }));
    } catch (err) {
      plog('[游戏] 启动检测失败（不影响别的）：' + err.message);
    }
    // 退出时把那个常驻 PowerShell 收掉（不然 Windows 上偶尔会留一个孤儿进程）
    app.on('before-quit', () => { try { gamedetect.stop(); } catch { /* 已经没了 */ } });
    try {
      trayMod.create(cfg, trayApi);
      plog('托盘建好了');
    } catch (err) {
      // 托盘建不起来不该带着整个程序一起死 —— 她还能跑，只是没法从托盘退出
      plog('[tray] 建托盘失败：' + err.message);
    }
    /*
     * ★ 心跳（第 4 步）。
     *
     * ⚠️⚠️ 空闲时间**必须问系统要**（`powerMonitor.getSystemIdleTime()`），
     *    不能自己记「上次收到鼠标事件是什么时候」——
     *    她自己走动、气泡刷新都会动，自己记的那个在「他走开了但她在动」
     *    的时候会一直归零。而「他到底在不在」正是回顾链最关键的那道闸。
     *
     * ⚠️ 必须在 `cfg.load()` 之后 —— 心跳里要读一堆配置。
     */
    heartbeat.attach({ powerMonitor });

    /*
     * ★ 她自己开口的那条路（自言语 / 到点提醒）。
     *
     * ⚠️ 只发给**主窗口** —— 气泡长在那儿。聊天窗是另一套（`chat:*`）。
     * ⚠️ 跟 `runChat` 的 `bubble:*` 是**两条不同的事件**：
     *    那条是"你问她、她流式答"，这条是"她自己说完整一句"。
     *    混用的话，自言语会被当成一次问答，而你根本没问过。
     */
    const sayIt = (text, o = {}) => {
      if (!text) return;
      /*
       * ⚠️⚠️ 「准备睡」之后**不许再开口**（他 2026-10-13 明确要求：
       *    「桌宠在睡着状态时不会说话也不会有任何气泡弹出」）。
       *
       * 为什么闸设在这儿：`sayIt` 是**唯一**的出口 —— 自言语、识屏、晚安
       * 全从这条走。以前只在 selftalk / peeker 各自的闸里挡过，
       * 那是"哪条链自己想起来了才挡"，漏一条就漏一条。
       * 搁在出口这儿，**以后新增任何链都自动被管住**。
       *
       * ★ 唯一放行的是**晚安**：那是"她最后留一句再走"，正是睡眠这条链
       *   自己要的结果。判据是 autoexit 自己的状态，不是调用方随手传的标志——
       *   用标志的话，以后谁想插话都能给自己开个后门，闸就形同虚设了。
       */
      if (review.isSleeping() && !byePending()) {
        plog(`[说] 「准备睡」挡下一句（${o.kind || '主动'}）：${text}`);
        return;
      }
      /*
       * ⚠️⚠️ 用 `overlay.broadcast`，**不要**只发给主窗口（2026-10-16 修的）。
       *
       *    broadcast 的名单是 `[mainWin, ...所有浮层窗口]` —— 主窗口照样收得到，
       *    但**聊天窗**（一个独立浮层）以前永远收不到 ⇒
       *    她自言自语、识屏点评、晚安这些话，聊天窗里**一个字都没有**。
       *    他 2026-10-16 报的「气泡内文字没有同步到聊天框」就是这个。
       *
       *    （`bubble:*` 那条走 runChat 的流本来就是 broadcast，所以只有
       *      `sayIt` 这一条是漏的。现在两条都到得了聊天窗。）
       */
      overlay.broadcast('speak:say', String(text), o);
      plog(`[说] ${o.kind || ''} ${text}`);
    };

    /*
     * ★★ 「她说过的每一句话，都记一笔」—— 统一走**文件顶部那个** `recordSaid`
     *    （见第 608 行）。它记两本账：`memory.addSpoken`（防复读）+ 推对话流
     *    （聊天窗拉历史用的就是对话流）。
     *
     * ⚠️⚠️⚠️ **这里原来还有一个同名的 `const recordSaid = …`，把外面那个遮住了。**
     *    那个版本**只记"我说过什么"，不推对话流**，于是在这里的三个调用点
     *    （自言语 / 睡前 / 识屏）全都用了它 ——
     *    结果：识屏和自言语说的话，聊天记录里**一个字都没有**，
     *    只有"对话"那条链（在别的函数作用域里，用的是顶部那个）正常。
     *
     *    他 2026-10-20 报的正是这个：「桌宠自己说的话还是无法同步至聊天框」。
     *    实测：13:11:06 识屏说了 23 字、自言语说了 32 字，而 `data/chat.jsonl`
     *    里那两条**根本不存在**（最近的一条是 13:11:23 的对话）。
     *
     *    ⇒ 删掉本地那份，全部用顶部那一个。**别再在函数里复制一份。**
     */

    /**
     * 现在这句是不是「晚安」—— 由 autoexit 自己说了算（见上面 sayIt 里那段注释）。
     * 拿不到就问不出来，**当作不是**（宁可少说一句晚安，也不能破了睡觉的闸）。
     */
    const byePending = () => {
      try { return !!autoexit.isSayingGoodnight(); } catch { return false; }
    };


    /**
     * 气泡忙不忙 —— 去页面里问。
     *
     * ⚠️ 同步拿不到（`executeJavaScript` 是异步的），所以这里只能问**上一次**
     *    问出来的结果，或者干脆放行。理由：自言语晚 5 秒说和现在说没区别，
     *    但**因为读不到状态就永远不说**是个静默故障。
     *    ⇒ 拿不到就**当作不忙**。
     */
    let bubbleBusyCache = false;
    let bubbleBusyAt = 0;
    const bubbleBusy = () => {
      const now = Date.now();
      if (now - bubbleBusyAt < 2000) return bubbleBusyCache;   // 2 秒内问过就用缓存
      bubbleBusyAt = now;
      if (win && !win.isDestroyed()) {
        win.webContents.executeJavaScript('(window.__yachiyoBubbleBusy ? window.__yachiyoBubbleBusy() : false)')
          .then((v) => { bubbleBusyCache = !!v; })
          .catch(() => { bubbleBusyCache = false; });
      }
      return bubbleBusyCache;
    };

    selftalk.attach({
      say: sayIt, busy: bubbleBusy, sleeping: () => review.isSleeping(),
      /*
       * ⚠️ **`chatBusy` 跟 `busy` 不是一回事**（2026-10-17 加的，清单 #42）：
       *    `bubbleBusy` 是去主窗口问「`#bubble` 里有没有字」，
       *    而**聊天窗的流式回复根本不碰那个气泡** ⇒ 对着聊天窗它恒为 false，
       *    那道闸等于不存在。
       *    这里直接用主进程那个 `busy`（`runChat` 正在跑时它是非空的），
       *    也就是「她这一轮回复跑完没有」。
       */
      chatBusy: () => !!busy,
      // ⚠️ 自言语那句要单独记 —— 它不走 runChat，所以 recordSaid 得单独接上
      onSaid: (text) => recordSaid(text, '自言自语'),
    });
    autoexit.attach({
      // ★ 晚安也要记进「我说过什么」—— 她说过的话，一条都不能漏
      say: (text, o) => { sayIt(text, o); recordSaid(text, (o && o.kind) || '睡前'); },
      reviewBusy: () => review.isBusy(),
      quit: () => softExit('她困了，自己先睡了'),
    });

    /*
     * ★ 补记：把**已经在聊天记录里**的那几句她补进「我说过什么」。
     *
     * ⚠️ 不补的话，这个功能要从装上的那一刻才开始生效 ——
     *    而她那几句正在复读的话**就在历史里**，等于白装。
     *
     * ⚠️⚠️ 标记**必须单独存一个文件**，不能塞进 `spoken.json`。
     *    踩过：第一版把 `Seeded` 写进 spoken.json，而
     *    `memory.readSpoken()` 只回 `{At, Items}` 两个字段、
     *    `addSpoken` 又拿它整个写回去 —— **别的字段全被冲掉**。
     *    症状：每次启动都以为"还没补记过"，于是**反复往里塞**同几句。
     *    （这是"读一个文件只挑自己要的字段、写回去却写整个对象"的经典坑。）
     */
    try {
      const seedFile = path.join(cfg.DATA, 'state', 'spoken-seed.json');
      if (!store.readJson(seedFile, null)) {
        const tail = memory.recent(12).filter((m) => m.role === 'assistant');
        const last = tail.slice(-3);
        for (const m of last) memory.addSpoken('主动', m.content);
        store.writeJson(seedFile, { done: true, n: last.length, at: Date.now() });
        plog(`[说] 补记了 ${last.length} 句她以前说过的话`);
      }
    } catch (err) { plog('[说] 补记失败：' + err.message); }

    /*
     * ★ 回顾链 —— 顺便把「准备睡」的变化推给页面。
     *
     * 为什么在这儿推而不是让页面自己算：进睡判据是**系统空闲时间**
     *   （`powerMonitor.getSystemIdleTime()`），那东西只有主进程拿得到，
     *   页面自己数"多久没动"会被她走动、气泡刷新带偏（旧工程栽过）。
     *
     * ⚠️ 只在**变化时**推 —— 心跳 5 秒一拍，无脑推就是每 5 秒一条 IPC，
     *    而且页面那边会反复 setSleeping，白忙。
     */
    let sleepPushed = null;
    const pushSleep = () => {
      const now = review.isSleeping();
      if (now === sleepPushed) return;
      sleepPushed = now;
      overlay.broadcast('sleep:changed', now);
      plog('[说] 「' + (now ? '准备睡' : '醒了') + '」→ 已通知页面');
    };
    heartbeat.on('review', () => { review.tick(heartbeat.idleMinutes()); pushSleep(); });
    heartbeat.on('selfTalk', (idleMin) => selftalk.tick(idleMin));
    heartbeat.on('autoExit', (idleMin) => autoexit.tick(idleMin));
    heartbeat.on('profile', (idleMin, now) => profiletool.tick(now || new Date()));

    /*
     * ★ 「花超了提醒我」（2026-10-16 接上的）。
     *
     *   ⚠️ 这一整套原来是**死的**：`usage.overLimit` / `spendAlert` / `spendLimit`
     *      只出现在 config 的默认值和设置面板的控件里，
     *      **没有任何一行逻辑读它们** —— 设了月上限也不会有人提醒。
     *
     *   ⚠️ 只提醒**一次/月**：心跳 5 秒一拍，不限次的话每拍都要冒一句。
     *      判据用账本自己的 `month` 字段（跨月它会自己归零），别自己算日期 ——
     *      账本用的是本地月份，自己算容易在月初月末差一天。
     */
    let spendAlertedFor = '';
    heartbeat.on('spend', () => {
      if (cfg.get('spendAlert') === false) return;
      const limit = Number(cfg.get('spendLimit')) || 0;
      if (limit <= 0) return;
      if (!usage.overLimit(limit)) return;

      const st = usage.all();
      if (spendAlertedFor === st.month) return;
      spendAlertedFor = st.month;

      // ⚠️ 先记日志 —— 它可能被「准备睡」那道闸挡掉，日志是**唯一**的验收指标
      plog(`[用量] 本月已花 ¥${st.monthCost.toFixed(2)}，超过设的上限 ¥${limit}`);
      sayIt(`这个月我们花到 ${st.monthCost.toFixed(2)} 块了，超过你设的线啦。`, { kind: '提醒', seconds: 12 });
    });

    /*
     * ★ 备份（2026-10-17 接上心跳的，清单 #6）。
     *
     *   ⚠️ 原来它**只在启动 8 秒后跑一次**（见下面那一小段），注释给的理由是
     *      "放心跳的话每 5 秒要 stat 一遍目录、读一遍备份状态，纯白烧 IO"。
     *      那个顾虑是真的 —— 但代价太大：桌宠长期不关机 ⇒ 备份要一直等到
     *      下次启动。第 3 天崩了或磁盘出问题，手上没有近期备份。
     *      备份是保他数据的东西，不能赌"他什么时候重启"。
     *
     *   ⇒ 两个顾虑一起解：**挂心跳 + 内存节流**（跟上面 spend 那个一个套路）。
     *      一小时才真判一次，一天最多读 24 次备份状态 ——
     *      比"每 5 秒一拍"省 700 多倍，而且不用再等重启。
     *
     *   ⚠️ 节流用**内存变量、不落盘**：重启就该重新判一次（那才是原来那条语义）。
     */
    /** 跑一次备份并打日志 —— **启动那一拍和心跳共用这一个实现**，改一处两处都跟着 */
    const runBackup = () => {
      try {
        const r = backup.tick();
        plog(`[备份] ${r.ran ? '跑了' : '没跑'}（${r.why || '到点了'}）` +
             ` 聊天 ${r.chat} · 日志 ${r.logs}` +
             (r.memory ? ` · 记忆 ${r.memory.ok ? r.memory.files + ' 个文件' : '失败：' + r.memory.why}` : ''));
      } catch (err) {
        // ⚠️ 备份绝不能因为她别的部件有问题就带她一起挂
        plog('[备份] 出错：' + err.message);
      }
    };

    let lastBackupCheck = 0;
    const BACKUP_CHECK_MS = 60 * 60 * 1000;
    heartbeat.on('backup', () => {
      const t = Date.now();
      if (t - lastBackupCheck < BACKUP_CHECK_MS) return;
      lastBackupCheck = t;
      runBackup();
    });

    /*
     * ★ 识屏（2026-10-13）。
     *
     * ⚠️ core 层**不直接 require electron**（那种模块在 node 里跑不起来、
     *    自检也就没法跑了）—— desktopCapturer / screen 由这儿塞进去。
     * ⚠️ `setOwnPid` 是给别看她自己的窗口用的：他正在跟聊天窗打字时
     *    前台是我们自己的进程，那一眼没什么可看的。
     */
    capture.attach({ desktopCapturer, screen, nativeImage });
    capture.setOwnPid(process.pid);
    peeker.attach({
      say: (text, o) => { sayIt(text, o); recordSaid(text, (o && o.kind) || '识屏'); },
      /*
       * ⚠️ 用**主进程那个 `busy`**（`runChat` 正在说话时它是个 AbortController），
       *    不是 `brain.isBusy()` —— 那个函数**不存在**（我第一版瞎写的）。
       *    ⚠️ 也别用 `bubbleBusy`：那个是去页面里问气泡在不在，
       *      而这里要知道的是"**她这轮话说完没有**" —— 说话中的话，
       *      再塞一句识屏会跟当前这句打架。
       */
      thinking: () => !!busy,
      sleeping: () => review.isSleeping(),
    });
    heartbeat.on('screen', (idleMin, now) => peeker.tick(idleMin, now || new Date()));

    heartbeat.start();
    plog('心跳起来了');

    // 开机自启对账：设置里勾着、注册表里没有（换机器/挪目录）→ 补上。只补不改。
    try {
      const as = autostart.sync(cfg.get('autostart'), app.isPackaged ? '' : app.getAppPath());
      plog('[自启] ' + (as.why || '对好了'));
    } catch (err) { plog('[自启] 对账失败：' + err.message); }

    /*
     * ★ 备份的**启动那一拍**（每天第一次启动跑一次；记忆每周一次）。
     *
     * ⚠️ **延后 8 秒再跑**：启动那几秒她在忙着建窗口、拉天气、装托盘 ——
     *    备份要读几十个文件、还可能要打 zip，挤在一起会让她启动发涩。
     *    他也不差这 8 秒（备份是后台的事）。
     *
     * ⚠️ 这里原来写着「**放启动这一下、不放心跳**」，理由是放心跳会每 5 秒
     *    去 stat 一遍目录、读一遍备份状态。那个顾虑 2026-10-17 用
     *    **心跳 + 内存节流**解掉了（见上面 runBackup 那一段，清单 #6）：
     *    现在这一拍负责"开机当天立刻备一次"，之后交给心跳每小时判一次。
     *    ⇒ 实现只此一份（`runBackup`）—— 两边各写一份日志格式，早晚会不一致。
     */
    setTimeout(runBackup, 8000);

    /*
     * ★ 探针专用：真截一张屏并落盘。
     *
     * ⚠️ 为什么非要在**主进程**里跑： 是 Electron 的 API，
     *    node 里根本没有 —— 自检跑不到这一条，只能真起一次应用。
     *    结果写进 ，探针读文件来判。
     * ⚠️ 只在探针模式（YACHIYO_MS > 0）下跑，正常启动绝不截屏。
     */
    if (PROBE_MS > 0) {
      setTimeout(async () => {
        try {
          const dir = path.join(PROBE_ROOT, '_cap-probe');
          fs.mkdirSync(dir, { recursive: true });
          const want = process.env.YACHIYO_CAPTURE || 'auto';
          const shot = await capture.grab(want);
          fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
            method: want, ok: shot.ok, why: shot.why, w: shot.w, h: shot.h,
            blank: shot.blank, max: shot.max, lit: shot.lit, decoded: shot.decoded, hash: shot.hash,
            bytes: shot.buffer ? shot.buffer.length : 0, usedMethod: shot.method,
          }, null, 2), 'utf8');
          if (shot.buffer) fs.writeFileSync(path.join(dir, 'shot.jpg'), shot.buffer);
          const fg = capture.foreground();
          fs.writeFileSync(path.join(dir, 'fg.json'), JSON.stringify(fg, null, 2), 'utf8');
          plog('[抓屏探针] ' + JSON.stringify({ ok: shot.ok, used: shot.method, w: shot.w, h: shot.h, lit: shot.lit, blank: shot.blank, kb: shot.buffer ? Math.round(shot.buffer.length / 1024) : 0 }));
        } catch (err) {
          plog('[抓屏探针] 出错：' + err.message);
        }
      }, 6000);
    }

    if (PROBE_MS > 0) startProbe();
  }).catch((err) => {
    /*
     * ⚠️⚠️ 启动阶段抛错**必须收场**（2026-10-16 加的）。
     *
     *    `app.whenReady().then(…)` 原来没有 `.catch` ——
     *    `cfg.load()` 或 `createWindow()` 抛了的话，这个 Promise 拒绝**没人接**
     *    （全仓也没有 `unhandledRejection` 监听），异常被静默吞掉。
     *
     *    而 `requestSingleInstanceLock()` 在上面**已经把锁拿到了** ⇒
     *    进程既没有窗口也没有托盘，却占着单实例锁：
     *    他再点一次只得到一句「已经有一个在跑了」，只能去任务管理器结束它。
     *
     *    所以：记一笔、然后**干净退出**，把锁放掉。
     */
    plog('[main] 启动阶段出错，退出：' + ((err && err.stack) || err));
    try { app.exit(1); } catch { process.exit(1); }
  });

  // 她不占任务栏，关掉最后一个窗口不该等于退出 —— 退出只有托盘和 ⏻ 两条路
  app.on('window-all-closed', () => { /* 故意留空 */ });
  app.on('activate', () => { if (!win) createWindow(); });
  // ⚠️⚠️ 这里**不能**写 `overlay.attach(win)` —— 这行是在模块加载时同步跑的，
  //     而 `win` 要到 app ready 之后的 createWindow() 里才赋值。写在这儿
  //     拿到的是 null，`mainWin` 就永远是 null ⇒ `overlay.broadcast` 少了
  //     主窗口那一份 ⇒ **主窗口收不到任何 cfg:changed**。
  //     症状特别阴：在面板里改任何东西，面板自己（本地先改一份）看着是好的，
  //     主窗口那边一点反应都没有 —— 切深色只有面板变、改桌宠大小她不变大、
  //     气泡宽度调了没动静。全是这一行的锅。
  //     attach 挪进 createWindow() 了（窗口重建时也会重新绑）。
  app.on('before-quit', () => {
    app.isQuitting = true;
    saveOnExit();                 // ⚠️ 必须在托盘销毁之前 —— 它是同步的，慢一点但不会丢
    overlay.destroyAll();
    trayMod.destroy();
  });
}

/**
 * **软退出** —— 她困了自己走的那条路，跟托盘 ⏻ 和聊天窗那个按钮走的是同一个出口。
 *
 * ⚠️ 收浮层走 `closeAll()` 不是 `destroyAll()`：浮层关闭时会**先把位置存下来**
 *    （见 overlay.cjs 的 close → flushGeom）。`destroyAll` 是给 `before-quit`
 *    用的，那时候窗口已经不需要复用、只求干净销毁。
 *
 * ⚠️ **防重入**：这条链是心跳每 5 秒判一次的，判中之后到进程真退掉之间
 *    还会再判好几次 —— 不防的话她会留好几句晚安。
 *    （旧工程的 `Invoke-SoftExit` 里也有这么一道，`$script:SoftExited`。）
 */
let softExiting = false;
function softExit(why) {
  if (softExiting) return false;
  softExiting = true;
  plog(`[软退出] ${why || ''}`);
  try { overlay.closeAll(); } catch (err) { plog('[软退出] 收浮层失败：' + err.message); }
  /*
   * ⚠️ 顺序：**先收窗、再存盘、最后退**。
   *    反过来（先退再存）的话，`before-quit` 里那次 `saveOnExit` 会跟这里打架，
   *    而且窗口销毁过程中她不复存在 —— 那正是旧工程「分层退出」的教训。
   */
  saveOnExit();
  app.quit();
  return true;
}
