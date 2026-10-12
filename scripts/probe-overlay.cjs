/**
 * 浮层验证 —— 菜单 / 面板 / 聊天窗拆成独立窗口之后，还能不能开、长什么样。
 *
 * 跑法：node scripts/probe-overlay.cjs
 * 产出：_bug-shots\ov-*.png
 */

'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');
const CDP_PORT = 9336;
const HOME = path.join(ROOT, '_probe-home');
const OUT = path.join(ROOT, '_bug-shots');
const RUN_MS = Number(process.env.PROBE_MS || 80000);
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
  static async targets() {
    return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json())
      .filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  }
  static async attach(urlPart) {
    const pages = await CDP.targets();
    const p = urlPart
      ? pages.find((t) => (t.url || '').includes(urlPart))
      : pages.find((t) => !/(menu|panel|chat)\.html/.test(t.url || ''));
    if (!p) throw new Error(`没找到 ${urlPart || '主窗口'}，现有：` + pages.map((t) => t.url).join(' | '));
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('连不上')), { once: true });
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
      setTimeout(() => { if (this.pend.has(id)) { this.pend.delete(id); rej(new Error(method + ' 超时')); } }, 12000);
    });
  }
  async js(expr) {
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
  async shot(file) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', clip: {
      x: 0, y: 0, width: 900, height: 620, scale: 1,
    } });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  }
}

const walkCard = `
  const c = document.querySelector('.card');
  const bar = document.querySelector('.bar');
  const sc = document.querySelector('.scroll, .p-main, .c-body');
  const r = c ? c.getBoundingClientRect() : null;
  return {
    hasCard: !!c,
    card: r ? { w: Math.round(r.width), h: Math.round(r.height) } : null,
    barH: bar ? Math.round(bar.getBoundingClientRect().height) : 0,
    dragRegion: bar ? getComputedStyle(bar).webkitAppRegion : null,
    scrollable: sc ? { h: sc.clientHeight, sh: sc.scrollHeight, canScroll: sc.scrollHeight > sc.clientHeight + 2 } : null,
    bodyH: document.body.getBoundingClientRect().height,
    winH: window.innerHeight,
  };
`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'),
    JSON.stringify({ petSize: 100, moveEnabled: false, sound: true }, null, 2), 'utf8');

  try {
    require('node:child_process').execSync(
      'powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\')}*' } | ` +
      'ForEach-Object { $_.Kill() }"', { stdio: 'ignore' });
  } catch { /* 没有就算了 */ }
  await sleep(500);

  const child = spawn(electronPath, [`--remote-debugging-port=${CDP_PORT}`, ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, YACHIYO_MS: String(RUN_MS), YACHIYO_HOME: HOME },
    stdio: 'ignore',
  });

  let main_ = null;
  for (let i = 0; i < 40 && !main_; i++) {
    await sleep(500);
    try { main_ = await CDP.attach(); } catch { /* 还没起来 */ }
  }
  if (!main_) { console.error('窗口起不来'); child.kill(); process.exit(1); }
  await sleep(3000);
  console.log('\n主窗口连上了。\n');

  /* ---- 1. 右键她 → 菜单窗 ---- */
  const hit = await main_.js(`return window.__yachiyo.hitProbe();`);
  await main_.mouse('mousePressed', hit.x, hit.y, 'right');
  await main_.mouse('mouseReleased', hit.x, hit.y, 'right');
  await sleep(1200);

  let pages = await CDP.targets();
  console.log(`  target 一共 ${pages.length} 个：`);
  for (const p of pages) console.log('    · ' + (p.url || '').split('/').pop());

  const menuT = pages.find((p) => (p.url || '').includes('menu.html'));
  console.log(menuT ? '\n  ✓ 右键她 → 菜单窗口开出来了' : '\n  ✗ 菜单窗口没出来');

  if (menuT) {
    const m = await CDP.attach('menu.html');
    const info = await m.js(walkCard);
    console.log(`    卡片 ${info.card.w}×${info.card.h}（窗口高 ${info.winH}）` +
      ` · 顶栏 ${info.barH}px · 可拖动 = ${info.dragRegion}`);
    const items = await m.js(`return document.querySelectorAll('#mList .m-item').length;`);

    console.log(`    窗口高 ${info.winH} · 顶栏 ${info.barH}px · 可拖动 = ${info.dragRegion}`);
    console.log(`    菜单项 ${items} 个`);
    await m.shot('ov-01-菜单.png');
  }

  /* ---- 2. 从菜单开设置面板 ---- */
  // ⚠️ panelT 要提到 if 外面 —— 下一节（图标/货币那一批）也要用它，
  //    留在块里的 const 出了块就没了。
  let panelT = null;
  if (menuT) {
    await main_.js(`window.yachiyo.ov.open('panel', { page: 'habit' }); return 1;`);
    await sleep(1500);
    panelT = (await CDP.targets()).find((p) => (p.url || '').includes('panel.html'));
    console.log(panelT ? '\n  ✓ 设置面板窗口开出来了' : '\n  ✗ 面板窗口没出来');
    if (panelT) {
      const p = await CDP.attach('panel.html');
      const info = await p.js(walkCard);
      console.log(`    卡片 ${info.card.w}×${info.card.h}（窗口高 ${info.winH}）`);
      console.log(`    内容区 ${info.scrollable.h}px / 内容 ${info.scrollable.sh}px` +
        ` → ${info.scrollable.canScroll ? '能滚 ✓' : '不用滚'}`);
      const rows = await p.js(`return document.querySelectorAll('#pMain .row').length;`);
      const navs = await p.js(`return [...document.querySelectorAll('#navs .nav')].map(n=>n.textContent.trim()).join(' / ');`);
      console.log(`    导航：${navs}`);
      console.log(`    当前页 ${rows} 行`);
      // 色卡
      await p.js(`document.querySelector('#navs .nav[data-k="habit"]').click(); return 1;`);
      await sleep(400);
      const sw = await p.js(`return { n: document.querySelectorAll('.swatch').length,
                                     hasPicker: !!document.querySelector('.cwrap input[type=color]'),
                                     hex: document.querySelector('.cwrap .hex')?.textContent };`);
      console.log(`    主题色：色卡 ${sw.n} 颗 · 调色盘 ${sw.hasPicker ? '有 ✓' : '没有 ✗'} · 当前 ${sw.hex}`);
      await p.shot('ov-02-面板.png');
    }
  }

  /* ---- 2b. 图标 / 货币 / 数字输入框（2026-10-12 那一批） ---- */
  if (panelT) {
    const p = await CDP.attach('panel.html');
    console.log('\n  ── 图标 / 货币 / 输入框 ──');

    // 浮层标题栏的头像 —— 都得是那张 .ico，而且真的解码出来了
    // ⚠️ 只查**这会儿已经开着的**窗口：target 不存在就是窗口还没建，
    //    不是「头像坏了」。聊天窗在下一节才开，所以它不在这张名单里。
    for (const f of ['menu.html', 'panel.html']) {
      try {
        const t = await CDP.attach(f);
        const a = await t.js(`const i = document.querySelector('.bar .ava');
          if (!i) return { none: true };
          return { w: i.naturalWidth, h: i.naturalHeight, src: i.getAttribute('src'),
                   shown: i.getBoundingClientRect().width };`);
        console.log(`    ${f.padEnd(11)} 头像 ${a.none ? '没有 ✗'
          : (a.w > 0 ? `解码 OK ${a.w}×${a.h} · 显示 ${a.shown.toFixed(0)}px ✓` : `加载失败 ✗ (${a.src})`)}`);
      } catch (e) { console.log(`    ${f.padEnd(11)} 连不上：${e.message}`); }
    }

    // AI 页：数字输入框 + 货币切换
    await main_.js(`window.yachiyo.ov.open('panel', { page: 'ai' }); return 1;`);
    await sleep(1200);
    const nums = await p.js(`const ins = [...document.querySelectorAll('#pMain .num-in')];
      return { n: ins.length, types: ins.map(i => i.type).join(','),
               empty: ins.filter(i => i.value === '').length,
               vals: ins.map(i => i.value).join(' | ') };`);
    console.log(`    AI 页数字输入框 ${nums.n} 个 · 空值 ${nums.empty} 个`);
    console.log(`    当前值 ${nums.vals}`);

    const before = await p.js(`return (document.querySelector('.stats .hl .v') || {}).textContent;`);
    await p.js(`const seg = [...document.querySelectorAll('#pMain .seg button, #pMain .seg div')]
      .find(b => /美元|\\$/.test(b.textContent));
      if (seg) seg.click();
      return seg ? seg.textContent.trim() : '没找到美元按钮';`).then((r) => console.log(`    点「${r}」`));
    await sleep(800);
    const after = await p.js(`return {
      today: (document.querySelector('.stats .hl .v') || {}).textContent,
      foot: [...document.querySelectorAll('#pMain .kv')].map(k => k.textContent).join(' ／ '),
      cfg: (window.yachiyo && 1), };`);
    console.log(`    用量卡金额：${before}  →  ${after.today}` +
      `   ${String(after.today || '').startsWith('$') ? '✓ 跟着切了' : '✗ 没跟着切'}`);
    console.log(`    折算说明：${after.foot.slice(0, 80)}`);

    // 切回来，别把测试用的 $ 留在配置里
    await p.js(`const seg = [...document.querySelectorAll('#pMain .seg button, #pMain .seg div')]
      .find(b => /人民币|¥/.test(b.textContent)); if (seg) seg.click(); return 1;`);
    await sleep(500);
    await p.shot('ov-04-ai页.png');
  }

  /* ---- 3. 聊天窗 ---- */
  await main_.js(`window.yachiyo.ov.open('chat'); return 1;`);
  await sleep(1500);
  const chatT = (await CDP.targets()).find((p) => (p.url || '').includes('chat.html'));
  console.log(chatT ? '\n  ✓ 聊天窗开出来了' : '\n  ✗ 聊天窗没出来');
  if (chatT) {
    const c = await CDP.attach('chat.html');
    const info = await c.js(walkCard);
    console.log(`    卡片 ${info.card.w}×${info.card.h}（窗口高 ${info.winH}）`);
    const hasInput = await c.js(`return !!document.getElementById('cInput');`);
    console.log(`    输入框 ${hasInput ? '在 ✓' : '没了 ✗'}`);
    const ava = await c.js(`const i = document.querySelector('.bar .ava');
      return i ? { w: i.naturalWidth, h: i.naturalHeight } : null;`);
    console.log(`    头像 ${ava && ava.w > 0 ? `解码 OK ${ava.w}×${ava.h} ✓` : '没加载出来 ✗'}`);
    await c.shot('ov-03-聊天.png');
  }

  /* ---- 4. 关掉菜单（点她的路）---- */
  if (menuT) {
    await main_.js(`window.yachiyo.ov.closeKind('menu'); return 1;`);
    await sleep(600);
    const visible = await main_.js(`return await window.yachiyo.win.state();`);
    const stillMenu = (await CDP.targets()).find((p) => (p.url || '').includes('menu.html'));
    console.log(`\n  关菜单：target ${stillMenu ? '还在（hide 了，没销毁 ✓）' : '没了'}`);
    void visible;
  }

  console.log(`\n截图在 ${OUT}\n`);
  child.kill();
  await sleep(400);
  process.exit(0);
}

main().catch((e) => { console.error('\n探针炸了：', e.message); process.exit(1); });
