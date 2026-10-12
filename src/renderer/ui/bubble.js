import { roll, applyEdit } from './typo.js';

/**
 * 气泡 —— 她说话的那个对话框。
 *
 * 位置算法：锚在她头顶附近，按配置的「固定点」决定气泡挂在她哪一侧。
 * 打字机效果只是个显示动画，文字本身是完整的。
 */

const bubbleEl = () => document.getElementById('bubble');
const textEl   = () => document.getElementById('bText');

let typeTimer = null;
let hideTimer = null;
let cfgRef = () => ({});

/* ============================================================
   「准备睡」闸 —— 睡着了，一个气泡都不许冒
   ============================================================
   他 2026-10-13 的要求：「桌宠在睡着状态时不会说话也不会有任何气泡弹出」

   ⚠️ 这是**第二道**闸。第一道在主进程的 `sayIt`（那儿挡的是"她要不要说"）；
      这一道挡的是"说了也不许显示"。两道都留着，因为它们是**不同的失效模式**：
        · 主进程那道漏了 → 她说的话还在往外发（日志里有，界面上没有）
        · 渲染层这道漏了 → 只要有任何一个事件绕过了 sayIt（比如
          `bubble:*` 那条走 runChat 的流、或者以后新加的链），页面就直接冒泡
      探针实测过：只加主进程那道时，直接重放 `speak:say` 事件照样能冒出来。

   ⚠️ 状态由主进程推（`sleep:changed`），见 app.js —— 页面这边**不要自己猜**
      （"多久没动"是主进程拿系统空闲时间算的，页面算不出来）。
   ============================================================ */
let sleepMode = false;

/** 主进程告诉她"我要睡了 / 我醒了" */
export function setSleeping(v) { sleepMode = !!v; }

const sleeping = () => sleepMode;

/**
 * ★ 只给探针看：页面这边的睡眠态。
 * 探针要能分开验「主进程的状态」和「页面收到的状态」——这俩不一致的时候，
 * 才知道是通知没送到，还是闸本身没生效（2026-10-13 查这条闸时全靠它）。
 * 产品逻辑不读它。
 */
window.__yachiyoSleepState = () => sleepMode;

/** 收函数不收对象 —— 配置在设置面板里随时会变，抓着旧对象看的是老值 */
export function initBubble(getCfg) {
  cfgRef = typeof getCfg === 'function' ? getCfg : () => getCfg;
}

/** 她当前的屏幕矩形（窗口坐标系里） */
function petRect() {
  const st = document.getElementById('stage');
  const r = st.getBoundingClientRect();
  return r;
}

/**
 * 摆位 —— 只算**位置**，不管文字。
 *
 * ⚠️ 抽出来是因为「快速问一句」的回复是**流式**涨上来的：
 *    每来一个 delta 就要重排一次，而重排不能重跑打字机、不能重置自动关闭的计时。
 */
function place() {
  const el = bubbleEl();
  const cfg = cfgRef() || { bubbleAnchor: 'bl' };
  const box = petRect();

  // 先显示再量尺寸 —— 藏着的元素量出来是 0
  el.classList.add('open');
  const bw = el.offsetWidth;
  const bh = el.offsetHeight;

  // ⚠️ #stage 是 461×461 的方框，可她只占中间偏左一块（rig.json 的件从
  //    174 单位到 439 单位）。拿方框的角当锚点，气泡会飘在离她半米远的地方 ——
  //    第一版就是这么写的，她坐在屏幕右下，气泡跑到半空中去了。
  //    这四个数是从件的包围盒量出来的（占 stage 的比例），换素材可能要跟着调。
  const PET_BOX = { x0: 0.26, x1: 0.70, y0: 0.25, y1: 0.90 };

  const px0 = box.left + box.width  * PET_BOX.x0;
  const px1 = box.left + box.width  * PET_BOX.x1;
  const py0 = box.top  + box.height * PET_BOX.y0;
  const py1 = box.top  + box.height * PET_BOX.y1;

  const anchor = cfg.bubbleAnchor || 'tl';      // 气泡挂在她哪个角
  const gap = 14;
  const above = anchor.startsWith('t');
  let x = anchor.endsWith('l') ? px0 - bw * 0.55 : px1 - bw * 0.45;
  let y = above ? py0 - bh - gap : py1 + gap;

  // 别跑出窗口
  x = Math.max(8, Math.min(x, window.innerWidth  - bw - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - bh - 8));

  el.style.left = x + 'px';
  el.style.top  = y + 'px';
  el.dataset.side = above ? '' : 'top';   // 气泡在她上面 → 尾巴朝下；在下面 → 尾巴朝上
  // 尾巴永远指着她的头
  el.style.setProperty('--tail', Math.max(14, Math.min(px0 + 30 - x, bw - 30)) + 'px');
}

/**
 * 流式说话 —— 快速问一句的回复走这条。
 *
 * ⚠️ 跟 showBubble 的区别：
 *    · **不跑打字机** —— 字本来就是一段段推过来的，再叠一层打字机会变成两倍慢
 *    · **不重置自动关闭的计时** —— 只有真的说完了（done）才开始数
 *    · 每次只重排位置，不动文字以外的任何状态
 */
export function streamBubble(text) {
  if (sleeping()) return;                    // ★ 睡着了一个气泡都不冒（见文件末尾）
  clearTimeout(typoTimer); typoWrong = '';   // 新的一句话开始，上一句的口误作废
  const el = bubbleEl();
  el.classList.toggle('clip', (cfgRef() || {}).bubbleOverflow === 'clip');
  clearInterval(typeTimer);              // 万一上一条还在打字
  clearTimeout(hideTimer);
  el.classList.add('open');
  textEl().textContent = text;
  place();
}

/** 流完了 —— 交给正常的自动关闭 */
export function settleBubble(ms) {
  clearTimeout(hideTimer);
  const cfg = cfgRef() || {};
  const sec = ms != null ? ms / 1000 : (cfg.bubbleSeconds || 8);
  hideTimer = setTimeout(hideBubble, Math.max(2, sec) * 1000);
}

/**
 * ★ 口误（他 2026-09-26 点名要的）—— 偶尔打错一个字，隔一会儿自己改回来。
 *
 * ⚠️⚠️ **只动气泡上显示的字**。`textEl()` 是纯展示；
 *    聊天记录 / 记忆 / 学习用的都是主进程那份**正确文本**，一个字都没被碰过。
 *    这条是整件事的意义所在 —— 她"手滑"是给人看的，不是真记错。
 *
 * ⚠️ 所以**绝不能**在这里回写任何东西：不调 `showBubble`（那会重跑打字机）、
 *    不碰 `quickBuf`（那是流式缓冲，下一帧会把它盖回来）、
 *    更不 notify 主进程。
 *
 * ⚠️ 必须能被打断：她说了下一句 / 气泡收了，这个计时器立刻作废 ——
 *    不然会出现"新的话冒出来了，却突然变成上一句打错的版本"。
 */
let typoWrong = '';
let typoTimer = null;
function startTypo(fullText) {
  clearTimeout(typoTimer);
  const cfg = cfgRef() || {};
  /*
   * ⚠️ `typo` 默认**开**（配置里就是 true）。这里判的是 `=== false` ——
   *    老配置升级上来时这个键可能不存在，取到 undefined，
   *    `!undefined` 会把口误整个关掉，而且他不会知道为什么。
   *    （同一个坑 `brain.cjs` 的 memShort 踩过。）
   */
  if (cfg.typo === false) return;

  /*
   * ⚠️ 打字机还在逐字吐的时候**不下手**。
   *    打字机每一跳都在覆写 textContent，口误写下去就被下一个字盖掉 ——
   *    看着像闪了一下，然后错字又没了（比不做还怪）。
   *    `typewriter` 默认是关的，所以正常路径（整句直接显示）不受影响。
   */
  if (cfg.typewriter !== false) return;

  let r;
  try {
    r = roll(fullText, {
      typo: cfg.typo,
      typoRate: cfg.typoRate,
      typoHoldMs: cfg.typoHoldMs,
    });
  } catch { return; }            // 口误是个装饰，坏了不能连累她说话
  if (!r.hit) return;

  const wrong = applyEdit(fullText, r.edit);
  if (!wrong || wrong === fullText) return;
  typoWrong = fullText;

  // ⚠️ 这里**直接写 textContent** —— 不是重跑 showBubble（那会重启打字机 + 重算位置）
  textEl().textContent = wrong;

  typoTimer = setTimeout(() => {
    typoWrong = '';
    // 中途她说了新的一句就别改了（那个 tick 已经作废）
    if (textEl().textContent === wrong) {
      textEl().textContent = fullText;
      place();                      // 字数变了，气泡高度跟着变，重摆一次
    }
  }, r.holdMs);
}

export function showBubble(text, opts = {}) {
  if (sleeping()) return;                    // ★ 同上
  const el = bubbleEl();
  const tx = textEl();
  const cfg = cfgRef() || { bubbleW: 242, bubbleH: 180, bubbleAlpha: 92, bubbleAnchor: 'bl', bubbleSeconds: 8 };

  // 宽/字号/字色/透明度/最大高度全走样式表里的 CSS 变量（app.js 的 applyBubble 在管），
  // 这里只管【位置】和文字本身
  el.classList.toggle('clip', cfg.bubbleOverflow === 'clip');

  // 先显示再量尺寸 —— 藏着的元素量出来是 0
  el.classList.add('open');

  // 打字机（关掉就直接整句显示）
  clearInterval(typeTimer);
  if (cfg.typewriter === false) {
    tx.textContent = text;
  } else {
    tx.textContent = '';
    let i = 0;
    typeTimer = setInterval(() => {
      tx.textContent = text.slice(0, ++i);
      if (i >= text.length) clearInterval(typeTimer);
    }, 42);
  }

  // ⚠️ 位置在文字**之后**算：气泡高度跟着内容走，先摆位会摆到旧尺寸上
  place();

  clearTimeout(hideTimer);
  /*
   * ⚠️ `opts.seconds` —— 某一条链可以有**自己的**停留时长。
   *    现在是自言语那条（配置键 `SelfTalkBubbleSeconds`）：
   *    自言自语是"随口一句"，挂 8 秒跟聊天回复一样长，会显得她在等回答。
   *    没给就用全局的 `bubbleSeconds`。
   */
  const secs = Number(opts.seconds) > 0 ? Number(opts.seconds) : (cfg.bubbleSeconds || 8);
  const ms = secs * 1000;
  if (!opts.sticky) hideTimer = setTimeout(hideBubble, ms);

  startTypo(text);
}

export function hideBubble() {
  clearInterval(typeTimer);
  clearTimeout(hideTimer);
  clearTimeout(typoTimer); typoWrong = '';   // 气泡都收了，别留着改回来
  bubbleEl().classList.remove('open');
}

/**
 * 正在说话时她的位置变了（走动/被拖）→ 气泡跟着挪。
 *
 * ⚠️ 只重排位置，**不能重跑 showBubble** —— 那会把打字机从头再来一遍，
 *    而且流式回复正在写的那半句会被它按整句重放一次。
 */
export function followPet() {
  const el = bubbleEl();
  if (!el.classList.contains('open')) return;
  if (!textEl().textContent) return;
  place();
}
