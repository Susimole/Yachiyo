/**
 * 右键菜单 —— **一个独立的小窗口**（不是主窗口里的一张卡片）。
 *
 * 只有 5 项：聊天 · 音效 · 夜间模式 · 桌宠移动 · API 接入
 * 开关类【点一下就变、菜单不关】，点开类的才收菜单。
 *
 * ⚠️⚠️ 2026-10-12 的三条改动（他报的）：
 *
 *   ① **只有右键点她才唤出**。
 *      原来 `document.addEventListener('contextmenu')` 挂在**整个文档**上 ——
 *      主窗口盖着屏幕，所以满桌面随便哪点右键都弹菜单。
 *      现在这条监听挪回了主窗口（app.js），并且加了 `hitPet()` 判定。
 *
 *   ② **退出确认重做**。
 *      原来是「就地二次确认」：同一个按钮按下变红、文字改成「确定退出？」。
 *      问题是那句 `btn.style.cssText = 'width:auto;padding:0 8px;...'` 把按钮
 *      撑开了，而它高度还是写死的 26px —— **文字挤出去了**（他说的「溢出」）。
 *      而且整个按钮的宽度变了之后，鼠标还停在原来那个点上，第二次点很可能
 *      落在按钮外面 —— 就是「有时按不了」。
 *      现在改成盖一层确认框，两个按钮「再想想 / 确定」，尺寸跟着文字走。
 *
 *   ③ **窗口能拖动**（`.bar` 上 `-webkit-app-region:drag`，在 overlay.css 里）。
 */

import { svg } from './icons.js';
import { makeHost } from './host.js';

export const ITEMS = [
  { k:'chat',  txt:'聊天',      kind:'go' },
  { k:'sound', txt:'音效',      kind:'sw', key:'sound' },
  { k:'moon',  txt:'夜间模式',  kind:'sw', key:'theme', invert:true },   // theme==='dark' 才算开
  { k:'move',  txt:'桌宠移动',  kind:'sw', key:'moveEnabled' },
  { k:'plug',  txt:'API 接入',  kind:'go' },
];

const $ = (id) => document.getElementById(id);
const host = makeHost(() => render());

function isOn(item, cfg) {
  if (item.kind !== 'sw') return false;
  return item.invert ? cfg[item.key] === 'dark' : !!cfg[item.key];
}

export function initMenu() {
  $('tTop').innerHTML   = svg('pin', 15);
  $('tGear').innerHTML  = svg('gear', 15);
  $('tPower').innerHTML = svg('power', 15);

  $('tGear').onclick  = () => host.openPanel('habit');
  $('tTop').onclick   = toggleTop;
  $('tPower').onclick = showAsk;

  $('askNo').onclick  = hideAsk;
  $('askYes').onclick = () => { hideAsk(); host.quit(); };

  // 确认框开着的时候点外面 = 取消
  $('veil').onclick = (e) => { if (e.target.id === 'veil') hideAsk(); };
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideAsk(); });

  /*
   * 点菜单**外面**就收起来。
   *
   * ⚠️⚠️ 2026-10-12 他报的：「右键菜单呼出后，点菜单之外的任何区域就会关闭」
   *    （他列在问题里 —— 意思是要这个行为，但现在是坏的）。
   *
   *    原来 menu.js 里有这一句：
   *        document.addEventListener('click', e => { if (!el().contains(e.target)) closeMenu(); });
   *    它当年能工作是因为菜单跟其它所有东西**在同一个文档里**。
   *    菜单搬成独立窗口之后，点「外面」的那一下**根本发生在这个页面之外**，
   *    这个页面的 document 永远收不到 —— 于是关不掉了。
   *
   *    独立窗口要判断「点外面」，只能靠**失焦**：
   *      · 点桌面 / 点别的应用 → explorer.exe 或那个应用拿到焦点 → 这个窗口 blur ✓
   *      · 点她 → 主窗口那边会把菜单关掉（见 app.js 的 initContextMenu）
   *      · 点菜单窗口自己的空白处 → 下面那条 pointerdown 兜住 ✓
   */
  window.addEventListener('blur', () => { hideAsk(); host.close(); });

  // 窗口内部的空白处（卡片边距那一圈）也算「外面」
  document.addEventListener('pointerdown', (e) => {
    if (!$('veil').classList.contains('open') && e.target.closest('.card') === null) {
      host.close();
    }
  });

  /*
   * ⚠️ 每次被打开都要重画 + 重量。
   *
   *    这个窗口是**复用**的（关掉只是 hide，不销毁），所以 render() 如果只
   *    在页面加载时跑一次，就只在**第一次加载**那一刻量过 —— 而那一刻窗口
   *    还是 `show:false`，布局没排，量出来的高度是错的（实测首次打开 339，
   *    而内容其实只有 242）。后面每次打开都不会再量。
   *
   *    挂在 ov:open 上，主进程 show() 之后会推这个事件过来，那时窗口已经可见。
   */
  window.yachiyo.on('ov:open', () => render());

  host.ready().then(render);
}

/**
 * 置顶 —— 她在最前面还是能被别的窗口盖住。
 *
 * ⚠️ 2026-10-12 他说的：「将暂停键替换为置顶键，原暂停键和相关配置项移除」。
 *
 *    暂停键当年接的是 `moveEnabled`（关掉她就不自己走了）——
 *    可**菜单里本来就有一项「桌宠移动」是同一个开关**，一个功能两个入口，
 *    而且「暂停」这个名字跟实际做的事（停止自动走动）也对不上。
 *    所以按钮换成**置顶**（那个是真的没有别的入口），
 *    `moveEnabled` 本身留着（「桌宠移动」那一项还在用，上一轮刚给它做过
 *    「关掉之后只留歇着/坐下/睡觉」）。
 *
 * 落地的活归主进程：页面只改配置，`main/index.cjs` 的 applyMainSideEffect
 * 收到 `alwaysOnTop` 去 `setAlwaysOnTop`。这个按钮只管把状态画出来。
 */
async function toggleTop() {
  await host.setCfg('alwaysOnTop', !host.cfg().alwaysOnTop);
  render();
}

function render() {
  const cfg = host.cfg();
  const box = $('mList');
  if (!box) return;
  box.innerHTML = '';

  for (const item of ITEMS) {
    const on = isOn(item, cfg);
    const d = document.createElement('div');
    d.className = 'm-item' + (on ? ' on' : '');
    d.innerHTML = svg(item.k) + `<span class="txt">${item.txt}</span>`
                + (item.kind === 'sw' ? `<span class="sw sm${on ? ' on' : ''}"></span>`
                                      : '<span class="arrow">›</span>');
    d.onclick = () => onItem(item);
    box.appendChild(d);
  }

  // 置顶按钮：钉着的时候点亮
  const p = $('tTop');
  if (p) {
    const on = !!cfg.alwaysOnTop;
    p.style.color = on ? 'var(--accent)' : '';
    p.title = on ? '已置顶（点一下取消）' : '总在最前（点一下钉住）';
  }

  /*
   * 量内容高，叫主进程把窗口收一收。
   * 窗口高写死的话菜单项少的时候下面会空一大块（实测 331 的窗口只装了 250）。
   *
   * ⚠️⚠️ **不能量 `.card`**。它是 `position:absolute; inset:0` ——
   *    填满的是**窗口**，不是内容。量它永远等于当前窗口高，
   *    于是 `fit()` 收到「高度没变」，什么都不会做（第一版就是这么白写的）。
   *    要量的是**里面真正的内容**：顶栏 + 列表。
   * ⚠️ 必须下一帧再量 —— render() 是同步的，此刻 DOM 还没排版。
   */
  requestAnimationFrame(() => {
    const bar = document.querySelector('.bar');
    const pad = document.querySelector('.pad');
    if (!bar || !pad) return;
    // scrollHeight = 内容实际高度（不受容器高度影响）
    window.yachiyo.ov.fit(bar.getBoundingClientRect().height + pad.scrollHeight);
  });
}

async function onItem(item) {
  const cfg = host.cfg();

  if (item.kind === 'sw') {                       // 就地变，菜单不关
    const next = item.invert ? (cfg[item.key] === 'dark' ? 'light' : 'dark')
                             : !cfg[item.key];
    await host.setCfg(item.key, next);
    render();
    return;
  }

  if (item.k === 'chat') host.openChat();
  if (item.k === 'plug') { host.close(); host.openPanel('ai'); }
}

function showAsk() { $('veil').classList.add('open'); }
function hideAsk() { $('veil').classList.remove('open'); }

initMenu();
