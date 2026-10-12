/**
 * 天气 —— 数据源：中国天气网（www.weather.com.cn / d1.weather.com.cn）
 *
 * ⚠️⚠️ 2026-10-12 实测的两条硬规矩，改这个文件之前先看：
 *
 *   ① **不带 `User-Agent` 直接 403 Forbidden**。
 *      实测（curl）：不带 UA → 403 openresty；带上一条普通浏览器 UA → 200。
 *      旧工程 `Get-WebText` 里就有 `$req.UserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'`，
 *      新工程重写的时候差点漏掉 —— 漏了就是「接口全挂」。
 *   ② **必须带 `Referer`**，否则回的是「商业合作」提示页（不是报错，是张 HTML）。
 *
 * 接口（都返回 JSONP 样式的伪 JSON，**不是**标准 JSON）：
 *   · 实时  http://d1.weather.com.cn/sk_2d/<9位ID>.html
 *   · 次日  http://d1.weather.com.cn/dingzhi/<9位ID>.html
 *   · 城市表 http://www.weather.com.cn/data/list3/city<6位码>.xml（逗号分隔的 `码|名字`）
 *
 * ⚠️ 伪 JSON 里同一个字段**可能有大小写两份**（`SD` 和 `sd` 是不同的东西：
 *    一个是湿度、一个是能见度）。所以**不能用 JSON.parse** —— 旧工程就是
 *    靠正则抠字段的（`Get-WeatherField`）。这里同理。
 *
 * ⚠️ 接口会限流（连刷几十次会被挡、返回空）。所以结果要缓存，
 *    **别删缓存逻辑** —— 缓存就是它的保护。
 */

'use strict';

const cfg = require('./config.cjs');

/* ── 常量 ───────────────────────────────────────────────── */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';
const REFERER = 'http://www.weather.com.cn/weather1d/101010100.shtml';

const T_SK = 8000;      // 实时接口超时
const T_CITY = 6000;    // 城市表超时 —— 进程刚起来第一次联网要建连接/DNS，给足
const T_DZ = 8000;

/** 城市表的内存缓存（省得反复请求被限流）。⚠️ 失败**不写**缓存，见 readTable */
const tableCache = new Map();

/** 名字 → 9 位 ID。同一个名字解析一次就够了 */
const idCache = new Map();

/** 最后一次成功拿到的结果（跑不动网络时至少还有旧的用） */
let lastGood = null;

/** 正在飞的那一次请求 —— 几处同时问只发一次 */
let inflight = null;

/* ── 底层取文本 ─────────────────────────────────────────── */

/**
 * 取一段文本。
 *
 * ⚠️ 用 `fetch` 而不是 `http.get`：Node 18+ 的 fetch 够用，而且这里
 *    只是 GET 一点点文本，没必要上更底层的东西。
 * ⚠️ **必须自己解 UTF-8** —— 中国天气网这两个接口的响应头**没有 charset**，
 *    交给浏览器/库去猜会按 Latin-1 解，中文全变乱码（旧工程踩过同一个坑）。
 */
async function getText(url, timeoutMs, { referer = REFERER } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('TIMEOUT')), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent': UA,          // ★ 不留神就 403
        'Referer': referer,        // ★ 不留神就是「商业合作」页
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      signal: ctl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    return new TextDecoder('utf-8').decode(buf);
  } catch (err) {
    if (ctl.signal.aborted) throw new Error(`等 ${timeoutMs / 1000} 秒没回话`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** 从伪 JSON 里抠一个字符串字段。找不到返回 '' */
function field(raw, name) {
  if (!raw) return '';
  // ⚠️ 字段名要做正则转义 —— 里面可能有 `(` 之类
  const m = new RegExp('"' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:\\s*"([^"]*)"').exec(raw);
  return m ? m[1] : '';
}

/* ── 城市名 → 9 位 ID ───────────────────────────────────── */

/**
 * 读 list3 的一级表。`code=''` 是省表，否则是某个上级码下面的子表。
 *
 * ⚠️ **失败不写缓存** —— 这是旧工程 2026-10-03 修过的一条：
 *    以前失败的空表也存进去，一次网络超时就让这个进程**活多久报多久**
 *    「位置没认出来」。不缓存 → 下一轮还会重试。
 */
async function readTable(code) {
  const key = String(code);
  if (tableCache.has(key)) return tableCache.get(key);

  const out = [];
  try {
    const raw = await getText(`http://www.weather.com.cn/data/list3/city${key}.xml`, T_CITY,
      { referer: 'http://www.weather.com.cn/' });
    for (const part of String(raw).split(',')) {
      const m = /^\s*(\d+)\|(.+?)\s*$/.exec(part);
      if (m) out.push({ code: m[1], name: m[2] });
    }
  } catch {
    /* 拉不到就返回空 —— 调用方会据此区分「网络问题」和「名字写错」 */
  }
  if (out.length) tableCache.set(key, out);
  return out;
}

/**
 * 在一层表里挑出「他说的那个」。
 *
 * ⚠️⚠️ 这里踩过一个特别阴的坑：**用「名字最长」挑是错的**。
 *
 *     输入 `北京市朝阳区`，区表里有 `010101|北京` 和 `010103|朝阳`。
 *     `"北京市朝阳区".includes("北京")` 和 `.includes("朝阳")` **同时成立**，
 *     两个名字都 2 个字 —— 比长度分不出高下，稳定排序下**先来的赢**，
 *     于是永远挑中「北京」，拿朝阳问也回北京。
 *     症状：**所有区都解析成市本身**，不报错，数据看着还挺正常。
 *
 *   正解看**匹配位置**：`北京` 在 index 0、`朝阳` 在 index 3 ——
 *   **出现得更靠后的那个才是他真正说的**（更靠后 = 更具体）。
 *   位置也一样时，才退回「名字更长」。
 */
function pickIn(list, text) {
  let best = null;
  for (const it of list) {
    const i = text.indexOf(it.name);
    if (i < 0) continue;
    if (!best || i > best.i || (i === best.i && it.name.length > best.it.name.length)) {
      best = { it, i };
    }
  }
  return best ? best.it : null;
}

/**
 * 6 位叶子码 → 9 位天气 ID —— **故意废掉的，永远返回空。别再试着把它补出来。**
 *
 * ⚠️⚠️⚠️ 我在这上面连栽**五**次，最后把五个候选式子一起跑才看清结论：
 *     **两张表之间根本不存在统一的换算公式**：
 *
 *     | 叶子码 | 真 ID（接口给的） | 尾段 |
 *     |---|---|---|
 *     | `250501` 郴州 | `1012505`**`01`** | 省/市：后两位**原样保留** |
 *     | `280601` 深圳 | `1012806`**`01`** | 同上 |
 *     | `010101` 北京 | `1010101`**`00`** | 直辖市：`01` → `00` |
 *     | `010103` 朝阳 | `1010103`**`00`** | 直辖市：`03` → `00`，**区号整个不进 ID** |
 *
 *     ⇒ 直辖市那一层的**区号不参与 ID**（都归到市），省/市那一层却要保留。
 *       拿一个 slice 式子去套两张表，必然「按住这头翘起那头」—— 我前五版全在这儿打转。
 *
 *   ★ 正确做法：**问接口要**，见下面的 `leafId()`。
 *     `list3/city010103.xml` 直接回 `010103|101010300` —— 权威、免费、一次就准。
 *
 *   ⚠️ 老结构说明（理解码表用，别删）：
 *     省表 `list3/city.xml` → `01|北京,02|上海,…,11|陕西,12|山东,…,25|湖南,28|广东,…`
 *     ★ **前两位是 list3 自己的顺序号，不是行政区划码** ——
 *       拿行政区划码去判会全错：`city11.xml` 回的是**陕西**（西安/咸阳/延安），不是北京。
 *     往下每一层的码 = 上一层再**接两位**，一共四层：
 *       省 `01` → 市 `0101|北京` → 区 `010101|北京,010102|海淀,010103|朝阳,…`
 *       省 `25`(湖南) → 市 `2505|郴州` → 区 `250501|…`
 *
 *   ⚠️ 走过弯路的五版（**别回头**）：
 *     ① `101 + 后6位` → 8 位，长度就不对；
 *     ② `101 + 前5位 + 0` → `010101` 碰巧对（后两位本来就是 `01`），
 *        `010103` 却出 `101010100` —— **接口照样回「北京」有数据**，不报错，最阴；
 *     ③ `101 + 前4位 + 后2位` → `010103` 出 `101010103`，接口回**空**；
 *     ④ `101 + 前2位 + 0 + 后4位` → 10 位；
 *     ⑤ 拿行政区划省码（11/12/31/50）判直辖市 → 全错，理由见上面结构说明。
 */
function toId(_leaf) {
  return '';
}

/**
 * 问接口要**权威的** 9 位天气 ID。
 *
 * 叶子码那一层的表，返回的是 `010101|101010100` —— 冒号右边直接就是天气 ID，
 * 比自己推靠谱得多（见 `toId` 上面那四个错误版本）。
 * ⚠️ 只有**叶子**才有这个形状；中间层（`0101|北京,010102|海淀`）没有。
 *   所以认不出形状就返回空，让调用方退回公式。
 */
const idByLeaf = new Map();

async function leafId(leaf) {
  const key = String(leaf);
  if (idByLeaf.has(key)) return idByLeaf.get(key);

  let id = '';
  try {
    const raw = await getText(`http://www.weather.com.cn/data/list3/city${key}.xml`, T_CITY,
      { referer: 'http://www.weather.com.cn/' });
    /*
     * `010101|101010100` 这种才是叶子 —— 右边是 **9 位天气 ID**。
     *
     * ⚠️⚠️ 这里必须卡死「9 位 **且以 101 开头**」，两个条件缺一不可。
     *    只写 `\d{9}` 会**误判中间层**：
     *      `city0101.xml` 回的是 `010101|北京,010102|海淀,010103|朝阳,…`
     *      按逗号切开之后，`010102|海淀` 的**码本身就是 6 位数字**，
     *      配上长的名字在贪婪匹配下能凑出 9 个数字 —— 于是「北京」被当成答案，
     *      拿朝阳去问也回北京。症状：**所有区都解析成同一个市**，还不报错。
     */
    for (const part of String(raw).split(',')) {
      const m = /^\s*\d+\|(101\d{6})\s*$/.exec(part);
      if (m) { id = m[1]; break; }
    }
  } catch { /* 拉不到就退回公式 */ }

  if (id) idByLeaf.set(key, id);
  return id;
}

/**
 * 把「XX省XX市XX区」这种自由文本解析成 9 位天气 ID。
 *
 * 返回 `{ ok, id, name, why }`。⚠️ 失败时 `why` 要说人话，
 * 而且要**分清「网络没拉到」和「名字写错了」** —— 旧工程 2026-10-03 专门修过：
 * 以前一律说「没认出省份（要写省名）」，其实是网络超时，把人往错处引。
 */
async function resolveCity(text) {
  const t = String(text || '').replace(/[\s　]/g, '');
  if (!t) return { ok: false, why: '没填城市' };

  // 直接给 9 位 ID 也认
  if (/^101\d{6}$/.test(t)) return { ok: true, id: t, name: t };

  const cached = idCache.get(t);
  if (cached) return { ok: true, ...cached };

  const provs = await readTable('');
  if (!provs.length) {
    return { ok: false, why: '城市表没拉到（网络问题，不是省名写错 —— 稍后会自动重试）' };
  }

  // ⚠️ 找省名用**最长匹配**：省表里有「海南」也有「海南藏族自治州」
  //    （青海的），先命中的话「青海省海南州」会被解析到海南岛去。
  const prov = pickIn(provs, t);
  if (!prov) return { ok: false, why: `没认出来「${text}」—— 要写省名，例如「湖南省郴州市」` };

  const cities = await readTable(prov.code);
  const city = pickIn(cities, t);
  if (!city) return { ok: false, why: `「${prov.name}」下面没找到这个市` };

  /*
   * ⚠️ 这里原来有一条「直辖市另算」的分支（省下面直接就是区）—— **删了**。
   *    实测四层结构是**全表统一**的：北京也有 `0101|北京` 这一层，
   *    它的下级才是 `010101|北京,010102|海淀,010103|朝阳,…`。
   *    留着那条分支只会把「北京」直接当叶子算，得到的 ID 是错的。
   */
  const dists = await readTable(city.code);
  const dist = pickIn(dists, t);
  const leaf = dist ? dist.code : city.code;
  const name = dist ? dist.name : city.name;

  /*
   * ★ 问接口要权威 ID（`010103|101010300`）。
   * ⚠️ 问不到**不再退回公式** —— 公式已废（见 toId 的长注释：两张表的对应关系
   *    不是一个算法，硬推出来的是「看着像对的」错值）。
   *    宁可**如实说没查到**，也不能拿个错 ID 去请求：错 ID 有时会**照样返回数据**
   *    （比如拿 `101010100` 问「朝阳」会回北京），那是假成功，比报错危险得多。
   */
  const id = await leafId(leaf);
  if (!id) {
    return { ok: false, why: '认出了城市，但拿不到它的天气编号（城市表没拉到，网络问题）—— 稍后会自动重试' };
  }
  const hit = { id, name };
  idCache.set(t, hit);
  return { ok: true, ...hit };
}

/* ── 拉一份完整的天气 ───────────────────────────────────── */

const W_CN = ['晴', '多云', '阴', '阵雨', '雷阵雨', '小雨', '中雨', '大雨', '暴雨',
              '雨夹雪', '小雪', '中雪', '大雪', '雾', '霾', '浮尘', '扬沙', '沙尘暴'];

/** 从实时接口那行伪 JSON 里把要用的都取出来 */
function parseSk(raw) {
  return {
    temp: field(raw, 'temp'),
    weather: field(raw, 'weather'),
    sd: field(raw, 'SD'),
    wd: field(raw, 'WD'),
    ws: field(raw, 'WS'),
    aqi: field(raw, 'aqi'),
    time: field(raw, 'time'),
    date: field(raw, 'date'),
  };
}

/** 次日接口把数据塞在 `weatherinfo` 里 */
function parseDz(raw) {
  return {
    temp: field(raw, 'temp'),
    tempn: field(raw, 'tempn'),
    weather: field(raw, 'weather'),
    wd: field(raw, 'wd'),
    ws: field(raw, 'ws'),
  };
}

/** 摄氏 → 华氏（只留一位小数） */
const toF = (c) => {
  const n = parseFloat(c);
  return Number.isFinite(n) ? (n * 9 / 5 + 32).toFixed(1) : '';
};

/**
 * 真去网上拉一份。**不做缓存判断、不做退避** —— 那些是 fetchWeather 的事。
 * @returns {{ok:boolean, data?:object, why?:string}}
 */
async function fetchNow(cityText, unit) {
  const r = await resolveCity(cityText);
  if (!r.ok) return { ok: false, why: r.why };

  const urlSk = `http://d1.weather.com.cn/sk_2d/${r.id}.html`;
  const urlDz = `http://d1.weather.com.cn/dingzhi/${r.id}.html`;

  // 两个接口各拉各的 —— 次日那个挂了不该把实时也带下来
  const [skRaw, dzRaw] = await Promise.all([
    getText(urlSk, T_SK).catch(() => ''),
    getText(urlDz, T_DZ).catch(() => ''),
  ]);

  const sk = parseSk(skRaw);
  if (!sk.temp && !sk.weather) {
    return { ok: false, why: '接口回空了（可能被限流了 —— 等几分钟再试）' };
  }

  return { ok: true, data: { id: r.id, name: r.name, sk, dz: parseDz(dzRaw), unit } };
}

/** 拼成给提示词看的一段话（也直接给她念） */
function format(d) {
  if (!d) return '';
  const { sk, dz, name } = d;
  const f = d.unit === 'f';

  const T = (c) => {
    const n = parseFloat(c);
    if (!Number.isFinite(n)) return '';
    return f ? toF(c) + '℉' : Math.round(n * 10) / 10 + '℃';
  };

  const lines = [`【${name}的天气】`];
  const head = [sk.date, sk.weather].filter(Boolean).join(' ');
  const now = [];
  if (sk.temp) now.push('现在 ' + T(sk.temp));
  if (sk.weather) now.push(sk.weather);

  if (head) lines.push(head);
  if (now.length) lines.push(now.join(' · '));
  const extra = [];
  if (sk.sd) extra.push('湿度' + sk.sd);
  if (sk.wd || sk.ws) extra.push((sk.wd || '') + (sk.ws || ''));
  if (sk.aqi) extra.push('AQI' + sk.aqi);
  if (extra.length) lines.push(extra.join(' '));

  if (dz && (dz.temp || dz.tempn)) {
    const lo = T(dz.tempn), hi = T(dz.temp);
    lines.push(`明天 ${[lo, hi].filter(Boolean).join('~')}${dz.weather ? ' ' + dz.weather : ''}`);
  }
  if (sk.time) lines.push(`（${sk.time} 观测）`);

  return lines.join('\n');
}

/* ── 带缓存 / 退避的对外入口 ─────────────────────────────── */

let nextTryAt = 0;         // 早于这个时间不再发请求（失败退避用）
let lastWhy = '';

/**
 * 拿一份天气（能等就等一下）。
 *
 * @param {object} [o]
 * @param {boolean} [o.force] 忽略退避，真去查（他主动问天气时用）
 * @returns {Promise<{ok:boolean, text:string, data:object|null, why:string, cached:boolean}>}
 */
async function fetchWeather(o = {}) {
  const c = cfg.all();
  const cityText = c.city || '';
  const unit = c.tempUnit || 'c';
  const min = Math.max(1, Number(c.weatherRefreshMin) || 20);

  if (!cityText) {
    return { ok: false, text: '', data: null, why: '还没填城市', cached: false };
  }

  // 缓存还新鲜 → 直接给旧的（接口会限流，别没事就刷）
  if (!o.force && lastGood && lastGood.city === cityText && lastGood.unit === unit
      && (Date.now() - lastGood.at) < min * 60000) {
    return { ok: true, text: lastGood.text, data: lastGood.data, why: '', cached: true };
  }

  if (!o.force && Date.now() < nextTryAt) {
    // 退避期内 —— 有旧的用旧的，没有就老实说
    if (lastGood) return { ok: true, text: lastGood.text, data: lastGood.data, why: '', cached: true };
    return { ok: false, text: '', data: null, why: lastWhy || '刚才没查到，等一会儿再试', cached: false };
  }

  // 已经有一次在飞 → 蹭它那一次，别重复发（限流就是被这么刷出来的）
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const r = await fetchNow(cityText, unit);
      if (!r.ok) {
        // ⚠️ 失败退避 5 分钟 —— 旧工程第三轮专门改的：
        //    以前失败也按天退避，一次网络抖动就让那一整天都没有天气
        nextTryAt = Date.now() + 5 * 60000;
        lastWhy = r.why;
        if (lastGood) return { ok: true, text: lastGood.text, data: lastGood.data, why: '', cached: true };
        return { ok: false, text: '', data: null, why: r.why, cached: false };
      }
      const text = format(r.data);
      lastGood = { at: Date.now(), city: cityText, unit, text, data: r.data };
      nextTryAt = Date.now() + min * 60000;   // 成功之后按刷新间隔
      lastWhy = '';
      return { ok: true, text, data: r.data, why: '', cached: false };
    } catch (err) {
      nextTryAt = Date.now() + 5 * 60000;
      lastWhy = err.message;
      if (lastGood) return { ok: true, text: lastGood.text, data: lastGood.data, why: '', cached: true };
      return { ok: false, text: '', data: null, why: err.message, cached: false };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

/** 只读缓存里那一份，**绝不发请求** —— 提示词总装走这条（不能卡住她说话） */
function cachedText() {
  const c = cfg.all();
  if (!lastGood) return '';
  if (lastGood.city !== (c.city || '')) return '';      // 城市换了，旧的不算数
  return lastGood.text;
}

/* ── 提示词那一块 ───────────────────────────────────────── */

const ASK_RE = /天气|气温|温度|下雨|会不会雨|下雪|冷|热|穿什么|带伞|空气质量|雾霾|多少度/;

/** 他这句话是不是在问天气/在聊外面 */
function isAsking(text) {
  return ASK_RE.test(String(text || ''));
}

/**
 * 提示词里的天气块。
 *
 * ⚠️ 没有缓存数据时**返回空字符串**（空块整个不出现，见 prompt.cjs 的规矩），
 *    而不是返回一句「不知道天气」—— 那会让她在完全无关的对话里
 *    莫名其妙提一句天气。
 */
function buildBlock() {
  const t = cachedText();
  if (!t) return '';
  return [
    t,
    '⚠️ 上面这份是你**已经拿到的**天气，直接用它答，别再说「我查不到」；'
    + '也不许自己编温度、编明天的天气。他没问天气就别主动往这上面扯。',
  ].join('\r\n');
}

/** 探针 / 自检用：把内部状态摊开 */
function _state() {
  return { lastGood, nextTryAt, lastWhy, tables: tableCache.size, ids: idCache.size };
}

/** 探针用：清干净（自检跑在隔离目录里，别把上一次的状态带进来） */
function _reset() {
  tableCache.clear(); idCache.clear(); idByLeaf.clear();
  lastGood = null; nextTryAt = 0; lastWhy = ''; inflight = null;
}

module.exports = {
  resolveCity, fetchNow, fetchWeather, cachedText, buildBlock, isAsking,
  format, field, toId,
  _state, _reset,
};
