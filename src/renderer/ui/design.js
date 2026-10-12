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

/*
 * ⚠️ 这里**故意不 import settings.js** —— 两边互相 import 会成环，
 *    而且我根本没有要调它的东西（调试台不改数据，只量 + 导出）。
 */

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
  { k: '--d-bar-h',     label: '顶栏高度',     min: 28, max: 72,  step: 1,   def: 44,   sel: '.bar' },
  { k: '--d-side-w',    label: '左栏宽度',     min: 90, max: 220, step: 1,   def: 158,  sel: '.p-side' },
  { k: '--d-main-pad',  label: '内容左右留白', min: 0,  max: 48,  step: 1,   def: 24,   sel: '#pMain' },
  { k: '--d-h2-size',   label: '页面标题字号', min: 12, max: 30,  step: 1,   def: 19,   sel: '#pMain h2' },
  { k: '--d-desc-size', label: '介绍文字字号', min: 10, max: 20,  step: 0.5, def: 12.5, sel: '#pMain .desc' },
  { k: '--d-gap',       label: '分组间距',     min: 4,  max: 40,  step: 1,   def: 14,   sel: '.group' },
  { k: '--d-radius',    label: '卡片圆角',     min: 0,  max: 28,  step: 1,   def: 14,   sel: '.card' },
];

/** 要能直接点着改的文字（contenteditable） */
const TEXT_PARAMS = [
  { k: 'panel.title', label: '顶栏标题',   sel: '.bar .title' },
  { k: 'panel.brand', label: '左栏署名',   sel: '.p-foot b' },
  { k: 'page.title',  label: '页面标题',   sel: '#pMain h2' },
  { k: 'page.desc',   label: '页面介绍',   sel: '#pMain .desc' },
];

/* ============================================================
   状态
   ============================================================ */

let on = false;
let bar = null;                 // 底部那条调试栏
let marks = [];                 // 画在页面上的轮廓框
let handles = [];               // 拖拽把手
let textMarks = [];             // 被改过的文字元素
let dragging = null;            // 正在拖的把手

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

  const left = document.createElement('div');
  left.className = 'd-bar-l';
  for (const p of NUM_PARAMS) {
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
    left.appendChild(row);
  }

  const right = document.createElement('div');
  right.className = 'd-bar-r';

  const bOut = document.createElement('button');
  bOut.className = 'd-btn d-btn-main';
  bOut.textContent = '导出 JSON';
  bOut.onclick = () => exportJson();

  const bReset = document.createElement('button');
  bReset.className = 'd-btn';
  bReset.textContent = '还原';
  bReset.onclick = () => {
    const card = $('.card');
    for (const p of NUM_PARAMS) card.style.removeProperty(p.k);
    syncInputs(); drawMarks();
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
  for (const t of TEXT_PARAMS) {
    const el = $(t.sel);
    if (!el) continue;
    el.contentEditable = 'true';
    el.spellcheck = false;
    el.classList.add('d-editable');
    const key = t.k;
    el.addEventListener('input', () => { el.dataset.edited = key; el.classList.add('d-edited'); }, true);
    // 回车不要换行 —— 这些都是一行文案
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); el.blur(); } }, true);
    textMarks.push({ el, t });
  }
}

function clearEditable() {
  for (const { el } of textMarks) {
    el.contentEditable = 'false';
    el.classList.remove('d-editable', 'd-edited');
    delete el.dataset.edited;
  }
  textMarks = [];
}

/* ============================================================
   导出
   ============================================================ */

function snapshot() {
  const out = { 结构: {}, 文字: {} };
  for (const p of NUM_PARAMS) out.结构[p.k.replace(/^--d-/, '')] = getVar(p.k, p.def);
  for (const { el, t } of textMarks) out.文字[t.k] = (el.textContent || '').trim();
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

export function enable() {
  if (on) return;
  on = true;
  const card = $('.card');
  if (!card) return;
  card.classList.add('d-on');
  buildBar();
  drawMarks();
  addHandles();
  makeEditable();
  window.addEventListener('resize', drawMarks, true);
  // 面板窗口可能要放大一点才施展得开
  try { window.yachiyo?.ov?.design?.(true); } catch { /* 主进程没加这个也行，只是挤一点 */ }
}

export function disable() {
  if (!on) return;
  on = false;
  const card = $('.card');
  if (card) for (const p of NUM_PARAMS) card.style.removeProperty(p.k);
  clearEditable();
  clearMarks();
  clearHandles();              // ★ 别漏 —— 漏了下次进来会叠一层
  if (bar) { bar.remove(); bar = null; }
  if (card) card.classList.remove('d-on', 'd-dragging');
  window.removeEventListener('resize', drawMarks, true);
  try { window.yachiyo?.ov?.design?.(false); } catch { /* 同上 */ }
}

export const toggle = () => (on ? disable() : enable());
export const isOn = () => on;
/** 探针用：不进调试台也能拿到当前快照，用来验导出的数据结构对不对 */
export const snapshotNow = () => snapshot();
