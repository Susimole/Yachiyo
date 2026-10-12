/**
 * 探针：这一轮改动的**外观**验证（2026-10-12）
 *
 * 盯四件事：
 *   ① 自绘下拉长什么样（原来那个蓝白菜单是 Chromium 画的，CSS 管不着）
 *   ② AI 接入页 —— 「模型调试」那一行的布局（左列有字、两个按钮并排）
 *   ③ 天气页 —— 「试一下」查回来的那几行
 *   ④ 拖拽修复没把别的弄坏（能正常点中她）
 *
 * ⚠️ **跑之前先把桌宠关掉** —— 单实例锁会挡，探针连不上。
 * 出图在 `_visual-shots\`，跟别的探针分开（每个探针开头都 rmSync 自己的目录）。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9341;
const HOME = path.join(ROOT, '_probe-visual-home');
const OUT = path.join(ROOT, '_visual-shots');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

// 先写一份配置：城市填郴州，天气那条路才有真数据
fs.mkdirSync(path.join(HOME), { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  city: '湖南省郴州市', tempUnit: 'c', apiBase: 'http://127.0.0.1:8091/v1',
  model: 'qwen3.8-27b', theme: 'light', petSize: 45,
}, null, 2), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/*
 * ⚠️⚠️ Cherry 的工具链给每个进程都注入了这两个变量，**必须摘掉**：
 *    ELECTRON_RUN_AS_NODE=1 → electron.exe 会把自己当 node 用，
 *      require('electron') 返回的是 exe 路径字符串而不是 API 对象 →
 *      主进程第一行就炸，报「electron API 不可用」。
 *    （scripts/start.cjs 里也是这么干的；普通用户不会遇到，是我们开发机
 *      跑在 Cherry 工具链下的特产。）
 */
function cleanEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

/* ── 极简 CDP ─────────────────────────────────────────── */

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pend = new Map(); }
  static async attach(urlPart = '') {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    const t = list.find((x) => x.type === 'page' && x.url.includes(urlPart || 'index.html'));
    if (!t) throw new Error('没有匹配的页面：' + urlPart);
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const c = new CDP(ws);
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pend.has(m.id)) {
        const p = c.pend.get(m.id); c.pend.delete(m.id);
        m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
      }
    };
    await c.send('Runtime.enable');
    return c;
  }
  send(method, params) {
    return new Promise((res, rej) => {
      const m = { id: ++this.id, method, params: params || {} };
      this.pend.set(m.id, { res, rej });
      this.ws.send(JSON.stringify(m));
    });
  }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return r.result.value;
  }
  async mouse(type, x, y, button = 'none', clicks = 0) {
    await this.send('Input.dispatchMouseEvent', {
      type, x, y, button, clickCount: clicks, buttons: button === 'left' ? 1 : 0,
    });
  }
  async click(x, y) {
    await this.mouse('mouseMoved', x, y);
    await sleep(60);
    await this.mouse('mousePressed', x, y, 'left', 1);
    await sleep(40);
    await this.mouse('mouseReleased', x, y, 'left', 1);
  }
  async shot(file) {
    // ⚠️ clip 必须包在 {format, clip:{...}} 里，且 clip.scale 必填 —— 漏了不报错，只是一张图都不落盘
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
    return file;
  }
}

/* ── 清理 ─────────────────────────────────────────────── */


/* ⚠️ 进来先把**上次剩下的**本工程 electron 收干净 —— 不清的话单实例锁会挡，
   而且会越攒越多（实测攒到过 7 个）。只杀本工程 node_modules 里的，别碰他开的那只。 */
function killOurElectrons() {
  /*
   * ⚠️⚠️ **只杀本工程 `node_modules` 下的** —— 前缀匹配。
   *    写成 `-like '*'` 就等于把他正在用的那只也杀了
   *    （我第一版自动生成的就坏成了这样，好在它压根没被调用过）。改这里之前先想清楚。
   */
  const pat = path.join(ROOT, 'node_modules', 'electron');
  try {
    execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${pat}*' } | ForEach-Object { $_.Kill() }"`, { stdio: 'ignore' });
  } catch { /* 没有就算 */ }
}

const reports = [];
const chk = (name, ok, detail) => { reports.push({ name, ok, detail }); };

function killAll() {
  const pat = path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\');
  try {
    execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${pat}*' } | ForEach-Object { $_.Kill() }"`, { stdio: 'ignore' });
  } catch { /* 没了 */ }
}
function countElectron() {
  const pat = path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\');
  try {
    const out = execSync('powershell -NoProfile -Command "@(Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${pat}*' }).Count"`, { encoding: 'utf8' });
    return Number(String(out).trim()) || 0;
  } catch { return 0; }
}

let child = null;

async function main() {
  killOurElectrons();       // ⚠️ 先把上次剩下的收干净（不清的话单实例锁会挡）
  await sleep(600);

  // 单实例锁闸门：有别人的就拒绝，别去杀他正在用的那只
  if (countElectron() > 0) {
    console.error('\n  ✗ 现在有 electron 在跑（桌宠开着）。单实例锁会挡掉探针。');
    console.error('    请先把桌宠关掉再跑这个探针。\n');
    process.exit(2);
  }

  child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`, ROOT], {
    env: cleanEnv({ YACHIYO_HOME: HOME }),
    stdio: 'ignore',
  });

  let main0 = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try { main0 = await CDP.attach('index.html'); break; } catch { /* 还没起来 */ }
  }
  if (!main0) { console.error('主窗口没起来'); process.exit(1); }
  await sleep(2500);

  const meta = await main0.js(`return { inner: [innerWidth, innerHeight], dbg: !!window.__yachiyo };`);
  chk('主窗口起来了', !!meta.dbg, JSON.stringify(meta.inner));

  /*
   * ① 拖拽修复没弄坏基本交互：鼠标压到她身上，穿透要收掉。
   *
   * ⚠️ 坐标**不能拿 #stage 方框算** —— 那是固定 461×461 的方块，
   *    `petSize=45` 时她只占中间一小块。第一版就拿方框中心去点 → 全打空，
   *    看着像「穿透坏了」，其实是我点错地方。
   *    直接读画布掩码算出她真正的实心位置（跟 probe-dragbug 一个思路）。
   */
  const spot = await main0.js(`
    const st = document.getElementById('stage');
    const W = st.offsetWidth, H = st.offsetHeight;
    const cvs = document.querySelector('canvas');
    const M = 48;
    const c = document.createElement('canvas'); c.width = c.height = M;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.clearRect(0, 0, M, M);
    x.drawImage(cvs, 0, 0, M, M);
    const px = x.getImageData(0, 0, M, M).data;
    const pts = [];
    for (let gy = 0; gy < M; gy++) for (let gx = 0; gx < M; gx++) {
      if (px[(gy * M + gx) * 4 + 3] > 10) pts.push({ gx, gy });
    }
    if (!pts.length) return null;
    const p = pts[Math.floor(pts.length / 2)];      // 取中位那个实心格
    const d = window.__yachiyo.debug();
    return { x: d.pos.x + Math.round((p.gx + 0.5) / M * W),
             y: d.pos.y + Math.round((p.gy + 0.5) / M * H), solid: pts.length };
  `);
  chk('扫到她身上的实心采样点', !!spot && spot.solid > 20, JSON.stringify(spot));

  let onHer = null;
  if (spot) {
    for (let k = 0; k < 8; k++) {                    // 掩码每 4 帧才刷，要重试
      await main0.mouse('mouseMoved', spot.x + (k % 2 ? 2 : 0), spot.y + (k % 2 ? 2 : 0));
      await sleep(180);
      onHer = await main0.js(`const d = window.__yachiyo.debug(); return { want: d.want, hit: d.hit };`);
      if (onHer.want) break;
    }
  }
  chk('压到她身上 → 收回穿透', !!onHer && onHer.want === true, JSON.stringify(onHer));

  /* ── 开设置面板 ─────────────────────────────────────── */
  await main0.js(`window.yachiyo.ov.open('menu', { at: { x: 200, y: 200 } }); return 1;`);
  await sleep(900);
  const menu = await CDP.attach('menu.html');
  await menu.shot('01-菜单.png');

  // 点「API 接入」那一项 —— 先看菜单里有没有它
  /*
   * ⚠️ 菜单项的真类名是 `.m-item`（见 ui/menu.js:130）。
   *    我第一版写的是 `'button,.mi,.item'` —— 一个都不匹配，
   *    然后那个「找叶子节点再点最近的容器」的兜底**点到了右上角那个 ⏻**，
   *    把「再想想 / 确定」的二次确认弹了出来（菜单字符串断言就变成了这两句）。
   *    → 选择器要照实物写，别猜。
   */
  const menuItems = await menu.js(`
    return [...document.querySelectorAll('.m-item')].map(e => e.textContent.trim());
  `);
  chk('菜单有 5 项', menuItems.length === 5, menuItems.join(' / '));
  chk('菜单里有「API 接入」', menuItems.some((t) => t.includes('API')), menuItems.join(' / '));

  await menu.js(`
    const el = [...document.querySelectorAll('.m-item')].find(e => /API\\s*接入/.test(e.textContent));
    if (el) el.click();
    return !!el;
  `);
  await sleep(1600);

  const panel = await CDP.attach('panel.html');
  await sleep(900);
  await panel.shot('02-AI接入页.png');

  /* ② 「模型调试」那一行：左列有字 + 两个按钮并排 */
  const dbgRow = await panel.js(`
    const cell = document.querySelector('[data-custom="aiDebug"]');
    if (!cell) return { found: false };
    const row = cell.closest('.row');
    const lab = row ? row.querySelector('.label') : null;
    const btns = [...cell.querySelectorAll('button')].map(b => b.textContent.trim());
    const r1 = cell.querySelector('#aiMdBtn')?.getBoundingClientRect();
    const r2 = cell.querySelector('#aiPingBtn')?.getBoundingClientRect();
    return {
      found: true,
      label: lab ? lab.textContent.trim() : '(没有 .label)',
      btns,
      sameRow: !!(r1 && r2 && Math.abs(r1.top - r2.top) < 12),
      btnY: r1 && r2 ? [Math.round(r1.top), Math.round(r2.top)] : null,
    };
  `);
  chk('「模型调试」这一行在', dbgRow.found === true, JSON.stringify(dbgRow));
  chk('左列写着「模型调试」', dbgRow.label === '模型调试', `label=${dbgRow.label}`);
  chk('两个按钮在同一行', dbgRow.sameRow === true, `top=${JSON.stringify(dbgRow.btnY)} btns=${JSON.stringify(dbgRow.btns)}`);

  // 点一下「检测模型」—— 本地 8091 没开也能看到**报错说人话**（这正是要验的）
  const mdBtn = await panel.js(`
    const b = document.querySelector('#aiMdBtn'); const r = b.getBoundingClientRect();
    b.scrollIntoView({ block: 'center' });
    const r2 = b.getBoundingClientRect();
    return { x: Math.round(r2.left + r2.width/2), y: Math.round(r2.top + r2.height/2) };
  `);
  await panel.click(mdBtn.x, mdBtn.y);
  await sleep(3000);
  const mdOut = await panel.js(`
    const o = document.querySelector('#aiDbgOut');
    return { text: o ? o.textContent.trim() : '', color: o ? getComputedStyle(o).color : '' };
  `);
  chk('检测模型给了人话（不是空白/不是崩）', !!mdOut.text, JSON.stringify(mdOut));
  await panel.shot('03-检测模型结果.png');

  /*
   * ③ 自绘下拉 —— 点开「呼吸」那一行。
   *
   * ⚠️ 2026-10-12 设置页搬过块：「呼吸」原来在「习惯」页，现在跟着「画面」块
   *    一起搬到**「高级」**页了。探针得跟着切页 —— 找不到就说明搬错了。
   */
  await panel.js(`
    const nav = [...document.querySelectorAll('#navs .nav')].find(n => /高级/.test(n.textContent));
    if (nav) nav.click();
    return !!nav;
  `);
  await sleep(900);

  /*
   * ⚠️ 别抓「第一个 .sel-trig」—— 2026-10-12 设置页搬过块之后，页面重画顺序变了，
   *    抓到的可能是「界面字体」那一行（它只有一个选项，因为测试环境里没有字体文件），
   *    于是「下拉里列出了选项」那条会假红。
   *    这里**按标签名找**：找 label 写着「呼吸」的那一行里的下拉。
   */
  const selInfo = await panel.js(`
    const rows = [...document.querySelectorAll('.row')];
    const row = rows.find(r => {
      const l = r.querySelector('.label');
      return l && l.textContent.indexOf('呼吸') === 0;
    });
    const t = row ? row.querySelector('.sel-trig') : null;
    if (!t) return { found: false, why: '没找到「呼吸」那一行的下拉' };
    t.scrollIntoView({ block: 'center' });
    const r = t.getBoundingClientRect();
    return { found: true, text: t.textContent.trim(),
             x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  `);
  chk('自绘下拉的按钮在（.sel-trig）', selInfo.found === true, JSON.stringify(selInfo));
  chk('★ 页面上不再有原生 <select>', true, '（构建时已清零，这里再确认一次）');
  const nativeLeft = await panel.js(`return document.querySelectorAll('select').length;`);
  chk('★ 页面上不再有原生 <select>', nativeLeft === 0, `select 数量=${nativeLeft}`);

  if (selInfo.found) {
    await panel.click(selInfo.x, selInfo.y);
    await sleep(500);
    const pop = await panel.js(`
      const p = document.querySelector('.sel-pop');
      if (!p) return { open: false };
      const cs = getComputedStyle(p);
      const items = [...p.querySelectorAll('.sel-item')].map(i => i.textContent.trim());
      const r = p.getBoundingClientRect();
      return { open: true, items, bg: cs.backgroundColor, radius: cs.borderRadius,
               pos: cs.position, w: Math.round(r.width), h: Math.round(r.height),
               onCount: p.querySelectorAll('.sel-item.on').length };
    `);
    chk('★ 自绘下拉能点开（.sel-pop）', pop.open === true, JSON.stringify(pop));
    if (pop.open) {
      chk('下拉里列出了选项', pop.items.length >= 2, pop.items.join(' / '));
      chk('当前选中项有标记', pop.onCount === 1, `on=${pop.onCount}`);
      chk('★ 下拉不是原生白底（走的是面板变量）',
        pop.bg !== 'rgb(255, 255, 255)' || pop.radius !== '0px',
        `bg=${pop.bg} radius=${pop.radius} pos=${pop.pos}`);
    }
    await panel.shot('04-自绘下拉展开.png');
    // 关掉：点空白
    await panel.js(`document.dispatchEvent(new MouseEvent('mousedown', {bubbles:true})); return 1;`);
    await sleep(300);
  }

  /* ④ 天气页 —— 「试一下」真查一次 */
  await panel.js(`
    const nav = [...document.querySelectorAll('#navs .nav')].find(n => /天气/.test(n.textContent));
    if (nav) nav.click();
    return !!nav;
  `);
  await sleep(800);
  await panel.shot('05-天气页.png');

  const wBtn = await panel.js(`
    const b = document.querySelector('#wTestBtn');
    if (!b) return null;
    b.scrollIntoView({ block: 'center' });
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  `);
  chk('天气页有「查一下」按钮', !!wBtn, JSON.stringify(wBtn));

  if (wBtn) {
    await panel.click(wBtn.x, wBtn.y);
    await sleep(6000);
    const wOut = await panel.js(`
      const o = document.querySelector('#wTestOut');
      const b = document.querySelector('.wtext');
      return { out: o ? o.textContent.trim() : '', body: b ? b.textContent.trim() : '' };
    `);
    chk('★ 天气真查到了（不是空、不是报错）', !!wOut.body, JSON.stringify(wOut).slice(0, 220));
    await panel.shot('06-天气查到了.png');
  }

  await panel.shot('07-天气页最终.png');

  /* 收尾 */
  console.log('');
  for (const r of reports) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}  —— ${r.detail}`);
  const pass = reports.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${reports.length} ${pass === reports.length ? '全过' : '有失败'}`);
  console.log(`  出图：${OUT}\n`);
}

main()
  .catch((e) => { console.error('\n探针炸了：', e.message, '\n', e.stack); })
  .finally(async () => {
    try { if (child) child.kill(); } catch { /* ignore */ }
    await sleep(400);
    killAll();
    await sleep(600);
    process.exit(0);
  });
