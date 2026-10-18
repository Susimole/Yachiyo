/**
 * 浮层页面的「宿主」—— 菜单 / 设置面板 / 聊天窗共用。
 *
 * 这三个页面各自是一个独立的小窗口（为什么拆的见 src/main/overlay.cjs），
 * 所以它们**没有 app.js**。但它们需要的那点能力是一样的：
 * 读配置、写配置、跟主题、开别的浮层、退出。
 * 这个文件就是那一小撮，三个页面各 `makeHost()` 一次。
 *
 * ⚠️ 为什么不每个页面自己写一份：主题切换有 5 个页面要跟着变
 *    （主窗口 + 3 个浮层），逻辑分三份的话必定会飘 ——
 *    比如「面板切深色，菜单还是浅色」这种。
 */

import { applyFont } from './font.js';

/**
 * 把主题落到 body 上。所有浮层都用同一套变量名（overlay.css 里定义）。
 *
 * ⚠️ 字体也在这儿落地 —— 五个窗口（主窗口 + 菜单 + 面板 + 聊天 + 输入条）
 *    各是一个独立页面，**每个都得自己注册一遍字体**，
 *    「主窗口换了字体、面板还是雅黑」这种撕裂就是这么来的。
 */
export function applyTheme(cfg) {
  /*
   * ⚠️ 用 classList.toggle，别整体赋 `className`（2026-10-16 修的）。
   *    整体赋会把 body 上**别的类名一起抹掉**。现在 body 上只有 dark/light，
   *    所以还没出过事 —— 但以后谁往 body 加一个类，就会被主题切换悄悄吃掉。
   */
  document.body.classList.toggle('dark', cfg.theme === 'dark');
  document.body.classList.toggle('light', cfg.theme !== 'dark');

  // 强调色是内联变量，跟主题正交（深浅两套都可能有粉/金）
  if (cfg.accent) document.documentElement.style.setProperty('--accent', cfg.accent);
  if (cfg.bubbleTextColor) { /* 浮层不用气泡色，留个位置 */ }

  // 字体（失败会自己退回默认，不会把界面变成宋体）
  applyFontTo(cfg);
}

/**
 * 落字体，并把失败说出来。
 *
 * ⚠️⚠️ 单独抽出来是因为它和 `applyTheme` **不是一回事**：
 *    原来这里只在 `key === 'theme' || 'accent'` 的时候叫 applyTheme，
 *    于是「在面板里换字体」这条路上，**面板自己根本不重新加载字体** ——
 *    主窗口换了（它那边的 `apply(key)` 有 fontFamily 分支），
 *    面板还是雅黑。实测就是这样：主窗口 `--font-ui` 已经指到 YachiyoUI，
 *    面板那边 `loaded: null`、`registered: []`，界面上两半是两个字体。
 */
function applyFontTo(cfg) {
  return applyFont(cfg).then((r) => {
    if (!r.ok) console.warn('[font] 换字体没成：' + r.error);
    return r;
  });
}

/**
 * 建一个宿主。
 * @param {(key:string, value:any)=>void} [onChange] 配置变了想额外做点什么
 */
export function makeHost(onChange) {
  let CFG = {};
  const ready = window.yachiyo.cfg.all().then((c) => {
    CFG = c;
    applyTheme(CFG);
    return CFG;
  });

  // 任何一个窗口改了配置，主进程都会广播给所有窗口（见 overlay.cjs 的 broadcast）
  window.yachiyo.on('cfg:changed', ({ key, value }) => {
    CFG[key] = value;
    if (key === 'theme' || key === 'accent') applyTheme(CFG);
    // ⚠️ 字体单独一支 —— 换字体时不用重画主题，但**必须**重新加载字体文件
    //    （见 applyFontTo 的注释：漏了这条「面板换了、她还是雅黑」）
    else if (key === 'fontFamily') applyFontTo(CFG);
    onChange?.(key, value);
  });

  return {
    cfg:   () => CFG,
    ready: () => ready,
    setCfg: async (k, v) => {
      CFG[k] = v;                       // 本地先改，界面立刻响应，不等 IPC 回来
      if (k === 'theme' || k === 'accent') applyTheme(CFG);
      await window.yachiyo.cfg.set(k, v);
    },
    /** 开另一个浮层（面板 / 聊天窗）。菜单自己要不要关由主进程定。 */
    openPanel: (page) => window.yachiyo.ov.open('panel', { page }),
    openChat:  ()      => window.yachiyo.ov.open('chat'),
    /** 关掉**自己**这个浮层 */
    close:     ()      => window.yachiyo.ov.close(),
    quit:      ()      => window.yachiyo.win.quit(),
    ai:        {
      ping:   () => window.yachiyo.ai.ping(),
      models: () => window.yachiyo.ai.models(),
    },
    usage:     { get:  () => window.yachiyo.usage.get() },
    chat: {
      send:    (t) => window.yachiyo.chat.send(t),
      abort:   ()  => window.yachiyo.chat.abort(),
      history: ()  => window.yachiyo.chat.history(),
      clear:   ()  => window.yachiyo.chat.clear(),
    },
  };
}
