/*
 * ⚠️ 本文件 2026-10-18 由 `桌面\八千代AI桌宠工作留痕\` / `_dsh020\verify\` 搬进仓库。
 *    搬的时候只改了一件事：把写死的 `D:/AI_work/Git` 换成 `path.resolve(__dirname,'..','..')`。
 *    逻辑一行没动 —— 这些探针每天都在用，改逻辑就是给自己找麻烦。
 *
 *    跑之前要先有一个**带 CDP 的实例**（`YACHIYO_CDP=9222 npm start`），
 *    否则会报"没连上主窗口"。见 tests/e2e/README.md。
 */
// 装「鼠标事件记录器」——他真人点，我这边只读，不注入任何输入
// 用法：node arm-record.cjs            装记录器
//       node arm-record.cjs --read     读记录（读一下 _probe.log 尾巴一起对时间线）
//
// ★ 2026-10-18 补（#6 第三轮）：
//   ① 加 mousemove（节流 150ms）—— "页面收不到鼠标消息" 这个假设必须能直接量出来
//   ② 每 500ms 轮询一次 `win:state`（主进程那边真设下去的穿透值 + 最近 20 次 IPC）
//      ⇒ 能一刀切开：页面没发 / 发了没生效 / 事件到了但没进 mousedown
//   ③ --read 顺便读 `_probe.log` 尾巴（托盘那条路的 `[托盘]` `[窗口]` `[鼠标]` 行）
const fs = require('node:fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = path.resolve(__dirname, '..', '..');
const PROBE_LOG = REPO + '/_probe.log';

function conn(u) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(u); let i = 0; const w = new Map();
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && w.has(m.id)) { const { res: r, rej: j } = w.get(m.id); w.delete(m.id); m.error ? j(new Error(JSON.stringify(m.error))) : r(m.result); }
    });
    ws.addEventListener('open', () => res({
      send: (me, p) => { const id = ++i; return new Promise((r, j) => { w.set(id, { res: r, rej: j }); ws.send(JSON.stringify({ id, method: me, params: p || {} })); }); },
      close: () => ws.close(),
    }));
    ws.addEventListener('error', () => rej(new Error('ws error')));
  });
}
const ev = async (c, e) => {
  const r = await c.send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

const ARM = `(() => {
  window.__rec = [];
  window.__recOn = true;
  const snap = (kind, e) => {
    if (!window.__recOn) return;
    const y = window.__yachiyo;
    const d = y && y.debug ? y.debug() : {};
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const cs = el ? getComputedStyle(el) : null;
    window.__rec.push({
      t: Math.round(performance.now()),
      kind,
      x: e.clientX, y: e.clientY, btn: (e.button === undefined ? null : e.button),
      hit: d.hit, want: d.want, dragging: d.dragging,
      sends: d.sends, reasserts: d.reasserts, shown: d.showns,
      pos: d.pos, size: y && y.size,
      el: el ? (el.id || el.tagName) : null,
      // ★ 关键诊断：那个点的元素是不是"窗口拖动区"（drag 区会把左键 mousedown 吃掉）
      region: cs ? (cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region') || 'none') : null,
      pe: cs ? cs.pointerEvents : null,
      mode: (y && y.rig && y.rig.state) ? y.rig.state.mode : null,
    });
    if (window.__rec.length > 800) window.__rec.shift();
  };
  /*
   * ⚠️ 加一条 pointerdown —— 它和 mousedown 不同层：
   *    如果 pointerdown 有、mousedown 没有 ⇒ 说明中间被**窗口拖动区**之类吃掉了，
   *    不是"事件没进来"。这一条能一刀切开。
   * ⚠️ 这个字符串在模板里，注释里**不能写反引号**（会提前闭合模板，栽过两次）。
   */
  window.addEventListener('pointerdown', (e) => snap('PTR-down', e), true);
  window.addEventListener('mousedown', (e) => snap('WD-down', e), true);
  window.addEventListener('mouseup',   (e) => snap('WD-up',   e), true);
  window.addEventListener('click',     (e) => snap('WD-click', e), true);
  window.addEventListener('contextmenu', (e) => snap('WD-ctx', e), true);
  const cvs = document.getElementById('pet');
  if (cvs) {
    cvs.addEventListener('mousedown', (e) => snap('CVS-down', e), true);
    cvs.addEventListener('mouseup',   (e) => snap('CVS-up',   e), true);
  }

  /* ① mousemove 计数（节流 150ms）+ 前 12 次的前几个点，能看出"消息到底进不进来" */
  window.__mv = { n: 0, first: [], last: null };
  window.__mvArm = performance.now();
  window.addEventListener('mousemove', (e) => {
    const mv = window.__mv;
    const now = performance.now();
    if (mv.last && now - mv.last.t < 150) { mv.n++; return; }
    mv.n++;
    mv.last = { t: Math.round(now - window.__mvArm), x: e.clientX, y: e.clientY };
    if (mv.first.length < 12) mv.first.push(mv.last);
  }, true);

  /* ② 主进程那边的真实穿透值（每 500ms 一条） */
  window.__recMain = [];
  if (!window.__mainTimer) {
    window.__mainTimer = setInterval(async () => {
      try {
        const s = await window.yachiyo.win.state();
        const d = window.__yachiyo.debug();
        window.__recMain.push({
          t: Math.round(performance.now() - window.__mvArm),
          visible: s ? s.visible : null,
          ignore: s ? s.ignore : null,
          want: d.want, sends: d.sends, reasserts: d.reasserts, shown: d.showns,
          lastMoves: window.__mv.n,
        });
        if (window.__recMain.length > 240) window.__recMain.shift();
      } catch (err) { /* 窗口正在销毁就算了 */ }
    }, 500);
  }

  // 顺便记一下她的画布和 stage 的 app-region
  const st = document.getElementById('stage');
  window.__stageRegion = st ? (getComputedStyle(st).webkitAppRegion || 'none') : 'no-stage';
  return 'armed; stage app-region = ' + window.__stageRegion;
})()`;

function tailProbeLog(n) {
  try {
    const b = fs.readFileSync(PROBE_LOG, 'utf8').split('\n').filter((s) => s.trim());
    return b.slice(-n);
  } catch { return ['（读不到 ' + PROBE_LOG + '）']; }
}

(async () => {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const main = list.find((t) => /index\.html/.test(t.url));
  if (!main) { console.log('✗ 没连上主窗口'); process.exit(1); }
  const mc = await conn(main.webSocketDebuggerUrl);
  await mc.send('Runtime.enable');

  if (process.argv.includes('--read')) {
    const raw = await ev(mc, `JSON.stringify(window.__rec || [])`);
    const rec = JSON.parse(raw);
    const mv = JSON.parse(await ev(mc, `JSON.stringify(window.__mv || {n:0,first:[],last:null})`));
    const mainRec = JSON.parse(await ev(mc, `JSON.stringify(window.__recMain || [])`));
    await ev(mc, `window.__rec = []; window.__mv = {n:0,first:[],last:null}; 1`);

    console.log('── ① 鼠标事件（' + rec.length + ' 条）──');
    if (!rec.length) console.log('   （一条都没有 —— 说明按下压根没到页面）');
    for (const r of rec) {
      console.log(`   ${String(r.t).padStart(6)}ms  ${r.kind.padEnd(9)} (${r.x},${r.y}) btn=${r.btn}`
        + `  el=${r.el}  hit=${r.hit} want=${r.want} drag=${r.dragging} sends=${r.sends}`
        + `  mode=${r.mode}  pos=${r.pos ? Math.round(r.pos.x) + ',' + Math.round(r.pos.y) : '?'}`);
    }

    console.log('\n── ② mousemove（页面到底收不收得到）──');
    console.log('   总共 ' + mv.n + ' 条；最后一条：' + JSON.stringify(mv.last));
    console.log('   前几条：' + JSON.stringify((mv.first || []).slice(0, 6)));

    console.log('\n── ③ 主进程状态时间线（visible / ignore / 页面 want / sends）──');
    if (!mainRec.length) console.log('   （一条都没有 —— 轮询没起来）');
    let prev = null;
    for (const r of mainRec) {
      const key = `${r.visible}/${r.ignore}/${r.want}`;
      if (key === prev) continue;   // 只打"变了"的那几拍，别刷屏
      prev = key;
      console.log(`   ${String(r.t).padStart(6)}ms  visible=${r.visible}  ignore=${r.ignore}`
        + `  want=${r.want}  sends=${r.sends} reasserts=${r.reasserts} shown=${r.shown} moves=${r.lastMoves}`);
    }
    console.log('   共 ' + mainRec.length + ' 拍');

    console.log('\n── ④ _probe.log 尾巴（[托盘] [窗口] [鼠标]）──');
    for (const l of tailProbeLog(40)) console.log('   ' + l);

    const now = JSON.parse(await ev(mc, `JSON.stringify({dbg: window.__yachiyo.debug(), mode: window.__yachiyo.rig.state.mode, probe: window.__yachiyo.hitProbe()})`));
    console.log('\n   此刻：' + JSON.stringify({ last: now.dbg.last, want: now.dbg.want, hit: now.dbg.hit, mask: now.dbg.mask, mode: now.mode, sends: now.dbg.sends }));
    console.log('   hitProbe = ' + JSON.stringify(now.probe));
    process.exit(0);
  }

  const r = await ev(mc, ARM);
  console.log('记录器：' + r);
  const st = JSON.parse(await ev(mc, `JSON.stringify({dbg: window.__yachiyo.debug(), probe: window.__yachiyo.hitProbe(), mode: window.__yachiyo.rig.state.mode})`));
  console.log('现在：last=' + JSON.stringify(st.dbg.last) + ' want=' + st.dbg.want + ' hit=' + st.dbg.hit + ' mode=' + st.mode);
  console.log('      hitProbe=' + JSON.stringify(st.probe));
  console.log('      sends=' + st.dbg.sends + ' reasserts=' + st.dbg.reasserts + ' showns=' + st.dbg.showns);
  process.exit(0);
})();
