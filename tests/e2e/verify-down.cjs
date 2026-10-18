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
 * verify-down —— 自己验「隐藏/显示之后 `mousedown` 还会不会丢」（2026-10-17）
 *
 * 背景：他亲手测出来的记录是「隐藏/显示之后只有 mouseup、一条 mousedown 都没有」。
 * 元凶是我上一轮加的 `win.on('show')` 里那句 `setIgnoreMouseEvents(true)`（已删）。
 *
 * 这个脚本不需要他配合：用 CDP 注入 press/release，
 * 而记录器是挂在 **window（capture）** 上的 ⇒ 只要事件被派发就能记到，
 * **不依赖点中 canvas**（之前几次失败都是栽在"没点中她"上）。
 *
 * 用法：node verify-down.cjs
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
  console.log('verify-down —— 隐藏/显示之后 mousedown 会不会丢');
  console.log('');

  let main = null;
  for (let i = 0; i < 25 && !main; i++) {
    try { main = (await ts()).find((t) => /index\.html/.test(t.url)); } catch {}
    if (!main) await sleep(400);
  }
  if (!main) { console.log('✗ 没连上主窗口'); process.exit(1); }
  const mc = await conn(main.webSocketDebuggerUrl);
  await mc.send('Runtime.enable');

  /* 装最小记录器（只看 down / up） */
  await ev(mc, `(() => {
    window.__d = { down: 0, up: 0, ptr: 0 };
    window.addEventListener('pointerdown', () => window.__d.ptr++, true);
    window.addEventListener('mousedown',    () => window.__d.down++, true);
    window.addEventListener('mouseup',      () => window.__d.up++, true);
    return 1;
  })()`);

  const probe = JSON.parse(await ev(mc, 'JSON.stringify(window.__yachiyo.hitProbe())'));
  const px = Math.round(probe.x), py = Math.round(probe.y);
  console.log('她身上那一点：' + J({ x: px, y: py }));

  /** 注入一次按下+松开，返回计数器 */
  const poke = async (label) => {
    await ev(mc, `window.__d = { down: 0, up: 0, ptr: 0 }; 1`);
    await mc.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none' });
    await sleep(80);
    await mc.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
    await sleep(80);
    await mc.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
    await sleep(400);
    const d = JSON.parse(await ev(mc, `JSON.stringify(window.__d)`));
    const dbg = JSON.parse(await ev(mc, 'JSON.stringify(window.__yachiyo.debug())'));
    console.log(`   ${label}：${J(d)}  want=${dbg.want} hit=${dbg.hit}`);
    return d;
  };

  console.log('');
  console.log('── ① 隐藏/显示之前 ──');
  const a = await poke('注入按下+松开');
  chk('★ 之前：mousedown 到了', a.down > 0, J(a));

  console.log('');
  console.log('── ② 隐藏 → 显示（走托盘那条路）──');
  const t1 = await ev(mc, `(async () => JSON.stringify(await window.yachiyo.ov._trayToggle()))()`);
  console.log('   切换 #1（隐藏）：' + t1);
  await sleep(1400);
  const t2 = await ev(mc, `(async () => JSON.stringify(await window.yachiyo.ov._trayToggle()))()`);
  console.log('   切换 #2（显示）：' + t2);
  await sleep(1600);

  console.log('');
  console.log('── ③ 隐藏/显示之后 ──');
  const b = await poke('注入按下+松开');
  chk('★★ 之后：mousedown **照样到**（这就是验收点）', b.down > 0, J(b));
  chk('   pointerdown 也在', b.ptr > 0, J(b));
  chk('   mouseup 也在', b.up > 0, J(b));

  console.log('');
  console.log('   对照：之前 ' + J(a) + '　之后 ' + J(b));
  console.log('');
  console.log((fail === 0 ? '★ 全绿 —— 修好了' : '✗ 有红 —— mousedown 还是丢') + `　${pass} 通过 / ${fail} 失败`);
  mc.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('炸了：' + e.message + '\n' + e.stack); process.exit(1); });
