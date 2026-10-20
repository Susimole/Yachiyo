/**
 * 设置面板 —— 五页：习惯 / 对话框 / 天气 / AI 接入 / 高级
 *
 * 声明式：settings-pages.js 里的 PAGES 描述一行长什么样，renderPage 负责造 DOM。
 * 加一个设置项 = 在 PAGES 里加一行，别的地方都不用动。
 * 每一项都直接读写 config.json 的键（键名跟 src/core/config.cjs 一一对应）。
 */

import { svg } from './icons.js';
import { fontState } from './font.js';
import { makeHost } from './host.js';
import { R, N, PRESET_COLORS, PAGES } from './settings-pages.js';
import { mountUsage, mountProviderPick, mountUsageChart, mountFontPick, mountTiltPoses,
  mountWeatherTest, mountAiDebug, mountCfgPath, mountDesignEntry,
  usagePaint, usageChartPaint, syncModelInput } from './settings-mounts.js';

/* 2026-10-20：R / N / PRESET_COLORS / PAGES 搬到 settings-pages.js，这里转出去保持对外 API 不变 */
export { R, N, PRESET_COLORS, PAGES };

export let api = null;   // { cfg, setCfg, reset, onChanged } —— settings-mounts.js 也读它（活绑定）
let curPage = 'habit';

/**
 * 现在跑的是开发版吗 —— 由 preload 按主进程的 `app.isPackaged` 给（`window.yachiyo.dev`）。
 *
 * 全工程**只有一处**判断（就是这儿），给「界面调试台」那道锁用：
 *   正式版里那颗按钮不建、整组不画、`design.js` 也不加载。
 * 用函数而不是顶层常量：preload 的注入时机不保证在模块求值之前。
 */
export const DEV = () => !!(window.yachiyo && window.yachiyo.dev);

/* ============================================================
   页面描述
   ============================================================ */


/**
 * 货币符号和换算。
 * ⚠️ DeepSeek 实际是按**人民币**扣款的。切到 $ 只是给你一个价格感觉，
 *    不改真实账单 —— 所以用配置里那个写死的汇率，不联网查。
 */
export function curInfo(cfg) {
  const usd = cfg.currency === 'usd';
  return { usd, sym: usd ? '$' : '¥', div: usd ? (Number(cfg.usdRate) || 7.25) : 1 };
}

/* ============================================================
   自绘下拉 —— 替掉原生 <select>
   ============================================================
   ⚠️⚠️ 为什么非换不可（他 2026-10-12 贴了截图）：

      原生 `<select>` 的**弹出菜单是 Chromium 自己画的，CSS 管不着**。
      闭合那只框我们能上样式，但点开之后那张白底蓝高亮的列表是系统级的 ——
      实测就是这样，而且**没有 `::picker()` 那种选择器能碰它**
      （Chromium 那个新伪元素要 `appearance: base-select` 才生效，
       而开了那个连闭合态都跟着变，得不偿失）。

      所以整条链自己来：按钮 + 一张浮层卡片，**跟面板同一套变量**
      （--bg-solid / --line / --accent / --r-card），深色模式也自动跟着走。

   ⚠️ 浮层挂在 `.card` 上（它是 `position:absolute; inset:0`，是现成的定位父级），
      **不能挂进 #pMain** —— 那是 `overflow-y:auto` 的滚动区，浮层会被裁掉。
   ⚠️ 全局只留一张浮层：面板重画（showPage）时上一张必须收掉，否则会叠在页面上。
   ============================================================ */
let closeOpenPop = null;

export function closeSelectPop() { if (closeOpenPop) closeOpenPop(); }

export function selRow(opts, cur, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'cwrap';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'sel-trig';

  const labelOf = (v) => {
    const hit = opts.find(([val]) => String(val) === String(v));
    return hit ? hit[1] : (opts[0] ? opts[0][1] : '');
  };
  trigger.innerHTML = `<span class="sel-txt"></span><span class="sel-car">▾</span>`;
  trigger.querySelector('.sel-txt').textContent = labelOf(cur);
  wrap.appendChild(trigger);

  let pop = null;

  const close = () => {
    if (!pop) return;
    pop.remove(); pop = null;
    trigger.classList.remove('open');
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close, true);
    if (closeOpenPop === close) closeOpenPop = null;
  };

  const onOutside = (e) => { if (pop && !pop.contains(e.target) && !wrap.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  trigger.onclick = (e) => {
    e.stopPropagation();
    if (pop) { close(); return; }
    closeSelectPop();                       // 别的地方可能还开着一张

    pop = document.createElement('div');
    pop.className = 'sel-pop';
    for (const [val, txt] of opts) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sel-item';
      /*
       * ⚠️ 加在**按钮自己身上**（`.sel-item.on`），不是行上 ——
       *    跟 .seg / .switch 一个道理，加错了选择器匹配不上，选中态就不显示。
       */
      if (String(val) === String(cur)) item.classList.add('on');
      item.innerHTML = `<span class="sel-tick">${String(val) === String(cur) ? '✓' : ''}</span>`
                     + `<span class="sel-item-t"></span>`;
      item.querySelector('.sel-item-t').textContent = txt;
      item.onclick = async (ev) => {
        ev.stopPropagation();
        cur = val;
        trigger.querySelector('.sel-txt').textContent = labelOf(val);
        close();
        await onPick(val);
      };
      pop.appendChild(item);
    }

    // 定位父级 = 整张卡片
    const host = document.querySelector('.card') || wrap.parentElement || document.body;
    host.appendChild(pop);

    // 先量再摆 —— 弹出前必须已经在 DOM 里（否则 clientHeight 是 0）
    const hb = host.getBoundingClientRect();
    const tb = trigger.getBoundingClientRect();
    let x = tb.left - hb.left;
    const py = pop.offsetHeight;
    let y = tb.bottom - hb.top + 6;
    if (y + py > hb.height - 8) y = Math.max(8, tb.top - hb.top - py - 6);  // 下面放不下就往上翻
    if (x + pop.offsetWidth > hb.width - 8) x = Math.max(8, hb.width - pop.offsetWidth - 8);
    pop.style.left = Math.round(x) + 'px';
    pop.style.top  = Math.round(y) + 'px';

    trigger.classList.add('open');
    document.addEventListener('mousedown', onOutside, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close, true);
    closeOpenPop = close;
  };

  wrap._closeSel = close;      // 面板重画时收掉（showPage 里用）
  return wrap;
}

/* ============================================================
   分组覆盖表 —— 界面调试台搬动分组用
   ============================================================
   ⚠️ `PAGES` 是**静态数据**，分组搬走了不该改它本身（改了就没法"还原"）。
      所以调试台把"哪些组搬到哪儿"记在这个 Map 里，
      `showPage` 渲染时拿它和 PAGES 合并 —— 撤回只要把键删掉。

   键 = 页面 key（'habit' / 'ai' / ...），值 = 该页**完整的**分组数组。

   ⚠️ 这个 Map 是**模块级**的：调试台搬完东西会调 `showPage` 重画，
      重画时数据得还在。退出调试台时由 design.js 清空。
   ============================================================ */
const groupOverride = new Map();

/*
 * ★ 给每个分组发一张"身份证"（`__gid` = 原来在哪页 + 第几组）。
 *
 * 为什么需要：调试台要能把组搬到别页去，那就得**认得出"这是同一个组"** ——
 *   它搬到新页面之后，在数组里的下标会变、前后邻居也变了，
 *   只有这个 id 是跟着它走的。还原的时候也靠它找回原位。
 *
 * ⚠️ 是**原地改 PAGES 对象**（加一个字符串字段），不是深拷贝 ——
 *   PAGES 里那些 `rows` 里的函数引用（`act: (a) => a.reset()`）深拷会丢语义。
 */
for (const p of PAGES) {
  p.groups.forEach((g, i) => { if (!g.__gid) g.__gid = p.k + '#' + i; });
}

export function setGroupOverride(map) { groupOverride.clear(); if (map) for (const [k, v] of map) groupOverride.set(k, v); }
export function getGroupOverride() { return groupOverride; }

/**
 * ★ 给调试台用的两个口：
 *   `PAGES_FOR_DESIGN()` —— 拿原始页面结构（它按 `__gid` 找"这个组本来在哪一页"）
 *   `ALL_GROUPS()`       —— 把所有组摊平成一张表，调试台搬动分组时按 id 取原件
 *
 * ⚠️ 返回的是**原件不是副本** —— 搬动只改 `groupOverride` 那个 Map，
 *    PAGES 本身一个字都不动，所以「还原」永远有得可还原。
 */
export const PAGES_FOR_DESIGN = () => PAGES;
export function ALL_GROUPS() {
  const byId = new Map();
  for (const p of PAGES) for (const g of p.groups) byId.set(g.__gid, { page: p.k, group: g });
  return byId;
}

/**
 * 调试台把某个自定义行搬到别的页之后，原来"按页挂载"的逻辑就找不着它了。
 * 这张表按**标记**找，跟在哪一页无关。
 *
 * ⚠️ 别删——`lang` 那几个是老代码留下来没用的（`if (el)` 会跳过），
 *    留着是为了以后真要加时有个现成位置。
 */
const MOUNTS = {
  providerPick: (el) => mountProviderPick(el),
  usageChart: (el) => mountUsageChart(el),
  usageStats: (el) => mountUsage(el),
  aiDebug: (el) => mountAiDebug(el),
  // ★ 2026-10-20：`visionHint`（「视觉模块」那一行）已删 —— 他要求去掉。
  weatherTest: (el) => mountWeatherTest(el),
  cfgPath: (el) => mountCfgPath(el),
  designEntry: (el) => mountDesignEntry(el),
  tiltPoses: (el) => mountTiltPoses(el),
  fontPick: (el) => mountFontPick(el),
  lang: () => { /* 语言那一行一直是占位，从来没有实现 */ },
};

/** 把某一页里所有 `t:'custom'` 的行挂上——**按标记找，跟页面无关** */
function mountCustoms(root) {
  for (const el of root.querySelectorAll('[data-custom]')) {
    const fn = MOUNTS[el.dataset.custom];
    if (fn) { try { fn(el); } catch (err) { console.error('[设置] 挂载 ' + el.dataset.custom + ' 失败：' + err.message); } }
  }
}

/* ============================================================
   造 DOM
   ============================================================ */

export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

/* ============================================================
   颜色换算（2026-10-21 加的，给「主题色」那块自绘调色盘用）
   ============================================================
   为什么不用现成的库：整个工程零依赖，为两个函数引一个色板库不值。
   ⚠️ `hexToHsv` 遇到不合法的串**回落到默认海蓝** —— 他手改 config.json
      写成 `#abc` 或拼错时，调色盘也得能开、能拖，不能白屏。
*/
function hexToHsv(hexStr) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hexStr || '').trim());
  const n = m ? parseInt(m[1], 16) : 0x0A7EA4;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

function hsvToHex(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (h < 60) { r = c; g = x; }
  else if (h < 120) { r = x; g = c; }
  else if (h < 180) { g = c; b = x; }
  else if (h < 240) { g = x; b = c; }
  else if (h < 300) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (q) => Math.round((q + m) * 255).toString(16).padStart(2, '0');
  return '#' + to(r) + to(g) + to(b);
}

/**
 * 自绘调色盘（**可拖**）—— 「主题色」和「文字颜色」两行共用这一个。
 *
 * 2026-10-21 加。起因：他报「主题色调色板只可点击不可拖动」，
 * 而原来那两处用的都是原生 `<input type="color">` —— 点开弹的是
 * Chromium / 系统取色器，里面拖不拖得动**我们完全管不了**。所以自己画。
 *
 * 结构：左边「饱和度 × 明度」方块（横轴=饱和度、纵轴=亮度），右边竖着色相条。
 * @param {string} startHex 当前颜色
 * @param {{onPreview:(hex:string)=>void, onCommit:(hex:string)=>void}} hooks
 *   `onPreview` = 拖动**中**（只改显示，别写盘）；`onCommit` = 松手那一下（该落盘了）。
 * @returns {HTMLElement} 直接 append 进那一行
 *
 * ⚠️ 监听挂在**元素自己**身上（不是 window）：`showPage` 每次重画都会重建这一块，
 *    挂 window 的话监听会一层层累积，关都关不掉。
 * ⚠️ 拖动中千万别写 config.json —— 跟 range 那条同一个道理，磁盘会被刷爆。
 */
function makePalette(startHex, hooks) {
  const pal = document.createElement('div');
  pal.className = 'pal';
  pal.innerHTML = '<div class="pal-sv"><i class="pal-dot"></i></div>'
    + '<div class="pal-hue"><i class="pal-hue-dot"></i></div>';
  const sv = pal.querySelector('.pal-sv');
  const dot = pal.querySelector('.pal-dot');
  const hueEl = pal.querySelector('.pal-hue');
  const hueDot = pal.querySelector('.pal-hue-dot');

  const cur = hexToHsv(startHex);
  let drag = null;                 // 'sv' | 'hue' | null

  const paint = () => {
    const pure = hsvToHex(cur.h, 1, 1);
    sv.style.background = 'linear-gradient(to top, #000, rgba(0,0,0,0)), '
      + 'linear-gradient(to right, #fff, ' + pure + ')';
    const here = hsvToHex(cur.h, cur.s, cur.v);
    dot.style.left = (cur.s * 100) + '%';
    dot.style.top = ((1 - cur.v) * 100) + '%';
    dot.style.background = here;
    /*
     * ⚠️⚠️ 色相条是**竖的**（宽 16 / 高 112），所以它的进度要走 `top`。
     *     第一版我照抄了方块那行的 `left` —— 结果拖着上下没反应
     *     （只有在那 16px 宽的条里左右蹭才动），他当场看出来了：「你做成左右了 hhh」。
     */
    hueDot.style.top = (cur.h / 360 * 100) + '%';
    return here;
  };
  const take = (e) => {
    if (!drag) return;
    const r = (drag === 'sv' ? sv : hueEl).getBoundingClientRect();
    const px = Math.min(1, Math.max(0, (e.clientX - r.left) / (r.width || 1)));
    const py = Math.min(1, Math.max(0, (e.clientY - r.top) / (r.height || 1)));
    /*
     * ⚠️ 色相条是**竖的** ⇒ 用 `py`（上下）；方块才是横轴饱和度 + 纵轴亮度。
     *   第一版把色相也写成了 `px`，于是上下拖不动 —— 他 2026-10-21 看出来了。
     */
    if (drag === 'sv') { cur.s = px; cur.v = 1 - py; } else { cur.h = py * 360; }
    const here = paint();
    if (hooks && hooks.onPreview) hooks.onPreview(here);
  };
  const begin = (kind) => (e) => {
    drag = kind;
    try { e.target.setPointerCapture(e.pointerId); } catch { /* 合成事件没有真的 pointerId */ }
    take(e);
    if (e.preventDefault) e.preventDefault();
  };
  const end = () => {
    if (!drag) return;
    drag = null;
    if (hooks && hooks.onCommit) hooks.onCommit(paint());
  };
  sv.addEventListener('pointerdown', begin('sv'));
  hueEl.addEventListener('pointerdown', begin('hue'));
  sv.addEventListener('pointermove', take);
  hueEl.addEventListener('pointermove', take);
  sv.addEventListener('pointerup', end);
  hueEl.addEventListener('pointerup', end);
  sv.addEventListener('pointercancel', end);
  hueEl.addEventListener('pointercancel', end);

  paint();
  return pal;
}

/**
 * ★★ 2026-10-21：调色板弹窗还开着吗 / 这次开着的期间改过颜色吗。
 *
 *   他报「不要松了鼠标就立刻关闭调色板，点击调色板之外才关」。
 *   根因不在弹窗自己身上：**改 `accent` 会让整页重画**（见 `initSettings` 里
 *   `if (k === 'accent') showPage(curPage)`），而 `showPage` 开场就 `closeSelectPop()` ——
 *   于是「松手 → 落盘 → 广播 → 重画 → 浮层被收」，看着就像松手就关。
 *   ⇒ 弹窗开着的时候先别重画（颜色本身已经通过内联 `--accent` 实时变了），
 *     等它真关上再补一次重画，把该同步的地方同步掉。
 */
let paletteOpen = false;
let paletteDirty = false;

/**
 * 点小方块 → 弹出调色板（2026-10-21 加的）。
 *
 * 他的话：「我需要的仅仅是最初唤出的调色板的小圆点可拖动实时变色而已」
 *   ⇒ **不是**把调色板摊在面板上；原来那颗小方块还在，点它才弹。
 *   之前那颗是原生 `<input type="color">`，弹的是系统取色器 —— 里面拖不动，
 *   我们管不了。现在弹窗是我们自己画的，圆点想怎么拖就怎么拖。
 *
 * 交互：拖动中**只改显示**（`onPreview`，他能实时看到颜色变），
 *      松手才落盘（`onCommit`）。**只在点弹窗外面 / Esc / 窗口尺寸变了才关**
 *      —— 松手不关（他 2026-10-21 特意要求的）。
 * ⚠️ 浮层挂到 `.card` 上而不是行里：行会被 `showPage` 整片重画，
 *    挂在行里滚一下就跟着跑了（下拉那张浮层当年也是这么修的）。
 */
function openPalettePopup(trigger, startHex, hooks) {
  closeSelectPop();                 // 别的地方可能还开着一张下拉
  const host = document.querySelector('.card') || document.body;
  const pop = document.createElement('div');
  pop.className = 'pal-pop';
  pop.appendChild(makePalette(startHex, {
    onPreview: hooks.onPreview,
    onCommit: (h) => { paletteDirty = true; hooks.onCommit(h); },   // 记一笔"改过"，关窗时补重画
  }));
  host.appendChild(pop);            // 先入 DOM 再量尺寸，否则 offsetWidth 是 0

  const hb = host.getBoundingClientRect();
  const tb = trigger.getBoundingClientRect();
  let x = tb.left - hb.left;
  let y = tb.bottom - hb.top + 6;
  if (y + pop.offsetHeight > hb.height - 8) y = Math.max(8, tb.top - hb.top - pop.offsetHeight - 6);
  if (x + pop.offsetWidth > hb.width - 8) x = Math.max(8, hb.width - pop.offsetWidth - 8);
  pop.style.left = Math.round(x) + 'px';
  pop.style.top = Math.round(y) + 'px';

  const onOutside = (e) => { if (!pop.contains(e.target) && !trigger.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  const close = () => {
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close, true);
    pop.remove();
    trigger.classList.remove('open');
    if (closeOpenPop === close) closeOpenPop = null;
    paletteOpen = false;
    /*
     * 开着的时候改过颜色 → 补一次重画（那期间我们把整页重画压住了，见上面那段）。
     * ⚠️ 放到下一个 tick：此刻可能正处在 `showPage` 里（它开场就 closeSelectPop），
     *    同步再调一次 showPage 会自己往里套。
     */
    if (paletteDirty) {
      paletteDirty = false;
      setTimeout(() => { try { showPage(curPage); } catch { /* 页面没了就算了 */ } }, 0);
    }
  };
  document.addEventListener('mousedown', onOutside, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close, true);
  trigger.classList.add('open');
  paletteOpen = true;
  closeOpenPop = close;             // showPage 重画时会调 closeSelectPop() 收掉
  return close;
}

function rowEl(row, ctx) {
  const d = document.createElement('div');
  d.className = 'row';
  /*
   * ★ 把配置键挂在行上 —— **给自检/探针用的稳定钩子**。
   *
   * ⚠️⚠️ 2026-10-13 栽的：自检原来是靠**文案**找那一行
   *    （`label.textContent.startsWith('深浅色')`）。他把那行的标签改成
   *    「日/夜间模式」之后，自检当场崩了 —— 改成按 `data-rk` 找，文案再改也不怕。
   *    （同理 `seg` 每个按钮也挂了 `data-v`。）
   */
  if (row.key) d.dataset.rk = row.key;

  if (row.t === 'custom') {
    /*
     * ⚠️ `label` 要给**整列的样式**（.row .label 是固定 92px 宽），
     *    不能只塞个字符串进去 —— 原来这里写 `row.label || ''`，
     *    连 `<div class="label">` 都没给，所以他看到左边那一栏是空的。
     */
    d.innerHTML = `<div class="label">${esc(row.label || '')}`
                + (row.hint ? `<small>${esc(row.hint)}</small>` : '')
                + '</div><div class="body" data-custom="' + esc(row.key) + '"></div>';
    return d;
  }

  const label = row.label
    ? `<div class="label">${esc(row.label)}`
      + (row.todo ? '<i class="todo">待接</i>' : '')
      + (row.hint ? `<small>${esc(row.hint)}</small>` : '')
      + '</div>'
    : '';
  d.innerHTML = `${label}<div class="body"></div>`;
  const body = d.querySelector('.body');
  const v = ctx.cfg()[row.key];

  switch (row.t) {
    case 'sw': {
      const sw = document.createElement('span');
      sw.className = 'sw' + (v ? ' on' : '');     // ★ on 要加在开关自己身上，不是行上
      sw.onclick = () => { sw.classList.toggle('on'); ctx.set(row.key, sw.classList.contains('on')); };
      body.appendChild(sw);
      break;
    }

    case 'seg': {
      const seg = document.createElement('div');
      seg.className = 'seg';
      for (const [val, txt] of row.opts) {
        const b = document.createElement('button');
        b.textContent = txt;
        b.dataset.v = String(val);      // ★ 给自检用（文案改了也找得到）
        if (String(v) === String(val)) b.classList.add('on');
        b.onclick = () => {
          seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
          b.classList.add('on');
          ctx.set(row.key, val);
        };
        seg.appendChild(b);
      }
      body.appendChild(seg);
      break;
    }

    /*
     * 数字输入框 —— 他明确要求「数值滑块改为输入框」的那几项用这个。
     * ⚠️ 用 `change` 不用 `input`：`input` 每敲一个字符就写一次配置，
     *    他输入「2.37」的中间态「2」「2.」都会被当成真值存进去，
     *    面板上别的地方（用量那块的单价）会跟着跳。
     */
    case 'num': {
      const wrap = document.createElement('div');
      wrap.className = 'cwrap';

      const inp = document.createElement('input');
      inp.type = 'number';
      inp.className = 'num-in';
      inp.step = String(row.step ?? 0.01);
      inp.min = '0';
      inp.value = v ?? 0;
      inp.onchange = async () => {
        const n = Number(inp.value);
        if (!Number.isFinite(n) || n < 0) { inp.value = ctx.cfg()[row.key] ?? 0; return; }
        await ctx.set(row.key, n);
      };
      wrap.appendChild(inp);

      const sym = document.createElement('span');
      sym.className = 'hex';
      sym.textContent = row.fmt ? row.fmt(v) : '';
      wrap.appendChild(sym);

      body.appendChild(wrap);
      break;
    }

    /*
     * 主题色 —— 预设色卡 + 调色盘。
     *
     * ⚠️ 预设色不是随便挑的，是**从她立绘上取的**（他说的「就用桌宠的主题色就行」）：
     *    头发、发梢、和服、裙子、章鱼、发饰。这样配色跟人物是一套，
     *    不会出现「面板蓝、人物粉」那种割裂。
     * ⚠️ 调色盘的 <input type=color> 是原生控件，`oninput` 边拖边生效 ——
     *    用 `onchange` 要松手才变，调的时候看不到效果。
     */
    case 'colors': {
      const wrap = document.createElement('div');
      wrap.className = 'cwrap';

      const box = document.createElement('div');
      box.className = 'swatches';

      const mark = () => {
        for (const s of box.children) {
          s.classList.toggle('on', String(s.dataset.c).toLowerCase() === String(ctx.cfg()[row.key]).toLowerCase());
          s.style.color = s.dataset.c;      // ‹on› 那圈描边用 currentColor
        }
        hex.textContent = ctx.cfg()[row.key] || '';
        if (typeof syncSq === 'function') syncSq();   // 选色卡时那颗小方块也跟着变（见下）
      };

      /*
       * ⚠️ `mark()` 里要调 `syncSq`，可它得等 sq 建好 —— 所以这里先声明再赋值，
       *    别写成 const（那样 `typeof` 判断会撞 TDZ）。
       */
      let syncSq = null;

      for (const [c, name] of PRESET_COLORS) {
        const s = document.createElement('div');
        s.className = 'swatch';
        s.dataset.c = c;
        s.style.background = c;
        s.title = name;
        s.onclick = async () => { await ctx.set(row.key, c); mark(); };
        box.appendChild(s);
      }
      wrap.appendChild(box);

      const hex = document.createElement('span');
      hex.className = 'hex';
      wrap.appendChild(hex);

      /*
       * ★★ 2026-10-21：那颗小方块还是原来那颗，但**点开弹的是我们自己的调色板**。
       *
       *   他报「主题色调色板只可点击不可拖动」，随后又说清楚：「我需要的仅仅是
       *   最初唤出的调色板的小圆点可拖动实时变色而已」。
       *   ⇒ 不是把调色板摊在面板上（我第一版就做错了），是**弹窗里的圆点能拖**。
       *   原来那颗是原生 `<input type="color">`，弹的是 Chromium / 系统取色器，
       *   里面拖不拖我们管不了 —— 所以换掉，弹我们自己画的。
       */
      const sq = document.createElement('div');
      sq.className = 'picksq';
      sq.title = '自己调一个';
      sq.style.background = /^#[0-9a-f]{6}$/i.test(v) ? v : '#0A7EA4';
      sq.onclick = (e) => {
        e.stopPropagation();
        if (closeOpenPop) { closeOpenPop(); return; }   // 再点一下收起
        openPalettePopup(sq, ctx.cfg()[row.key] || v, {
          // 拖动中：色块、色号、页面上的 --accent 一起实时跟着走（不写盘）
          onPreview: (h) => {
            hex.textContent = h;
            sq.style.background = h;
            document.documentElement.style.setProperty('--accent', h);
          },
          onCommit: async (h) => { await ctx.set(row.key, h); mark(); },
        });
      };
      syncSq = () => {
        const cur = String(ctx.cfg()[row.key] || '');
        sq.style.background = /^#[0-9a-f]{6}$/i.test(cur) ? cur : '#0A7EA4';
      };
      wrap.appendChild(sq);

      body.appendChild(wrap);
      mark();
      break;
    }

    case 'range': {
      const sl = document.createElement('input');
      sl.type = 'range'; sl.min = row.min; sl.max = row.max; sl.step = row.step;
      sl.value = v ?? row.min;
      const out = document.createElement('span');
      out.className = 'val';
      const show = () => out.textContent = row.fmt(Number(sl.value));
      show();
      sl.oninput = show;
      // 拖动时一直写会把磁盘刷爆 —— 松手才落盘，中途只改显示
      sl.onchange = () => ctx.set(row.key, Number(sl.value));
      body.append(sl, out);
      break;
    }

    case 'text': case 'key': {
      const inp = document.createElement('input');
      inp.type = row.t === 'key' ? 'password' : 'text';
      inp.value = v ?? '';
      inp.placeholder = row.ph || '';
      inp.onchange = () => ctx.set(row.key, inp.value.trim());
      /*
       * 可选的下拉候选（原生 <datalist>）。
       * 「模型」那一行用它 —— 候选由「检测模型」现问出来，
       * 但**仍然可以手打**（自建服务未必给 /models）。
       * ⚠️ datalist 的 id 要全局唯一，同时挂在 #pMain 里，
       *    页面重画（showPage）会连它一起换掉，所以取值时现查不缓存。
       */
      if (row.list) {
        inp.setAttribute('list', row.list);
        inp.autocomplete = 'off';
      }
      body.appendChild(inp);
      break;
    }

    case 'color': {
      /*
       * ★ 2026-10-21：跟「主题色」那一行同一个套路 —— **小方块 + 点开弹调色板**。
       *   原来是原生 `<input type="color">`（弹系统取色器、里面拖不动）。
       *   这一行是「气泡文字颜色」：拖动中只改显示，松手才落盘。
       */
      const wrap2 = document.createElement('div');
      wrap2.className = 'cwrap';
      const code = document.createElement('span');
      code.className = 'val'; code.style.minWidth = '76px'; code.textContent = v;
      const sq = document.createElement('div');
      sq.className = 'picksq';
      sq.title = '自己调一个';
      sq.style.background = /^#[0-9a-f]{6}$/i.test(v) ? v : '#000000';
      sq.onclick = (e) => {
        e.stopPropagation();
        if (closeOpenPop) { closeOpenPop(); return; }
        openPalettePopup(sq, v, {
          onPreview: (h) => { code.textContent = h; sq.style.background = h; },
          onCommit: (h) => { code.textContent = h; sq.style.background = h; ctx.set(row.key, h); },
        });
      };
      wrap2.append(sq, code);
      body.append(wrap2);
      break;
    }

    case 'sel': {
      /*
       * ⚠️ 原来是原生 `<select>` —— 它点开之后那张**白底蓝高亮的菜单是
       *    Chromium 自己画的**，css 一行都碰不到，跟面板风格完全对不上
       *    （他 2026-10-12 贴了截图）。现在换成自绘的下拉浮层。
       */
      body.appendChild(selRow(row.opts, v, (val) => ctx.set(row.key, val)));
      break;
    }

    case 'btn': {
      const b = document.createElement('button');
      b.className = 'btn' + (row.cls ? ' ' + row.cls : '');
      b.textContent = row.text;
      b.onclick = () => row.act(ctx);
      body.appendChild(b);
      break;
    }
  }
  return d;
}

/**
 * 用量统计卡的重画入口。
 * ⚠️ 不在这儿 `window.yachiyo.on('cfg:changed')` —— preload 的 on 没有 off，
 *    showPage 每进一次 AI 页就挂一个，切十次就是十个监听器。
 *    走 initSettings 传给 makeHost 的那个 onChange 回调，天生只有一份。
 */
let _booted = false;
export function bootSettings() {
  if (_booted) return;
  _booted = true;
  initSettings();
}

export function initSettings() {
  /*
   * ⚠️ 这个页面现在是一个**独立的小窗口**（panel.html），不再长在主窗口里。
   *    所以宿主自己建，而不是等 app.js 传进来 —— 主窗口那边已经没有它的
   *    任何引用了。菜单 / 聊天窗同理，三页共用 ui/host.js。
   */
  api = makeHost((k) => {
    /*
     * 主题/强调色变了 → 整页重画（样式变量是内联的，不重画会有一半是旧的）
     *
     * ⚠️⚠️ 2026-10-21：**调色板弹窗开着的时候先别重画**。
     *    他报「不要松了鼠标就立刻关闭调色板」—— 根因就在这儿：
     *    松手 → 落盘 → 广播 accent → 这里 showPage → showPage 开场 closeSelectPop()
     *    ⇒ 弹窗被顺手收掉，看着像"松手即关"。
     *    颜色本身早就通过内联 `--accent` 实时生效了，所以这里压住不影响观感；
     *    等他关掉弹窗，`openPalettePopup` 的 close() 会补一次重画。
     */
    if (k === 'theme' || k === 'accent') {
      if (paletteOpen) { paletteDirty = true; return; }
      showPage(curPage); return;
    }
    // ¥/$ 和汇率变了 → 只重画用量卡上的金额（其余一个字不用动）
    if (k === 'currency' || k === 'usdRate') { usagePaint?.(); usageChartPaint?.(); return; }
    /*
     * 模型名是从别处改的 → 把「模型」那一行的输入框同步过来。
     * ⚠️ 不能 `showPage('ai')` 重画整页 —— 那样刚检测出来的模型清单就被抹了。
     *    只动那一个 input。
     */
    if (k === 'model') syncModelInput();
  });

  // 主进程开这个窗口时会把 state 推过来（比如「直接开 AI 接入那一页」）
  window.yachiyo.on('ov:open', (st) => { if (st && st.page) showPage(st.page); });
  const navs = document.getElementById('navs');
  navs.innerHTML = '';

  for (const p of PAGES) {
    const n = document.createElement('div');
    n.className = 'nav' + (p.k === curPage ? ' on' : '');
    n.dataset.k = p.k;
    n.innerHTML = svg(p.icon, 16) + `<span>${p.name}</span>`;
    n.onclick = () => showPage(p.k);
    navs.appendChild(n);
  }

  document.getElementById('pMin').innerHTML  = svg('min', 15);
  document.getElementById('pClose').innerHTML = svg('close', 15);
  document.getElementById('pClose').onclick = () => closePanel();
  document.getElementById('pMin').onclick   = () => closePanel();

  showPage(curPage);

  /*
   * ★★ 后台预载调试台的覆盖（`design.json`），**不等用户点调试台**。
   *
   * ⚠️ 为什么：覆盖是「改了就生效」那套存下来的。如果等到点开调试台才去读，
   *    那**重启之后第一次看面板还是原样** —— 他得先点一下调试台才看见自己调过的东西，
   *    这就不叫"即时生效"了。
   *
   * 读完之后 `design.js` 自己会重新跑一遍装饰（见那边的 `__designAttach`），
   * 所以这里 fire-and-forget 就行，不用 await。
   *
   * ⚠️⚠️ 但**正式版里不许跑**（2026-10-16 修的）——
   *    这一行原来没有 `DEV()` 判断，是**唯一**一条绕过守卫的进口：
   *    文件头写着「正式版里 `design.js` 连加载都不加载」，
   *    按钮（:1161）和 devOnly 的组（:1284）都挡了，
   *    偏偏这里没挡 ⇒ 面板一打开就动态 import 它、读 design.json、按里面的覆盖改界面。
   *    实测：打包版里 `design.js` 确实在，而且真的会被加载。
   */
  if (DEV()) {
    import('./design.js').then((m) => m.preload && m.preload()).catch(() => { /* 读不到就算了 */ });
  }
}

bootSettings();

export function showPage(k) {
  const p = PAGES.find(x => x.k === k) || PAGES[0];
  curPage = p.k;

  /*
   * ⚠️ 整页要重画了 —— 先把还开着的那张下拉浮层收掉。
   *    浮层挂在 `.card` 上，**不在 #pMain 里**，下面那句 `innerHTML = …`
   *    抹不到它 ⇒ 不收掉就会有一张孤儿卡片浮在新页面上（还点不掉）。
   */
  closeSelectPop();

  document.querySelectorAll('#navs .nav').forEach(n =>
    n.classList.toggle('on', n.dataset.k === p.k));

  const ctx = {
    cfg: api.cfg,
    set: (key, val) => api.setCfg(key, val),
    reset: () => api.reset(),
    /**
     * 在资源管理器里打开备份文件夹。
     * ⚠️ 主进程那边**只认白名单里的几个目录、而且必须在 cfg.DIR 底下** ——
     *    `shell.openPath` 能打开任意路径，不设闸等于把整台机器递出去。
     */
    revealBackup: () => window.yachiyo.win.reveal('backup'),
    /* ★ 2026-10-20：聊天记录（chat.jsonl）、providers.json、state/ 都在这个目录里 */
    revealData: () => window.yachiyo.win.reveal('data'),
  };

  const main = document.getElementById('pMain');
  main.scrollTop = 0;
  main.innerHTML = `<h2>${esc(p.title)}</h2><div class="desc">${esc(p.desc)}</div>`;

  /*
   * ⚠️ 分组列表**可能被调试台改过**（他把某个组搬到别页去了）——
   *    所以先看覆盖表，没有才用 PAGES 里写死的。见上面 groupOverride 那段。
   */
  const groups = groupOverride.get(p.k) || p.groups;

  for (const g of groups) {
    /*
     * ⚠️ 标了 `devOnly` 的组**正式版整组不画** —— 连那个框带标题一起。
     *    我第一版只在行里判断（`mountDesignEntry` 里 `if (!DEV) return`），
     *    结果正式版里留下一个**只有标题的空框**：「界面调试」四个字照样露出来。
     *    探针（probe-packaged.cjs 第 ④ 组）当场抓到的。
     */
    if (g.devOnly && !DEV()) continue;
    const box = document.createElement('div');
    box.className = 'group';
    // 调试台靠这个认人（拖拽时要知道拖的是哪个组、松手时往哪儿插）
    if (g.__gid) box.dataset.dgroup = g.__gid;
    if (g.title) box.innerHTML = `<div class="g-title">${esc(g.title)}</div>`;
    for (const row of g.rows) box.appendChild(rowEl(row, ctx));
    main.appendChild(box);
  }

  /*
   * ★ 自定义行的挂载**按标记找，不再按页面找**。
   *
   * ⚠️ 原来这里是 `if (p.k === 'ai') { … }` 一串 —— 那种写法跟"这个自定义项在哪一页"
   *    绑死了：调试台一旦把「联网」组从 AI 页搬到高级页，里面若有自定义项就没人挂。
   *    改成按 `data-custom` 标记找，**搬到哪儿都自动跟上**。
   */
  mountCustoms(main);

  /*
   * 调试台把这一页的组**全搬走了** → 留个话，别让他以为是面板坏了。
   * 只在调试态显示（`showPage` 每次都整片重建 innerHTML，所以不存在"重复加"）。
   */
  if (!main.querySelector('.group') && document.querySelector('.card.d-on')) {
    const tip = document.createElement('div');
    tip.className = 'd-empty';
    tip.textContent = '（这一页的组都搬走了 —— 用左栏的下拉搬回来，或点「还原」）';
    main.appendChild(tip);
  }

  /*
   * ★★ 调试台回挂 —— **必须在最后**。
   *
   * ⚠️⚠️ 这一行不加就是个"必经之路"的 bug（他 2026-10-13 撞到的）：
   *    上面 `main.innerHTML = …` 把 `#pMain` 整片重建了，
   *    可编辑文字 / 拖拽把手 / 分组下拉**全绑在旧 DOM 上**，重建就蒸发。
   *    于是：进调试台 → 一切正常 → **点一下左栏切页 → 全没了**。
   *    （探针当时没抓到，因为它从头到尾没切过页；真人一点就现原形。）
   *
   * 调试台没开的时候 `window.__designAttach` 是 undefined 或者自己 return，
   * 这一句对一个普通用户来说等于不存在。
   */
  /*
   * ⚠️ **每次重画都调**，不只是调试态 —— 他改过文字之后，**切页**同样会重画，
   *    不重新铺一遍，改过的字就当场打回原样了（那就谈不上"即时生效"）。
   *    调试台没启用过时 `__designAttach` 是 undefined，这一句等于不存在。
   */
  try { if (window.__designAttach) window.__designAttach(); } catch (err) { console.error('[设置] 调试台回挂失败：' + err.message); }
}

/**
 * 切到某一页。
 *
 * ⚠️ 这里**不管窗口显隐** —— 那归主进程（overlay.cjs）。
 *    原来这个函数还顺手做了两件事：
 *      · `#panel` 加 `.open` —— 那是「卡片从她旁边弹出来」的动画，现在整页
 *        就是卡片，没得弹
 *      · `win.focusable(true)` —— 因为面板当时跟她在**同一个窗口**里，而那个
 *        窗口平时 focusable:false（免得抢他打游戏的按键）。面板现在是独立
 *        窗口，天生就收键盘，不用再动主窗口
 */
export function openPanel(page) {
  if (page) showPage(page);
}

/** 关掉自己这个窗口（其实是 hide，主进程复用） */
export function closePanel() {
  try { window.yachiyo.ov.close(); } catch { /* 桥没接上就算了 */ }
}

/**
 * 只是个占位 —— **窗口显隐现在归主进程管**（overlay.isOpen('panel')），
 * 这个页面自己问不出来。
 * ⚠️ 删掉它会把 main/index.cjs 里 import 的那几处一起打断，所以留着。
 */
export const panelOpen = () => false;
