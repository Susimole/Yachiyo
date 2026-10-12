/**
 * 设置面板 · 界面调试台
 * ==========================================================================
 *
 * 干什么用的：
 *     他要把设置面板的**区域摆放**和**介绍文字**逐项调一遍。
 *     正常用面板的时候它是**完全隐身**的 —— 只有从「高级 → 界面调试 → 调试台」
 *     点进来才展开，退出后原样还原。
 *
 * ★ 三个决定（2026-10-13 他定的）：
 *     ① **只导出 JSON，不写回任何配置** —— 调完他把 JSON 给我，我改进源码。
 *        好处：代码里始终只有**一套值**，不会出现「改了没生效、不知道听谁的」。
 *     ② **不碰正式面板** —— 所有手柄/虚线框都是调试时才创建的 DOM，
 *        退出即销毁。调 bug 调坏了也只坏调试台，平时用的面板不受影响。
 *     ③ 入口在**高级页最下面一颗不起眼的小按钮**。
 *
 * 怎么调：
 *     · **拖**顶栏下沿 → 顶栏高度
 *     · **拖**左栏右沿 → 左栏宽度
 *     · **点文字**直接改（contenteditable），改过的会用虚线标出来
 *     · 其余数值在底部那一条上调
 *
 * ⚠️ 为什么用 CSS 变量而不是直接写 inline style：
 *     style.css 里各处都是硬编码的 px。调试台如果直接 `el.style.height = …`，
 *     一旦 showPage 重画，内联样式全丢。
 *     走 `--d-*` 变量挂在 `.card` 上 —— **重画也不影响**（变量在祖先节点上），
 *     退出时删掉变量即完全还原。
 */

/* ============================================================
   跟 settings.js 的关系 —— **只能用动态 import**
   ============================================================
   静态 `import { showPage } from './settings.js'` 会成环：
   那边是 `import('./design.js')`，这边再静态指回去，谁先求值就成了运气。

   所以这几个口全走**运行时动态导入**，缓存在下面。
   ⚠️ `enable()` 里 `await initDeps()` 一次，之后同步用 —— 别在别处再 import。
   ============================================================ */
let showPageFn = null;          // settings.js 的 showPage
let setOverrideFn = null;       // settings.js 的 setGroupOverride
let PAGES_FOR_DESIGN = null;    // settings.js 的 PAGES_FOR_DESIGN
let ALL_GROUPS = null;          // settings.js 的 ALL_GROUPS
let curPage = 'habit';          // 当前在哪一页（搬动分组时要写进覆盖表）

async function initDeps() {
  if (showPageFn) return;
  const m = await import('./settings.js');
  showPageFn = m.showPage;
  setOverrideFn = m.setGroupOverride;
  PAGES_FOR_DESIGN = m.PAGES_FOR_DESIGN;
  ALL_GROUPS = m.ALL_GROUPS;
}

/** 重画当前页（改了覆盖表之后必须来一发） */
function showPageNow() {
  if (typeof showPageFn === 'function') showPageFn(curPage);
}

/* ============================================================
   可调参数表
   ============================================================ */

/**
 * 每条 = 一个 CSS 变量 + 一个范围 + 中文说明。
 * `sel` 只用来在页面上画出轮廓框（量位置给他看），不参与改值。
 */
/**
 * ⚠️⚠️ `def` 必须是 **style.css / overlay.css 里此刻的真实值** ——
 *     对不上的话，一开调试台那几处会当场跳一下（他第一眼就会看出来）。
 *     下面的数都是 2026-10-13 从样式表里逐个抠出来抄的：
 *        .card border-radius = var(--r-card) → 14
 *        .bar  height         = var(--bar-h)  → 44
 *        .p-side width        = 158px
 *        .p-main padding      = 20px 24px
 *        .p-main h2           = 19px
 *        .p-main .desc        = 12.5px
 *        .group margin-bottom = 14px
 */
const NUM_PARAMS = [
  /* ---- 大结构 ---- */
  { g:'结构', k: '--d-bar-h',     label: '顶栏高',     min: 28, max: 72,  step: 1,   def: 44,   sel: '.bar' },
  { g:'结构', k: '--d-side-w',    label: '左栏宽',     min: 90, max: 220, step: 1,   def: 158,  sel: '.p-side' },
  { g:'结构', k: '--d-main-pad',  label: '内容留白',   min: 0,  max: 48,  step: 1,   def: 24,   sel: '#pMain' },
  { g:'结构', k: '--d-radius',    label: '卡片圆角',   min: 0,  max: 28,  step: 1,   def: 14,   sel: '.card' },

  /* ---- 全局间距 ---- */
  { g:'间距', k: '--d-gap',       label: '分组间距',   min: 4,  max: 40,  step: 1,   def: 14,   sel: '.group' },
  { g:'间距', k: '--d-row-h',     label: '行高',       min: 24, max: 80,  step: 1,   def: 44,   sel: '.row' },
  { g:'间距', k: '--d-row-pad',   label: '行上下留白', min: 0,  max: 30,  step: 1,   def: 9,    sel: '.row' },
  { g:'间距', k: '--d-row-gap',   label: '行内间距',   min: 0,  max: 40,  step: 1,   def: 14,   sel: '.row' },
  { g:'间距', k: '--d-group-pad', label: '组内上下留白', min: 0, max: 24, step: 1,   def: 4,    sel: '.group' },
  { g:'间距', k: '--d-body-gap',  label: '控件间距',   min: 0,  max: 30,  step: 1,   def: 12,   sel: '.row .body' },
  { g:'间距', k: '--d-desc-gap',  label: '介绍文字下距', min: 0, max: 40, step: 1,  def: 16,   sel: '#pMain .desc' },

  /* ---- 字号 ---- */
  { g:'字号', k: '--d-h2-size',   label: '页面标题',   min: 12, max: 30,  step: 1,   def: 19,   sel: '#pMain h2' },
  { g:'字号', k: '--d-desc-size', label: '页面介绍',   min: 10, max: 20,  step: 0.5, def: 12.5, sel: '#pMain .desc' },
  { g:'字号', k: '--d-gtitle-size', label: '分组标题', min: 9,  max: 20,  step: 0.5, def: 12,   sel: '.group > .g-title' },
  { g:'字号', k: '--d-label-size', label: '行标签',    min: 9,  max: 20,  step: 0.5, def: 13.5, sel: '.row .label' },
  { g:'字号', k: '--d-hint-size', label: '提示小字',   min: 8,  max: 16,  step: 0.5, def: 10.5, sel: '.row .label small' },
  { g:'字号', k: '--d-nav-size',  label: '左栏导航',   min: 10, max: 20,  step: 0.5, def: 13,   sel: '.p-side .nav' },

  /* ---- 字距 / 内距 ---- */
  { g:'字距', k: '--d-label-w',   label: '标签列宽',   min: 60, max: 200, step: 1,   def: 92,   sel: '.row .label' },
  { g:'字距', k: '--d-gtitle-ls', label: '分组标题字距', min: -1, max: 4, step: 0.1, def: 0.4,  sel: '.group > .g-title' },
  { g:'字距', k: '--d-gtitle-pad',label: '分组标题上距', min: 0, max: 26, step: 1,   def: 11,   sel: '.group > .g-title' },
  { g:'字距', k: '--d-nav-pad',   label: '导航项高',   min: 4,  max: 20,  step: 1,   def: 8,    sel: '.p-side .nav' },
  { g:'字距', k: '--d-hint-gap',  label: '提示文字上距', min: 0, max: 8,  step: 1,   def: 1,    sel: '.row .label small' },
];

/**
 * 面板上**固定那几处**文字。
 *
 * ⚠️ `scope` / `base` **分开写**，导出和存盘时拼成 `scope/base`：
 *    · `panel/title`  —— 顶栏标题，全面板只有一处
 *    · `page:adv/title` —— 页面标题，**按页各存各的**
 *      （不分开的话，「习惯」页改过的介绍会跟着跑到「高级」页去）
 *
 * ⚠️ 别写成 `panel:panel.title` 这种 —— 之前就是这么写的，键名啰嗦一倍，
 *    而且跟别处的命名规则对不上。
 */
const TEXT_PARAMS = [
  { scope: 'panel',            base: 'title', sel: '.bar .title' },
  { scope: 'panel',            base: 'brand', sel: '.p-foot b' },
  { scope: 'PAGE',             base: 'title', sel: '#pMain h2' },     // PAGE = 按页
  { scope: 'PAGE',             base: 'desc',  sel: '#pMain .desc' },
];

/**
 * 给页面上所有内容文字挂 `<span>`（不带样式，纯定位）+ contenteditable。
 *
 * 覆盖：分组标题 / 每行的标签 / 标签下面那行提示小字 / 按钮文字。
 * ⚠️ 键用「组序号 + 行序号」**不用文字内容** —— 内容正是要改的东西，
 *    拿它当键，改一个字就找不回来了。
 * ⚠️ `<small>` 里可能夹着「待接」那个 `<i>` —— 那是标记不是文案，要跳过。
 */
function makeContentEditable() {
  const main = $('#pMain');
  if (!main) return;
  const groups = $$('#pMain .group');

  /*
   * ★★ scope 用**组 id**（`data-dgroup` = PAGES 里那个 `__gid`），不用"第几组"。
   *
   * ⚠️ 为什么：他要**在页面之间搬分组**。搬完之后序号全变了 ——
   *    「习惯页第 0 组」搬到高级页可能变成第 3 组，
   *    用序号当 key 的话，他在习惯页改的文字会**串到高级页去**。
   *    `__gid`（`页#序号`，在 settings.js 里定死）是跟着分组走的，搬到哪都认得出。
   *
   * 键的格式：`<scope>|<组内键>` —— `|` 由 wrapEditable 切开。
   */
  groups.forEach((box) => {
    const gid = box.dataset.dgroup || 'anon';
    const key = (base) => gid + '|' + base;

    // 分组标题
    const gt = $('.g-title', box);
    if (gt) wrapEditable(gt, key('title'), 'c-gtitle');

    $$('.row', box).forEach((row, ri) => {
      const lab = $('.label', row);
      if (lab) {
        // 标签本身（跳过里面的 <small> / <i class="todo">）
        wrapEditable(lab, key(`r${ri}.label`), 'c-label', { skipChildren: true });
        const hint = $('small', lab);
        if (hint) wrapEditable(hint, key(`r${ri}.hint`), 'c-hint');
      }
      const btn = $('.body .btn', row);
      if (btn) wrapEditable(btn, key(`r${ri}.btn`), 'c-btn');
    });
  });

}

/**
 * 把元素里的**纯文本**包进一个 span 并设成可编辑。
 * @param {Element} host
 * @param {string} key
 * @param {string} cls 标记 class，导出时靠它认类型
 * @param {{skipChildren?:boolean}} [o] 子元素（small / i）保持原样，只包自己那截文本
 */
function wrapEditable(host, key, cls, o = {}) {
  if (host.dataset.dkey) return;                  // 已经包过，别重复
  // 取"属于这个元素自己"的文本节点
  const own = [...host.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim());
  if (!own.length) return;

  /*
   * ★ 键分两截（`key` 里已经含了 scope）：
   *   `data-dscope` = 组 id 或 `page:<页>`；`data-dbase` = 组内那一项的键。
   *   组 id 用 `__gid`（跨页稳定），行/项用序号 —— 见 makeContentEditable 处的说明。
   */
  const cut = key.indexOf('|');
  const scope = cut > 0 ? key.slice(0, cut) : '';
  const base = cut > 0 ? key.slice(cut + 1) : key;

  const span = document.createElement('span');
  // ⚠️ `d-editable` 只在调试态加 —— 那是视觉标记（虚线框），
  //    退出之后还挂着的话，满屏虚线框却一个都改不动，是骗人的。
  span.className = (on ? 'd-editable ' + cls : 'd-txt');
  span.dataset.dkey = key;
  span.dataset.dscope = scope;
  span.dataset.dbase = base;
  span.textContent = own[0].textContent.trim();

  if (o.skipChildren) {
    // 只替换第一个文本节点，后面的 <small> / <i> 原地不动
    host.replaceChild(span, own[0]);
  } else {
    host.innerHTML = '';
    host.appendChild(span);
  }

  /*
   * ★★ 这两个标记**永远留着**（不管是不是调试态），但 `contentEditable` 只在调试时开。
   *
   * ⚠️ 为什么非留着：他退出调试台之后，改动得**继续看得见**（"即时生效"嘛）。
   *    而退出会触发一次重画 —— 重画出来的新元素如果没带 `dbase`，
   *    `applyTexts()` 就一个都对不上，改过的字会当场打回原样。
   *    带着标记但不可编辑：显示的是他改过的内容，但他改不动（那才是退出调试台的语义）。
   */
  span.dataset.dstandby = '1';
  span.spellcheck = false;

  /*
   * ★★ 敲一个字就落实（`input`），不是等失焦。
   *    他 2026-10-13 报的「切换分组后改动失效」就是这里没存 ——
   *    旧版只把字留在 DOM 里，重画一次就没了。
   *
   * ⚠️ 只写 `state` + 防抖落盘，**不动 DOM**：正在打字的元素不能去改它的 textContent，
   *    那会把光标顶到末尾（中文输入法下尤其难受）。
   */
  span.addEventListener('input', () => {
    const v = (span.textContent || '').trim();
    if (!state.文字[scope]) state.文字[scope] = {};
    state.文字[scope][base] = v;
    span.classList.add('d-edited');
    scheduleSave();
  });

  // ★ 只有**调试态**才真的可编辑。退出之后保留内容、但改不动。
  if (on) {
    span.contentEditable = 'true';
    span.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); span.blur(); } }, true);
  }

  textEls.set(key, span);       // 记进本轮（退出调试台时要按它把类摘干净）
}

/* ============================================================
   状态
   ============================================================ */

let on = false;
let bar = null;                 // 底部那条调试栏
let marks = [];                 // 画在页面上的轮廓框
let handles = [];               // 拖拽把手
/**
 * 所有被挂上 contentEditable 的元素 —— **按 key 存 Map，不是数组**。
 *
 * ⚠️⚠️ 2026-10-13 从导出的 JSON 里看出来的隐患：
 *   `#pMain` 每次重画都会再造一批新元素，如果只往数组里 push，
 *   **切一次页就攒一批**。切过三页之后导出，`文字` 段里同一批 key
 *   （`group.3.title` 之类）会有好几份互相打架的值，
 *   而且里面混着**别的页**的文案 —— 拿去改代码就会把文案贴错页。
 *   ⇒ 换 Map：重画前先踢掉所有"已经不在 DOM 里"的，同一个 key 只留最新的。
 */
const textEls = new Map();      // key -> element
let dragging = null;            // 正在拖的把手
let dragGroup = null;           // 正在拖的分组（跨区移动用）

/*
 * ⚠️⚠️ `marks` 和 `handles` **必须分开管**（2026-10-13 探针抓到的）：
 *     我第一版把把手也 push 进了 `marks`，而 `drawMarks()` 第一件事就是
 *     `clearMarks()` —— 于是把手**刚建出来就被下一次重画清掉了**，
 *     页面上一个把手都没有，还不报错。
 *     （探针断言 `handles.length === 2` 才把它揪出来。）
 */

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

/** 取值：先看有没有变量，没有就用默认值 */
function getVar(k, def) {
  const card = $('.card');
  if (!card) return def;
  const v = card.style.getPropertyValue(k).trim();
  return v ? parseFloat(v) : def;
}

function setVar(k, v) {
  const card = $('.card');
  if (card) card.style.setProperty(k, v + 'px');
}

/* ============================================================
   轮廓框 —— 把每个区域的真实位置量出来给他看
   ============================================================ */

function drawMarks() {
  clearMarks();
  const card = $('.card');
  if (!card) return;
  const cb = card.getBoundingClientRect();

  for (const p of NUM_PARAMS) {
    // .card 自己就是整张卡片，不用画框
    if (p.sel === '.card') continue;
    const el = $(p.sel);
    if (!el) continue;
    const r = el.getBoundingClientRect();
    const m = document.createElement('div');
    m.className = 'd-mark';
    m.dataset.param = p.k;
    m.style.cssText = `left:${Math.round(r.left - cb.left)}px;top:${Math.round(r.top - cb.top)}px;` +
      `width:${Math.round(r.width)}px;height:${Math.round(r.height)}px;`;
    m.innerHTML = `<i class="d-mark-tag">${p.label} ${Math.round(r.width)}×${Math.round(r.height)}</i>`;
    card.appendChild(m);
    marks.push(m);
  }
}

function clearMarks() {
  for (const m of marks) m.remove();
  marks = [];
}

/* ============================================================
   拖拽把手
   ============================================================ */

/**
 * 拖顶栏下沿 → 顶栏高度；拖左栏右沿 → 左栏宽度。
 * ⚠️ 拖拽期间**必须实时更新**（oninput 不是 onchange）——
 *    不实时的话他松手才知道调成什么样，来回试十次就烦了。
 */
function handleDrag(e, kind) {
  e.preventDefault();
  e.stopPropagation();
  const card = $('.card');
  const first = { x: e.clientX, y: e.clientY };
  const startBar = getVar('--d-bar-h', 44);
  const startSide = getVar('--d-side-w', 132);

  const move = (ev) => {
    if (kind === 'bar') {
      const d = Math.round(ev.clientY - first.y);
      setVar('--d-bar-h', Math.max(28, Math.min(72, startBar + d)));
    } else {
      const d = Math.round(ev.clientX - first.x);
      setVar('--d-side-w', Math.max(90, Math.min(220, startSide + d)));
    }
    drawMarks();
    syncInputs();
    // 把手位置走 CSS 变量，本来就会跟着走；这里再显式摆一次，
    // 免得某些 Chromium 版本对 calc() 里的嵌套 var() 更新有延迟
    placeHandles();
  };
  const up = () => {
    window.removeEventListener('mousemove', move, true);
    window.removeEventListener('mouseup', up, true);
    card.classList.remove('d-dragging');
    dragging = null;
  };
  dragging = kind;
  card.classList.add('d-dragging');
  window.addEventListener('mousemove', move, true);
  window.addEventListener('mouseup', up, true);
}

/** 把手的位置用 CSS 变量算 —— 拖动时它自己就跟着走，不用每帧重摆 */
function placeHandles() {
  for (const h of handles) {
    if (h.dataset.kind === 'bar') {
      h.style.top = 'calc(var(--d-bar-h, var(--bar-h, 44px)) - 4px)';
    } else {
      h.style.left = 'calc(var(--d-side-w, 158px) - 4px)';
      h.style.top = 'calc(var(--d-bar-h, var(--bar-h, 44px)))';
    }
  }
}

function addHandles() {
  const card = $('.card');
  if (!card) return;
  const mk = (cls, kind) => {
    const h = document.createElement('div');
    h.className = 'd-handle ' + cls;
    h.dataset.kind = kind;
    h.title = kind === 'bar' ? '拖动改顶栏高度' : '拖动改左栏宽度';
    h.onmousedown = (e) => handleDrag(e, kind);
    card.appendChild(h);
    handles.push(h);            // ★ 进 handles，**不进 marks**
  };
  mk('d-h-bar', 'bar');
  mk('d-h-side', 'side');
  placeHandles();
}

function clearHandles() {
  for (const h of handles) h.remove();
  handles = [];
}

/* ============================================================
   底部调试栏
   ============================================================ */

function buildBar() {
  bar = document.createElement('div');
  bar.className = 'd-bar';

  /*
   * ⚠️ 参数有 22 条了，平铺成一坨没法看 —— 按 `g`（组名）分栏。
   *    每组一个竖条，组名竖着写在左边。
   */
  const left = document.createElement('div');
  left.className = 'd-bar-l';
  const groups = [];
  for (const p of NUM_PARAMS) {
    let grp = groups.find((x) => x.name === p.g);
    if (!grp) { grp = { name: p.g, items: [] }; groups.push(grp); }
    grp.items.push(p);
  }
  for (const grp of groups) {
    const col = document.createElement('div');
    col.className = 'd-grp';
    const h = document.createElement('div');
    h.className = 'd-grp-h';
    h.textContent = grp.name;
    col.appendChild(h);
    for (const p of grp.items) {
      const row = document.createElement('label');
      row.className = 'd-item';
      row.innerHTML = `<span>${p.label}</span>`;
      const inp = document.createElement('input');
      inp.type = 'number';
      inp.min = p.min; inp.max = p.max; inp.step = p.step;
      inp.dataset.vk = p.k;
      inp.value = getVar(p.k, p.def);
      inp.oninput = () => {
        const n = Number(inp.value);
        if (!Number.isFinite(n)) return;
        const v = Math.max(p.min, Math.min(p.max, n));
        setVar(p.k, v);
        // ★ 记进状态并落盘 —— 这样切页/重启都还在
        state.结构[p.k.replace(/^--d-/, '')] = v;
        scheduleSave();
        drawMarks();
      };
      row.appendChild(inp);
      col.appendChild(row);
    }
    left.appendChild(col);
  }

  const right = document.createElement('div');
  right.className = 'd-bar-r';

  const bOut = document.createElement('button');
  bOut.className = 'd-btn d-btn-main';
  bOut.textContent = '导出 JSON';
  bOut.onclick = () => exportJson();

  const bReset = document.createElement('button');
  bReset.className = 'd-btn';
  bReset.textContent = '全部还原';
  bReset.title = '参数 + 分组摆放，都回到原样';
  bReset.onclick = async () => {
    const card = $('.card');
    for (const p of NUM_PARAMS) card.style.removeProperty(p.k);
    /*
     * ★ 「全部还原」= 把**存下来的覆盖**整个清掉。
     *
     * ⚠️ 光清变量不够 —— 文字改动和分组搬动都在 `state` 里、还落了盘，
     *    不清盘的话下次进调试台它们又回来了，按钮就名不副实。
     *    （旧版本还叫「还原」的时候只管参数，那是错的。）
     */
    state = { 结构: {}, 文字: {}, 分组移动: [] };
    savedTextKeys.clear();
    moves = [];
    if (setOverrideFn) setOverrideFn(new Map());
    try { await window.yachiyo?.ov?.designClear?.(); } catch { /* 删不掉就算了 */ }
    showPageNow();
    flash('✓ 已全部还原（覆盖文件也删了）');
  };

  const bExit = document.createElement('button');
  bExit.className = 'd-btn';
  bExit.textContent = '退出调试';
  bExit.onclick = () => disable();

  /*
   * ★ 告诉他改动存哪儿了 —— 他上一轮就是「没找到 JSON 放在哪」。
   *   小字灰字，不抢眼，但找得到。
   */
  const hint = document.createElement('div');
  hint.className = 'd-where';
  hint.textContent = '改动即时生效，存在：';
  const pathLine = document.createElement('div');
  pathLine.className = 'd-where-p';
  pathLine.textContent = '（读路径中…）';
  Promise.resolve(window.yachiyo?.ov?.designWhere?.()).then(
    (p) => { if (p) pathLine.textContent = p; },
    () => { pathLine.textContent = '%APPDATA%\\Yachiyo\\design.json'; });

  right.append(bOut, bReset, bExit, hint, pathLine);

  bar.append(left, right);
  $('.card').appendChild(bar);
}

/** 外部改了值（拖拽）→ 把输入框同步过来 */
function syncInputs() {
  if (!bar) return;
  for (const inp of $$('input[data-vk]', bar)) {
    const p = NUM_PARAMS.find((x) => x.k === inp.dataset.vk);
    if (p) inp.value = getVar(p.k, p.def);
  }
}

/* ============================================================
   文字可编辑
   ============================================================ */

/**
 * 把一个元素标成可编辑。
 * ⚠️ 加 `dataset.marked` 是为了**防重复**：顶栏标题那几处不随页重建，
 *   `attachToPage` 每次重画都会再跑一遍 `makeEditable`，
 *   不防的话会给它们**叠一堆一模一样的 keydown 监听**（跑一百次就一百个）。
 */
function markEditable(el, dkey, scope, base, cls) {
  el.dataset.dkey = dkey;         // 导出扫 DOM 用的原始键
  el.dataset.dscope = scope;
  el.dataset.dbase = base;
  el.dataset.dstandby = '1';      // 标记"这是调试台管的"，退出后也留着（见 wrapEditable）
  /*
   * ⚠️ `d-editable` 是**视觉标记**（虚线框 + 手型光标），只在调试态加。
   *    非调试态也加的话，退出调试台之后满屏虚线框 —— 而且元素明明改不动，
   *    看着像能编辑，是骗人的。（探针量到残留 43 个才发现的。）
   */
  if (on) {
    el.contentEditable = 'true';
    el.classList.add('d-editable');
    if (cls) el.classList.add(cls);
  }
  // ⚠️ 监听器**只挂一次**（`marked` 是 JS 侧私有标记）：
  //    顶栏标题那几处不随页重建，`attachToPage` 每重画一次就会再标一次，
  //    不防的话会叠一堆一模一样的监听器。
  if (el.dataset.marked) return;
  el.dataset.marked = '1';
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } }, true);
  el.addEventListener('input', () => {
    const v = (el.textContent || '').trim();
    if (!state.文字[scope]) state.文字[scope] = {};
    state.文字[scope][base] = v;
    el.classList.add('d-edited');
    scheduleSave();
  });
}

function makeEditable() {
  textEls.clear();          // ★ 每次重建 —— 不"记账"，只记这一轮挂上去的

  /*
   * ① 固定那几处（顶栏标题 / 左栏署名 / 页面标题 / 页面介绍）
   *
   * ⚠️ 页面标题和介绍**按页各存各的** —— scope 用 `page:<页>`。
   *    不然「习惯」页改过的介绍会跟着跑到「高级」页去。
   */
  const pageScope = 'page:' + (curPage || '?');
  for (const t of TEXT_PARAMS) {
    const el = $(t.sel);
    if (!el) continue;
    const sc = (t.scope === 'PAGE') ? pageScope : t.scope;
    markEditable(el, `${sc}|${t.base}`, sc, t.base, null);
    textEls.set(`${sc}|${t.base}`, el);
  }
  // ② 页面上跟着内容走的那批（分组标题 / 每行的标签和提示 / 按钮）
  makeContentEditable();
}

/**
 * 只清标记 —— **DOM 的还原交给整页重画**（`showPage`），不自己拆。
 *
 * ⚠️ 我第一版想手动把包出来的 `<span>` 拆掉、把文本塞回原位：
 *    条件写得又绕又脆（`childElementCount === 1` 之类的），
 *    而 `.label` 里还夹着 `<small>` / `<i>》，一旦判错就会**吃掉提示文字**。
 *    既然 `showPage` 本来就会整片重建 `#pMain`，那就别自己动手 ——
 *    重画一次，DOM 连包过的 span 带 contenteditable 一起消失，天然还原。
 */
function clearEditable() {
  for (const el of textEls.values()) {
    el.contentEditable = 'false';
    /*
     * ⚠️⚠️ **类必须自己摘**（2026-10-13 探针抓到的）。
     *     我原来只关 contentEditable，想着"DOM 交给 showPage 重画" ——
     *     但 `#pMain` **外面**还有两处可编辑（`.bar .title` 顶栏标题、
     *     `.p-foot b` 左栏署名），它们在 `.card` 里，重画 `#pMain` 带不走，
     *     于是退出调试台后它们**一直挂着虚线框**（探针量到残留 2 个）。
     *
     * ⚠️⚠️ 但 `data-dkey` / `data-dscope` / `data-dbase` **一个都不能删**：
     *     退出调试台之后改动要**继续看得见**，而退出会触发重画 ——
     *     标记删了，重画出来的新元素对不上号，`applyTexts()` 铺不回去，
     *     他改过的字会当场打回原样。标记只是"记号"，留着不显示任何东西。
     */
    el.classList.remove('d-editable', 'c-gtitle', 'c-label', 'c-hint', 'c-btn', 'd-edited');
  }
  textEls.clear();
}

/* ============================================================
   跨区移动分组
   ============================================================
   他要的：「区域内组可以跨区移动（例：将「AI接入-联网」移动至「高级」分区中）」。

   怎么实现的（两个都给了，他两个都要）：
     · **拖拽** —— 按住分组标题拖，画面里跟一个幽灵框；
         · 松在**左栏某个导航项**上 → 整组搬到那一页
         · 松在**另一个分组**上     → 插到它前面（同页就是调顺序）
         · 松在自己身上/空处         → 什么也不做
     · **下拉** —— 每个分组标题右边一个小下拉，直接选去哪页（拖歪了能用它兜底）

   ⚠️ 搬动**不改 PAGES 本身**，只改 settings.js 里那个 `groupOverride` Map。
      所以「还原」按钮能一键全恢复 —— PAGES 从来没被碰过。
   ============================================================ */

let moves = [];                 // [{gid, to, at}] —— 导出用，也是重画的依据

/* ============================================================
   ★★ 覆盖状态 —— 改了就生效，不是"导出给辉夜改代码"
   ============================================================
   他 2026-10-13 的原话：「改成我做修改即时生效吧，每次切换分组后都会让之前的改动失效」。

   ⚠️⚠️ 那个"失效"的根因就在这儿：`showPage` 重画 `#pMain` 时，
      **新 DOM 是从 PAGES 的数据重新生成的** —— 你 contenteditable 敲进去的字
      没有任何地方存着，重建一次就没了。改参数也一样（变量挂在 .card 上所以活着，
      但那只是运气好）。

   ⇒ 所有改动都记在 `state` 里，**每次重画之后自动写回 DOM**；
      并且防抖落盘到 `%APPDATA%\Yachiyo\design.json`，重启也还在。
   ============================================================ */
let state = { 结构: {}, 文字: {}, 分组移动: [] };
let savedTextKeys = new Set();   // 已经写进过 state 的键 —— 用来判断"基线"从哪儿取
let saveTimer = null;

/** 从主进程读回上次的覆盖（进调试台时调一次） */
async function loadState() {
  const api = window.yachiyo && window.yachiyo.ov;
  if (!api || !api.designLoad) return;
  try {
    const j = await api.designLoad();
    if (j && typeof j === 'object') {
      state = { 结构: j.结构 || {}, 文字: j.文字 || {}, 分组移动: j.分组移动 || [] };
      moves = Array.isArray(state.分组移动) ? state.分组移动.slice() : [];
    }
  } catch { /* 读不到就当没有覆盖 */ }
}

/** 防抖落盘 —— 拖滑块会一路触发，不能每次都写盘 */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const api = window.yachiyo && window.yachiyo.ov;
    if (!api || !api.designPut) return;
    state.分组移动 = moves.slice();
    api.designPut(state).then(
      (r) => { if (r && r.ok) flash('✓ 已生效（' + r.bytes + ' 字节）'); },
      () => flash('✗ 存不上，看看日志'));
  }, 400);
}

/**
 * 把状态里的覆盖写回 DOM —— **每次重画之后必须调一次**。
 *
 * ⚠️ 顺序要紧：先套变量（会改布局），再铺文字（改内容），
 *    最后才是分组的搬动（它会触发再一次重画）。搬动在 applyOverride 里做。
 */
function applyState() {
  const card = $('.card');
  if (card) {
    for (const [k, v] of Object.entries(state.结构 || {})) {
      if (Number.isFinite(Number(v))) card.style.setProperty('--d-' + k, Number(v) + 'px');
    }
  }
  syncInputs();
  applyTexts();
}

/**
 * 把覆盖过的文字铺回 DOM。
 *
 * ⚠️ 键的组成见 `keyFor` —— 组用 `__gid`（稳定），行/项用序号。
 *    用 `gid` 而不是"第几组"是**必须**的：切页之后序号会变，
 *    用序号的话「习惯页第 0 组」和「高级页第 0 组」会串味。
 */
function applyTexts() {
  const cards = $$('#pMain .d-editable[data-dbase]');
  for (const el of cards) {
    const sc = el.dataset.dscope;
    const base = el.dataset.dbase;
    const ov = (sc && state.文字 && state.文字[sc]) ? state.文字[sc][base] : undefined;
    if (ov === undefined) continue;      // 没覆盖过就保持源码原样
    const t = el.textContent;
    if (t === ov) continue;
    el.textContent = ov;
    el.classList.add('d-edited');
  }
  return cards.length;
}

/** 重建覆盖表并重画当前页 */
function applyOverride() {
  try {
    const groupsById = ALL_GROUPS();
    const orig = PAGES_FOR_DESIGN();

    // 先从"原始结构"复制一份出来当底
    const map = new Map();
    for (const p of orig) map.set(p.k, p.groups.slice());

    // 再按搬动记录逐条应用
    for (const mv of moves) {
      for (const [k, arr] of map) {
        const i = arr.findIndex((g) => g.__gid === mv.gid);
        if (i >= 0) { arr.splice(i, 1); break; }
      }
      const dst = map.get(mv.to);
      if (!dst) { console.warn('[调试台] 没有目标页：' + mv.to); continue; }
      const g = groupsById.get(mv.gid);
      if (!g) { console.warn('[调试台] 找不到分组：' + mv.gid); continue; }
      const at = (typeof mv.at === 'number' && mv.at >= 0 && mv.at <= dst.length) ? mv.at : dst.length;
      dst.splice(at, 0, g.group);
    }

    setOverrideFn(map);
    showPageNow();
  } catch (err) {
    /*
     * ⚠️ 不能吞 —— 这里一旦抛，表现是「搬动记录写进去了、覆盖表还是空的、
     *    页面纹丝不动、一句报错都没有」，能查半天（2026-10-13 就是这么栽的）。
     */
    console.error('[调试台] 应用分组搬动失败：' + err.message + '\n' + err.stack);
    if (bar) {
      let t = $('.d-toast', bar);
      if (!t) { t = document.createElement('span'); t.className = 'd-toast'; bar.appendChild(t); }
      t.style.color = '#e03160';
      t.textContent = '✗ 搬动失败：' + err.message;
      t.classList.add('on');
    }
  }
}

/** 搬一个组 —— 记录 + 重画（同一个组搬多次只留最后一次） */
function moveGroup(gid, to, at) {
  moves = moves.filter((m) => m.gid !== gid);
  moves.push({ gid, to, at: typeof at === 'number' ? at : null });
  state.分组移动 = moves.slice();     // ★ 记进状态并落盘（重启也还在）
  scheduleSave();
  applyOverride();
}

/** 撤掉某一次搬动（下拉选"回原来那页"时用） */
function unlinkGroup(gid) {
  moves = moves.filter((m) => m.gid !== gid);
  state.分组移动 = moves.slice();
  scheduleSave();
  applyOverride();
}

function installGroupMove() {
  const card = $('.card');
  if (!card) return;

  const navs = $$('#navs .nav');
  const groups = $$('#pMain .group');

  // ---- ① 左栏导航：拖到它身上 = 搬到那一页 ----
  for (const n of navs) {
    if (n.dataset.dnav) continue;
    n.dataset.dnav = '1';
    n.classList.add('d-nav-drop');
    n.addEventListener('dragover', (e) => {
      if (!dragGroup) return;
      e.preventDefault();
      $$('.d-nav-drop').forEach((x) => x.classList.remove('d-over'));
      n.classList.add('d-over');
    });
    n.addEventListener('dragleave', () => n.classList.remove('d-over'));
    n.addEventListener('drop', (e) => {
      if (!dragGroup) return;
      e.preventDefault();
      n.classList.remove('d-over');
      const to = n.dataset.k;
      const cur = $('.card').dataset.dpage;
      if (to === cur) { unlinkGroup(dragGroup); }          // 拖回自己那页 = 撤回
      else moveGroup(dragGroup, to, null);                 // 放那页最后
      dragGroup = null;
    });
  }

  // ---- ② 分组本身：拖到另一个组上 = 插到它前面 ----
  groups.forEach((box, idx) => {
    const gid = box.dataset.dgroup;
    const title = $('.g-title', box);
    if (!gid || !title) return;

    title.classList.add('d-grab');
    title.draggable = true;
    title.title = '按住拖到别的页 / 别的组';

    title.addEventListener('dragstart', (e) => {
      dragGroup = gid;
      box.classList.add('d-src');
      try { e.dataTransfer.setData('text/plain', gid); } catch { /* 某些版本不让设，无所谓 */ }
      e.dataTransfer.effectAllowed = 'move';
    });
    title.addEventListener('dragend', () => {
      dragGroup = null;
      box.classList.remove('d-src');
      $$('.d-over').forEach((x) => x.classList.remove('d-over'));
      $$('.d-drop').forEach((x) => x.classList.remove('d-drop'));
      syncGroupCtl();
    });

    box.addEventListener('dragover', (e) => {
      if (!dragGroup || dragGroup === gid) return;
      e.preventDefault();
      box.classList.add('d-drop');
    });
    box.addEventListener('dragleave', () => box.classList.remove('d-drop'));
    box.addEventListener('drop', (e) => {
      if (!dragGroup || dragGroup === gid) return;
      e.preventDefault();
      e.stopPropagation();
      box.classList.remove('d-drop');
      const cur = $('.card').dataset.dpage;
      moveGroup(dragGroup, cur, idx);          // 插到这个组前面
      dragGroup = null;
    });

    // ---- ③ 下拉兜底：拖歪了直接选页 ----
    const ctl = document.createElement('div');
    ctl.className = 'd-gctl';
    const sel = document.createElement('select');
    sel.className = 'd-gsel';
    for (const p of PAGES_FOR_DESIGN()) {
      const o = document.createElement('option');
      o.value = p.k; o.textContent = p.name;
      sel.appendChild(o);
    }
    sel.onchange = () => moveGroup(gid, sel.value, null);
    ctl.appendChild(sel);
    title.appendChild(ctl);
  });
}

/** 让每个下拉都显示"这个组现在在哪一页" */
function syncGroupCtl() {
  const cur = $('.card').dataset.dpage;
  for (const box of $$('#pMain .group')) {
    const sel = $('.d-gsel', box);
    if (sel && cur) sel.value = cur;
  }
}

/* ============================================================
   ★★ 页重画钩子 —— 这是整个调试台最关键的一处接线
   ============================================================
   ⚠️⚠️ 他 2026-10-13 报的：「点了一下其他地方，又不能编辑文本和拖动分组了」。

   根因：`showPage()` 会把 `#pMain` **整片重建**（`innerHTML = ...`），
        而可编辑文字 / 拖拽把手 / 分组下拉**全是绑在旧 DOM 上的** ——
        重建之后一个都不剩。而切页、点导航、搬完分组重画……
        都会走 `showPage`，所以**几乎每一个操作都会把它清光**。

        我第一版把"挂功能"跟"进入调试台"焊在一起（只在 `enable()` 里调一次），
        于是：进调试台 → 都好使 → **点一下左栏 → 全没了**。
        探针没抓到是因为它从头到尾没切过页（只测了下拉搬动），
        他是第一个真的用手点的 —— 这类"必经之路"的 bug 只有真人会撞上。

   ⇒ 解法：`showPage` 每次重画完都回调一次，把这几样重新挂上。
      钩子在 settings.js 的 `showPage` 末尾调，那边只认 `window.__designAttach`。
   ============================================================ */
/**
 * ★★ settings.js 每次重画 `#pMain` 之后都调这个（见那边的 showPage 末尾）。
 *
 * 它干两件事，**不管开没开调试台**：
 *   ① 重新把文字包成可标记的 span（`makeEditable`；非调试态下不给它 contentEditable）
 *   ② 把存下来的覆盖铺回去（`applyState`）—— 这就是"退出之后改动照样在"
 *
 * 调试态时再多做一步：把手柄 / 下拉 / 轮廓挂上（`attachToPage`）。
 *
 * ⚠️ 名字用 `__design` 前缀挂在 window 上，是因为 settings.js 不能静态 import 本文件
 *    （会成环，见文件头）。settings 那边只管 `if (window.__designAttach)`。
 */
window.__designAttach = () => {
  if (!stateLoaded) {
    stateLoaded = true;
    // 首次：先把盘上的覆盖读回来，读完再补一遍装饰（同步等不了 await）
    loadState().then(() => { try { window.__designAttach(); } catch { /* 补一次失败就算了 */ } });
  }
  if (on) {
    const navOn = $('#navs .nav.on');
    if (navOn && navOn.dataset.k) curPage = navOn.dataset.k;
    const card = $('.card');
    if (card) card.dataset.dpage = curPage;
    attachToPage();
  } else {
    /*
     * ⚠️ 非调试态也要跑 —— 他退出调试台之后改动得继续看得见，
     *    而**切页**同样会重画，不重新铺一遍就当场打回原样了。
     */
    makeEditable();
    applyState();
  }
};

/**
 * ★★ 装饰 + 铺回改动 —— **每次重画都要跑，不管开没开调试台**。
 *
 * ⚠️ 为什么退出调试台之后还得跑：他要"即时生效"，那就得**退出之后照样看得见**。
 *    而退出会触发一次重画 —— 新 DOM 是干净的，不重新包一遍、不重新铺一遍，
 *    他改过的字就当场打回原样了。
 *
 * 跟 `attachToPage()` 的区别：
 *   · 这个 = 「把页面弄成能显示改动的样子」（永远要做）
 *   · 那个 = 「把调试工具挂上去」（只有调试态做）
 */
/** 盘上的覆盖读回来没有 —— 用来保证只读一次 */
let stateLoaded = false;

/** 把"跟着页面走"的那几样重新挂上（重画之后必须再跑一遍） */
function attachToPage() {
  /*
   * ★ `#pMain` 每次重画都造一批**全新**元素，而**上一批**虽然已经不在 DOM 里了，
   *   `data-dkey` 还挂在它们身上 —— 导出是"扫 DOM"，本来不该受影响，
   *   但如果旧元素因为某种原因还留在文档里，就会出现**同一个 key 两份**。
   *   所以这里只做一件事：把已经**离开文档**的那些摘干净。
   *
   * ⚠️⚠️ 别在这儿 `clearEditable()` —— 那会把**外面那两处**
   *    （顶栏标题 `.bar .title`、左栏署名 `.p-foot b`）也摘掉。
   *    它们在 `.card` 里、不随 `#pMain` 重建，摘了就**再也挂不回来**：
   *    一开调试台顶栏标题就点不动，而且一声不响。
   *    2026-10-13 试过，`panel.title` 直接从导出里消失了。
   */
  for (const [, el] of [...textEls]) {
    if (document.body.contains(el)) continue;
    // ⚠️ 只清**已经离开文档**的（重画换掉的那批）。标记也一并摘掉，
    //    免得它们永远挂在游离节点上、越攒越多。
    el.contentEditable = 'false';
    el.classList.remove('d-editable', 'c-gtitle', 'c-label', 'c-hint', 'c-btn');
    delete el.dataset.dkey;
    delete el.dataset.dscope;
    delete el.dataset.dbase;
    delete el.dataset.marked;
  }

  makeEditable();        // 所有文字可编辑（含 47 行的标签/提示）—— 内部会重建记录
  installGroupMove();    // 分组拖拽把手 + 兜底下拉
  applyState();          // ★★ 把覆盖过的**写回**（文字 + CSS 变量）—— 这一步就是"改动不丢"
  drawMarks();           // 区域轮廓
  syncGroupCtl();
}

/* ============================================================
   导出
   ============================================================ */

function snapshot() {
  const out = { 结构: {}, 文字: {}, 分组移动: [] };

  // 结构（CSS 变量）
  for (const p of NUM_PARAMS) out.结构[p.k.replace(/^--d-/, '')] = getVar(p.k, p.def);

  /*
   * 文字 —— ★★ **现扫 DOM，不查内部记账**。
   *
   * ⚠️⚠️ 为什么不用 `textEls` 那个 Map（2026-10-13 的教训）：
   *   我用"往 Map 里登记"的方式维护状态，结果切页之后旧页的元素没清干净、
   *    导出的 JSON 里同一个 key 有两份打架的值，还混着**别的页**的文案。
   *    改成"重画时 clear + 重挂"之后更糟：顶栏标题那几处（不随页重建）
   *    被当成旧元素删掉，**整条 `panel.title` 从导出里消失了**。
   *    ⇒ 记账就会记错。**DOM 才是真相**：谁带着 `data-dkey` 就导谁。
   *      这样切过多少页都不会串，也不会漏。
   */
  // ⚠️ 必须是 `$$`（querySelectorAll）—— 写成 `$` 拿到的是单个元素，
  //    `for...of` 一个 DOM 元素会抛 "not iterable"，**整个导出连坐**（13 项检查全红）。
  for (const el of $$('.d-editable[data-dkey]')) {
    // 键用 scope+base 拼（`habit#2/title` 这种），比内部的 `scope|base` 好读
    const sc = el.dataset.dscope || 'panel';
    const bs = el.dataset.dbase || el.dataset.dkey;
    out.文字[sc + '/' + bs] = (el.textContent || '').trim();
  }

  // 分组移动（调试台搬过的组）
  if (moves.length) out.分组移动 = moves.slice();

  return out;
}

/**
 * 导出 —— **弹一个能看见内容的框**，不是在后台偷偷复制。
 *
 * ⚠️⚠️ 他 2026-10-13 报的：「没找到 JSON 放在哪了」。
 *    老版本只有一个按钮，走 `navigator.clipboard.writeText` + `console.log`：
 *      · 剪贴板在 `file://` 下**可能被静默拒绝**，而我不等 Promise 就先弹了
 *        「已复制到剪贴板」—— 典型的**假成功**，他 Ctrl+V 出来是空的；
 *      · 就算复制成功，他也看不到内容、更不知道能存成文件。
 *    ⇒ 现在：内容**显示在屏幕上**，加「复制」和「保存成文件」两颗按钮。
 *      保存走主进程的 dialog，存完**自动在资源管理器里点亮**那个文件。
 */
function exportJson() {
  const data = snapshot();
  const txt = JSON.stringify(data, null, 2);
  console.log('[调试台] 导出：\n' + txt);

  // 关了上一次的（连点两下别叠）
  const old = $('.d-export');
  if (old) old.remove();

  const box = document.createElement('div');
  box.className = 'd-export';

  const head = document.createElement('div');
  head.className = 'd-export-h';
  head.innerHTML = `<b>导出的内容</b><span class="d-export-n"></span>`;
  head.querySelector('.d-export-n').textContent = `${txt.length} 字符 / ${Object.keys(data.文字 || {}).length} 条文字 / ${Object.keys(data.结构 || {}).length} 项参数`;

  const ta = document.createElement('textarea');
  ta.className = 'd-export-t';
  ta.readOnly = true;                 // ⚠️ 只读：免得他手滑改了内容又存出去
  ta.value = txt;

  const foot = document.createElement('div');
  foot.className = 'd-export-f';

  const bCopy = document.createElement('button');
  bCopy.className = 'd-btn';
  bCopy.textContent = '复制';
  bCopy.onclick = async () => {
    // ⚠️ 这次**等 Promise 真的回来**再说"成功"，不再先报后验
    try {
      await navigator.clipboard.writeText(txt);
      flash('✓ 已复制');
    } catch {
      ta.select();                       // 复制不了就把内容选中，让他 Ctrl+C
      flash('剪贴板不给用 —— 已帮你选中，按 Ctrl+C');
    }
  };

  const bSave = document.createElement('button');
  bSave.className = 'd-btn d-btn-main';
  bSave.textContent = '保存成文件…';
  bSave.onclick = async () => {
    const api = window.yachiyo && window.yachiyo.ov;
    if (!api || !api.designSave) { flash('这个版本的桥没接上，用「复制」吧'); return; }
    bSave.disabled = true;
    bSave.textContent = '保存中…';
    const r = await api.designSave(txt);
    bSave.disabled = false;
    bSave.textContent = '保存成文件…';
    if (r && r.ok) flash('✓ 已存到 ' + r.file + '（' + r.bytes + ' 字节）');
    else flash('没存成：' + ((r && r.why) || '未知原因'));
  };

  const bClose = document.createElement('button');
  bClose.className = 'd-btn';
  bClose.textContent = '关掉';
  bClose.onclick = () => box.remove();

  foot.append(bCopy, bSave, bClose);
  box.append(head, ta, foot);
  $('.card').appendChild(box);
  ta.focus();
  ta.select();
  return data;
}

function flash(msg) {
  if (!bar) return;
  let t = $('.d-toast', bar);
  if (!t) { t = document.createElement('span'); t.className = 'd-toast'; bar.appendChild(t); }
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(flash._t);
  flash._t = setTimeout(() => t.classList.remove('on'), 1800);
}

/* ============================================================
   进出
   ============================================================ */

export async function enable() {
  if (on) return;
  const card = $('.card');
  if (!card) return;
  on = true;

  await initDeps();                       // 先把 settings.js 那几个口拿到

  // 记住现在在哪一页 —— 搬动分组 / 退出重画都要用
  const navOn = $('#navs .nav.on');
  if (navOn && navOn.dataset.k) curPage = navOn.dataset.k;
  card.dataset.dpage = curPage;

  /*
   * ★★ 顺序要紧（他 2026-10-13 要的「即时生效」）：
   *   ① 先把上次存下的覆盖读回来（含分组搬动）
   *   ② 用搬动重建覆盖表 —— **它会触发一次整页重画**，
   *      而重画末尾的 `__designAttach` 钩子内含 `applyState()`，
   *      参数和文字就在那一步自动铺回去了
   *   ③ 最后才挂参数栏和把手（它们长在 `.card` 上，不随页重建）
   *
   * ⚠️ 别把 `applyState()` 提到 `applyOverride()` 前面 —— 那时页面还是旧的，
   *    铺上去马上被重画冲掉。
   */
  await loadState();
  applyOverride();

  card.classList.add('d-on');
  buildBar();
  addHandles();          // 这两个把手长在 `.card` 上，不随页重画，只挂一次
  attachToPage();        // ★ 跟着页面走的那几样 —— 重画时靠 `__designAttach` 再调
  window.addEventListener('resize', drawMarks, true);

  // 面板窗口放大一点才施展得开
  try { window.yachiyo?.ov?.design?.(true); } catch { /* 主进程没加这个也行，只是挤一点 */ }
}

export function disable() {
  if (!on) return;
  on = false;
  const card = $('.card');

  /*
   * ⚠️⚠️ **退出调试台不等于还原** —— 这两件事必须分清楚（他 2026-10-13 要的）。
   *
   *   退出 = 收起**画图工具**（手柄 / 轮廓 / 参数栏 / 可编辑标记）
   *   还原 = 把改动**撤销** —— 那是「全部还原」按钮的事
   *
   * 我第一版把两者混在一起了：退出时 `removeProperty` 把所有 `--d-*` 擦了、
   * 还把搬过的分组恢复原位 —— 于是"改完退出就回原样，下次进来才又变回去"，
   * 那根本不叫即时生效。
   *
   * ⇒ 现在退出只收工具，**改动一概留着**：
   *    · CSS 变量留在 `.card` 上
   *    · 文字改动由 `applyTexts` 铺着，重画之后也还是改过的
   *    · 分组搬动继续用着那张覆盖表
   */
  clearEditable();
  clearMarks();
  clearHandles();              // ★ 别漏 —— 漏了下次进来会叠一层
  if (bar) { bar.remove(); bar = null; }
  const exp = $('.d-export'); if (exp) exp.remove();     // 导出框也带走
  if (card) {
    card.classList.remove('d-on', 'd-dragging');
    delete card.dataset.dpage;
  }
  window.removeEventListener('resize', drawMarks, true);
  // ⚠️ 这里**不碰** state / moves / 覆盖表 —— 它们就是"改动本身"

  // ② 重画一次：把包过的 <span>、下拉控件这些调试期 DOM 清干净。
  //    重画完 `__designAttach` 会因为 `on === false` 直接 return，
  //    但页面上的**文字内容**会由这次重画从 state 里重新铺回来（见下面这行）。
  showPageNow();
  applyState();
  /*
   * ★ 重画这一步很关键：调试台给文字包了 `<span contenteditable>`、
   *   给分组标题塞了下拉控件，这些都不会自己消失。
   *   重画一次 `#pMain` 整片重建，DOM 天然回到原样。
   */
  showPageNow();

  try { window.yachiyo?.ov?.design?.(false); } catch { /* 同上 */ }
}

// 启用期间他切页了 → 记下来，搬动分组时要写进覆盖表
document.addEventListener('click', (e) => {
  if (!on) return;
  const n = e.target && e.target.closest && e.target.closest('#navs .nav');
  if (n && n.dataset.k) {
    curPage = n.dataset.k;
    const card = $('.card');
    if (card) card.dataset.dpage = curPage;
  }
}, true);

export const toggle = () => (on ? disable() : enable());
export const isOn = () => on;
/** 探针用：不进调试台也能拿到当前快照，用来验导出的数据结构对不对 */
export const snapshotNow = () => snapshot();

/**
 * 探针用：看看动态导入的那几个口到底注上没。
 * ⚠️ 别删 —— 这五个只要有一个是 null，`applyOverride` 就会静默半死
 *   （搬动记录写进去了、覆盖表还是空的、页面纹丝不动、不报错）。
 *   2026-10-13 就是靠它定位的。
 */
export const depsOk = () => ({
  showPage: typeof showPageFn === 'function',
  setOverride: typeof setOverrideFn === 'function',
  pages: typeof PAGES_FOR_DESIGN === 'function',
  allGroups: typeof ALL_GROUPS === 'function',
  moves: moves.length,
});
