/**
 * 自检 · P0 那一批（第 16 套）
 *
 * 管 2026-10-17 修的 7 条。**这一套是先写断言、再改代码的** ——
 * 也就是说：它第一次跑**必须红**，改完必须全绿。
 * 每条断言上面都写着「改前是什么样」，别把红的说成绿的。
 *
 *   #1  `peeker ⇄ prompt` 循环依赖 → 识屏整条链静默死亡
 *   #4  点「停止」后照样重试、回复照出
 *   #5  断流重试 → 气泡里的字重复
 *   #34 404/405/413 白等 4.5 秒（4xx 没标 hard）
 *   #35 SSE 里的 `data:{"error":…}` 被吞
 *   #41 事件内部只按 `\n` 拆行（CR 分隔的多行 data: 被合并）
 *   #6  备份只在启动跑一次（心跳钩子表里没有 backup）
 *
 * ⚠️ 跑在隔离目录里（`YACHIYO_HOME`），不碰他真实数据。
 * ⚠️ 假 SSE 端点是本机 127.0.0.1 随机端口，不连真网络、不花一分钱。
 * 跑法：node scripts/selfcheck-p0.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.join(ROOT, '_selfcheck-home-p0');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.YACHIYO_HOME = HOME;

const out = [];
const chk = (name, ok, detail) => {
  out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail != null ? '  —— ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const CORE = path.join(ROOT, 'src', 'core');
const CORE_FILES = fs.readdirSync(CORE).filter((f) => f.endsWith('.cjs'));

/** 清掉全部 core 模块缓存 —— 验「加载顺序」必须从零开始 */
function wipeCore() {
  for (const f of CORE_FILES) {
    try { delete require.cache[require.resolve(path.join(CORE, f))]; } catch { /* 没加载过就算了 */ }
  }
}
/** ⚠️ 名字带不带 `.cjs` 都认 —— 自检里两种写法混着用，别为这个 debug 半天 */
const loadCore = (name) => require(path.join(CORE, String(name).replace(/\.cjs$/, '') + '.cjs'));

/* ══════════ ① #1 循环依赖 ══════════ */
/*
 * 改前：peeker 顶部 `const prompt = require('./prompt.cjs')` 绑死，
 *       而 prompt 末尾是 `module.exports = {…}` **整体替换**。
 *       谁先加载谁拿到空对象 —— 真实启动顺序是
 *       index.cjs → brain.cjs → prompt.cjs → peeker.cjs，正踩中这一条，
 *       于是 `prompt.timeBlock is not a function`，识屏每次都在这里死。
 */
console.log('\n【① 识屏的循环依赖（#1）】');

const rebuild = (order) => {
  wipeCore();
  loadCore('config.cjs').load();
  for (const m of order) loadCore(m);
  return loadCore('peeker.cjs');
};

for (const order of [['brain'], ['prompt'], ['peeker']]) {
  const label = order[0];
  let ok = false;
  let detail = '';
  try {
    const pk = rebuild(order);
    const sys = pk.buildSystem({ userText: '看一眼', chain: 'screen' });
    ok = typeof sys === 'string' && sys.length > 0;
    detail = ok ? `${sys.length} 字` : '返回空';
  } catch (err) {
    detail = err.message;
  }
  const tag = label === 'peeker' ? '（本来就好）' : '（★ 真实启动就是这个顺序）';
  chk(`先加载 ${label} → peeker.buildSystem() 不抛 ${tag}`, ok, detail);
}

/* ══════════ ② #34 状态码分档 ══════════ */
/*
 * 改前：switch 里只有 400/401/402/403/422 和几个 5xx，
 *       404/405/413 掉进 default，hard 由服务端 detail 里有没有关键词决定
 *       ⇒ 通常 false ⇒ 被当软错误重试三次，白等 4.5 秒。
 */
console.log('\n【② 错误分档（#34）】');

const provider = (() => { wipeCore(); loadCore('config.cjs').load(); return loadCore('provider.cjs'); })();
const ex = provider.explain;

if (typeof ex !== 'function') {
  chk('provider.cjs 导出了 explain（自检要够得着）', false, '没导出 —— 得先把它加进 module.exports');
} else {
  chk('#34 404（模型名写错）→ hard，不再重试', ex(404, '{"error":{"message":"model not found"}}').hard === true);
  chk('#34 405 → hard', ex(405, '{}').hard === true);
  chk('#34 413（请求体太大）→ hard', ex(413, '{}').hard === true);
  chk('#34 401 仍然是 hard', ex(401, '{}').hard === true);
  chk('5xx 仍可重试（hard=false）', ex(500, '{}').hard === false && ex(503, '{}').hard === false);
  chk('429 仍按 detail 判（不一律 hard）', ex(429, '{}').hard === false);
}

/* ══════════ ③ 假 SSE 端点：重试与解析 ══════════ */

function listen(server) {
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));
}
/** 一条正常的内容帧（事件间用 \r\n\r\n） */
const frame = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\r\n\r\n`;

/* ---- #4 点停止还重试 ---- */
console.log('\n【③ 点「停止」之后（#4）】');

async function caseAbort() {
  let reqs = 0;
  const server = http.createServer((req, res) => {
    reqs++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let n = 0;
    const timer = setInterval(() => {
      res.write(frame('帧' + n));
      if (++n >= 20) { clearInterval(timer); res.end(); }
    }, 100);
    req.on('close', () => clearInterval(timer));
  });
  const port = await listen(server);
  const deltas = [];
  const ctl = new AbortController();
  const stop = setTimeout(() => ctl.abort(new Error('USER')), 500);

  let caught = null;
  let returned = null;
  try {
    returned = await provider.chat({
      base: `http://127.0.0.1:${port}`, key: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      signal: ctl.signal, onDelta: (t) => deltas.push(t),
    });
  } catch (err) { caught = err; }
  clearTimeout(stop);

  // 等过重试窗口（1.5 秒那档）—— 改前就是在这里偷偷重发的
  await sleep(4000);
  server.close();

  chk('#4 停止后服务端只收到 1 次请求', reqs === 1, `实收 ${reqs} 次`);
  chk('#4 停止后 chat() 没有「成功返回完整文本」', returned === null,
    returned ? `★ 返回了 ${returned.text.length} 字` : '抛错了（对）');
  chk('#4 抛出来的是硬错（hard=true，不再重试）', caught && caught.hard === true,
    caught ? `hard=${caught.hard} / ${caught.message}` : '没抛错');
  chk('#4 停止之后没有继续吐字', deltas.length <= 6, `停止后共 ${deltas.length} 次 onDelta`);
}

async function caseAbortedSignal() {
  let reqs = 0;
  const server = http.createServer((req, res) => { reqs++; res.writeHead(200); res.end(); });
  const port = await listen(server);
  const ctl = new AbortController();
  ctl.abort(new Error('USER'));            // 进来之前就已经中止了
  let caught = null;
  try {
    await provider.chat({
      base: `http://127.0.0.1:${port}`, key: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }], signal: ctl.signal,
    });
  } catch (err) { caught = err; }
  server.close();
  chk('#4 进来时 signal 已被中止 → 立刻拒绝，一个请求都不发', reqs === 0 && !!caught,
    `实发 ${reqs} 次；${caught ? caught.message : '没抛错'}`);
}

/* ---- #5 断流重试 ---- */
console.log('\n【④ 流到一半断网（#5）】');

async function caseBrokenSocket() {
  let reqs = 0;
  const server = http.createServer((req, res) => {
    reqs++;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(frame('PARTIAL-'));
    setTimeout(() => res.destroy(), 80);       // 说到一半，连接没了
  });
  const port = await listen(server);
  const deltas = [];
  let caught = null;
  let returned = null;
  try {
    returned = await provider.chat({
      base: `http://127.0.0.1:${port}`, key: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }], onDelta: (t) => deltas.push(t),
    });
  } catch (err) { caught = err; }
  await sleep(4000);                            // 过重试窗口
  server.close();

  chk('#5 断流后只请求 1 次（不重试）', reqs === 1, `实收 ${reqs} 次`);
  chk('#5 气泡里的字不重复', deltas.join('') === 'PARTIAL-', JSON.stringify(deltas.join('')));
  chk('#5 抛硬错，而不是「静默成功」', !!caught && caught.hard === true,
    caught ? `hard=${caught.hard}` : `★ 静默返回了 ${returned ? returned.text : 'null'}`);
}

/* ---- #41 CR 分隔的多行 data ---- */
console.log('\n【⑤ 事件内部用 CR 分行的多行 data:（#41）】');

async function caseCrMultiLine() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // 一条事件里有**两行** data:，行之间用 \r；事件之间用 \r\r
    res.write('data: {"choices":[{"delta":{"content":"AA"}}]}\r'
            + 'data: {"choices":[{"delta":{"content":"BB"}}]}\r\r');
    res.end();
  });
  const port = await listen(server);
  let got = null;
  let err = null;
  try {
    const r = await provider.chat({
      base: `http://127.0.0.1:${port}`, key: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    got = r.text;
  } catch (e) { err = e.message; }
  server.close();
  chk('#41 两行 data: 用 \\r 分隔 → 都认得出来（改前整条丢弃）', got === 'AABB',
    got === null ? `丢光了：${err}` : JSON.stringify(got));
}

/* ---- #35 SSE 里的 error 事件 ---- */
console.log('\n【⑥ SSE 里的 error 事件（#35）】');

async function caseSseError(halfFirst) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (halfFirst) res.write(frame('前半句'));
    res.write('data: ' + JSON.stringify({ error: { message: 'Insufficient Balance' } }) + '\r\n\r\n');
    res.end();
  });
  const port = await listen(server);
  let got = null;
  let caught = null;
  try {
    const r = await provider.chat({
      base: `http://127.0.0.1:${port}`, key: 'k', model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
    });
    got = r.text;
  } catch (e) { caught = e; }
  server.close();
  return { got, caught };
}

async function runSseErrorCases() {
  const a = await caseSseError(false);
  chk('#35 只有 error 事件 → 报的是**对面的原话**（不是「模型名写错了」）',
    !!a.caught && /Insufficient Balance/.test(a.caught.message),
    a.caught ? a.caught.message : `★ 当成功返回了：${JSON.stringify(a.got)}`);

  const b = await caseSseError(true);
  chk('#35 吐了半句之后来 error → 也要报错（改前静默当成功）',
    !!b.caught, b.caught ? b.caught.message : `★ 当成功返回了 text=${JSON.stringify(b.got)}`);
}

/* ══════════ ⑦ #6 心跳钩子表 ══════════ */
/*
 * 改前：`hooks` 表里 6 项，没有 `backup`。
 *       而 `on()` 是 `if (name in hooks)` —— **键不在就静默不注册**，
 *       所以备份永远挂不上心跳（这个坑识屏踩过一次，见 heartbeat.cjs 的注释）。
 */
console.log('\n【⑦ 备份挂心跳（#6）】');

function caseBackupHook() {
  wipeCore();
  const cfg = loadCore('config.cjs');
  cfg.load();
  cfg.set('AiEnabled', true);
  const hb = loadCore('heartbeat.cjs');

  let called = 0;
  hb.on('backup', () => { called++; });
  try { hb.tick(new Date()); } catch { /* 别的链没注册，不该影响这一条 */ }

  chk('#6 心跳钩子表里有 backup（不在表里会被静默忽略）', called >= 1, `被叫了 ${called} 次`);
}

/* ══════════ 静态检查（真行为由外壳探针验） ══════════ */
function staticChecks() {
  const idx = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.cjs'), 'utf8');
  chk('（静态）index.cjs 里注册了 heartbeat.on(\'backup\'…) —— 真行为由探针验',
    /heartbeat\.on\(\s*'backup'/.test(idx), '只查文本，不代表行为');
  chk('（静态）备份那一段还有节流（别每 5 秒读盘）',
    /lastBackupCheck|BACKUP_CHECK_MS/.test(idx), '只查文本');
}

/* ══════════ 跑 ══════════ */
(async () => {
  await caseAbort();
  await caseAbortedSignal();
  await caseBrokenSocket();
  await caseCrMultiLine();
  await runSseErrorCases();
  caseBackupHook();
  staticChecks();

  console.log('\n' + '─'.repeat(52));
  const pass = out.filter((x) => x.ok).length;
  console.log(`  ${pass}/${out.length} 通过  ${pass === out.length ? '✓ 全过' : '✗ 有失败'}`);
  console.log('─'.repeat(52) + '\n');
  const bad = out.filter((x) => !x.ok);
  if (bad.length) {
    console.log('失败明细：');
    for (const b of bad) console.log(`  - ${b.name}: ${b.detail}`);
  }
  process.exit(pass === out.length ? 0 : 1);
})();
