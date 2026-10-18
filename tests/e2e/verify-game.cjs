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
 * verify-game —— 批次 D 真机验（2026-10-17）
 *
 * 验两半：
 *   ① 主进程那半：常驻 PowerShell **真的起来了**、`_game` 探针能广播
 *   ② 页面那半：收到「进游戏」之后她**真的坐下**、并且**钉住不走**（连点/等冷却都不动）
 *      再收到「退游戏」⇒ 放开、能自己换动作
 *
 * ⚠️ 判定逻辑（全屏 + 进程）不在这里验 —— 那是 `selfcheck-gamedetect` 的 25 项。
 *
 * 用法：node verify-game.cjs
 */
'use strict';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (o) => JSON.stringify(o);
let pass = 0, fail = 0;
const chk = (n, ok, d) => { if (ok) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d !== undefined ? '   → ' + d : '')); } };

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
const ts = async () => (await (await fetch('http://127.0.0.1:9222/json/list')).json());

(async () => {
  console.log('verify-game —— 游戏时保持坐着');
  console.log('');

  let main = null;
  for (let i = 0; i < 25 && !main; i++) {
    try { main = (await ts()).find((t) => /index\.html/.test(t.url)); } catch {}
    if (!main) await sleep(400);
  }
  if (!main) { console.log('✗ 没连上主窗口'); process.exit(1); }
  const mc = await conn(main.webSocketDebuggerUrl);
  await mc.send('Runtime.enable');

  chk('配置里有 gameDetect（默认开）', (await ev(mc, 'window.__yachiyo.cfg.gameDetect')) === true);

  /* ---------- ① 进游戏 ---------- */
  console.log('');
  console.log('── ① 假装进游戏 ──');
  const before = await ev(mc, 'window.__yachiyo.rig.state.mode');
  console.log('   进游戏前状态 = ' + before);
  const r1 = JSON.parse(await ev(mc, `(async () => JSON.stringify(await window.yachiyo.ov._game(true)))()`));
  console.log('   探针返回 = ' + J(r1));
  await sleep(600);
  const m1 = await ev(mc, 'window.__yachiyo.rig.state.mode');
  const l1 = await ev(mc, 'window.__yachiyo.rig.state.left');
  console.log('   进游戏后状态 = ' + m1 + '，left = ' + l1);
  chk('★ 她坐下了（mode = sit）', m1 === 'sit', String(m1));
  chk('★ 而且钉得比较久（left 很大，不会自己换动作）', Number(l1) > 1000, String(l1));

  /* ---------- ② 钉住：连点她也不该跑掉 ---------- */
  console.log('');
  console.log('── ② 钉得住吗（点她一下 + 等 3 秒）──');
  const probe = JSON.parse(await ev(mc, 'JSON.stringify(window.__yachiyo.hitProbe())'));
  if (probe) {
    await mc.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Math.round(probe.x), y: Math.round(probe.y), button: 'none' });
    await sleep(80);
    await mc.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(probe.x), y: Math.round(probe.y), button: 'left', clickCount: 1 });
    await sleep(60);
    await mc.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(probe.x), y: Math.round(probe.y), button: 'left', clickCount: 1 });
    await sleep(400);
  }
  const m2 = await ev(mc, 'window.__yachiyo.rig.state.mode');
  console.log('   点她之后 = ' + m2);
  chk('★ 点她也没把她点起来遛弯（还是 sit）', m2 === 'sit', String(m2));

  await sleep(3000);
  const m3 = await ev(mc, 'window.__yachiyo.rig.state.mode');
  console.log('   等 3 秒后 = ' + m3);
  chk('★ 3 秒后还是坐着（没被冷却重骰走）', m3 === 'sit', String(m3));

  /* ---------- ③ 退游戏 ---------- */
  console.log('');
  console.log('── ③ 假装退游戏 ──');
  await ev(mc, `(async () => JSON.stringify(await window.yachiyo.ov._game(false)))()`);
  await sleep(500);
  const l3 = await ev(mc, 'window.__yachiyo.rig.state.left');
  console.log('   退游戏后 left = ' + l3 + '（应该是 0 或很小 ⇒ 下一拍就会自己换动作）');
  chk('★ 放开了（left 不再被钉死）', Number(l3) < 1000, String(l3));

  console.log('');
  console.log((fail === 0 ? '★ 全绿' : '✗ 有红') + `　${pass} 通过 / ${fail} 失败`);
  mc.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('炸了：' + e.message + '\n' + e.stack); process.exit(1); });
