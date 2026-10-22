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

/**
 * 读**错误响应体**最多等多久（2026-10-17 加的，清单 #40）。
 *
 * 对面发了错误码、body 却发一半就挂着 —— 那就别等它：
 * 错误信息是「有更好、没有也能报」，不值得为它把整条对话链僵住。
 */
const ERROR_BODY_MS = 4000;

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

  /*
   * ★★ 2026-10-20：认出「这个模型看不了图」（`noVision`）。
   *
   *   背景：他 2026-10-20 拍板删掉「识图地址 / 密钥 / 模型」三格，
   *   识图从此**只用对话模型**。代价是：换成没有视觉的模型，她就真瞎了，
   *   而且**没有任何字段能提前问出来**（没有 `supports_vision` 这种东西）。
   *   唯一能知道的办法就是**真发一次被拒** —— 所以这里给它单独标一个标记，
   *   由 `looktool` 换成那句「当前对话模型不具备视觉模块」。
   *
   *   ⚠️ **只认 4xx**。5xx / 网络错不是"没视觉"，混进去就等于给了个假结论
   *      （偶发故障被说成"你这模型看不了图"）。
   *   ⚠️ 这条**认不出"收了图但瞎说"** —— 实测 `deepseek-v4-pro` 不报错，
   *      问它屏幕上什么颜色，它答「未知」。那种只能靠 look.log 里
   *      `via=chat` 但描述空/离谱看出来。
   */
  const noVision = status >= 400 && status < 500
    && /image|vision|multimodal|content[\s_-]*type|modality/i.test(detail);

  switch (status) {
    case 400: return { msg: `请求格式不对${tail}`, hard: true, noVision };
    case 401: return { msg: `API Key 不对或者过期了${tail}`, hard: true };
    case 402: return { msg: `账户余额不够了${tail}`, hard: true };
    case 403: return { msg: `这个 Key 没有调这个模型的权限${tail}`, hard: true };
    case 422: return { msg: `参数有问题${tail}`, hard: true, noVision };
    case 429: return { msg: `问得太密了，被限流，缓一下再试${tail}`, hard };
    case 500: case 502: case 503: case 504:
      return { msg: `对面服务器抽风了，等会儿再试${tail}`, hard: false };
    default: {
      /*
       * ⚠️ **除 429 外的 4xx 一律硬错**（2026-10-17 修的，清单 #34）。
       *
       *   改前这里只把 `hard` 交给上面那条正则（看 detail 里有没有
       *   invalid_api_key / insufficient / …）。于是 404「模型名写错」、
       *   405、413 这些**重试一百次也没用**的错被判成软错误
       *   → 白重试三次、白等 4.5 秒才把报错给他。
       *   实测改前：404 / 405 / 413 各发 3 次请求，耗时 4525 / 4517 / 4534 ms
       *   （对照：400 只要 27 ms）。
       *
       *   更糟的是**不稳定**：同一个 404 硬不硬，取决于**对面怎么措辞** ——
       *   要是它的 message 里恰好带 "invalid_request"，才会被判成硬错。
       *
       *   5xx 仍然软错（对面抽风，重试有意义）；429 上面单独一档。
       */
      const is4xx = status >= 400 && status < 500;
      return { msg: `请求失败（HTTP ${status}）${tail}`, hard: is4xx || hard, noVision };
    }
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
   * ★ 工具调用（2026-10-17 加的，方案「乙」的底座）。
   *   ⚠️ **没有 tools 就一个字都别加** —— 往不支持 `tools` 的服务端塞空数组/空字段，
   *      严一点的中转站会直接 400（这跟 `thinking` 那个坑是同一类）。
   */
  if (Array.isArray(o.tools) && o.tools.length) {
    body.tools = o.tools;
    body.tool_choice = o.toolChoice || 'auto';
  }

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
  /*
   * ⚠️ 传进来的 signal 可能**已经是 aborted 的**（2026-10-17 修的，清单 #4）。
   *    重试时就会走到这里：第一次中止之后 chat() 又发了一次，而那个 signal 早中止了。
   *    而 `addEventListener` 挂在**已中止**的 signal 上**永远不会触发** ⇒
   *    第二次请求根本没人能停 —— 他点了「停止」，她还在往下说。
   *    ⇒ 入口先查一眼：已经停了就**一个请求都别发**。
   */
  if (o.signal) {
    if (o.signal.aborted) {
      clearTimeout(total); clearTimeout(idle);
      ctl.abort(new Error('USER'));
      throw Object.assign(new Error('取消了'), { hard: true });
    }
    o.signal.addEventListener('abort', () => ctl.abort(new Error('USER')), { once: true });
  }

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
    /*
     * ⚠️⚠️ **读错误体也必须受超时管着**（2026-10-17 修的，清单 #40）。
     *
     *   改前是先 `clearTimeout(total); clearTimeout(idle);` **再** `await res.text()` ——
     *   于是碰上「对面回了 500、声明了 Content-Length、body 却发一半然后挂着」
     *   这种情况，两个定时器**都已经没了** ⇒ 这个 await 永远不返回，
     *   整条对话链就僵在那儿（只剩 undici 自己几百秒的兜底）。
     *   实测改前（本机）：正常那一路 2.99 秒就断，错误这一路挂满 12 秒还没结束。
     *
     *   ⇒ 读错误体单独限时；超了就用**已经收到的那截**（通常是空的）。
     *      顺序也调过来：**先读完 body，再清定时器**。
     */
    const bodyText = await Promise.race([
      res.text().catch(() => ''),
      new Promise((r) => setTimeout(() => r(''), ERROR_BODY_MS)),
    ]);
    clearTimeout(total); clearTimeout(idle);
    const e = explain(res.status, bodyText);
    throw Object.assign(new Error(e.msg), { hard: e.hard, status: res.status, noVision: e.noVision });
  }

  // ---- 读 SSE ----
  let text = '';
  let reasoning = '';
  let usage = null;
  let buf = '';
  let firstMs = null;
  let emitted = false;
  let truncated = false;
  let rawBytes = 0;      // 收了多少字节 —— 报错时说人话用
  /*
   * ★ 工具调用（2026-10-17 加的，方案「乙」的底座）。
   *   ⚠️ 流式里它是**分片**来的，必须按 `index` 攒（`args` 是字符串要拼，不能覆盖）——
   *      详见下面处理 `delta.tool_calls` 那段注释。
   */
  const toolCalls = [];
  let sawToolFinish = false;
  /*
   * ⚠️ 判「对面到底是不是 SSE」要数 **`data:` 行的条数**，不能数事件边界。
   *    因为结尾那截「没带空行的尾巴」也会被当成一条事件处理 ——
   *    拿它当判据的话，对面回一坨 JSON 也会被算成「认出了一条事件」，
   *    于是又报回那句误导人的「模型名写错了」。
   */
  let dataLines = 0;

  /*
   * ⚠️⚠️ 解码必须是**流式**的（2026-10-14 修的）。
   *
   *    原来是每块单独 `Buffer.from(piece).toString('utf8')`。
   *    一个中文字 3 字节 —— 正好被切在两个 chunk 中间时，
   *    前半截和后半截**各自都解不出字**，那个字会变成 3 个 U+FFFD。
   *
   *    实测（`留痕\工具脚本\repro-sse.cjs`，本地假服务端）：
   *      喂 `"你好世界再见"`、在第 10 个字节处断开
   *      期望 `"你好世[界]再见"` → 实得 `"你好世���再见"`（3 个 U+FFFD）
   *
   *    ⚠️ 这个是**静默**的：不报错、不断线，他看着像「模型抽风吐乱码」，
   *       压根不会怀疑到解析层。
   *
   *    `{ stream: true }` 会把最后那几个**不完整的字节留在解码器里**，
   *    等下一块到了接着拼 —— 这才是 TextDecoder 的正确用法。
   */
  const dec = new TextDecoder('utf-8');

  /*
   * ⚠️ 事件分隔符 = **空行**，但行尾有三种写法。
   *
   *    SSE 规范允许 LF / CRLF / CR，原来只认 `\n\n`。
   *    对面要是用 `\r\n\r\n`，`indexOf('\n\n')` **永远找不到**
   *    （`\r\n\r\n` 这四字节里根本没有 `\n\n`）⇒ buf 一直涨、
   *    一条事件都认不出、最后 `!text` 那条报错说「模型名写错了」——
   *    **报错方向还是错的**。实测复现过，一发作就是「一个字都没回」。
   */
  const SEP = /\r\n\r\n|\n\n|\r\r/;

  /**
   * 吃掉一条事件里所有的 data: 行。
   *
   * ⚠️ 拆行的写法必须跟上面那个 `SEP` **对齐**（2026-10-17 修的，清单 #41）。
   *    改前是按 `\n` 拆，可 SEP 是认 `\r\r` 的（老式 Mac 换行）——
   *    于是「事件之间用 \r\r 分、事件内部几行 data: 也用 \r 分」那种流，
   *    几行会被**粘成一行**，parseChunk 解不出来 → 整条静默丢光，
   *    最后报回那句误导人的「模型名写错了」。
   *    实测改前：两行 data: 分别带 "AA" / "BB"，一个字节都没认出来。
   *    ⚠️ 但要注意：**单行** data: + `\r\r` 分隔本来就是好的，
   *       别把「`\r\r` 分隔符坏了」当成结论去改 SEP。
   */
  const eatEvent = (rawEvent) => {
    for (const raw of rawEvent.split(/\r\n|\r|\n/)) {
      const line = raw.trim();
      if (line.startsWith('data:')) dataLines++;
      const obj = parseChunk(line);
      if (!obj) continue;
      if (obj.usage) usage = obj.usage;

      /*
       * ⚠️⚠️ **SSE 里的 error 事件不能吞**（2026-10-17 修的，清单 #35）。
       *
       *   服务端把失败也放在流里发：`data: {"error":{"message":"…"}}`。
       *   改前这里只读 usage / choices，error 字段一个字都不看 ⇒
       *     · 一个字都没吐过 ⇒ 最后报「她一个字都没回 —— 可能是模型名写错了」，
       *       把「余额不够」说成「模型名错」，他照着去查模型名，查不出来；
       *     · 已经吐了半句 ⇒ **当成成功返回**，那半句被当成她说完了
       *       （连 truncated 都不标，界面也看不出来）。
       *   实测改前：前者误报模型名；后者 text="前半句" 且一路成功返回。
       *
       *   判硬错 —— 对面明确说了失败，重试大概率还是失败；带上它的原话。
       */
      if (obj.error) {
        const e = obj.error;
        const detail = typeof e === 'string' ? e : (e.message || e.type || JSON.stringify(e));
        throw Object.assign(new Error(`对面报错了：${detail}`), { hard: true, partial: text });
      }

      const choice = obj.choices?.[0];
      const delta = choice?.delta;
      if (delta?.reasoning_content) reasoning += delta.reasoning_content;
      if (delta?.content) {
        if (firstMs === null) firstMs = Date.now() - t0;
        text += delta.content;
        emitted = true;
        o.onDelta?.(delta.content);
      }
      /*
       * ★ 工具调用（2026-10-17 加的，方案「乙」的底座）。
       *
       *   ⚠️⚠️ 流式里的 `tool_calls` 是**分片**来的：同一轮可能先来
       *      `{index:0, id:'call_x', function:{name:'look_screen', arguments:''}}`，
       *      然后一堆 `{index:0, function:{arguments:'{"a"'}}`、`'":1}'` ……
       *      ⇒ 必须**按 index 攒**，`arguments` 是字符串要**拼**，别覆盖。
       *      （这是"一次请求就能用工具"的代价：比非流式难写一点。）
       *   ⚠️ `id` / `name` 只会在**第一片**里出现，后面几片可能没有 ⇒ 有就覆盖、没有就留着。
       */
      if (Array.isArray(delta?.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = Number.isInteger(tc.index) ? tc.index : 0;
          if (!toolCalls[i]) toolCalls[i] = { id: '', name: '', args: '' };
          const slot = toolCalls[i];
          if (tc.id) slot.id = String(tc.id);
          if (tc.function?.name) slot.name = String(tc.function.name);
          if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments;
          emitted = true;                     // 只调工具不说话，也算"她开口了"，别让上层当成哑了
        }
      }
      // finish_reason=length 表示被 max_tokens 截断了 —— 记下来，别当成说完了
      if (choice?.finish_reason === 'length') truncated = true;
      if (choice?.finish_reason === 'tool_calls') sawToolFinish = true;
    }
  };

  try {
    for await (const piece of res.body) {
      armIdle();
      rawBytes += piece.length || 0;
      buf += dec.decode(piece, { stream: true });

      // ⚠️ 按【空行】切事件，不能按 \n 切 —— 内容里可能带换行，
      //    按行切会把一段话拆成好几条半截 JSON。
      let m;
      while ((m = SEP.exec(buf)) !== null) {
        const rawEvent = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        eatEvent(rawEvent);
      }
    }

    /*
     * ⚠️ 流断了要**把尾巴吃干净**（2026-10-14 补的）。
     *    · `dec.decode()` 不带参数 = 把解码器里剩的字节冲出来
     *    · 有些服务端最后一条事件**后面不带空行** —— 原来 buf 里那份直接扔了，
     *      最后半句就这么没了，而且一声不响。
     */
    buf += dec.decode();
    const tail = buf.trim();
    if (tail) eatEvent(tail);
  } catch (err) {
    /*
     * ⚠️⚠️ 流走到这一步才炸的，全在这里收口（2026-10-17 修的，清单 #4 #5）。
     *
     *   改前**只有**「signal 被中止、且原因不是 USER」那一支会标 hard，
     *   另外两种最常见的失败都掉进 `throw err`（没带 hard）→ 被当成软错误重试：
     *
     *     #4 他点「停止」→ why === 'USER' → 跳过 if → 1.5 秒后又发一次请求，
     *        而重试那次挂的是已中止的 signal、没人能停 ⇒ 回复照样说完。
     *        实测改前：服务端收到 2 次请求、chat() 返回完整文本、多吐 24 次 onDelta。
     *     #5 流到一半 socket 断了 → 根本没进 abort 分支 → 同样重试 ⇒
     *        气泡里的话重放一遍。实测改前：请求 3 次、气泡 "PARTIAL-PARTIAL-PARTIAL-"。
     *
     *   现在的规矩（跟上面同步请求那条路对齐）：
     *     · **已经吐过字**（emitted）⇒ 硬错。重试只会让她把话说第二遍。
     *     · **他主动停的**（USER）⇒ 硬错。停就是停。
     *     · 其余（卡住 / 超时 / 断流，且没吐过字）⇒ 软错，交给上面 chat() 重试。
     */
    /*
     * ⚠️ **里面已经判过性的错误原样放行**（2026-10-17）——
     *    「SSE 里的 error 事件」是对面**明确报出来的失败**（清单 #35），
     *    在这儿重新包装会把它改写成「她说了半句就断了（网络断了）」，
     *    把真正的原因（余额不够 / 参数不对）盖掉。
     */
    if (err.hard === true) throw err;

    const why = ctl.signal.aborted ? (ctl.signal.reason?.message || 'ABORT') : '';
    const stopped = why === 'USER';

    if (stopped) {
      throw Object.assign(new Error('取消了'), { hard: true, partial: text });
    }
    if (emitted) {
      const what = why === 'IDLE' ? '卡住了' : why ? '超时' : '网络断了';
      throw Object.assign(new Error(`她说了半句就断了（${what}）`), { hard: true, partial: text });
    }
    // 没吐过字、也不是他停的 —— 值得再试一次；顺手把底层报错翻成人话
    throw Object.assign(new Error(`她没说完就断了（${err.message || String(err)}）`), { hard: false });
  } finally {
    clearTimeout(total); clearTimeout(idle);
  }

  /*
   * ⚠️ 空回复要**分清是哪一种**（2026-10-14 加的）。
   *
   *   原来只有一句话「可能是模型名写错了」—— 可 CRLF 那种情况里，
   *   模型名一个字都没错，错的是**分隔符**。他照着这句话去查模型名，
   *   查一辈子也查不出来。**误导性的报错比没有报错还费时间。**
   */
  /*
   * ★★ 2026-10-20：**只有 tool_calls、没有正文，是正常的**，不是失败。
   *
   *   他 2026-10-20 报「用 deepseek-flash 在对话里引导识图仍旧失败」。
   *   实测：说「看看我屏幕」，模型正确地调了 `look_screen`，`finish_reason`
   *   就是 `tool_calls`，**正文一个字都没有** —— 而这里把"没正文"一律当硬错抛掉：
   *     她一个字都没回 —— 可能是模型名写错了
   *   ⇒ `brain.cjs` 的 catch 把刚 push 的那句话撤回、整轮报错，
   *      工具循环**一步都没走到**，`look.log` 里自然一次都不会出现。
   *      （这解释了为什么 2026-10-17 加的工具到现在从没真跑过。）
   *
   *   ⚠️ 所以判据要改成「没正文**而且**没工具调用」才算没回话。
   */
  const hasToolCall = toolCalls.filter(Boolean).length > 0;
  if (!text && !hasToolCall) {
    if (rawBytes > 0 && dataLines === 0) {
      throw Object.assign(
        new Error(`对面回了 ${rawBytes} 字节，一条 SSE 事件都没认出来 —— 接口可能不是 SSE，或者分隔符不是空行`),
        { hard: true });
    }
    throw Object.assign(new Error('她一个字都没回 —— 可能是模型名写错了'), { hard: true });
  }

  return {
    text,
    reasoning,
    usage,
    ms: Date.now() - t0,
    firstMs,
    truncated,
    /*
     * ★ 模型要用工具（方案「乙」）。
     *   空数组 = 这轮没调工具；非空 = 上层要执行完、把结果塞回 messages 再问一次。
     *   ⚠️ `args` 是**原始 JSON 字符串**（流式拼起来的），由调用方 `JSON.parse` ——
     *      别在这儿解析：解析失败要由调用方决定"报错还是当空参数"，那属于业务判断。
     */
    toolCalls: toolCalls.filter(Boolean).map((t) => ({ id: t.id, name: t.name, args: t.args })),
    /** 服务端明确说"这一轮就是去调工具的"（`finish_reason === 'tool_calls'`） */
    toolFinish: sawToolFinish,
  };
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
/**
 * 列清单不用等太久 —— 它就是个 GET，不像生成那样要思考。
 * ⚠️ 2026-10-22：加了个 env 钩子（只在自检里用）—— 真要等 15 秒才验得出
 *    "body 卡住"那种超时，测试跑不动。日常没人设它，就是 15000。
 */
const LIST_MS = Number(process.env.YACHIYO_LIST_MS || 15000);

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

  /*
   * ★★ 2026-10-21 修（外部审查 YCH-004 · 确定复现）：
   *
   *    原来这一行 `clearTimeout(timer)` 在**读 body 之前** —— 意思是
   *    "头回来了就算通了"。可 `res.text()` 也要吃网络：服务端完全可能
   *    头照发、body 迟迟不来（被限流 / 中间设备扣着 / 服务端自己卡住）。
   *    那时候这个 timer 已经清掉了 ⇒ **没有任何超时** ⇒
   *    `listModels()` 永远 pending，设置页那颗「检测模型」一直转圈，
   *    上层 IPC 也跟着挂住（只能重启客户端）。
   *
   *    ⇒ 改法：① timer 留到 body 读完再清；② 另外再挂一个**只管 body** 的超时，
   *      读超了照样 abort（reader 会被打断，`res.text()` 抛 AbortError）。
   *      两个都留着不会互相干扰：先到先算。
   */
  let text = '';
  try {
    text = await res.text();
  } catch (err) {
    clearTimeout(timer);
    if (ctl.signal.aborted) {
      throw new Error(`${LIST_MS / 1000} 秒内没把响应读完 —— 地址通了但响应卡住了`);
    }
    throw new Error('响应读到一半断了 —— 网络不稳，或者服务端中途关掉了连接');
  }
  clearTimeout(timer);

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

/*
 * ⚠️ `explain` 也导出（2026-10-17 加的）—— 它是个**纯函数**
 *    （状态码 + 响应体 → 人话 + 该不该重试那一条判断），导出没有任何副作用。
 *    自检要直接量它（selfcheck-p0 的「错误分档」那几条）；
 *    不导出的话只能起假端点绕一大圈，还测不到 405/413 这种边角状态码。
 */
module.exports = { chat, cost, ping, listModels, buildBody, explain, IDLE_MS, RETRIES };
