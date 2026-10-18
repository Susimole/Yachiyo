/**
 * 联网 —— 她答不上来的时候，真去网上查一次。
 *
 * ── ★★ 为什么走 Anthropic 兼容端点，不走 `/responses`（2026-10-01 的教训）──
 *
 *   原来是 `/responses` + `tools=[{type:'web_search'}]`。那个内置工具类型
 *   **被服务端静默忽略** —— 照样返回 200，一次都没搜，模型拿旧知识编答案。
 *   他为此被**骗了整整一天**（实测问他，答得头头是道，全是编的）。
 *
 *   换到 `/anthropic/v1/messages` + `tools=[{type:'web_search_20250305'}]` 之后：
 *   实测 3.6 秒返回、服务端**真搜了 2 次**。
 *
 *   ⇒ **必须留一个可验收指标**：从返回里数 `server_tool_use` 块。
 *     **那个数 = 0 就说明这条链又坏了** —— 别只看"拿到 N 字"，
 *     那正是当年被骗的地方（编的答案也有 N 字）。
 *
 * ── ★ 解析只取 `type === 'text'` 的块 ─────────────────────
 *   返回里还有三种块，**一个都不能拼进来**：
 *     · `thinking`              —— 她的内心戏
 *     · `server_tool_use`       —— 她调搜索的动作
 *     · `web_search_tool_result`—— 原始搜索结果（一次 10 条）
 *   拼进去等于把内心戏和生搜索结果一起当资料交给她，她会**照着念**。
 *   （旧协议上就这么踩过坑：问世界杯冠军，真正该用的 121 字被拼成 971 字，
 *     开头全是"我们需要回答用户中文问题…"这种独白。）
 *
 * ── 什么时候查 ────────────────────────────────────────────
 *   ⚠️ **只在"他的话里明显需要新鲜信息"的时候查**。
 *     查一次要几秒 + 一次搜索费 + 几千 token，不能逢话就查。
 *     判据是关键词，保守一点 —— 宁可漏查（她会说"我查不到"），
 *     也别乱查（每句话都联网又慢又贵）。
 */

'use strict';

const cfg = require('./config.cjs');
const store = require('./store.cjs');
const T = require('./text.cjs');
const log = require('./log.cjs');

const FILE = store.STATE + '/web.json';

/** 结果留多久算"新鲜"（超过就不带进提示词了） */
const FRESH_MS = 10 * 60 * 1000;

/** 查回来的答案截到多少字 —— 不截的话一次能塞几千字进提示词，又贵又挤 */
const ANSWER_MAX = 1500;

/**
 * 「这句话要不要联网」—— **打分**，不是单个词命中就查。
 *
 * ⚠️⚠️ 为什么非打分不可（第一版就是被这个咬的）：
 *    原来写成一条大正则 `...|(最新|现在|今天|目前|...)` ——
 *    于是「**今天**吃了火锅」命中「今天」→ 去联网查了顿火锅。
 *    日常闲聊里「今天/现在/最近」出现率极高，这一类弱词**不能单独触发**。
 *
 * 规则：
 *   · 命令（"查一下"）= 4 分 —— 他直接让查，那必须查（除非有否定词）
 *   · 强信号（最新 / 多少钱 / 2026年…）= 2 分
 *   · 弱信号（今天 / 最近 / 现在 这些时间词）= 1 分，最多算**一个**
 *   · 合计 ≥ 2 才查
 *   ⇒ 「今天的新闻」= 1+2 ✓
 *     「今天吃了火锅」= 1 ✗
 *     「查一下三体」= 4 ✓
 */
const RE_COMMAND = /(搜一下|搜下|搜搜|查一下|查查|百度一下|谷歌一下|上网查|网上查|帮我查|帮我搜)/;
const RE_STRONG = [
  /(最新|近期|这几天|近况)/,
  /(新闻|头条|发布会|进展|动态|发生了什么)/,
  /(多少钱|什么价|价格|股价|汇率|票房|排名|评分|冠军|比赛结果|战绩)/,
  /(什么时候(出|发|上|开)|发布了没|出了没|上线了没|定了没)/,
  /(20\d{2}\s*年)/,
  /(是谁|哪一家|哪个公司|哪个队|哪位)/,
  /*
   * ★ 事实型提问（2026-10-13 补）。
   *   漏了这一类，他问「今年……放假时长是**多少**」只拿到 1 分（只有"今年"这个弱词）
   *   → 够不到门槛 → **压根没去查** → 她只能推测着答。
   *   他要的正是这种"政策文件里写死的事实"，而模型不知道 2026 年的安排。
   */
  /(是多少|是几|有多少|多少号|多少天|几天|多久|多长时间|是哪|哪个时候)/,
];
/**
 * ⚠️ 弱信号：**最多只算一个**，不然「今天 现在 最近」凑一块就够 2 分了。
 *
 * ★ 但**带时间词 + 是个疑问句** → 额外 +1（见 `score`）。
 *   理由：「今天/今年」开头还带疑问词的，绝大多数在问**当下的事实**，
 *   而那正是模型答不准、最需要查的一类。
 *   例：「今年……假期时长是多少」= 弱 1 + 疑问 1 = 2 ✓
 *       「今天吃了火锅」= 弱 1（没疑问词）✗
 */
const RE_WEAK = /(今天|昨天|现在|目前|当前|最近|今年|这个月|这周)/;

/**
 * ★ 疑问句的尾巴。
 * ⚠️ 只在**带弱信号**的时候才算分 —— 单看疑问词会把所有问句都拉去联网。
 * ⚠️ 必须锚在**句尾附近**（`$`）：`这是为什么呢？因为…` 那种长解释句不算。
 *    判据是"这句就问这一件事"，不是"句子里有个问号"。
 */
const RE_QUESTION = /(是多少|是几|哪些|什么|多少|怎么|多久|哪一?个?|吗)$/;

/**
 * ⚠️ **否定词要先看**：「别查了」「不用搜」不能触发。
 *    旧工程为这个专门写过一条（`Test-AiAskSong` 里那个 `(不|别|不用|不要|先别)` 前缀）。
 * ⚠️ 判据要掐在"查"字附近，不能整句扫 ——
 *    「别吵我，等会儿再查」里的「别」离「查」很远，那是同意查，不是别查。
 */
const NO_RE = /(别|不用|不要|先别|不必|无需|懒得)\s*(去)?\s*(搜|查|联网|上网|百度|谷歌)/;

/** 打分（探针/自检要能看出为什么） */
function score(text) {
  const t = String(text || '').trim();
  if (!t) return { total: 0, hit: [] };
  const hit = [];
  if (RE_COMMAND.test(t)) hit.push(['命令', 4]);
  for (const re of RE_STRONG) if (re.test(t)) { hit.push(['强', 2]); break; }

  const weak = RE_WEAK.test(t);
  if (weak) hit.push(['弱(时间词)', 1]);
  /*
   * ★ 时间词 + 句尾疑问 → 再 +1。
   *   这一条是 2026-10-13 为他那句「今年……时长是多少」补的 ——
   *   那句话只命中"今年"（1 分），够不到门槛，所以她**没查**，只能推测。
   */
  if (weak && RE_QUESTION.test(t.replace(/[。！!？?\s]+$/, ''))) hit.push(['疑问', 1]);

  return { total: hit.reduce((s, x) => s + x[1], 0), hit: hit.map((x) => `${x[0]}+${x[1]}`) };
}

function shouldSearch(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (NO_RE.test(t)) return false;      // ⚠️ 否定优先，要在打分**之前**

  /*
   * ⚠️⚠️ 三道闸要在这儿就过（2026-10-16 加的）。
   *
   *    `index.cjs` 是**先调 `shouldSearch()`、再去冒「我查一下…」**的 ——
   *    而开关 / key / 每日上限原来只在 `search()` 里面才判 ⇒
   *    他把联网关掉了，界面上照样先弹一句「我查一下…」，
   *    然后 `search()` 才回一句"联网关着"，前后矛盾。
   *    实测：webEnabled=false、没 key、上限已满 —— 三种情况 `shouldSearch` 全返回 true。
   */
  if (cfg.get('webEnabled') === false) return false;
  if (!cfg.get('apiKey')) return false;
  const max = Number(cfg.get('webMaxPerDay')) || 0;
  if (max > 0 && todayUses() >= max) return false;

  return score(t).total >= 2;
}

/** 今天搜过几次（跨天自动归零 —— 口径跟 `search()` 里写计数那段一致） */
function todayUses() {
  const s = readState();
  return String(s.day || '') === T.day(new Date()) ? (Number(s.n) || 0) : 0;
}

/* ── 当日计数 ─────────────────────────────────────────── */

function readState() {
  const v = store.readJson(FILE, null);
  return (v && typeof v === 'object') ? v : {};
}
function writeState(o) { return store.writeJson(FILE, o); }

/** 今天查了几次 */
function countToday(now = new Date()) {
  const s = readState();
  return String(s.day || '') === T.day(now) ? (Number(s.n) || 0) : 0;
}

/** 最近一次查回来的东西（过了保鲜期就当没有） */
function last() {
  const s = readState();
  if (!s.answer || !s.at) return null;
  if (Date.now() - Number(s.at) > FRESH_MS) return null;
  return { q: s.q || '', answer: s.answer, at: Number(s.at), uses: Number(s.uses) || 0 };
}

/* ── 端点 ─────────────────────────────────────────────── */

/** 联网的地址：配置优先，没配就按接口地址拼 */
function url() {
  const explicit = String(cfg.get('webApiUrl') || '').trim();
  if (explicit) return explicit;
  const base = String(cfg.get('apiBase') || '').trim().replace(/\/+$/, '');
  return base ? `${base}/anthropic/v1/messages` : '';
}

/**
 * 从返回里数「服务端真搜了几次」。
 *
 * ★★ 这是这条链**唯一的可验收指标**。
 *    返回 200 不等于真搜了 —— 当年 /responses 就是返回 200 但一次没搜。
 */
function countUses(json) {
  try {
    /*
     * ★★ **优先用服务端自己给的那个数**（2026-10-13 打真接口发现的）：
     *      `usage.server_tool_use.web_search_requests`
     *    实测 DeepSeek 会回这个字段（值 2 = 真搜了 2 次）。
     *    它比"数块"准 —— 数块会把「一次搜索」算成两个（tool_use + result），
     *    而且块的数量跟"搜了几次"并不总是一对一。
     *    ⚠️ 老服务 / 别的兼容端点可能不给这个字段，那就退回去数块。
     */
    const official = json && json.usage && json.usage.server_tool_use
                  && json.usage.server_tool_use.web_search_requests;
    if (Number.isFinite(Number(official)) && Number(official) > 0) return Number(official);

    const blocks = json && json.content;
    if (!Array.isArray(blocks)) return 0;
    // 退回数块：只数 tool_use（result 是它的回声，不另算一次）
    return blocks.filter((b) => b && b.type === 'server_tool_use').length;
  } catch { return 0; }
}

/** 只取 `type === 'text'` 的块 —— 别的三种块一个都不能拼进来（原因见文件头） */
function pickText(json) {
  try {
    const blocks = json && json.content;
    if (!Array.isArray(blocks)) return '';
    return blocks
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('')
      .trim();
  } catch { return ''; }
}

/**
 * 真去查一次。
 *
 * ⚠️ **非流式**。Anthropic 那条链要等它搜完再答，流式反而更难处理超时。
 *    旧工程实测 3.6 秒返回，20 秒有 5 倍余量。
 *
 * @returns {Promise<{ok:boolean, answer:string, uses:number, ms:number, why:string}>}
 */
async function search(query) {
  const c = cfg.all();
  const bad = (why) => ({ ok: false, answer: '', uses: 0, ms: 0, why });

  if (cfg.get('webEnabled') === false) return bad('联网关着');
  if (!c.apiKey) return bad('还没填 API Key');

  const u = url();
  if (!u) return bad('没有接口地址');

  const max = Math.max(0, Number(cfg.get('webMaxPerDay')) || 0);
  if (max > 0 && countToday() >= max) return bad(`今天已经查过 ${max} 次了`);

  const maxUses = Math.max(1, Number(cfg.get('webMaxUses')) || 3);
  const maxTok = Math.max(200, Number(cfg.get('webMaxOutputTokens')) || 1500);
  const timeoutSec = Math.max(5, Number(cfg.get('webTimeoutSeconds')) || 20);

  const body = {
    model: c.model,
    max_tokens: maxTok,
    messages: [{ role: 'user', content: String(query) }],
    // ⚠️ `web_search_20250305` 是这个端点认的类型名。
    //    写成别的（比如 OpenAI 那套 `{type:'web_search'}`）会被**静默忽略**。
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxUses }],
  };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('TIMEOUT')), timeoutSec * 1000);
  const t0 = Date.now();

  try {
    const res = await fetch(u, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // ⚠️ Anthropic 那套用的是 `x-api-key` 头 + `anthropic-version`，
        //    不是 `Authorization: Bearer`。DeepSeek 的兼容端点两套都收，
        //    但照 Anthropic 的规矩发最稳。
        'x-api-key': c.apiKey,
        'anthropic-version': '2023-06-01',
        Authorization: `Bearer ${c.apiKey}`,
        'User-Agent': 'YachiyoAI/1.0',
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });

    const text = await res.text();
    if (!res.ok) {
      return bad(`端点回了 ${res.status}：${text.slice(0, 160)}`);
    }

    let json;
    try { json = JSON.parse(text); }
    catch { return bad('回来的不是 JSON：' + text.slice(0, 120)); }

    const uses = countUses(json);
    const answer = pickText(json);
    const ms = Date.now() - t0;

    /*
     * ★★ 两个都要判：
     *    · `uses === 0` → **服务端压根没搜**，答案很可能是编的（当年就是这么骗的）
     *    · `answer` 空 → 搜了但没答出来
     *    ⚠️ `uses === 0` **不算成功** —— 哪怕 answer 有一大段。
     */
    if (!uses) {
      log.warn('联网', `⚠️ 服务端一次都没搜（${ms}ms）—— 这个答案可能是编的，不采用`);
      return { ok: false, answer: '', uses: 0, ms, why: '服务端一次都没搜（答案不可信）' };
    }
    if (!answer) {
      log.warn('联网', `搜了 ${uses} 次但没给答案（${ms}ms）`);
      return { ok: false, answer: '', uses, ms, why: '搜了但没答出来' };
    }

    const trimmed = answer.length > ANSWER_MAX
      ? answer.slice(0, ANSWER_MAX) + '…（太长，截住了）'
      : answer;

    /*
     * ⚠️ 当日计数：**先拿旧值判断是不是同一天，再覆盖 s.day**。
     *    第一版写成 `s.day = today; s.n = (s.day === today ? ...)` ——
     *    自己跟自己比，永远成立，于是计数**从来不会归零**（跨天也不清）。
     */
    const s = readState();
    const today = T.day(new Date());
    const prev = String(s.day || '') === today ? (Number(s.n) || 0) : 0;
    s.day = today;
    s.n = prev + 1;
    s.q = String(query).slice(0, 120);
    s.answer = trimmed;
    s.at = Date.now();
    s.uses = uses;
    writeState(s);

    // ★ 这一行是可验收指标 —— 数**搜了几次**，不是"拿到几个字"
    log.info('联网', `查到了 · ${ms}ms · 服务端搜了 ${uses} 次 · ${trimmed.length} 字 · 「${s.q}」`);
    return { ok: true, answer: trimmed, uses, ms, why: '' };

  } catch (err) {
    const ms = Date.now() - t0;
    if (err.name === 'AbortError' || ctl.signal.aborted) {
      log.warn('联网', `${timeoutSec} 秒还没回来，断了`);
      return { ok: false, answer: '', uses: 0, ms, why: `等超时了（${timeoutSec} 秒）` };
    }
    log.error('联网', '出错：' + err.message);
    return { ok: false, answer: '', uses: 0, ms, why: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/* ── 进提示词 ─────────────────────────────────────────── */

/**
 * 刚查到的那一段，给主对话当背景资料。
 *
 * ⚠️ 说清楚这是**查来的**，而且**用自己的话说** ——
 *    不这么说她会把搜索结果整个念一遍（模型看到"资料"就爱照抄）。
 */
function buildBlock() {
  if (cfg.get('webEnabled') === false) return '';
  const l = last();
  if (!l) return '';
  return [
    '【你刚上网查到的】（这是他问的事，你真的去查过了）',
    `他问的是：${l.q}`,
    l.answer,
    /*
     * ⚠️⚠️ 这两条要求**必须写死**。实测查回来的原文是**一整张 markdown 表格**
     *    （1161 字，带 `|` 竖线）。不说清楚的话她会照着念 ——
     *    而他问"今年放假几天"，要的是**一句话**，不是一张表糊在他屏幕上。
     */
    '⚠️ 上面这份是**查来的资料**，不是你要说的话。规矩：',
    '- **用你自己的话讲**，别整段照念、**别贴表格**（尤其那些 `|` 竖线，一个字都别抄下来）；',
    '- 他问多少就答多少。问「放假几天」就答那几天最重要的（比如春节哪天到哪天、共几天），'
    + '**别把七个节日全念一遍**；他要是想听全部，会再问；',
    '- 他要是没问起就别主动提；查不到的部分就说查不到，**别补**。',
  ].join(T.CRLF);
}

module.exports = {
  FILE, FRESH_MS, ANSWER_MAX,
  shouldSearch, score, url, countUses, pickText, search, buildBlock,
  last, countToday,
  _reset() { writeState({}); },
  _state: () => ({ ...readState(), today: countToday() }),
};
