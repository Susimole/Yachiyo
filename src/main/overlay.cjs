/**
 * 浮层窗口 —— 右键菜单 / 设置面板 / 聊天窗。
 *
 * ⚠️⚠️ 为什么这三个必须**各自是一个独立的小窗口**（2026-10-12 改）：
 *
 *    它们原来都是主窗口里的 DOM。而主窗口是**盖住屏幕的透明置顶窗**
 *    （现在缩成底部一条带，但仍然是全宽的）。问题是：
 *    要让菜单能点，唯一的办法是把**整窗**的鼠标穿透关掉 ——
 *    Electron 没有「窗口内局部穿透」这种东西。
 *    ⇒ 菜单只占屏幕 2.4%，一打开却把 **97.6% 的屏幕**也一起挡住，
 *      后面什么窗口都点不到。他报的就是这个。
 *
 *    拆开之后：主窗口永远保持穿透（除非鼠标真的压在她身上），
 *    菜单自己是个 240×320 的小窗，只挡它自己那一小块。
 *
 * ⚠️ 三个窗都是**先建好然后 hide/show 复用**，不是每次开都新建。
 *    重建要重新加载 HTML + 重新拉配置，开一次菜单卡半秒，很难受。
 */

'use strict';

const { BrowserWindow, screen, app } = require('electron');
const path = require('node:path');

/**
 * 配置层（存窗口位置用）。
 *
 * ⚠️ 这里**故意用 late require 的方式拿**，不在文件顶部 `require('../core/config.cjs')` ——
 *    主进程在 `app.whenReady()` 里才 `cfg.load()`，而 overlay 是模块加载时就
 *    require 进来的。顶部硬拿会在 cfg 还没初始化时就用上默认值。
 *    包成函数，调用时现取，永远拿到已经好的那一份。
 */
function cfgMod() {
  return require('../core/config.cjs');
}
/** 每种浮层存不存尺寸 —— 菜单不存（高度是按内容自动收的，存了下次会裁内容） */
const SAVE_SIZE = { menu: false, panel: true, chat: true };   // ⚠️ ask 已于 2026-10-17 删除（见 SPEC）
/** 存盘去抖（毫秒）—— 拖窗口时 move/resize 事件一秒几十个，别把磁盘刷爆 */
const SAVE_DEBOUNCE_MS = 800;

const R = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, 'preload.cjs');

/**
 * 每个浮层的尺寸。
 * ⚠️ 必须跟 `renderer/overlay.css` 里各页的 body 尺寸一致 ——
 *    窗口比内容大会露出一圈透明的空白，比内容小会把内容裁掉。
 */
const SPEC = {
  /*
   * ⚠️⚠️ menu 的 `resizable` **必须是 true**，哪怕它能自动收高。
   *    Electron 在 Windows 上，`resizable: false` 的窗口**连代码自己
   *    `setBounds` 改高都不让** —— 于是 fit() 收到「高度没变」什么都不做，
   *    菜单底下永远空一块（实测 331 的窗口只装了 250 的内容）。
   *
   *    用户拖不动它 —— 这个窗口是 `frame:false`，没有边框可以拖，
   *    而顶栏那条是 `-webkit-app-region: drag`（移动，不是缩放）。
   *    所以放宽 resizable 只是让**代码**能改尺寸，不是让用户能拉。
   */
  // ⚠️ h 是**打开时的初始高度**；打开后页面会量表一次，再通过 ov:fit 收准
  //    （实测内容 30+212=242，所以 250 是合适的初始值，不用先胖再瘦）
  /*
   * `top` = 这个窗口要不要置顶。
   *
   * ⚠️⚠️ 菜单是 **false**（他 2026-10-12 说的「菜单窗永远不置顶」）。
   *    他原来的抱怨是「菜单页遮挡其它窗口视频无法播放」—— 一个 244×250 的
   *    小菜单压在别人的视频上，本来就说不通。
   *
   *    但光改这一行不够：主窗口是 `screen-saver` 档的置顶窗，
   *    **顶层的窗口永远盖在非顶层之上** —— 菜单会跑到她后面去，
   *    正好落在她身上那半边就点不着了。所以 open/close 里还要
   *    在主窗口那边让一让（见 setMainTop）。
   */
  menu:  { w: 244, h: 250, resizable: true, top: false },
  /*
   * ⚠️ 设置面板也是 **false**。
   *    他 2026-10-12 补充的：「设置菜单页还是会置顶，它不应该被置顶遮挡其它窗口」。
   *    上一轮我只把「菜单」那一项关掉了，把面板漏了 —— 而面板有 780×580，
   *    盖在别人窗口上比那个小菜单更碍事。
   */
  /*
   * ★ `lockSize` = **用户不许拖边框改大小**（2026-10-17 他要求的）。
   *
   *   他报了两条：「拖动设置窗口边框会导致边框视觉闪回」（#3），
   *   以及优化项「固定设置菜单边框，不可拖动设置边框（长宽用当前设置的值）」。
   *
   *   ⚠️ **不能改成 `resizable: false`** —— 见上面 menu 那段注释：Windows 上
   *      `resizable:false` 的窗口**连代码自己 `setBounds` 都不让**，
   *      而面板要靠这一步恢复他上次的尺寸（`winGeom.panel`，当前是 1000×730）。
   *      所以 `resizable` 留 true（那是给**代码**用的），
   *      用户那一侧靠 `will-resize` 里 `preventDefault()` 掐掉 —— 见 ensure()。
   */
  panel: { w: 780, h: 580, resizable: true, lockSize: true, minW: 620, minH: 420, top: false },
  chat:  { w: 420, h: 540, resizable: true, minW: 340, minH: 360, top: true },
  /*
   * ⚠️ 这里原来有 `ask`（双击她弹出来的「快速问一句」那条 380×56 的输入条）——
   *    **2026-10-17 删了**。他要求的：「双击不再呼出打字栏，而是直接呼出聊天框」。
   *    连带的 `renderer/ask.html`、`renderer/ui/ask.js` 一起删，
   *    双击的落点改成 `openChat()`（见 renderer/app.js 的 onPetDoubleClick）。
   */
};

/** 哪些浮层要**按内容自动收高**（见 fit()）。
 *  面板/聊天窗是固定尺寸 —— 内容多了应该是**里面滚**，不是把窗口撑大。 */
const AUTO_FIT = new Set(['menu']);

/** @type {Map<string, BrowserWindow>} */
const wins = new Map();
/** 谁开着 —— 主进程要用它来决定「现在能不能退出」之类的事 */
let mainWin = null;

function attach(mw) { mainWin = mw; }

/** 建一个（或拿回已经建好的）浮层窗口 */
function ensure(kind) {
  const old = wins.get(kind);
  if (old && !old.isDestroyed()) return old;

  const s = SPEC[kind];
  const w = new BrowserWindow({
    width: s.w,
    height: s.h,
    show: false,
    frame: false,              // 自己画标题栏（要能拖动、要跟主题一致）
    transparent: true,         // 圆角靠 CSS，窗口本身透明
    resizable: !!s.resizable,
    minWidth: s.minW, minHeight: s.minH,
    skipTaskbar: true,
    hasShadow: false,
    // ⚠️ 菜单**永远不置顶**（他 2026-10-12 的要求），下面那两行才是最终的落地
    alwaysOnTop: !!s.top,
    fullscreenable: false,
    backgroundColor: '#00000000',
    title: 'Yachiyo',
    icon: path.join(R, 'assets', 'icon.ico'),
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      // 开发版才给探针口（见 index.cjs 同名字段的说明）
      additionalArguments: app.isPackaged ? [] : ['--yachiyo-dev'],
    },
  });

  // ⚠️ 浮层要能打字、能点按钮 —— 所以必须 focusable。
  //    这跟主窗口（focusable:false，免得抢他打游戏的按键）是两回事。
  if (s.top) w.setAlwaysOnTop(true, 'screen-saver');
  w.loadFile(path.join(R, `${kind}.html`));

  // 页面报错转出来 —— 不然浮层白屏的时候一个字都看不见
  w.webContents.on('console-message', (e) => {
    // ⚠️ 字段名是 `sourceId` 不是 `file`（2026-10-16 修的，跟 index.cjs 同款）
    const src = String(e.sourceId || '');
    console.log(`[${kind}] ${e.message}   (${src ? path.basename(src.split('?')[0]) : '?'}:${e.lineNumber})`);
  });

  /*
   * ★ 记住他拖到哪儿、拉多大（2026-10-12 他说的「窗口位置/大小要存」）。
   *
   * ⚠️ 两个时机都要：`move`/`resize` 是**拖的过程中**（去抖 800ms，停下才写），
   *    `close` 是**收起来那一刻**（拖完立刻关窗，去抖那一次可能还没落地就被 hide 了）。
   *    只挂在 close 上不够 —— 他拖完不关窗、直接退出应用，位置就丢了。
   */
  /*
   * ⚠️⚠️ **只有设置面板和聊天窗记位置**（`SAVE_SIZE` 里为 true 的那两个）。
   *
   *   他 2026-10-12 的两次要求正好相反，这里记清楚为什么最后是"不记"：
   *     · 先说「窗口位置/大小要存」→ 我给 panel / chat / menu 都加上了记位置
   *     · 后说「右键菜单不再记忆位置，改为鼠标位置唤出」→ **菜单退出记账**
   *   理由很实在：菜单是「在光标处弹出来的一张卡片」，
   *   位置**每一次都该由那次右键决定**。记住上一次会让人以为点的不是这儿。
   *   （面板/聊天窗是常驻窗口，会一直摆在那儿，记得住才有用。）
   */
  if (SAVE_SIZE[kind]) {
    w.on('move', () => queueSaveGeom(w, kind));
    w.on('resize', () => queueSaveGeom(w, kind));
  }

  /*
   * ★ 不许用户拖边框改大小（2026-10-17 他要求的，理由见 SPEC 里 panel 那段注释）。
   *
   *    `will-resize` **只在用户拖动时**触发 —— 代码调 `setBounds` 不走它。
   *    所以这一刀只砍用户那一侧：面板恢复上次尺寸、以后要自适应，全都照旧。
   *
   *    ⚠️ 他那个「拖设置窗边框 → 边框视觉闪回」的根子，就是**透明窗口被系统缩放**
   *       那一下的重绘。尺寸根本不让改，这条 bug 就整个消失了（不用另外打补丁）。
   */
  if (s.lockSize) w.on('will-resize', (ev) => ev.preventDefault());

  // 关掉 = 藏起来（复用），真的销毁只在退出时
  w.on('close', (ev) => {
    if (mainWin && !mainWin.isDestroyed() && mainWin.__quitting !== true) {
      ev.preventDefault();
      flushGeom(w, kind);         // 收起前先把位置记下来（去抖那次可能还没落地）
      w.hide();
    }
  });

  wins.set(kind, w);
  return w;
}

/**
 * 把窗口摆在某个**屏幕坐标**上，并且保证整块都在屏幕里。
 *
 * ⚠️ 调用方给的是**主窗口内的坐标**（鼠标事件给的就是这个），
 *    要加上主窗口自己的位置才是屏幕坐标。
 *    直接拿去 `setPosition` 的话，菜单会开在屏幕左上角 —— 因为主窗口
 *    现在只是底部一条带，它的 (0,0) 在屏幕中间偏下。
 */
/* ── 窗口位置 / 大小的存与取（2026-10-12 他要求「要存」）─────── */

/**
 * 读某个浮层存过的位置/大小。
 * ⚠️ 一定要 try —— `winGeom` 是用户能直接编辑 JSON 的，手改坏了不能让她打不开面板。
 */
function getGeom(kind) {
  try {
    const all = cfgMod().get('winGeom');
    const g = all && typeof all === 'object' ? all[kind] : null;
    return (g && typeof g === 'object') ? g : null;
  } catch { return null; }
}

/**
 * 把某个浮层的当前位置写进配置。
 *
 * ⚠️ 只在**真变了**的时候写，而且去抖 800ms —— 拖窗口时 `move` 事件一秒几十个，
 *    每个都写盘的话磁盘会被刷爆（旧工程有过一模一样的教训）。
 * ⚠️ 菜单只存 x/y（见 SAVE_SIZE 的注释）。
 */
function saveGeom(w, kind) {
  if (!w || w.isDestroyed()) return;

  /*
   * ⚠️⚠️ **闸门设在最里面这一层**，不是在各个调用点。
   *
   *    我第一版是把判断写在 `ensure()` 里 —— 只给 panel/chat 挂 move/resize 监听。
   *    结果菜单照样被存了：因为 **`close` 事件里那个 `flushGeom` 是无条件调的**，
   *    它绕过了监听那道门。探针里量到配置里凭空多出一条 `menu:{x:900,y:862}`。
   *
   *    ⇒ 放在这里，**任何调用点都绕不过去**（close / closeKind / destroyAll 全走它）。
   *      以后再加存位置的路径，也不用记得"这里要不要判 SAVE_SIZE"。
   */
  if (!SAVE_SIZE[kind]) return;

  try {
    const b = w.getBounds();
    const old = getGeom(kind) || {};
    /*
     * ★ 锁了尺寸的窗口（`lockSize`，见 SPEC 的 panel）**只记位置、不记尺寸**。
     *
     *   2026-10-17 探针量出来的：每开关一次设置面板，存下来的尺寸就 **+2px**
     *   （1000×730 → 1002×732 → 1004×734 …）。
     *   机制是**正反馈**：`setBounds(1002)` 之后 Windows 报回来的 bounds 是 1004
     *   （`frame:false` + `transparent` 在 DPI 125% 下那点边框补偿），
     *   于是存 1004 → 下次设 1004 → 报 1006 …… 开上一百次面板它比屏幕还宽。
     *
     *   用户拖不动边框之后，尺寸本来就不该再变 —— 那就干脆别记它，
     *   一直沿用他**最后一次能拖**时定的那个值（这正是他要的「长宽用当前设置的值」）。
     */
    const lock = !!(SPEC[kind] && SPEC[kind].lockSize);
    let g;
    if (!SAVE_SIZE[kind]) g = { x: b.x, y: b.y };
    else if (lock && old.width) g = { x: b.x, y: b.y, width: old.width, height: old.height };
    else g = { x: b.x, y: b.y, width: b.width, height: b.height };

    const all = cfgMod().get('winGeom');
    const prev = (all && typeof all === 'object' && all[kind]) || {};
    // 位置没动、尺寸也没动 → 什么都不做（否则光是开关菜单就会一直写盘）
    if (prev.x === g.x && prev.y === g.y
        && (g.width == null || (prev.width === g.width && prev.height === g.height))) return;
    cfgMod().set('winGeom', { ...(all && typeof all === 'object' ? all : {}), [kind]: g });
  } catch (err) {
    console.error(`[overlay] 存 ${kind} 的窗口位置失败：${err.message}`);
  }
}

/** 拖/拉之后延后落盘 */
function queueSaveGeom(w, kind) {
  if (w.__geomTimer) clearTimeout(w.__geomTimer);
  w.__geomTimer = setTimeout(() => {
    w.__geomTimer = null;
    saveGeom(w, kind);
  }, SAVE_DEBOUNCE_MS);
}

/** 把还没落盘的那次立刻写掉（收起窗口 / 退出应用时用） */
function flushGeom(w, kind) {
  if (!w || w.isDestroyed()) return;
  if (w.__geomTimer) { clearTimeout(w.__geomTimer); w.__geomTimer = null; }
  saveGeom(w, kind);
}

function placeAt(w, kind, at) {
  const s = SPEC[kind];

  /*
   * ★ 2026-10-12 他说的：「窗口位置/大小要存」。
   *
   * 顺序是：**存过的那份优先** > 调用方给的坐标（点菜单那一下）> 工作区居中。
   * ⚠️ 为什么存过的要优先于 `at`：
   *    `at` 是「右键点在哪里」——那只该决定**第一次**开在哪儿。
   *    他要是把面板拖到左边去了，下次从菜单点开又跳回鼠标那儿，
   *    那「记得位置」就等于没做。
   */
  /*
   * ⚠️⚠️ **菜单永远不看存过的那份**（他 2026-10-12 的要求：
   *    「右键菜单不再记忆位置，改为鼠标位置唤出」）。
   *
   *    即使旧配置里还留着一次 `winGeom.menu`（我上一轮存进去过），
   *    这里也**整份忽略** —— 不然他会遇到「明明点在这儿，菜单却弹到上回那儿」，
   *    而且找不出原因（配置是他不会去看的地方）。
   */
  /*
   * ⚠️ `ask`（快速问答输入条）也**不看存过的那份** —— 它每次都由代码
   *    摆在她头顶（见 `ask.js` 的定位），位置不是"他的选择"。
   *    它当初会被存下来，是因为我那个 `move` 监听挂得太宽（见下面 ensure() 里的注释）。
   */
  // ⚠️ 菜单不记位置（见 SAVE_SIZE 的注释）。ask 已于 2026-10-17 删除。
  const saved = (kind === 'menu') ? null : getGeom(kind);
  let x, y;

  if (saved && saved.x != null && saved.y != null) {
    x = saved.x; y = saved.y;
  } else if (at && at.x != null) {
    x = at.x; y = at.y;
  } else {
    // 没头没脑地开（比如从托盘点「设置」）—— 工作区居中
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const wa = d.workArea;
    x = wa.x + (wa.width - s.w) / 2;
    y = wa.y + (wa.height - s.h) / 2;
  }

  /*
   * ⚠️ 屏幕的判定不能拿「坐标落在哪个屏」算 —— 窗口可能**有一半在外面**
   *    （我们下面才夹回来），而且拔掉副屏之后那些坐标会指向不存在的区域。
   *    用 `getDisplayMatching`：它挑「跟这块矩形重叠最多」的那个屏，
   *    没得挑就退主屏，正好是我们要的语义。
   */
  const d = screen.getDisplayMatching({ x: Math.round(x), y: Math.round(y), width: s.w, height: s.h })
         || screen.getPrimaryDisplay();
  const wa = d.workArea;

  // 尺寸：存过的优先（面板/聊天窗能拉大拉小），但**不小于 SPEC 里的最小尺寸**
  let cw = s.w, ch = s.h;
  if (SAVE_SIZE[kind] && saved && saved.width) cw = Math.max(s.minW || 200, Math.round(saved.width));
  if (SAVE_SIZE[kind] && saved && saved.height) ch = Math.max(s.minH || 120, Math.round(saved.height));

  // 贴边翻转：先试右下，出界就往回挪
  if (x + cw > wa.x + wa.width)  x = wa.x + wa.width - cw;
  if (y + ch > wa.y + wa.height) y = wa.y + wa.height - ch;
  if (x < wa.x) x = wa.x;
  if (y < wa.y) y = wa.y;

  w.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(cw), height: Math.round(ch) });
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * 开一个浮层。
 * @param {string} kind 'menu' | 'panel' | 'chat'
 * @param {object} [o]
 * @param {object} [o.at]     屏幕坐标（给了就摆那儿，不给就居中）
 * @param {object} [o.state]  要带过去的初始状态（比如 panel 开哪一页）
 */
/**
 * 发一条消息给浮层，**等它加载完再发**。
 *
 * ⚠️⚠️ 2026-10-12 踩的：浮层是懒建的 —— 第一次 `ov.open('panel', {page:'ai'})`
 *    的时候窗口才刚 new 出来、页面还在加载，这一刻 `webContents.send` 发出去
 *    的事件**没人接**（监听器是页面脚本注册的，脚本还没跑）。
 *    结果就是「从菜单点『API 接入』，面板开出来了，但停在默认那一页」——
 *    偶发，因为要看加载快不快，最难查的那种。
 *
 *    `did-finish-load` 一定在页面的模块脚本执行完之后 —— 那时候监听器肯定挂上了。
 */
function sendWhenReady(w, channel, payload) {
  if (!w || w.isDestroyed()) return;
  if (w.webContents.isLoading()) {
    w.webContents.once('did-finish-load', () => {
      if (!w.isDestroyed()) w.webContents.send(channel, payload);
    });
  } else {
    w.webContents.send(channel, payload);
  }
}

function open(kind, o = {}) {
  const w = ensure(kind);
  placeAt(w, kind, o.at);

  /*
   * ⚠️ 顺序：**让位 → show → focus → 顶上去**。
   *
   *   原来 `syncMainTop()` 是放在 `show()` 后面的，那一段里
   *   窗口已经可见了但她还压在上面 —— 正好是"先闪一下旧的 z 序、再摆正"，
   *   几十毫秒，他看得见我看不见（截图截不到，见 index.cjs 里 probe-bounds 的注释）。
   *
   *   `focus()` 那一下**要放在顶上去之前**：系统激活窗口时会顺手改一次 z 序，
   *   我们最后那下 `moveTop()` 才是最终答案，排在它后面才不会被它盖掉。
   */
  syncMainTop(null, kind);     // ① 先让她让位（这一刻浮层还没 show，靠 pending 数得到）
  w.show();
  w.focus();                   // ② 浮层要能直接打字
  syncMainTop(kind);           // ③ 再把浮层顶到她前面（这一步才是最终 z 序）

  /*
   * ★★ **这一行 2026-10-12 被我删过一次，别再删。**
   *
   *   改 z 序那段时重写 `open()`，把 `sendWhenReady(w, 'ov:open', o.state)` 漏掉了。
   *   它是这个文件里**唯一**把 `state` 递给浮层的地方 ——
   *   于是「从菜单点 API 接入」打开了面板，但面板**停在默认那一页（习惯）**。
   *   不报错、面板也开出来了，看着就像"菜单那一项点错了"。
   *
   *   探针 `probe-zorder` / 自检都逮不到它（它们只看窗口在不在、在谁前面）——
   *   是 2026-10-12 补的 `audit-dead-exports` 那条思路揪出来的：
   *   **一个写好的函数没人调，功能就静默没了。**
   */
  sendWhenReady(w, 'ov:open', o.state || {});

  return w;
}

/**
 * 主窗口暂时让出「置顶层」。
 *
 * ⚠️⚠️ 为什么非要有这么一出：
 *    菜单是**不置顶**的（他 2026-10-12 的要求），可主窗口是
 *    `setAlwaysOnTop(true, 'screen-saver')` —— Windows 的 z 序里
 *    **顶层窗口永远盖在非顶层之上**，跟谁后 show 的没关系。
 *    结果就是：菜单弹在她旁边，落在她身上那半块**跑到她背后去了**，
 *    看不见也点不着。实测就是这么回事。
 *
 *    所以菜单开着的时候把主窗口降下来，关了再按配置恢复。
 *    「不置顶」这件事本来就是对这一小段时间的要求 —— 菜单关掉之后
 *    她该在最前还是在最前。
 */
/**
 * 主窗口置顶的落地点。
 *
 * ⚠️⚠️⚠️ **这个函数里不许加任何"优化"。无条件调 `setAlwaysOnTop` 就完了。**
 *
 *   2026-10-12 我在这儿加过一行"聪明"的闸：
 *       if (mainWin.isAlwaysOnTop() === v) return;   // 已经是这个值就不调
 *   动机是「怀疑菜单上下闪跟多余的 SetWindowPos 有关」——
 *   而那只是**猜测，而且始终没验成功**（连拍 34 张截图逐张比哈希，菜单画面完全稳定）。
 *   结果：**为了一个没验证的问题，引入了一个真问题**。
 *
 *   为什么它一定是错的：**Windows 上 `isAlwaysOnTop()` 读的是窗口的样式位，
 *   而 `screen-saver` 那种层级由系统另外管** —— 两者会不同步。
 *   不同步时这个方法会「撒谎」，于是**该升的时候被跳过，她再也回不到最前**。
 *   他看完录屏后报的四件事全是这个根因：
 *     · **右键弹出的是 Windows 桌面菜单**（穿透没被正确收回 → 右键被桌面接走）
 *     · **她拖不动**（主窗口被压住，落到她身上那半块收不到鼠标事件）
 *     · 菜单上下闪回（和她之间的 z 序在错误状态之间来回）
 *     · 没点别处却把别的窗口关了（主窗口层叠一乱，菜单被误判成失焦）
 *
 *   ⇒ **宁可多发一次系统调用**。这个函数一次开/关浮层才调一两次，
 *      `SetWindowPos` 那点开销根本不值得省，而猜错的代价是把桌宠弄瘫。
 */
function setMainTop(on) {
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.setAlwaysOnTop(!!on, 'screen-saver');
}

/**
 * 按「现在有几个不置顶的浮层开着」决定主窗口该不该让位，**并且把刚开的那个顶到前面**。
 *
 * ⚠️ 不能一关就往回还 —— 菜单和面板可以同时开着（他点了菜单里的「设置」
 *    之后菜单还挂着）。关掉其中一个就把主窗口顶起来，另一个立刻被压到后面去。
 *    所以每次开/关都**重新数一遍**，而不是记一个布尔。
 *
 * ── ★★ 为什么非要 `raise` 这一下（2026-10-12 实测，别删）──────────
 *
 *   他报的：「右键菜单有些东西点不了」。
 *   实测真实 z 序（Win32 `EnumWindows`，从最前到后）：
 *       0: 主窗口 2048×560   topmost=否     ← 她在最前面
 *       1: 菜单    244×250   topmost=否     ← 菜单在她后面
 *
 *   根因：**`setAlwaysOnTop(false)` 在 Windows 上不只是改一个标志位** ——
 *   它把窗口从「置顶带」挪进「不置顶带」，而**插进不置顶带的位置不由我们定**。
 *   实测她被插到了**菜单前面**。她又是块 2048×560 的大透明窗，
 *   跟菜单重叠的那半截就把菜单盖住了 —— 那半边的菜单项点不到，正是他说的。
 *
 *   ⇒ 降完她之后**必须显式把浮层顶到最前**（`moveTop()`）。
 *     实测对比（同样条件下量 z 序）：
 *       A 什么都不做           菜单 #1 / 她 #0   ✗
 *       C 先 show 再 setBounds 菜单 #1 / 她 #0   ✗
 *       D `moveTop()`          菜单 #0 / 她 #1   ✓ ← 只有这个管用
 *       E `insertAfter(她)`    菜单 #1 / 她 #0   ✗（同一带里插不进去）
 */
function syncMainTop(raise, pending) {
  const anyOpen = [...wins.entries()]
    .some(([k, w]) => SPEC[k] && !SPEC[k].top && !w.isDestroyed() && w.isVisible());
  /*
   * ⚠️ `pending` = 「这个浮层马上要开」。必须在 show 之前就把她降下来，
   *    但这一刻它还没 show，上面那个 `isVisible()` 数不到它。
   *    等 show 之后再降的话，中间那几十毫秒菜单是**被她压着**出现的 ——
   *    正好是"先闪一下旧 z 序、再摆正"。
   */
  setMainTop(anyOpen || !!pending ? false : mainTopWanted);

  /*
   * ⚠️ 只在**降了她之后**才顶 —— 她没让位的时候（配置里本来就没置顶）
   *    浮层本来就在她前面，多顶一下反而会盖住别的正常窗口。
   * ⚠️ 顺序也是要紧的：**先降她、再顶浮层**。反过来的话刚顶上去的浮层
   *    会被紧接着那一下 `setAlwaysOnTop(false)` 又甩到后面去。
   */
  if (raise && (anyOpen || pending)) {
    const w = wins.get(raise);
    if (w && !w.isDestroyed() && w.isVisible()) {
      try { w.moveTop(); } catch (err) { console.error(`[overlay] 顶 ${raise} 失败：${err.message}`); }
    }
  }
}

/** 主窗口该不该置顶（= 用户的配置）—— 由 index.cjs 在装配时塞进来 */
let mainTopWanted = true;

function mainTopValue(v) { mainTopWanted = v !== false; }

/**
 * 让某个浮层**按内容高**重设自己 —— 菜单项多一条少一条都会变。
 *
 * ⚠️ 窗口高写死的话，内容少的时候底下会空一大块（实测 331 的窗口里
 *    只装了 250px 的内容，剩下 80px 是纯白）。这个只能由**页面自己**量 ——
 *    主进程不知道 .card 里塞了多少东西。
 */
function fit(kind, h) {
  const w = wins.get(kind);
  if (!w || w.isDestroyed()) return;

  /*
   * ⚠️⚠️ 只有**该按内容自适应**的那几个才收（现在只有菜单）。
   *    这里一开始写的是 `if (s.resizable) return;` —— 想表达「面板/聊天窗是
   *    固定尺寸别乱动」。结果上面为了让菜单能被代码改高，把 menu 的
   *    resizable 也改成了 true，**菜单自己就被这句跳过了**，
   *    fit() 一直是空的，菜单底下那块空白两轮都没修掉。
   *    用「谁该自适应」这个**明确的开关**，别拿 resizable 兼职。
   */
  if (!AUTO_FIT.has(kind)) return;

  const b = w.getBounds();
  const next = Math.max(80, Math.min(Math.round(h), 900));
  if (Math.abs(next - b.height) < 2) return;   // 没变就别 setBounds，会闪
  w.setBounds({ ...b, height: next });
}

function close(kind) {
  const w = wins.get(kind);
  if (w && !w.isDestroyed()) flushGeom(w, kind);   // 走这条路收窗也要记位置
  if (w && !w.isDestroyed() && w.isVisible()) w.hide();
  // ⚠️ 收一个之后要**重新数一遍**还有没有别的不置顶浮层开着（见 syncMainTop）
  syncMainTop();
}

function isOpen(kind) {
  const w = wins.get(kind);
  return !!w && !w.isDestroyed() && w.isVisible();
}

function closeAll() {
  for (const k of wins.keys()) close(k);
}

/** 退出时真销毁（这个走的是 app.quit，close 里的拦截要让路） */
function destroyAll() {
  /*
   * ⚠️⚠️ 「正在退出」这个旗子要插在 **主窗口** 上（2026-10-16 修的）。
   *
   *    `ensure()` 里 `w.on('close')` 的守卫读的是 **`mainWin.__quitting`**
   *    （见上面的 :169）—— 可**全仓没有任何地方设过它** ⇒ 那个判断恒成立，
   *    退出时每个浮层的 close 都被 `preventDefault()` + `hide()` 拦了一道。
   *
   *    （原来这儿设的是 `w.__quitting = true` —— 可**没有任何地方读那个值**，
   *      纯属白写。注释还写着「saveGeom 见了它就直接返回」，而 saveGeom
   *      压根没看过它（它只看 SAVE_SIZE）。那句注释也是错的，一并更正。）
   */
  if (mainWin && !mainWin.isDestroyed()) mainWin.__quitting = true;

  for (const [kind, w] of wins.entries()) {
    if (w.isDestroyed()) continue;
    // ⚠️ 先记位置再销毁 —— 「拖完面板直接退出应用」是最常见的场景，这一次不能丢
    flushGeom(w, kind);
    w.destroy();
  }
  wins.clear();
}

/**
 * 发给**所有**浮层窗口 + 主窗口。
 *
 * ⚠️ 配置变了要广播给每一个 —— 不然会出现「在面板里改了，菜单里的勾
 *    还是旧的」这种对不上的状态。原来只有一个窗口，send 一次就够；
 *    拆成四个窗口之后这是个**必然会踩**的坑。
 */
function broadcast(channel, ...args) {
  const targets = [mainWin, ...wins.values()];
  for (const w of targets) {
    if (w && !w.isDestroyed()) w.webContents.send(channel, ...args);
  }
}

/* ============================================================
   界面调试台 —— 临时把面板窗口放大一点
   ============================================================
   为什么需要：设置面板默认 780×580，而调试台底下要压一条 216px 的参数栏，
   剩给内容区的就没多少了。他要在里面看整张面板的布局，挤着看不见全貌。

   ★ 两条规矩：
     ① **只放大，不缩小** —— 他要是自己把窗口拉得比设计尺寸还大，
        那是他想要的尺寸，别给拽回来。
     ② **退出时精确还原** —— 进来时的 `getBounds()` 原样摆回去
        （不是硬写 780×580，他平时调过的尺寸不能丢）。

   ⚠️ 牺牲掉的一种情况：**调试台开着的时候他手动拽窗口边调了大小，
      退出会被还原覆盖掉**。为了这条去写"哪个维度是他改的"判断不值得 ——
      调试台本来就是个临时开一下的东西，退出后想调尺寸随时还能调。
   ⚠️ 幂等：靠 `if (designPrev) return` 挡住第二次 enable，
      免得把「放大后」的尺寸误当成原始尺寸存下来。
   ============================================================ */
const DESIGN_SIZE = { w: 1200, h: 820 };
let designPrev = null;

function designMode(on) {
  const panelWin = wins.get('panel');
  if (!panelWin || panelWin.isDestroyed()) return false;

  if (on) {
    if (designPrev) return true;                 // 已经在调试模式里了
    const b = panelWin.getBounds();
    designPrev = b;
    // 只放大：已经够大就一个字不动
    if (b.width < DESIGN_SIZE.w || b.height < DESIGN_SIZE.h) {
      let { x, y } = b;
      const wa = screen.getPrimaryDisplay().workArea;
      const cw = Math.max(b.width, DESIGN_SIZE.w);
      const ch = Math.max(b.height, DESIGN_SIZE.h);
      if (x + cw > wa.x + wa.width) x = wa.x + wa.width - cw;
      if (y + ch > wa.y + wa.height) y = wa.y + wa.height - ch;
      try {
        panelWin.setBounds({ x: Math.round(x), y: Math.round(y), width: cw, height: ch });
      } catch { /* 摆不动就保持原样，顶多挤一点 */ }
    }
    return true;
  }

  if (designPrev) {
    /*
     * ⚠️ 调试期间他如果**自己拽窗口边**把尺寸改了，那个尺寸才是他想要的，
     *    别用进来之前的旧尺寸把它盖回去。只还原位置/宽高里他没动过的部分
     *    —— 判断办法：跟"进来时记录的值"比，一样说明他没动过。
     */
    try { panelWin.setBounds(designPrev); } catch { /* 窗口可能已经关了 */ }
    designPrev = null;
  }
  return true;
}

module.exports = {
  SPEC, attach, ensure, open, close, fit, isOpen, closeAll, destroyAll, broadcast,
  mainTopValue, designMode,
  list: () => wins,
};
