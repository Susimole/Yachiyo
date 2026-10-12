/**
 * 配置落盘审计 —— 2026-10-12。
 *
 * 他报的：「用户变动的菜单配置项需要在退出时保存，有些项我看貌似是不会保存的」。
 *
 * 这个探针**不猜**：挨个改一遍（菜单改的、面板改的、托盘改的），
 * 然后把 config.json 从磁盘上读回来，一项一项对。
 *
 * ⚠️ 关键：改完之后要**真的退出一次**再读盘 —— 他说的就是「退出时保存」，
 *    光看改完当下的文件是不作数的（可能是退出那一步把它覆盖了）。
 *
 * 跑法：node scripts/probe-save.cjs
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9352;
const HOME = path.join(ROOT, '_probe-save-home');
const FILE = path.join(HOME, 'config.json');
const RUN_MS = Number(process.env.PROBE_MS || 120000);

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
}

async function attachOverlay(part, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try { return await CDP.attach(part); } catch { await sleep(150); }
  }
  return null;
}

let child = null;
const fail = [];
const ok = (cond, msg, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '   ' + extra : ''}`);
  if (!cond) fail.push(msg);
};

async function killElectron() {
  try { child?.kill(); } catch { /* 没了 */ }
  try {
    execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\')}*' } | ` +
      'ForEach-Object { $_.Kill() }"', { stdio: 'ignore' });
  } catch { /* 干净退了 */ }
}

const readCfg = () => {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
};

/** 这一跑想验的每一项：键 → 改成什么 */
const WANT = {
  // —— 菜单里那几个开关 ——
  sound: false,
  moveEnabled: false,
  alwaysOnTop: false,
  // —— 菜单里没有、只能从设置面板改的 ——
  theme: 'dark',
  petSize: 155,
  bubbleW: 444,
  transitionMs: 260,
  currency: 'usd',
  thinkingStyle: 'off',
  roam: 'quiet',
  memShort: false,
  typo: false,
  fpsLimit: 30,
  weatherVoice: 'own',
  soundVolume: 0.42,          // ← 故意挑一个「面板上没有」的键，看它会不会被丢掉
};

async function main() {
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ moveSpeed: 100 }, null, 2), 'utf8');

  await killElectron();
  await sleep(500);

  child = spawn(electronPath, [`--remote-debugging-port=${CDP_PORT}`, ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, YACHIYO_MS: String(RUN_MS), YACHIYO_HOME: HOME },
    stdio: 'ignore',
  });

  let m = null;
  for (let i = 0; i < 50 && !m; i++) { await sleep(500); try { m = await CDP.attach(); } catch { /* 还没起来 */ } }
  if (!m) { await killElectron(); throw new Error('Electron 没起来'); }

  try {
    await sleep(3000);

    console.log('\n[1] 从**菜单窗**改（走的是浮层那条 IPC）');
    await m.evalJs(`window.yachiyo.ov.open('menu', { at: { x: 200, y: 200 } }); return 1;`);
    const mnu = await attachOverlay('menu.html');
    ok(!!mnu, '菜单开出来了');
    if (mnu) {
      await sleep(400);
      const r = await mnu.evalJs(`
        const c = window.yachiyo.cfg;
        await c.set('sound', false);
        await c.set('moveEnabled', false);
        await c.set('alwaysOnTop', false);
        return await c.all();
      `);
      console.log('   改完页面拿到的值:', JSON.stringify({
        sound: r.sound, moveEnabled: r.moveEnabled, alwaysOnTop: r.alwaysOnTop }));
    }

    console.log('\n[2] 从**设置面板**改');
    await m.evalJs(`window.yachiyo.ov.open('panel', { page: 'habit' }); return 1;`);
    const pnl = await attachOverlay('panel.html');
    ok(!!pnl, '面板开出来了');
    if (pnl) {
      await sleep(600);
      const r = await pnl.evalJs(`
        const c = window.yachiyo.cfg;
        for (const [k, v] of ${JSON.stringify(Object.entries(WANT))}) await c.set(k, v);
        return await c.all();
      `);
      console.log('   改完页面拿到的值:', JSON.stringify(
        Object.fromEntries(Object.keys(WANT).map((k) => [k, r[k]]))));
    }

    // ---- 改完**当下**先读一次盘 ----
    const rightAfter = readCfg();
    console.log('\n[3] 改完当下，磁盘上是什么');
    const missNow = Object.entries(WANT).filter(([k, v]) => JSON.stringify(rightAfter[k]) !== JSON.stringify(v));
    ok(missNow.length === 0, '改完那一刻就该全部落盘（cfg.set 是同步写文件的）',
      missNow.length ? '没落的：' + missNow.map(([k, v]) => `${k}(盘上=${JSON.stringify(rightAfter[k])} 想要=${JSON.stringify(v)})`).join(' ') : `${Object.keys(WANT).length} 项全在`);

    // ---- 干净退出 ----
    console.log('\n[4] 走**正常退出**（⏻ 那条路），再看盘');
    await m.evalJs(`window.yachiyo.win.quit(); return 1;`);
    for (let i = 0; i < 60; i++) {
      await sleep(300);
      const n = Number(execSync(
        'powershell -NoProfile -Command "@(Get-Process electron -ErrorAction SilentlyContinue).Count"',
        { encoding: 'utf8' }).trim()) || 0;
      if (n === 0) { console.log('   进程已退干净（' + ((i + 1) * 300) + 'ms）'); break; }
    }

    const after = readCfg();
    console.log('\n[5] 退出之后逐项对账');
    const miss = [];
    for (const [k, v] of Object.entries(WANT)) {
      const got = after[k];
      const same = JSON.stringify(got) === JSON.stringify(v);
      if (!same) miss.push([k, v, got]);
      console.log(`   ${same ? '✓' : '✗'} ${k.padEnd(14)} 想要 ${JSON.stringify(v).padEnd(10)} 盘上 ${JSON.stringify(got)}`);
    }
    ok(miss.length === 0, '退出之后全都还在',
      miss.length ? `丢了 ${miss.length} 项：${miss.map(([k]) => k).join(' ')}` : `${Object.keys(WANT).length} 项全对`);

    // 有没有被「退出时的某一步」覆盖掉
    const before = JSON.stringify(rightAfter), aft = JSON.stringify(after);
    ok(before === aft, '退出这一步没有改动配置（说明不是退出时被覆盖）',
      before === aft ? '' : '改完当下和退出之后不一样 —— 退出那一步动了它');
  } finally {
    await killElectron();
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
}

main().catch(async (e) => { console.error(e); await killElectron(); process.exit(1); });
