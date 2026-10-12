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

/** 面板上**固定那几处**文字（跟当前在哪一页无关） */
const TEXT_PARAMS = [
  { k: 'panel.title', label: '顶栏标题', sel: '.bar .title' },
  { k: 'panel.brand', label: '左栏署名', sel: '.p-foot b' },
  { k: 'page.title',  label: '页面标题', sel: '#pMain h2' },
  { k: 'page.desc',   label: '页面介绍', sel: '#pMain .desc' },
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

  groups.forEach((box, gi) => {
    // 分组标题
    const gt = $('.g-title', box);
    if (gt) wrapEditable(gt, `group.${gi}.title`, 'c-gtitle');

    $$('.row', box).forEach((row, ri) => {
      const lab = $('.label', row);
      if (lab) {
        // 标签本身（跳过里面的 <small> / <i class="todo">）
        wrapEditable(lab, `row.${gi}.${ri}.label`, 'c-label', { skipChildren: true });
        const hint = $('small', lab);
        if (hint) wrapEditable(hint, `row.${gi}.${ri}.hint`, 'c-hint');
      }
      const btn = $('.body .btn', row);
      if (btn) wrapEditable(btn, `row.${gi}.${ri}.btn`, 'c-btn');
    });
  });

  for (const el of $$('.d-editable', main)) textEls.push(el);
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

  const span = document.createElement('span');
  span.className = 'd-editable ' + cls;
  span.dataset.dkey = key;
  span.textContent = own[0].textContent.trim();

  if (o.skipChildren) {
    // 只替换第一个文本节点，后面的 <small> / <i> 原地不动
    host.replaceChild(span, own[0]);
  } else {
    host.innerHTML = '';
    host.appendChild(span);
  }

  span.contentEditable = 'true';
  span.spellcheck = false;
  span.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); span.blur(); } }, true);
}

/* ============================================================
   状态
   ============================================================ */

let on = false;
let bar = null;                 // 底部那条调试栏
let marks = [];                 // 画在页面上的轮廓框
let handles = [];               // 拖拽把手
let textEls = [];               // 所有被挂上 contentEditable 的元素
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
        setVar(p.k, Math.max(p.min, Math.min(p.max, n)));
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
  bReset.onclick = () => {
    const card = $('.card');
    for (const p of NUM_PARAMS) card.style.removeProperty(p.k);
    /*
     * ⚠️ 分组搬动也要一起还原 —— 按钮写着「全部还原」，
     *    只清参数、留着搬动的话名不副实。（只管参数的那个老版本叫「还原」。）
     */
    moves = [];
    if (setOverrideFn) setOverrideFn(new Map());
    showPageNow();
    flash('✓ 已全部还原');
  };

  const bExit = document.createElement('button');
  bExit.className = 'd-btn';
  bExit.textContent = '退出调试';
  bExit.onclick = () => disable();

  right.append(bOut, bReset, bExit);

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

function makeEditable() {
  // ① 固定那几处（顶栏标题 / 左栏署名 / 页面标题 / 页面介绍）
  for (const t of TEXT_PARAMS) {
    const el = $(t.sel);
    if (!el || el.dataset.dkey) continue;
    el.contentEditable = 'true';
    el.spellcheck = false;
    el.classList.add('d-editable');
    el.dataset.dkey = t.k;
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } }, true);
    textEls.push(el);
  }
  // ② 页面上跟着内容走的那批（分组标题 / 47 行的标签和提示 / 按钮）
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
  for (const el of textEls) {
    el.contentEditable = 'false';
    /*
     * ⚠️⚠️ **类必须自己摘**（2026-10-13 探针抓到的）。
     *     我原来只关 contentEditable，想着"DOM 交给 showPage 重画" ——
     *     但 `#pMain` **外面**还有两处可编辑（`.bar .title` 顶栏标题、
     *     `.p-foot b` 左栏署名），它们在 `.card` 里，重画 `#pMain` 带不走，
     *     于是退出调试台后它们**一直挂着虚线框**（探针量到残留 2 个）。
     *     ⇒ 类名和 dkey 都在这里清干净，重画只是额外把包过的 span 带走。
     */
    el.classList.remove('d-editable', 'c-gtitle', 'c-label', 'c-hint', 'c-btn');
    delete el.dataset.dkey;
  }
  textEls = [];
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
  applyOverride();
}

/** 撤掉某一次搬动（下拉选"回原来那页"时用） */
function unlinkGroup(gid) {
  moves = moves.filter((m) => m.gid !== gid);
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
   导出
   ============================================================ */

function snapshot() {
  const out = { 结构: {}, 文字: {}, 分组移动: [] };

  // 结构（CSS 变量）
  for (const p of NUM_PARAMS) out.结构[p.k.replace(/^--d-/, '')] = getVar(p.k, p.def);

  /*
   * 文字 —— **所有**挂过 contentEditable 的，键就是 `data-dkey`。
   * 分三类其实靠前缀区分：`group.` / `row.` 是内容文案，其余是面板级。
   */
  for (const el of textEls) {
    const key = el.dataset.dkey;
    if (key) out.文字[key] = (el.textContent || '').trim();
  }

  // 分组移动（调试台搬过的组）
  if (moves.length) out.分组移动 = moves.slice();

  return out;
}

function exportJson() {
  const data = snapshot();
  const txt = JSON.stringify(data, null, 2);
  console.log('[调试台] 导出：\n' + txt);
  // 剪贴板 —— 他能直接粘给我
  try {
    navigator.clipboard.writeText(txt).then(
      () => flash('✓ 已复制到剪贴板'),
      () => flash('✓ 已打印到控制台（剪贴板不通）'));
  } catch { flash('✓ 已打印到控制台'); }
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

  card.classList.add('d-on');
  buildBar();
  drawMarks();
  addHandles();
  makeEditable();
  installGroupMove();
  syncGroupCtl();
  window.addEventListener('resize', drawMarks, true);

  // 面板窗口放大一点才施展得开
  try { window.yachiyo?.ov?.design?.(true); } catch { /* 主进程没加这个也行，只是挤一点 */ }
}

export function disable() {
  if (!on) return;
  on = false;
  const card = $('.card');

  // ① 清掉调试时加上去的东西（CSS 变量 + 那些手柄/轮廓）
  if (card) for (const p of NUM_PARAMS) card.style.removeProperty(p.k);
  clearEditable();
  clearMarks();
  clearHandles();              // ★ 别漏 —— 漏了下次进来会叠一层
  if (bar) { bar.remove(); bar = null; }
  if (card) {
    card.classList.remove('d-on', 'd-dragging');
    delete card.dataset.dpage;
  }
  window.removeEventListener('resize', drawMarks, true);

  // ② 把搬动过的分组还原 —— 覆盖表清空 + **整页重画**
  moves = [];
  if (setOverrideFn) setOverrideFn(new Map());
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
