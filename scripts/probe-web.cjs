/**
 * 端到端探针 · 联网（A）
 *
 * 自检（selfcheck-4e.cjs）验的是 `websearch.cjs` 本身。
 * 这个探针验的是**主进程那段接线** —— 自检根本跑不到 `main/index.cjs`：
 *
 *   ① 他问一句"要查的" → 主进程**真的先查了**（假端点收到 Anthropic 那套请求）
 *   ② **判据**：日常闲聊那句话**不该**触发查询
 *   ③ ★★ 查到的内容**真的进了这一轮的系统提示词**
 *      —— 少了这一步，联网就是个"查了但没用上"的死链
 *
 * 跑法：node scripts/probe-web.cjs
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9354;
const LLM_PORT = 8796;
const HOME = path.join(ROOT, '_probe-web-home');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 假服务：两种协议各一条路 ── */
const seen = [];
function startLLM() {
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let p = {};
      try { p = JSON.parse(body); } catch { /* 记空的 */ }
      const isAnthropic = req.url.includes('/anthropic/');

      if (isAnthropic) {
        seen.push({ kind: 'web', url: req.url, tools: (p.tools || []).map((t) => t.type),
                    maxTok: p.max_tokens, q: (p.messages || [])[0] && p.messages[0].content });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          id: 'm1', type: 'message', role: 'assistant',
          content: [
            // ⚠️ 故意混三种块进来 —— 解析只该取 text
            { type: 'thinking', thinking: '这句内心戏不该进答案' },
            { type: 'server_tool_use', id: 't1', name: 'web_search' },
            { type: 'web_search_tool_result', tool_use_id: 't1', content: [] },
            { type: 'text', text: '据网络资料：答案是「烤面包机」，2026 年三月发布的。' },
          ],
        }));
        return;
      }

      // 主对话：SSE
      const msgs = p.messages || [];
      seen.push({
        kind: 'chat',
        sysHasWeb: String((msgs[0] || {}).content || '').includes('刚上网查到的'),
        sysLen: String((msgs[0] || {}).content || '').length,
      });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '哦，我查到啦。' }, finish_reason: null }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((r) => s.listen(LLM_PORT, '127.0.0.1', () => r(s)));
}

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
  apiBase: `http://127.0.0.1:${LLM_PORT}`, model: 'probe-model', apiKey: 'sk-probe-web',
  AiEnabled: true, webEnabled: true, webMaxUses: 3, webMaxPerDay: 20,
  webTimeoutSeconds: 8, webMaxOutputTokens: 1500,
  autostart: false, sound: false, moveEnabled: false, backupDaily: false, profileEnabled: false,
}, null, 2), 'utf8');

(async () => {
  const fail = [];
  const ok = (cond, msg, extra) => {
    console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '   ' + extra : ''}`);
    if (!cond) fail.push(msg);
  };

  const srv = await startLLM();
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
  if (!main) { child.kill(); srv.close(); throw new Error('Electron 没起来'); }
  await sleep(2500);

  try {
    /* ── ① 日常闲聊：不该查 ── */
    seen.length = 0;
    await main.evalJs(`return window.yachiyo.chat.send('今天吃了火锅');`);
    await sleep(1200);
    const chatOnly = seen.filter((x) => x.kind === 'chat');
    const webWhenChat = seen.filter((x) => x.kind === 'web');
    ok(chatOnly.length === 1, '  日常闲聊正常回了话', `${chatOnly.length} 次对话请求`);
    ok(webWhenChat.length === 0, '★ 「今天吃了火锅」**没有**触发联网（弱词陷阱）', `${webWhenChat.length} 次查询`);
    ok(chatOnly[0] && chatOnly[0].sysHasWeb === false, '  提示词里也确实没带联网块', '');

    /* ── ② 需要查的：先查、再带上 ── */
    seen.length = 0;
    await main.evalJs(`return window.yachiyo.chat.send('搜一下烤面包机是哪年发布的');`);
    await sleep(2200);

    const w = seen.filter((x) => x.kind === 'web');
    const c = seen.filter((x) => x.kind === 'chat');
    ok(w.length === 1, '★★ 主进程**真的先查了**（假端点收到了 Anthropic 那套请求）', `${w.length} 次`);
    ok(w[0] && w[0].tools && w[0].tools[0] === 'web_search_20250305',
      '★ 带的是 `web_search_20250305`（写成别的会被服务端静默忽略）',
      JSON.stringify(w[0] && w[0].tools));
    ok(w[0] && /anthropic\/v1\/messages/.test(w[0].url), '★ 打的是 Anthropic 端点那条路', w[0] && w[0].url);
    ok(w[0] && w[0].q === '搜一下烤面包机是哪年发布的', '  问题原样传过去了', w[0] && w[0].q);

    ok(c.length === 1, '  查完之后**照样让她回话**（没有卡住）', `${c.length} 次`);
    ok(c[0] && c[0].sysHasWeb === true,
      '★★ **查到的东西真的进了这一轮的系统提示词**（少了这步它就是"查了但没用上"）', '');
    ok(c[0] && c[0].sysLen > 200, '  系统提示词确实变长了', `${c[0] && c[0].sysLen} 字`);

    /* ── ③ 日志里有可验收指标 ── */
    const plog = (() => { try { return fs.readFileSync(path.join(ROOT, '_probe.log'), 'utf8'); } catch { return ''; } })();
    const line = plog.split('\n').find((l) => l.includes('[联网]'));
    ok(!!line, '★ 日志里留了可验收指标那一行', line ? line.trim().slice(-60) : '（没有）');
    ok(line && /服务端搜了 \d+ 次/.test(line),
      '★★ 记的是**搜了几次**（不是"拿到几个字"——当年就是被 N 字骗的）', '');

    /* ── ④ 联网状态落盘 ── */
    const st = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'data/state/web.json'), 'utf8')); } catch { return null; } })();
    ok(st && st.n === 1, '  当日计数 +1', st ? String(st.n) : '（没落盘）');
    ok(st && st.uses >= 1, '  存下了"服务端搜了几次"', st ? String(st.uses) : '');
    ok(st && /烤面包机/.test(st.answer || ''), '  存的是**只有 text 块**的答案',
      st ? String(st.answer).slice(0, 30) : '');
    ok(st && !/内心戏/.test(st.answer || ''), '★ 内心戏没被拼进答案', '');

  } finally {
    try { child.kill(); } catch { }
    try { srv.close(); } catch { }
    try { execSync("powershell.exe -NoProfile -Command \"Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | ForEach-Object { $_.Kill() }\"", { stdio: 'ignore', windowsHide: true }); } catch { }
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
})().catch((e) => { console.error(e.message); process.exit(1); });
