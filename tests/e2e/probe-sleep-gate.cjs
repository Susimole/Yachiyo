/*
 * ⚠️ 本文件 2026-10-18 由 `桌面\八千代AI桌宠工作留痕\` / `_dsh020\verify\` 搬进仓库。
 *    搬的时候只改了一件事：把写死的 `D:/AI_work/Git` 换成 `path.resolve(__dirname,'..','..')`。
 *    逻辑一行没动 —— 这些探针每天都在用，改逻辑就是给自己找麻烦。
 *
 *    跑之前要先有一个**带 CDP 的实例**（`YACHIYO_CDP=9222 npm start`），
 *    否则会报"没连上主窗口"。见 tests/e2e/README.md。
 */
/**
 * 探针：「准备睡」之后到底还冒不冒气泡
 *
 * 他 2026-10-13 的要求：
 *   「桌宠在睡着状态时不会说话也不会有任何气泡弹出」
 *
 * 为什么非得起真机：主进程里的 `sayIt` 是个闭包，从渲染层调不到；
 *   自检又不起窗口、量不到气泡。**中间这一段只有真机探针够得着。**
 *
 * 验两条出口（气泡只可能从这两条出来）：
 *   ① `speak:say`  —— 自言语 / 识屏 / 回顾（走主进程的 `sayIt`，闸在那儿）
 *   ② `bubble:*`   —— 双击她那条问答流（不走 sayIt，闸在 `chat:send-quick` 入口）
 *
 * ⚠️ 探针重放的是**事件**，不是真发请求 —— 不花钱、不发网络。
 *    它验的是「主进程的闸 + 渲染层的气泡」这一段接线；
 *    `chat:send-quick` 那个入口拦截另由 selfcheck 覆盖。
 *
 * 跑法：node scripts/probe-sleep-gate.cjs   （开发版，不用打包）
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.tmpdir(), 'yachiyo-sleepgate-probe');
const PORT = 9365;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killAll() {
  try {
    execSync('powershell.exe -NoProfile -Command "Get-Process electron,Yachiyo -ErrorAction SilentlyContinue | Stop-Process -Force"',
      { stdio: 'ignore', windowsHide: true });
  } catch { /* 没进程正好 */ }
}

const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

async function connect(t) {
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const ev = async (expression) => {
    const id = ++seq;
    const p = new Promise((r) => pending.set(id, r));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    const r = await p;
    if (r.result && r.result.exceptionDetails) {
      return { __err: String((r.result.exceptionDetails.exception || {}).description).slice(0, 250) };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  return { ws, ev };
}

const pass = [], fail = [];
const chk = (name, ok, extra) => {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra !== undefined ? '   → ' + JSON.stringify(extra) : ''}`);
};

/** 气泡现在露没露脸：既有字、又量得到宽度 */
const BUBBLE = `(() => {
  const b = document.getElementById('bubble');
  if (!b) return { err: '找不到 #bubble' };
  const t = document.getElementById('bText');
  return { text: (t && t.textContent) || '', w: Math.round(b.getBoundingClientRect().width) };
})()`;

/**
 * 把气泡按回去 —— 每轮开始先清干净，免得上一轮的残留被当成这一轮的。
 *
 * ⚠️⚠️ **绝对不能碰内联 `display` 样式**（我第一版就栽在这儿）：
 *     当初图省事写成 `style.setProperty('display','none','important')`，
 *     那个 `!important` 优先级压过一切 —— 之后主进程/气泡逻辑再怎么调
 *     `style.display=''` 都显示不出来，**连"醒着应该有气泡"那组也一起测不出**，
 *     看起来像"产品坏了"，其实是我自己的清场代码把整轮实验废掉了。
 *     ⇒ 只摘 `.on` 类（那是气泡自己的显隐开关），别动 inline style。
 */
const HIDE = `(() => {
  const b = document.getElementById('bubble');
  if (b) b.classList.remove('on');
  const t = document.getElementById('bText'); if (t) t.textContent = '';
  return true;
})()`;

const shown = (s) => !!(s && !s.err && s.w > 0 && String(s.text).length > 0);

async function main() {
  killAll();
  await sleep(600);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.YACHIYO_HOME = HOME;

  const child = spawn(require('electron'), ['.', `--remote-debugging-port=${PORT}`],
    { cwd: ROOT, env, windowsHide: true });

  let mainT = null;
  for (let i = 0; i < 30 && !mainT; i++) {
    await sleep(900);
    try { mainT = (await list()).find((t) => t.type === 'page' && t.url.includes('index.html')); } catch { }
  }
  if (!mainT) { console.log('✗ 主窗口起不来'); try { child.kill(); } catch { } process.exit(1); }
  const M = await connect(mainT);
  await sleep(1800);

  // ⚠️ 探针口挂在 `window.yachiyo.ov` 里（跟 design 同层），不在顶层
  const hooks = await M.ev(`({
    probe: !!(window.yachiyo && window.yachiyo.ov && window.yachiyo.ov._probe),
    sleep: !!(window.yachiyo && window.yachiyo.ov && window.yachiyo.ov._sleep),
  })`);
  if (!hooks.probe || !hooks.sleep) {
    console.log('✗ 探针口没挂上（只有开发版才有）: ' + JSON.stringify(hooks));
    try { child.kill(); } catch { }
    process.exit(1);
  }
  console.log('  （_probe / _sleep 两个口 ✓）');

  /*
   * ⚠️⚠️ 判据：**推一句全世界只有这一次出现的文本，然后看它折不折在气泡里**。
   *
   * 我第一版是「先清空气泡 → 推 → 量宽度」，结果被两件事同时污染：
   *   · 清空/测量之间夹着好几段 await，窗口状态会被心跳改动
   *   · 气泡本来就有"开场白"之类的既有内容，量到宽度也分不清是谁的
   * 换成"认字"就干净了：**出现 = 没拦住，没出现 = 拦住了**，不依赖任何时序。
   */
  let tagSeq = 0;
  const say = async () => {
    const tag = `ZY-SAY-${++tagSeq}`;
    await M.ev(`document.getElementById('bText').textContent = ''`);   // 只清字，不动显示状态
    await M.ev(`window.yachiyo.ov._probe('speak:say', ${JSON.stringify(tag)})`);
    await sleep(700);
    const got = await M.ev(`document.getElementById('bText').textContent`);
    return { tag, got, hit: got === tag };
  };
  const ask = async () => {
    const tag = `ZY-ASK-${++tagSeq}`;
    await M.ev(`document.getElementById('bText').textContent = ''`);
    await M.ev(`window.yachiyo.ov._probe('bubble:delta', ${JSON.stringify(tag)})`);
    await M.ev(`window.yachiyo.ov._probe('bubble:done', {})`);
    await sleep(700);
    const got = await M.ev(`document.getElementById('bText').textContent`);
    return { tag, got, hit: String(got || '').includes(tag) };
  };

  console.log('');
  console.log('=== ① 醒着：两条路都该冒出来（证明"认字"这个判据本身有效）===');
  const a1 = await say();
  chk('醒着 · speak:say → 气泡里有这句话', a1.hit, a1);
  const a2 = await ask();
  chk('醒着 · bubble:* → 气泡里有这句话', a2.hit, a2);

  console.log('');
  console.log('=== ② 睡着：两条路都必须哑掉 ===');
  /*
   * ⚠️⚠️ 为什么**不**用 `ov._sleep(true)` 来进睡（试过，测不出来）：
   *     它只把主进程的 sleepMode 置 true，而心跳每 5 秒跑一次 `review.tick()`——
   *     这一拍看到「键鼠空闲时间 < 55 分钟」就会判定"他回来了"，
   *     当场把 sleepMode 拨回 false。探针还没量完，闸门已经解除了。
   *     （真机上没问题：能进睡就说明他真的离开够久了。）
   *
   * ⇒ 改成**直接给页面推 `sleep:changed`** —— 那才是渲染层真正看的那个状态，
   *   也就是这两条断言想验的东西。推完立刻验状态，再量气泡。
   */
  await M.ev(`window.yachiyo.ov._probe('sleep:changed', true)`);
  await sleep(250);
  const pageSleep = await M.ev(`window.__yachiyoSleepState ? window.__yachiyoSleepState() : 'no-hook'`);
  chk('页面进入睡眠态', pageSleep === true, pageSleep);

  const b1 = await say();
  chk('睡着 · speak:say → 这句话没出现', !b1.hit, b1);
  const b2 = await ask();
  chk('睡着 · bubble:* → 这句话没出现', !b2.hit, b2);

  console.log('');
  console.log('=== ③ 掰回来：两条路都得恢复 ===');
  await M.ev(`window.yachiyo.ov._probe('sleep:changed', false)`);
  await sleep(250);
  const pageAwake = await M.ev(`window.__yachiyoSleepState ? window.__yachiyoSleepState() : 'no-hook'`);
  chk('页面退出睡眠态', pageAwake === false, pageAwake);

  const c1 = await say();
  chk('醒来 · speak:say → 又能说了', c1.hit, c1);
  const c2 = await ask();
  chk('醒来 · bubble:* → 又能答了', c2.hit, c2);

  console.log('');
  console.log(`=== 睡觉闸：${pass.length} 项通过 / ${fail.length} 项失败 ===`);
  if (fail.length) { console.log('失败项：'); for (const f of fail) console.log('  ✗ ' + f); }

  try { child.kill(); } catch { }
  await sleep(900);
  killAll();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { }
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error('探针炸了：' + e.stack); killAll(); process.exit(1); });
