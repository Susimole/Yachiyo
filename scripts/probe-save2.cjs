/**
 * 配置落盘审计 · 第二轮 —— **用真鼠标真键盘点界面**，不直接调 cfg.set。
 *
 * 第一轮（probe-save.cjs）直接调 `cfg.set()`，15/15 全过 ——
 * 那只证明了「存储那条路是通的」，证明不了「界面上的每个控件都会去调它」。
 *
 * 这一轮换成 CDP 的 Input 域：点开关、拖滑块、输入框里打字再点别处让它失焦……
 * 跟真人操作走同一条路。改完正常退出，再把 config.json 读回来对账。
 *
 * 跑法：node scripts/probe-save2.cjs
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9354;
const HOME = path.join(ROOT, '_probe-save2-home');
const FILE = path.join(HOME, 'config.json');
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
  static async attach(urlPart) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    const p = urlPart
      ? pages.find((t) => (t.url || '').includes(urlPart))
      : pages.find((t) => !/(menu|panel|chat|ask)\.html/.test(t.url || ''));
    if (!p) throw new Error('没找到 target（想要 ' + (urlPart || '主窗口') + '）');
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连不上')), { once: true });
    });
    const c = new CDP(ws);
    await c.send('Runtime.enable');
    try { await c.send('Page.enable'); } catch { /* 有的 target 不给 Page */ }
    return c;
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pend.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pend.has(id)) { this.pend.delete(id); rej(new Error(method + ' 超时')); } }, 15000);
    });
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  }
  /* ---- 真输入 ---- */
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  }
  /** 点一下输入框、全选、打字、再点别处让它失焦（就是真人的操作顺序） */
  async typeInto(x, y, text, blurAt) {
    await this.click(x, y);
    await sleep(120);
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 2, key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await sleep(60);
    await this.send('Input.insertText', { text });
    await sleep(120);
    await this.click(blurAt.x, blurAt.y);   // 失焦 → change 事件
    await sleep(200);
  }
  /** 在滑块轨道上按一个比例点一下（range 会同时发 input + change） */
  async dragRange(x0, y0, w, frac) {
    await this.click(Math.round(x0 + w * frac), y0);
    await sleep(250);
  }
}

let child = null;
const fail = [];
const ok = (cond, msg, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '   ' + extra : ''}`);
  if (!cond) fail.push(msg);
};
const readCfg = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };

async function killElectron() {
  try { child?.kill(); } catch { /* 没了 */ }
  try {
    execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\')}*' } | ` +
      'ForEach-Object { $_.Kill() }"', { stdio: 'ignore' });
  } catch { /* 干净退了 */ }
}

/**
 * 找到某一行的控件，**先滚进可视区**再量坐标。
 *
 * ⚠️⚠️ 2026-10-12 我自己的探针栽在这上面：`#pMain` 是个滚动区，
 *    一页 20 行、可视高度只有 550px，**底下那些行根本不在视口里**。
 *    `getBoundingClientRect()` 照样会给出一个 y=900 这样的坐标，
 *    `Input.dispatchMouseEvent` 送到那个点就是**空气** ——
 *    不报错、不生效，看着像「这个控件存不住配置」。
 *    实测第一版：7 个控件里 5 个「失败」，全是这一条造成的假警报。
 */
const FIND_ROW = (labelStart) => `
  const row = [...document.querySelectorAll('#pMain .row')]
    .find((r) => r.querySelector('.label')?.textContent.startsWith(${JSON.stringify(labelStart)}));
  if (!row) return { err: '没有这一行：' + ${JSON.stringify(labelStart)} };
  row.scrollIntoView({ block: 'center' });
  await new Promise((r) => setTimeout(r, 250));   // 等滚动落定再量
  const el = row.querySelector('.sw, input, .seg button, .swatch') || row.querySelector('.body > *');
  if (!el) return { err: '这一行里没有控件' };
  const r = el.getBoundingClientRect();
  const box = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  // 量完再确认一眼它真的落在视口里 —— 不然就是白点一下
  const inView = box.x > 0 && box.y > 0 && box.x < window.innerWidth && box.y < window.innerHeight;
  return { ...box, inView, tag: el.tagName, cls: el.className, type: el.type,
           value: el.value, text: (el.textContent || '').trim().slice(0, 20) };
`;

/** 在正文里点一个不碰任何控件的空白处（让输入框失焦） */
const BLANK = `const m = document.getElementById('pMain');
  const r = m.getBoundingClientRect();
  return { x: Math.round(r.left + 6), y: Math.round(r.top + m.clientHeight - 24) };`;

async function main() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({}, null, 2), 'utf8');

  await killElectron();
  await sleep(500);

  child = spawn(electronPath, [`--remote-debugging-port=${CDP_PORT}`, ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, YACHIYO_MS: String(RUN_MS), YACHIYO_HOME: HOME },
    stdio: 'ignore',
  });

  let m = null;
  for (let i = 0; i < 50 && !m; i++) { await sleep(500); try { m = await CDP.attach(); } catch { /* 还没起来 */ } }
  if (!m) { await killElectron(); throw new Error('Electron 没起来'); }

  const want = {};
  const drove = [];

  try {
    await sleep(3000);
    await m.evalJs(`window.yachiyo.ov.open('panel', { page: 'habit' }); return 1;`);

    let p = null;
    for (let i = 0; i < 25 && !p; i++) { await sleep(200); try { p = await CDP.attach('panel.html'); } catch { /* */ } }
    ok(!!p, '设置面板开出来了');
    if (!p) throw new Error('没有面板没法往下测');

    const blank = await p.evalJs(BLANK);
    console.log(`\n失焦用的空白点：(${blank.x}, ${blank.y})`);

    /* ---- 开关 ---- */
    console.log('\n[1] 开关（点一下）');
    {
      const el = await p.evalJs(FIND_ROW('总在最前'));
      if (el.err || !el.inView) { ok(false, '找到「总在最前」那一行', el.err || '滚进来了但坐标还在视口外'); }
      else {
        await p.click(el.x, el.y);
        await sleep(400);
        const v = await m.evalJs(`return (await window.yachiyo.cfg.all()).alwaysOnTop;`);
        want.alwaysOnTop = v;
        ok(v === false, '点一下 → 配置变了', `alwaysOnTop=${v}`);
        drove.push('sw/alwaysOnTop');
      }
    }

    /* ---- 分段按钮 ---- */
    console.log('\n[2] 分段按钮（点「深色」）');
    {
      const el = await p.evalJs(`
        const row = [...document.querySelectorAll('#pMain .row')]
          .find((r) => r.querySelector('.label')?.textContent.startsWith('深浅色'));
        if (!row) return { err: '没有「深浅色」那一行' };
        const b = [...row.querySelectorAll('.seg button')].find((x) => x.textContent.trim() === '深色');
        if (!b) return { err: '没有「深色」按钮' };
        row.scrollIntoView({ block: 'center' });
        await new Promise((r) => setTimeout(r, 250));
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                 inView: r.top > 0 && r.bottom < window.innerHeight };
      `);
      if (el.err || !el.inView) { ok(false, '找到「深色」按钮', el.err || '视口外'); }
      else {
        await p.click(el.x, el.y);
        await sleep(600);
        const v = await m.evalJs(`return (await window.yachiyo.cfg.all()).theme;`);
        want.theme = v;
        ok(v === 'dark', '选了深色 → 配置变了', `theme=${v}`);
        drove.push('seg/theme');
      }
    }

    /* ---- 滑块（点轨道，不拖） ---- */
    console.log('\n[3] 滑块（在轨道上点一下）');
    {
      // 深色切完页面会重画，重新找
      await p.evalJs(`document.querySelector('#navs .nav[data-k="habit"]').click(); return 1;`);
      await sleep(500);
      const el = await p.evalJs(FIND_ROW('桌宠大小'));
      if (el.err || !el.inView) { ok(false, '找到「桌宠大小」那一行', el.err || '视口外'); }
      else {
        const before = await m.evalJs(`return (await window.yachiyo.cfg.all()).petSize;`);
        await p.dragRange(el.x - Math.round(el.w / 2), el.y, el.w, 0.75);
        const v = await m.evalJs(`return (await window.yachiyo.cfg.all()).petSize;`);
        want.petSize = v;
        ok(v !== before, '滑块动过之后配置跟着变了', `${before} → ${v}`);
        drove.push('range/petSize');
      }
    }

    /* ---- 数字输入框 ---- */
    console.log('\n[4] 数字输入框（打字 → 点别处失焦）');
    {
      await m.evalJs(`window.yachiyo.ov.open('panel', { page: 'ai' }); return 1;`);
      await sleep(900);
      const el = await p.evalJs(FIND_ROW('输入单价'));
      if (el.err || !el.inView) { ok(false, '找到「输入单价」那一行', el.err || '视口外'); }
      else {
        const blank2 = await p.evalJs(BLANK);
        const before = await m.evalJs(`return (await window.yachiyo.cfg.all()).priceIn;`);
        await p.typeInto(el.x, el.y, '3.33', blank2);
        const v = await m.evalJs(`return (await window.yachiyo.cfg.all()).priceIn;`);
        want.priceIn = v;
        ok(v === 3.33, '数字框打完字点别处 → 存下来了', `priceIn ${before} → ${v}`);
        drove.push('num/priceIn');
      }
    }

    /* ---- 文本输入框 ---- */
    console.log('\n[5] 文本输入框（打字 → 点别处失焦）');
    {
      const el = await p.evalJs(FIND_ROW('接口地址'));
      if (el.err || !el.inView) { ok(false, '找到「接口地址」那一行', el.err || '视口外'); }
      else {
        const blank2 = await p.evalJs(BLANK);
        const before = await m.evalJs(`return (await window.yachiyo.cfg.all()).apiBase;`);
        await p.typeInto(el.x, el.y, 'https://example.test/v1', blank2);
        const v = await m.evalJs(`return (await window.yachiyo.cfg.all()).apiBase;`);
        want.apiBase = v;
        ok(v === 'https://example.test/v1', '文本框打完字点别处 → 存下来了', `${before} → ${v}`);
        drove.push('text/apiBase');
      }
    }

    /* ---- 下拉 ---- */
    console.log('\n[6] 下拉（用键盘选）');
    {
      const el = await p.evalJs(`
        const row = [...document.querySelectorAll('#pMain .row')]
          .find((r) => r.querySelector('.label')?.textContent.startsWith('思考参数'));
        if (!row) return { err: '没有「思考参数」那一行' };
        const s = row.querySelector('select');
        if (!s) return { err: '这一行里没有 select' };
        row.scrollIntoView({ block: 'center' });
        await new Promise((r) => setTimeout(r, 250));
        const r = s.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                 inView: r.top > 0 && r.bottom < window.innerHeight, value: s.value };
      `);
      if (el.err || !el.inView) { ok(false, '找到「思考参数」下拉', el.err || '视口外'); }
      else {
        // 直接用键盘：点开 → 按 ↓ → 回车（原生 select 认这个）
        await p.click(el.x, el.y);
        await sleep(250);
        await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40 });
        await p.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await p.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await sleep(400);
        const v = await m.evalJs(`return (await window.yachiyo.cfg.all()).thinkingStyle;`);
        want.thinkingStyle = v;
        ok(v !== el.value, '下拉选过之后配置变了', `${el.value} → ${v}`);
        drove.push('sel/thinkingStyle');
      }
    }

    /* ---- 色卡 ---- */
    console.log('\n[7] 色卡（点第二颗）');
    {
      await m.evalJs(`window.yachiyo.ov.open('panel', { page: 'habit' }); return 1;`);
      await sleep(900);
      const el = await p.evalJs(`
        const row = [...document.querySelectorAll('#pMain .row')]
          .find((r) => r.querySelector('.label')?.textContent.startsWith('主题色'));
        if (!row) return { err: '没有「主题色」那一行' };
        const sw = row.querySelectorAll('.swatch');
        if (sw.length < 2) return { err: '色卡不够两颗' };
        row.scrollIntoView({ block: 'center' });
        await new Promise((r) => setTimeout(r, 250));
        const r = sw[1].getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                 inView: r.top > 0 && r.bottom < window.innerHeight };
      `);
      if (el.err || !el.inView) { ok(false, '找到色卡', el.err || '视口外'); }
      else {
        const before = await m.evalJs(`return (await window.yachiyo.cfg.all()).accent;`);
        await p.click(el.x, el.y);
        await sleep(500);
        const v = await m.evalJs(`return (await window.yachiyo.cfg.all()).accent;`);
        want.accent = v;
        ok(v !== before, '点了色卡 → 配置变了', `${before} → ${v}`);
        drove.push('colors/accent');
      }
    }

    console.log(`\n   一共驱动了 ${drove.length} 个控件：${drove.join('  ')}`);

    /* ---- 退出，再对账 ---- */
    console.log('\n[8] 正常退出，重新读盘对账');
    await m.evalJs(`window.yachiyo.win.quit(); return 1;`);
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const n = Number(execSync(
        'powershell -NoProfile -Command "@(Get-Process electron -ErrorAction SilentlyContinue).Count"',
        { encoding: 'utf8' }).trim()) || 0;
      if (n === 0) { console.log(`   进程退干净了（${(i + 1) * 300}ms）`); break; }
    }

    const onDisk = readCfg();
    const miss = [];
    for (const [k, v] of Object.entries(want)) {
      const same = JSON.stringify(onDisk[k]) === JSON.stringify(v);
      if (!same) miss.push(k);
      console.log(`   ${same ? '✓' : '✗'} ${k.padEnd(14)} 退出前 ${JSON.stringify(v).padEnd(22)} 盘上 ${JSON.stringify(onDisk[k])}`);
    }
    ok(miss.length === 0, '界面改过的每一项都活到了退出之后',
      miss.length ? `没存住的：${miss.join(' ')}` : `${Object.keys(want).length} 项全对`);
  } finally {
    await killElectron();
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
}

main().catch(async (e) => { console.error(e); await killElectron(); process.exit(1); });
