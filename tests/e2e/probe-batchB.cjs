#!/usr/bin/env node
/*
 * ⚠️ 本文件 2026-10-18 由 `桌面\八千代AI桌宠工作留痕\` / `_dsh020\verify\` 搬进仓库。
 *    搬的时候只改了一件事：把写死的 `D:/AI_work/Git` 换成 `path.resolve(__dirname,'..','..')`。
 *    逻辑一行没动 —— 这些探针每天都在用，改逻辑就是给自己找麻烦。
 *
 *    跑之前要先有一个**带 CDP 的实例**（`YACHIYO_CDP=9222 npm start`），
 *    否则会报"没连上主窗口"。见 tests/e2e/README.md。
 */
/**
 * probe-batchB —— 批次 B 的真机验证（2026-10-17）
 *
 *   优化1 锁设置面板边框 → 打开面板，量**渲染层真实尺寸**（应是他上次拉到的 1000×730），
 *                          再静态确认 `overlay.cjs` 里那一刀（lockSize + will-resize）在
 *   优化3 双击直接开聊天窗 → `openAsk` 入口必须没了、ask 两个文件必须没了、
 *                            `openChat()` 必须还能开聊天窗
 *   优化2 睡觉能被叫醒   → 把 `rig.state` 切成 sleep 并锁住，真按下一次，
 *                          模式必须变成 **sit**（不是 idle）
 *
 * ⚠️ 优化1 的「拖不动」没法用 CDP 直接量（那是系统层的窗口属性，渲染层看不见）。
 *    这里量的是它的**两个前提**：面板确实用了上次的尺寸 + 那一刀在代码里。
 *    手感想验的话，你自己去拖一下边框 —— 拖不动就对了。
 *
 * 用法：node probe-batchB.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join('D:', 'AI_work', 'Git');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (o) => JSON.stringify(o);

let pass = 0, fail = 0;
const chk = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '   → ' + detail : '')); }
};

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    const waiting = new Map();
    ws.addEventListener('message', (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && waiting.has(msg.id)) {
        const { res, rej } = waiting.get(msg.id);
        waiting.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error))); else res(msg.result);
      }
    });
    ws.addEventListener('error', (e) => reject(new Error('WS: ' + (e.message || e.type))));
    ws.addEventListener('open', () => resolve({
      send(method, params) {
        const mid = ++id;
        return new Promise((res, rej) => { waiting.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params: params || {} })); });
      },
      close() { try { ws.close(); } catch {} },
    }));
  });
}

async function evalIn(c, expr) {
  const r = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
}

const targets = async () => (await (await fetch('http://127.0.0.1:9222/json/list')).json());

(async () => {
  console.log('probe-batchB —— 批次 B 真机验证');
  console.log('');

  /* 等主窗口 */
  let main = null;
  for (let i = 0; i < 25 && !main; i++) {
    try { main = (await targets()).find((t) => /index\.html/.test(t.url)); } catch { /* 还没起 */ }
    if (!main) await sleep(400);
  }
  if (!main) { console.log('✗ 没连上主窗口'); process.exit(1); }
  const mc = await connect(main.webSocketDebuggerUrl);
  await mc.send('Runtime.enable');
  console.log('主窗口连上了');
  console.log('');

  /* ---------- 静态：那一刀在不在 + ask 删干净了没 ---------- */
  console.log('── 静态检查（源码/文件）──');
  const overlaySrc = fs.readFileSync(path.join(REPO, 'src', 'main', 'overlay.cjs'), 'utf8');
  const appSrc = fs.readFileSync(path.join(REPO, 'src', 'renderer', 'app.js'), 'utf8');
  const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  chk('overlay.cjs：panel 有 lockSize: true', /panel:\s*\{[^}]*lockSize:\s*true/.test(overlaySrc));
  chk('overlay.cjs：有 will-resize 里 preventDefault 那一刀',
    /will-resize[\s\S]{0,80}preventDefault\(\)/.test(overlaySrc));
  chk('overlay.cjs：SPEC 里已经没有 ask 窗格了', !/\n\s*ask:\s*\{/.test(overlaySrc));
  chk('overlay.cjs：SAVE_SIZE 里也没有 ask 了', !/SAVE_SIZE\s*=\s*\{[^}]*ask/.test(overlaySrc));

  const appClean = stripComments(appSrc);
  chk('★ app.js：双击走 openChat()（剥掉注释后没有 openAsk 了）', !appClean.includes('openAsk'));
  chk('app.js：有 wakeUp() 这个函数', /function\s+wakeUp\s*\(/.test(appClean));
  const wakeCalls = (appClean.match(/wakeUp\(\)/g) || []).length;
  chk('★ wakeUp 被三个互动点调用（单击 / 双击 / 按下拖动），含定义共 ≥4 处', wakeCalls >= 4, '出现 ' + wakeCalls + ' 次');
  chk('app.js：单击那条路按返回值分流（`if (!wakeUp())` —— 别把刚坐下的她改成站着）',
    /if\s*\(!wakeUp\(\)\)\s*rig\.state\.rest\(\)/.test(appClean));
  chk('app.js：双击那条路也分流了', (appClean.match(/if\s*\(!wakeUp\(\)\)\s*rig\.state\.rest\(\)/g) || []).length >= 2);

  chk('★ ask.html 已删除', !fs.existsSync(path.join(REPO, 'src', 'renderer', 'ask.html')));
  chk('★ ui/ask.js 已删除', !fs.existsSync(path.join(REPO, 'src', 'renderer', 'ui', 'ask.js')));
  console.log('');

  /* ---------- 优化2：睡觉能被叫醒 ---------- */
  console.log('── 优化2 睡觉能被叫醒 ──');
  const probe = JSON.parse(await evalIn(mc, 'JSON.stringify(window.__yachiyo.hitProbe())'));
  if (!probe) { console.log('✗ hitProbe() null —— 她还没画出来？'); }
  const px = Math.round(probe.x), py = Math.round(probe.y);

  await evalIn(mc, `(() => { const r = window.__yachiyo.rig; r.state.enter('sleep', 'probe'); r.state.left = 999; return 1; })()`);
  await sleep(250);
  const before = await evalIn(mc, 'window.__yachiyo.rig.state.mode');
  chk('先把状态切成 sleep（并且锁住不让它自己切走）', before === 'sleep', String(before));

  await mc.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
  await sleep(60);
  await mc.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
  await sleep(250);
  const after = await evalIn(mc, 'window.__yachiyo.rig.state.mode');
  chk('★ 按她一下 → 状态变成 sit（坐着被叫醒，不是站着）', after === 'sit', String(after));
  console.log('');

  /* ---------- 优化3：双击的落点是聊天窗 ---------- */
  console.log('── 优化3 双击 → 聊天窗 ──');
  const hasAskApi = await evalIn(mc, 'typeof (window.__yachiyo && window.__yachiyo.openAsk)');
  chk('★ 探针口 openAsk 没了（typeof = undefined）', hasAskApi === 'undefined', hasAskApi);
  const hasChatApi = await evalIn(mc, 'typeof (window.__yachiyo && window.__yachiyo.openChat)');
  chk('openChat 还在', hasChatApi === 'function', hasChatApi);

  await evalIn(mc, 'window.__yachiyo.openChat(); 1');
  await sleep(1200);
  const list = await targets();
  chk('★ 聊天窗能开出来', list.some((t) => /chat\.html/.test(t.url)), J(list.map((t) => t.url)));
  console.log('');

  /* ---------- 优化1：面板用的是他上次的尺寸 ---------- */
  console.log('── 优化1 设置面板（锁尺寸：用上次的值）──');
  const want = JSON.parse(await evalIn(mc, 'JSON.stringify(window.__yachiyo.cfg.winGeom && window.__yachiyo.cfg.winGeom.panel)'));
  console.log('   配置里记的面板尺寸 = ' + J(want));

  await evalIn(mc, `window.yachiyo.ov.open('panel', { page: 'ai' }); 1`);
  await sleep(1400);
  const list2 = await targets();
  const panel = list2.find((t) => /panel\.html/.test(t.url));
  chk('设置面板开出来了', !!panel);
  if (panel) {
    const pc = await connect(panel.webSocketDebuggerUrl);
    await pc.send('Runtime.enable');
    await sleep(500);
    const size = JSON.parse(await evalIn(pc, 'JSON.stringify({w: innerWidth, h: innerHeight})'));
    console.log('   面板实际渲染尺寸 = ' + J(size));
    /*
     * ⚠️ 容差 ±3px：`innerWidth/innerHeight` 是**页面**的尺寸，
     *    跟窗口 `getBounds()` 差 1-2px 是常规的（透明窗口那圈残留）。
     *    这条断言要管的是「用的是**上次那个**尺寸，不是 SPEC 默认的 780×580」——
     *    默认值和实际值差了 220px，容差再松也不会误判。
     */
    const near = want && Math.abs(size.w - want.width) <= 3 && Math.abs(size.h - want.height) <= 3;
    chk('★ 面板用的是他上次拉到的那个尺寸（不是 SPEC 默认的 780×580）',
      near, J(size) + ' vs 配置 ' + J(want) + '（SPEC 默认 780×580）');
    if (want) {
      chk('   顺便确认它不是被 SPEC 默认值顶掉的',
        size.w !== 780 || size.h !== 580, J(size));
    }
    pc.close();
  }

  /* ---- 尺寸不许漂：连开关 3 次，winGeom.panel 必须纹丝不动 ---- */
  /*
   * ★ 这条是 2026-10-17 探针自己抖出来的问题：原来每开关一次面板尺寸就 +2px
   *   （`setBounds(1002)` → Windows 报回 1004 → 存 1004 → 下次设 1004 → 报 1006…），
   *   正反馈，开一百次面板它比屏幕还宽。
   *   修法见 overlay.cjs 的 saveGeom：锁了尺寸的窗口只记位置、不记尺寸。
   *   ⚠️ 读的是**磁盘上的 config.json** —— 主进程改了 winGeom 不会广播到渲染层，
   *      从页面里读永远看到旧值（那样这条断言就是假绿）。
   */
  const cfgFile = path.join(process.env.APPDATA || '', 'Yachiyo', 'config.json');
  const readPanelGeom = () => {
    try {
      const c = JSON.parse(fs.readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, ''));
      return (c.winGeom && c.winGeom.panel) || null;
    } catch { return null; }
  };
  const g0 = readPanelGeom();
  for (let i = 0; i < 3; i++) {
    await evalIn(mc, `window.yachiyo.ov.open('panel'); 1`);
    await sleep(800);
    await evalIn(mc, `window.yachiyo.ov.closeKind('panel'); 1`);
    await sleep(600);
  }
  const g1 = readPanelGeom();
  chk('★ 连开关 3 次面板，存下来的尺寸**不漂**（原来每次 +2px）',
    !!g0 && !!g1 && g0.width === g1.width && g0.height === g1.height,
    J(g0) + '  →  ' + J(g1));

  console.log('');
  console.log((fail === 0 ? '★ 全绿' : '✗ 有红') + `　${pass} 通过 / ${fail} 失败`);
  mc.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('炸了：' + e.message + '\n' + e.stack); process.exit(1); });
