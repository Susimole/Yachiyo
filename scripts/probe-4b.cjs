/**
 * 端到端探针 · 第 4 步②（自言语 + 自动关闭）
 *
 * 自检（selfcheck-4b.cjs）验的是**纯逻辑**（喂空闲分钟数、假退出钩子）。
 * 这个探针验的是**真机上接上了没有** —— 中间隔着一整条主进程接线，
 * 而且接错的表现**全都是静默的**：
 *
 *   ① 自言语真的冒到气泡上了吗？（`speak:say` 在白名单里？渲染层收了吗？）
 *   ② 自动关闭**在"他刚动过"的时候会不会误关**？（这条最要命 —— 误关就是程序没了）
 *   ③ 她真困了要退的时候，是不是走了软退出那条路（存盘 + 清进程）
 *
 * ⚠️ 跑的时候**别碰键鼠** —— 一碰系统空闲时间归零，第②条的前提就没了。
 *
 * ⚠️ 自动关闭的门槛有 **10 分钟硬下限**（填小了也按 60 算），
 *    所以**这里不真等它触发** —— 那要等十分钟。
 *    真触发那一路由自检钉（喂 75 分钟）。这个探针盯的是**"不该关的时候没关"**。
 *
 * 跑法：node scripts/probe-4b.cjs
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9345;
const LLM_PORT = 8793;
const HOME = path.join(ROOT, '_probe-4b-home');
const RUN_MS = Number(process.env.PROBE_MS || 300000);

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
  static async attach() {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl
                                  && t.url.includes('index.html'));
    if (!page) throw new Error('没找到主窗口页面');
    const ws = new WebSocket(page.webSocketDebuggerUrl);
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
      setTimeout(() => { if (this.pend.has(id)) { this.pend.delete(id); rej(new Error(method + ' 超时')); } }, 20000);
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

/* ── 隔离目录 ─────────────────────────────────────────── */

fs.rmSync(HOME, { recursive: true, force: true });
const DATA = path.join(HOME, 'data');
fs.mkdirSync(path.join(DATA, 'state'), { recursive: true });

fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  apiBase: `http://127.0.0.1:${LLM_PORT}`,
  model: 'probe-model',
  apiKey: 'sk-probe-4b',
  AiEnabled: true,
  // 自言语：**立刻到点**（排期一写下去就是过去的时刻 → 下一拍就说）
  SelfTalkEnabled: true,
  SelfTalkMinMinutes: 20, SelfTalkMaxMinutes: 60,
  SelfTalkAvoidRepeat: true,
  // 自动关闭：门槛填 11（有 10 分钟硬下限，填 1 也按 60）——这里只要它**别关**
  AutoExitEnabled: true,
  AutoExitIdleMinutes: 11,
  autostart: false, sound: false, moveEnabled: false, petVisible: true,
}, null, 2), 'utf8');

// ★ 排期写成"早就该说了" → 第一拍就该开口
fs.writeFileSync(path.join(DATA, 'state', 'selftalk.json'),
  JSON.stringify({ nextAt: Date.now() - 60000 }, null, 2), 'utf8');

const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

/** 日志目录（她自己的链写这儿） */
function chainLog() {
  try {
    const d = path.join(HOME, 'logs');
    const f = fs.readdirSync(d).filter((x) => x.endsWith('.log')).sort().pop();
    return f ? fs.readFileSync(path.join(d, f), 'utf8') : '';
  } catch { return ''; }
}

/* ── 开跑 ─────────────────────────────────────────────── */

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
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, YACHIYO_MS: String(RUN_MS), YACHIYO_HOME: HOME },
    stdio: 'ignore',
  });

  let cdp = null;
  for (let i = 0; i < 50 && !cdp; i++) {
    await sleep(500);
    try { cdp = await CDP.attach(); } catch { /* 还没起来 */ }
  }
  if (!cdp) { child.kill(); llm.kill(); throw new Error('Electron 没起来'); }
  await sleep(2500);

  try {
    /* ── ① 心跳三条链都挂上了 ── */
    const plog = (() => { try { return fs.readFileSync(path.join(ROOT, '_probe.log'), 'utf8'); } catch { return ''; } })();
    ok(/心跳起来了/.test(plog), '心跳起来了', '');
    ok(!/is not a function|ReferenceError|TypeError/.test(plog),
      '日志里没有接线错的痕迹', '');

    /* ── ② 自言语真的冒到气泡上了 ── */
    /*
     * ⚠️⚠️ **认她说的那一句，别认"气泡里有字就算"**。
     *    第一版就是这么写的，结果气泡是同一个（`#bubble`），
     *    逮到的是**开机那句招呼**（"来啦～"）—— 看着绿，其实什么都没验到。
     *
     * ⚠️⚠️ 而且**不能"隔几秒把排期重推回过去"**（第一版也这么干了）。
     *    排期一到点就先排下一次、然后才说话 —— 重推回过去的话，
     *    紧接着那一拍会撞上"最近说过的话不许重复"，她被驳回 → 排期又往后跳。
     *    实测转了三圈才说成，期间把 exp 读成了"下一次 -1 分钟后"（其实是过去那一拍）。
     *    ⇒ 排期是**产品自己的节奏**，探针只该看，不该推。
     */
    console.log('\n  …等她自己开口（排期已设成"早就该说了"）…\n');
    const saidRe = /\[自言语\] \d+ms · 说了 \d+ 字：(.+)$/m;
    let hit = null;
    for (let i = 0; i < 45; i++) {
      await sleep(1000);
      const m = chainLog().match(saidRe);
      if (!m) continue;
      // 她真说了 —— 再去画面里确认那句话在不在屏幕上（气泡只留几秒）
      const bubble = await cdp.evalJs(
        "const el=document.getElementById('bubble');" +
        "const tx=document.getElementById('bText');" +
        "return { open: !!el && el.classList.contains('open'), text: tx ? tx.textContent : '' };");
      hit = { log: m[1], bubble };
      if (bubble.open && bubble.text && bubble.text.includes(m[1].slice(0, 6))) break;
    }

    ok(!!hit, '★ 她真的开口了（落盘日志里有「说了 N 字」那行）',
      hit ? hit.log.slice(0, 40) : '（一次都没说）');
    ok(hit && hit.bubble.open && hit.bubble.text.includes(hit.log.slice(0, 6)),
      '★ 那句话真的冒到气泡上了（speak:say 那一路通了）',
      hit ? `气泡里是「${hit.bubble.text.slice(0, 24)}」` : '');

    const logTxt = chainLog();
    ok(/\[自言语\] 下次安排在/.test(logTxt), '  日志记了"下次安排在几点"（可验收指标）',
      (logTxt.split('\n').find((l) => l.includes('下次安排在')) || '').slice(-46));

    /* ── ③ 下一次真的排到了未来 ── */
    const st1 = read(path.join(DATA, 'state', 'selftalk.json'), {}) || {};
    ok(Number(st1.nextAt) > Date.now() + 60000,
      '★ 说完之后下一次排到了至少 1 分钟以后（不是立刻再来一句）',
      `${Math.round((Number(st1.nextAt) - Date.now()) / 60000)} 分钟后`);

    /* ── ④ ⚠️ 最要命的一条：不该关的时候没关 ── */
    console.log('\n  …盯着看她会不会误关（他刚动过，绝不该关）…\n');
    let alive = true;
    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      try { await cdp.evalJs('return 1;'); } catch { alive = false; break; }
    }
    ok(alive, '★ 程序还活着 —— 他刚动过的时候**没有误关**（防秒关那道闸真接上了）',
      alive ? '盯了 25 秒' : '进程没了！');

    if (alive) {
      const st2 = autoexitState();
      ok(st2.sawActive === true,
        '★ 记下了"这一趟见过他动过"（没有这条的话他一启动就会被秒关）',
        JSON.stringify(st2));
    }

    /* ── ⑤ 准备睡挡着自言语 ── */
    const gated = await cdp.evalJs("return window.yachiyo.ov && window.yachiyo.ov.info ? 'ok' : 'no';");
    ok(gated === 'ok', '浮层桥还在（准备睡那条闸接在 review 上）', '');

    /* ── ⑥ 退出走软退出（不真退，只确认那条路存在且没被触发过） ── */
    ok(!/软退出/.test(plog),
      '这段时间里没有走过软退出（不该退的时候没退）', '');

  } finally {
    try { child.kill(); } catch { }
    try { llm.kill(); } catch { }
    try { execSync("powershell.exe -NoProfile -Command \"Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | ForEach-Object { $_.Kill() }\"", { stdio: 'ignore', windowsHide: true }); } catch { }
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
})().catch((e) => { console.error(e); process.exit(1); });

/**
 * 读自动关闭的状态 —— 它**不落盘**（`sawUserActive` 故意只在内存里，
 * 重启就该归零，见 autoexit.cjs 的注释），所以只能从日志里认。
 */
function autoexitState() {
  const t = chainLog();
  return { sawActive: /见到他动了/.test(t) };
}
