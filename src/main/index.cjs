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

const { app, BrowserWindow, screen, ipcMain, shell, powerMonitor, desktopCapturer, nativeImage } = require('electron');
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
const websearch = require('../core/websearch.cjs');
const capture = require('../core/capture.cjs');
const peeker  = require('../core/peeker.cjs');
const trayMod  = require('./tray.cjs');
const overlay  = require('./overlay.cjs');

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

  // 告诉 overlay「主窗口是哪一个」—— 广播要发给它一份（见文件末尾那段注释：
  // 这行曾经写在模块作用域里，那时 win 还是 null）
  overlay.attach(win);

  const url = process.env.YACHIYO_URL;
  if (url) win.loadURL(url);
  else win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // 把页面的 console 转到主进程 —— 不然页面报错一个字都看不见
  // ⚠️ Electron 44 起是对象式回调；旧的位置参数写法会刷一屏 deprecation 警告
  win.webContents.on('console-message', (e) => {
    const file = e.file ? path.basename(e.file) : '?';
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

  win.once('ready-to-show', () => win.show());
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
const SECRET_KEYS = ['apiKey'];
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
ipcMain.handle('probe:sleep', (_e, on) => {
  // `on` 给 null 就是**纯查询**，不改状态（探针要分开问"设成功没"和"现在什么状态"）
  if (on === null || on === undefined) return review.isSleeping();
  review._setSleeping(!!on);
  // 立刻把状态推给页面 —— 不然要等下一拍心跳（5 秒）才生效，探针得干等
  overlay.broadcast('sleep:changed', review.isSleeping());
  return review.isSleeping();
});

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
  try { memory.addSpoken(kind || '主动', text); }
  catch (err) { console.error('[说] 记「我说过什么」失败：' + err.message); }
}

/**
 * 在资源管理器里打开一个**我们自己的目录**（备份文件夹 / 配置文件夹）。
 *
 * ⚠️ 只允许打开「cfg.DIR 底下」的目录 —— 渲染层要是被 XSS 了，
 *    `shell.openPath` 能打开任意路径，那等于把整台机器的文件系统递出去。
 *    这道闸很便宜，加上。
 */
ipcMain.handle('app:reveal', (_e, kind) => {
  const targets = {
    backup: backup.root(),
    config: cfg.DIR,
    data: cfg.DATA,
    logs: path.join(cfg.DIR, 'logs'),
  };
  const dir = targets[String(kind)];
  if (!dir) return { ok: false, why: '不认识的目录' };
  const full = path.resolve(dir);
  if (!full.startsWith(path.resolve(cfg.DIR))) {
    return { ok: false, why: '越界了' };
  }
  try {
    fs.mkdirSync(full, { recursive: true });     // 还没备过的时候目录可能不存在
    shell.openPath(full);
    return { ok: true, dir: full };
  } catch (err) {
    return { ok: false, why: err.message };
  }
});

ipcMain.handle('ov:probe-raise', (_e, kind, afterHwnd) => {
  const w = overlay.list().get(kind);
  if (!w || w.isDestroyed()) return { ok: false, why: '窗口不在' };
  const raw = afterHwnd ? parseInt(String(afterHwnd), 10) : 0;
  if (raw) {
    // `insertAfter` 第二参要的是 NodeBuffer / number hwnd
    const Buffer = require('node:buffer').Buffer;
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(raw));
    try { w.insertAfter(buf); } catch (err) { return { ok: false, why: err.message }; }
  } else {
    try { w.moveTop(); } catch (err) { return { ok: false, why: err.message }; }
  }
  return { ok: true };
});

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
ipcMain.handle('ov:probe-bounds', (_e, kind, on) => {
  const w = overlay.list().get(kind);
  if (!w || w.isDestroyed()) return { ok: false, why: '窗口不在' };
  if (on === false) { w.__probeBounds = false; return { ok: true, log: probeBoundsLog.get(kind) || [] }; }

  probeBoundsLog.set(kind, []);
  const orig = w.setBounds.bind(w);
  w.setBounds = (b, ...rest) => {
    const from = w.getBounds();
    const r = orig(b, ...rest);
    const to = w.getBounds();
    if (from.x !== to.x || from.y !== to.y || from.width !== to.width || from.height !== to.height) {
      const log = probeBoundsLog.get(kind) || [];
      log.push({ t: Date.now(), from: { x: from.x, y: from.y, w: from.width, h: from.height },
                 to: { x: to.x, y: to.y, w: to.width, h: to.height } });
      probeBoundsLog.set(kind, log);
    }
    return r;
  };
  return { ok: true };
});

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

ipcMain.on('win:ignore-mouse', (_e, on) => {
  win?.setIgnoreMouseEvents(!!on, { forward: true });
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
 * 问一句、把回答流式推出去 —— 两个入口共用这一份。
 *
 * ⚠️⚠️ 别退回去用 `win.webContents.send(...)`。
 *    聊天窗拆成独立的 chat.html 之后，流只发给主窗口的话就送到没人看的地方去了：
 *    主窗口里没有聊天 DOM（收了也是空转），聊天窗里那条气泡**永远是空的**，
 *    而且不报错、`send` 还老老实实返回 ok —— 假成功。踩过一次。
 *
 * @param {string} text
 * @param {{delta:string, done:string, fail:string}} ev 三个事件名
 *        （聊天窗走 chat:*，快速问一句走 bubble:* —— 见 renderer/ui/ask.js）
 */
async function runChat(text, ev) {
  const msg = String(text || '').trim();
  if (!msg) return { ok: false, error: '空的' };
  if (busy) return { ok: false, error: '上一句还没说完，等一下下' };

  const gate = brain.ready();
  if (!gate.ok) return { ok: false, error: gate.why, needKey: true };

  const ctl = new AbortController();
  busy = ctl;

  /*
   * ★ 他这句话在问天气 → **现查一次**（旧工程 Invoke-AiWeatherRefreshNow 那套）。
   *
   * ⚠️ 为什么不在提示词总装里查：那是「她说每一句话之前都要跑」的地方，
   *    放那儿等于每句话都同步上网，网络一抖她整个人卡住（旧工程的老毛病 O07）。
   *    这里只在**他自己问到天气**时才等这一下，而且给 5 秒硬上限 ——
   *    查不动就不查了，用缓存那份，不能因为天气把他这句话卡死。
   */
  if (weather.isAsking(msg)) {
    try {
      const r = await Promise.race([
        weather.fetchWeather({ force: true }),
        new Promise((res) => setTimeout(() => res({ ok: false, why: '查得太慢，先不等了' }), 5000)),
      ]);
      plog('[weather] 他问到天气 → 现查：' + (r.ok ? (r.cached ? '用缓存' : '拿到新的') : ('没查到 · ' + r.why)));
    } catch (err) {
      plog('[weather] 现查失败：' + err.message);
    }
  }

  // 边收边推 —— 不然要干等到整段生成完才出字
  const onDelta = (t) => overlay.broadcast(ev.delta, t);

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
  if (websearch.shouldSearch(msg)) {
    /*
     * ⚠️ **先冒一句**。
     *    查一次要 4~9 秒（实测 8146ms，服务端搜了 4 次），
     *    这期间她那边**一点动静都没有** —— 看着像卡死了。
     *    先推一句短的，等真答案回来照常覆盖掉（`bubble:delta` 是累加的，
     *    但 `brain.reply` 一开始会重置缓冲，所以这句不会残留）。
     */
    overlay.broadcast(ev.delta, '我查一下…');
    const w = await websearch.search(msg).catch((e) => ({ ok: false, why: e.message }));
    plog(`[联网] ${w.ok ? `查到 ${w.answer.length} 字（服务端搜了 ${w.uses} 次）` : '没查到：' + w.why}`);
  }

  try {
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
    busy = null;
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
ipcMain.handle('chat:send-quick', (_e, text) => {
  if (review.isSleeping()) {
    plog('[说] 「准备睡」挡下一次双击提问：' + String(text || '').slice(0, 40));
    return { ok: false, error: '她睡了', sleeping: true };
  }
  return runChat(text, {
    delta: 'bubble:delta', done: 'bubble:done', fail: 'bubble:error',
  });
});

ipcMain.on('chat:abort', () => { busy?.abort(); busy = null; });

ipcMain.handle('chat:history', () => memory.recent(60));
// 同上：清空的通知也得广播 —— 收的是聊天窗，不是主窗口
ipcMain.on('chat:clear', () => { memory.clear(); overlay.broadcast('chat:cleared'); });

ipcMain.handle('usage:get',   () => usage.all());
ipcMain.handle('usage:reset', () => usage.reset());

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

/** 设置面板的「测试连接」—— 拿真 key 问一句最短的，验通了才算数 */
ipcMain.handle('ai:ping', async () => {
  const c = cfg.all();
  if (!c.apiKey) return { ok: false, error: '还没填 API Key —— 「测试连接」要拿它真发一句话', needsKey: true };
  try {
    /*
     * ⚠️⚠️ 这里原来写的是 `model: c.thinking ? 'deepseek-reasoner' : c.model` ——
     *    **写死的模型名**，把他填的那个盖掉了。
     *    他 2026-10-12 报的就是这个：「我用其他的地址检测到模型但不可用，
     *    404 报错 model 'deepseek-reasoner' not found」——
     *    他明明在面板里选了别的模型，一点「测试连接」还是去打 deepseek-reasoner。
     *    测试连接要测的是**他配的那一套**，不是我们觉得好的那一套。
     */
    const r = await provider.ping({
      base: c.apiBase, key: c.apiKey,
      model: c.model,
      temperature: c.temperature ?? 0.1,
      thinking: c.thinking,
      reasoningEffort: c.thinkingDepth,
      thinkingStyle: c.thinkingStyle,
    });
    return { ok: true, text: r.text, ms: r.ms };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/**
 * 检测模型 —— 问他填的那个接口地址「你有哪些模型」。
 *
 * ⚠️ 跟 ai:ping 是**两件事**，别合并：
 *    · ping（测试连接）= 真发一句话，验「能不能生成」—— 花钱、慢（思考模式十几秒）
 *    · models（检测模型）= GET /models，验「地址通不通 + 有哪些模型名」—— 免费、快
 *    这个按钮要的是后者：**看地址关联的模型，以及可用性**。
 *
 * ★ 2026-10-12 他报的：「应当可以先检测接口地址是否有对应模型，
 *   **而不是让用户填写 API 后才能检测**（填入 API 后是测试连接的事了）」。
 *   对 —— 这两步的前提本来就不一样。所以这里改成：
 *     ① 先**不带 Key** 问一次（本地 vLLM / Ollama 这类根本不要 Key）
 *     ② 撞 401/403 才**带上 Key** 重试
 *     ③ 还是不行 → 说人话：地址是通的，但这家要鉴权才能列模型
 *   ⚠️ 做不到「永远不填 Key 也能检测」—— 官方端点（实测 DeepSeek）不带 Key 就是 401。
 */
ipcMain.handle('ai:models', async () => {
  const c = cfg.all();
  if (!c.apiBase) return { ok: false, error: '还没填接口地址', needsBase: true };

  const bail = (err) => ({
    ok: false,
    error: err.message,
    noList: !!err.noList,
    needsKey: !!err.needsKey,
    status: err.status,
    current: c.model,
  });

  /*
   * ⚠️ 这里用返回值上报，**不能 throw** —— IPC handle 里抛出去会变成
   *    rejected promise，渲染层那边拿到的是个异常，`r.ok` 根本读不到。
   */
  try {
    try {
      const r = await provider.listModels({ base: c.apiBase, key: '' });
      return { ok: true, url: r.url, ids: r.ids, current: c.model, keyed: false };
    } catch (err) {
      const needAuth = err.status === 401 || err.status === 403;

      // ① 这家要鉴权，而且他还没填 Key → 把「地址是通的、只差钥匙」说清楚
      if (needAuth && !c.apiKey) {
        return {
          ok: false, current: c.model, needsKey: true, status: err.status,
          error: '地址是通的，但这家要鉴权才肯给模型清单 —— 填上 API Key 再点一次',
        };
      }

      // ② 要鉴权、也填了 Key → 拿 Key 重试一次
      if (needAuth) {
        try {
          const r = await provider.listModels({ base: c.apiBase, key: c.apiKey });
          return { ok: true, url: r.url, ids: r.ids, current: c.model, keyed: true };
        } catch (err2) {
          if (!(err2.status === 401 || err2.status === 403)) return bail(err2);
          return bail(Object.assign(new Error('地址通了，但 Key 不对 —— 这家不认这把钥匙'), {
            status: err2.status, needsKey: true,
          }));
        }
      }

      // ③ 别的错（连不上 / 超时 / 404 没有 /models）原样上报
      return bail(err);
    }
  } catch (err) {
    return bail(err);      // 兜底：上面任何一处漏出来的异常都别变成 rejected promise
  }
});

/* ============================================================
   字体
   ============================================================
   ⚠️⚠️ 为什么要绕这么大一圈从主进程读字节，而不是页面上直接
        `@font-face { src: url('./assets/fonts/x.ttf') }`：

        实测过 —— **file:// 下 Chromium 直接把字体加载拒了**。
        同一次实验里 `document.fonts` 报的是 `ZXFYunYuan: error`，
        `document.fonts.check()` 全程 false，两行文字宽度一模一样
        （说明根本没换字体），而且**不报错、不弹窗**。

        根因：字体请求是 **CORS 模式**的，而 `file://` 是不透明源，
        自己加载自己也得过 CORS —— 过不了。

        ⇒ 换一条根本不过网络的路径：主进程 `readFileSync` 把字节通过 IPC
          递给页面，页面用 `new FontFace(name, bytes)` 手搓一个字体加进去。
          ArrayBuffer 来源的 FontFace **不做任何 fetch**，CORS 无从谈起。

   ⚠️ 文件名要**掐死在这三个后缀**里，而且必须落在 fonts 目录内 ——
      这是从「页面」递过来的字符串，不校验就等于开了个任意文件读取的口子。
*/
const FONT_EXT = ['.ttf', '.otf', '.ttc'];

function fontFile(name) {
  const base = path.basename(String(name || ''));
  if (!FONT_EXT.includes(path.extname(base).toLowerCase())) return null;
  const full = path.join(cfg.FONTS, base);
  if (path.dirname(full) !== cfg.FONTS) return null;      // 双保险：不许跑出去
  return fs.existsSync(full) ? full : null;
}

/** 有哪些字体可选 —— 设置面板那一行的下拉就是它填的 */
ipcMain.handle('font:list', () => {
  try {
    if (!fs.existsSync(cfg.FONTS)) return [];
    return fs.readdirSync(cfg.FONTS)
      .filter((f) => FONT_EXT.includes(path.extname(f).toLowerCase()))
      .sort();
  } catch { return []; }
});

/** 把字体字节递过去（页面拿去 new FontFace） */
ipcMain.handle('font:bytes', (_e, name) => {
  const p = fontFile(name);
  if (!p) return { ok: false, error: '找不到这个字体文件' };
  try {
    return { ok: true, name: path.basename(p), bytes: fs.readFileSync(p) };
  } catch (err) {
    return { ok: false, error: '读不出来：' + err.message };
  }
});

/** 字体目录在哪 —— 设置面板里告诉他「往哪儿丢字体」 */
ipcMain.handle('font:dir', () => cfg.FONTS);

// 窗口的真实状态 —— 自检要拿它对账「页面改了配置，主进程到底落没落地」
ipcMain.handle('win:state', () => {
  if (!win) return null;
  return {
    visible: win.isVisible(),
    alwaysOnTop: win.isAlwaysOnTop(),
    focusable: win.isFocusable(),
    bounds: win.getBounds(),
    /*
     * 他多久没碰键鼠了（**秒**）。
     *
     * ⚠️ 就是 `powerMonitor.getSystemIdleTime()` 的**原样** ——
     *    不在这儿除 60。渲染层/探针要分钟自己除，但**主进程这层别做换算**：
     *    一换算就有两个地方记着"单位是分钟"，改一处忘一处。
     *    （旧工程踩过：把秒当分钟用，于是"他刚动了"被当成"他走了十分钟"。）
     */
    sysIdleSeconds: heartbeat.idleMinutes() >= 0 ? heartbeat.idleMinutes() * 60 : null,
  };
});

ipcMain.on('app:quit', () => { app.isQuitting = true; app.quit(); });

/* ============================================================
   托盘
   ============================================================ */

const trayApi = {
  toggleShow() {
    if (!win) return;
    const next = !win.isVisible();
    if (next) { win.show(); win.setAlwaysOnTop(!!cfg.get('alwaysOnTop'), 'screen-saver'); }
    else win.hide();
    cfg.set('petVisible', next);
    trayMod.refresh(cfg, trayApi);
  },
  set(k, v) {
    cfg.set(k, v);
    win?.webContents.send('cfg:changed', { key: k, value: v });
    trayMod.refresh(cfg, trayApi);
  },
  // ⚠️ 托盘项现在开的是**独立浮层窗口**，不是主窗口里的 DOM
  //    （主窗口只盖屏幕底部一条带，面板 580px 根本塞不下）
  openSettings() { overlay.open('panel', { state: { page: 'habit' } }); },
  openChat()     { overlay.open('chat'); },
  quit()         { app.isQuitting = true; app.quit(); },
};

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
    if (win) { win.show(); win.setAlwaysOnTop(!!cfg.get('alwaysOnTop'), 'screen-saver'); }
  });

  app.whenReady().then(() => {
    cfg.load();
    plog('配置目录：' + cfg.DIR);
    createWindow();
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
      if (win && !win.isDestroyed()) win.webContents.send('speak:say', String(text), o);
      plog(`[说] ${o.kind || ''} ${text}`);
    };

    /*
     * ★★ 「她说过的每一句话，都记一笔」—— 统一走这一个入口。
     *
     *   ⚠️⚠️ 为什么非要有这一步：`memory.buildSpokenBlock()` 那块
     *     「你最近自己说过的话」一直在提示词里，但**从来没人往里面写** ——
     *     `memory.addSpoken` 写好了、导出了、一次都没被调用过。
     *     结果：那块永远是空的 → 她**没有任何依据知道自己刚才说过什么**
     *     → 同一句话反复说（旧工程实测过「你 X 分钟没挪窝了」一小时说 8 遍）。
     *
     *   ⚠️ 这是**唯一**的写入点。旧工程这里是 `Add-AiSaid` ——
     *     她说每句话的唯一出口，副产物就是记下她说了什么。
     *     新工程没有那个函数，所以在这儿补一个等价物；**以后新增任何
     *     "她开口"的链，都要从这儿走**，不然那条链的复读就又没人管了。
     */
    const recordSaid = (text, kind) => {
      try { memory.addSpoken(kind || '主动', text); }
      catch (err) { plog('[说] 记「我说过什么」失败：' + err.message); }
    };

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
     * ★ 备份（每天第一次启动跑一次；记忆每周一次）。
     *
     * ⚠️ **放启动这一下、不放心跳**：
     *    放心跳的话，判断是"今天备过没有"，跑完就一直是 no-op —— 但每 5 秒
     *    去 stat 一遍目录、读一遍备份状态，纯白烧 IO。
     *    启动一次判一次，正好是旧工程那条语义（"每天第一次启动 AI 时"）。
     *
     * ⚠️ **延后 8 秒再跑**：启动那几秒她在忙着建窗口、拉天气、装托盘 ——
     *    备份要读几十个文件、还可能要打 zip，挤在一起会让她启动发涩。
     *    他也不差这 8 秒（备份是后台的事）。
     */
    setTimeout(() => {
      try {
        const r = backup.tick();
        plog(`[备份] ${r.ran ? '跑了' : '没跑'}（${r.why || '到点了'}）` +
             ` 聊天 ${r.chat} · 日志 ${r.logs}` +
             (r.memory ? ` · 记忆 ${r.memory.ok ? r.memory.files + ' 个文件' : '失败：' + r.memory.why}` : ''));
      } catch (err) {
        // ⚠️ 备份绝不能因为她别的部件有问题就带她一起挂
        plog('[备份] 出错：' + err.message);
      }
    }, 8000);

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
