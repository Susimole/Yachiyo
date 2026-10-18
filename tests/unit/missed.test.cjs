/**
 * 自检 · 交接文档漏掉的那五条（第 17 套）
 *
 * 背景：66 条外部 bug 清单里，2026-10-16 那轮大修**漏了 5 条** ——
 *       既没说修了、也没说没修，从交接文档里消失了。
 *       这一套管的就是它们，同样**先写断言再改代码**：
 *
 *   #10 关掉短期记忆后，他当前这句话没发给模型（messages 只有 system）
 *   #11 「隔了多久」的时间感知永远提示不了久别（先 push 再组提示词）
 *   #40 错误响应体停住时，请求一直挂着（超时定时器已经清掉）
 *   #42 自言自语跟聊天流式回复同时进行，气泡里文字交错
 *   #49 开发用静态服务器：一发 `/%` 整个进程死
 *
 * ⚠️ 跑在隔离目录里（`YACHIYO_HOME`），不碰他真实数据；不起窗口、不连真网络。
 * 跑法：node scripts/selfcheck-missed.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.join(ROOT, '_selfcheck-home-missed');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.YACHIYO_HOME = HOME;

const out = [];
const chk = (name, ok, detail) => {
  out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail != null ? '  —— ' + detail : ''}`);
};

const CORE = path.join(ROOT, 'src', 'core');
const HOUR = 3600 * 1000;

/** 清掉一个 core 模块的缓存再 require */
function fresh(rel) {
  const p = path.join(CORE, rel);
  delete require.cache[require.resolve(p)];
  return require(p);
}

/*
 * ⚠️⚠️ **重建顺序不能乱**（这一条我自己踩过）：
 *    先重建上游、再重建下游 —— 这样下游 require 到的就是**刚建的那一批**，
 *    我打的桩（provider.chat / prompt.buildSystem）才会被真正调用。
 *    反过来写（先 brain 后 provider）：brain 手里握着旧实例，
 *    桩打在另一个对象上 —— 现象是"测试跑了真网络"。
 */
function rebuildChain() {
  const cfg = fresh('config.cjs');
  const mem = fresh('memory.cjs');
  const prompt = fresh('prompt.cjs');
  const provider = fresh('provider.cjs');
  const brain = fresh('brain.cjs');
  return { cfg, mem, prompt, provider, brain };
}

/** 写一条「他 N 小时前说的话」到 chat.jsonl（要在重建链之前写） */
function seedHisLastWord(text, agoMs) {
  const memForPath = fresh('memory.cjs');
  fs.mkdirSync(path.dirname(memForPath.FILE), { recursive: true });
  fs.writeFileSync(memForPath.FILE,
    JSON.stringify({ role: 'user', content: text, ts: Date.now() - agoMs }) + '\n', 'utf8');
}

/* ══════════ #10 / #11：组提示词与入库的顺序 ══════════ */
console.log('\n【① 他这句话有没有发出去 / 久别还提不提（#10 #11）】');

async function caseGapSense() {
  /*
   * ⚠️⚠️ 这里原来造的是「**8 小时前**」那条记录，而这条用例又断言
   *    「组提示词时**今天他还没说过话**」—— 两件事**只有凌晨才同时成立**：
   *    下午 6 点往前推 8 小时还是今天，todayCount 必然 ≥ 1 ⇒ 误报红。
   *    （我们前几轮一直在凌晨跑，所以一直是绿的 —— 今天下午一跑就露馅了。）
   *    ⇒ 改成 **30 小时前**：既跨了天（todayCount 干净），
   *      又照样满足下面那条「很久没说话（≥470 分钟）」的断言。**与跑的时刻无关**。
   */
  seedHisLastWord('我一天多以前说的', 30 * HOUR);
  const { cfg, mem, prompt, provider, brain } = rebuildChain();
  cfg.load();
  cfg.set('apiKey', 'selfcheck-key');
  cfg.set('model', 'selfcheck-model');
  cfg.set('apiBase', 'http://127.0.0.1:1');

  /*
   * 量**组提示词那一刻**memory 怎么回答这两个问题。
   * 这是最硬的判据：不用去猜提示词里的中文措辞（措辞会改，这两个数不会）。
   */
  let snap = null;
  const realBuild = prompt.buildSystem;
  prompt.buildSystem = (o) => {
    snap = { last: mem.lastSeen(), today: mem.todayCount() };
    return realBuild.call(prompt, o);
  };

  provider.chat = async () => ({ text: '嗯', usage: null, ms: 1 });
  await brain.reply('你现在在吗');

  chk('（前置）prompt.buildSystem 的桩生效了', snap !== null, snap ? 'ok' : 'brain 没走这个函数 —— 判据要换');

  const gapMin = snap && snap.last ? Math.round((Date.now() - snap.last) / 60000) : null;
  chk('#11 组提示词时，「他上次说话」是 8 小时前（不是刚刚）',
    gapMin !== null && gapMin >= 470, gapMin === null ? '没量到' : `${gapMin} 分钟前`);
  chk('#11 组提示词时，今天他还没说过话（这一句不算进去）',
    snap && snap.today === 0, `todayCount=${snap ? snap.today : '?'}`);
}

async function caseMemShortOff() {
  seedHisLastWord('我八小时前说的', 8 * HOUR);
  const { cfg, provider, brain } = rebuildChain();
  cfg.load();
  cfg.set('apiKey', 'selfcheck-key');
  cfg.set('model', 'selfcheck-model');
  cfg.set('apiBase', 'http://127.0.0.1:1');
  cfg.set('memShort', false);

  let captured = null;
  provider.chat = async (o) => { captured = o.messages; return { text: '嗯', usage: null, ms: 1 }; };
  await brain.reply('你现在在吗');

  const users = (captured || []).filter((m) => m.role === 'user');
  chk('#10 关掉短期记忆后，messages 里仍然有他这一句',
    users.length >= 1 && users.some((m) => m.content === '你现在在吗'),
    `roles = [${(captured || []).map((m) => m.role).join(', ')}]`);
  chk('#10 关掉短期记忆后，不带更早的历史（只带这一句）',
    users.length === 1, `${users.length} 条 user`);
}

/* ══════════ #40：错误响应体停住 ══════════ */
console.log('\n【② 错误响应体停住时会不会挂死（#40）】');

async function caseErrorBodyStall() {
  const provider = fresh('provider.cjs');
  /*
   * 服务端：回 **404**、声明 Content-Length 却只发一半，然后保持连接不动。
   *
   * ⚠️ 用 4xx 别用 5xx：5xx 是「软错误」，`chat()` 会**按设计**重试两次 ——
   *    那样量到的是"重试 3 次 × 每次 4 秒"，会把它误判成"还挂着"（我第一版就踩了）。
   *    4xx 是硬错、不重试，一次调用就能看出「读错误体到底有没有被限时」。
   */
  const server = http.createServer((req, res) => {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Content-Length': '200' });
    res.write('{"error":{"message":"只发了半截');   // 故意不发完，也不 end()
  });
  const port = await new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port)));

  /*
   * ⚠️ **这一条必须自己带兜底超时** —— 被测的正是「请求会不会一直挂着」，
   *    傻等下去测试自己也跟着挂（实测：不加兜底，整个自检卡满 5 分钟被掐断）。
   *    ⇒ 8 秒还没结果就判「挂住了」，然后主动把连接掐掉放它走。
   */
  const t0 = Date.now();
  let slow = false;
  const call = provider.chat({
    base: `http://127.0.0.1:${port}`, key: 'k', model: 'm',
    messages: [{ role: 'user', content: 'hi' }],
  }).then(() => ({ returned: true })).catch((err) => ({ err }));
  const done = await Promise.race([
    call,
    new Promise((r) => setTimeout(() => { slow = true; r({ timeout: true }); }, 8000)),
  ]);
  const ms = Date.now() - t0;
  try { server.closeAllConnections(); } catch { /* 老 node 没这个 API 就算了 */ }
  server.close();

  chk('#40 错误体不发完 → 也要在超时内结束，不能一直挂着',
    !slow && !!done.err && ms < 6000,
    slow ? `★ ${ms}ms 还没结束（挂住了）`
      : done.err ? `${ms}ms → ${done.err.message.slice(0, 34)}`
        : `★ ${ms}ms 就返回了，居然没报错`);
}

/* ══════════ #42：自言自语该不该在他聊天时开口 ══════════ */
console.log('\n【③ 自言语跟聊天撞车（#42）】');

function caseSelfTalkGate() {
  /*
   * ⚠️ 这一条**别用 grep 判** —— 我第一版就是静默文本匹配，
   *    结果在注释里也能匹配到，跑出来是**假绿**。
   *    现在真调一次 tick，看这一拍到底开不开口。
   * ⚠️ 重建顺序：先 provider（打桩）、再 selftalk ——
   *    反过来 selftalk 手里会是旧实例，桩打不上，测试会去连真网。
   */
  const cfg = fresh('config.cjs');
  const provider = fresh('provider.cjs');
  let chatCalls = 0;
  provider.chat = async () => { chatCalls++; return { text: '自言自语', usage: null, ms: 1 }; };
  const st = fresh('selftalk.cjs');

  cfg.load();
  cfg.set('AiEnabled', true);
  cfg.set('SelfTalkEnabled', true);

  const atNow = () => st._setNextAt(Date.now() - 1000);   // 让它「到点」

  /* ① 他正在聊天 → 这一拍不该开口 */
  st._reset();
  st.attach({ chatBusy: () => true });
  atNow();
  const r1 = st.tick(0, new Date());
  chk('#42 他正在聊天时，自言语这一拍不开口', r1 !== '说一句', `tick 返回「${r1}」`);

  /* ② 他没在聊 → 闸不能拦死，照常开口 */
  st._reset();
  st.attach({ chatBusy: () => false });
  atNow();
  const r2 = st.tick(0, new Date());
  chk('#42 他没在聊时照常开口（闸没拦死）', r2 === '说一句', `tick 返回「${r2}」`);

  /* ③ noteUserSpoke 真让路 —— 排期都到点了，也该被静默期挡住 */
  st._reset();
  st.attach({ chatBusy: () => false });
  st.noteUserSpoke('他刚说的这句');
  atNow();
  const r3 = st.tick(0, new Date());
  chk('#42 noteUserSpoke 之后要让路（改前只去重、不让路）', r3 !== '说一句', `tick 返回「${r3}」`);

  st._reset();
}

/* ══════════ #49：开发用静态服务器 ══════════ */
console.log('\n【④ 开发用服务器打得死吗（#49）】');

async function caseServeCrash() {
  const { spawn } = require('node:child_process');
  const PORT = 18931;
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'serve.cjs')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += String(d); });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(900);

  const hit = (p) => new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: p }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.setTimeout(1500, () => { req.destroy(); resolve(0); });
  });

  const baseline = await hit('/index.html');
  const malformed = await hit('/%');
  await wait(400);
  const aliveAfter = child.exitCode === null && !child.killed;
  const afterCrash = aliveAfter ? await hit('/index.html') : 0;

  try { child.kill(); } catch { /* 已经死了 */ }

  chk('#49 基线能通（服务器起得来）', baseline === 200 || baseline === 404, `HTTP ${baseline}`);
  chk('#49 访问 /% 不崩（改前整个进程死于 URIError）', aliveAfter,
    aliveAfter ? `进程还在（/% 返回 ${malformed}）`
      : `★ 进程死了：${(stderr.split('\n').find((l) => /Error/.test(l)) || stderr).slice(0, 70)}`);
  chk('#49 挨过一发之后还能继续服务', afterCrash === 200 || afterCrash === 404, `HTTP ${afterCrash}`);
}

/* ══════════ 跑 ══════════ */
(async () => {
  await caseGapSense();
  await caseMemShortOff();
  await caseErrorBodyStall();
  caseSelfTalkGate();
  await caseServeCrash();

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
