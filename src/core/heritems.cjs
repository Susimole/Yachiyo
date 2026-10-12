/**
 * 她自己的东西 —— **心事 / 认错 / 小日子**。
 *
 * 三样放一个文件，是因为它们的形状几乎一样：**一条一条攒、有上限、
 * 相似的要合并、挑几条进提示词**。分开写三遍会有一堆复制粘贴，
 * 将来改一条规矩要改三处（旧工程就是散着的）。
 *
 * 存哪儿：
 *   · 心事 → `data/她的心事.json` 的 `worry` 字段（跟情绪**同一个文件**）
 *   · 认错 → `data/她认的错.json` 的 `mistake`
 *   · 小日子 → `data/她的小日子.json` 的 `small`
 *   ⚠️ 情绪为什么跟心事放一起？旧工程就是一份 `她的心事.json` 装两样，
 *      沿用它 —— 他手上有旧文件，格式对不上会很别扭。
 *
 * ⚠️ 键名用英文（旧工程是中文键，那是为了 PowerShell 好读；这边是 JS，
 *    英文键不会被编码/转义咬）。他照样能打开看。
 */

'use strict';

const path = require('node:path');
const cfg = require('./config.cjs');
const store = require('./store.cjs');
const T = require('./text.cjs');

const FILE_WORRY = path.join(store.DATA, '她的心事.json');
const FILE_MISTAKE = path.join(store.DATA, '她认的错.json');
const FILE_SMALL = path.join(store.DATA, '她的小日子.json');

/* ══════════════════════════════════════════════════════════
   ① 心事 —— 她在意、但还没解决的事
   ══════════════════════════════════════════════════════════ */

/** 三档。⚠️ 非法值一律当「在意」（旧工程如此）—— 宁可记重一点，别丢了 */
const WORRY_RANKS = ['小事', '在意', '重要'];

/**
 * 各档的寿命（天）。
 * ⚠️⚠️ **只有「小事」按天数过期（3 天），另外两档给 0 = 永不过期。**
 *     这是旧工程刻意定的：她在意的事、重要的事，只该由**解决**或者
 *     **她自己放下**来结束，不该因为"过了 N 天"就自动消失 ——
 *     那会让她变成一个说过就忘的人。「小事」是例外，鸡毛蒜皮该自然淡掉。
 */
const WORRY_DAYS = { 小事: 3, 在意: 0, 重要: 0 };

const WORRY_MAX = 60;         // 总上限（旧工程没写明，按「重要永不删」推的合理值）
const WORRY_HINT_MAX = 2;     // 注入最多几条

/*
 * ★★ 去重判据 —— 2026-10-12 晚从「单看 similarity ≥ 阈值」换成 `T.isLikelySame`。
 *
 * 为什么换：旧的单阈值在**共享句式**上会大量错合，实测
 *   「我以为他讨厌西瓜」vs「我以为他讨厌闹钟」→ **0.71**，
 *   而真正该合的「他今天心情不好」vs「不太好」→ 0.83 —— 两条挨得太近，
 *   砍高了漏合、砍低了错合。根因是那截公共前缀贡献了太多重复 gram。
 *
 * 新判据两道闸 + 先剃公共头尾，实测 7 条该合的全过、8 条不该合的全分得开
 * （含「他今天加班 / 没加班」这种否定词陷阱）。详见 `text.cjs` 的长注释。
 */

function readFile(file, key) {
  const v = store.readJson(file, null);
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { [key]: [] };
  if (!Array.isArray(v[key])) v[key] = [];
  return v;
}
function writeFile(file, o) { return store.writeJson(file, o); }

function stampId(prefix, now = new Date()) {
  return `${prefix}${T.day(now).replace(/-/g, '')}${T.pad2(now.getHours())}${T.pad2(now.getMinutes())}${T.pad2(now.getSeconds())}`;
}

/**
 * 加一条心事。
 * @param {object} o
 * @param {string} o.about  在意什么（3~60 字）
 * @param {string} [o.rank] 档位，不认→『在意』
 * @param {string} [o.effect] 影响（空则给兜底句「说话温和一点」）
 */
function addWorry(o = {}) {
  const about = String(o.about || '').trim().replace(/[\r\n]+/g, ' ');
  if (about.length < 3) return { ok: false, why: '太短了（要 3 字以上）' };
  if (about.length > 60) return { ok: false, why: '太长了（60 字以内）' };

  const rank = WORRY_RANKS.includes(o.rank) ? o.rank : '在意';
  const effect = String(o.effect || '').trim().slice(0, 40) || '说话温和一点';

  const all = readFile(FILE_WORRY, 'worry');
  const now = new Date();

  // 相似的合并 —— 同一件事她会反复注意到，那不是新心事，是同一件
  const hit = all.worry.find((w) => w && w.about
    && T.isLikelySame(w.about, about).same);

  if (hit) {
    hit.seenTimes = (Number(hit.seenTimes) || 1) + 1;
    hit.lastSeen = T.stamp(now);
    /*
     * ★ 反复到第 3 次 → 升档（旧工程的规矩）。
     *   「小事」老被她重新注意到，说明它其实不小 —— 那就别按小事算寿命了。
     *   只升「小事 → 在意」，不继续往上跳：再往上该由回顾链自己判。
     */
    if (hit.rank === '小事' && hit.seenTimes >= 3) {
      hit.rank = '在意';
      console.log(`[heritems] 心事第 3 次出现，升档：${hit.about}`);
    }
    writeFile(FILE_WORRY, all);
    return { ok: true, why: '', merged: true };
  }

  all.worry.push({
    id: stampId('m', now),
    written: T.stamp(now),
    about,
    rank,
    effect,
    seenTimes: 1,
    lastSeen: T.stamp(now),
    tries: [],
    status: '挂着',          // 挂着 | 放下了 | 解决了
  });

  // ⚠️ 满了之后从**最老的「小事」**开始扔 —— 宁可少一条鸡毛蒜皮，
  //    也不能把「重要」的挤掉
  if (all.worry.length > WORRY_MAX) {
    const i = all.worry.findIndex((w) => w && w.rank === '小事');
    all.worry.splice(i >= 0 ? i : 0, 1);
  }

  writeFile(FILE_WORRY, all);
  return { ok: true, why: '' };
}

/** 记一次为她这件事「试过了什么」 */
function addWorryTry(id, o = {}) {
  const all = readFile(FILE_WORRY, 'worry');
  const w = all.worry.find((x) => x && x.id === id);
  if (!w) return false;
  if (!Array.isArray(w.tries)) w.tries = [];
  w.tries.push({ at: T.stamp(new Date()), what: String(o.what || '').slice(0, 60), useful: !!o.useful });
  if (w.tries.length > 6) w.tries = w.tries.slice(-6);
  w.lastSeen = T.stamp(new Date());
  writeFile(FILE_WORRY, all);
  return true;
}

/**
 * 心事衰减 —— 每小时跑。
 * ⚠️ **只让小事的过期**（在意/重要寿命是 0 = 永不按天算）。见 WORRY_DAYS 的注释。
 */
function decayWorries(now = Date.now()) {
  const all = readFile(FILE_WORRY, 'worry');
  let n = 0;
  all.worry = all.worry.filter((w) => {
    if (!w || w.status !== '挂着') return true;
    const days = WORRY_DAYS[w.rank] || 0;
    if (!days) return true;                       // 0 = 永不过期
    const t = T.parseStamp(w.lastSeen || w.written);
    if (!t) return true;                          // 没时间戳 → 不猜，留着
    if ((now - t) / 86400000 >= days) { n++; return false; }
    return true;
  });
  if (n) { writeFile(FILE_WORRY, all); console.log(`[heritems] ${n} 条小事淡掉了`); }
  return n;
}

/* ══════════════════════════════════════════════════════════
   ② 认错 —— 她搞错了什么、学到了什么
   ══════════════════════════════════════════════════════════ */

/**
 * 上限 —— 走配置（默认 30）。
 * ⚠️ 写成配置键不是为了给他调，是为了**能被验**：
 *    硬编码常量的话，自检没法在不动源码的前提下把它压到 5 去确定性地撞上限。
 */
const MISTAKE_MAX_DEFAULT = 30;
const mistakeMax = () => Math.max(1, Number(cfg.get('MistakeMax')) || MISTAKE_MAX_DEFAULT);
// ⚠️ MISTAKE_SIM 已废 —— 去重改成 T.isLikelySame（两道闸 + 先剃公共头尾），见文件上方那段注释
const MISTAKE_HINT_MAX = 2;

/**
 * @param {object} o
 * @param {string} o.thought  我以为…… （**空了整条丢** —— 没有"我以为"就没有认知偏差，那只是流水账）
 * @param {string} o.actual   实际是……
 * @param {boolean} [o.open]  问题还在吗
 * @param {string} [o.lesson] 教训
 */
function addMistake(o = {}) {
  const thought = String(o.thought || '').trim().replace(/[\r\n]+/g, ' ');
  const actual = String(o.actual || '').trim().replace(/[\r\n]+/g, ' ');
  if (!thought) return { ok: false, why: '没写「我以为」—— 那不算认错' };
  if (!actual) return { ok: false, why: '没写「实际是」' };

  const body = thought + actual;
  if (body.length < 4) return { ok: false, why: '太短了' };
  if (body.length > 120) return { ok: false, why: '太长了（120 字以内）' };

  const all = readFile(FILE_MISTAKE, 'mistake');
  if (all.mistake.some((m) => m && m.thought
      && T.isLikelySame(m.thought + (m.actual || ''), body).same)) {
    return { ok: false, why: '这条已经认过了' };
  }

  const now = new Date();
  // ★ 新的放最前（旧工程如此）—— 取「最近 30 条」就不用再排序
  all.mistake.unshift({
    id: stampId('k', now),
    written: T.stamp(now),
    thought,
    actual,
    open: !!o.open,
    lesson: String(o.lesson || '').trim().slice(0, 60),
  });
  const cap = mistakeMax();
  if (all.mistake.length > cap) all.mistake = all.mistake.slice(0, cap);

  writeFile(FILE_MISTAKE, all);
  return { ok: true, why: '' };
}

/* ══════════════════════════════════════════════════════════
   ③ 她的小日子 —— 她自己的生活在过
   ══════════════════════════════════════════════════════════ */

/** 7 组。⚠️ 组名不认 → 归到「在做」 */
const SMALL_GROUPS = ['在做', '成了', '没成', '想做', '口味', '念想', '外面'];
const SMALL_PER_DAY = 2;       // ★ 一天最多 2 条（不然她一天能写 20 条流水账）
const SMALL_MAX = 80;
const SMALL_HINT_MAX = 4;
// ⚠️ SMALL_SIM 已废 —— 同上，走 T.isLikelySame

function addSmall(group, what, now = new Date()) {
  const g = SMALL_GROUPS.includes(group) ? group : '在做';
  const w = String(what || '').trim().replace(/[\r\n]+/g, ' ');
  if (w.length < 3) return { ok: false, why: '太短了（要 3 字以上）' };
  if (w.length > 60) return { ok: false, why: '太长了（60 字以内）' };

  const all = readFile(FILE_SMALL, 'small');
  const today = T.day(now);

  if (all.small.filter((s) => s && String(s.written || '').startsWith(today)).length >= SMALL_PER_DAY) {
    return { ok: false, why: `今天已经记过 ${SMALL_PER_DAY} 条了` };
  }
  if (all.small.some((s) => s && s.what && T.isLikelySame(s.what, w).same)) {
    return { ok: false, why: '这条差不多的已经记过了' };
  }

  all.small.push({ id: stampId('s', now), written: T.stamp(now), group: g, what: w });
  if (all.small.length > SMALL_MAX) all.small = all.small.slice(-SMALL_MAX);

  writeFile(FILE_SMALL, all);
  return { ok: true, why: '' };
}

/* ══════════════════════════════════════════════════════════
   提示词注入（三样各一段）
   ══════════════════════════════════════════════════════════ */

/**
 * 心事那段。
 *
 * ⚠️ 挑的是「跟她现在这句话最相关的」几条 —— 用**相似度 + 档位权重**打分。
 *    旧工程就是这么挑的（评分 = 档位权重×10 + 相似度×5），
 *    单纯取最新的会挑出一堆跟当下毫无关系的事。
 *
 * @param {string} key 检索键 —— 把「情境 + 他刚说的话」拼起来
 */
function worryBlock(key = '') {
  if (cfg.get('worryEnabled') === false) return '';
  const all = readFile(FILE_WORRY, 'worry');
  const live = all.worry.filter((w) => w && w.status === '挂着');
  if (!live.length) return '';

  const rankW = { 小事: 1, 在意: 2, 重要: 3 };
  const scored = live.map((w) => ({
    w,
    s: (rankW[w.rank] || 2) * 10 + (key ? T.similarity(w.about, key) * 5 : 0),
  })).sort((a, b) => b.s - a.s).slice(0, WORRY_HINT_MAX);

  const lines = [];
  for (const { w } of scored) {
    let s = `- ${w.about}`;
    if (w.rank === '重要') s += '（这件事对你挺重要）';
    if (Array.isArray(w.tries) && w.tries.length) {
      const last = w.tries[w.tries.length - 1];
      s += ` · 你试过：${last.what}`;
    }
    lines.push(s);
  }

  return [
    '【你心里挂着的事】',
    ...lines,
    '⚠️ 当背景用。**别主动报出来、别追问** —— 除非他正好聊到，那就自然接一句。'
    + '他不接就说明现在不想聊，放着。',
  ].join(T.CRLF);
}

/**
 * 认错那段。
 * ⚠️ **只带有「教训」的** —— 没教训的那几条是流水账，
 *    摆进提示词只会让她莫名其妙地翻旧账（旧工程专门跳过它们）。
 */
function mistakeBlock() {
  if (cfg.get('mistakeEnabled') === false) return '';
  const all = readFile(FILE_MISTAKE, 'mistake');
  const withLesson = all.mistake.filter((m) => m && m.lesson && m.thought).slice(0, MISTAKE_HINT_MAX);
  if (!withLesson.length) return '';

  const lines = withLesson.map((m) => `- 我以为${m.thought}，其实是${m.actual}。→ ${m.lesson}`);
  return [
    '【你自己认过的错】',
    ...lines,
    '⚠️ 这是提醒你别再犯同一个毛病的，**不是让他看见你记得多清楚**。'
    + '别主动提、别道歉一遍，正常说话就行。',
  ].join(T.CRLF);
}

/** 小日子那段 —— 从最新往前取最多 4 条 */
function smallBlock() {
  if (cfg.get('smallEnabled') === false) return '';
  const all = readFile(FILE_SMALL, 'small');
  const list = all.small.filter((s) => s && s.what).slice(-SMALL_HINT_MAX);
  if (!list.length) return '';

  const lines = list.map((s) => `- 〔${s.group}〕${s.what}`);
  return [
    '【你自己的小事】',
    ...lines,
    '⚠️ 这些是你自己日子里的东西，**不是拿来汇报的**。'
    + '聊到了顺口提一句就行，别一口气报完。',
  ].join(T.CRLF);
}

module.exports = {
  FILE_WORRY, FILE_MISTAKE, FILE_SMALL,
  WORRY_RANKS, WORRY_DAYS, SMALL_GROUPS,
  MISTAKE_MAX: MISTAKE_MAX_DEFAULT,
  addWorry, addWorryTry, decayWorries,
  addMistake,
  addSmall,
  worryBlock, mistakeBlock, smallBlock,
  _reset() {
    writeFile(FILE_WORRY, { worry: [] });
    writeFile(FILE_MISTAKE, { mistake: [] });
    writeFile(FILE_SMALL, { small: [] });
  },
};
