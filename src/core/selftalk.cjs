/**
 * 自言语 —— 隔一阵子她自己冒一句，不等他问。
 *
 * ── ★ 上下文是**独立**的一套（他 2026-10-12 拍板的 A 方案）────────
 *   系统提示词照常（人格 + 记忆 + 目标 + 心事 + 情绪 + 时间），
 *   但**用户那一侧不是聊天记录**，而是一段「现在的场景」：
 *       现在几点 + 外面天气 + 你最近已说过的话 + 「随口说一句就好」。
 *
 *   为什么不复用主对话：她自言语之后他要是接一句，模型会以为他接的是
 *   **刚才那段自言自语**，而实际上他根本没看见（气泡早消失了）。
 *   旧工程就是分开的，这里照搬。
 *
 * ⚠️ 但**记忆块要拿得到**：旧工程这条链传的是空串当检索键，结果
 *    `Get-AiMemoryBlock('')` 直接返回空 —— 习惯库和梗库**永远看不到**
 *    （"他会熬夜""他上晚班"这些最该在深夜用上的记忆全白记了，O35 修的）。
 *   新工程 `prompt.buildSystem({ userText })` 拿 userText 去检索，
 *   所以这里**必须给一个检索键**：先拿"现在几点"当键，够用了。
 *
 * ── 到点的判据（旧工程，一条都别省）──────────────────────────
 *   ① 总开关 / SelfTalkEnabled 开着
 *   ② ⚠️ **他在电脑前**（空闲 0~5 分钟）—— 人不在就别对着空椅子说话。
 *      看视频不算走开（那会儿键鼠也不动），所以这里只认 5 分钟这个粗判据。
 *   ③ 气泡不忙（她刚说过话 / 正在打字）→ 让给这一轮，下次再说
 *   ④ 「准备睡」挡着 → 不说（见 review.isSleeping()）
 *   ⑤ 从没到过点 → 排一个
 */

'use strict';

const cfg = require('./config.cjs');
const store = require('./store.cjs');
const T = require('./text.cjs');
const memory = require('./memory.cjs');
const provider = require('./provider.cjs');
const prompt = require('./prompt.cjs');
const usage = require('./usage.cjs');
const markers = require('./markers.cjs');
const weather = require('./weather.cjs');
const log = require('./log.cjs');

/** 上次说到哪儿了（下次到点时刻也在里面，重启不丢） */
const FILE = store.STATE + '/selftalk.json';

/** 「他在电脑前」的判据：空闲不到这么多分钟就算他在 */
const ACTIVE_MINUTES = 5;

/** 最近说过的话留几条（旧工程是 3 —— 压复读的**依据**，别加多） */
const RECENT_MAX = 3;

/** 拿到这句话之后走这个钩子（主进程注入：气泡 + 聊天记录） */
let say = null;

/** 「气泡忙不忙」——由主进程注入（气泡在计时 / 正在打字 / 有请求在飞） */
let busyCheck = null;

/** 「准备睡」挡不挡 —— 由主进程注入（review.isSleeping） */
let sleepCheck = null;

/**
 * 她说完之后叫一声 —— 主进程拿它记「我说过什么」。
 *
 * ⚠️ 自言语**不走 `runChat`**（那是"你问她答"那条路），
 *    所以那个统一记录点接不上它 —— 少这一条，她自言自语说的每一句
 *    都不会进"我说过什么"，也就**永远不会被去重**（照样复读）。
 */
let onSaid = null;

/**
 * 有请求在飞。
 *
 * ⚠️ **下次开口的时刻不放在内存里** —— 只认盘上 `selftalk.json` 的 `nextAt`。
 *    放内存里踩过：`tick()` 每次都调 `restoreSchedule()`，而它读的是盘；
 *    内存里那个改完之后，下一拍又被盘上的旧值盖回去 ——
 *    症状是"刚排好的期永远不算数"，而且看不出来是谁盖的。
 *    只留一个出处，就没有"谁盖谁"这回事了（顺带重启天然能接上）。
 */
let busy = false;

function attach(o = {}) {
  if (typeof o.say === 'function') say = o.say;
  if (typeof o.busy === 'function') busyCheck = o.busy;
  if (typeof o.sleeping === 'function') sleepCheck = o.sleeping;
  if (typeof o.onSaid === 'function') onSaid = o.onSaid;
}

/* ── 持久状态 ─────────────────────────────────────────── */

function readState() {
  const v = store.readJson(FILE, null);
  return (v && typeof v === 'object') ? v : {};
}
function writeState(o) { return store.writeJson(FILE, o); }

/** 最近说过的几句（最新的在前） */
function recents() {
  const r = readState().recent;
  return Array.isArray(r) ? r.filter((x) => typeof x === 'string' && x.trim()) : [];
}
function addRecent(text) {
  const s = readState();
  const list = [String(text).trim(), ...recents()]
    .filter((x, i, a) => x && a.indexOf(x) === i)      // 去掉挨着的重复
    .slice(0, RECENT_MAX);
  s.recent = list;
  s.lastAt = T.stamp(new Date());
  writeState(s);
}

/* ── 频率 ─────────────────────────────────────────────── */

/**
 * 时段倍率。
 * ⚠️ 乘在**间隔**上 —— 数越大越安静。白 1.5 / 晚 1.0 / 深夜 2.0（旧工程拍的）。
 * ⚠️ 判据用**小时**，不是"今天/昨晚"这种词 —— 后者会在 23:59 和 00:01 之间跳。
 */
function factor(now = new Date()) {
  const h = now.getHours();
  if (cfg.get('SelfTalkTimeFactors') === false) return 1;
  let f;
  if (h >= 7 && h < 18) f = num(cfg.get('SelfTalkDayFactor'), 1.5);
  else if (h >= 18 && h < 23) f = num(cfg.get('SelfTalkEveningFactor'), 1);
  else f = num(cfg.get('SelfTalkNightFactor'), 2);
  /*
   * ⚠️ 夹到 [0.2, 10]。
   *    他能在设置里把这几个数手改坏（0 / -3 / 1000）——
   *    0 的话间隔永远是 0 分钟，她会**每 5 秒说一句**；1000 的话等于永久闭嘴。
   *    两个都不是他要的，而且都不会报错。旧工程也是这么夹的。
   */
  if (!(f > 0)) f = 1;
  return Math.max(0.2, Math.min(10, f));
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/**
 * 排下一次。
 * @returns {number} 排到了什么时候（毫秒时间戳）
 */
function schedule(now = new Date()) {
  let min = Math.round(num(cfg.get('SelfTalkMinMinutes'), 20));
  let max = Math.round(num(cfg.get('SelfTalkMaxMinutes'), 60));
  if (min < 1) min = 1;
  if (max < min) max = min;

  const base = min + Math.floor(Math.random() * (max - min + 1));
  const f = factor(now);
  const eff = Math.max(1, Math.round(base * f));

  const at = now.getTime() + eff * 60000;
  const s = readState();
  s.nextAt = at;
  writeState(s);
  log.info('自言语', `下次安排在 ${new Date(at).toTimeString().slice(0, 8)}` +
    `（基准 ${base} 分钟 × ${f} = ${eff} 分钟后）`);
  return at;
}

/** 下次开口的时刻（读盘 —— 唯一的出处） */
function nextAt() { return Number(readState().nextAt) || 0; }

/** 重启之后接着上次的点（没排过 / 已经过太久就重排） */
function restoreSchedule(now = new Date()) {
  const v = nextAt();
  // ⚠️ 过去超过 2 小时的不认 —— 那是几天前存的，直接用她会在启动瞬间开口
  if (v > now.getTime() - 2 * 3600000) return v;
  return schedule(now);
}

/* ── 那段「现在的场景」 ───────────────────────────────── */

/**
 * 自言语用的**用户侧文本**。
 *
 * ⚠️ 这不是"他说的话"，是「她此刻所处的场景」。措辞照旧工程
 *   （`New-AiSelfTalkContext`）—— 尤其"别每句都围着他转"那几句是他特意加的。
 */
function context(now = new Date()) {
  const parts = [];

  // ⚠️ `SelfTalkUseTime` 之前是个**没被读过的键**（默认 true，关掉没反应）。
  //    这里补上：关掉就不给她"现在几点"，那她就不会说"这个点了该睡了"这种话。
  //    说白了这道开关的真实用途是：**不想让她提时间**的时候关掉。
  if (cfg.get('SelfTalkUseTime') !== false) parts.push(prompt.timeBlock(now));
  parts.push('');
  parts.push('他在电脑前。');
  parts.push('（你不需要回答任何问题 —— 这只是你自己想开口。）');

  // 天气只读缓存，绝不在这儿发请求（提示词总装是她说每句话的必经之路）
  if (cfg.get('SelfTalkUseWeather') !== false) {
    const wx = weather.cachedText();
    if (wx) {
      const city = String(cfg.get('city') || '');
      parts.push('');
      parts.push(city ? `外面（${city}）：${wx}` : `外面：${wx}`);
    }
  }

  if (cfg.get('SelfTalkAvoidRepeat') !== false) {
    const r = recents();
    if (r.length) {
      parts.push('');
      parts.push('你最近已经说过这些话了，别重复，也别换个说法再说一遍：');
      for (const x of r) parts.push('- ' + x);
    }
  }

  parts.push('');
  parts.push('你跟他像处了很多年的老朋友，不是整天盯着他操心的大姐。');
  parts.push('这几句就说你自己：在想什么、想吃什么、刚冒出来的怪点子 —— 整句都不提他也行。');
  parts.push('别每句话都问他怎么样，也别老是关心他吃没吃、睡没睡。');
  parts.push('');
  parts.push('随口说一句就好。不想说的话，就只回复两个字：沉默');

  return parts.join(T.CRLF);
}

/* ── 那一趟请求 ───────────────────────────────────────── */

/**
 * 真去说一句。
 * @returns {Promise<{said:boolean, text:string, why:string}>}
 */
async function run(now = new Date()) {
  if (busy) return { said: false, text: '', why: '上一句还没说完' };
  const c = cfg.all();
  if (!c.apiKey) return { said: false, text: '', why: '还没填 API Key' };

  busy = true;
  const t0 = Date.now();
  try {
    /*
     * ⚠️ 系统提示词照常给，但**检索键不能是空串** ——
     *    空串的时候习惯库/梗库一条都命中不了（旧工程 O35 的坑）。
     *    这里拿"现在的时段词 + 天气"当键，足够让「熬夜 / 睡眠 / 上班」这些
     *    该在深夜用上的记忆浮出来。
     */
    const h = now.getHours();
    const key = (h >= 23 || h < 5) ? '深夜 熬夜 睡觉 作息 上班 晚班'
              : (h < 11) ? '早上 起床 早饭 上班'
              : (h < 14) ? '中午 吃饭 午饭'
              : (h < 18) ? '下午 工作 累'
              : '晚上 吃饭 下班 休息';

    /*
     * ⚠️ `SelfTalkUseMemory` 之前也是个**没被读过的键**。
     *    它的语义 = "自言语里要不要带上她记住的东西"。
     *      · 关掉：系统提示词**整个不给她**（只剩人格 + 时间）——
     *        她说的话就只在当下，不会翻旧账
     *      · 打开（默认）：照常给
     *    ⚠️ 关掉的时候连**人格**都必须留着 —— 那是"她是谁"，
     *      不带人格就不是她了。
     */
    const useMem = cfg.get('SelfTalkUseMemory') !== false;
    const sysPrompt = useMem
      ? prompt.buildSystem({ userText: key, now })
      : [prompt.personaBlock(), prompt.timeBlock(now)].filter(Boolean).join(T.GAP);

    const r = await provider.chat({
      base: c.apiBase, key: c.apiKey, model: c.model,
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: context(now) },
      ],
      /*
       * ⚠️ 自言语**不走思考模式** —— 它就是随口一句，
       *    开思考会从几秒变成几十秒，而她还等着冒气泡。
       */
      thinking: false,
      temperature: c.temperature,
      thinkingStyle: c.thinkingStyle,
    });

    const yuan = provider.cost(r.usage, { in: c.priceIn, out: c.priceOut, hit: c.priceCacheHit });
    usage.add(r.usage, yuan);

    const parsed = markers.parse(r.text, { chain: 'selftalk' });
    const text = String(parsed.text || '').trim();

    /*
     * ★ 「沉默」是**合法输出**，不是失败 —— 旧工程专门留的：
     *   不给她"可以不说"这个出口，她就会为了完成任务硬挤一句废话。
     *   ⚠️ 只认短的：模型偶尔会写「今天我想沉默一会儿，因为…」，
     *      那种不算，那是她真想说话。
     */
    if (!text || text === '沉默' || /^[（(]?沉默[）)]?[。.]?$/.test(text)) {
      log.info('自言语', '这一轮她说"沉默"，那就不说（合法的）');
      return { said: false, text: '', why: '她自己选了沉默' };
    }

    // ⚠️ 太长的不要 —— 自言自语不是开讲座（旧工程截到 200）
    const out = text.length > 200 ? text.slice(0, 200) : text;

    if (typeof say === 'function') {
      // ⚠️ 带上这条链**自己的**气泡时长（配置键 SelfTalkBubbleSeconds）
      try { say(out, { kind: '自言自语', seconds: Number(cfg.get('SelfTalkBubbleSeconds')) || 0 }); }
      catch (err) { log.error('自言语', '往外说的时候出错：' + err.message); }
    }
    addRecent(out);
    /*
     * ★ 记进「她说过的每一句话」。
     * ⚠️ 用**剥过标记的成品**，不是模型吐的原文（原文里可能有 `[心情 …]`）。
     * ⚠️ 跟 `addRecent` 是**两件事**，别合：
     *      `recent` = 自言语自己那条链的"最近 3 句"（窄，只压自言自语）
     *      这一条   = 全局的"我说过什么"（宽，四条链共用，压所有复读）
     */
    try { if (typeof onSaid === 'function') onSaid(out); }
    catch (err) { log.error('自言语', '记「我说过什么」时出错：' + err.message); }
    log.info('自言语', `${Date.now() - t0}ms · 说了 ${out.length} 字：${out}`);
    return { said: true, text: out, why: '' };

  } catch (err) {
    log.error('自言语', `失败：${err.message}`);
    return { said: false, text: '', why: err.message };
  } finally {
    busy = false;
  }
}

/* ── 五道闸（心跳 5 秒叫一次）─────────────────────────── */

/**
 * @param {number} idleMin 键鼠停了多少分钟（拿不到是 -1）
 * @param {Date} [now]
 * @returns {string} 这一拍做了什么（日志/探针要看）
 */
function tick(idleMin, now = new Date()) {
  if (cfg.get('AiEnabled') === false) return '总开关关着';
  if (cfg.get('SelfTalkEnabled') === false) return '自言语关着';
  if (busy) return '上一句还在路上';

  const at = restoreSchedule(now);
  if (now.getTime() < at) return '还没到点';

  /*
   * ★★ **一到点就先排下一次，然后才判要不要说**（旧工程就是这个顺序）。
   *
   *   我第一版是"说了才排"。后果很具体：气泡忙的时候这一拍直接 return，
   *   排期**没动** —— 于是每一拍都还是"到点"状态。他要是连着聊了半小时，
   *   她这半小时里每一拍都在"到点了但说不出"，等他一停，
   *   她**立刻**就冒一句 —— 间隔完全没起作用，看着像她一直在门口等着插嘴。
   *
   *   先排的话，被挡掉那一轮就等于**这一轮让过去了**，下一轮本来就在
   *   20~60 分钟之后，正是我们要的"这次先不说了，下次再说"。
   */
  schedule(now);

  // ④ 「准备睡」挡着（回顾之后她就安静等着了）
  try { if (typeof sleepCheck === 'function' && sleepCheck()) return '准备睡中，不说'; } catch { }

  /*
   * ② 他不在就别对着空椅子说话。
   * ⚠️ `idleMin < 0` = **拿不到**空闲时间，不是"他不在" —— 这种情况**照说**，
   *    不然一旦系统不给这个数，她从此再也不开口，而且不报错。
   */
  if (idleMin >= 0 && idleMin > ACTIVE_MINUTES) return '他不在（先不说）';

  // ③ 气泡忙 → 让给这一轮
  try { if (typeof busyCheck === 'function' && busyCheck()) return '气泡正忙，让一轮'; } catch { }

  // ⑤ 说
  run(now).catch((e) => log.error('自言语', '异步那趟出错：' + e.message));
  return '说一句';
}

/* ── 状态 ─────────────────────────────────────────────── */

module.exports = {
  FILE, ACTIVE_MINUTES, RECENT_MAX,
  attach, tick, run, context, factor, schedule, restoreSchedule, recents,
  isBusy: () => busy,
  nextAt,
  /** 他说话了 —— 自言语让一让，别跟他抢（也顺手压一下复读） */
  noteUserSpoke(text) {
    const t = String(text || '').trim();
    if (t) addRecent(t);
  },
  /** 自检用：直接把下次到点写成某个时刻（走盘，跟真实路径同一条） */
  _setNextAt(t) { const st = readState(); st.nextAt = Number(t) || 0; writeState(st); },
  _reset() { busy = false; say = null; busyCheck = null; sleepCheck = null; writeState({}); },
  _state: () => ({ busy, nextAt: nextAt(), nextIn: nextAt() ? Math.round((nextAt() - Date.now()) / 60000) : null, ...readState() }),
};
