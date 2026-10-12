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
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
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
}

/* ============================================================
   消息
   ============================================================ */

function bubble(role, text, pending = false) {
  const row = document.createElement('div');
  row.className = 'c-row ' + role;
  if (pending) row.classList.add('pending');

  const b = document.createElement('div');
  b.className = 'c-bub';
  const span = document.createElement('span');
  span.textContent = text;                    // ⚠️ 用 textContent，别用 innerHTML
  b.appendChild(span);
  row.appendChild(b);

  body().appendChild(row);
  if (stickBottom) body().scrollTop = body().scrollHeight;
  return { row, span };
}

function sys(text) {
  const d = document.createElement('div');
  d.className = 'c-sys';
  d.textContent = text;
  body().appendChild(d);
  body().scrollTop = body().scrollHeight;
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
export async function openChat() {
  if (!body().childElementCount) {
    // 第一次打开才拉历史 —— 之后页面里就留着了，来回开关不会丢
    try {
      const hist = await window.yachiyo.chat.history();
      if (!hist.length) sys('还没说过话。先打个招呼？');
      else {
        sys('—— 下面是你们之前聊的 ——');
        for (const m of hist) bubble(m.role === 'user' ? 'user' : 'ai', m.content);
      }
    } catch (err) {
      note('历史读不出来：' + err.message, 'err');
    }
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
      // ⚠️ 2026-10-12 他说的：「聊天框不必每次对话后都弹出本轮消耗」。
      //    每说一句就插一行「她说完了 · ¥0.00022 · 3.2s」，聊十句就十条，
      //    把对话冲得七零八落。用量去设置面板的「用量与成本」看就行。
      //    （只有**出错**才在这儿留一行 —— 那个他必须看见。）
      void r;
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
