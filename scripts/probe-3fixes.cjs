/**
 * 2026-10-12 最后一轮的三个修复，逐个验：
 *
 *   ① 菜单窗**永远不置顶**；桌宠的置顶开关能真正落到窗口上
 *      （菜单开着时主窗口临时让位，关掉要还回去）
 *   ② 接口地址不再强绑 DeepSeek —— 测试连接必须用**他配的那个模型名**，
 *      thinking / reasoning_effort 这两个 DeepSeek 私有字段要能不发
 *   ③ 撞到屏幕边：**当场转身 + 当场进歇着**，而且不会再度撞同一面墙
 *
 * 跑法：node scripts/probe-3fixes.cjs
 * 产出：_fix-shots\*.png
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9350;
const FAKE_PORT = 8796;
const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}/v1`;
const HOME = path.join(ROOT, '_probe-fix3-home');
const OUT = path.join(ROOT, '_fix-shots');
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
  async mouse(type, x, y, button = 'none') {
    await this.send('Input.dispatchMouseEvent', {
      type, x, y, button, clickCount: 1, buttons: button === 'left' ? 1 : 0,
    });
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

async function lastReq() {
  try {
    const r = await fetch(`${FAKE_URL.replace('/v1', '')}/__last`);
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { last: null }; }
  } catch { return { last: null }; }
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

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    apiBase: FAKE_URL, apiKey: 'sk-fake',
    model: 'my-own-model-name',        // ★ 故意用一个非 DeepSeek 的名字
    petSize: 60, moveEnabled: true, roam: 'active', activity: 300,
    moveSpeed: 300, edgePauseSeconds: 1.2,
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

  const winWH = async () => m.evalJs(`return { w: window.innerWidth, h: window.innerHeight };`);

  try {
    await sleep(3000);

    /* ================= ① 置顶 ================= */
    console.log('\n[1] 菜单不置顶 / 桌宠置顶可切');

    const baseTop = await m.evalJs(`return (await window.yachiyo.win.state()).alwaysOnTop;`);
    ok(baseTop === true, '开局主窗口是置顶的（配置默认 true）', `alwaysOnTop=${baseTop}`);

    // 右键她 → 菜单
    const hit = await m.evalJs(`return window.__yachiyo.hitProbe();`);
    await m.evalJs(`window.__yachiyo.rig.locked = true; window.__yachiyo.rig.setMode('idle'); return 1;`);
    await m.mouse('mousePressed', hit.x, hit.y, 'right');
    await m.mouse('mouseReleased', hit.x, hit.y, 'right');
    const mnu = await attachOverlay('menu.html');
    ok(!!mnu, '菜单开出来了');

    const mi = await m.evalJs(`return await window.yachiyo.ov.info('menu');`);
    console.log('   菜单窗口:', JSON.stringify(mi));
    ok(mi.exists && mi.open, '菜单窗口是开着的');
    ok(mi.topmost === false, '**菜单窗口没有置顶**', `topmost=${mi.topmost}`);

    const during = await m.evalJs(`return (await window.yachiyo.win.state()).alwaysOnTop;`);
    console.log(`   菜单开着时主窗口 alwaysOnTop=${during}`);
    ok(during === false, '菜单开着时主窗口让位了（不然菜单在 z 序上会被她压住）');

    // 菜单里那个「置顶」键
    // ⚠️ 页面是异步加载的，`initMenu()` 跑完图标才进去 —— 查太早会拿到空 innerHTML，
    //    上一跑就是这么偶发红的。等到它有图标为止。
    let btn = { has: false };
    for (let i = 0; i < 20 && !btn.icon; i++) {
      btn = await mnu.evalJs(`const b = document.getElementById('tTop');
        return b ? { has: true, title: b.title, icon: (b.innerHTML || '').includes('svg') } : { has: false };`);
      if (!btn.icon) await sleep(200);
    }
    ok(btn.has && btn.icon, '菜单顶栏那颗换成了「置顶」键（有图标）', btn.title);
    const oldPause = await mnu.evalJs(`return !!document.getElementById('tPause');`);
    ok(oldPause === false, '原来的「暂停」键没了');

    // 点一下置顶键 → 配置翻 + 主窗口跟着翻
    await mnu.evalJs(`document.getElementById('tTop').click(); return 1;`);
    await sleep(700);
    const cfgTop = await m.evalJs(`return (await window.yachiyo.cfg.all()).alwaysOnTop;`);
    ok(cfgTop === false, '点一下把配置翻成了「不置顶」', `alwaysOnTop=${cfgTop}`);
    await mnu.shot('01-菜单.png', 244, 260, 2);

    // 关掉菜单 → 主窗口按配置恢复
    await m.evalJs(`window.yachiyo.ov.closeKind('menu'); return 1;`);
    await sleep(700);
    const afterClose = await m.evalJs(`return (await window.yachiyo.win.state()).alwaysOnTop;`);
    ok(afterClose === false, '关掉菜单后主窗口按**新配置**恢复（不置顶）', `alwaysOnTop=${afterClose}`);

    // 再切回置顶，验「恢复成 true」那条路
    await m.evalJs(`await window.yachiyo.cfg.set('alwaysOnTop', true); return 1;`);
    await sleep(600);
    const backTrue = await m.evalJs(`return (await window.yachiyo.win.state()).alwaysOnTop;`);
    ok(backTrue === true, '置顶再打开 → 主窗口真的置顶了', `alwaysOnTop=${backTrue}`);

    // 菜单开着→关上，主窗口该回到 true
    await m.evalJs(`window.yachiyo.ov.open('menu', { at: { x: 100, y: 100 } }); return 1;`);
    await sleep(600);
    const d2 = await m.evalJs(`return (await window.yachiyo.win.state()).alwaysOnTop;`);
    await m.evalJs(`window.yachiyo.ov.closeKind('menu'); return 1;`);
    await sleep(600);
    const a2 = await m.evalJs(`return (await window.yachiyo.win.state()).alwaysOnTop;`);
    ok(d2 === false && a2 === true, '一开一关，主窗口让位又还给它', `开=${d2} → 关=${a2}`);

    /* ================= ② 不再强绑 DeepSeek ================= */
    console.log('\n[2] 接口地址不再强绑 DeepSeek');

    const cfgModel = await m.evalJs(`return (await window.yachiyo.cfg.all()).model;`);
    console.log('   配的模型:', cfgModel);

    const ping = await m.evalJs(`return await window.yachiyo.ai.ping();`);
    ok(ping.ok === true, '测试连接通了', ping.ok ? `${ping.ms}ms` : ping.error);
    const sent = await lastReq();
    const b = sent.last?.body || {};
    console.log('   真正发出去的 model =', b.model, ' thinking =', JSON.stringify(b.thinking));
    ok(b.model === cfgModel,
      '**测试连接用的是他配的模型名**（原来写死 deepseek-reasoner，就是他报的 404）',
      `发的=${b.model} 配的=${cfgModel}`);

    // ⚠️ 默认必须是「一直发」—— 他开着思考模式，程序不能自作主张按地址猜着关掉
    ok(b.thinking?.type === 'enabled',
      '默认（一直发）→ 地址就算不是 deepseek 也照发 thinking',
      `thinking=${JSON.stringify(b.thinking)}`);
    ok(!!b.reasoning_effort, 'reasoning_effort 一起发', `effort=${b.reasoning_effort}`);
    ok(b.temperature === undefined, '这个模式下不发 temperature（老规矩）');

    // auto：看地址 —— 假服务地址不含 deepseek，所以应该不发
    await m.evalJs(`await window.yachiyo.cfg.set('thinkingStyle', 'auto'); return 1;`);
    await sleep(500);
    await m.evalJs(`return await window.yachiyo.ai.ping();`);
    const auto = (await lastReq()).last?.body || {};
    ok(auto.thinking === undefined,
      'thinkingStyle=auto + 地址不带 deepseek → 不发',
      `thinking=${JSON.stringify(auto.thinking)}`);
    ok(typeof auto.temperature === 'number', '这种时候照常发 temperature', `temperature=${auto.temperature}`);

    // off：永远不发
    await m.evalJs(`await window.yachiyo.cfg.set('thinkingStyle', 'off'); return 1;`);
    await sleep(500);
    await m.evalJs(`return await window.yachiyo.ai.ping();`);
    const off = (await lastReq()).last?.body || {};
    ok(off.thinking === undefined, 'thinkingStyle=off → 永远不发', `thinking=${JSON.stringify(off.thinking)}`);
    ok(off.model === cfgModel, '三条路都用的同一个模型名', `model=${off.model}`);

    await m.evalJs(`await window.yachiyo.cfg.set('thinkingStyle', 'always'); return 1;`);

    /* ================= ③ 撞墙 ================= */
    console.log('\n[3] 撞到屏幕边：当场转身 + 进歇着 + 不回头撞第二下');

    /*
     * ⚠️ 别瞎放。`facing === 1` 是**朝左**（原立绘朝向），1 表示往 -x 走。
     *    第一版直接 place(0)，可她要是朝右，放最左边就是「背对着墙往前走」——
     *    10 秒都撞不上，看着像「这条功能坏了」。
     *    所以先读 facing，再把她贴到**她正对着的那面墙**上。
     *    顺便 `locked = true` 把状态机按住，她不会半路坐下。
     */
    const edgeInfo = await m.evalJs(`
      const r = window.__yachiyo.rig;
      r.locked = true;
      r.state.enter('walk');                 // 强制走起来（别等状态机骰）
      const f = window.__yachiyo.facing;
      window.__yachiyo.place(f === 1 ? 0 : 1e9);   // 1e9 会被 clamp 到最右边
      return { facing: f, x: +window.__yachiyo.pos.x.toFixed(1) };`);
    console.log(`   先把状态机按住进 walk，facing=${edgeInfo.facing}（1=朝左），放在 x=${edgeInfo.x}`);
    await sleep(200);

    // 高频采样，抓住撞上那一瞬间
    const track = [];
    for (let i = 0; i < 260; i++) {
      const s = await m.evalJs(`
        return { x: +window.__yachiyo.pos.x.toFixed(1),
                 mode: window.__yachiyo.rig.mode,
                 facing: window.__yachiyo.facing,
                 moving: window.__yachiyo.moving };`);
      track.push({ t: i * 40, ...s });
      await sleep(40);
    }

    // 找出「贴边」的帧：x≈0 或 x≈maxX
    const maxX = await m.evalJs(`
      const s = await window.yachiyo.win.screen();
      return Math.max(0, s.workArea.width - window.__yachiyo.size);`);
    const atEdge = (s) => s.x <= 0.6 || s.x >= maxX - 0.6;

    const hits = [];
    for (let i = 1; i < track.length; i++) {
      if (atEdge(track[i]) && !atEdge(track[i - 1]) && track[i - 1].moving) hits.push(i);
    }
    console.log(`   采了 ${track.length} 帧 · 撞边 ${hits.length} 次 · 她最远走到 x=${Math.max(...track.map((s) => s.x))}`);
    ok(hits.length >= 1, '观察期内她确实撞到了边（这条是基线）', `${hits.length} 次`);

    if (hits.length) {
      const h = hits[0];
      const prev = track[h - 1], at = track[h], next = track[h + 1] || track[h];
      console.log(`   撞上那一下: x ${prev.x}(moving=${prev.moving},facing=${prev.facing})` +
                  ` → x ${at.x}(facing=${at.facing},mode=${at.mode},moving=${at.moving})`);
      ok(at.facing === -prev.facing, '撞上那一刻**当场转身**了', `facing ${prev.facing} → ${at.facing}`);
      ok(at.mode === 'idle' || next.mode === 'idle',
        '撞上之后进「歇着」（不是还挂着 walk）', `mode ${prev.mode} → ${at.mode} → ${next.mode}`);
      ok(at.moving === false, '那一刻就不再往前挪了', `moving=${at.moving}`);

      // 「不会再度就近撞墙」：撞完之后，在「歇着」那段时间里不该再撞同一面
      const restMs = 1200;      // 配置里 edgePauseSeconds = 1.2
      const again = hits.slice(1).find((i) => track[i].t - track[h].t < restMs);
      ok(!again, '**没有立刻又撞同一面墙**',
        again ? `撞后 ${track[again].t - track[h].t}ms 又撞了` : `${hits.length} 次撞墙之间都隔开了`);

      // 转身之后是往离开墙的方向走
      const later = track.slice(h + 3, h + 14).filter((s) => s.moving);
      if (later.length) {
        const awayFromLeft = prev.x <= 1;
        const away = awayFromLeft
          ? later.every((s) => s.x >= at.x - 1)
          : later.every((s) => s.x <= at.x + 1);
        ok(away, '转身之后是往**离开墙**的方向走的',
          `${awayFromLeft ? '左' : '右'}墙 · 后续 x：${later.map((s) => s.x).join(' ')}`);
      }
    }

    const win = await winWH();
    await m.shot('02-撞墙后.png', win.w, win.h, 1.5);
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
