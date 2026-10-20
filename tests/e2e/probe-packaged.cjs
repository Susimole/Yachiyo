/*
 * ⚠️ 本文件 2026-10-18 由 `桌面\八千代AI桌宠工作留痕\` / `_dsh020\verify\` 搬进仓库。
 *    搬的时候只改了一件事：把写死的 `D:/AI_work/Git` 换成 `path.resolve(__dirname,'..','..')`。
 *    逻辑一行没动 —— 这些探针每天都在用，改逻辑就是给自己找麻烦。
 *
 *    跑之前要先有一个**带 CDP 的实例**（`YACHIYO_CDP=9222 npm start`），
 *    否则会报"没连上主窗口"。见 tests/e2e/README.md。
 */
/**
 * 探针：**打包版该有的有、该没的没**
 *
 * 这个探针回答的是「装给别人的那个版本，跟开发版差在哪」——
 * 开发版好用不等于打包版好用，两边最容易在**路径**和**标志**上分叉：
 *
 *   ① `icon.ico` 加载得出来吗（打包时 files 段排错过一次，图标全瞎）
 *   ② `window.yachiyo.dev` = false、探针口**不存在**（别给正式版留后门）
 *   ③ 高级页**没有**「界面调试台」那颗按钮（他明确要求：不能打包进去）
 *   ④ 窗口起得来、API 桥 10 个键齐
 *
 * 跑法：node scripts/probe-packaged.cjs
 *       （需要先 `npx electron-builder --win --dir`）
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const EXE = path.join(__dirname, '..', '..', 'dist', 'win-unpacked', 'Yachiyo.exe');
const HOME = path.join(os.tmpdir(), 'yachiyo-pkg-probe');
const PORT = 9385;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killAll() {
  try {
    execSync('powershell.exe -NoProfile -Command "Get-Process Yachiyo,electron -ErrorAction SilentlyContinue | Stop-Process -Force"',
      { stdio: 'ignore', windowsHide: true });
  } catch { /* 没进程正好 */ }
}

const pass = [], fail = [];
const chk = (name, ok, extra) => {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra !== undefined ? '   → ' + JSON.stringify(extra) : ''}`);
};

/** 每个 target 一个 CDP 连接；返回一个 ev(expression) 函数 */
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
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
  return async (expression) => {
    const id = ++seq;
    const p = new Promise((r) => pending.set(id, r));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    const r = await p;
    if (r.result && r.result.exceptionDetails) {
      return { __err: String((r.result.exceptionDetails.exception || {}).description).slice(0, 200) };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.log('✗ 找不到打包版：' + EXE);
    console.log('  先跑 npx electron-builder --win --dir');
    process.exit(1);
  }

  killAll();
  await sleep(800);

  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;          // ⚠️ 不摘这个，打包版退出码 9
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.YACHIYO_HOME = HOME;

  const child = spawn(EXE, [`--remote-debugging-port=${PORT}`], { env, windowsHide: true });
  const list = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };

  let mainT = null;
  for (let i = 0; i < 25 && !mainT; i++) {
    await sleep(800);
    mainT = (await list()).find((t) => t.type === 'page' && t.url.includes('index.html'));
  }
  if (!mainT) { console.log('✗ 打包版起不来'); try { child.kill(); } catch { } process.exit(1); }

  const M = await connect(mainT.webSocketDebuggerUrl);
  await sleep(1800);

  console.log('');
  console.log('=== ① API 桥 ===');
  const keys = await M('Object.getOwnPropertyNames(window.yachiyo||{}).join(",")');
  /*
   * ⚠️ 2026-10-21 修判据（**不是产品 bug**）：原来把整串键名写死（当时 10 个），
   *    后来加了 `providers` / `vision` 就永远红 —— 可"多一个键"不等于坏了。
   *    ⇒ 改成**按名字验该在的都在**，多出来的不管（那才是正常的演进）。
   */
  {
    const have = String(keys || '').split(',').filter(Boolean);
    const need = ['dev', 'cfg', 'win', 'chat', 'font', 'usage', 'weather', 'ai', 'rig', 'ov', 'on', 'pet'];
    const miss = need.filter((k) => !have.includes(k));
    chk('window.yachiyo 在，该有的键都在（' + need.length + ' 个，实测共 ' + have.length + ' 个）',
      miss.length === 0, miss.length ? ('缺：' + miss.join(',')) : keys);
  }

  console.log('');
  console.log('=== ② 正式版不许有后门 ===');
  const dev = await M('window.yachiyo && window.yachiyo.dev');
  chk('yachiyo.dev === false', dev === false, dev);
  const probe = await M('typeof ((window.yachiyo||{}).ov||{})._probe');
  chk('探针口 _probe 不存在', probe === 'undefined', probe);
  const slp = await M('typeof ((window.yachiyo||{}).ov||{})._sleep');
  chk('探针口 _sleep 不存在', slp === 'undefined', slp);
  /*
   * ⚠️ 这条的**预期在 2026-10-17 反过来了**（原来写的是「ov.design 仍在（无害，无入口）」）。
   *
   *    第 38 轮修 `#29` 时，`ov` 那一整块（design / designSave / _probe /
   *    _sleep / _isSleeping / probeRaise / probeBounds）都被并进了
   *    `preload.cjs` 的 `...(DEV ? {…})` ⇒ **正式版里一个都不存在**。
   *    而这条探针的判据还停在"它应该还在"上，于是打完包就报红
   *    （实测 `typeof …ov.design` = "undefined"，比原来还干净）。
   *    ⇒ 现在跟 `selfcheck-gate` 一个口径：**正式版里它就是不该在**。
   *    ⚠️ 这也说明：探针在仓库外，改了源码没人跑它，判据就会悄悄过期。
   */
  const dsn = await M('typeof ((window.yachiyo||{}).ov||{}).design');
  chk('（附）ov.design 在正式版里不存在（#29 把它并进 DEV 块了）', dsn === 'undefined', dsn);

  console.log('');
  console.log('=== ③ 打开设置面板 ===');
  await M(`window.yachiyo.ov.open('panel', {})`);
  await sleep(2500);
  const panelT = (await list()).find((t) => t.type === 'page' && t.url.includes('panel.html'));
  if (!panelT) { console.log('✗ 面板没起来'); try { child.kill(); } catch { } process.exit(1); }
  const P = await connect(panelT.webSocketDebuggerUrl);
  await sleep(1200);

  // ★ 顺带把图标也验了（他上一轮报的就是这个）
  const imgs = await P(`[...document.querySelectorAll('img')].map(im => ({
     cls: im.className, w: im.naturalWidth, src: im.getAttribute('src')||''
  }))`);
  const icoBad = (imgs || []).filter((i) => /icon\.ico/.test(i.src) && !(i.w > 0));
  const icoOk = (imgs || []).filter((i) => /icon\.ico/.test(i.src) && i.w > 0);
  chk(`设置面板里的 icon.ico 正常（${icoOk.length} 处）`, icoBad.length === 0 && icoOk.length > 0,
    icoBad.length ? icoBad : icoOk.map((i) => i.cls));

  console.log('');
  console.log('=== ④ 高级页不该有「界面调试台」===');
  await P(`(() => { const n = [...document.querySelectorAll('#navs .nav')].find(x => x.dataset.k === 'adv'); if (n) n.click(); })()`);
  await sleep(1000);
  const r = await P(`(() => {
    const btns = [...document.querySelectorAll('#pMain .btn')].map(b => b.textContent.trim());
    const last = document.querySelector('#pMain .group:last-of-type .g-title');
    return { btns, hasDesign: btns.includes('界面调试台'), lastGroup: last ? last.textContent.trim() : '' };
  })()`);
  chk('没有「界面调试台」按钮', r && r.hasDesign === false, r && r.btns);
  chk('最后一组不是「界面调试」', r && r.lastGroup !== '界面调试', r && r.lastGroup);

  console.log('');
  console.log(`=== 打包版：${pass.length} 项通过 / ${fail.length} 项失败 ===`);
  if (fail.length) { console.log('失败项：'); for (const f of fail) console.log('  ✗ ' + f); }

  try { child.kill(); } catch { }
  await sleep(900);
  killAll();
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { }
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error('探针炸了：' + e.stack); killAll(); process.exit(1); });
