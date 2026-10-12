/**
 * 探针：设置面板的「界面调试台」端到端
 *
 * 验的是**接线通不通**，自检够不着的那一段：
 *   1. 高级页最下面那颗「界面调试台」按钮在不在、点不点得动
 *   2. 点下去之后面板有没有进调试态（.card.d-on）
 *   3. 底部参数栏、区域轮廓框、拖拽把手、可编辑文字 —— 四样齐不齐
 *   4. 退出来是不是**干净还原**（class 去掉、DOM 清空、CSS 变量清空）
 *
 * ⚠️ 第 4 条最关键：他平时用的面板不能因为调试台留了尾巴而变形。
 *
 * 跑法：node scripts/probe-design.cjs   （开发版，不需要先打包）
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const HOME = path.join(os.tmpdir(), 'yachiyo-design-probe');
const PORT = 9363;

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
      return { __err: String((r.result.exceptionDetails.exception || {}).description).slice(0, 300) };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  return { ws, ev };
}

const pass = [];
const fail = [];
const chk = (name, ok, extra) => {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra !== undefined ? '   → ' + JSON.stringify(extra) : ''}`);
};

async function main() {
  killAll();
  await sleep(600);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.YACHIYO_HOME = HOME;

  const electron = require('electron');
  const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`],
    { cwd: ROOT, env, windowsHide: true });

  let mainT = null;
  for (let i = 0; i < 30 && !mainT; i++) {
    await sleep(900);
    try {
      const l = await list();
      mainT = l.find((t) => t.type === 'page' && t.url.includes('index.html'));
    } catch { /* 还没起来 */ }
  }
  if (!mainT) { console.log('✗ 主窗口起不来'); try { child.kill(); } catch { } process.exit(1); }

  const MAIN = await connect(mainT);
  await sleep(1500);

  console.log('');
  console.log('=== ① 打开设置面板 ===');
  await MAIN.ev(`window.yachiyo.ov.open('panel', {})`);
  await sleep(2500);
  let l = await list();
  const panelT = l.find((t) => t.type === 'page' && t.url.includes('panel.html'));
  if (!panelT) { console.log('✗ 设置面板没起来'); try { child.kill(); } catch { } process.exit(1); }
  const P = await connect(panelT);
  await sleep(1200);

  console.log('');
  console.log('=== ② 切到「高级」页，找那颗按钮 ===');
  const navOk = await P.ev(`(() => {
    const n = [...document.querySelectorAll('#navs .nav')].find(x => x.dataset.k === 'adv');
    if (!n) return { err: '找不到高级页导航' };
    n.click();
    return { clicked: true };
  })()`);
  chk('高级页导航点得动', !!(navOk && navOk.clicked), navOk && navOk.err);
  await sleep(900);

  const btn = await P.ev(`(() => {
    const b = [...document.querySelectorAll('#pMain .btn')].find(x => x.textContent.trim() === '界面调试台');
    if (!b) return { err: '找不到按钮', all: [...document.querySelectorAll('#pMain .btn')].map(x => x.textContent.trim()) };
    return { found: true, cls: b.className, visible: b.getBoundingClientRect().width > 0 };
  })()`);
  chk('「界面调试台」按钮存在', !!(btn && btn.found), btn && (btn.err || btn.cls));
  chk('按钮是「不起眼」款（.quiet）', !!(btn && /quiet/.test(btn.cls || '')), btn && btn.cls);

  console.log('');
  console.log('=== ③ 点开调试台 ===');
  await P.ev(`(() => { const b=[...document.querySelectorAll('#pMain .btn')].find(x=>x.textContent.trim()==='界面调试台'); if(b) b.click(); })()`);
  await sleep(1500);

  const dom = await P.ev(`(() => {
    const card = document.querySelector('.card');
    return {
      onClass: card.classList.contains('d-on'),
      bar: !!document.querySelector('.d-bar'),
      inputs: document.querySelectorAll('.d-bar input[data-vk]').length,
      btns: [...document.querySelectorAll('.d-bar .d-btn')].map(b => b.textContent.trim()),
      marks: document.querySelectorAll('.d-mark').length,
      handles: document.querySelectorAll('.d-handle').length,
      editables: document.querySelectorAll('.d-editable').length,
      varSet: card.style.getPropertyValue('--d-main-pb') || getComputedStyle(card).getPropertyValue('--d-main-pb').trim(),
    };
  })()`);
  chk('面板进了调试态 .card.d-on', !!dom.onClass, dom.onClass);
  chk('底部参数栏建出来了', !!dom.bar);
  chk('参数输入框数量对（7 条）', dom.inputs === 7, dom.inputs);
  chk('参数栏三颗按钮', dom.btns.length === 3, dom.btns);
  chk('区域轮廓框画出来了', dom.marks > 0, dom.marks);
  chk('拖拽把手在（顶栏 + 左栏）', dom.handles === 2, dom.handles);
  chk('可编辑文字挂上了', dom.editables > 0, dom.editables);

  console.log('');
  console.log('=== ④ 改一个值，看有没有真的作用到样式 ===');
  const sideBefore = await P.ev(`getComputedStyle(document.querySelector('.p-side')).width`);
  const sideAfter = await P.ev(`(() => {
    const inp = [...document.querySelectorAll('.d-bar input[data-vk]')].find(i => i.dataset.vk === '--d-side-w');
    if (!inp) return { err: '找不到左栏宽度输入框' };
    inp.value = '190';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return getComputedStyle(document.querySelector('.p-side')).width;
  })()`);
  chk('改「左栏宽度」立刻生效', sideAfter === '190px', { 改前: sideBefore, 改后: sideAfter });

  console.log('');
  console.log('=== ⑤ 导出 JSON —— 验数据结构，不只验按钮 ===');
  const json = await P.ev(`(async () => {
    const m = await import('./ui/design.js');
    return m.snapshotNow();
  })()`);
  chk('快照有「结构」段', !!(json && json.结构), json && Object.keys(json));
  chk('结构段是 7 条', !!(json && json.结构 && Object.keys(json.结构).length === 7),
    json && json.结构 && Object.keys(json.结构).length);
  chk('左栏宽度记成了刚改的 190', !!(json && json.结构 && json.结构['side-w'] === 190),
    json && json.结构 && json.结构['side-w']);
  chk('快照有「文字」段', !!(json && json.文字), json && json.文字);
  chk('文字段抓到顶栏标题', !!(json && json.文字 && json.文字['panel.title']),
    json && json.文字 && json.文字['panel.title']);

  const exp = await P.ev(`(() => {
    const b = [...document.querySelectorAll('.d-bar .d-btn')].find(x => /导出/.test(x.textContent));
    if (!b) return { err: '找不到导出按钮' };
    b.click();
    return { clicked: true };
  })()`);
  await sleep(700);
  const toast = await P.ev(`(() => { const t = document.querySelector('.d-toast'); return t ? t.textContent : null; })()`);
  chk('点导出有反馈提示', !!(exp && exp.clicked) && !!toast, toast || (exp && exp.err));

  console.log('');
  console.log('=== ⑥ 退出调试台 —— 必须干净还原 ===');
  await P.ev(`(() => { const b=[...document.querySelectorAll('.d-bar .d-btn')].find(x=>/退出/.test(x.textContent)); if(b) b.click(); })()`);
  await sleep(1200);

  const after = await P.ev(`(() => {
    const card = document.querySelector('.card');
    return {
      onClass: card.classList.contains('d-on'),
      bar: !!document.querySelector('.d-bar'),
      marks: document.querySelectorAll('.d-mark').length,
      handles: document.querySelectorAll('.d-handle').length,
      editables: document.querySelectorAll('.d-editable').length,
      inlineVars: card.getAttribute('style') || '',
      sideW: getComputedStyle(document.querySelector('.p-side')).width,
    };
  })()`);
  chk('.d-on 去掉了', !after.onClass, after.onClass);
  chk('参数栏清掉了', !after.bar);
  chk('轮廓框清掉了', after.marks === 0, after.marks);
  chk('把手清掉了', after.handles === 0, after.handles);
  chk('可编辑标记清掉了', after.editables === 0, after.editables);
  chk('内联 CSS 变量清空了', !/--d-/.test(after.inlineVars), after.inlineVars);
  chk('左栏宽度还原成 158px', after.sideW === '158px', after.sideW);

  console.log('');
  console.log(`=== 界面调试台：${pass.length} 项通过 / ${fail.length} 项失败 ===`);
  if (fail.length) { console.log('失败项：'); for (const f of fail) console.log('  ✗ ' + f); }

  try { child.kill(); } catch { }
  await sleep(900);
  killAll();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { }
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error('探针炸了：' + e.stack); killAll(); process.exit(1); });
