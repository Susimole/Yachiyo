/**
 * 心跳 —— 她每隔几秒醒一下，看看有没有到点该做的事。
 *
 * ⚠️⚠️ **这个文件只做「什么时候该跑」，不碰「跑什么」。**
 *     每样活的实现都在各自的模块里（`mood` / `heritems` / `goals` / …），
 *     这里只负责按时间把它们叫起来。
 *
 *     为什么分这么清楚：旧工程是把定时判断和具体活儿混在四个 `Update-Ai*`
 *     函数里的，结果「一小时跑一次」这段逻辑被抄了四遍，改一处忘三处。
 *
 * 旧工程那一套（`入口.ps1` 里三个定时器）：
 *   · **5 秒**那一拍  —— 收联网结果（那一步我们还没做）
 *   · **30 秒**那一拍 —— 领任务、说话、识屏、自言语、主动开口
 *   · 每个 `Update-Ai*` 自己再判「到点没」
 *   ⇒ 新工程收成**一个心跳**：每 5 秒叫一次，各模块自己判到没到点。
 *
 * ── 三个节流键 ──（旧工程的做法，一个都不能少）
 *   `hourKey`  一小时只跑一次  —— 情绪回落 / 心事衰减
 *   `dayKey`   一天只跑一次    —— 目标到期判定
 *   两个都用**本地时间**拼键（`yyyy-MM-dd HH` / `yyyy-MM-dd`），
 *   ⚠️ 不能用「距上次多少毫秒」—— 那样休眠唤醒之后会连着补跑好几次。
 *
 * ⚠️ **空闲时间是问系统要的**（`powerMonitor.getSystemIdleTime()`），
 *    不是自己记的「上次收到鼠标事件是什么时候」。两者差别很大：
 *    她自己走动、气泡刷新都会动，自己记的那个在「他走开了但她在动」
 *    的时候会一直归零 —— 而「他到底在不在」正是回顾链最关键的一道闸。
 */

'use strict';

const cfg = require('./config.cjs');
const mood = require('./mood.cjs');
const heritems = require('./heritems.cjs');
const goals = require('./goals.cjs');
const T = require('./text.cjs');

/** 心跳间隔（毫秒）。⚠️ 旧工程是 5 秒 —— 跟联网收尾那条链绑着，别随手改大 */
const TICK_MS = 5000;

/** 三个节流键 —— 跑过一次就记下当前的时间键，下次比对 */
let hourKey = '';
let dayKey = '';

/** `powerMonitor` 实例，由主进程装配时塞进来（core 层不直接 require electron） */
let powerMonitor = null;

/** 喂系统空闲时间用 —— 主进程那边要拿到的是**秒**，这里存秒 */
let idleRetriever = null;

/**
 * 装配。
 * @param {object} o
 * @param {object} o.powerMonitor Electron 的 powerMonitor（用来拿系统空闲时间）
 */
function attach(o = {}) {
  powerMonitor = o.powerMonitor || null;
}

/**
 * 他多久没碰键鼠了（**分钟**）。
 * @returns {number} 分钟；拿不到返回 -1（调用方据此**不做判断**，而不是当成"他刚动过"）
 */
function idleMinutes() {
  try {
    if (idleRetriever) return idleRetriever();
    if (!powerMonitor || typeof powerMonitor.getSystemIdleTime !== 'function') return -1;
    // ⚠️ 它返回的是**秒**
    return powerMonitor.getSystemIdleTime() / 60;
  } catch { return -1; }
}

/** 测试用：直接喂一个空闲分钟数进去（不走系统） */
function _setIdleMinutes(fn) { idleRetriever = fn; }

/* ── 三个节流 ─────────────────────────────────────────── */

const sameHour = (now) => `${T.day(now)} ${T.pad2(now.getHours())}`;
const sameDay = (now) => T.day(now);

/**
 * 每小时的维护：情绪回落 + 心事衰减。
 * @returns {string[]} 这次真跑了哪几样（给日志用；没到点返回空数组）
 */
function hourly(now = new Date()) {
  const k = sameHour(now);
  if (k === hourKey) return [];
  hourKey = k;

  const done = [];
  try { if (mood.decay(now.getTime())) done.push('情绪回落'); }
  catch (err) { console.error('[heartbeat] 情绪回落出错：' + err.message); }
  try { if (heritems.decayWorries(now.getTime())) done.push('心事衰减'); }
  catch (err) { console.error('[heartbeat] 心事衰减出错：' + err.message); }
  return done;
}

/**
 * 每天的维护：目标到期 → 搁下。
 * @returns {number} 搁下了几条
 */
function daily(now = new Date()) {
  const k = sameDay(now);
  if (k === dayKey) return 0;
  dayKey = k;
  try { return goals.tick(now); }
  catch (err) { console.error('[heartbeat] 目标判定出错：' + err.message); return 0; }
}

/* ── 那一拍 ───────────────────────────────────────────── */

/** 后面几步接上来的活（回顾 / 自言语 / 唱歌 / 自动关闭），现在都还是空 */
const hooks = {
  review: null,      // () => void         —— 回顾链
  selfTalk: null,    // () => void         —— 自言语
  autoExit: null,    // (idleMin) => void  —— 准备睡 / 自动关闭
  /*
   * 人物画像的"该不该重写"。
   * ⚠️ 它跟上面三条**不一样**：不看「准备睡」、也不说话 ——
   *    它是后台把"他这个人"重写一遍，正是他不在的时候该干的活。
   *    自己内部有 6 小时一次的节流（见 core/profiletool.cjs）。
   */
  profile: null,     // () => void         —— 人物画像重写
  /*
   * 识屏（隔一阵看一眼他的屏幕）。
   *
   * ⚠️⚠️ **这个键曾经漏掉过**（2026-10-13 加识屏时）——
   *    `on()` 里是 `if (name in hooks)`，**键不存在就静默不注册**。
   *    症状极阴：主进程 `heartbeat.on('screen', …)` 老老实实返回、
   *    不报错、不警告，而识屏**永远不跑**，日志里一个字都没有。
   *    ⇒ **以后再加链，第一件事是在这儿补一行。**
   */
  screen: null,      // (idleMin) => void  —— 识屏
  /*
   * 花钱那本账的看门人（设置里那个「花超了提醒我」）。
   *
   * ⚠️ 2026-10-16 加的：那个功能**一直是死的** ——
   *    `usage.overLimit` / `spendAlert` / `spendLimit` 全仓只在
   *    usage.cjs 里定义过，**没有任何地方调用**。
   *    他要的语义是"花到一定数就提醒我"，而"定期去看一眼"这件事
   *    全程序只有这一个地方有：心跳。
   *
   * ⚠️ 按上面那条教训 —— 加链第一件事就是在**这张表里补一行**，
   *    不然 `on()` 会静默不注册（`if (name in hooks)`），什么症状都没有。
   */
  spend: null,       // () => void         —— 花钱超限提醒
  /*
   * 每日 / 每周备份（2026-10-17 加的，清单 #6）。
   *
   * ⚠️ 原来它**只在启动 8 秒后跑一次**，那段注释给的理由是
   *    「放心跳的话，判断是"今天备过没有"—— 可每 5 秒 stat 一遍目录、
   *      读一遍备份状态，纯白烧 IO」。
   *    那个顾虑是真的，但代价太大：桌宠是**长期不关机**的 ⇒
   *    备份要一直等到下次启动。第 3 天崩了或磁盘出问题，手上没有近期备份。
   *    备份是保他数据的东西，不能赌"他什么时候重启"。
   *
   *    ⇒ 两个顾虑一起解：**挂心跳 + 内存节流**（节流在 index.cjs 那边，
   *      一小时才真判一次）。既不用等重启，也不会每 5 秒读盘。
   *
   * ⚠️ 按上面识屏那条教训 —— 加链第一件事就是在**这张表里补一行**，
   *    不然 `on()` 会静默不注册（`if (name in hooks)`），什么症状都没有。
   */
  backup: null,      // () => void         —— 每日 / 每周备份
};

/** 注册一副钩子（第 4 步后面两段会调） */
function on(name, fn) {
  if (name in hooks) hooks[name] = fn;
}

/**
 * **心跳那一拍** —— 每 5 秒叫一次。
 *
 * @param {Date} [now]
 * @returns {object} 这一拍干了什么（探针/自检要看）
 */
function tick(now = new Date()) {
  const out = { hourly: [], daily: 0, idleMin: -1, ran: [] };

  /*
   * ⚠️ 总开关关着就**整个不跑**。
   *    但**节流键照样要推进** —— 不然关掉一小时再打开，会立刻补跑一次
   *    「情绪回落」，看着像她一开机就莫名其妙变了心情。
   */
  if (cfg.get('AiEnabled') === false) {
    hourKey = sameHour(now);
    dayKey = sameDay(now);
    return out;
  }

  out.hourly = hourly(now);
  out.daily = daily(now);
  out.idleMin = idleMinutes();

  for (const [name, fn] of Object.entries(hooks)) {
    if (!fn) continue;
    try { fn(out.idleMin, now); out.ran.push(name); }
    catch (err) { console.error(`[heartbeat] ${name} 这一拍出错：` + err.message); }
  }
  return out;
}

/** 开一个真定时器（主进程装配时调） */
let timer = null;
function start() {
  if (timer) return timer;
  // ⚠️ `.unref()` **不能加** —— 加了之后这个定时器不会让进程保持存活，
  //    而它正是"她还活着"的凭据之一。主进程本来就常驻，但显式一点更稳。
  timer = setInterval(() => {
    try { tick(); } catch (err) { console.error('[heartbeat] 心跳出错：' + err.message); }
  }, TICK_MS);
  console.log(`[heartbeat] 心跳起来了，每 ${TICK_MS / 1000} 秒一拍`);
  return timer;
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

/**
 * 探针/自检重置用。
 * ⚠️ **`idleRetriever` 也要清** —— 不清的话上一段测试注入的假空闲时间
 *    会一直粘着，下一段测「拿不到空闲时间」时它还给着旧值，
 *    于是那条断言永远红（而且看着像 heartbeat 的 bug，不像测试的）。
 */
function _reset() { hourKey = ''; dayKey = ''; idleRetriever = null; powerMonitor = null; stop(); }

module.exports = {
  TICK_MS, attach, tick, start, stop, on, idleMinutes,
  _setIdleMinutes, _reset,
  _state: () => ({ hourKey, dayKey, running: !!timer }),
};
