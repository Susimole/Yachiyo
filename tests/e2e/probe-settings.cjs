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

  /* ══════════ ⑥ 调色盘：点小方块弹出来，圆点能拖（2026-10-21） ══════════
     他原话：「我需要的仅仅是最初唤出的调色板的小圆点可拖动实时变色而已」
     ⇒ 面板上只留一颗小方块，点它才弹；弹出来那块板里的圆点必须能拖、且**实时**变色。 */
  console.log('');
  console.log('【调色盘：点小方块才弹，圆点拖得动】');
  const drag = await PANEL.ev(`(async () => {
    const nav = document.querySelector('#navs .nav[data-k="habit"]');
    if (nav) nav.click();
    await new Promise(r => setTimeout(r, 300));
    const sq = document.querySelector('#pMain .picksq');
    if (!sq) return { err: '面板上没有 .picksq 小方块' };
    const hexEl = sq.closest('.cwrap') ? sq.closest('.cwrap').querySelector('.hex') : null;
    const before = hexEl ? hexEl.textContent : '';
    sq.click();
    await new Promise(r => setTimeout(r, 250));
    const pal = document.querySelector('.pal-pop .pal');
    if (!pal) return { err: '点了小方块但没弹出调色板' };
    const sv = pal.querySelector('.pal-sv');
    const r = sv.getBoundingClientRect();
    const at = (fx, fy) => ({ clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, bubbles: true, pointerId: 1 });
    const seen = [];
    sv.dispatchEvent(new PointerEvent('pointerdown', at(0.8, 0.2)));
    for (const [fx, fy] of [[0.85, 0.35], [0.9, 0.6], [0.95, 0.8]]) {
      sv.dispatchEvent(new PointerEvent('pointermove', at(fx, fy)));
      await new Promise(r2 => setTimeout(r2, 60));
      if (hexEl) seen.push(hexEl.textContent);
    }
    sv.dispatchEvent(new PointerEvent('pointerup', at(0.95, 0.8)));
    await new Promise(r => setTimeout(r, 350));
    let saved = '';
    try { const c = await window.yachiyo.cfg.all(); saved = String(c && c.accent || ''); } catch { /* 读不到就算了 */ }
    return { before, seen, after: hexEl ? hexEl.textContent : '', saved, popup: true,
             w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  chk('★ 面板上是一颗小方块（不是把调色板摊在页面里）', !!drag && !drag.err, drag && (drag.err || 'ok'));
  chk('★ 点一下小方块 → 弹出调色板', !!drag && drag.popup === true, drag && drag.err);
  chk('  弹出的板有尺寸（0 宽 0 高就点不到）', !!drag && drag.w > 40 && drag.h > 40, drag && [drag.w, drag.h]);
  chk('★ **拖动中每一帧都在实时变色**（不是松手才变）',
    !!drag && Array.isArray(drag.seen) && drag.seen.length === 3
      && drag.seen[0] !== drag.seen[1] && drag.seen[1] !== drag.seen[2], drag && drag.seen);
  /*
   * ★ 2026-10-21：色相条是**竖的**，必须"上下拖"才变色。
   *   第一版我把它当横的（用 clientX 算），拖着上下没反应 —— 他当场看出来了。
   *   这条钉的就是横竖：固定 x 只改 y，颜色必须变。
   */
  const hue = await PANEL.ev(`(async () => {
    const sq = document.querySelector('#pMain .picksq');
    const hexEl = sq && sq.closest('.cwrap') ? sq.closest('.cwrap').querySelector('.hex') : null;
    if (!document.querySelector('.pal-pop')) { if (sq) sq.click(); await new Promise(r => setTimeout(r, 250)); }
    const bar = document.querySelector('.pal-pop .pal-hue');
    if (!bar) return { err: '没有色相条 .pal-hue' };
    const r = bar.getBoundingClientRect();
    const at = (fy) => ({ clientX: r.left + r.width / 2, clientY: r.top + r.height * fy, bubbles: true, pointerId: 3 });
    bar.dispatchEvent(new PointerEvent('pointerdown', at(0.08)));
    const topColor = hexEl ? hexEl.textContent : '';
    bar.dispatchEvent(new PointerEvent('pointermove', at(0.9)));   // 固定 x，只改 y
    await new Promise(r2 => setTimeout(r2, 120));
    const bottomColor = hexEl ? hexEl.textContent : '';
    bar.dispatchEvent(new PointerEvent('pointerup', at(0.9)));
    await new Promise(r2 => setTimeout(r2, 250));
    return { topColor, bottomColor, w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  chk('★ 色相条是**竖的**（上下拖 / 只改 y 就变色）',
    !!hue && !hue.err && hue.topColor !== hue.bottomColor, hue);
  chk('  色相条本身是竖长的（宽 < 高）', !!hue && hue.w < hue.h, hue && [hue.w, hue.h]);

  /* ★ 2026-10-21 他要求：**松手不许关**，只有点弹窗外边才关 */
  const stay = await PANEL.ev(`(async () => {
    const open1 = !!document.querySelector('.pal-pop');
    const sq = document.querySelector('#pMain .picksq');
    if (!open1 && sq) { sq.click(); await new Promise(r => setTimeout(r, 260)); }
    const pal = document.querySelector('.pal-pop .pal');
    if (!pal) return { err: '调色板没开着' };
    const sv = pal.querySelector('.pal-sv');
    const r = sv.getBoundingClientRect();
    const at = (fx, fy) => ({ clientX: r.left + r.width * fx, clientY: r.top + r.height * fy, bubbles: true, pointerId: 9 });
    sv.dispatchEvent(new PointerEvent('pointerdown', at(0.4, 0.4)));
    sv.dispatchEvent(new PointerEvent('pointermove', at(0.55, 0.5)));
    sv.dispatchEvent(new PointerEvent('pointerup', at(0.55, 0.5)));
    await new Promise(r2 => setTimeout(r2, 500));      // 等落盘 + 那条"重画"广播跑完
    const afterUp = !!document.querySelector('.pal-pop');
    /* 点「面板自己的空白处」不算外面（那算同一张卡）；这里点 body 才算外面 */
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await new Promise(r2 => setTimeout(r2, 300));
    return { afterUp, afterOutside: !!document.querySelector('.pal-pop') };
  })()`);
  chk('★ **松手之后弹窗不关**（他 2026-10-21 明确要求）', !!stay && stay.afterUp === true, stay);
  chk('★ 点弹窗外面才关', !!stay && stay.afterOutside === false, stay);

  /*
   * ⚠️ 2026-10-21 改判据：原来断言"松手后的颜色 ≠ 拖之前"。
   *    可隔离 HOME 里上一次跑探针**已经把颜色改成同一个值**了，
   *    起点正好等于终点 → 假红。真正该验的是**松手落盘了没有**。
   */
  chk('★ 松手后色值合法 #rrggbb', !!drag && /^#[0-9a-f]{6}$/i.test(String(drag.after || '')), drag && drag.after);
  chk('★ 松手后**真的写进 config 了**（不是只在界面上变）',
    !!drag && String(drag.saved || '').toLowerCase() === String(drag.after || '').toLowerCase(),
    drag && { after: drag.after, saved: drag.saved });

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
