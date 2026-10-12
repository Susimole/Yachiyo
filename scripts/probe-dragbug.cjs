/**
 * 探针：拖拽卡死（他 2026-10-12 报「偶尔无法拖动」）
 *
 * 假设：拖到鼠标跑出**主窗口方框**之后，渲染层收不到 mouseup，
 *       `dragging` 永远不清 —— 之后 `refreshMouse()` 一直走
 *       `if (dragging) { wantInteractive(true); return; }`，
 *       再也没人把指针还给桌面 ⇒ 点不着、拖不动。
 *
 * 这个探针只读**页面状态**，不改任何东西。
 */
'use strict';

const path = require('path');
const { spawn } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const PORT = 9339;
const HOME = path.join(ROOT, '_probe-dragbug-home');

const { rmSync, mkdirSync } = require('fs');
rmSync(HOME, { recursive: true, force: true });
mkdirSync(HOME, { recursive: true });

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

let ws, id = 0;
const pend = new Map();
function send(method, params, sessionId) {
  return new Promise((res, rej) => {
    const m = { id: ++id, method, params: params || {} };
    if (sessionId) m.sessionId = sessionId;
    pend.set(m.id, { res, rej });
    ws.send(JSON.stringify(m));
  });
}

/**
 * ⚠️ 单实例锁：桌宠开着的时候，第二个实例会被主进程直接 quit ——
 *    CDP 端口根本不会起来，症状是「探针连不上」。
 *    这里先数一遍进程表，有就别硬上（别去杀他正在用的那只）。
 */
function runningElectrons() {
  try {
    const out = require('child_process')
      .execSync('tasklist /FI "IMAGENAME eq electron.exe" /FO CSV /NH',
        { encoding: 'latin1', windowsHide: true });
    return out.split(/\r?\n/).filter((l) => /electron\.exe/i.test(l)).length;
  } catch { return 0; }
}

async function main() {
  const live = runningElectrons();
  if (live > 0) {
    console.error(`\n  ✗ 现在有 ${live} 个 electron 进程在跑（桌宠开着）。`);
    console.error('    单实例锁会挡掉探针 —— 请先把桌宠关掉再跑。\n');
    process.exit(2);
  }

  // ⚠️ 参数顺序：`--remote-debugging-port` 必须在**工程目录之前**
  //    （跟 scripts/selfcheck.cjs 一致）。写反了 Chromium 认不到这个开关。
  const child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`, ROOT], {
    env: cleanEnv({ YACHIYO_HOME: HOME }),
    stdio: 'ignore', detached: false,
  });

  /*
   * ⚠️ 这里原来写的是 `const page = list.find(...)`，而 `list` 只在 try 里赋值 ——
   *    一次都没连上时 `list` 是 `undefined`，报的是「Cannot read properties of
   *    undefined (reading 'find')」，看着像探针的代码错，其实是**窗口没起来**。
   *    现在起不来就说人话，并带上 _probe.log 的尾巴（那里才有真原因）。
   */
  let page = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      page = list.find((t) => t.type === 'page' && !t.url.includes('devtools')) || null;
      if (page) break;
    } catch { /* 还没起来，继续等 */ }
  }
  if (!page) {
    console.error(`\n  ✗ ${PORT} 端口上等不到页面 —— 窗口没起来。`);
    try {
      const log = require('fs').readFileSync(path.join(ROOT, '_probe.log'), 'utf8');
      console.error('  _probe.log 最后几行：');
      console.error(log.split(/\r?\n/).slice(-8).map((s) => '    ' + s).join('\n'));
    } catch { /* 没日志也算了 */ }
    try { child.kill(); } catch { /* ignore */ }
    process.exit(1);
  }

  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => { ws.onopen = r; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  };
  await send('Runtime.enable');

  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' +
      (r.exceptionDetails.exception && r.exceptionDetails.exception.description));
    return r.result.value;
  };

  const mouse = (type, x, y, button) => send('Input.dispatchMouseEvent', {
    type, x, y, button: button || 'left', buttons: type === 'mouseReleased' ? 0 : 1,
    clickCount: 1, pointerType: 'mouse',
  });

  await sleep(2500);

  const out = [];
  const chk = (name, ok, detail) => { out.push({ name, ok, detail }); };

  // 1) 窗口方框 vs 她的实际包围盒
  const geo = await ev(`
    const d = window.__yachiyo;
    return { dbg: !!d, inner: [innerWidth, innerHeight] };
  `);
  const size = await ev(`
    const st = document.getElementById('stage');
    return { stage: [st.offsetWidth, st.offsetHeight],
             left: st.offsetLeft, top: st.offsetTop, inner: [innerWidth, innerHeight] };
  `);
  chk('拿到窗口方框', !!size, JSON.stringify(size));

  // 2) 探一探她身上哪些点是"实心"的（用 hitPet 的逻辑反推：看 debug 里的 mask）
  //    这里直接问 debug.mask 拿不到原始掩码，改问：把鼠标移到某点，看穿透状态
  const probeHit = async (x, y) => {
    await mouse('mouseMoved', x, y);
    await sleep(180);
    return ev(`
      const d = window.__yachiyo;
      return d && d.debug ? !!d.debug().want : null;
    `);
  };

  /*
   * ⚠️ 点是她的坐标**不能拿 #stage 的方框算** —— #stage 是固定的 461×461 方块，
   *    而 `petSize=45` 时她只占中间一小块，位置还是 `left=1547 top=160` 那种
   *    **相对方框的偏移**。我第一版就拿方框中心去点，结果头顶/腰/脚**全打空**，
   *    看着像「穿透坏了」，其实是**我自己点错地方**。
   *    直接问截图里那套：`debug()` 里有 mask 的实心采样，用它反推她真正的包围盒。
   */
  await sleep(2000);   // 等掩码建起来（头几帧是空的）
  const box = await ev(`
    const d = window.__yachiyo.debug();
    return { pos: d.pos, stage: [document.getElementById('stage').offsetWidth,
                                 document.getElementById('stage').offsetHeight] };
  `);
  const [sw, sh] = size.stage;

  /*
   * ⚠️ 别猜「头大概在 18% 高度」这种 —— 她的**姿势会变**（idle / walk / sit / sleep
   *    换着来），掩码又是 48×48 的粗采样，单点试命中率很低。
   *    实测扫下来：竖着一条线很多时候**只有一格**能命中，姿势一变就全空。
   *
   *    所以先**扫一遍**把她身上真正点得着的点找出来，后面所有操作都用那个点。
   *    扫的是 #stage 方框内的归一化网格 —— `hitPet` 用的就是这个坐标系。
   */
  /*
   * ⚠️ 实测这条**偶尔**会空（8 次里挂 1 次左右）—— 抓到现场才知道为什么。
   *    所以失败时把「她到底在不在画布上」的关键量全落到 `_dragbug-fail.json`，
   *    别只留一句「空」。
   */
  const scan = await ev(`
    const st = document.getElementById('stage');
    const W = st.offsetWidth, H = st.offsetHeight;
    const out = [];
    // 复用页面上的 debug 判定需要真事件，改成直接读 canvas 的掩码自己算
    const cvs = document.querySelector('canvas');
    const M = 48;
    const c = document.createElement('canvas'); c.width = c.height = M;
    const x = c.getContext('2d', { willReadFrequently: true });
    x.clearRect(0, 0, M, M);
    x.drawImage(cvs, 0, 0, M, M);
    const px = x.getImageData(0, 0, M, M).data;
    let solid = 0;
    for (let gy = 0; gy < M; gy++) for (let gx = 0; gx < M; gx++) {
      if (px[(gy * M + gx) * 4 + 3] > 10) {
        solid++;
        out.push({ x: Math.round((gx + 0.5) / M * W), y: Math.round((gy + 0.5) / M * H) });
      }
    }
    // 取最靠中间那个实心格当握点（好拖）
    let mid = null, best = 1e9;
    for (const p of out) {
      const d = Math.abs(p.x - W / 2) + Math.abs(p.y - H / 2);
      if (d < best) { best = d; mid = p; }
    }
    return { solid, mid, left: out[0] || null, bottom: out[out.length - 1] || null };
  `);
  chk('扫到她身上有实心采样点', scan.solid > 20, `采样点 ${scan.solid} 个`);

  /* ⚠️ 这条偶尔会空 —— 失败时把现场存下来（画布尺寸 / 她的状态 / 掩码开关） */
  if (scan.solid <= 20) {
    const diag = await ev(`
      const cvs = document.querySelector('canvas');
      const g = cvs.getContext('2d');
      const d = g.getImageData(0, 0, cvs.width, cvs.height).data;
      let opaque = 0;
      for (let i = 3; i < d.length; i += 4 * 53) if (d[i] > 10) opaque++;
      const dbg = window.__yachiyo.debug();
      return {
        画布: { w: cvs.width, h: cvs.height, cssW: cvs.clientWidth, cssH: cvs.clientHeight },
        画布上的实心采样: opaque,
        rig有currentSet: !!(window.__yachiyo.rig && window.__yachiyo.rig.currentSet),
        rig件数: window.__yachiyo.rig && window.__yachiyo.rig.currentSet
                  ? window.__yachiyo.rig.currentSet.count : null,
        状态: window.__yachiyo.rig && window.__yachiyo.rig.mode,
        她的位置: dbg.pos,
        maskData有没有: dbg.mask,
        want: dbg.want,
      };
    `).catch((e) => ({ 诊断都失败了: e.message }));
    try {
      fs.writeFileSync(path.join(ROOT, '_dragbug-fail.json'),
        JSON.stringify({ scan, diag }, null, 2), 'utf8');
      console.error('  ⚠ 扫不到她 —— 现场已存到 _dragbug-fail.json');
      console.error('    ' + JSON.stringify(diag));
    } catch { /* 存不下也算了 */ }
  }

  const anchor = scan.mid || { x: Math.round(sw / 2), y: Math.round(sh / 2) };
  const cx = box.pos.x + anchor.x;   // 鼠标坐标是相对窗口的
  const midY = box.pos.y + anchor.y;
  // 头顶/脚边沿用扫描结果的两端（扫不到就退回中间的握点）
  const headY = box.pos.y + (scan.left ? scan.left.y : anchor.y);
  const footY = box.pos.y + (scan.bottom ? scan.bottom.y : anchor.y);
  const rHead = await probeHit(cx, headY);
  const rMid  = await probeHit(cx, midY);
  const rFoot = await probeHit(cx, footY);
  /*
   * ⚠️ 单点试命中**天生就是时好时坏**的 —— 掩码每 4 帧才刷一次，而且她还在呼吸/换姿势。
   *    所以这里不看单点，看**一整片区域里有多少点点得着**：
   *    实测身宽那几列里通常有一半左右能命中，这就足以证明「掩码在正常工作」。
   *    取 3 个位置各试 3 次，只要**任何一处命中**就算过 —— 判定的是能力，不是运气。
   */
  const tries = [[cx, headY], [cx, midY], [cx, footY]];
  let anyHit = false;
  const hitDetail = [];
  for (const [tx, ty] of tries) {
    let got = false;
    for (let k = 0; k < 3 && !got; k++) {
      // 每次先偏 2px 再回来 —— 同坐标的连续事件会被浏览器合并掉
      await mouse('mouseMoved', tx + 2, ty + 2); await sleep(80);
      got = (await probeHit(tx, ty)) === true;
    }
    hitDetail.push(`${ty}:${got ? '命中' : '空'}`);
    if (got) anyHit = true;
  }
  chk('★ 她身上点得着（掩码生效）', anyHit, hitDetail.join(' '));

  /*
   * 3) ★ 核心：按住鼠标 → 「鼠标跑出窗口」（mouseleave + blur）→ **不发 mouseup**
   *
   * ⚠️⚠️ 这一段的断言语义**取决于在测哪一版**，别搞反：
   *
   *   旧版（修复前）：mouseleave/blur 之后 `dragging` **仍然卡在 true**，
   *     而且 `want` 也永远是 true（穿透被永久关掉）—— 这时**「通过」= bug 复现**。
   *   修好后：blur 那条兜底会派发一个合成 mouseup，`dragging` **当场被清掉**，
   *     之后还能正常开始新的拖动 —— 这时**「通过」= bug 不复现**。
   *
   *   所以这里用一个开关切语义，免得看的人以为「全过」是好事。
   */
  const EXPECT_FIXED = process.env.DRAGBUG_REPRO !== '1';

  await mouse('mouseMoved', cx, midY);
  await sleep(100);
  await mouse('mousePressed', cx, midY);
  await sleep(120);
  const afterDown = await ev(`return !!window.__yachiyo.debug().dragging;`);
  chk('按下后进入 dragging', afterDown === true, `dragging=${afterDown}`);

  // 模拟"鼠标跑出窗口"：真实的离开就是这几下（mouseleave + 失焦）
  await ev(`
    window.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
    window.dispatchEvent(new Event('blur'));
    return 1;
  `);
  await sleep(300);
  const afterLeave = await ev(`
    const d = window.__yachiyo.debug();
    return { dragging: !!d.dragging, want: !!d.want, hit: d.hit };
  `);

  if (EXPECT_FIXED) {
    chk('★ 跑出窗口后 dragging 被清掉（不卡死）', afterLeave.dragging === false,
      JSON.stringify(afterLeave));
  } else {
    chk('★ [复现模式] dragging 仍卡住', afterLeave.dragging === true, JSON.stringify(afterLeave));
  }

  /*
   * 4) 再按一次 —— **这才是他真正报的症状**（卡住之后再也拖不动）。
   *
   * ⚠️ 这一步必须**带重试**，原因跟上面那条一样：掩码每 4 帧才刷一次，
   *    单发一个 mouseMoved 有可能落在旧掩码上判成「没压到她」，
   *    于是穿透没收回、mousedown 根本送不到渲染层 —— 那是**探针自己的时序**，
   *    不是产品的毛病。真人拖的时候鼠标是连续动的，根本不会卡在这上面。
   *    （这里要验的是「状态机能不能重新起拖」，不是「一发入魂」。）
   */
  let armed = false;
  for (let k = 0; k < 10 && !armed; k++) {
    await mouse('mouseMoved', cx + (k % 2 ? 2 : 0), midY + (k % 2 ? 2 : 0));
    await sleep(160);
    armed = (await ev(`return !!window.__yachiyo.debug().want;`)) === true;
  }
  chk('重新压到她身上（收回了穿透）', armed === true, `armed=${armed}`);

  await mouse('mousePressed', cx, midY);
  await sleep(180);
  const secondDown = await ev(`
    const d = window.__yachiyo.debug();
    return { dragging: !!d.dragging };
  `);
  if (EXPECT_FIXED) {
    chk('★ 还能重新开始拖（他能拖得动了）', secondDown.dragging === true, JSON.stringify(secondDown));
  } else {
    chk('★ [复现模式] 第二次按下仍起不了新拖动', secondDown.dragging !== true, JSON.stringify(secondDown));
  }

  // 5) 收尾：正常松手，状态要干净
  await mouse('mouseReleased', cx, midY);
  await sleep(250);
  const afterUp = await ev(`
    const d = window.__yachiyo.debug();
    return { dragging: !!d.dragging, want: !!d.want };
  `);
  chk('松手后 dragging 清空', afterUp.dragging === false, JSON.stringify(afterUp));

  /*
   * ⚠️ 松手那一刻鼠标**还压在她身上**，所以 want=true 是**对的**（本来就该收着鼠标）。
   *    要证明的是另一件事：**指针没被永久锁死** —— 把鼠标挪到左上角的空气处，
   *    这时必须恢复穿透（want=false），桌面才点得动。
   *    这正是他报的那个症状：卡住之后「桌面也点不动」。
   */
  await mouse('mouseMoved', 4, 4);
  await sleep(120);
  await mouse('mouseMoved', 6, 6);
  await sleep(300);
  const offHer = await ev(`
    const d = window.__yachiyo.debug();
    return { want: d.want, hit: d.hit };
  `);
  chk('★ 鼠标挪开 → 穿透还给桌面（没被锁死）', offHer.want === false, JSON.stringify(offHer));

  // 收拾
  try { await mouse('mouseReleased', cx, midY); } catch { /* ignore */ }

  console.log('');
  for (const o of out) console.log(`  ${o.ok ? '✓' : '✗'} ${o.name}  —— ${o.detail}`);
  const pass = out.filter((o) => o.ok).length;
  console.log(`\n  ${pass}/${out.length} ${pass === out.length ? '全过' : '有失败'}\n`);

  try { child.kill(); } catch { /* ignore */ }
  await sleep(400);
  process.exit(0);
}

main().catch((e) => { console.error('探针炸了：', e.message); process.exit(1); });
