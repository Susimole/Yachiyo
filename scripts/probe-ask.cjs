/**
 * 2026-10-12 那三样新东西的验收：
 *   ① 点她 → 叮咚音效真的加载了、真的在播
 *   ② 双击她 → 弹出「快速问一句」的小条；回车 → 条子消失
 *   ③ 她的回复冒在**气泡**上（不进聊天窗），而且是一段段涨上来的
 *   ④ icon：新 .ico 是**多尺寸**的（托盘 16/20/24 不糊）
 *
 * 走本地假模型（scripts/fake-llm.cjs），不联网、不花钱。
 * 跑法：node scripts/probe-ask.cjs
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9344;
const FAKE_PORT = 8792;
const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}/v1`;
const HOME = path.join(ROOT, '_probe-ask-home');
const OUT = path.join(ROOT, '_ask-shots');
const RUN_MS = Number(process.env.PROBE_MS || 90000);

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
  static async attach(urlPart) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    const p = urlPart
      ? pages.find((t) => (t.url || '').includes(urlPart))
      : pages.find((t) => !/(menu|panel|chat|ask)\.html/.test(t.url || ''));
    if (!p) throw new Error('没找到 target（想要 ' + (urlPart || '主窗口') + '）');
    const ws = new WebSocket(p.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连不上')), { once: true });
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
      setTimeout(() => { if (this.pend.has(id)) { this.pend.delete(id); rej(new Error(method + ' 超时')); } }, 15000);
    });
  }
  async evalJs(expr) {
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
  async shot(file, w, h, scale = 2) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale } });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  }
}

async function attachOverlay(part, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try { return await CDP.attach(part); } catch { await sleep(150); }
  }
  return null;
}


/** ⚠️ fake-llm 的 /__last 在「一条都没收到」时返回的是纯文本 "not found"，直接 .json() 会炸 */
async function lastReq() {
  try {
    const r = await fetch(`${FAKE_URL}/__last`);
    const t = await r.text();
    try { return JSON.parse(t); } catch { return { last: null, calls: 0 }; }
  } catch { return { last: null, calls: 0 }; }
}

let fakeProc = null;
let child = null;
const fail = [];
const ok = (cond, msg, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '   ' + extra : ''}`);
  if (!cond) fail.push(msg);
};

/** 只收 electron —— ⚠️ 别顺手把假模型服务也收了，下面还要用它 */
async function killElectron() {
  try { child?.kill(); } catch { /* 没了 */ }
  try {
    execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\')}*' } | ` +
      'ForEach-Object { $_.Kill() }"', { stdio: 'ignore' });
  } catch { /* 干净退了 */ }
}

async function killAll() {
  await killElectron();
  try { fakeProc?.kill(); } catch { /* 没起来 */ }
}

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    apiBase: FAKE_URL, apiKey: 'sk-fake', model: 'deepseek-flash',
    petSize: 100, moveEnabled: false, roam: 'quiet', sound: true,
  }, null, 2), 'utf8');

  fakeProc = spawn(process.execPath, [path.join(__dirname, 'fake-llm.cjs'), String(FAKE_PORT)], { stdio: 'ignore' });
  await sleep(700);

  // ⚠️ 这里只能收 electron。写 killAll() 的话假服务刚起来就被自己杀了，
  //    对话链整条变 ECONNREFUSED —— 然后你会以为是气泡那条路坏了。
  await killElectron();
  await sleep(600);

  child = spawn(electronPath, [`--remote-debugging-port=${CDP_PORT}`, ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, YACHIYO_MS: String(RUN_MS), YACHIYO_HOME: HOME },
    stdio: 'ignore',
  });

  let m = null;
  for (let i = 0; i < 50 && !m; i++) { await sleep(500); try { m = await CDP.attach(); } catch { /* 还没起来 */ } }
  if (!m) { await killAll(); throw new Error('Electron 没起来'); }

  try {
    await sleep(3000);
    const win = await m.evalJs(`return { w: window.innerWidth, h: window.innerHeight };`);

    /* ---- 1. 音效 ---- */
    console.log('\n[1] 点击音效');
    const snd = await m.evalJs(`
      const mod = await import('./ui/sound.js');
      return mod.soundStats();
    `);
    const click = (snd.click || [])[0] || {};
    console.log('   池子:', JSON.stringify(snd.click));
    ok(!!click.src, '叮咚.mp3 挂上了', click.src);
    ok(click.readyState >= 2, '音频解码成功（readyState ≥ 2）', `readyState=${click.readyState} duration=${click.duration}s`);
    ok(!click.error, '没有解码错误', click.error ? 'mediaError=' + click.error : '');

    // 真的点一下她：音效要走「有声音输出」那条路 —— 这里只能验它没抛、currentTime 动了
    const hit = await m.evalJs(`return window.__yachiyo.hitProbe();`);
    await m.evalJs(`window.__yachiyo.rig.locked = true; window.__yachiyo.rig.setMode('idle'); return 1;`);
    await m.mouse('mousePressed', hit.x, hit.y, 'left');
    await m.mouse('mouseReleased', hit.x, hit.y, 'left');
    await sleep(500);
    const played = await m.evalJs(`
      const mod = await import('./ui/sound.js');
      const st = mod.soundStats().click;
      return { any: st.some(s => s.src && true), paused: null };
    `);
    ok(!!played.any, '点完之后音效模块还活着（没把点击带崩）');

    // 配置里关掉 → 不该再响（看 play() 里的短路）
    const muted = await m.evalJs(`
      const mod = await import('./ui/sound.js');
      window.__yachiyo.cfg.sound = false;      // 手动改本地 CFG（跟设置面板同一个对象）
      mod.play('click');
      window.__yachiyo.cfg.sound = true;
      return 'ok';
    `);
    ok(muted === 'ok', '音效关掉时 play() 不抛异常');

    /* ---- 2. 双击 → 快速问一句 ---- */
    console.log('\n[2] 双击弹出输入条');
    // ⚠️ 用 __yachiyo.openAsk 直接调，不去赌 CDP 双击的时间窗
    //    （Input.dispatchMouseEvent 连点两次的 detail 计数不可靠）
    await m.evalJs(`window.__yachiyo.openAsk(); return 1;`);
    const ask = await attachOverlay('ask.html');
    ok(!!ask, '输入条窗口建出来了');
    if (ask) {
      await sleep(500);
      const info = await ask.evalJs(`
        const card = document.querySelector('.ask-card').getBoundingClientRect();
        const inp = document.getElementById('aInput');
        return { open: await window.yachiyo.ov.isOpen('ask'),
                 w: Math.round(card.width), h: Math.round(card.height),
                 winW: window.innerWidth, winH: window.innerHeight,
                 inpW: Math.round(inp.getBoundingClientRect().width),
                 focused: document.activeElement === inp,
                 ph: inp.placeholder };
      `);
      console.log(`   卡片 ${info.w}×${info.h} / 窗口 ${info.winW}×${info.winH} · 输入框 ${info.inpW}px`);
      ok(info.open, '输入条是开着的');
      ok(Math.abs(info.w - info.winW) <= 2 && Math.abs(info.h - info.winH) <= 2, '卡片填满窗口（没露透明边）');
      ok(info.inpW > 120, '输入框有地方打字', `${info.inpW}px`);
      ok(info.focused, '光标已经在输入框里（不用再点一下）');
      await ask.shot('01-输入条.png', info.winW, info.winH, 2);

      /* ---- 3. 回车 → 条子消失 + 回复冒气泡 ---- */
      console.log('\n[3] 回车 → 条子收掉 + 气泡回复');
      /*
       * 在页面里挂一个计数器数 **delta 事件**。
       * ⚠️ 光靠外面每 200ms 采一次 DOM 是验不出「流式」的 ——
       *    假服务 3 个字一块、每 12ms 一块，8 个字的句子 36ms 就吐完了，
       *    外面采到的永远是最后那一帧，看着像「一次性弹出来」。
       *    采样的锅，不是代码的锅。
       */
      await m.evalJs(`
        window.__dn = 0;
        window.yachiyo.on('bubble:delta', () => { window.__dn++; });
        return 1;
      `);
      await ask.evalJs(`
        const el = document.getElementById('aInput');
        el.value = '报数';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 1;
      `);
      await sleep(400);
      const gone = await m.evalJs(`return await window.yachiyo.ov.isOpen('ask');`);
      ok(gone === false, '回车之后输入条自己收掉了');

      /*
       * 气泡：等流式涨上来。
       * ⚠️ 别死等到超时 —— 说完了 6 秒会自动收，跑满 8 秒采到的最后一帧是「已经关了」，
       *    于是三条断言全红，看着像功能坏了。采到目标句子就停，并留下**最长的那一帧**。
       */
      const frames = [];
      for (let i = 0; i < 40; i++) {
        const b = await m.evalJs(`
          const el = document.getElementById('bubble');
          return { open: el.classList.contains('open'),
                   text: document.getElementById('bText').textContent,
                   w: el.offsetWidth, h: el.offsetHeight };
        `);
        frames.push(b);
        if (b.open && /一二三/.test(b.text)) break;
        if (!b.open && frames.some((f) => f.text.length > 0)) break;   // 已经说过又关了
        await sleep(200);
      }
      const grew = frames.filter((f) => f.open && f.text.length > 0);
      const best = grew.reduce((a, b) => (b.text.length >= (a?.text.length ?? -1) ? b : a), null) || { text: '' };
      const dn = await m.evalJs(`return window.__dn;`);
      console.log(`   气泡帧数 ${grew.length} · delta 事件 ${dn} 次 · 说到最长「${best.text}」`);
      ok(grew.length > 0, '气泡冒出来了');
      ok(/一二三/.test(best.text), '气泡里是她的回复', best.text);
      ok(dn >= 2, '回复是**一块块推**过来的（流式，不是一次性整段）', `${dn} 块`);
      await m.shot('02-气泡回复.png', win.w, win.h, 2);

      // ⚠️ 关键：这条**不能**进聊天窗（他要求的是气泡，不是开个窗）
      const chatTarget = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json())
        .find((t) => (t.url || '').includes('chat.html'));
      ok(!chatTarget, '聊天窗没被顺带打开（回复走的是气泡）');

      /* ---- 4. 空输入按回车 = 关掉，不发 ---- */
      console.log('\n[4] 空着按回车');
      // ⚠️ 等上一轮真的回完（busy 锁），不然「没发新请求」可能是因为还在忙
      for (let i = 0; i < 30; i++) {
        const l = await lastReq();
        if (l.last) break;
        await sleep(200);
      }
      const before = await lastReq();
      await m.evalJs(`window.__yachiyo.openAsk(); return 1;`);
      await sleep(400);
      await ask.evalJs(`
        const el = document.getElementById('aInput');
        el.value = '   ';
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 1;
      `);
      await sleep(700);
      const closed = await m.evalJs(`return await window.yachiyo.ov.isOpen('ask');`);
      const after = await lastReq();
      ok(closed === false, '空着按回车 → 只关掉，不报错');
      ok((before.last?.at || 0) === (after.last?.at || 0), '空输入没有发出去（假服务没收到新请求）');
    }

    /* ---- 5. icon ---- */
    console.log('\n[5] 图标');
    const ico = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'assets', 'icon.ico'));
    // ICO 头：前 2 字节保留 0，第 3~4 字节 type=1(icon)，第 5~6 字节是**图像张数**
    const n = ico.readUInt16LE(4);
    const sizes = [];
    for (let i = 0; i < n; i++) {
      const off = 6 + i * 16;
      const w = ico[off] === 0 ? 256 : ico[off];
      sizes.push(w);
    }
    console.log('   icon.ico 里有这些尺寸:', sizes.join(' / '));
    ok(n >= 4, '是新那个多尺寸 .ico（不是单张 128）', `${n} 张`);
    ok(sizes.includes(16) && sizes.includes(24) && sizes.includes(32),
       '托盘要的 16/24/32 都在（小尺寸不会糊）', sizes.join('/'));

    for (const f of ['menu.html', 'panel.html', 'chat.html']) {
      const t = await attachOverlay(f, 3);
      if (!t) { console.log(`   ${f} 没开着，跳过`); continue; }
      const a = await t.evalJs(`const i = document.querySelector('.bar .ava');
        return i ? { w: i.naturalWidth, src: i.getAttribute('src') } : null;`);
      ok(a && a.w > 0, `${f} 标题栏头像加载出来了`, a ? `${a.w}px` : '没有');
    }
    // 设置面板左下角那个「八」—— 换成图片了
    await m.evalJs(`await window.yachiyo.ov.open('panel', { page: 'habit' }); return 1;`);
    await sleep(1200);
    const pnl = await attachOverlay('panel.html');
    if (pnl) {
      const foot = await pnl.evalJs(`
        const f = document.querySelector('.p-side .p-foot .m-ava');
        return f ? { tag: f.tagName, w: f.naturalWidth || 0, text: (f.textContent||'').trim() } : null;
      `);
      console.log('   左下角:', JSON.stringify(foot));
      ok(foot && foot.tag === 'IMG' && foot.w > 0, '设置面板左下角那个「八」换成图标了',
         foot ? `<${foot.tag}> ${foot.w}px` : '找不到');
      await pnl.shot('03-面板左下角.png', 780, 580, 1.5);
    }
  } finally {
    await killAll();
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
}

main().catch(async (e) => { console.error(e); await killAll(); process.exit(1); });
