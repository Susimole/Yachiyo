/**
 * 探针：3c 情绪标记的**端到端**验证（走真链路，起窗口）。
 *
 * selfcheck-3c.cjs 验的是数据层（纯函数），**验不到 brain.js 有没有接上**。
 * 这个探针补那一刀：真起一只、真发一句、真让假模型吐 `[心情 差]`，然后看
 *   ① 气泡 / 聊天记录里**有没有残留那串方括号**（剥干净了吗）
 *   ② 情绪有没有**真的落盘**
 *
 * ⚠️ 跑之前先把桌宠关掉。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9411;
const FAKE_PORT = 8789;
const HOME = path.join(ROOT, '_probe-3c-home');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  petSize: 45, theme: 'light',
  apiBase: `http://127.0.0.1:${FAKE_PORT}`, apiKey: 'sk-test',
  model: 'fake-model', thinking: false,
}, null, 2), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function cleanEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}
function killOurElectrons() {
  const pat = path.join(ROOT, 'node_modules', 'electron');
  try {
    execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${pat}*' } | ForEach-Object { $_.Kill() }"`, { stdio: 'ignore' });
  } catch { /* 没有就算 */ }
}

async function attach(part, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await sleep(500);
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = l.find((x) => x.type === 'page' && x.url.includes(part));
      if (!t) continue;
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => { ws.onopen = r; });
      let id = 0; const pend = new Map();
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pend.has(m.id)) {
          const p = pend.get(m.id); pend.delete(m.id);
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        }
      };
      const raw = (me, pa) => new Promise((res, rej) => {
        const o = { id: ++id, method: me, params: pa || {} };
        pend.set(o.id, { res, rej }); ws.send(JSON.stringify(o));
      });
      await raw('Runtime.enable');
      const js = async (ex) => {
        const r = await raw('Runtime.evaluate', {
          expression: `(async () => { ${ex} })()`, awaitPromise: true, returnByValue: true,
        });
        if (r.exceptionDetails) {
          throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        }
        return r.result.value;
      };
      return { js };
    } catch { /* 还没起来 */ }
  }
  return null;
}

const out = [];
const chk = (name, ok, detail) => { out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) }); };
const readMood = () => {
  try { return JSON.parse(fs.readFileSync(path.join(HOME, 'data', '她的心事.json'), 'utf8')).情绪; }
  catch { return null; }
};
const readChat = () => {
  try {
    return fs.readFileSync(path.join(HOME, 'data', 'chat.jsonl'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch { return []; }
};

let child = null; let fake = null;
(async () => {
  killOurElectrons();
  await sleep(600);
  let live = 0;
  try {
    live = Number(execSync('powershell -NoProfile -Command "@(Get-Process electron -ErrorAction SilentlyContinue).Count"',
      { encoding: 'utf8' }).trim()) || 0;
  } catch { /* ignore */ }
  if (live > 0) { console.error(`\n  ✗ 有 ${live} 个 electron 在跑 —— 先关掉桌宠。\n`); process.exit(2); }

  fake = spawn(process.execPath, [path.join(__dirname, 'fake-llm.cjs'), String(FAKE_PORT)],
    { stdio: 'ignore', windowsHide: true });
  await sleep(900);

  child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`, ROOT], {
    env: cleanEnv({ YACHIYO_HOME: HOME }), stdio: 'ignore',
  });
  const main = await attach('index.html');
  if (!main) { console.error('主窗口没起来'); process.exit(1); }
  await sleep(3500);

  // ① 先问一句「难过一下」→ 假模型回 `【心情 差】\n今天有点闷，说不上来。`
  const r1 = await main.js(`return await window.yachiyo.chat.send('今天有点难过一下');`);
  chk('第一句发出去了', r1 && r1.ok === true, JSON.stringify(r1).slice(0, 120));
  await sleep(1500);

  // 聊天历史里那条回复 —— 必须**没有**方括号
  const chat1 = readChat().filter((m) => m.role === 'assistant');
  const last1 = chat1[chat1.length - 1];
  chk('★ 存档里的回复剥干净了（没留方括号）',
    !!last1 && !/[\[【]心情/.test(last1.content),
    last1 ? JSON.stringify(last1.content) : '(没有 assistant 记录)');
  chk('★ 正文还在（不是整条被吃掉）',
    !!last1 && /闷/.test(last1.content), last1 ? last1.content : '');

  const m1 = readMood();
  chk('★ 心情落盘了（低落）', m1 && m1.现在 === '低落', JSON.stringify(m1 && m1.现在));
  chk('  记下了原因（取自正文）', m1 && /闷/.test(m1.为什么 || ''), m1 && m1.为什么);

  // ② 再问一句「高兴一下」→ 变成高兴
  const r2 = await main.js(`return await window.yachiyo.chat.send('夸夸你，高兴一下');`);
  chk('第二句发出去了', r2 && r2.ok === true, '');
  await sleep(1500);

  const m2 = readMood();
  chk('★ 心情变成高兴了', m2 && m2.现在 === '高兴', JSON.stringify(m2 && m2.现在));
  chk('  流水记了两条', m2 && Array.isArray(m2.记录) && m2.记录.length === 2,
    m2 && m2.记录 && m2.记录.length);

  const chat2 = readChat().filter((m) => m.role === 'assistant');
  const last2 = chat2[chat2.length - 1];
  chk('★ 第二条也剥干净了', !!last2 && !/[\[【]心情/.test(last2.content),
    last2 ? JSON.stringify(last2.content) : '');

  /*
   * ③ 她还能正常回话（没被 3c 的接线搞坏）
   * ⚠️ 提示词里到底有没有那几段，归 selfcheck-3c.cjs 管（纯函数好验）。
   *    这里只确认**真链路没断** —— 两轮都出话了。
   */
  chk('两轮都有回复（链路没断）',
    chat2.length >= 2 && !!last2 && last2.content.length > 0, `assistant 记录 ${chat2.length} 条`);

  console.log('');
  for (const r of out) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}  —— ${r.detail}`);
  const pass = out.filter((x) => x.ok).length;
  console.log(`\n  ${pass}/${out.length} ${pass === out.length ? '全过' : '有失败'}\n`);
})()
  .catch((e) => { console.error('\n探针炸了：', e.message); })
  .finally(async () => {
    try { if (child) child.kill(); } catch { /* ignore */ }
    try { if (fake) fake.kill(); } catch { /* ignore */ }
    await sleep(400);
    killOurElectrons();
    await sleep(400);
    process.exit(0);
  });
