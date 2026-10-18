/**
 * preload —— 主进程和页面之间唯一的桥。
 * 页面里碰不到 Node，只能用这里列出来的东西。
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * 现在跑的是开发版还是打包版？
 *
 * ⚠️⚠️ **绝对不能用 `require('electron').app.isPackaged`**（2026-10-13 踩的）：
 *    preload 跑在**沙箱**里，那里的 `require('electron')` **只有
 *    `contextBridge` / `ipcRenderer` 两个东西**，没有 `app`。
 *    写成 `app.isPackaged` 会当场抛 `Cannot read properties of undefined`，
 *    而 Electron 对这个错误的处理方式是 —— **静默放弃整个 preload 脚本**：
 *         Unable to load preload script: ...\preload.cjs
 *    ⇒ `window.yachiyo` 整个不存在 ⇒ 气泡、配置、事件**全线失灵**，
 *      但主进程照常跑、不报致命错，只有渲染层的 console 里有一行提示。
 *      **这个坑是探针抓出来的**：`typeof window.yachiyo === 'undefined'`。
 *
 * ★ 判据由**主进程显式传**（见 index.cjs / overlay.cjs 的 `additionalArguments`）——
 *   那边 `app.isPackaged` 是可靠的，这边只管读。
 *   ⚠️ 别退回去自己猜：`process.execPath` 在沙箱里实测**判不出**开发版
 *      （试过，`DEV` 永远是 false，探针口静默不挂）。
 */
const DEV = (process.argv || []).includes('--yachiyo-dev');

contextBridge.exposeInMainWorld('yachiyo', {
  /**
   * ★ **只给页面看的一个标记**：现在跑的是开发版吗。
   *
   * 设置面板拿它决定「界面调试台」那颗按钮挂不挂 —— 正式版里**根本不出现**，
   * 而且调试台那个模块（ui/design.js）走的是动态 import，正式版连加载都不加载。
   *
   * ⚠️ 它必须在**顶层**（跟 cfg / win / ov 平级）。我第一版顺手写在 `ov:` 里面了，
   *    页面读 `window.yachiyo.dev` 永远是 undefined ⇒ 开发版里按钮也不见了。
   */
  dev: DEV,

  /* ---------- 配置 ---------- */
  cfg: {
    all:   ()      => ipcRenderer.invoke('cfg:all'),
    set:   (k, v)  => ipcRenderer.invoke('cfg:set', k, v),
    patch: (obj)   => ipcRenderer.invoke('cfg:patch', obj),
    reset: ()      => ipcRenderer.invoke('cfg:reset'),
    dir:   ()      => ipcRenderer.invoke('cfg:dir'),
  },

  /* ---------- 窗口 ---------- */
  win: {
    /**
     * 鼠标穿透：true = 点得到桌面（她挡着的地方不挡人）。
     * ⚠️ 别每次鼠标一动就调 —— 页面里先跟自己上次的状态比一遍，变了才发。
     *    这个 IPC 会走一趟主进程 setIgnoreMouseEvents，每帧调会卡。
     */
    ignoreMouse:  (on) => ipcRenderer.send('win:ignore-mouse', on),
    hide:         ()       => ipcRenderer.send('win:hide'),
    quit:         ()       => ipcRenderer.send('app:quit'),
    openSettings: ()       => ipcRenderer.send('win:open-settings'),
    /** 屏幕信息 —— 页面拿它来算她能走多远 */
    screen:       ()       => ipcRenderer.invoke('win:screen'),
    /** 窗口的真实状态（显隐 / 置顶 / 可聚焦）—— 自检拿来对账主进程落没落地 */
    state:        ()       => ipcRenderer.invoke('win:state'),
    /** 把她叫到最前面（点托盘图标时用） */
    focus:        ()       => ipcRenderer.send('win:focus'),
    /** 面板开了要能打字 → 放开键盘焦点；关面板立刻收回去 */
    focusable:    (on)     => ipcRenderer.send('win:focusable', on),
    /**
     * 让主进程按画布重算舞台窗口（`resizeStage()`）。
     *
     * ⚠️ 主进程**早就注册了** `win:setStage`，可 preload 这边一直没暴露
     *    （2026-10-16 补的）—— `app.js:117` 那句 `window.yachiyo.win.setStage()`
     *    抛 TypeError，被它自己的 `try/catch` 吞掉，**一声不响**：
     *    初始缩放 / 高 DPI 变化 / 换显示器时，舞台根本不会跟着调。
     *    （改桌宠大小时走的是另一条路 `win:stage`，所以只有那几个场景露馅。）
     */
    setStage:     ()       => ipcRenderer.invoke('win:setStage'),
    /**
     * 在资源管理器里打开一个自己的目录（备份 / 配置 / 数据 / 日志）。
     * ⚠️ 主进程那边只认白名单里的四个，**只允许 cfg.DIR 底下** ——
     *    这个能力要是开了口子等于把整台机器的文件系统递出去。
     */
    reveal:       (kind)   => ipcRenderer.invoke('app:reveal', kind),
  },

  /* ---------- 聊天 ---------- */
  chat: {
    send:    (text) => ipcRenderer.invoke('chat:send', text),
    /**
     * 快速问一句（双击她弹出来的那条）。
     * ⚠️ 跟 send 的区别是**推的事件不一样**：这条走 bubble:*，
     *    由主窗口接住冒在气泡上，聊天窗一个字都不进。
     *
     * ⚠️ 2026-10-17：「快速问一句」那个界面（`ask.html` / `ui/ask.js`）**删了** ——
     *    双击她改成直接开聊天窗。这条 IPC 因此**暂时没有调用方**，留着备用；
     *    要复活它的话，先想清楚「只问不记」这件事值不值得（见 app.js 里那段注释）。
     */
    sendQuick: (text) => ipcRenderer.invoke('chat:send-quick', text),
    abort:   ()     => ipcRenderer.send('chat:abort'),
    history: ()     => ipcRenderer.invoke('chat:history'),
    clear:   ()     => ipcRenderer.send('chat:clear'),
  },

  /* ---------- 字体 ---------- */
  font: {
    /** `%APPDATA%\Yachiyo\fonts\` 里有哪些字体文件 */
    list:  ()     => ipcRenderer.invoke('font:list'),
    /** 取某个字体的字节（页面拿去 new FontFace）—— 见 main/index.cjs 的长注释 */
    bytes: (name) => ipcRenderer.invoke('font:bytes', name),
    dir:   ()     => ipcRenderer.invoke('font:dir'),
  },

  /* ---------- 她 ---------- */
  pet: {
    /**
     * 他碰她了（点 / 双击 / 拖）—— 把她从「准备睡」里叫醒。
     *
     * ⚠️ 叫的是**主进程那层**睡（`review.isSleeping()`）—— `ui/bubble.js` 的
     *    「睡着了一个气泡都不冒」闸的就是它，`chat:send` 也会拿它回「她睡了」。
     *    视觉那层睡姿归渲染层的 `wakeUp()` 管，两码事，都得叫。
     */
    wake: () => ipcRenderer.send('pet:wake'),
  },

  /* ---------- 用量与成本 ---------- */
  usage: {
    get:   () => ipcRenderer.invoke('usage:get'),
    reset: () => ipcRenderer.invoke('usage:reset'),
    /**
     * 图上那几种粒度的数据（2026-10-17 加的，配设置面板那张走势图）。
     * @param {'day'|'week'|'month'} range 日 = 近 24 小时（按小时）· 周 = 近 7 天 · 月 = 近 30 天
     */
    series: (range) => ipcRenderer.invoke('usage:series', range),
  },

  /* ---------- AI 服务商预设（2026-10-17 加的）----------
   * ⚠️ `activate` 会**把那份值写回 config**（见 core/providers.cjs），
   *    所以切完必须**重新读一次**地址/Key/模型三行 ——
   *    别拿页面里那份旧的 CFG 去显示，那是上一家的。
   */
  providers: {
    list:     ()          => ipcRenderer.invoke('providers:list'),
    current:  ()          => ipcRenderer.invoke('providers:current'),
    save:     (id, patch) => ipcRenderer.invoke('providers:save', id, patch),
    activate: (id)        => ipcRenderer.invoke('providers:activate', id),
    add:      (name)      => ipcRenderer.invoke('providers:add', name),
    remove:   (id)        => ipcRenderer.invoke('providers:remove', id),
  },

  weather: {
    /** force=true 是真去网上打一次（不带就吃缓存 + 退避） */
    get: (force) => ipcRenderer.invoke('weather:get', !!force),
  },

  /* ---------- AI 接入 ---------- */
  ai: {
    /** 拿真 key 问一句最短的，验通了才算数（花钱、慢） */
    ping: () => ipcRenderer.invoke('ai:ping'),
    /** 问接口地址有哪些模型（GET /models，免费、快） */
    models: (o) => ipcRenderer.invoke('ai:models', o),
  },

  /* ---------- 骨架参数（每个姿态各自那套） ---------- */
  rig: {
    /** 读五个姿态当前的倾斜角 `{ idle, walk, run, sit, sleep }` */
    tilts: () => ipcRenderer.invoke('rig:tilts'),
    /** 改其中几个 —— 会写回 rig.json，并广播让主窗口现改内存 */
    setTilts: (patch) => ipcRenderer.invoke('rig:set-tilts', patch),
  },

  /* ---------- 浮层（菜单 / 面板 / 聊天窗） ---------- */
  ov: {
    /**
     * 开一个浮层。
     * @param {'menu'|'panel'|'chat'} kind
     * @param {object} [state] 带过去的状态；`state.at` 是**发起方窗口内**的坐标，
     *                         主进程会换成屏幕坐标（菜单要跟着鼠标弹）
     */
    open:  (kind, state) => ipcRenderer.invoke('ov:open', kind, state),
    /** 关掉**发起这次调用的那个浮层窗口**（浮层自己关自己） */
    close: ()            => ipcRenderer.send('ov:close'),
    /** 量好了内容高就叫一声，窗口跟着收 */
    fit: (h) => ipcRenderer.send('ov:fit', h),
    /** 按名字关某一个（主窗口点她的时候要收掉菜单） */
    closeKind: (kind)    => ipcRenderer.send('ov:close-kind', kind),
    /** 某个浮层开着没有 —— 独立窗口的显隐只有主进程知道 */
    isOpen: (kind)       => ipcRenderer.invoke('ov:is-open', kind),
    /** 浮层窗口的真实状态（开着没 / 置顶没 / 摆在哪）—— 自检量「菜单不置顶」用 */
    info:   (kind)       => ipcRenderer.invoke('ov:info', kind),
    /*
     * ★★ **下面这一整块只在开发版挂**（`DEV` 见文件头）——
     *    打包出去给别人的版本里，这几个键根本不存在。产品流程一次都不调它们。
     *
     * ⚠️⚠️ 这一族**漏过两次**，两次都是同一个原因：新加的口子没往这个 spread 里放。
     *      · 2026-10-14：`probeRaise` / `probeBounds` 漏在外面
     *      · 2026-10-16：调试台的 `design*` 六个键漏在外面
     *        —— 其中 `design:put` 是个**写文件**的通道
     *    两次都实测到：打包版的 `preload.cjs` 里搜得到这些名字。
     *    ⇒ 以后加口子，**先问一句「这个正式版要不要有」**；不要就放进这个 spread。
     */
    ...(DEV ? {
      /**
       * ★★ **只给探针用**：把主窗口收到的 `bubble:*` 事件重放一遍。
       *
       * 为什么需要：主进程的 `runChat` **不广播 `speak:say`** ——
       *   它走的是 `bubble:delta/done`。而主进程里的函数从渲染层调不到，
       *   所以「她说的话到底有没有变成气泡」这件事，
       *   探针够不着、自检也够不着（自检不起窗口）。
       *   有了这个口子，就能在不发真请求（不花钱）的前提下量到真实行为。
       */
      _probe: (channel, payload) => ipcRenderer.emit(String(channel), {}, payload),
      /**
       * 界面调试台开关 —— 把**发起调用的那个浮层窗口**放大 / 还原。
       * 只有设置面板的调试台会调；主进程那边只放大不缩小、退出精确还原。
       */
      design: (on)         => ipcRenderer.send('ov:design', !!on),
      /** 调试台「保存成文件」—— 存到桌面并在资源管理器里点亮它 */
      designSave: (text)   => ipcRenderer.invoke('design:save', text),
      /*
       * ★ 调试台的**即时生效**那套（改了就落盘，重启也在）——
       *   存的是一份**覆盖**，源码里的默认值一个字都不动，随时能清掉。
       */
      designLoad:  ()      => ipcRenderer.invoke('design:load'),
      designPut:   (data)  => ipcRenderer.invoke('design:put', data),
      designClear: ()      => ipcRenderer.invoke('design:clear'),
      designWhere: ()      => ipcRenderer.invoke('design:where'),
      /**
       * ★★ **只给探针用**：把「准备睡」掰过去 / 掰回来。
       * 真实进睡要"键鼠停够 55 分钟"，等不起；本机也没有可靠办法伪造用户活动
       * （`SetThreadExecutionState` / `SendKeys` 实测都重置不了系统空闲计时器）。
       */
      _sleep:      (on) => ipcRenderer.invoke('probe:sleep', !!on),
      _isSleeping: ()   => ipcRenderer.invoke('probe:sleep', null),
      /**
       * ★ **只给探针用**：走**托盘那条路**显示/隐藏（2026-10-17 加的）。
       * 他要复现的 bug：「托盘右键菜单的显示/隐藏，隐藏后再显示就点不动她」——
       * 那条路跟 `cfg:set('petVisible')` **不是同一段代码**，得单独能叫。
       * ⚠️ 主进程那边是 `devOnly` ⇒ 正式版里 invoke 会 reject（无害）。
       */
      _trayToggle: ()   => ipcRenderer.invoke('probe:tray-toggle'),
      /**
       * ★ **只给探针用**：假装进/退游戏，广播一次 `game:changed`。
       * 真实触发要真开个全屏游戏／等他去打，等不起 —— 而这一条要验的是**页面那半**。
       * ⚠️ 主进程那边是 `devOnly` ⇒ 正式版里 invoke 会 reject（无害）。
       */
      _game: (on)       => ipcRenderer.invoke('probe:game', !!on),
      /**
       * ★ **只给探针用**：把某个浮层往上顶一层（或按 hwnd 插到某个窗口后面）。
       *
       * 为什么需要它：`setAlwaysOnTop(false)` 在 Windows 上**不只是改标志位** ——
       *   它会把窗口从"置顶带"挪到"不置顶带"，而**插的位置是不确定的**
       *   （实测：主窗口被降下来之后**排到了菜单前面**）。所以"谁在谁前面"
       *   这件事只能自己显式摆，而摆完对不对**只能靠探针量真实 z 序**。
       *
       * ⚠️ 这是**调试口**，产品流程里不调它。不想为了量一次 z 序就
       *    先改一遍产品代码 —— 那就变成"改完了再验自己改得对"。
       */
      probeRaise: (kind, afterHwnd) => ipcRenderer.invoke('ov:probe-raise', kind, afterHwnd || null),
      /** ★ 只给探针用：开始/停止记录某一个浮层的每次 setBounds（查"闪"用） */
      probeBounds: (kind, on) => ipcRenderer.invoke('ov:probe-bounds', kind, on !== false),
    } : {}),
    /** 浮层窗口被打开时主进程会推这个，带 state */
    // 事件走下面的 on()
  },

  /* ---------- 主进程 → 页面 ---------- */
  on: (ch, fn) => {
    const allow = [
      'tray:toggle-show', 'tray:open-settings', 'tray:open-chat', 'cfg:changed',
      'chat:delta', 'chat:done', 'chat:error', 'chat:cleared',
      // 快速问一句那条路 —— 主窗口接住，冒在气泡上
      'bubble:delta', 'bubble:done', 'bubble:error',
      /*
       * ★ 她自己开口（自言语 / 以后的到点提醒）。
       *
       * ⚠️⚠️ 白名单这个东西**漏一个不报错** —— 主进程 `webContents.send`
       *    照常返回成功，只是页面上什么都没发生。2026-10-12 就因为
       *    `win:tilts-changed` 不在表里，白查了半天"滑块没反应"。
       *    ⇒ 以后**每加一条链，都要顺手在这儿看一眼**。
       */
      'speak:say',
      /*
       * ★ 「准备睡」的状态变了 —— 页面拿它当气泡的第二道闸（见 ui/bubble.js）。
       * ⚠️⚠️ 2026-10-13 **又漏了一次**：上面那段注释刚写完「以后每加一条链，
       *    都要顺手在这儿看一眼」，转头加 `sleep:changed` 就忘了登记。
       *    症状一模一样 —— 主进程发的日志有了、页面状态死活是 false、
       *    **没有任何报错**，白查了半小时。
       *    ⇒ 现在这个数组**开头的注释就是教训本身**，别再犯第三次。
       */
      'sleep:changed',
      /*
       * ★ 切了 AI 服务商预设。
       * ⚠️ 又一条**必须登记**的 —— 页面靠它把「地址 / Key / 模型」三行刷新成
       *    新预设的值；漏了的话切完预设输入框里还是上一家的，看着像没切成功。
       *    （这个数组上面那两条注释就是"漏登记"的两次教训，别再犯。）
       */
      'providers:changed',
      /*
       * ★ 光标离开了窗口那条带（主进程的守望发的，见 main/index.cjs 的 startCursorWatch）。
       * ⚠️ 又一条**必须登记**的 —— 页面靠它把穿透打开，不然桌面上的东西点不动。
       */
      'win:cursor-out',
      /*
       * ★★ 主窗口被**显示**了（2026-10-18 加的，为 #6「隐藏后再显示，左键拖不动」）。
       *   页面靠它**无条件重申**一次穿透状态 —— 这是唯一能修掉
       *   「页面以为没事、其实窗口还忽略着鼠标」的时机（控制点仍然只在页面）。
       * ⚠️ 又是**必须登记**的一条：这个 on() 对没登记的频道是**静默丢弃**的，
       *   漏了的话主进程照发、页面照收不到，而且一点报错都没有。
       */
      'win:shown',
      /*
       * ★★ 主进程每 120ms 喂一次光标位置（2026-10-18，为 #6 的死锁）。
       *   `forward:true` 只转发 up、不转发 move —— 光靠 mousemove 更新"鼠标在哪"，
       *   一旦 move 断了，页面永远判"不在她身上"，穿透永远开着，再也点不着。
       * ⚠️ 必须登记，不登记会被静默丢掉（这个 on() 的老毛病）。
       */
      'win:cursor-pos',
      /*
       * ★ 他开始 / 结束打游戏了（全屏 + 进程检测，见 core/gamedetect.cjs）。
       * ⚠️ 必须登记 —— 页面靠它把她钉在「坐着」，漏了就是"打游戏时她还在来回走"。
       */
      'game:changed',
      'win:stage',
      /*
       * ★ 每个姿态的倾斜角被改了（设置面板那 5 个滑块）。
       * ⚠️⚠️ 这条**必须加进白名单** —— 这个 `on()` 是**静默丢弃**没登记过的频道的
       *    （`if (!allow.includes(ch)) return;`），少了它主进程照发、页面照收不到，
       *    而且**一点报错都没有**，表现就是「拖了滑块没反应，重启才生效」。
       *    我第一版就是漏了这儿，探针里量到 `presets.sit.lean` 死活不变。
       */
      'win:tilts-changed',
      'ov:open',              // 浮层被打开，带 state
      'ov:close',             // 浮层被要求关闭
    ];
    if (!allow.includes(ch)) return;
    ipcRenderer.on(ch, (_e, ...args) => fn(...args));
  },
});
