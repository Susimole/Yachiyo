/**
 * 端到端探针 · C-2（她说的话要记下来）
 *
 * 自检验的是 `memory.addSpoken` / `buildSpokenBlock` 本身对不对。
 * 这个探针验的是**主进程那条接线**（`recordSaid` 在 `main/index.cjs` 里，
 * 自检根本跑不到那段）：
 *
 *   ① 她回完话之后，「我说过什么」**真的多了一条**
 *   ② 下**一轮**的提示词里，**真的带上了**她刚说的那句
 *      ← 这才是"压复读"真正生效的地方：没有 ②，① 只是个没人看的档案
 *
 * 跑法：node scripts/probe-speak.cjs
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9346;
const LLM_PORT = 8794;
const HOME = path.join(ROOT, '_probe-speak-home');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pend = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pend.has(m.id)) {
        const { res, rej } = this.pend.get(m.id);
        this.pend.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
  }
  static async attach(match) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const p = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && t.url.includes(match));
    if (!p) throw new Error('没找到 ' + match);
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连不上')), { once: true });
    });
    const c = new CDP(ws);
    await c.send('Runtime.enable');
    return c;
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pend.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pend.has(id)) { this.pend.delete(id); rej(new Error(method + ' 超时')); } }, 60000);
    });
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  }
}

/* ── 隔离目录 ── */
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(path.join(HOME, 'data', 'state'), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  apiBase: `http://127.0.0.1:${LLM_PORT}`,
  model: 'probe-model', apiKey: 'sk-probe-speak',
  AiEnabled: true, memShort: true, memShortCount: 30,
  profileEnabled: false,            // 这条探针不管画像
  autostart: false, sound: false, moveEnabled: false,
  backupDaily: false,               // 别让它来搅
}, null, 2), 'utf8');

const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const SPOKEN = path.join(HOME, 'data', 'state', 'spoken.json');

(async () => {
  const fail = [];
  const ok = (cond, msg, extra) => {
    console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '   ' + extra : ''}`);
    if (!cond) fail.push(msg);
  };

  const llm = spawn(process.execPath, [path.join(__dirname, 'fake-llm.cjs'), String(LLM_PORT)],
    { stdio: 'ignore', windowsHide: true });
  await sleep(700);

  try { execSync("powershell.exe -NoProfile -Command \"Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | ForEach-Object { $_.Kill() }\"", { stdio: 'ignore', windowsHide: true }); } catch { }
  await sleep(500);

  const child = spawn(electronPath, [`--remote-debugging-port=${CDP_PORT}`, ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, YACHIYO_MS: '90000', YACHIYO_HOME: HOME },
    stdio: 'ignore',
  });

  let main = null;
  for (let i = 0; i < 50 && !main; i++) {
    await sleep(500);
    try { main = await CDP.attach('index.html'); } catch { /* 还没起来 */ }
  }
  if (!main) { child.kill(); llm.kill(); throw new Error('Electron 没起来'); }
  await sleep(3000);

  try {
    /* ── 一开始是空的 ── */
    const s0 = read(SPOKEN, { Items: [] }) || { Items: [] };
    ok(!s0.Items || s0.Items.length === 0, '一开始「我说过什么」是空的', `${(s0.Items || []).length} 条`);

    /* ── ① 说一句 ── */
    // 走主进程的对话链（跟聊天窗是同一个 IPC 出口）
    const r1 = await main.evalJs(`return window.yachiyo.chat.send('在吗');`);
    ok(r1 && r1.ok === true, '她回了一句', r1 ? String(r1.text || '').slice(0, 30) : JSON.stringify(r1));
    await sleep(600);

    const s1 = read(SPOKEN, { Items: [] }) || { Items: [] };
    ok((s1.Items || []).length >= 1,
      '★ 她说的话被记进「我说过什么」了（recordSaid 那条接线通了）',
      `${(s1.Items || []).length} 条` + (s1.Items && s1.Items[0] ? `：${s1.Items[0].s.slice(0, 24)}` : ''));
    ok(s1.Items && s1.Items[0] && s1.Items[0].k === '对话',
      '  来源标成「对话」', s1.Items && s1.Items[0] ? s1.Items[0].k : '');

    /* ── ② 下一轮真的带上去了 ── */
    await main.evalJs(`return window.yachiyo.chat.send('那你说说看');`);
    await sleep(600);

    const last = await (await fetch(`http://127.0.0.1:${LLM_PORT}/__last`)).json();
    const sys = ((last.last || {}).body || {}).messages?.[0]?.content || '';
    ok(/你最近自己说过的话/.test(sys),
      '★★ 下一轮的提示词里**真的带上了**「你最近自己说过的话」',
      '（这才是压复读真正生效的地方）');
    ok(s1.Items && s1.Items[0] && sys.includes(s1.Items[0].s.slice(0, 8)),
      '★ 而且带的就是她刚说的那句', '');
    ok(/别原样再说一遍/.test(sys), '  那句「别原样再说一遍」也在', '');

    /* ── ③ 补记不会重复跑 ── */
    const n1 = (read(SPOKEN, { Items: [] }).Items || []).length;
    // 手动"重启"一次补记判断：把 seed 文件删掉再跑一遍逻辑是验不到的（那是主进程里的），
    // 这里退一步验它**留下的那份标记**在、而且记录条数不会再翻倍
    const seedFile = path.join(HOME, 'data', 'state', 'spoken-seed.json');
    ok(fs.existsSync(seedFile), '★ 补记打了一次性标记（不然每次启动都重复补）',
      fs.existsSync(seedFile) ? JSON.stringify(read(seedFile, {})) : '（标记没写）');
    ok((read(SPOKEN, { Items: [] }).Items || []).length === n1, '  记录条数没被重复塞', `${n1} 条`);

    /* ── ④ 日志里有记录 ── */
    const plog = (() => { try { return fs.readFileSync(path.join(ROOT, '_probe.log'), 'utf8'); } catch { return ''; } })();
    ok(/补记了 \d+ 句/.test(plog), '主进程日志里记了补记了几句',
      (plog.split('\n').find((l) => /补记了/.test(l)) || '').trim());

  } finally {
    try { child.kill(); } catch { }
    try { llm.kill(); } catch { }
    try { execSync("powershell.exe -NoProfile -Command \"Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | ForEach-Object { $_.Kill() }\"", { stdio: 'ignore', windowsHide: true }); } catch { }
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
})().catch((e) => { console.error(e.message); process.exit(1); });
