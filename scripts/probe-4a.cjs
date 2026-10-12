/**
 * 端到端探针 · 第 4 步①（心跳 + 回顾链）
 *
 * 自检（selfcheck-4a.cjs）验的是**纯逻辑**：闸门判得对不对、解析落得对不对。
 * 这个探针验的是**真机上接上了没有** —— 两件事只有真跑才看得出来：
 *
 *   ① `powerMonitor.getSystemIdleTime()` 真的拿到数了
 *      而且单位真的是**秒**（忘了除 60 就会得到一个 600 的假数；
 *      忘了乘 60 就会把"他刚动了"当成"他走了十分钟"）
 *   ② **回顾真的发起了、真的有东西落进她的数据层**
 *      —— 不是只看到日志里打了个字
 *
 * ⚠️ 用真的键鼠事件来翻这道闸：PowerShell 调 `SendKeys.SendWait('')`。
 *    空串**不会往任何窗口打字**，它只调 GetLastInputInfo，
 *    把系统空闲时间打回 0 —— 正好是"他回来碰了一下电脑"。
 *
 * 跑法：node scripts/probe-4a.cjs
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9341;
const LLM_PORT = 8790;
const HOME = path.join(ROOT, '_probe-4a-home');
const RUN_MS = Number(process.env.PROBE_MS || 150000);

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

/**
 * 「他动了一下电脑」。
 *
 * ⚠️ 试过 `SendKeys.SendWait('')` —— **在这台机器上不管用**（发完空闲时间照涨，
 *    实测 281 → 283 秒）。合成按键不一定会进 `GetLastInputInfo` 那个计数器，
 *    取决于会话和前台窗口，指望不上。
 *
 * ✅ 管用的是 `SetThreadExecutionState(ES_SYSTEM_REQUIRED)`：它做的正是
 *    「把系统空闲计时器打回 0」，而且**不需要任何真实输入设备**。
 *    ⚠️ 只传这一个标志、**不加 ES_CONTINUOUS** —— 加了就是把"别睡"钉住不放，
 *      这台机器在探针跑完之前都不会息屏（他就那么一个显示器）。
 *      单发一次是「这一下算有人用了」，正是我们要的语义。
 */
function touch() {
  execSync(`powershell.exe -NoProfile -Command "` +
    `$s='[DllImport(\\"kernel32.dll\\")] public static extern uint SetThreadExecutionState(uint esFlags);'; ` +
    `$t=Add-Type -MemberDefinition $s -Name Pow${process.pid} -Namespace YcProbe -PassThru; ` +
    `$t::SetThreadExecutionState([uint32]2147483648)"`,
    { stdio: 'ignore', windowsHide: true });
}

/* ── 隔离目录 ─────────────────────────────────────────── */

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

const DATA = path.join(HOME, 'data');
const STATE = path.join(DATA, 'state');
fs.mkdirSync(STATE, { recursive: true });

/** 先造两句他说的话 —— 没材料的话回顾链会（正确地）跳过 */
const seed = [
  { role: 'user', content: '今天回来挺晚的，路上还下了点雨', ts: Date.now() - 7200000 },
  { role: 'assistant', content: '诶，那你衣服湿了没啊', ts: Date.now() - 7190000 },
  { role: 'user', content: '还好，外套挡了一下。我今晚想早点睡', ts: Date.now() - 600000 },
  { role: 'assistant', content: '好耶，那我也不闹你了', ts: Date.now() - 590000 },
];
fs.writeFileSync(path.join(DATA, 'chat.jsonl'), seed.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

/**
 * 配置。
 *
 * ⚠️ `ReviewIdleMinutes` 写 0.05：真机上等 55 分钟验不了。
 *    但**实际门槛不是 0.05 —— 是 5 分钟**，`review.tick` 里有一道
 *    `Math.max(5, …)` 的护栏（防"他还在打字就突然回顾"）。
 *    ⇒ 这个探针**必须真等够 5 分钟**才验得到。别为了跑得快把这护栏绕过去：
 *      绕过去就只是证明"触发器会调用自己"，证明不了门槛真的在生效。
 *      那护栏本身在自检里另外单独钉了两条（读配置 / 不低于下限）。
 */
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  apiBase: `http://127.0.0.1:${LLM_PORT}`,
  model: 'probe-model',
  apiKey: 'sk-probe-4a',
  AiEnabled: true,
  ReviewIdleMinutes: 0.05,
  AutoExitEnabled: false,          // ⚠️ 不然她跑到一半自己退出去了
  autostart: false,
  petVisible: true,
  sound: false,
  weatherAuto: false,
  typing: false,
  moveEnabled: false,              // 别让她乱走，省得干扰判断
}, null, 2), 'utf8');

const read = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };

/* ── 开跑 ─────────────────────────────────────────────── */

(async () => {
  const fail = [];
  const ok = (cond, msg, extra) => {
    console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '   ' + extra : ''}`);
    if (!cond) fail.push(msg);
  };

  // 假模型
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
  await sleep(3000);            // 让它把窗口、心跳都起起来

  try {
    /* ── ① 心跳起来了 ── */
    const plog = (() => { try { return fs.readFileSync(path.join(ROOT, '_probe.log'), 'utf8'); } catch { return ''; } })();
    ok(/心跳起来了/.test(plog), '心跳起来了（主进程日志里有这一行）', '');
    ok(!/UnhandledPromise|ReferenceError|is not a function/.test(plog),
      '日志里没有 require 漏了 / 未捕获的错', '');

    /* ── ② powerMonitor 真的给数了，单位是秒 ── */
    const sysIdle = await cdp.evalJs('return window.yachiyo.win.state().then(s => s && s.sysIdleSeconds);');
    ok(typeof sysIdle === 'number' && sysIdle >= 0,
      'powerMonitor.getSystemIdleTime() 拿得到数', String(sysIdle));
    ok(sysIdle < 60 * 60 * 24,
      '★ 单位是【秒】不是分钟（一天 = 86400；比这还大就是算错单位了）',
      `当前 ${Math.round(sysIdle)} 秒 ≈ ${(sysIdle / 60).toFixed(1)} 分钟`);

    /* ── ③ 现在人没在动 → 还不到点，不该回顾 ── */
    touch();                       // ⚠️ 在这一台上不管用，见 touch() 的注释
    const idleNow = await cdp.evalJs('return window.yachiyo.win.state().then(s => s && s.sysIdleSeconds);');
    await sleep(5000);
    const idleLater = await cdp.evalJs('return window.yachiyo.win.state().then(s => s && s.sysIdleSeconds);');
    ok(idleLater > idleNow,
      '★ 没人碰电脑的时候，空闲秒数真的在往上走（读的是活的系统值，不是个死数）',
      `${Math.round(idleNow)} → ${Math.round(idleLater)} 秒`);

    /*
     * ⚠️ 「还没到门槛 → 不回顾」这一条**在这台机器上验不了**，
     *    而原因是探针环境本身，不是她坏了：
     *    我造不出"他刚动过"的初始状态 —— `SendKeys` 和
     *    `SetThreadExecutionState` **两个都打不回系统空闲计时器**
     *    （实测发完照涨），而探针开跑时机器本来就已经闲了好几分钟。
     *    ⇒ 探针一启动她就该到点了，"还没到点"这个状态根本不存在。
     *    "没到门槛就不动手"由自检直接喂空闲分钟数（0.5 / 0.9 / 54）验，那边是硬的。
     *    这里只确认：**她确实是到点才动的**（看下面那行日志）。
     */
    const rvFile = path.join(STATE, 'review.json');

    /* ── ④ 放着不管 → 到点发起 ── */
    console.log('\n  …松开手，等她自己到点（门槛 5 分钟，真等）…\n');
    let fired = false;
    for (let i = 0; i < 400 && !fired; i++) {
      await sleep(1000);
      const st = read(rvFile, null);
      if (st && st.lastDay) fired = true;
    }
    ok(fired, '★ 键鼠停够 → 回顾真的发起了', fired ? `lastDay=${read(rvFile).lastDay}` : '');

    /* ── ④b 她是**卡着门槛**动的，不是早也动晚也动 ── */
    // ⚠️ 她自己的链走的是**落盘日志**（`logs\YYYY-MM.log`），不是主进程那本 `_probe.log`
    const chainLog = (() => {
      try {
        const d = path.join(HOME, 'logs');
        const f = fs.readdirSync(d).filter((x) => x.endsWith('.log')).sort().pop();
        return f ? fs.readFileSync(path.join(d, f), 'utf8') : '';
      } catch { return ''; }
    })();
    ok(chainLog.length > 0, '她的链有落盘日志（不然"没回顾"是门槛没过还是写盘挂了，只能猜）',
      chainLog ? `${chainLog.split('\n').filter(Boolean).length} 行` : '（空的）');
    const m = chainLog.match(/键鼠停了\s*([\d.]+)\s*分钟（门槛\s*([\d.]+)）/);
    ok(!!m, '日志里记了她动手时的空闲分钟数（可验收指标）', m ? m[0] : '（没这行）');
    if (m) {
      const stopped = Number(m[1]), need = Number(m[2]);
      ok(need === 5,
        '★ 门槛是 5 分钟的那道护栏（配置写 0.05 也没让它变成 0.05）', `门槛 ${need}`);
      /*
       * ⚠️ 这里**不能**断言"就卡在门槛边上"。
       *    探针开跑时机器已经闲了 N 分钟，她第一拍就该到点 ——
       *    `stopped - need` 就是那个 N，不是她的反应慢。
       *    真机上他离开的时候，这个差本来就该接近 0（心跳 5 秒一拍），
       *    探针环境造不出那个起点，所以只钉"到点才动"这一半。
       */
      ok(stopped >= need && stopped < need + 30,
        '★ 到点就动，不会拖（上限给 30 分钟，正常人早关机了）',
        `停了 ${stopped.toFixed(1)} 分钟，门槛 ${need}`);
    }

    await sleep(4000);            // 等那趟请求跑完

    const last = await (await fetch(`http://127.0.0.1:${LLM_PORT}/__last`)).json();
    ok(last.calls >= 1, '假模型真的收到了请求', `${last.calls} 次`);

    // ⚠️ 请求体藏在 `body` 里（`{headers, body, raw}`）—— 别当成顶层字段拿
    const reqBody = (last.last || {}).body || {};
    const sent = JSON.stringify(reqBody.messages || []);
    ok(/一天结束了，你回头想想今天/.test(sent), '  收到的是回顾的提示词', '');
    ok(/他：今天回来挺晚的/.test(sent),
      '★ 素材里真的带上了他今天说的话（没材料她会编）', '');
    ok(reqBody.thinking && reqBody.thinking.type === 'disabled',
      '  回顾不发思考模式（它是他不在的时候跑的，卡住了没人看得见）',
      reqBody.thinking ? JSON.stringify(reqBody.thinking) : '（没带这个字段）');

    /* ── ⑤ 回来的东西真的落进了数据层 ── */
    /*
     * ⚠️ 文件名是**中文**的，跟旧工程一路 —— 别按英文猜。
     *    情绪和心事**同一个文件**（`她的心事.json`：`情绪` 键 + `worry` 数组），
     *    认错和小日子各自一个文件。
     */
    const worryFile = read(path.join(DATA, '她的心事.json'), {}) || {};
    const worries = worryFile.worry || [];
    const moodNow = worryFile.情绪 ? worryFile.情绪.现在 : '';
    const mists = (read(path.join(DATA, '她认的错.json'), {}) || {}).mistake || [];
    const smalls = (read(path.join(DATA, '她的小日子.json'), {}) || {}).small || [];

    ok(worries.length >= 1, '★ 心事落进了她的数据层', `${worries.length} 条`);
    ok(moodNow && moodNow !== '平常', '★ 情绪落进了她的数据层', moodNow || '（没变）');
    ok(mists.length >= 1, '★ 认错落进了她的数据层', `${mists.length} 条`);
    ok(smalls.length >= 1, '★ 小日子落进了她的数据层', `${smalls.length} 条`);

    if (worries[0]) console.log(`     心事：${worries[0].rank} · ${worries[0].about}`);
    if (mists[0])   console.log(`     认错：${mists[0].thought} / ${mists[0].actual} / 还在=${mists[0].open}`);
    if (smalls[0])  console.log(`     小日子：${smalls[0].group} · ${smalls[0].what}`);

    /* ── ⑥ 一天只回顾一次 ── */
    const callsBefore = last.calls;
    await sleep(9000);                          // 再停够一次门槛（1 分钟）也还是只回顾过一次
    const last2 = await (await fetch(`http://127.0.0.1:${LLM_PORT}/__last`)).json();
    ok(last2.calls === callsBefore,
      '★ 今天已经回顾过 → 再停多久也不重发（一天最多一次）',
      `${callsBefore} → ${last2.calls}`);

    /* ── ⑦ 他在真机上没被碰过 ── */
    const REAL = 'C:\\Users\\Susim\\AppData\\Roaming\\Yachiyo';
    ok(!fs.existsSync(path.join(REAL, 'data', 'state', 'review.json'))
       || read(path.join(REAL, 'data', 'state', 'review.json'), {}).lastDay !== new Date().toISOString().slice(0, 10)
       || (fs.statSync(path.join(REAL, 'data', 'state', 'review.json')).mtimeMs < Date.now() - 60000),
      '他的真数据没被这次探针写过', path.join(REAL, 'data', 'state'));

  } finally {
    try { child.kill(); } catch { }
    try { llm.kill(); } catch { }
    try { execSync("powershell.exe -NoProfile -Command \"Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | ForEach-Object { $_.Kill() }\"", { stdio: 'ignore', windowsHide: true }); } catch { }
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
})().catch((e) => { console.error(e); process.exit(1); });
