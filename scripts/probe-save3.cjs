/**
 * 配置落盘审计 · 第三轮 —— **重启之后还在不在**。
 *
 * 前两轮验的是「写进文件了没有」，都过了。
 * 可他说的原话是「需要在**退出时**保存」——那件事的验收标准其实是
 * **重新打开还认不认**：文件里写着、启动时没读回来，对他就是「没保存」。
 *
 * 所以这一跑：开机 → 用真鼠标改一圈 → 退出 → **再开一次** → 对账
 *   · 应用内存里的值（cfg.all()）
 *   · 界面控件上显示的值（对得上才算数）
 *
 * 跑法：node scripts/probe-save3.cjs
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9356;
const HOME = path.join(ROOT, '_probe-save3-home');
const FILE = path.join(HOME, 'config.json');
const RUN_MS = Number(process.env.PROBE_MS || 200000);

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
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
  }
}

let child = null;
const ok = (cond, msg, extra) => console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '   ' + extra : ''}`);
const allOk = { v: true };
const check = (cond, msg, extra) => { ok(cond, msg, extra); if (!cond) allOk.v = false; };

async function killElectron() {
  try { child?.kill(); } catch { /* 没了 */ }
  try {
    execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\')}*' } | ` +
      'ForEach-Object { $_.Kill() }"', { stdio: 'ignore' });
  } catch { /* 干净退了 */ }
}

async function boot(tag) {
  child = spawn(electronPath, [`--remote-debugging-port=${CDP_PORT}`, ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, YACHIYO_MS: String(RUN_MS), YACHIYO_HOME: HOME },
    stdio: 'ignore',
  });
  let m = null;
  for (let i = 0; i < 50 && !m; i++) { await sleep(500); try { m = await CDP.attach(); } catch { /* 还没起来 */ } }
  if (!m) throw new Error(`${tag}：Electron 没起来`);
  await sleep(3000);
  return m;
}

async function quit(m) {
  try { await m.evalJs(`window.yachiyo.win.quit(); return 1;`); } catch { /* 窗口已经在关了 */ }
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    const n = Number(execSync(
      'powershell -NoProfile -Command "@(Get-Process electron -ErrorAction SilentlyContinue).Count"',
      { encoding: 'utf8' }).trim()) || 0;
    if (n === 0) return true;
  }
  return false;
}

/** 界面上的控件现在显示的是什么 */
const UI_SNAPSHOT = `
  const out = {};
  const val = (id) => { const e = document.getElementById(id); return e ? e.value : null; };
  // 面板里的几个代表
  const rowVal = (label) => {
    const r = [...document.querySelectorAll('#pMain .row')]
      .find((x) => x.querySelector('.label')?.textContent.startsWith(label));
    if (!r) return null;
    const sw = r.querySelector('.sw'); if (sw) return sw.classList.contains('on');
    const inp = r.querySelector('input'); if (inp) return inp.value;
    const sel = r.querySelector('select'); if (sel) return sel.value;
    const seg = r.querySelector('.seg button.on'); if (seg) return seg.textContent.trim();
    return null;
  };
  out.alwaysOnTop = rowVal('总在最前');
  out.theme = rowVal('深浅色');
  out.petSize = rowVal('桌宠大小');
  out.transitionMs = rowVal('站坐过渡');
  out.accent = (() => {
    const hex = document.querySelector('#pMain .cwrap .hex');
    return hex ? hex.textContent.trim() : null;
  })();
  out.bodyDark = document.body.classList.contains('dark');
  return out;
`;

async function main() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({}, null, 2), 'utf8');
  await killElectron();
  await sleep(500);

  /* ============ 第一次开机：改一圈 ============ */
  console.log('\n[1] 第一次开机 —— 用真鼠标改一圈');
  let m = await boot('第一次');
  const want = {};

  try {
    // 先记下原始值
    const before = await m.evalJs(`return await window.yachiyo.cfg.all();`);
    console.log('   原始：', JSON.stringify({
      theme: before.theme, alwaysOnTop: before.alwaysOnTop,
      petSize: before.petSize, accent: before.accent, transitionMs: before.transitionMs }));

    await m.evalJs(`window.yachiyo.ov.open('panel', { page: 'habit' }); return 1;`);
    let p = null;
    for (let i = 0; i < 25 && !p; i++) { await sleep(200); try { p = await CDP.attach('panel.html'); } catch { /* */ } }
    if (!p) throw new Error('面板没开出来');

    // 面板这边：滚进可视区 + 点
    const clickRow = async (label, pick) => {
      const el = await p.evalJs(`
        const row = [...document.querySelectorAll('#pMain .row')]
          .find((r) => r.querySelector('.label')?.textContent.startsWith(${JSON.stringify(label)}));
        if (!row) return { err: '没有这一行' };
        row.scrollIntoView({ block: 'center' });
        await new Promise((r) => setTimeout(r, 250));
        const el = ${pick};
        if (!el) return { err: '控件没找到' };
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
                 w: Math.round(r.width),
                 inView: r.top > 0 && r.bottom < window.innerHeight };
      `);
      if (el.err || !el.inView) throw new Error(`${label}：${el.err || '不在视口里'}`);
      return el;
    };

    // ① 开关：总在最前 → 关
    // ⚠️ 这里**先别往 want 里写** —— 下面的菜单按钮测的也是同一个键，
    //    一 key 记两个值，对账的时候必然有一个对不上（第一版就是这么翻的）。
    //    只用局部变量接中间值，最后那个才是要验的。
    let panelTop = null;
    {
      const el = await clickRow('总在最前', `row.querySelector('.sw')`);
      await p.click(el.x, el.y);
      await sleep(400);
      panelTop = await m.evalJs(`return (await window.yachiyo.cfg.all()).alwaysOnTop;`);
      check(panelTop === false, '面板上改了「总在最前」', `alwaysOnTop=${panelTop}`);
    }
    // ② 深色
    {
      const el = await clickRow('深浅色', `[...row.querySelectorAll('.seg button')].find((b) => b.textContent.trim() === '深色')`);
      await p.click(el.x, el.y);
      await sleep(700);
      want.theme = await m.evalJs(`return (await window.yachiyo.cfg.all()).theme;`);
      check(want.theme === 'dark', '改了「深浅色」', `theme=${want.theme}`);
    }
    // ③ 滑块（切深色会重画整页，重新找）
    {
      await p.evalJs(`document.querySelector('#navs .nav[data-k="habit"]').click(); return 1;`);
      await sleep(600);
      const el = await clickRow('桌宠大小', `row.querySelector('input[type=range]')`);
      await p.click(Math.round(el.x + el.w * 0.3), el.y);
      await sleep(400);
      want.petSize = await m.evalJs(`return (await window.yachiyo.cfg.all()).petSize;`);
      check(want.petSize !== before.petSize, '拖了「桌宠大小」', `${before.petSize} → ${want.petSize}`);
    }
    // ④ 色卡
    {
      const el = await clickRow('主题色', `row.querySelectorAll('.swatch')[2]`);
      await p.click(el.x, el.y);
      await sleep(500);
      want.accent = await m.evalJs(`return (await window.yachiyo.cfg.all()).accent;`);
      check(!!want.accent, '点了「主题色」色卡', `accent=${want.accent}`);
    }
    // ⑤ 站坐过渡
    {
      const el = await clickRow('站坐过渡', `row.querySelector('input[type=range]')`);
      await p.click(Math.round(el.x + el.w * 0.2), el.y);
      await sleep(400);
      want.transitionMs = await m.evalJs(`return (await window.yachiyo.cfg.all()).transitionMs;`);
      check(want.transitionMs !== before.transitionMs, '拖了「站坐过渡」', `${before.transitionMs} → ${want.transitionMs}`);
    }

    // ⑥ 菜单窗里那个置顶键（真点）
    {
      await m.evalJs(`window.yachiyo.ov.closeKind('panel'); return 1;`);
      await sleep(300);
      const hit = await m.evalJs(`return window.__yachiyo.hitProbe();`);
      await m.evalJs(`window.__yachiyo.rig.locked = true; window.__yachiyo.rig.setMode('idle'); return 1;`);
      await m.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: hit.x, y: hit.y, button: 'right', clickCount: 1, buttons: 2 });
      await m.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: hit.x, y: hit.y, button: 'right', clickCount: 1, buttons: 0 });
      let mnu = null;
      for (let i = 0; i < 20 && !mnu; i++) { await sleep(200); try { mnu = await CDP.attach('menu.html'); } catch { /* */ } }
      if (mnu) {
        await sleep(400);
        const b = await mnu.evalJs(`const e = document.getElementById('tTop'); const r = e.getBoundingClientRect();
          return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };`);
        await mnu.click(b.x, b.y);
        await sleep(600);
        const menuTop = await m.evalJs(`return (await window.yachiyo.cfg.all()).alwaysOnTop;`);
        check(menuTop !== panelTop, '点了菜单里的「置顶」键，值真的反过来了',
          `面板改成 ${panelTop} → 菜单又点回 ${menuTop}`);
        want.alwaysOnTop = menuTop;      // ← 最终值才算数
      } else {
        check(false, '菜单开出来了');
      }
    }

    console.log('\n   改完这一圈，内存里是：', JSON.stringify(want));

    /* ============ 退出 ============ */
    console.log('\n[2] 正常退出');
    const clean = await quit(m);
    check(clean, '进程退干净了');
    const onDisk = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const [k, v] of Object.entries(want)) {
      check(JSON.stringify(onDisk[k]) === JSON.stringify(v), `退出的那一刻 ${k} 在盘上`, `盘上 ${JSON.stringify(onDisk[k])}`);
    }

    /* ============ 再开一次 ============ */
    console.log('\n[3] **重新打开** —— 这才叫「保存住了」');
    child = null;
    await sleep(800);
    m = await boot('第二次');

    const after = await m.evalJs(`return await window.yachiyo.cfg.all();`);
    console.log('   重启后内存里：', JSON.stringify(
      Object.fromEntries(Object.keys(want).map((k) => [k, after[k]]))));
    for (const [k, v] of Object.entries(want)) {
      check(JSON.stringify(after[k]) === JSON.stringify(v), `重启后 ${k} 还是那个值`,
        `${JSON.stringify(after[k])}${JSON.stringify(after[k]) === JSON.stringify(v) ? '' : ' ≠ ' + JSON.stringify(v)}`);
    }

    // 界面显示的那一份也要对 —— 文件里对、界面上显示默认值，对他来说一样是「没保存」
    await m.evalJs(`window.yachiyo.ov.open('panel', { page: 'habit' }); return 1;`);
    let p2 = null;
    for (let i = 0; i < 25 && !p2; i++) { await sleep(200); try { p2 = await CDP.attach('panel.html'); } catch { /* */ } }
    if (p2) {
      await sleep(900);
      const ui = await p2.evalJs(UI_SNAPSHOT);
      console.log('   重启后面板上显示的：', JSON.stringify(ui));
      check(ui.alwaysOnTop === want.alwaysOnTop, '面板上「总在最前」显示的是新值', `${ui.alwaysOnTop}`);
      check(ui.theme === (want.theme === 'dark' ? '深色' : '浅色'), '面板上「深浅色」显示的是新值', `${ui.theme}`);
      check(String(ui.petSize) === String(want.petSize), '面板上「桌宠大小」显示的是新值', `${ui.petSize}`);
      check(ui.bodyDark === (want.theme === 'dark'), '面板自己的主题也跟着', `body.dark=${ui.bodyDark}`);
    } else {
      check(false, '第二次也能开面板');
    }
  } finally {
    await killElectron();
  }

  console.log(`\n==== ${allOk.v ? '✓ 全过' : '✗ 有没过'} ====`);
  if (!allOk.v) process.exitCode = 1;
}

main().catch(async (e) => { console.error(e); await killElectron(); process.exit(1); });
