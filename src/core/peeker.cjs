/**
 * 识屏 —— 隔一阵偷偷看一眼他的屏幕，然后说一句。
 *
 * ── ★★ "时间可设"是他 2026-10-13 明确要求的那一条 ─────────────
 *   `screenEveryMinutes` = 基础间隔（默认 12 分钟）。
 *   另外还有一整套（都照旧工程搬的）：
 *     · `screenMaxPerDay`      一天最多看几次（**0 = 不限** —— 旧工程拍板过：
 *                              识屏本身就有间隔，再限次数的话中午就用光了）
 *     · `screenTimeFactors`    分时段倍率：白天/晚上/深夜各一个，**乘在间隔上**
 *                              深夜默认 ×3（12 分钟变 36 分钟）—— 别那么吵
 *     · `screenShots`          一次截几张（两张内容一样只发一张，省图片钱）
 *     · `screenShotGapSeconds` 两张之间隔几秒
 *     · `screenCapture`        抓屏用哪条路（auto / desktopCapturer / gdi）
 *
 * ── 五道闸（一道都不能省）────────────────────────────────
 *   ① 开关（`screenEnabled` + 总开关）
 *   ② **他不在就别看** —— 人走了屏幕上是别人的东西 / 一堆无关画面
 *   ③ 她正忙（在说话/在想）→ 让这一轮
 *   ④ 「准备睡」挡着 → 不看
 *   ⑤ 今天看够了 → 不看（`screenMaxPerDay`，0 = 不限）
 *
 * ── 两条"不看"的额外判据（旧工程 O80 的血）────────────────
 *   · 截出来**全黑** → 多半是独占全屏游戏（或者屏幕关了）→ 跳过，**不花钱**
 *   · 跟**上一轮**的图**一模一样** → 他一直盯着同一个页面 → 跳过整轮
 *     （注意：这跟"同一次里两张一样"是两回事，那个只省第二张）
 */

'use strict';

const cfg = require('./config.cjs');
const store = require('./store.cjs');
const T = require('./text.cjs');
const capture = require('./capture.cjs');
const provider = require('./provider.cjs');
/*
 * ⚠️⚠️ **循环依赖：顶层这个引用【不能信】**（2026-10-17 修的，清单 #1）。
 *
 *    `prompt.cjs` 末尾是 `module.exports = {…}` —— **整体替换**导出对象。
 *    真实启动顺序是 index.cjs → brain.cjs → prompt.cjs → peeker.cjs：
 *    prompt 走到它第 41 行来 require 我们，我们又在这里 require 回去 ——
 *    此时 prompt 还没执行到末尾那句，**返回的是个空对象 {}**，
 *    而且绑在 `const` 上，后面永远不会自己更新。
 *
 *    后果不是「少一块提示词」，是**整条链静默死亡**：
 *    `prompt.timeBlock is not a function` 每次都抛在 buildSystem 里，
 *    被 look() 的 catch 吞掉只留一行日志 —— 而截图、前台窗口、
 *    今日次数（screenMaxPerDay）**早就都做完了**，白扣。
 *
 *    留这个顶层 require 是为了让「先加载 peeker」那条路照常走
 *    （那种顺序下 prompt 是完整的）；**用到的时候必须重新取一次**。
 *    prompt.cjs 那边早就这么干了（它的 `peekerMod()`），这里是对称的另一半。
 */
const promptTop = require('./prompt.cjs');
/** ⚠️ 循环依赖下不能信顶层那个引用 —— 每次现取 */
function promptMod() {
  try { return require('./prompt.cjs'); } catch { return promptTop || {}; }
}
const usage = require('./usage.cjs');
const markers = require('./markers.cjs');
/*
 * ★ 2026-10-20：把「这台机器看不了图」落一份状态给设置面板显示。
 *   ⚠️ looktool 不 require 我们，不构成循环（上面 prompt 那套的坑不适用于它）。
 */
const looktol = require('./looktool.cjs');
const log = require('./log.cjs');

const FILE = store.STATE + '/screen.json';

/** 「他不在」的判据：空闲超过这么多分钟就别看了 */
const AWAY_MINUTES = 30;

/** 看过的结果留多久算新鲜（超过就不带进提示词） */
const LOOK_FRESH_MS = 10 * 60 * 1000;

/** 状态标签三档 */
const WORKS = ['工作', '摸鱼', '其他'];

/* ── 注进来的东西（core 不直接 require electron / 不直接说话）── */
let say = null;          // (text, opts) => void   她怎么把话说出去
let onLook = null;       // (look) => void         记进"我说过什么"等
let thinking = null;     // () => boolean          她正忙着吗
let sleeping = null;     // () => boolean          「准备睡」挡着吗

function attach(o = {}) {
  if (typeof o.say === 'function') say = o.say;
  if (typeof o.onLook === 'function') onLook = o.onLook;
  if (typeof o.thinking === 'function') thinking = o.thinking;
  if (typeof o.sleeping === 'function') sleeping = o.sleeping;
}

/* ── 状态 ─────────────────────────────────────────────── */

function readState() {
  const v = store.readJson(FILE, null);
  return (v && typeof v === 'object') ? v : {};
}
function writeState(o) { return store.writeJson(FILE, o); }

/** 今天看了几次 */
function countToday(now = new Date()) {
  const s = readState();
  return String(s.day || '') === T.day(now) ? (Number(s.n) || 0) : 0;
}
function bumpToday(now = new Date()) {
  const s = readState();
  const today = T.day(now);
  const prev = String(s.day || '') === today ? (Number(s.n) || 0) : 0;
  s.day = today;
  s.n = prev + 1;
  writeState(s);
}

/** 下次看的时间（读盘 —— 唯一出处，跟 selftalk 一个道理） */
function nextAt() { return Number(readState().nextAt) || 0; }

/** 上一轮的图哈希（跨轮去重用） */
function lastHash() { return String(readState().lastHash || ''); }
function isSameAsLast(h) {
  const l = lastHash();
  return !!l && !!h && l === h;
}

/* ── 频率 ─────────────────────────────────────────────── */

/**
 * 时段倍率 —— 乘在**间隔**上，数越大越安静。
 * 白 1 / 晚 1 / 深夜 3（旧工程默认：深夜别那么吵）。
 * ⚠️ 夹到 [0.5, 10]：调成 0 的话间隔变 0，她会**一直**截屏；
 *    调成 1000 等于永久闭嘴。两个都不报错，所以得夹。
 */
function factor(now = new Date()) {
  if (cfg.get('screenTimeFactors') === false) return 1;
  const h = now.getHours();
  let f;
  if (h >= 23 || h < 7) f = num(cfg.get('screenNightFactor'), 3);
  else if (h >= 18) f = num(cfg.get('screenEveningFactor'), 1);
  else f = num(cfg.get('screenDayFactor'), 1);
  if (!(f > 0)) f = 1;
  return Math.max(0.5, Math.min(10, f));
}
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }

/**
 * 排下一次。
 * @returns {number} 排到什么时候（毫秒）
 */
function schedule(now = new Date()) {
  let mins = Math.round(num(cfg.get('screenEveryMinutes'), 12));
  if (mins < 1) mins = 1;                       // ⚠️ 0 会变成"每 5 秒截一次"
  const f = factor(now);
  const eff = Math.max(1, Math.round(mins * f));
  const at = now.getTime() + eff * 60000;

  const s = readState();
  s.nextAt = at;
  writeState(s);
  log.info('识屏', `下次看她屏幕安排在 ${new Date(at).toTimeString().slice(0, 8)}` +
    `（基准 ${mins} 分钟 × ${f} = ${eff} 分钟后）`);
  return at;
}

/** 重启之后接着上次的点（没排过 / 已过去太久就重排） */
function restoreSchedule(now = new Date()) {
  const v = nextAt();
  if (v > now.getTime() - 2 * 3600000) return v;
  return schedule(now);
}

/* ── 看过的结果 ───────────────────────────────────────── */

function lastLook() {
  const s = readState();
  if (!s.lastText || !s.lastAt) return null;
  if (Date.now() - Number(s.lastAt) > LOOK_FRESH_MS) return null;
  return {
    text: String(s.lastText), work: String(s.lastWork || '其他'),
    at: Number(s.lastAt), title: String(s.lastTitle || ''), proc: String(s.lastProc || ''),
  };
}

/**
 * 她说的话怎么解析。
 *
 * ⚠️ 状态标签她可能写在**开头也可能写在末尾**（旧工程两种都见过），
 *    所以两边都剥。
 * ⚠️ 认不出来的标签**不算数**（归「其他」），而且要**从正文里删掉** ——
 *    不删的话 `[别的]` 那三个字会留在气泡上给他看见。
 */
function parseLook(raw) {
  let t = String(raw || '').trim();
  let work = '其他';

  // 找所有 `[xx]`，认第一个合法的
  const all = [...t.matchAll(/[\[【]\s*(工作|摸鱼|其他)\s*[\]】]/g)];
  if (all.length) work = all[0][1];

  // 不管认不认得出，把行首/行尾那些方括号标签都剥掉（`[别的]` 也不该留在正文里）
  t = t.replace(/^\s*[\[【][^\]】]{1,6}[\]】]\s*/, '')
       .replace(/\s*[\[【][^\]】]{1,6}[\]】]\s*$/, '')
       .trim();

  return { text: t, work: WORKS.includes(work) ? work : '其他' };
}

/* ── 那一趟 ───────────────────────────────────────────── */

/**
 * 真去看一眼。
 * @returns {Promise<{ok:boolean, why:string, look:object|null}>}
 */
async function look(now = new Date()) {
  const c = cfg.all();
  if (!c.apiKey) return { ok: false, why: '还没填 API Key', look: null };

  /* ① 截屏 */
  const shot = await capture.grab(cfg.get('screenCapture'));
  if (!shot.ok) {
    log.warn('识屏', `截屏没成（${shot.method}）：${shot.why}`);
    return { ok: false, why: shot.why, look: null };
  }
  if (shot.blank) {
    /*
     * ⚠️ 全黑**不算失败**，是"这一轮没什么可看的"。
     *    旧工程说这里是"多半在独占全屏玩游戏" —— 但 2026-10-13 实测
     *    他的全屏游戏抓出来**不是黑的**，所以黑更可能是：屏幕关了、
     *    在锁屏、或者真的碰上了独占全屏。
     *    不管哪种，结论一样：**不花钱、跳过**。
     */
    log.info('识屏', `截出来是全黑的（${shot.method} ${shot.w}×${shot.h}）→ 跳过这轮，不花钱`);
    return { ok: false, why: '全黑', look: null, blank: true };
  }

  /* ② 跟他上一轮看的比 —— 一模一样就别再念一遍 */
  if (cfg.get('screenAvoidRepeat') !== false && isSameAsLast(shot.hash)) {
    log.info('识屏', '画面跟上一轮一模一样 → 跳过（他一直盯着同一页，没必要再说一遍）');
    return { ok: false, why: '画面没变', look: null, same: true };
  }

  /* ③ 前台窗口 —— 不截图也能知道他在用什么 */
  let fg = { title: '', proc: '', pid: 0, ok: false };
  if (cfg.get('screenUseForeground') !== false) {
    fg = capture.foreground();
    // ⚠️ 抓到的是**我们自己**的窗口（他在跟聊天窗打字）→ 那没什么可看的
    if (fg.ok && capture._state().ownPid && fg.pid === capture._state().ownPid) {
      log.info('识屏', '前台是我们自己的窗口 → 跳过');
      return { ok: false, why: '前台的她自己', look: null };
    }
  }

  /* ④ 问她 */
  const userText = buildUserText(fg, shot);
  const h = now.getHours();
  const key = fg.title || ((h >= 23 || h < 5) ? '深夜 熬夜 游戏' : (h < 11 ? '早上 工作' : h < 18 ? '下午 工作' : '晚上 游戏 休息'));

  let r;
  try {
    r = await provider.chat({
      /*
       * ★ 2026-10-20：**识图不再有自己的模型/地址/密钥**（三格已删）。
       *   原来这行是 `c.screenModel || c.model`，可连接还是主对话那套 ——
       *   于是填了 `kimi-k2.6` 就变成「拿 kimi 的型号去问 deepseek」，
       *   2026-10-18 那条 400 就是它。现在只剩一个模型，没有第二个可以填错。
       */
      base: c.apiBase, key: c.apiKey, model: c.model,
      messages: [
        { role: 'system', content: buildSystem(fg, key, now) },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            // ⚠️ 顺序：**文字在前、图在后** —— 反过来有些服务会挑刺
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + shot.buffer.toString('base64') } },
          ],
        },
      ],
      // ⚠️ 识屏**不走思考模式** —— 看图吐槽要快，开思考会拖到十几秒
      thinking: false,
      temperature: c.temperature,
      thinkingStyle: c.thinkingStyle,
    });
  } catch (err) {
    /*
     * ★ 2026-10-20：**「这个模型看不了图」要说清楚**。
     *   原来一律记成「问她的时候出错：…」—— 那句话在日志里跟网络抖动、
     *   被限流长得一模一样，而他关掉客户端之后**只剩这条日志可看**。
     *   （2026-10-18 那条 400 就是这么被埋了整晚的。）
     */
    if (err && err.noVision) {
      looktol.noteNoVision(err.message);
      log.error('识屏', '当前对话模型不具备视觉模块 → 这轮跳过（' + err.message + '）');
      return { ok: false, why: 'noVision', look: null };
    }
    log.error('识屏', '问她的时候出错：' + err.message);
    return { ok: false, why: err.message, look: null };
  }

  const yuan = provider.cost(r.usage, { in: c.priceIn, out: c.priceOut, hit: c.priceCacheHit });
  usage.add(r.usage, yuan);

  const parsed = markers.parse(r.text, { chain: 'screen' });
  const p = parseLook(parsed.text);
  if (!p.text) {
    log.warn('识屏', '她这次一个字都没说（可能图她看不见）');
    return { ok: false, why: '她没说话', look: null };
  }

  /* ⑤ 落状态 */
  const s = readState();
  s.lastText = p.text;
  s.lastWork = p.work;
  s.lastAt = Date.now();
  s.lastTitle = fg.title || '';
  s.lastProc = fg.proc || '';
  s.lastHash = shot.hash;               // ★ 跨轮去重要用
  writeState(s);

  const look = { text: p.text, work: p.work, at: s.lastAt, title: fg.title, proc: fg.proc };
  if (onLook) { try { onLook(look); } catch (e) { log.error('识屏', '往外报的时候出错：' + e.message); } }
  if (say) { try { say(p.text, { kind: '识屏' }); } catch (e) { log.error('识屏', '说的时候出错：' + e.message); } }

  // ★ 这一行是可验收指标：**截图多少字、她说了多少字**（不然"看没看"看不出来）
  log.info('识屏', `${shot.method} ${shot.w}×${shot.h} · ${p.work} · ` +
    `图 ${(shot.buffer.length / 1024).toFixed(0)}KB · 她说 ${p.text.length} 字：${p.text}`);
  return { ok: true, why: '', look };
}

/**
 * 她那边的**系统提示词**。
 *
 * ⚠️ 三样都不能少（旧工程三个 bug 换来的）：
 *   ① **时间块** —— 少了它她会对着一张截图瞎猜几点，
 *      说出「[11:33] 都快三点了，还不睡呀」这种鬼话
 *   ② **他最近说过什么** —— 识屏是独立请求，看不到对话上下文的话，
 *      他 13:32 说"吃了"，她 13:35 还在问"午饭是不是又糊弄过去了"
 *   ③ **她最近识屏说过什么** —— 不然同一件关心一晚能问 4 遍
 */
function buildSystem(fg, key, now) {
  const parts = [];
  /*
   * ⚠️ 这两句以前**只有 personaBlock 在 try 里**，`timeBlock` 在外头：
   *    循环依赖一发作就是它先炸，整条 buildSystem 直接挂掉（清单 #1）。
   *    现在两句都在 try 里 —— 真取不到也只是少一块，不至于让整次识屏作废。
   */
  try {
    const p = promptMod();
    parts.push(p.personaBlock());
    parts.push(p.timeBlock(now));
  } catch { /* 人格/时间坏了也不能空着走，下面还有记忆块 */ }
  try {
    const p = promptMod();
    const b = p.buildSystem({ userText: key, chain: 'screen' });
    // ⚠️ 上面那个已经含人格和时间了，这里只要**记忆那几块** ——
    //    整份塞进去会重复。做法：把人格和时间那两段从结果里去掉。
    const trimmed = b
      .replace(p.personaBlock(), '')
      .replace(p.timeBlock(now), '')
      .trim();
    if (trimmed) parts.push(trimmed);
  } catch { /* 记忆块坏了不该让整次识屏作废 */ }

  const prev = lastLook();
  if (prev) {
    parts.push([
      '【你上一次看他屏幕时说的话】',
      `- [${prev.work}] ${prev.text}`,
      '⚠️ 这些你**已经说过了** —— 别再重复同样的意思，换个角度或者说点别的。',
    ].join(T.CRLF));
  }
  return parts.filter(Boolean).join(T.GAP);
}

/** 她那边的**用户消息**（文字部分；图另外拼） */
function buildUserText(fg, shot) {
  const lines = [];
  lines.push('（偷偷看了一眼他的屏幕）先判断他在干嘛，然后在话的**末尾**加一个状态标签（原样写，别改写）：');
  lines.push('[工作] = 他在正经干活（写代码 / 改文件 / 做正事）');
  lines.push('[摸鱼] = 他在玩、打游戏、看视频、刷网页，总之不是正经活');
  lines.push('[其他] = 看不出来 / 人不在 / 屏幕黑着');
  lines.push('');
  if (fg && fg.ok && (fg.title || fg.proc)) {
    lines.push(`他现在的前台窗口：「${fg.title || '（没有标题）'}」（程序 ${fg.proc || '未知'}）`);
    lines.push('（这条是系统给的，准的 —— 拿它跟图对照着看。）');
    lines.push('');
  }
  lines.push('用不超过 40 个字，随口吐槽或关心他一句。别汇报、别描述画面（他自己看得见）。');
  lines.push('先对一遍上面的时间，别说错时段。看不出来就用 [其他]，**别编**。');
  lines.push('⚠️ 上面已经写了「他最近跟你说过什么」—— 那些你都已经知道了，**别再问一遍**。');
  void shot;
  return lines.join(T.CRLF);
}

/** 给主对话当背景的那一块 */
function buildBlock() {
  if (cfg.get('screenEnabled') === false) return '';
  const l = lastLook();
  if (!l) return '';
  const lines = [
    '【你刚看了一眼他屏幕】（这是你亲眼看到的，不是他告诉你的）',
    `他说的是：他屏幕上 —— ${l.text}（你当时判断：${l.work}）`,
  ];
  if (l.title) lines.push(`（那时候他的前台窗口是「${l.title}」）`);
  lines.push('⚠️ 这只是**背景**。他要是没提，别主动说"我刚看了你屏幕" —— 那听着像监视；'
    + '他要是问了，就用你自己的话接，别把当时那句原样重复。');
  return lines.join(T.CRLF);
}

/* ── 那一拍 ───────────────────────────────────────────── */

let busy = false;

/**
 * 「真去看一眼」那个函数。
 * ⚠️ **默认就是本文件的 `look`**，抽出这个变量**只为自检** ——
 *    `look` 要真截屏（node 里没有 desktopCapturer，永远失败），
 *    而且它异步、会把 `busy` 占住，后面的闸就测不到了。
 *    自检用 `_setLook()` 换成一个立刻返回的假函数，就能把**闸的逻辑**单独测干净。
 */
let doLook = (...a) => look(...a);

/**
 * @param {number} idleMin 键鼠停了多少分钟（拿不到是 -1）
 * @param {Date} [now]
 * @returns {string} 这一拍做了什么
 */
function tick(idleMin, now = new Date()) {
  if (cfg.get('AiEnabled') === false) return '总开关关着';
  if (cfg.get('screenEnabled') === false) return '识屏关着';
  if (busy) return '上一眼还没看完';

  const at = restoreSchedule(now);
  if (now.getTime() < at) return '还没到点';

  /*
   * ⚠️ 一到点就**先排下一次**（跟自言语一个道理）。
   *    不先排的话，被闸拦下来的那一拍排期不动 → 每一拍都还是"到点"状态，
   *    等他/她一变回可用，她会**立刻**连看好几次。
   */
  schedule(now);

  // ① 他不在 → 不看
  if (idleMin >= 0 && idleMin > AWAY_MINUTES) return '他不在（不看）';

  // ② 她正忙 → 让这一轮
  try { if (thinking && thinking()) return '她正忙'; } catch { /* 问不出来就当她闲着 */ }

  // ③ 「准备睡」挡着
  try { if (sleeping && sleeping()) return '准备睡中'; } catch { /* 同上 */ }

  // ④ 今天看够了
  const max = Math.max(0, Number(cfg.get('screenMaxPerDay')) || 0);
  if (max > 0 && countToday(now) >= max) return '今天看够了';

  // ⑤ 看
  busy = true;
  bumpToday(now);
  doLook(now)
    .catch((e) => log.error('识屏', '异步那趟出错：' + e.message))
    .finally(() => { busy = false; });
  return '看一眼';
}

module.exports = {
  FILE, AWAY_MINUTES, LOOK_FRESH_MS, WORKS,
  attach, tick, look, schedule, restoreSchedule, factor,
  parseLook, buildBlock, buildSystem, buildUserText,
  countToday, nextAt, lastLook, lastHash, isSameAsLast,
  isBusy: () => busy,
  _bumpToday: () => bumpToday(),
  /** 自检用：把"真去看一眼"换成假的（node 里没有截屏，真那个永远失败还会占住 busy） */
  _setLook(fn) { doLook = typeof fn === 'function' ? fn : ((...a) => look(...a)); },
  _setNextAt(t) { const s = readState(); s.nextAt = Number(t) || 0; writeState(s); },
  _setLastHash(h) { const s = readState(); s.lastHash = String(h || ''); writeState(s); },
  _setLastLook(o) {
    const s = readState();
    s.lastText = o.text || ''; s.lastWork = o.work || '其他';
    s.lastAt = o.at || Date.now(); s.lastTitle = o.title || ''; s.lastProc = o.proc || '';
    writeState(s);
  },
  _reset() {
    busy = false;
    doLook = (...a) => look(...a);
    say = null; onLook = null; thinking = null; sleeping = null;
    writeState({});
  },
  _state: () => ({ busy, nextAt: nextAt(), today: countToday(), ...readState() }),
};
