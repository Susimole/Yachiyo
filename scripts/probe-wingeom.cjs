/**
 * 探针：浮层窗口的**位置/大小记不记得住**（2026-10-12 他要求的功能）
 *
 * 验的是：面板挪个地方、拉个尺寸 → 关掉 → 再开，**是不是还在那儿**。
 *
 * ⚠️ 怎么"挪"：用 `window.moveTo` / `window.resizeTo`（在面板页面里调）。
 *    试过 CDP 合成鼠标去拖标题栏 —— **走不通**：标题栏是
 *    `-webkit-app-region: drag`，拖动由系统接管，合成事件到不了那套逻辑。
 *    又试过 PowerShell 调 `user32.dll` 的 `MoveWindow`，白绕四轮
 *    （见下面第 2 步的注释）。`window.moveTo` 落到真窗口上，
 *    `move`/`resize` 事件跟产品代码监听的**完全同一条路径**，够用且零依赖。
 *
 * ⚠️ 跑之前先把桌宠关掉（单实例锁会挡）。
 */
'use strict';

const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9371;
const HOME = path.join(ROOT, '_probe-wingeom-home');
const CFG = path.join(HOME, 'config.json');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
fs.writeFileSync(CFG, JSON.stringify({
  petSize: 45, city: '湖南省郴州市', theme: 'light',
}, null, 2), 'utf8');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanEnv(extra) {
  const env = { ...process.env, ...(extra || {}) };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  return env;
}

/* ── 极简 CDP ─────────────────────────────────────────── */

async function attach(part, tries = 60) {
  for (let i = 0; i < tries; i++) {
    await sleep(500);
    try {
      const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const t = l.find((x) => x.type === 'page' && x.url.includes(part));
      if (!t) continue;
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => { ws.onopen = r; });
      let id = 0; const pend = new Map();
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && pend.has(m.id)) {
          const p = pend.get(m.id); pend.delete(m.id);
          m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
        }
      };
      const send = (me, pa) => new Promise((res, rej) => {
        const o = { id: ++id, method: me, params: pa || {} };
        pend.set(o.id, { res, rej }); ws.send(JSON.stringify(o));
      });
      await send('Runtime.enable');
      const js = async (ex) => {
        const r = await send('Runtime.evaluate', {
          expression: `(async () => { ${ex} })()`, awaitPromise: true, returnByValue: true,
        });
        if (r.exceptionDetails) {
          throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
        }
        return r.result.value;
      };
      return { js };
    } catch { /* 还没起来 */ }
  }
  return null;
}


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

/* ── 主流程 ───────────────────────────────────────────── */

const reports = [];
const chk = (name, ok, detail) => { reports.push({ name, ok, detail }); };
const readGeom = () => {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')).winGeom || null; } catch { return null; }
};

let child = null;
(async () => {
  killOurElectrons();       // ⚠️ 先把上次剩下的收干净（不清的话单实例锁会挡）
  await sleep(600);

  let live = 0;
  try {
    live = Number(execSync('powershell -NoProfile -Command "@(Get-Process electron -ErrorAction SilentlyContinue).Count"',
      { encoding: 'utf8' }).trim()) || 0;
  } catch { /* 数不到就算了 */ }
  if (live > 0) {
    console.error(`\n  ✗ 有 ${live} 个 electron 在跑（桌宠开着）—— 请先关掉再跑。\n`);
    process.exit(2);
  }

  child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`, ROOT], {
    env: cleanEnv({ YACHIYO_HOME: HOME }), stdio: 'ignore',
  });

  const main = await attach('index.html');
  if (!main) { console.error('主窗口没起来'); process.exit(1); }
  await sleep(3000);

  /* 1) 开面板 */
  await main.js(`window.yachiyo.ov.open('panel', { state: { page: 'habit' } }); return 1;`);
  await sleep(1800);
  const panel = await attach('panel.html', 20);
  chk('面板开出来了', !!panel, '');
  if (!panel) throw new Error('面板没开出来');

  const b0 = (await panel.js(`return await window.yachiyo.ov.info('panel');`)).bounds;
  chk('读到面板初始位置', !!b0, JSON.stringify(b0));

  /*
   * 2) 真移窗口 + 真拉尺寸。
   *
   * ⚠️ 用 **`window.moveTo` / `window.resizeTo`**，不折腾 Win32。
   *    试过 PowerShell 的 `MoveWindow`，白绕四轮：EnumWindows 的**回调作用域**
   *    跟宿主不是同一个，`$script:` / `$global:` / 静态字段三种回传全丢，
   *    一直返回空的 —— 排查成本远大于收益。
   *
   *    `window.moveTo` 是渲染层对自己窗口的**标准操作**，Electron 把它落到真窗口上，
   *    `move` / `resize` 事件**跟我们代码监听的完全是同一条路径**，
   *    所以验出来的结论对真实拖拽同样成立。还不依赖任何外部工具。
   */
  const TARGET = { x: 260, y: 180, w: 700, h: 500 };
  await panel.js(`window.moveTo(${TARGET.x}, ${TARGET.y}); return 1;`);
  await sleep(400);
  await panel.js(`window.resizeTo(${TARGET.w}, ${TARGET.h}); return 1;`);
  await sleep(400);
  const bAfter = (await panel.js(`return await window.yachiyo.ov.info('panel');`)).bounds;
  chk('真把窗口挪走并改小了',
    Math.abs(bAfter.x - TARGET.x) < 8 && Math.abs(bAfter.y - TARGET.y) < 8 && bAfter.width < 780,
    `移到 ${JSON.stringify(bAfter)}`);

  await sleep(2200);          // 等 800ms 去抖落盘
  const g1 = readGeom();
  const gp = g1 && g1.panel;
  chk('★ 位置写进了配置', !!gp && Math.abs(gp.x - TARGET.x) < 6 && Math.abs(gp.y - TARGET.y) < 6,
    JSON.stringify(gp));
  chk('★ 尺寸也一起存了', !!gp && gp.width > 400 && gp.height > 300,
    gp ? `${gp.width}×${gp.height}` : '(没存)');

  /* 3) 关掉再开 */
  await main.js(`window.yachiyo.ov.closeKind('panel'); return 1;`);
  await sleep(1000);
  await main.js(`window.yachiyo.ov.open('panel', { state: { page: 'ai' } }); return 1;`);
  await sleep(2000);
  const panel2 = await attach('panel.html', 20);
  const info2 = panel2 ? await panel2.js(`return await window.yachiyo.ov.info('panel');`) : null;
  const b2 = info2 && info2.bounds;
  const ok2 = !!b2 && Math.abs(b2.x - TARGET.x) < 8 && Math.abs(b2.y - TARGET.y) < 8;
  chk('★★ 重开后还在原地（这就是他要的）', ok2,
    `重开 bounds=${JSON.stringify(b2)}  期望 x≈${TARGET.x} y≈${TARGET.y}`);

  /* 4) 从菜单点开也得去老地方（不能跳回鼠标那儿） */
  await main.js(`window.yachiyo.ov.closeKind('panel'); return 1;`);
  await sleep(800);
  await main.js(`window.yachiyo.ov.open('panel', { at: { x: 40, y: 40 }, state: { page: 'weather' } }); return 1;`);
  await sleep(2000);
  const panel3 = await attach('panel.html', 20);
  const info3 = panel3 ? await panel3.js(`return await window.yachiyo.ov.info('panel');`) : null;
  const b3 = info3 && info3.bounds;
  chk('★ 给了鼠标坐标也照样用存过的那份（不跳回去）',
    !!b3 && Math.abs(b3.x - TARGET.x) < 8 && Math.abs(b3.y - TARGET.y) < 8,
    `bounds=${JSON.stringify(b3)}`);

  /*
   * 5) ★ 菜单**完全不记位置**，每次都去鼠标那儿
   *    （他 2026-10-12 的要求：「右键菜单不再记忆位置，改为鼠标位置唤出」）
   *
   * ⚠️ 这条断言原来写的是「菜单只存了 x/y（不存 height）」——
   *    那是**上一版**的行为（那时菜单也记位置）。他改了口径之后这条永远红，
   *    但红的原因不是坏了、是**需求变了**。探针要跟着需求走，别留一条永远红的。
   */
  /*
   * ⚠️⚠️ **`at` 是「主窗口内」的坐标，不是屏幕坐标**（见 index.cjs 的 ov:open）。
   *    我第一版给的是 `{x:900, y:500}` —— 主窗口是一整条贴着屏幕底部的带子
   *    （y 从 552 起、高 560），500 加过去就是**屏幕 y=1052**，已经在屏幕外了。
   *    菜单被夹回来落到 862，我看着像"没去鼠标那儿"，其实**夹得完全正确**
   *    （工作区高 1112 − 菜单高 251 = 861）。
   *
   *    ⇒ 要用**她的真实位置**当右键点，那才是真实场景。 */
  const petPos = await main.js(`const d = window.__yachiyo.debug(); return d.pos;`);
  const atX = Math.round(petPos.x + 40);
  const atY = Math.round(petPos.y + 60);
  const wantScreenX = atX;                 // 主窗口 x 从 0 起，所以屏幕 x 就等于窗口内 x
  const wantScreenY = 552 + atY;           // 主窗口 y 从 552 起（见 win:screen 的实测）

  // 先给菜单一个人为的"旧位置"，看它会不会被用上
  const cfgFile = CFG;
  const cur = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  cur.winGeom = { ...(cur.winGeom || {}), menu: { x: 111, y: 222 } };
  fs.writeFileSync(cfgFile, JSON.stringify(cur, null, 2), 'utf8');

  await main.js(`window.yachiyo.ov.open('menu', { at: { x: ${atX}, y: ${atY} } }); return 1;`);
  await sleep(1600);
  const mInfo = await main.js(`return await window.yachiyo.ov.info('menu');`);
  const mb = mInfo && mInfo.bounds;
  /*
   * ⚠️ 断言别写死坐标 —— 菜单会**贴边夹取**：
   *    她贴着屏幕底站着，菜单放不下就只能往上翻（y 落到工作区底 − 菜单高）。
   *    第一版我写「必须靠近 (1881,992)」，y 被夹到 862 就判红了，
   *    可那个夹取**完全正确**（992 已经在屏幕外）。
   *    ⇒ 只验两件真正要验的事：**不是**旧位置、**贴近**她所在的横向位置。
   */
  const nearX = !!mb && Math.abs(mb.x - wantScreenX) < 260;
  const maxY = 1112 - 251;                       // 工作区高 − 菜单高（屏幕内能放的最低）
  const onScreenY = !!mb && mb.y <= maxY + 4 && mb.y >= 0;
  const notOld = !!mb && !(Math.abs(mb.x - 111) < 30 && Math.abs(mb.y - 222) < 30);
  chk('★★ 菜单去鼠标那儿（不是配置里那个旧位置 111,222）',
    nearX && onScreenY && notOld,
    `bounds=${JSON.stringify(mb)} · 期望 x 靠近 ${wantScreenX}、y ≤ ${maxY}`);

  await main.js(`window.yachiyo.ov.closeKind('menu'); return 1;`);
  await sleep(1200);
  const g2 = JSON.parse(fs.readFileSync(cfgFile, 'utf8')).winGeom || {};
  chk('★ 用完菜单，配置里**没多出** menu 那条',
    g2.menu == null || (g2.menu.x === 111 && g2.menu.y === 222),
    `menu=${JSON.stringify(g2.menu)}（只该剩我人为塞的那条，不该被覆盖）`);

  console.log('');
  for (const r of reports) console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}  —— ${r.detail}`);
  const pass = reports.filter((r) => r.ok).length;
  console.log(`\n  ${pass}/${reports.length} ${pass === reports.length ? '全过' : '有失败'}\n`);
})()
  .catch((e) => { console.error('\n探针炸了：', e.message); })
  .finally(async () => {
    try { if (child) child.kill(); } catch { /* ignore */ }
    await sleep(400);
    try {
      execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ForEach-Object { $_.Kill() }"',
        { stdio: 'ignore' });
    } catch { /* ignore */ }
    await sleep(500);
    process.exit(0);
  });
