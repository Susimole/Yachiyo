/**
 * 准备睡 → 自动关闭 —— 他离开够久，她留一句晚安然后自己退出。
 *
 * ── ★★ 四道闸，缺一道都会出真机事故 ──────────────────────────
 *
 *   ① **键鼠停够 `AutoExitIdleMinutes`**（默认 60）
 *
 *   ② ⚠️⚠️ **这一趟运行里必须"见过活人"** —— 这条是**真机事故换来的**。
 *      旧工程 2026-10-03：他远程挂着不动，Windows 的空闲时间是**从系统层面**算的，
 *      桌宠一启动就是"键鼠停了 2 小时" → **秒关** —— 启动等于没启动。
 *      判据：这一趟里出现过「空闲 < 5 分钟」的时刻，才允许关。
 *      ⚠️ 别图省事用"启动后过了多久"代替 —— 那挡不住"他一直在看着但没碰键鼠"。
 *
 *   ③ **回顾还没跑完 → 不许关**（他当年标了「切记切记」）。
 *      关了就等于把她今天想的东西全丢了，而且没有任何痕迹。
 *
 *   ④ **她说想晚点关 → 一天最多延 1 次、每次 30 分钟**
 *      （回顾输出里的 `晚点关|` 那一行，见 review.cjs）。
 *      ⚠️ 延完那一次要**清掉标记**，不然每一拍都会重新延，永远关不掉。
 *
 * ── 退出走哪条路 ─────────────────────────────────────────────
 *   不在这儿直接 `app.quit()` —— 这里只做判断，真正的退出由主进程注入的
 *   `quit` 钩子走**软退出**（收窗 → 存盘 → 退进程），跟托盘那条路是同一个。
 */

'use strict';

const cfg = require('./config.cjs');
const store = require('./store.cjs');
const T = require('./text.cjs');
const mood = require('./mood.cjs');
const log = require('./log.cjs');

/** 「见过活人」+ 晚点关的标记存这儿（重启不该把"见过活人"带过来 —— 见闸②） */
const FILE = store.STATE + '/autoexit.json';

/** 「他就在电脑前」的判据：空闲不到这么多分钟 */
const SAW_ACTIVE_MINUTES = 5;

/** 晚点关：一天最多延一次，一次这么久 */
const LATE_MINUTES = 30;

/** 说晚安之前给他一点反应时间（他也是人，可能刚坐下又想走） */
const BYE_GRACE_MS = 1500;

/*
 * ⚠️ `AiSawUserActive` **故意不落盘、不放模块级持久** ——
 *    它是「**这一趟运行**里见过活人」，重启一次就该归零。
 *    存到 review/autoexit 的状态文件里的话，下次开机她又能秒关
 *    （那正是这道闸要防的事）。
 */
let sawUserActive = false;

/** 已经说过晚安了（防重入） */
let byeSaid = false;

/** 主进程注入的三个钩子 */
let hooks = { say: null, quit: null, reviewBusy: null, wasActive: null };

function attach(o = {}) {
  if (typeof o.say === 'function') hooks.say = o.say;
  if (typeof o.quit === 'function') hooks.quit = o.quit;
  if (typeof o.reviewBusy === 'function') hooks.reviewBusy = o.reviewBusy;
  /**
   * 「他前几天在不在」——可选。
   * ⚠️ 给了就**两重判据一起用**：这一趟见过活人 **或者** 之前确实活跃过。
   *    只认前者的话，他晚上挂机睡下、第二天早上回来，她会一直不关
   *    （那也还行）；只认后者的话就退回旧工程那个"秒关"的坑。
   *    ⇒ **默认只认前者**，这个钩子是给以后接"在场"链留的口子。
   */
  if (typeof o.wasActive === 'function') hooks.wasActive = o.wasActive;
}

/* ── 当日状态 ─────────────────────────────────────────── */

function readState() {
  const v = store.readJson(FILE, null);
  return (v && typeof v === 'object') ? v : {};
}
function writeState(o) { return store.writeJson(FILE, o); }

/**
 * 她说「想晚点关」。
 * @returns {{ok:boolean, why:string}}
 */
function askLate(now = new Date()) {
  const s = readState();
  if (String(s.lateDay || '') === T.day(now)) {
    return { ok: false, why: '今天已经延过一次了' };
  }
  s.lateDay = T.day(now);
  s.lateAt = T.stamp(now);
  writeState(s);
  log.info('自动关闭', `她说想晚点关 —— 那就再等 ${LATE_MINUTES} 分钟（今天那次用掉了）`);
  return { ok: true, why: '' };
}

/** 今天那次"晚点关"用掉了没有 */
function lateUsedToday(now = new Date()) {
  return String(readState().lateDay || '') === T.day(now);
}

/**
 * 今天这次延时要生效吗？
 *
 * ⚠️ **消费式**：返回 true 的同时把标记清掉。
 *    不清的话每一拍都返回 true，就永远关不掉了 —— 旧工程专门为这个写过注释。
 */
function consumeLate(now = new Date()) {
  if (!lateUsedToday(now)) return false;
  const s = readState();
  delete s.lateDay;
  delete s.lateAt;
  writeState(s);
  return true;
}

/* ── 晚安（按心情挑一句）─────────────────────────────── */

/**
 * ⚠️ 三档心情配三句话（旧工程）。
 *    心情拿不到就退回默认那句 —— **不许因为心情读不出来就不说晚安了**。
 */
function byeText() {
  let now = '';
  try { now = String(mood.read().现在 || ''); } catch { /* 读不出来就用默认那句 */ }
  if (now === '高兴') return '今天挺好的，我先睡啦';
  if (now === '低落') return '我先去躺会儿';
  return '我有点困了，先去睡啦';
}

/* ── 那一拍 ───────────────────────────────────────────── */

/**
 * @param {number} idleMin 键鼠停了多少分钟（拿不到是 -1）
 * @param {Date} [now]
 * @returns {string} 这一拍做了什么
 */
function tick(idleMin, now = new Date()) {
  if (cfg.get('AiEnabled') === false) return '总开关关着';
  if (cfg.get('AutoExitEnabled') === false) return '自动关闭关着';

  // 拿不到空闲时间 → 不判断（宁可开着也不误关）
  if (idleMin < 0) return '拿不到空闲时间（不判断）';

  /*
   * ★ 闸②的前半：他就在电脑前 → 记一笔"这一趟见过活人"。
   * ⚠️ 这一句必须放在**门槛判断之前** —— 放在后面的话，
   *    他动完之后空闲时间一涨过门槛，这个标记永远记不上。
   */
  if (idleMin < SAW_ACTIVE_MINUTES) {
    if (!sawUserActive) log.info('自动关闭', '见到他动了 —— 这一趟允许自动关闭');
    sawUserActive = true;
    /*
     * ⚠️ 这里**不重置 `byeSaid`**。
     *    说了晚安之后他已经走了（软退出排在那儿了），他要是刚好回来碰一下、
     *    再走 —— 那第二轮的"她不说话了"才是更奇怪的。
     *    一次运行留一次晚安就够。
     */
    return '他在（不动）';
  }

  let need = Math.round(Number(cfg.get('AutoExitIdleMinutes')) || 60);
  if (!(need >= 10)) need = 60;            // ⚠️ 填小了（0 / 负数）就按 60 —— 别让她十分钟就走
  if (idleMin < need) return '还没停够';

  // ★ 闸②：这一趟还没见过活人 → 一律不关（防"一开机就秒关"）
  if (!sawUserActive) {
    if (hooks.wasActive && hooks.wasActive()) { /* 有别的凭据，放行 */ }
    else return '这一趟还没见过他动过（不关）';
  }

  // ★ 闸③：回顾没跑完不许关（他标了「切记切记」）
  try { if (hooks.reviewBusy && hooks.reviewBusy()) return '回顾还在跑（不关）'; } catch { }

  // ★ 闸④：她说想晚点关 —— 消费掉那一次，然后往后推
  if (consumeLate(now)) return `她说晚点关，再等 ${LATE_MINUTES} 分钟`;

  // 留晚安（只留一次）
  if (!byeSaid) {
    byeSaid = true;
    const bye = byeText();
    try { if (hooks.say) hooks.say(bye, { kind: '睡前' }); }
    catch (err) { log.error('自动关闭', '留晚安时出错：' + err.message); }
    log.info('自动关闭',
      `键鼠停了 ${Math.round(idleMin)} 分钟（门槛 ${need}）→ 留了晚安，准备保存退出`);
  }

  /*
   * ⚠️ 松手之前给一拍缓冲。
   *    晚安气泡刚冒出来就退进程的话，他看到的是一闪而过的半个气泡 ——
   *    而"她说了句晚安"正是这条链**唯一**让他看得见的东西。
   *    （旧工程是同步流程，这里得自己等。）
   */
  if (!quitTimer) {
    quitTimer = setTimeout(() => {
      quitTimer = null;
      try {
        if (hooks.quit) hooks.quit();
        else log.warn('自动关闭', '没接退出钩子 —— 判断全过了但没退成');
      } catch (err) { log.error('自动关闭', '退出时出错：' + err.message); }
    }, BYE_GRACE_MS);
    // ⚠️ 别 unref —— 这一拍之后主进程可能没有别的活了，unref 会让它悄悄不执行
  }
  return '留晚安，准备退出';
}

let quitTimer = null;

/* ── 状态 ─────────────────────────────────────────────── */

module.exports = {
  FILE, SAW_ACTIVE_MINUTES, LATE_MINUTES,
  attach, tick, byeText, askLate, lateUsedToday, consumeLate,
  sawUserActive: () => sawUserActive,
  _setSawActive(v) { sawUserActive = !!v; },
  _reset() {
    sawUserActive = false;
    byeSaid = false;
    hooks = { say: null, quit: null, reviewBusy: null, wasActive: null };
    if (quitTimer) { clearTimeout(quitTimer); quitTimer = null; }
    writeState({});
  },
  _state: () => ({ sawUserActive, byeSaid, pending: !!quitTimer, ...readState() }),
};
