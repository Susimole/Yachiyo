/**
 * 模型调用层 —— 现在只接 DeepSeek 一路（OpenAI 兼容格式）。
 *
 * ⚠️ 这个模块**只能在主进程里跑**：API Key 不能进渲染进程。
 *    页面那边只拿得到「配没配 Key」这一个布尔值。
 *
 * ⚠️⚠️ 请求体是**照着旧工程实测能跑的那套**写的，别自己发明：
 *   · model = "deepseek-flash"
 *   · 思考开：`thinking:{type:"enabled"}` + `reasoning_effort:"low|medium|high"`
 *     —— **这个模式下 temperature 不生效，旧工程干脆不发**
 *   · 思考关：`thinking:{type:"disabled"}` + `temperature`
 *     （出处：旧工程 `模型.ps1` 的 `New-AiRequestBody`，2026-10-11 核对）
 *
 *   我一开始按自己的印象写成 `deepseek-reasoner` + 照常发 temperature —— 那是错的。
 */

'use strict';

/** 空闲超时：多久没动静就断（不是总时长）。
 *  ⚠️ 思考模型首字要等 20~40 秒是常事，用「总超时」会把它误杀；
 *     要盯的是「连接活着但一个字都不来」。旧工程也是这个口径（ReadWriteTimeout）。 */
const IDLE_MS = Number(process.env.YACHIYO_IDLE_MS || 30000);
/** 总时长兜底，防止对面挤牙膏挤一辈子 */
const TOTAL_MS = 300000;
/** 重试次数（硬错不重试） */
const RETRIES = 2;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 服务端错误 → 说人话，并标出这错「重试有用吗」。
 * 他把 Key 填错了、余额没了，看到「HTTP 402」是没用的，而且重试三次只是更慢。
 */
function explain(status, body) {
  let detail = '';
  try {
    detail = JSON.parse(body)?.error?.message || '';
  } catch {
    detail = String(body || '').replace(/\s+/g, ' ').slice(0, 200);
  }
  const tail = detail ? `（${detail}）` : '';
  const hard = /invalid_api_key|insufficient|authentication|invalid_request/i.test(detail);

  switch (status) {
    case 400: return { msg: `请求格式不对${tail}`, hard: true };
    case 401: return { msg: `API Key 不对或者过期了${tail}`, hard: true };
    case 402: return { msg: `账户余额不够了${tail}`, hard: true };
    case 403: return { msg: `这个 Key 没有调这个模型的权限${tail}`, hard: true };
    case 422: return { msg: `参数有问题${tail}`, hard: true };
    case 429: return { msg: `问得太密了，被限流，缓一下再试${tail}`, hard };
    case 500: case 502: case 503: case 504:
      return { msg: `对面服务器抽风了，等会儿再试${tail}`, hard: false };
    default:
      return { msg: `请求失败（HTTP ${status}）${tail}`, hard };
  }
}

/** 把 SSE 的一条 data: 行解析出来；不是 JSON 就返回 null */
function parseChunk(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try { return JSON.parse(payload); } catch { return null; }
}

/** 按配置拼请求体 —— 这是唯一一处决定「发什么参数」的地方 */
function buildBody(o) {
  const body = {
    model: o.model,
    messages: o.messages,
    stream: true,
    stream_options: { include_usage: true },   // 不开这个，流式回来的 usage 是 null
  };

  /*
   * ⚠️⚠️ `thinking` / `reasoning_effort` 是 **DeepSeek 自己的字段**，
   *    不是 OpenAI 接口的一部分。
   *
   *    他 2026-10-12 报的：「接口地址貌似强绑定 DeepSeek，我用其他的地址
   *    检测到模型但不可用」。那次主要是 ping 里写死了模型名（见
   *    main/index.cjs 的 ai:ping），但**把 DeepSeek 私有字段往别家发**
   *    是同一个毛病的另一半 —— 严一点的服务直接 400，
   *    宽松一点的也会因为它而选错推理路径。
   *
   *    所以加一档开关 `thinkingStyle`：
   *      · 'auto'（默认）= 地址里带 deepseek 就当它是 DeepSeek，否则**不发**这两个字段
   *      · 'deepseek'    = 强制发（中转站、自建反代但后端是 DeepSeek 时用）
   *      · 'off'         = 永远不发
   */
  /*
   * ⚠️⚠️ 默认是 `always`，**不是** auto —— 这是被自检逼回来的。
   *
   *    我第一版把默认写成 auto（地址里带 deepseek 才发）。结果自检里
   *    「带 thinking 参数 / 带 reasoning_effort / 思考模式下不发 temperature」
   *    三条当场红了 —— 因为自检用的假服务地址是 127.0.0.1，不含 deepseek。
   *    这三条红得有道理：**他明明开着「思考模式」，程序却自作主张不发了**，
   *    而他从头到尾没要求过这件事。
   *
   *    他报的 404（model 'deepseek-reasoner' not found）根因是**模型名写死**，
   *    跟 thinking 这个字段没关系 —— 那一处单独修了（见 main/index.cjs 的 ai:ping）。
   *    OpenAI 兼容的服务对**不认识的字段**基本都是忽略，不会因此报错。
   *
   *    ⇒ 默认保持改动之前的行为（一直发），auto / off 摆在那儿给
   *      「对面真的会因为这两个字段 400」的人用。
   */
  const style = o.thinkingStyle || 'always';
  const sendDS = style === 'always'
    || (style === 'auto' && /deepseek/i.test(String(o.base || '')));

  if (sendDS) {
    if (o.thinking) {
      body.thinking = { type: 'enabled' };
      body.reasoning_effort = o.reasoningEffort || 'low';
      // ⚠️ 这里**故意不发 temperature** —— 思考模式下它不生效（旧工程同款）
    } else {
      body.thinking = { type: 'disabled' };
      if (typeof o.temperature === 'number') body.temperature = o.temperature;
    }
  } else {
    // 不按 DeepSeek 那套发：thinking / reasoning_effort 一个都不带，温度照发
    if (typeof o.temperature === 'number') body.temperature = o.temperature;
  }
  return body;
}

/** 发一次（不重试）。onDelta 只在这一层被调。 */
async function once(o) {
  const url = `${String(o.base || '').replace(/\/+$/, '')}/chat/completions`;
  const ctl = new AbortController();

  let idle = null;
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctl.abort(new Error('IDLE')), IDLE_MS);
  };
  const total = setTimeout(() => ctl.abort(new Error('TOTAL')), TOTAL_MS);
  armIdle();
  if (o.signal) o.signal.addEventListener('abort', () => ctl.abort(new Error('USER')), { once: true });

  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${o.key}`,
        'User-Agent': 'YachiyoAI/1.0',
      },
      body: JSON.stringify(buildBody(o)),
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(total); clearTimeout(idle);
    if (err.name === 'AbortError' || ctl.signal.aborted) {
      const why = ctl.signal.reason?.message;
      if (why === 'IDLE') throw Object.assign(new Error(`她 ${IDLE_MS / 1000} 秒没说出一个字，断了`), { hard: false });
      if (why === 'USER') throw Object.assign(new Error('取消了'), { hard: true });
      throw Object.assign(new Error('她想了太久还没回'), { hard: false });
    }
    throw Object.assign(
      new Error(`连不上 ${o.base} —— 检查网络，或者接口地址写错了`), { hard: false });
  }

  if (!res.ok) {
    clearTimeout(total); clearTimeout(idle);
    const text = await res.text().catch(() => '');
    const e = explain(res.status, text);
    throw Object.assign(new Error(e.msg), { hard: e.hard, status: res.status });
  }

  // ---- 读 SSE ----
  let text = '';
  let reasoning = '';
  let usage = null;
  let buf = '';
  let firstMs = null;
  let emitted = false;
  let truncated = false;

  try {
    for await (const piece of res.body) {
      armIdle();
      buf += Buffer.from(piece).toString('utf8');

      // ⚠️ 按【空行】切事件，不能按 \n 切 —— 内容里可能带换行，
      //    按行切会把一段话拆成好几条半截 JSON。
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const rawEvent = buf.slice(0, idx);
        buf = buf.slice(idx + 2);

        for (const line of rawEvent.split('\n')) {
          const obj = parseChunk(line.trim());
          if (!obj) continue;
          if (obj.usage) usage = obj.usage;

          const choice = obj.choices?.[0];
          const delta = choice?.delta;
          if (delta?.reasoning_content) reasoning += delta.reasoning_content;
          if (delta?.content) {
            if (firstMs === null) firstMs = Date.now() - t0;
            text += delta.content;
            emitted = true;
            o.onDelta?.(delta.content);
          }
          // finish_reason=length 表示被 max_tokens 截断了 —— 记下来，别当成说完了
          if (choice?.finish_reason === 'length') truncated = true;
        }
      }
    }
  } catch (err) {
    if (ctl.signal.aborted) {
      const why = ctl.signal.reason?.message;
      if (why !== 'USER') {
        // 已经吐过字的就别重试了（重试会把说过的再说一遍）
        throw Object.assign(new Error(`她说了半句就断了（${why === 'IDLE' ? '卡住了' : '超时'}）`),
          { hard: emitted, partial: text });
      }
    }
    throw err;
  } finally {
    clearTimeout(total); clearTimeout(idle);
  }

  if (!text) throw Object.assign(new Error('她一个字都没回 —— 可能是模型名写错了'), { hard: true });

  return { text, reasoning, usage, ms: Date.now() - t0, firstMs, truncated };
}

/**
 * 跟她说一句话，边收边把新出来的字交给 onDelta。带退避重试。
 *
 * @param {object} o
 * @param {string} o.base            接口地址，末尾不带 /
 * @param {string} o.key             API Key
 * @param {string} o.model           模型 id
 * @param {Array}  o.messages        [{role, content}, ...]
 * @param {boolean} o.thinking       走不走思考模式
 * @param {string} [o.reasoningEffort] low | medium | high
 * @param {number} [o.temperature]   思考模式下会被忽略
 * @param {function} [o.onDelta]     (text) => void
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<object>}
 */
async function chat(o) {
  if (!o.key) throw new Error('还没填 API Key —— 右键菜单 → API 接入');

  let lastErr = null;
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    try {
      return await once(o);
    } catch (err) {
      lastErr = err;
      // 硬错（Key 不对 / 余额没了 / 已经吐了半句）重试没用，直接抛
      if (err.hard || attempt === RETRIES) throw err;
      // 退避：第一次等 1.5 秒，最后一次等 3 秒（跟旧工程一个节奏）
      await sleep(attempt === 0 ? 1500 : 3000);
    }
  }
  throw lastErr;
}

/**
 * 用量 → 钱。单位是「元 / 百万 token」。
 *
 * ⚠️ DeepSeek 把输入分成【缓存命中】和【未命中】两笔算，单价差 4 倍。
 *    只按 prompt_tokens × priceIn 算会把缓存命中的那些多算一遍。
 */
function cost(usage, price) {
  if (!usage) return 0;
  const p = { in: 2, out: 8, hit: 0.5, ...(price || {}) };
  const hit  = usage.prompt_cache_hit_tokens  || 0;
  const miss = usage.prompt_cache_miss_tokens || (usage.prompt_tokens || 0) - hit;
  return (
    (miss / 1e6) * p.in +
    (hit  / 1e6) * p.hit +
    ((usage.completion_tokens || 0) / 1e6) * p.out
  );
}

/** 设置面板的「测试连接」—— 拿真 key 问一句最短的，验通了才算数 */
async function ping(o) {
  return chat({
    ...o,
    messages: [{ role: 'user', content: '回一个字：好' }],
  });
}

/* ============================================================
   模型清单
   ============================================================ */

/** 列清单不用等太久 —— 它就是个 GET，不像生成那样要思考 */
const LIST_MS = 15000;

/**
 * 问接口地址「你有哪些模型」。
 *
 * 他 2026-10-12 要的：「模型接入那里选择模型项需要有一个检测模型按钮，
 * 目的是检测地址关联的模型以及可用性」。
 *
 * `GET {base}/models` 是 OpenAI 兼容端点的标配（DeepSeek 也有），
 * **不计费、不消耗 token** —— 拿它来验「地址 + Key 通不通、这个地址到底
 * 有哪些模型」是最划算的一步。比起「发一句话看它回不回」，它还能顺带
 * 告诉我们**模型名写对没有**。
 *
 * @returns {Promise<{url:string, ids:string[]}>}
 * @throws {Error} 出错时 message 是人话
 */
async function listModels(o) {
  const url = `${String(o.base || '').replace(/\/+$/, '')}/models`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('TIMEOUT')), LIST_MS);

  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${o.key}`,
        'User-Agent': 'YachiyoAI/1.0',
      },
      signal: ctl.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (ctl.signal.aborted) {
      throw new Error(`${LIST_MS / 1000} 秒没回话 —— 地址写错了，或者网络不通`);
    }
    throw new Error(`连不上 ${o.base} —— 检查网络，或者接口地址写错了`);
  }
  clearTimeout(timer);

  const text = await res.text().catch(() => '');

  if (!res.ok) {
    /*
     * ⚠️ 404 单独说清楚。
     *    不是所有服务都实现了 /models（自建的一堆没有）。这时候**不代表
     *    地址是坏的** —— 只是问不出来。别把它报成「连接失败」吓他。
     */
    if (res.status === 404) {
      throw Object.assign(
        new Error('这个地址没有 /models 接口 —— 不是所有服务都提供模型清单，'
                + '不代表地址写错了，用「测试连接」验更直接'),
        { noList: true, status: 404 });
    }
    const e = explain(res.status, text);
    throw Object.assign(new Error(e.msg), { status: res.status, hard: e.hard });
  }

  let data = null;
  try { data = JSON.parse(text); } catch {
    throw new Error('地址回的不是 JSON —— 多半是个网页，不是模型接口');
  }

  // 三种常见形状都认：{data:[{id}]} / [{id}] / {models:[...]}
  const arr = Array.isArray(data) ? data : (data.data || data.models || []);
  const ids = [];
  for (const m of (Array.isArray(arr) ? arr : [])) {
    const id = typeof m === 'string' ? m : (m && (m.id || m.name || m.model));
    if (id) ids.push(String(id));
  }

  return { url, ids: [...new Set(ids)].sort() };
}

module.exports = { chat, cost, ping, listModels, buildBody, IDLE_MS, RETRIES };
