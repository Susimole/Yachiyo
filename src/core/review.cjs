/**
 * 回顾链 —— 一天结束（他离开够久），她坐下来把今天想一遍。
 *
 * 产出四样，都写进 3c 那些数据层：
 *   心事 | 档位 || 内容 || 影响
 *   情绪 | 心情 || 为什么 || 挂在哪条心事上（可空）
 *   认错 | 我以为 || 实际是 || 问题还在吗 || 教训
 *   小日子 | 组 || 内容
 *   想说 | （今天不想想这些，合法，不是怠工）
 *   晚点关 | （她想再等会儿，今天最多延一次 30 分钟）
 *
 * ── ★★ 五道闸，一道都不能省 ─────────────────────────────
 *   ① **键鼠停够 `ReviewIdleMinutes`**（默认 55）
 *      不设这道她会在你打字的时候突然"回顾"。
 *   ② **他回来了**（idle < 门槛）→ 若在「准备睡」就**静默取消**，
 *      不解释、不尴尬 —— 旧工程原话。
 *   ③ **今天已经回顾过** → 只进「准备睡」，不再发请求（一天最多一次）。
 *   ④ **今天没怎么聊过** → 跳过，**照样标记今天已回顾**。
 *      ⚠️ 这条是防"编"的：没材料硬回顾，她会编出一段不存在的经历。
 *      判据 = 他说过 **≥2 句**（旧工程 `Test-AiReviewHasMaterial`）。
 *   ⑤ 前四条都过 → 发起回顾，标记今天已回顾，并进「准备睡」。
 *
 * ── 为什么不用「最后活动时间」记空闲 ──
 *   空闲时间是**问系统要**的（主进程的 `powerMonitor.getSystemIdleTime()`），
 *   由 `heartbeat.idleMinutes()` 提供。自己记的那个在「他走开了但她在动」
 *   的时候会一直归零 —— 而那正是这道闸最需要准的时刻。
 */

'use strict';

const cfg = require('./config.cjs');
const store = require('./store.cjs');
const T = require('./text.cjs');
const memory = require('./memory.cjs');
const provider = require('./provider.cjs');
const mood = require('./mood.cjs');
const heritems = require('./heritems.cjs');
const usage = require('./usage.cjs');
const log = require('./log.cjs');

/*
 * ⚠️ 循环依赖的破法：这里**只在用到的时候**才 require autoexit。
 *    autoexit 不 require review（它靠主进程注入的 `reviewBusy` 钩子问），
 *    所以其实不构成环 —— 但保持这个习惯，免得以后谁加了反向依赖就悄悄死锁。
 */
let _autoexit = null;
function autoexitMod() {
  if (!_autoexit) { try { _autoexit = require('./autoexit.cjs'); } catch { _autoexit = null; } }
  return _autoexit;
}

/** 「今天回顾过没有」等当日状态存这儿 */
const FILE = store.STATE + '/review.json';

/** 回顾的对话上限（旧工程 30 轮，每句截 80 字） */
const MATERIAL_TURNS = 30;
const MATERIAL_LINE_MAX = 80;
/** 说他至少说过几句才算"今天聊过"（旧工程就是 2） */
const MIN_USER_LINES = 2;

let busy = false;              // 有请求在飞
let sleepMode = false;         // 「准备睡」
let lastError = '';

/* ── 当日状态 ─────────────────────────────────────────── */

function readState() {
  const v = store.readJson(FILE, null);
  return (v && typeof v === 'object') ? v : {};
}
function writeState(o) { return store.writeJson(FILE, o); }

/** 今天回顾过没有 */
function reviewedToday(now = new Date()) {
  return String(readState().lastDay || '') === T.day(now);
}
function markToday(now = new Date()) {
  const s = readState();
  s.lastDay = T.day(now);
  s.lastAt = T.stamp(now);
  writeState(s);
}

/* ── 素材 ─────────────────────────────────────────────── */

/**
 * 凑今天的材料。
 * @returns {{text:string, userLines:number}}
 */
function buildMaterial(now = new Date()) {
  const turns = memory.recent(MATERIAL_TURNS);

  // 从最新往回捡，捡到够数为止，最后**正过来**（旧工程也是这么拼的）
  const lines = [];
  for (let i = turns.length - 1; i >= 0 && lines.length < MATERIAL_TURNS; i--) {
    const m = turns[i];
    const tx = String(m.content || '').replace(/[\r\n]+/g, ' ').trim();
    if (!tx) continue;
    lines.unshift(`${m.role === 'assistant' ? '你' : '他'}：${T.clip(tx, MATERIAL_LINE_MAX)}`);
  }

  const userLines = turns.filter((m) => m.role === 'user' && String(m.content || '').trim()).length;

  const parts = [];
  if (lines.length) {
    parts.push(['【今天你们聊了什么】', ...lines].join(T.CRLF));
  }

  // 作息那一段要「今天最后活动」，而那要识屏/在场那条链（还没做）——
  // 没有就不放这一段，别拿个假的糊上去。
  // ⚠️ 识屏评论那一段同理（旧工程从日志里捞「屏幕看一眼（」那些行）。

  return { text: parts.join(T.GAP).trim(), userLines };
}

/**
 * 回顾的提示词。
 * ⚠️ 格式说明**逐条照旧工程**抄的 —— 那是他一句句校过的，
 *    尤其「心事最多 1 条」「不许编」「情绪必须写原因」这几条，
 *    少一条模型就会开始编或者写成待办清单。
 */
function buildPrompt(material) {
  return [
    '一天结束了，你回头想想今天。下面是今天的材料。',
    '',
    material,
    '',
    '【按下面的格式输出，一行一条，不要别的内容】',
    '心事|档位 || 你留意到的、关于他的一点什么 || 你打算怎么不一样',
    '     档位只能填这三个：小事 / 在意 / 重要',
    '       · 小事 —— 随口一提的，明天就忘了也没关系（例子：他今天好像没睡够）',
    '       · 在意 —— 你确实放在心上的（例子：他这两天话比平时少）',
    '       · 重要 —— 一直挂着你心里的事（例子：他老是熬夜，劝了也不听）',
    '     完整例子：心事|在意 || 他这两天话比平时少 || 说话温和一点、少开玩笑',
    '★ 认错|我以为什么 || 实际是什么 || 那个问题还在吗 || 你学到什么',
    '     今天是他说清楚了你以前想岔了的事（比如你昨天以为他在熬夜，其实他人早躺下了）——',
    '     **当天没弄明白的不算**。而且「问题还在吗」一定要写：',
    '     你以为错了，不代表那件事就没了（例子：我以为他在熬夜刷视频 || 他早就躺床上了 || 还在，他今天睡到中午才起 || 屏幕亮着不等于人还在）',
    '★ 小日子|组 || 你自己今天的事',
    '     组只能填：在做 / 成了 / 没成 / 想做 / 口味 / 念想 / 外面',
    '     完整例子：小日子|没成 || 想做茶碗蒸，蛋液比例没调对，蒸出来全是蜂窝',
    '     ⚠️ **今天真的没做什么就一行都别写** —— 空着比编一条好，编的会跟你以前说的对不上',
    '情绪|高兴 / 平常 / 低落 || 为什么（例子：情绪|高兴 || 他今天主动来找我聊了三次）',
    '★ 想说|今天不想想这些',
    '     今天要是真的什么都不想说，就单独输出这一行 —— 没关系，明天再说',
    '',
    '【要求】',
    '- 心事**最多 1 条**，而且必须是你在材料里**真的看到**的 —— 看不出来就一行都别写，**不许编**；',
    '- ⚠️ 心事是"你留意到他身上的一点什么"，不是"要他做的事" —— 要让他做事的那是目标，不是心事；',
    '- 情绪**必须写原因**（高兴也要写），一句就够；',
    '- 情绪只说**你自己的感受**。可以说事实（"他今天没怎么理我"），但**不许猜他的动机**、**不许拿情绪要东西**；',
    '- 材料里没有的，一个字都不要写。',
  ].join(T.CRLF).trim();
}

/* ── 解析 ─────────────────────────────────────────────── */

/**
 * 把她的回顾结果落到数据层。
 *
 * ⚠️ 前导的 `-` `*` 和全角空格都要 TrimStart 掉 —— 模型爱加项目符号，
 *    不剥的话 `- 心事|…` 匹配不上前缀，整行白写（旧工程踩过）。
 * ⚠️ 半角 `|` 和全角 `：` 都要认（模型两种都会吐）。
 *
 * @returns {{worry:number, mood:string, mistake:number, small:number, skip:boolean, lateAsk:string}}
 */
function applyResult(text) {
  const out = { worry: 0, mood: '', mistake: 0, small: 0, skip: false, lateAsk: '' };
  const lines = String(text || '').split(/\r?\n/);

  for (const raw of lines) {
    const t = String(raw).trim().replace(/^[-*・\s　]+/, '').trim();
    if (!t) continue;

    const cut = (prefix) => t.slice(prefix).trim();
    const seg = (s) => s.split('||').map((x) => String(x).trim());

    if (t.startsWith('心事|') || t.startsWith('心事：')) {
      const p = seg(cut(3));
      let rank = '在意', about = '', effect = '';
      // ★ 新格式 `档位 || 内容 || 影响`；旧的 `内容 || 影响` 也认
      if (['小事', '在意', '重要'].includes(p[0])) {
        rank = p[0]; about = p[1] || ''; effect = p[2] || '';
      } else {
        about = p[0] || ''; effect = p[1] || '';
      }
      if (about) {
        const r = heritems.addWorry({ about, rank, effect });
        if (r.ok && !r.merged) out.worry++;
      }
    } else if (t.startsWith('情绪|') || t.startsWith('情绪：')) {
      const p = seg(cut(3));
      const r = mood.set(p[0] || '', p[1] || '', { from: '回顾' });
      if (r.ok) out.mood = p[0];
      else lastError = r.why;
    } else if (t.startsWith('认错|') || t.startsWith('认错：')) {
      const p = seg(cut(3));
      if (p[0]) {
        // ⚠️ 旧工程把「我以为」和「实际是」拼成 body 存进去的；
        //    新工程的 addMistake 收两个字段，这里分开传（格式更新了，语义一样）
        /*
         * ⚠️ 「问题还在吗」不能 `!!p[2]` —— 模型会写「还在」或者「已经没事了」，
         *    两边都是非空字符串，`!!` 会把它们判成一模一样（都算"还在"）。
         *    认否定词：说了「没 / 不在 / 已经」这类才算解决了。
         */
        const openTxt = String(p[2] || '').trim();
        const r = heritems.addMistake({
          thought: p[0], actual: p[1] || '',
          open: openTxt ? !/^(没|不|否|无|已|解决|过去|没事)/.test(openTxt) : false,
          lesson: p[3] || '',
        });
        if (r.ok) out.mistake++;
      }
    } else if (t.startsWith('小日子|') || t.startsWith('小日子：')) {
      const p = seg(cut(4));
      if (p[0] && p[1]) {
        const r = heritems.addSmall(p[0], p[1]);
        if (r.ok) out.small++;
      }
    } else if (t.startsWith('想说|') || t.startsWith('想说：')) {
      out.skip = true;
      log.info('回顾', '她今天不想想这些（她自己说的，不算错）');
    } else if (t.startsWith('晚点关|') || t.startsWith('晚点关：')) {
      out.lateAsk = cut(4);
    }
  }
  return out;
}

/* ── 那一趟请求 ───────────────────────────────────────── */

/**
 * 真去回顾一次（异步）。
 * @returns {Promise<object|null>}
 */
async function run(now = new Date()) {
  if (busy) return null;
  const c = cfg.all();
  if (!c.apiKey) { log.warn('回顾', '没有 API Key，跳过'); return null; }

  const mat = buildMaterial(now);
  if (mat.userLines < MIN_USER_LINES) {
    log.info('回顾', '今天没怎么聊过，跳过（不编，也不花这次请求）');
    return null;
  }

  busy = true;
  const t0 = Date.now();
  log.info('回顾', `开始想今天（素材 ${mat.text.length} 字）`);
  try {
    const r = await provider.chat({
      base: c.apiBase, key: c.apiKey, model: c.model,
      messages: [{ role: 'user', content: buildPrompt(mat.text) }],
      // ⚠️ 回顾**不走思考模式** —— 它不是对话，一次输出就完事，
      //    开思考只会让这一趟从十几秒变成几十秒，而且它是他不在的时候跑的，
      //    真要卡住了也没人看得见。
      thinking: false,
      temperature: c.temperature,
      thinkingStyle: c.thinkingStyle,
    });

    /*
     * ★ 这一趟也要记账。
     *   ⚠️ 不加这段的话，回顾是**唯一一笔不花钱却也不进账本**的请求 ——
     *      设置面板里的「今天花了多少」会静默少算，而且少算得不多不少、
     *      刚好看不出来（一天一次，几厘钱）。
     *      这是典型"假成功"：账本看着好好的，只是永远偏低。
     */
    const yuan = provider.cost(r.usage, { in: c.priceIn, out: c.priceOut, hit: c.priceCacheHit });
    usage.add(r.usage, yuan);

    const parsed = applyResult(r.text);

    /*
     * ★ 「晚点关」在**回顾结果里**（格式见文件头的清单），
     *   但真正决定要不要延的是自动关闭那条链 —— 所以在这儿交给它。
     *   ⚠️ 一天只认一次，而且 autoexit 是**消费式**的（延时生效一次就清标记），
     *      不然每一拍都会重新延、永远关不掉。
     */
    if (parsed.lateAsk) {
      try { autoexitMod()?.askLate(); }
      catch (err) { log.error('回顾', '处理「晚点关」时出错：' + err.message); }
    }

    log.info('回顾', `完成 · ${Date.now() - t0}ms · ` +
      `心事 ${parsed.worry} · 情绪 ${parsed.mood || '没变'} · ` +
      `认错 ${parsed.mistake} · 小日子 ${parsed.small}` +
      (parsed.skip ? ' · 她今天不想想这些' : ''));
    return parsed;
  } catch (err) {
    lastError = err.message;
    log.error('回顾', '失败：' + err.message);
    return null;
  } finally {
    busy = false;
  }
}

/* ── 五道闸（心跳每 5 秒叫一次）───────────────────────── */

/**
 * @param {number} idleMin 键鼠停了多少分钟（`heartbeat.idleMinutes()`）
 * @returns {string} 这一拍做了什么（给日志/探针看）
 */
function tick(idleMin) {
  if (cfg.get('AiEnabled') === false) return '总开关关着';

  // 请求还在飞 —— 什么都不做（旧工程也不在这里收尾，是异步自己完成的）
  if (busy) return '回顾还在跑';

  if (idleMin < 0) return '拿不到空闲时间（不判断）';

  const need = Math.max(5, Number(cfg.get('ReviewIdleMinutes')) || 55);

  // ② 他回来了 → 「准备睡」静默取消
  if (idleMin < need) {
    if (sleepMode) {
      sleepMode = false;
      log.info('回顾', '准备睡：他回来了，取消，恢复平常');
      return '他回来了，取消准备睡';
    }
    return '他还在（不动）';
  }

  // ③ 今天已经回顾过 → 只进「准备睡」
  if (reviewedToday()) {
    if (!sleepMode) {
      sleepMode = true;
      log.info('回顾', `准备睡：回顾过、键鼠停了 ${Math.round(idleMin)} 分钟，先安静等着`);
      return '今天回顾过了，进准备睡';
    }
    return '准备睡中';
  }

  // ④ 今天没聊过 → 跳过，但**照样标记**（不然每一拍都会重试）
  const mat = buildMaterial();
  if (mat.userLines < MIN_USER_LINES) {
    markToday();
    sleepMode = true;
    log.info('回顾', '今天没怎么聊过，跳过（不编，也不花这次请求）');
    return '没材料，跳过并标记';
  }

  // ⑤ 发起
  log.info('回顾', `键鼠停了 ${idleMin.toFixed(1)} 分钟（门槛 ${need}）→ 发起回顾`);
  markToday();
  sleepMode = true;
  run().catch((e) => log.error('回顾', '异步那趟出错：' + e.message));
  return '发起回顾';
}

/* ── 状态 ─────────────────────────────────────────────── */

module.exports = {
  FILE, buildMaterial, buildPrompt, applyResult, run, tick, reviewedToday,
  isSleeping: () => sleepMode,
  /**
   * ★ **只给探针用**：直接把「准备睡」掰过去 / 掰回来。
   *
   * 为什么需要：真实的进睡条件是「键鼠停够 55 分钟」，端到端等不起，
   *    而且本机 `SetThreadExecutionState` 那类"伪造用户活动"的办法实测无效
   *    （旧工程试过，见交接文档）。要在真机上验「睡着了到底还没有气泡」，
   *    就必须有个直接拨开关的口子。
   * ⚠️ 产品流程里不调它 —— 真实进出走 `tick()` 和 `wake()`。
   */
  _setSleeping(v) { sleepMode = !!v; },
  isBusy: () => busy,
  lastError: () => lastError,
  /** 她回来了（主对话那边也可以叫一声） */
  wake() { if (sleepMode) { sleepMode = false; log.info('回顾', '被叫醒，退出准备睡'); } },
  /** 自检用：只退出「准备睡」，**不碰**「今天回顾过」那条标记 */
  _wake() { sleepMode = false; },
  _reset() { busy = false; sleepMode = false; lastError = ''; writeState({}); },
  _state: () => ({ busy, sleepMode, lastError, reviewedToday: reviewedToday(), ...readState() }),
};
