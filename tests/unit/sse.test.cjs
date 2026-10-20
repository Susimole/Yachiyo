/**
 * 自检 · SSE 解析（第 10 套）
 *
 * 为什么要单独一套：`core/provider.cjs` 的 SSE 读取**一直是没测过的**。
 * `scripts/fake-llm.cjs` 只回标准 LF、而且**一次写完不拆块** ——
 * 真实网络里那两种情况一个都碰不到，所以下面这两个 bug 活了很久：
 *
 *   ① **分块劈开中文**：一个中文字 3 字节，正好切在两个 chunk 之间时，
 *      前半截后半截各自都解不出字 ⇒ 那个字变成 3 个 U+FFFD。
 *      **静默**——不报错，他看着像"模型抽风吐乱码"。
 *   ② **CRLF 分隔**：只按 `\n\n` 切事件，对面用 `\r\n\r\n` 就一条都认不出，
 *      最后报「她一个字都没回 —— 可能是模型名写错了」——**报错方向还是错的**。
 *
 * 这里起一个**本地假服务端**（不连外网、不花钱），喂真 `provider.cjs`。
 * 跑在隔离目录里（`YACHIYO_HOME`）。
 *
 * 跑法：node scripts/selfcheck-sse.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const STARTED = Date.now();
const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.join(ROOT, '_selfcheck-home-sse');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.YACHIYO_HOME = HOME;

const provider = require(path.join(ROOT, 'src/core/provider.cjs'));

const out = [];
const chk = (name, ok, detail) => {
  out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail != null ? '  —— ' + detail : ''}`);
};

/* ══════════ 假服务端 ══════════ */

const LF = '\n\n';
const CRLF = '\r\n\r\n';
const CR = '\r\r';

/** 一条 SSE 事件的字节（行尾统一用 \r\n，跟真服务端一样） */
function evt(obj, sep) {
  return Buffer.from(`data: ${JSON.stringify(obj)}\r\n${sep}`, 'utf8');
}
/** 纯文本事件（`data: [DONE]` 这种） */
function rawEvt(text, sep) {
  return Buffer.from(`data: ${text}\r\n${sep}`, 'utf8');
}
function delta(content) {
  return { choices: [{ delta: { content } }] };
}

/**
 * @param {Buffer[]} chunks 按顺序写出去的分块（每块之间隔 25ms）
 * @param {string} [contentType]
 */
function serve(chunks, contentType = 'text/event-stream') {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    let i = 0;
    const next = () => {
      if (i >= chunks.length) { res.end(); return; }
      res.write(chunks[i++]);
      setTimeout(next, 25);
    };
    next();
  });
}

/** 把一个 Buffer 从第 n 个字节处切成两块 */
const cut = (buf, n) => [buf.subarray(0, n), buf.subarray(n)];

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}

/** 喂一次，拿结果。不抛 —— 错误也当结果返回 */
async function feed(chunks, opts = {}) {
  const server = serve(chunks, opts.contentType);
  const port = await listen(server);
  const got = [];
  try {
    const res = await provider.chat({
      base: `http://127.0.0.1:${port}`,
      key: 'dummy',
      model: 'mock',
      messages: [{ role: 'user', content: 'hi' }],
      onDelta: (t) => got.push(t),
    });
    return { ok: true, ...res, streamed: got.join('') };
  } catch (err) {
    return { ok: false, error: err.message, streamed: got.join('') };
  } finally {
    server.close();
  }
}

(async () => {
  /* ══════════ ① 分隔符 ══════════ */
  console.log('\n【分隔符：LF / CRLF / CR 都要认】');

  const r1 = await feed([evt(delta('你好'), LF), rawEvt('[DONE]', LF)]);
  chk('LF 分隔', r1.ok && r1.text === '你好', r1.ok ? r1.text : r1.error);

  const r2 = await feed([evt(delta('你好'), CRLF), rawEvt('[DONE]', CRLF)]);
  chk('★ CRLF 分隔（修复前：一个字都没回）', r2.ok && r2.text === '你好', r2.ok ? r2.text : r2.error);

  const r3 = await feed([evt(delta('你好'), CR), rawEvt('[DONE]', CR)]);
  chk('★ CR 单独分隔', r3.ok && r3.text === '你好', r3.ok ? r3.text : r3.error);

  const r4 = await feed([
    evt(delta('甲'), LF), evt(delta('乙'), CRLF), evt(delta('丙'), CR), rawEvt('[DONE]', LF),
  ]);
  chk('三种分隔符混着用', r4.ok && r4.text === '甲乙丙', r4.ok ? r4.text : r4.error);

  /* ══════════ ② 分块 ══════════ */
  console.log('\n【分块：多字节字符被劈在 chunk 边界上】');

  const CN = '你好世界再见';
  const cnBuf = evt(delta(CN), LF);
  // 正文从哪里开始：`data: {"choices":[{"delta":{"content":"` 之后的第 1 个字节
  const head = cnBuf.indexOf(Buffer.from(CN, 'utf8'));
  const pieces = cut(cnBuf, head + 10);            // 前 9 字节 = 3 个整字，第 10 字节劈开第 4 个字
  const r5 = await feed([pieces[0], pieces[1], rawEvt('[DONE]', LF)]);
  chk('★ 中文被劈在两个 chunk 之间（修复前：变成 U+FFFD）',
    r5.ok && r5.text === CN,
    r5.ok ? `${r5.text}${r5.text.includes('\uFFFD') ? ' ← 有替换符！' : ''}` : r5.error);

  const EMOJI = '好了🎉🎉';                        // 4 字节字符
  const emBuf = evt(delta(EMOJI), LF);
  const emHead = emBuf.indexOf(Buffer.from(EMOJI, 'utf8'));
  const em = cut(emBuf, emHead + 6);              // 3 + 劈开第 1 个 emoji（4 字节）
  const r6 = await feed([em[0], em[1], rawEvt('[DONE]', LF)]);
  chk('★ 4 字节 emoji 被劈开', r6.ok && r6.text === EMOJI, r6.ok ? r6.text : r6.error);

  // 逐字节喂 —— 最狠的一种
  const one = evt(delta('逐字节'), LF);
  const bytewise = [];
  for (let i = 0; i < one.length; i++) bytewise.push(one.subarray(i, i + 1));
  const r7 = await feed([...bytewise, rawEvt('[DONE]', LF)]);
  chk('★ 整条事件按单字节喂（最狠）', r7.ok && r7.text === '逐字节', r7.ok ? r7.text : r7.error);

  /* ══════════ ③ 尾巴 ══════════ */
  console.log('\n【流结尾的尾巴】');

  const r8 = await feed([evt(delta('没有空行结尾'), LF).subarray(0, evt(delta('没有空行结尾'), LF).length - 2)]);
  chk('★ 最后一条事件后面没有空行（修复前：整条丢掉）',
    r8.ok && r8.text === '没有空行结尾', r8.ok ? r8.text : r8.error);

  const r9 = await feed([evt(delta('半句'), LF), Buffer.from('data: {"choices":[{"delta":{"content":"没说完",', 'utf8')]);
  chk('尾巴是半截 JSON → 不该炸，前面那半句要留住',
    r9.ok && r9.text === '半句', r9.ok ? r9.text : r9.error);

  /* ══════════ ④ 其它字段 ══════════ */
  console.log('\n【顺带要保住的老功能】');

  const r10 = await feed([
    evt({ choices: [{ delta: { reasoning_content: '想一下' } }] }, LF),
    evt(delta('答案是 42'), LF),
    evt({ usage: { prompt_tokens: 10, completion_tokens: 5 } }, LF),
    rawEvt('[DONE]', LF),
  ]);
  chk('正文与 reasoning 分开收', r10.ok && r10.text === '答案是 42' && r10.reasoning === '想一下',
    r10.ok ? `text=${r10.text} reasoning=${r10.reasoning}` : r10.error);
  chk('usage 收得到', r10.ok && r10.usage && r10.usage.completion_tokens === 5,
    r10.ok ? JSON.stringify(r10.usage) : r10.error);
  chk('onDelta 流式回调和最终正文一致', r10.ok && r10.streamed === r10.text,
    r10.ok ? JSON.stringify(r10.streamed) : r10.error);
  chk('firstMs 有值（首字耗时）', r10.ok && typeof r10.firstMs === 'number', r10.ok ? r10.firstMs : r10.error);

  const r11 = await feed([
    evt(delta('被截断了'), LF),
    evt({ choices: [{ delta: {}, finish_reason: 'length' }] }, LF),
  ]);
  chk('finish_reason=length → truncated 标记', r11.ok && r11.truncated === true,
    r11.ok ? String(r11.truncated) : r11.error);

  /* ══════════ ⑤ 报错要说人话 ══════════ */
  console.log('\n【空回复时的报错方向】');

  const r12 = await feed([Buffer.from('{"error":"这不是 SSE，是一坨 JSON"}', 'utf8')], 'application/json');
  chk('★ 回了字节但一条事件都认不出 → 要说「不是 SSE」，不能说「模型名写错了」',
    !r12.ok && /不是 SSE|分隔符/.test(r12.error), r12.ok ? r12.text : r12.error);

  const r13 = await feed([rawEvt('[DONE]', LF)]);
  chk('只回了 [DONE]、真的没内容 → 保留原来的说法',
    !r13.ok && /一个字都没回/.test(r13.error), r13.ok ? r13.text : r13.error);

  /* ══════════ ⑥ 只有工具调用、没有正文（2026-10-20 修的） ══════════ */
  console.log('\n【只有 tool_calls、正文为空 —— 这不算失败】');

  const r14 = await feed([
    evt({ choices: [{ delta: { tool_calls: [{
      index: 0, id: 'call_1', type: 'function',
      function: { name: 'look_screen', arguments: '{}' },
    }] } }] }, LF),
    evt({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, LF),
    rawEvt('[DONE]', LF),
  ]);
  chk('★ 只有工具调用、正文为空 ⇒ **不抛错**（修复前：「她一个字都没回」，识屏永远走不到）',
    r14.ok, r14.ok ? '没有抛错' : r14.error);
  chk('★ 工具调用解析出来（name=look_screen）',
    r14.ok && r14.toolCalls && r14.toolCalls[0] && r14.toolCalls[0].name === 'look_screen',
    r14.ok ? JSON.stringify(r14.toolCalls) : r14.error);
  chk('finish_reason=tool_calls → toolFinish 为真',
    r14.ok && r14.toolFinish === true, r14.ok ? String(r14.toolFinish) : r14.error);
  chk('正文是空串（不是 undefined）', r14.ok && r14.text === '',
    r14.ok ? JSON.stringify(r14.text) : r14.error);

  /* ══════════ 隔离 ══════════ */
  console.log('\n【隔离检查】');
  chk('跑在隔离目录里', HOME.includes('_selfcheck-home-sse'), HOME);
  const REAL = 'C:\\Users\\Susim\\AppData\\Roaming\\Yachiyo';
  chk('  他真那份的 chat.jsonl 没被这次自检碰过',
    !fs.existsSync(path.join(REAL, 'data', 'chat.jsonl'))
    || fs.statSync(path.join(REAL, 'data', 'chat.jsonl')).mtimeMs < STARTED, '');

  console.log('\n' + '─'.repeat(52));
  const pass = out.filter((x) => x.ok).length;
  console.log(`  ${pass}/${out.length} 通过  ${pass === out.length ? '✓ 全过' : '✗ 有失败'}`);
  console.log('─'.repeat(52) + '\n');
  const bad = out.filter((x) => !x.ok);
  if (bad.length) { console.log('失败明细：'); for (const b of bad) console.log(`  - ${b.name}: ${b.detail}`); }
  process.exit(pass === out.length ? 0 : 1);
})().catch((e) => { console.error('\n自检自己炸了：', e.stack || e.message); process.exit(1); });
