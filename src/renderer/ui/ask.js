/**
 * 快速问一句 —— 双击她弹出来的那个小输入条。
 *
 * 他 2026-10-12 说的：「双击桌宠唤出对话输入框，按下回车或发送键后消失，
 * 桌宠回复用气泡显示」（参考 Coopanion 的交互）。
 *
 * ★ 跟「聊天窗」是**两条不同的路**，别合并：
 *     · 聊天窗（chat.html） = 开会话，有一来一回的历史，回字打在列表里
 *     · 这条（ask.html）    = 随口问一句，**问完这个框就没了**，
 *                             她的回答冒在头顶的气泡上，不进聊天历史界面
 *   主进程那边也是两条 IPC（chat:send / chat:send-quick），
 *   推的事件名都不一样（chat:delta vs bubble:delta）——
 *   不然「聊天窗里聊着天，头顶也跟着冒气泡」。
 *
 * ⚠️ 这个窗口是**独立的**（跟菜单/面板/聊天窗一样，见 main/overlay.cjs）。
 *    所以它关不掉自己以外的东西；「她回什么」是通过主进程广播
 *    `bubble:*` 事件推到**主窗口**去冒气泡的（见 app.js）。
 */

const $ = (id) => document.getElementById(id);

/** 这次问话是不是已经发出去了 —— 决定关窗口时要不要「什么都不做」 */
let sent = false;

function close() {
  try { window.yachiyo.ov.close(); } catch { /* 桥没接上就算了 */ }
}

function submit() {
  const el = $('aInput');
  const text = el.value.trim();
  if (!text) { close(); return; }     // 空着按回车 = 关掉，别发一句空的

  sent = true;
  el.value = '';
  el.disabled = true;
  $('aSend').disabled = true;

  /*
   * ⚠️ 不 await —— 他要求「按下回车后输入框消失」，那就立刻收。
   *    回复走 bubble:* 事件，在**主窗口**的气泡里慢慢长出来。
   *    这里 await 的话，输入框会一直杵在她头顶等她写完，跟要求相反。
   */
  window.yachiyo.chat.sendQuick(text).catch(() => {});
  close();
}

function boot() {
  $('aSend').onclick = submit;
  $('aClose').onclick = close;

  const el = $('aInput');
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  });
  // ⚠️ Esc 别冒到 window 上去 —— 那会把菜单之类的也一起关掉
  el.addEventListener('keyup', (e) => { if (e.key === 'Escape') e.stopPropagation(); });

  /*
   * 点框外面就收起来（跟右键菜单同款思路）。
   * ⚠️ 这个页面里除了 .card 之外全是「窗口的透明底」—— 那儿也要能收，
   *    所以 listen 在 window 上、判 target 不在 card 里。
   */
  window.addEventListener('pointerdown', (e) => {
    if (!e.target.closest('.ask-card')) close();
  }, true);

  // 切走（点到别的应用）也收 —— 独立窗口只能靠失焦判断「点外面了」
  window.addEventListener('blur', () => { if (!sent) close(); });

  // 窗口是复用的（close 只是 hide），每次被叫出来要把状态清干净
  window.yachiyo.on('ov:open', () => {
    sent = false;
    el.disabled = false;
    $('aSend').disabled = false;
    el.value = '';
    // ⚠️ 这里必须等一帧再 focus —— 窗口刚 show() 的时候还没拿到焦点，
    //    立刻 focus() 会被后面那次系统焦点覆盖掉，光标不在框里就得拿鼠标点一下
    setTimeout(() => { try { window.focus(); el.focus(); el.select(); } catch { /* 算了 */ } }, 30);
  });

  // 首帧（万一 ov:open 比脚本加载早，见 overlay.cjs 的 sendWhenReady）
  setTimeout(() => el.focus(), 60);
}

boot();
