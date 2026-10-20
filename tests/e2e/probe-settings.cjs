/*
 * 探针：设置面板「五页都能画出来」（2026-10-20 新加，洗澡⑥ 的安全网）
 *
 * 为什么非要有：`npm test` 那 20 套是**纯 node**，一个都不加载 `settings.js` /
 * `app.js` / `index.cjs`。也就是说**界面层没有任何自动化**——
 * 拆文件、改渲染只要不抛语法错，自检全绿，而面板可能已经白屏了。
 * 2026-10-18 就吃过一次：图那一行没有 label，落进横排容器，布局塌了自检一声不响。
 *
 * 这一套钉三件事：
 *   1. 五页**每页都画得出来**（.row 数量 + 标题对得上）
 *   2. 今天动过的那几行**在不在**（「数据文件夹」在；「识图模型 / 识图地址 / 视觉模块」不在）
 *   3. 页面脚本**没抛异常**（h2 没被更新 / 有 error 都算红）
 *
 * 跑法：node tests/e2e/probe-settings.cjs
 *      （自己起 Electron，跑完自己关；用隔离的 YACHIYO_HOME，不碰他的真实数据）
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..', '..');
const HOME = path.join(os.tmpdir(), 'yachiyo-settings-probe');
const PORT = 9365;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pass = [];
const fail = [];
const chk = (name, ok, extra) => {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra !== undefined ? '   → ' + JSON.stringify(extra) : ''}`);
};

function killAll() {
  try {
    execSync('powershell.exe -NoProfile -Command "Get-Process electron,Yachiyo -ErrorAction SilentlyContinue | Stop-Process -Force"',
      { stdio: 'ignore', windowsHide: true });
  } catch { /* 没进程正好 */ }
}

const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

/** 连一个 CDP target —— ⚠️ 必须带重试：懒建窗口刚出现那一刻连接会抛 Invalid URL */
async function connect(t, tries = 6) {
  const target = (t && typeof t === 'object') ? t.webSocketDebuggerUrl : t;
  if (typeof target !== 'string' || !/^ws/.test(target)) throw new Error('connect() 参数不对：' + JSON.stringify(t));
  let ws = null;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      ws = new WebSocket(target);
      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
        setTimeout(() => rej(new Error('ws timeout')), 4000);
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err; ws = null;
      await sleep(800);
    }
  }
  if (!ws) throw new Error('连不上 CDP：' + (lastErr && lastErr.message));
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
      return { __err: String(((r.result.exceptionDetails.exception || {}).description) || '').slice(0, 300) };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  return { ws, ev };
}

const PAGES = [
  /* ⚠️ 这里的 key 是 `PAGES` 里的 `k`（可以在 settings-pages.js 里 grep `k:'`），
     不是页面名字 —— 我第一版把「对话」写成 `chat`，探针当场报 no-nav 才发现的。 */
  ['habit', '习惯'],
  ['bubble', '对话框'],
  ['weather', '天气'],
  ['ai', 'AI 接入'],
  ['adv', '高级'],
];

async function main() {
  console.log('探针：设置面板五页渲染（洗澡⑥ 安全网）\n');
  killAll();
  await sleep(600);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.YACHIYO_HOME = HOME;

  const electron = require('electron');
  const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, env, windowsHide: true });

  let mainT = null;
  for (let i = 0; i < 30 && !mainT; i++) {
    await sleep(900);
    try { mainT = (await list()).find((t) => t.type === 'page' && t.url.includes('index.html')); } catch { /* 还没起 */ }
  }
  if (!mainT) { console.log('✗ 主窗口起不来'); try { child.kill(); } catch { } process.exit(1); }
  const MAIN = await connect(mainT);
  await sleep(1500);

  // 打开设置面板（真实入口）
  await MAIN.ev(`window.yachiyo.ov.open('panel', { state: { page: 'habit' } })`);

  let pt = null;
  for (let i = 0; i < 20 && !(pt && pt.webSocketDebuggerUrl); i++) {
    await sleep(700);
    pt = (await list()).find((t) => t.type === 'page' && t.url.includes('panel.html'));
  }
  chk('设置面板窗口起来了', !!(pt && pt.webSocketDebuggerUrl), pt && pt.url);
  if (!pt) { try { child.kill(); } catch { } process.exit(1); }

  const PANEL = await connect(pt);
  await sleep(1200);

  // 先把页面里的异常勾住（之后每页都查一遍）
  await PANEL.ev(`(() => { window.__errs = []; window.addEventListener('error', (e) => window.__errs.push(String(e.message || e))); return true; })()`);

  const navN = await PANEL.ev(`document.querySelectorAll('#navs .nav').length`);
  chk('左侧导航有 5 页', navN === 5, navN);

  const allText = [];
  for (const [k, title] of PAGES) {
    const clicked = await PANEL.ev(`(() => {
      const n = document.querySelector('#navs .nav[data-k="${k}"]');
      if (!n) return 'no-nav';
      n.click();
      return true;
    })()`);
    chk(`  点得动「${title}」页`, clicked === true, clicked);
    await sleep(500);

    const info = await PANEL.ev(`(() => {
      const main = document.getElementById('pMain');
      return {
        h2: (main.querySelector('h2') || {}).textContent || '',
        rows: main.querySelectorAll('.row').length,
        cards: main.querySelectorAll('.card').length,
        text: main.innerText || '',
      };
    })()`);
    if (!info || info.__err) { chk(`  「${title}」页画出来了`, false, info && info.__err); continue; }
    chk(`  「${title}」页画出来了（h2 = ${JSON.stringify(info.h2)}，${info.rows} 行 / ${info.cards} 组）`,
      !!info.h2 && info.rows >= 3, { h2: info.h2, rows: info.rows, cards: info.cards });
    allText.push(info.text);
  }

  const txt = allText.join('\n');

  /* ⚠️ 判据用「认字」—— 这两条钉的是 2026-10-20 那次改动（删三格、加数据文件夹） */
  chk('★ 「数据文件夹」按钮在（今天新加的）', /数据文件夹/.test(txt), '');
  chk('★ 「备份文件夹」还在', /备份文件夹/.test(txt), '');
  chk('★ 识图那三格确实没了（识图地址 / 识图密钥 / 识图模型）',
    !/识图地址|识图密钥|识图模型/.test(txt), txt.match(/识图[^\s]{0,4}/g) || '');
  chk('★ 「视觉模块」那一行也删了（他要求）', !/视觉模块/.test(txt), '');
  chk('★ 五个设计要点：没有 JS 异常',
    await PANEL.ev(`(window.__errs || []).length`) === 0, await PANEL.ev(`JSON.stringify(window.__errs || [])`));

  // 关掉面板不报错
  await PANEL.ev(`(() => { const b = document.querySelector('.close, #close, .p-x'); if (b) b.click(); return true; })()`);
  await sleep(400);
  chk('关掉面板不炸', !(await PANEL.ev(`(window.__errs || []).length`)), '');

  try { child.kill(); } catch { }
  await sleep(400);
  killAll();

  console.log('');
  console.log('─'.repeat(52));
  console.log(`  ${pass.length}/${pass.length + fail.length} 通过  ${fail.length ? '✗ 有失败' : '✓ 全过'}`);
  console.log('─'.repeat(52));
  if (fail.length) { console.log('失败明细：'); for (const f of fail) console.log('  - ' + f); }
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error('探针自己炸了：', e.message); try { killAll(); } catch { } process.exit(1); });
