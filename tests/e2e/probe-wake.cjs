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
 * probe-wake —— #4「完全无法互动」的修复验证（2026-10-17）
 *
 * 他后来确认了：**她当时是睡着状态**。而「睡」有两层 ——
 *   · 视觉层：rig 的 sleep 姿态（批次 B 的 wakeUp() 管）
 *   · **气泡层**：主进程 `review.isSleeping()`，`ui/bubble.js` 里
 *     「睡着了一个气泡都不冒」闸的就是它（这一层是 #4 的真凶）
 *
 * 判据（硬）：把她掰成睡着 → 点她一下 → **气泡那道闸必须打开**。
 *   `bubble.js` 自己把状态暴露成 `window.__yachiyoSleepState()`，
 *   所以这个"打开"是能直接量到的，不用靠看她说不说话。
 *
 * ⚠️ 真实进睡要"键鼠停够 55 分钟"，等不起 —— 用只给探针用的 `_sleep()` 掰。
 *
 * 用法：node probe-wake.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OUT = 'D:\\AI_work\\留痕\\稿子-批次C';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const chk = (n, ok, d) => { if (ok) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d !== undefined ? '   → ' + d : '')); } };

function connect(u) {
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' :: ' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description || ''));
  return r.result.value;
};
const ts = async () => (await (await fetch('http://127.0.0.1:9222/json/list')).json());
async function shot(c, name) {
  const r = await c.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
  console.log('   截图 → ' + name);
}

(async () => {
  console.log('probe-wake —— 她睡着的时候点她，叫得醒吗');
  console.log('');

  let main = null;
  for (let i = 0; i < 25 && !main; i++) {
    try { main = (await ts()).find((t) => /index\.html/.test(t.url)); } catch {}
    if (!main) await sleep(400);
  }
  if (!main) { console.log('✗ 没连上主窗口'); process.exit(1); }
  const mc = await connect(main.webSocketDebuggerUrl);
  await mc.send('Runtime.enable');

  /* 主窗口的探针口是 dev 版才有的 */
  const hasProbe = await ev(mc, `typeof window.yachiyo.ov._sleep`);
  chk('拿到了只给探针用的睡眠开关（_sleep）', hasProbe === 'function', hasProbe);
  if (hasProbe !== 'function') { process.exit(1); }
  chk('bubble.js 把睡眠状态暴露出来了（__yachiyoSleepState）',
    await ev(mc, `typeof window.__yachiyoSleepState`) === 'function');

  const probe = JSON.parse(await ev(mc, 'JSON.stringify(window.__yachiyo.hitProbe())'));
  const px = Math.round(probe.x), py = Math.round(probe.y);

  /* ---------- ① 先掰成睡着 ---------- */
  console.log('');
  console.log('── ① 把她掰成「准备睡」 ──');
  await ev(mc, `window.yachiyo.ov._sleep(true)`);
  await sleep(600);
  const s1 = await ev(mc, `window.__yachiyoSleepState()`);
  const s1b = await ev(mc, `window.yachiyo.ov._isSleeping()`);
  chk('★ 页面这边拿到了「睡着」（气泡闸已落下）', s1 === true, String(s1));
  chk('★ 主进程那边也是睡着的', s1b === true, String(s1b));

  /* ---------- ② 点她一下 ---------- */
  console.log('');
  console.log('── ② 点她一下（真·CDP 按下抬起，落到她身上）──');
  await mc.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
  await sleep(80);
  await mc.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
  await sleep(600);

  const s2 = await ev(mc, `window.__yachiyoSleepState()`);
  const s2b = await ev(mc, `window.yachiyo.ov._isSleeping()`);
  chk('★★ 点她之后，气泡闸**打开了**（页面这层）', s2 === false, String(s2));
  chk('★★ 主进程那层也醒了（改前这里还是 true —— 那就是 #4）', s2b === false, String(s2b));

  const mode = await ev(mc, `window.__yachiyo.rig.state.mode`);
  chk('她不是躺着的状态（视觉层没被留在 sleep）', mode !== 'sleep', String(mode));

  /* ---------- ③ 聊天那道闸也顺带解了 ---------- */
  console.log('');
  console.log('── ③ 顺带验：睡着时聊天会被拒，点过之后就不该拒了 ──');
  await ev(mc, `window.yachiyo.ov._sleep(true)`);
  await sleep(400);
  /*
   * ⚠️⚠️ 这里**别再调 `chat.send()`**（我第一版就这么干的）：
   *    · 它是**真发请求、真花钱**的 —— 探针不该顺手替他把钱花了；
   *    · 而且"睡着时聊天被拒"压根不归本轮管：那道检查在不同入口上不一样
   *      （`chat:send-quick` 才带"她睡了"），拿它当判据只会得出误导结论。
   *    ⇒ 只**读**状态，不发请求。
   */
  console.log('   睡着时主进程的睡眠标记 = ' + await ev(mc, `window.yachiyo.ov._isSleeping()`));

  /*
   * ⚠️ 2026-10-21：这里原来复用上面那组 `px/py` —— 但**她会动**（走动 / 换姿态），
   *    第一次点击之后那组坐标就过期了，第二次等于点在空气上 ⇒ 当然"没醒"。
   *    ⇒ 点之前重新量一次她此刻的身体位置。这不是放宽判据：
   *      只是让「点她一下」真的落在**她身上**，判据（主进程必须醒）一动不动。
   */
  const probe2 = JSON.parse(await ev(mc, 'JSON.stringify(window.__yachiyo.hitProbe())'));
  const px2 = Math.round(probe2.x), py2 = Math.round(probe2.y);
  await mc.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px2, y: py2, button: 'left', clickCount: 1 });
  await sleep(80);
  await mc.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px2, y: py2, button: 'left', clickCount: 1 });
  await sleep(600);
  chk('★ 点过之后主进程醒了（聊天便不再被"她睡了"挡）',
    (await ev(mc, `window.yachiyo.ov._isSleeping()`)) === false,
    '点在 (' + px2 + ',' + py2 + ') 之后仍是睡着的');

  /* ---------- ④ 顺手拍一张服务商那行（间距 + 去备注之后） ---------- */
  console.log('');
  console.log('── ④ 服务商那行的样子 ──');
  await ev(mc, `window.yachiyo.ov.open('panel'); 1`);
  await sleep(1600);
  const panel = (await ts()).find((t) => /panel\.html/.test(t.url));
  if (panel) {
    const pc = await connect(panel.webSocketDebuggerUrl);
    await pc.send('Runtime.enable');
    await pc.send('Page.enable');
    await sleep(500);
    await ev(pc, `(() => { const n = [...document.querySelectorAll('#navs .nav')].find((e) => e.textContent.trim() === 'AI 接入'); if (n) n.click(); return 1; })()`);
    await sleep(900);
    const row = JSON.parse(await ev(pc, `JSON.stringify((() => {
      const r = document.querySelector('#pMain .row[data-rk="providerPick"]');
      if (!r) return { found: false };
      const btns = [...r.querySelectorAll('button')];
      const cs = btns[0] ? getComputedStyle(btns[0].parentElement) : null;
      return {
        found: true,
        count: btns.length,
        names: btns.map((b) => b.textContent.trim()),
        gap: cs ? cs.columnGap : null,
        hasNote: !!r.querySelector('.kv'),
      };
    })())`));
    chk('服务商那行还在', row.found === true, JSON.stringify(row));
    chk('★ 按钮之间的间距有了（columnGap = ' + row.gap + '）', row.gap && row.gap !== 'normal' && parseFloat(row.gap) >= 8, String(row.gap));
    chk('★ 那行备注去掉了（没有 .kv 说明）', row.hasNote === false, String(row.hasNote));
    await shot(pc, '实测-服务商2.png');
    pc.close();
  }
  await ev(mc, `window.yachiyo.ov.closeKind('panel'); 1`);
  await sleep(300);
  await ev(mc, `window.yachiyo.ov._sleep(false)`);

  console.log('');
  console.log((fail === 0 ? '★ 全绿' : '✗ 有红') + `　${pass} 通过 / ${fail} 失败`);
  mc.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('炸了：' + e.message + '\n' + e.stack); process.exit(1); });
