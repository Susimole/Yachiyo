/*
 * ⚠️ 本文件 2026-10-18 由 `桌面\八千代AI桌宠工作留痕\` / `_dsh020\verify\` 搬进仓库。
 *    搬的时候只改了一件事：把写死的 `D:/AI_work/Git` 换成 `path.resolve(__dirname,'..','..')`。
 *    逻辑一行没动 —— 这些探针每天都在用，改逻辑就是给自己找麻烦。
 *
 *    跑之前要先有一个**带 CDP 的实例**（`YACHIYO_CDP=9222 npm start`），
 *    否则会报"没连上主窗口"。见 tests/e2e/README.md。
 */
/**
 * 探针：打包版里 icon.ico 到底**加载出来**没有
 *
 * ⚠️ 为什么不能只看「文件在不在」：
 *     `find dist/ -name '*.ico'` 只能证明**文件被拷进去了**，
 *     证明不了 Chromium 真把它渲染出来了。
 *     `<img>` 加载失败**不报错**，只是 naturalWidth 变成 0 ——
 *     跟"修复前"从外表看一模一样。必须量 naturalWidth。
 *
 * 验的地方（正是他报失效的几处）：
 *     主窗口 / 右键菜单 / 设置面板（标题栏 + 左下角）/ 聊天窗 / 提问窗
 *
 * 跑法：node scripts/probe-ico.cjs      （需要先 npx electron-builder --win --dir）
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const EXE = path.join(__dirname, '..', 'dist', 'win-unpacked', 'Yachiyo.exe');
const HOME = path.join(os.tmpdir(), 'yachiyo-ico-probe');
const PORT = 9361;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killAll() {
  try {
    execSync('powershell.exe -NoProfile -Command "Get-Process Yachiyo -ErrorAction SilentlyContinue | Stop-Process -Force"',
      { stdio: 'ignore', windowsHide: true });
  } catch { /* 没进程正好 */ }
}

const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

async function main() {
  if (!fs.existsSync(EXE)) {
    console.log('✗ 找不到打包版：' + EXE + '\n  先跑 npx electron-builder --win --dir');
    process.exit(1);
  }

  killAll();
  await sleep(600);

  const env = { ...process.env };
  // ⚠️ 这俩会污染 Electron 启动（FACT.md 第 6 条）
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.YACHIYO_HOME = HOME;

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, windowsHide: true });

  let targets = [];
  for (let i = 0; i < 25; i++) {
    await sleep(800);
    try { targets = await list(); if (targets.some((t) => t.type === 'page')) break; } catch { }
  }
  const mainT = targets.find((t) => t.type === 'page');
  if (!mainT) { console.log('✗ 打包版没起来'); try { child.kill(); } catch { } process.exit(1); }

  // 每个 target 开一个自己的 CDP 连接 —— 比 session 简单，浮层各自独立很合适
  const conn = new Map();   // targetId -> {ws, send, ev}
  const connect = async (t) => {
    if (conn.has(t.id)) return conn.get(t.id);
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
    const send = (method, params = {}) => new Promise((res) => {
      const id = ++seq; pending.set(id, res);
      ws.send(JSON.stringify({ id, method, params }));
    });
    const ev = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result && r.result.exceptionDetails) {
        return { __err: String((r.result.exceptionDetails.exception || {}).description).slice(0, 200) };
      }
      return r.result && r.result.result ? r.result.result.value : undefined;
    };
    const o = { ws, send, ev, t };
    conn.set(t.id, o);
    return o;
  };

  const measure = async (t, label) => {
    const c = await connect(t);
    await sleep(1500);   // 给图片解码留时间
    const rows = await c.ev(`(() => {
      const out = [];
      document.querySelectorAll('img').forEach((im) => {
        out.push({ src: im.getAttribute('src') || '', cls: im.className,
                   naturalW: im.naturalWidth, naturalH: im.naturalHeight,
                   shown: Math.round(im.getBoundingClientRect().width) });
      });
      return out;
    })()`);
    if (rows && rows.__err) return { label, err: rows.__err };
    return { label, url: t.url.split('/').pop(), rows: rows || [] };
  };

  const results = [];
  const MAIN = await connect(mainT);

  // ① 主窗口
  results.push(await measure(mainT, '主窗口 index.html'));

  // ② 逐个叫起浮层（走的是跟用户右键**同一条** IPC 路）
  const OVERLAYS = [
    { kind: 'menu', file: 'menu.html', label: '右键菜单' },
    { kind: 'panel', file: 'panel.html', label: '设置面板' },
    { kind: 'chat', file: 'chat.html', label: '聊天窗' },
  ];
  for (const ov of OVERLAYS) {
    const r = await MAIN.ev(`window.yachiyo.ov.open(${JSON.stringify(ov.kind)}, {})`);
    await sleep(2000);
    const all = await list();
    const t = all.find((x) => x.type === 'page' && x.url.includes(ov.file));
    if (!t) { results.push({ label: ov.label + ' (' + ov.file + ')', err: '窗口没起来: ' + JSON.stringify(r) }); continue; }
    results.push(await measure(t, ov.label + ' (' + ov.file + ')'));
    const c = await connect(t);
    await c.ev(`window.yachiyo && window.yachiyo.ov.close()`);
    await sleep(700);
  }

  // ---- 报告 ----
  console.log('');
  console.log('=== icon.ico 加载实测（naturalWidth=0 就是没显示出来）===');
  let ok = 0, bad = 0;
  for (const r of results) {
    console.log('');
    console.log('【' + r.label + '】');
    if (r.err) { console.log('  ✗ ' + r.err); bad++; continue; }
    if (!r.rows.length) { console.log('  （没有 img 元素）'); continue; }
    for (const im of r.rows) {
      const isIco = /icon\.ico/.test(im.src);
      const pass = im.naturalW > 0;
      if (isIco) { pass ? ok++ : bad++; }
      console.log(`  ${isIco ? (pass ? '✓' : '✗') : '·'} ${im.cls || '(无 class)'}` +
        `  natural=${im.naturalW}x${im.naturalH}  显示宽=${im.shown}px  src=${im.src}`);
    }
  }
  console.log('');
  console.log(`=== icon.ico：${ok} 处正常 / ${bad} 处失败 ===`);
  console.log(bad === 0 && ok > 0 ? '★ 全过 —— 打包版的菜单图标修好了' : '⚠️ 还有没加载出来的');

  try { child.kill(); } catch { }
  await sleep(900);
  killAll();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { }
  process.exit(bad === 0 && ok > 0 ? 0 : 1);
}

main().catch((e) => { console.error('探针炸了：' + e.stack); killAll(); process.exit(1); });
