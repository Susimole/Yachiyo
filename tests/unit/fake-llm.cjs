/**
 * 假的模型服务 —— **只给自检用**。
 *
 * 他还没填 API Key，可对话链不能因此就没法验。
 * 这个服务在本机起一个 HTTP，回跟 DeepSeek 同格式的 SSE，
 * 内容是固定的几句话，按他发来的关键词挑。
 *
 * 跑法：node scripts/fake-llm.cjs [端口]
 * 自检会自己把它拉起来，跑完关掉。
 *
 * ⚠️ 它**故意会**：把收到的请求体存下来（自检要验参数发对没有）、
 *    按关键词回不同的句子、带上 usage。
 * ⚠️ 它**不会**：真的调用任何外部服务。断网也能跑。
 */

'use strict';

const http = require('node:http');

const PORT = Number(process.argv[2] || 8788);

/** 自检要看的：最后一次收到的请求体 */
let lastRequest = null;
let calls = 0;

/** 按关键词挑一句话 —— 让自检能验「她确实读到了我发的东西」 */
function pickReply(text) {
  const t = String(text || '');
  /*
   * ★ 回顾链（第 4 步①）—— 假模型得认得出「回顾的提示词」，
   *   回她该回的那几行格式。不认的话，探针只能验到「请求发出去了」，
   *   验不到「回来的东西真的落进了心事 / 情绪 / 认错 / 小日子」。
   *   ⚠️ 认的是提示词第一句，不是关键词 —— 这句是 review.cjs 写死的。
   */
  if (/一天结束了，你回头想想今天/.test(t)) {
    /*
     * ⚠️ 这几行的**长度**是照数据层的门槛凑的，别随手改短：
     *    心事 ≥3 字、认错「我以为」≥2 字 且 两者拼起来 ≥4 字、小日子 ≥3 字。
     *    凑短了落不了库，探针会红，而红的原因看着像"回顾链坏了"。
     */
    return [
      '心事|在意 || 他昨晚又说到两点还没睡 || 别催，就说一句我先去躺一会儿',
      '情绪|高兴 || 他今天回来还惦记着跟我说一句',
      '认错|我以为他今晚又要熬到很晚 || 他十一点就关了机 || 没了，这周都挺规律 || 屏幕亮着不等于人还在',
      '小日子|成了 || 把昨天想做的那碗茶碗蒸又试了一遍，这次蛋液比例对了',
    ].join('\n');
  }
  /*
   * ★ 自言语（第 4 步②）—— 她那一侧的文本是**场景**不是对话，
   *    所以认的是场景里那句独有的话（`selftalk.context()` 写死的）。
   *   ⚠️ 回一句**不像对话回复**的：自言语是自言自语，不是答话。
   */
  if (/这是你自己想开口/.test(t)) return '忽然想吃松饼了，等会儿要是没事就去弄一份。';
  if (/报数|数个数|几个字/.test(t)) return '一二三，数完啦。';
  if (/你好|在吗|hello/i.test(t)) return '在的在的，怎么啦？';
  if (/几点|时间/.test(t)) return '我看看表…嗯，是时候该干活了吧。';
  if (/超长/.test(t)) return '长'.repeat(240);
  /*
   * ★ 3c 的情绪标记 —— 假模型也得会吐，不然「她打了标记 →
   *   程序剥掉 → 心情落盘」这条链**端到端验不了**（只能单独测解析函数，
   *   那验不到 brain.js 有没有真的接上）。
   */
  if (/高兴一下|心情好|夸夸你/.test(t)) return '[心情 好]\n被你夸得有点飘，嘿嘿。';
  if (/难过一下|心情差|难受/.test(t)) return '【心情 差】\n今天有点闷，说不上来。';
  return '嗯，我听着呢。你接着说。';
}

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = http.createServer((req, res) => {
  // 自检要拿它验「参数发对了没有」
  if (req.url === '/__last') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ calls, last: lastRequest }));
    return;
  }
  if (req.url === '/__reset') {
    lastRequest = null; calls = 0;
    res.writeHead(200); res.end('ok');
    return;
  }

  /*
   * 「检测模型」那条路 —— GET /models。
   * 跟真服务一样认 Bearer Key，Key 不对就 401，这样自检能验
   * 「没填 Key 时那个按钮要说人话」。
   *
   * ⚠️ 故意**不**记录到 lastRequest：它不算一次「对话请求」，
   *    记进去的话自检里「用量记账」「多轮上下文」那些断言会被它搅乱。
   */
  if (req.url.endsWith('/models')) {
    if (!/^Bearer \S+/.test(req.headers.authorization || '')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid_api_key' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [
      { id: 'deepseek-flash',    object: 'model', owned_by: 'fake' },
      { id: 'deepseek-chat',     object: 'model', owned_by: 'fake' },
      { id: 'deepseek-reasoner', object: 'model', owned_by: 'fake' },
      { id: 'zzz-not-in-config', object: 'model', owned_by: 'fake' },
    ] }));
    return;
  }

  if (!req.url.endsWith('/chat/completions')) {
    res.writeHead(404); res.end('not found'); return;
  }

  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body); } catch { /* 记原样 */ }
    calls++;
    lastRequest = { headers: req.headers, body: parsed, raw: body.slice(0, 4000) };

    // 没带 Key 就当 401 —— 验「Key 传没传」用得上
    if (!/^Bearer \S+/.test(req.headers.authorization || '')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid_api_key' } }));
      return;
    }

    const userMsg = [...(parsed.messages || [])].reverse().find((m) => m.role === 'user');
    const reply = pickReply(userMsg?.content);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    // 一小段一小段吐，模拟流式 —— 整段一次吐出来的话，
    // 页面那边「边收边显示」有没有 bug 就验不出来了
    const chunks = reply.match(/.{1,3}/gs) || [''];
    let i = 0;
    const timer = setInterval(() => {
      if (i < chunks.length) {
        sse(res, {
          choices: [{ index: 0, delta: { content: chunks[i] }, finish_reason: null }],
        });
        i++;
        return;
      }
      // 最后一块带 finish_reason + usage（跟真服务一样）
      clearInterval(timer);
      sse(res, {
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 12,
          total_tokens: 132,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 40,
        },
      });
      res.write('data: [DONE]\n\n');
      res.end();
    }, 12);

    // ⚠️ 这里必须挂 res 不能挂 req。
    //    Node 里 req 的 'close' 表示「请求体读完了」，不是「连接断了」——
    //    挂 req 上的话，请求一读完就把定时器清掉，流永远发不完，
    //    对面一直等，症状是「她的气泡卡在正在说，一个字都不出」。
    res.on('close', () => clearInterval(timer));
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-llm] 起来了 http://127.0.0.1:${PORT}`);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT',  () => server.close(() => process.exit(0)));
