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
 * probe-batchA —— 批次 A 那五条的真机验证
 *
 *   #6 眼动门：不碰她时 `rig.mouse.on` 必须是 false；碰一下之后必须变 true
 *   #2 可复制：聊天窗里 `.c-bub` 的 **计算样式** user-select 必须是 text
 *   #1 顺序  ：聊天窗第一次打开时，「—— 下面是你们之前聊的 ——」必须排在最前面
 *
 * ⚠️ #6 那条是本轮最要紧的 —— 它连的是「鼠标在屏幕底下那条里随便动，
 *    她的眼珠不该跟着转」。原来的写法是 `on: true` 恒真，所以：
 *    注入 mousemove 但**不先碰她** ⇒ on 应当保持 false。
 *
 * 用法：node probe-batchA.cjs
 */
'use strict';

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

(async () => {
  console.log('probe-batchA —— 批次 A 真机验证');
  console.log('');

  const targets = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const main = targets.find((t) => /index\.html/.test(t.url));
  const mc = await connect(main.webSocketDebuggerUrl);
  await mc.send('Runtime.enable');

  const probe = JSON.parse(await evalIn(mc, 'JSON.stringify(window.__yachiyo.hitProbe())'));
  const px = Math.round(probe.x), py = Math.round(probe.y);

  /* ---------- #6 眼动门 ---------- */
  console.log('── #6 眼动跟随的门 ──');

  // 先等过 15 秒冷静期（万一刚才是我们碰的）
  await evalIn(mc, 'window.__yachiyo.debug(); 1');   // 只是唤醒
  const frozenWait = 16;
  console.log('   等 ' + frozenWait + ' 秒让「互动有效期」过期……');
  await sleep(frozenWait * 1000);

  await mc.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px, y: py, button: 'none' });
  await sleep(200);
  const noTouch = JSON.parse(await evalIn(mc, 'JSON.stringify(window.__yachiyo.rig.mouse)'));

  chk('★ 没碰过她时，鼠标压在她身上也不跟（on=false）', noTouch.on === false, J(noTouch));

  // 碰她一下 = 注入一次真实按下（走 markInteract）
  await mc.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
  await sleep(80);
  await mc.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
  await sleep(120);
  await mc.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: px + 20, y: py, button: 'none' });
  await sleep(200);
  const touched = JSON.parse(await evalIn(mc, 'JSON.stringify(window.__yachiyo.rig.mouse)'));
  chk('★ 碰过她之后（15 秒内）就跟着鼠标了（on=true）', touched.on === true, J(touched));

  // 关掉跟随 = 配置 0
  const cfgNow = await evalIn(mc, 'window.__yachiyo.cfg.gazeFollowSec');
  chk('配置里有 gazeFollowSec（当前 ' + cfgNow + '）', typeof cfgNow === 'number', String(cfgNow));
  console.log('');

  /* ---------- #1 / #2 聊天窗 ---------- */
  console.log('── #1 #2 聊天窗 ──');
  await evalIn(mc, 'window.__yachiyo.openChat(); 1');
  await sleep(1200);

  const targets2 = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  const chat = targets2.find((t) => /chat\.html/.test(t.url));
  chk('聊天窗开起来了', !!chat, J(targets2.map((t) => t.url)));
  if (chat) {
    const cc = await connect(chat.webSocketDebuggerUrl);
    await cc.send('Runtime.enable');
    await sleep(600);

    const style = JSON.parse(await evalIn(cc, `JSON.stringify((() => {
      const b = document.querySelector('.c-bub');
      const s = document.querySelector('.c-sys');
      const t = document.getElementById('cInput');
      const g = (el) => el ? getComputedStyle(el).userSelect || getComputedStyle(el).webkitUserSelect : null;
      return { bub: g(b), sys: g(s), input: g(t), bar: g(document.querySelector('.bar')) };
    })())`));
    chk('★ 消息气泡的计算样式 user-select = text（能选中复制了）', style.bub === 'text', J(style));
    chk('输入框也是 text', style.input === 'text', J(style.input));
    chk('顶部拖动栏没被开成可选（拖窗口不会拖出选中残影）', style.bar !== 'text', J(style.bar));

    const rows = JSON.parse(await evalIn(cc, `JSON.stringify(
      [...document.getElementById('cBody').children].map((r) => ({
        cls: r.className,
        text: (r.textContent || '').slice(0, 30),
      }))
    )`));
    console.log('   聊天窗列表（前 5 条）：');
    for (const r of rows.slice(0, 5)) console.log('     · [' + r.cls + '] ' + JSON.stringify(r.text));

    const firstSys = rows.findIndex((r) => /下面是你们之前聊的|还没说过话/.test(r.text));
    chk('★ 历史提示排在第 1 条（历史整块在最前面）', firstSys === 0, '@' + firstSys);
    cc.close();
  }

  console.log('');
  console.log((fail === 0 ? '★ 全绿' : '✗ 有红') + `　${pass} 通过 / ${fail} 失败`);
  mc.close();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('炸了：' + e.message); process.exit(1); });
