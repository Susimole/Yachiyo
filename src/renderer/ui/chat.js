/**
 * 聊天窗 —— 跟她说话的那个框。
 *
 * 跟气泡长得像，但这个是能打字的：上面是消息列表，下面是输入框。
 * 位置锚在她旁边，跟气泡同一套算法（别拿 #stage 的方框角算，见 bubble.js 的注释）。
 *
 * ⚠️ 她自己回的字是【流式】来的：主进程边收边推 `chat:delta`，
 *    这里只管往当前那条上追加。所以发完不能立刻把气泡封口，
 *    要等 `send` 的 promise 回来才知道这轮结束没结束。
 */

import { svg } from './icons.js';
import { makeHost } from './host.js';

let api = null;              // { speak }
let typing = false;
let curText = null;          // 正在流式写入的那个 <span>
let curBubble = null;        // 它所在的那条消息
let stickBottom = true;      // 用户往上翻看历史时别硬拽回底部

const body  = () => document.getElementById('cBody');
const input = () => document.getElementById('cInput');

/** 独立窗口：加载完直接拉历史、聚焦输入框 */
export function bootChat() {
  if (api) return;
  initChat();
  openChat();
}

export function initChat() {
  /*
   * ⚠️ 这个页面现在是一个**独立的小窗口**（chat.html），不再长在主窗口里。
   *    宿主自己建 —— 主窗口那边已经没有它的任何引用了。
   */
  api = makeHost();

  document.getElementById('cClose').innerHTML = svg('close', 14);
  document.getElementById('cSend').textContent = '发送';
  document.getElementById('cClose').onclick = closeChat;
  window.yachiyo.on('ov:open', () => openChat());
  document.getElementById('cSend').onclick = send;

  const ta = input();
  ta.addEventListener('keydown', (e) => {
    // Enter 发，Shift+Enter 换行 —— 这是聊天框的肌肉记忆，别反着来
    // ⚠️ `!e.isComposing && e.keyCode !== 229`（2026-10-16 修的）——
    //    中文输入法选字时那个回车是「确认候选词」，不判的话半截拼音会被发出去。
    const enter = e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229;
    if (enter) { e.preventDefault(); send(); }
    if (e.key === 'Escape') { e.preventDefault(); closeChat(); }
  });
  // ⚠️ 输入框里按 Esc 别让它冒到 window 上去 —— 那会连菜单一起关掉
  ta.addEventListener('keyup', (e) => { if (e.key === 'Escape') e.stopPropagation(); });

  body().addEventListener('scroll', () => {
    const b = body();
    stickBottom = b.scrollHeight - b.scrollTop - b.clientHeight < 40;
  });

  document.getElementById('cClear').onclick = () => {
    if (!confirm('把你们聊过的都忘掉？')) return;
    window.yachiyo.chat.clear();
  };

  // ---- 主进程推过来的流 ----
  window.yachiyo.on('chat:delta', (t) => {
    if (!curText) return;
    curText.textContent += t;
    if (stickBottom) body().scrollTop = body().scrollHeight;
  });

  window.yachiyo.on('chat:cleared', () => {
    body().innerHTML = '';
    sys('她把之前聊的都忘掉了。');
  });

  /*
   * ★ 她**在别处**说的话，也要进这张列表（2026-10-16 补的）。
   *
   *   聊天窗自己发的那一轮走 `chat:delta`（见上面），可她的嘴不止一张：
   *     · 自言语 / 识屏点评 / 晚安  → 主进程 `sayIt` 发的 `speak:say`
   *     · 双击快问的回答            → `bubble:done`
   *   这两条以前聊天窗**一个字都看不到**，而且**重开也不补** ——
   *   `openChat()` 只在第一次打开时拉历史（那个 `childElementCount` 守卫）。
   *   他 2026-10-16 报的「气泡内文字没有同步到聊天框」就是这个。
   */
  window.yachiyo.on('speak:say', (text) => appendSaid(text));
  window.yachiyo.on('bubble:done', (r) => appendSaid(r && r.text));
}

/* ============================================================
   消息
   ============================================================ */

/*
 * ★ 「造一条消息」和「把它挂上去」拆开（2026-10-17 修的）。
 *
 *   历史要**整块插到列表最前面**（见 loadHistory），所以那批元素得先攒进一个
 *   DocumentFragment 再一次性 prepend —— 没法走原来那条「造完立刻 appendChild」。
 */
function makeBubble(role, text, pending = false) {
  const row = document.createElement('div');
  row.className = 'c-row ' + role;
  if (pending) row.classList.add('pending');

  const b = document.createElement('div');
  b.className = 'c-bub';
  const span = document.createElement('span');
  span.textContent = text;                    // ⚠️ 用 textContent，别用 innerHTML
  b.appendChild(span);
  row.appendChild(b);

  return { row, span };
}

/** 滚到底 —— 但他往上翻历史的时候别硬拽回去 */
function scrollDown() {
  if (stickBottom) body().scrollTop = body().scrollHeight;
}

function bubble(role, text, pending = false) {
  const b = makeBubble(role, text, pending);
  body().appendChild(b.row);
  scrollDown();
  return b;
}

/**
 * 往列表里插一条**她说的**话（来源见 initChat 里那两条监听）。
 * ⚠️ 空的直接不插 —— `bubble:done` 在她其实没说出话时 text 是空的。
 */
function appendSaid(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return;
  bubble('ai', t);
}

function makeSys(text) {
  const d = document.createElement('div');
  d.className = 'c-sys';
  d.textContent = text;
  return d;
}

function sys(text) {
  const d = makeSys(text);
  body().appendChild(d);
  body().scrollTop = body().scrollHeight;
  return d;
}

function note(text, kind = '') {
  const d = document.createElement('div');
  d.className = 'c-note' + (kind ? ' ' + kind : '');
  d.textContent = text;
  body().appendChild(d);
  body().scrollTop = body().scrollHeight;
}

/* ============================================================
   开关
   ============================================================ */

/**
 * 打开 —— **只管拉历史 + 聚焦输入框**。
 *
 * ⚠️ 窗口显隐和摆位都归主进程（overlay.cjs）。原来这里还干了三件事：
 *    · `#chat.open` —— 那是「卡片从她旁边弹出来」的动画，现在整页就是聊天窗
 *    · `win.focusable(true)` —— 它当时跟她在**同一个窗口**里，而那个窗口
 *      平时 focusable:false（免得抢他打游戏的按键）；独立窗口天生收键盘
 *    · `place()` —— 算她旁边的位置；独立窗口是系统摆的，不用算了
 */
/*
 * ★ 历史**整块插到列表最前面**（2026-10-17 修的 #1）。
 *
 *   他报的：「双击唤出的聊天窗口消息同步异常，表现为我刚刚发送的消息会插入在此前的对话之中」。
 *
 *   病根是**异步**：原来这里 `await history()` 一回来就 `appendChild` 到**末尾**。
 *   他手快，历史还在路上（要读文件）就回车了 —— 他的消息先落在列表里，
 *   历史回来了**追加在它后面**，于是新消息被夹在「—— 下面是你们之前聊的 ——」
 *   和一堆旧对话中间。窗口刚弹出来那几百毫秒最容易中，所以他说「双击唤出的时候」。
 *
 *   修法不是让他等（等几百毫秒才敢打字，手感很差），而是**历史永远插在最前面** ——
 *   历史是「过去」，「现在」怎么抢跑都只能排在它后面。谁先到都不会再错位。
 *
 *   ⚠️ 「拉过了」的标志用 `histLoaded`，不是原来那个「body 里有没有元素」：
 *     原来读失败时 `note()` 也会往 body 里塞一条，那个守卫**从此永远为真** ——
 *     历史只要失败过一次，这一辈子都不会再重试。
 */
let histLoaded = false;
let histLoading = null;

async function loadHistory() {
  let hist;
  try {
    hist = await window.yachiyo.chat.history();
  } catch (err) {
    note('历史读不出来：' + err.message, 'err');
    return;                    // ⚠️ 不置 histLoaded —— 下次开窗还能重试
  }
  const frag = document.createDocumentFragment();
  if (!hist.length) {
    frag.appendChild(makeSys('还没说过话。先打个招呼？'));
  } else {
    frag.appendChild(makeSys('—— 下面是你们之前聊的 ——'));
    for (const m of hist) frag.appendChild(makeBubble(m.role === 'user' ? 'user' : 'ai', m.content).row);
  }
  body().prepend(frag);
  histLoaded = true;
  body().scrollTop = body().scrollHeight;      // 历史在上，但视线还是落在最新那条
}

export async function openChat() {
  if (!histLoaded && !histLoading) {
    // 第一次打开才拉历史 —— 之后页面里就留着了，来回开关不会丢
    histLoading = loadHistory().finally(() => { histLoading = null; });
  }
  setTimeout(() => input().focus(), 80);
}

export function closeChat() {
  try { window.yachiyo.ov.close(); } catch { /* 桥没接上就算了 */ }
}

/** ⚠️ 占位 —— 窗口显隐归主进程（overlay.isOpen('chat')），这个页面问不出来 */
export const chatOpen = () => false;

/* ============================================================
   发
   ============================================================ */

bootChat();

async function send() {
  const ta = input();
  const text = ta.value.trim();
  if (!text || typing) return;

  ta.value = '';
  stickBottom = true;

  const { row: userRow } = bubble('user', text);
  const pending = bubble('ai', '', true);
  curText = pending.span;
  curBubble = pending;
  typing = true;

  ta.disabled = true;
  document.getElementById('cSend').disabled = true;

  try {
    const r = await window.yachiyo.chat.send(text);
    pending.row.classList.remove('pending');

    if (!r.ok) {
      // 空壳要撤掉 —— 留着一条空白气泡，看着像她哑了
      pending.row.remove();
      note(r.error, 'err');
      if (r.needKey) api?.openPanel?.('ai');
    } else {
      /*
       * ★ 用主进程给的**成品文本**把流式那份盖掉（2026-10-16 修的）。
       *
       *   流式推的（`chat:delta`）是**原文** —— 带着 `[心情 好]` 这类标记；
       *   而 `send` 的返回值里 `text` 是 `brain.reply` **剥过标记、去过空行**的成品。
       *   原来这儿写的是 `void r;` —— 返回值整个丢掉，
       *   于是聊天窗里永远留着那版带标记的原文。
       */
      if (r.text) pending.span.textContent = r.text;

      // ⚠️ 2026-10-12 他说的：「聊天框不必每次对话后都弹出本轮消耗」。
      //    每说一句就插一行「她说完了 · ¥0.00022 · 3.2s」，聊十句就十条，
      //    把对话冲得七零八落。用量去设置面板的「用量与成本」看就行。
      //    （只有**出错**才在这儿留一行 —— 那个他必须看见。）
    }
  } catch (err) {
    pending.row.remove();
    note('发不出去：' + err.message, 'err');
  } finally {
    typing = false;
    curText = null;
    curBubble = null;
    ta.disabled = false;
    document.getElementById('cSend').disabled = false;
    ta.focus();
    if (stickBottom) body().scrollTop = body().scrollHeight;
  }
}
