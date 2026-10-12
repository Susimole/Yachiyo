/**
 * 2026-10-12 第二批的验收：
 *   ① 关掉「桌宠移动」→ 她只该在 歇着 / 坐下 / 睡觉 里挑，**脚不许再动**
 *   ② 「检测模型」按钮 → 问出地址上的模型清单、能点选、当前那个对不上要报警
 *
 * 走本地假模型（scripts/fake-llm.cjs），它会回一个 GET /models。
 * 跑法：node scripts/probe-settings2.cjs
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9346;
const FAKE_PORT = 8794;
const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}/v1`;
const HOME = path.join(ROOT, '_probe-set2-home');
const OUT = path.join(ROOT, '_set2-shots');
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
  async shot(file, w, h, scale = 1.5) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale } });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  }
}

async function attachOverlay(part, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try { return await CDP.attach(part); } catch { await sleep(150); }
  }
  return null;
}

let fakeProc = null, child = null;
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

/** 画布的「下三分之一」里不透明像素的数量 —— 脚在那儿，脚动它就变 */
const FOOT_SIG = `
  const c = document.getElementById('pet');
  const g = c.getContext('2d', { willReadFrequently: true });
  const W = c.width, H = c.height;
  const d = g.getImageData(0, Math.floor(H * 0.62), W, Math.floor(H * 0.38)).data;
  let n = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 40) n++;
  return n;
`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    apiBase: FAKE_URL, apiKey: 'sk-fake', model: 'deepseek-flash',
    petSize: 100, roam: 'active', activity: 300, moveEnabled: true,
  }, null, 2), 'utf8');

  fakeProc = spawn(process.execPath, [path.join(__dirname, 'fake-llm.cjs'), String(FAKE_PORT)], { stdio: 'ignore' });
  await sleep(700);
  await killElectron();
  await sleep(500);

  child = spawn(electronPath, [`--remote-debugging-port=${CDP_PORT}`, ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, YACHIYO_MS: String(RUN_MS), YACHIYO_HOME: HOME },
    stdio: 'ignore',
  });

  let m = null;
  for (let i = 0; i < 50 && !m; i++) { await sleep(500); try { m = await CDP.attach(); } catch { /* 还没起来 */ } }
  if (!m) { await killElectron(); try { fakeProc.kill(); } catch { /* */ } throw new Error('Electron 没起来'); }

  try {
    await sleep(3000);

    /* ============ ① 关掉移动 ============ */
    console.log('\n[1] 关掉「桌宠移动」→ 只有 歇着 / 坐下 / 睡觉');

    // 先确认开着的时候她**确实会走**（不然下面那条是真也可以通过）
    await m.evalJs(`window.__yachiyo.rig.locked = false; return 1;`);
    const seenOn = new Set();
    for (let i = 0; i < 55; i++) {
      seenOn.add(await m.evalJs(`return window.__yachiyo.rig.mode;`));
      await sleep(300);
    }
    console.log('   开着移动时见过的状态:', [...seenOn].join(' / '));
    ok(seenOn.has('walk') || seenOn.has('run'), '开着的时候她确实会走（这条是基线）', [...seenOn].join(' '));

    // 关掉
    await m.evalJs(`await window.yachiyo.cfg.set('moveEnabled', false); return 1;`);
    await sleep(1500);

    const rightAfter = await m.evalJs(`return { mode: window.__yachiyo.rig.mode,
      allow: window.__yachiyo.rig.state.allowMove };`);
    ok(rightAfter.allow === false, '状态机收到「不许走」了', `allowMove=${rightAfter.allow}`);
    ok(rightAfter.mode === 'idle', '关掉那一瞬间她当场站住（不是等这一轮走完）', `mode=${rightAfter.mode}`);

    // 盯一段时间：状态只能是那三个
    const seenOff = new Set();
    const sigs = [];
    for (let i = 0; i < 70; i++) {
      const s = await m.evalJs(`return { mode: window.__yachiyo.rig.mode, sig: (() => { ${FOOT_SIG} })() };`);
      seenOff.add(s.mode);
      if (s.mode === 'idle') sigs.push(s.sig);
      await sleep(250);
    }
    console.log('   关掉移动后见过的状态:', [...seenOff].join(' / '));
    const bad = [...seenOff].filter((x) => !['idle', 'sit', 'sleep'].includes(x));
    ok(bad.length === 0, '一个走/跑/跳都没再出现过', bad.length ? '出现了：' + bad.join(',') : [...seenOff].join(' '));

    // 脚不许动：idle 期间下半张图的像素数应该基本恒定
    if (sigs.length >= 6) {
      const mn = Math.min(...sigs), mx = Math.max(...sigs);
      const range = (mx - mn) / (mn || 1);
      ok(range < 0.03, '脚是站住的（下半张图逐帧几乎不变）',
        `${mn}~${mx}，波动 ${(range * 100).toFixed(2)}%（呼吸带来的几像素不算）`);
    } else {
      ok(false, '脚是站住的 —— 采样不够（idle 帧只有 ' + sigs.length + ' 个）');
    }

    await m.shot('01-关掉移动.png', (await m.evalJs(`return window.innerWidth;`)), (await m.evalJs(`return window.innerHeight;`)), 1.5);

    // 开回去
    await m.evalJs(`await window.yachiyo.cfg.set('moveEnabled', true); return 1;`);
    await sleep(800);
    const back = await m.evalJs(`return window.__yachiyo.rig.state.allowMove;`);
    ok(back === true, '再打开开关能恢复', `allowMove=${back}`);

    /* ============ ② 检测模型 ============ */
    console.log('\n[2] 「检测模型」按钮');
    await m.evalJs(`await window.yachiyo.ov.open('panel', { page: 'ai' }); return 1;`);
    await sleep(1500);
    const pnl = await attachOverlay('panel.html');
    ok(!!pnl, '设置面板开出来了');
    if (!pnl) throw new Error('没有面板就没法往下测');

    const hasBtn = await pnl.evalJs(`return !!document.getElementById('aiMdBtn');`);
    ok(hasBtn, 'AI 页上有「检测模型」按钮');

    const before = await pnl.evalJs(`
      return { chips: document.querySelectorAll('#aiMdList .mchip').length,
               modelInputs: [...document.querySelectorAll('#pMain .row')]
                 .filter(r => r.querySelector('.label')?.textContent.startsWith('模型'))
                 .map(r => { const i = r.querySelector('input'); return i ? { list: i.getAttribute('list'), type: i.type } : null; }) };
    `);
    console.log('   点之前:', JSON.stringify(before));

    await pnl.evalJs(`document.getElementById('aiMdBtn').click(); return 1;`);
    await sleep(2500);

    const after = await pnl.evalJs(`
      const chips = [...document.querySelectorAll('#aiMdList .mchip')].map(b => b.textContent.trim());
      const on = [...document.querySelectorAll('#aiMdList .mchip.on')].map(b => b.textContent.trim());
      const dl = [...(document.getElementById('aiModelList')?.options || [])].map(o => o.value);
      return { out: document.getElementById('aiMdOut').textContent,
               chips, on, dl,
               tips: [...document.querySelectorAll('#aiMdList .kv')].map(e => e.textContent.trim()) };
    `);
    console.log('   结果:', after.out);
    console.log('   清单:', after.chips.join(' / '));
    console.log('   提示:', after.tips.join(' | '));

    ok(after.chips.length === 4, '把假服务的 4 个模型都列出来了', after.chips.join(','));
    ok(after.on.length === 1 && after.on[0] === 'deepseek-flash', '当前用的那个被标出来了', after.on.join(','));
    ok(after.dl.length === 4, '候选灌进了「模型」输入框的 datalist', after.dl.join(','));
    ok(/在清单里/.test(after.tips.join(' ')), '说了「当前这个在清单里」');
    ok(/不一定能用|测试连接/.test(after.tips.join(' ')), '提醒了「列出来 ≠ 能用」（这两件事不一样）');
    await pnl.shot('02-检测模型.png', 780, 580, 1.5);

    // 点一个别的 → 配置要跟着变
    await pnl.evalJs(`
      [...document.querySelectorAll('#aiMdList .mchip')].find(b => b.textContent.trim() === 'deepseek-reasoner').click();
      return 1;
    `);
    await sleep(700);
    const picked = await m.evalJs(`return (await window.yachiyo.cfg.all()).model;`);
    ok(picked === 'deepseek-reasoner', '点一下就把模型换过去了', `model=${picked}`);
    const inpVal = await pnl.evalJs(`
      return [...document.querySelectorAll('#pMain .row')]
        .find(r => r.querySelector('.label')?.textContent.startsWith('模型'))?.querySelector('input')?.value;
    `);
    ok(inpVal === 'deepseek-reasoner', '上面那个输入框跟着同步了', `input=${inpVal}`);

    // 名字写错 → 要红字报警
    await pnl.evalJs(`await window.yachiyo.cfg.set('model', 'deepseek-typo-xxx'); return 1;`);
    await sleep(500);
    await pnl.evalJs(`document.getElementById('aiMdBtn').click(); return 1;`);
    await sleep(2500);
    const warn = await pnl.evalJs(`
      const kv = [...document.querySelectorAll('#aiMdList .kv')];
      const w = kv.find(e => /拼错/.test(e.textContent));
      return { text: w?.textContent || '', color: w ? getComputedStyle(w).color : '' };
    `);
    console.log('   写错名字时:', warn.text, warn.color);
    ok(/拼错/.test(warn.text), '模型名不在清单里时会明确指出来', warn.text);
    await pnl.shot('03-名字写错.png', 780, 580, 1.5);

    // 没填 Key → 要说人话，不能崩
    await pnl.evalJs(`await window.yachiyo.cfg.set('apiKey', ''); return 1;`);
    await sleep(500);
    const noKey = await pnl.evalJs(`
      const r = await window.yachiyo.ai.models();
      return r;
    `);
    ok(noKey.ok === false && /Key/.test(noKey.error), '没填 Key 时给的是人话', noKey.error);
  } finally {
    await killElectron();
    try { fakeProc.kill(); } catch { /* 没起来 */ }
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
}

main().catch(async (e) => {
  console.error(e);
  await killElectron();
  try { fakeProc?.kill(); } catch { /* */ }
  process.exit(1);
});
