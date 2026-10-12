/**
 * 2026-10-12 最后四项的验收：
 *   ① 音效音量滑块 —— **只在设置面板**，右键菜单里没有
 *   ② 夜间模式文字是白的
 *   ③ 界面字体可换（用 `%APPDATA%\Yachiyo\fonts\` 里的 ttf）
 *   ④ 设置面板**不置顶**，而且不遮挡别的窗口
 *
 * 跑法：node scripts/probe-4tweaks.cjs
 * 产出：_fx-shots\*.png
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9360;
const HOME = path.join(ROOT, '_probe-fx-home');
const OUT = path.join(ROOT, '_fx-shots');
const RUN_MS = Number(process.env.PROBE_MS || 150000);

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
      setTimeout(() => { if (this.pend.has(id)) { this.pend.delete(id); rej(new Error(method + ' 超时')); } }, 20000);
    });
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text);
    return r.result.value;
  }
  async shot(file, w, h, scale = 1.5) {
    const r = await this.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale } });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
  }
}

async function attachOverlay(part, tries = 25) {
  for (let i = 0; i < tries; i++) {
    try { return await CDP.attach(part); } catch { await sleep(150); }
  }
  return null;
}

let child = null;
const fail = [];
const ok = (cond, msg, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '   ' + extra : ''}`);
  if (!cond) fail.push(msg);
};

async function killElectron() {
  try { child?.kill(); } catch { /* 没了 */ }
  try {
    execSync('powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\')}*' } | ` +
      'ForEach-Object { $_.Kill() }"', { stdio: 'ignore' });
  } catch { /* 干净退了 */ }
}

/** 量一段固定文字在**当前字体**下有多宽 —— 换没换成，看这个最实在 */
const MEASURE = (text) => `
  const d = document.createElement('span');
  d.textContent = ${JSON.stringify(text)};
  d.style.cssText = 'position:fixed;left:-9999px;top:0;font-size:32px;white-space:nowrap;';
  document.body.appendChild(d);
  const w = +d.getBoundingClientRect().width.toFixed(2);
  d.remove();
  return w;
`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'data'), { recursive: true });
  fs.mkdirSync(path.join(HOME, 'fonts'), { recursive: true });
  // ⚠️ 字体要真的丢进**这个隔离家里**才有得测（真家那份不影响自检）
  const TTF = 'C:\\Users\\Susim\\Desktop\\系统字体更换\\细圆体.ttf';
  const hasTtf = fs.existsSync(TTF);
  if (hasTtf) fs.copyFileSync(TTF, path.join(HOME, 'fonts', '细圆体.ttf'));
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    petSize: 60, moveEnabled: false, alwaysOnTop: true,
  }, null, 2), 'utf8');

  await killElectron();
  await sleep(500);

  child = spawn(electronPath, [`--remote-debugging-port=${CDP_PORT}`, ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, YACHIYO_MS: String(RUN_MS), YACHIYO_HOME: HOME },
    stdio: 'ignore',
  });

  let m = null;
  for (let i = 0; i < 50 && !m; i++) { await sleep(500); try { m = await CDP.attach(); } catch { /* 还没起来 */ } }
  if (!m) { await killElectron(); throw new Error('Electron 没起来'); }

  try {
    await sleep(3000);
    console.log(`   字体测试文件：${hasTtf ? '有' : '没有（跳过字体那条）'} ${TTF}`);

    /* ============ ④ 设置面板不置顶 ============ */
    console.log('\n[1] 设置面板不置顶');
    await m.evalJs(`window.yachiyo.ov.open('panel', { page: 'habit' }); return 1;`);
    const pnl = await attachOverlay('panel.html');
    ok(!!pnl, '面板开出来了');
    await sleep(700);

    const pi = await m.evalJs(`return await window.yachiyo.ov.info('panel');`);
    console.log('   面板窗口:', JSON.stringify(pi));
    ok(pi.exists && pi.open, '面板窗口是开着的');
    ok(pi.topmost === false, '**面板窗口没有置顶**', `topmost=${pi.topmost}`);

    const mainTop = await m.evalJs(`return (await window.yachiyo.win.state()).alwaysOnTop;`);
    ok(mainTop === false, '面板开着时主窗口让位', `主窗口 alwaysOnTop=${mainTop}`);

    // 菜单也开一个 → 两个都开着，关掉菜单，主窗口**不能**顶起来
    await m.evalJs(`window.yachiyo.ov.open('menu', { at: { x: 120, y: 120 } }); return 1;`);
    await sleep(700);
    const both = await m.evalJs(`
      return { menu: (await window.yachiyo.ov.info('menu')).topmost,
               panel: (await window.yachiyo.ov.info('panel')).topmost,
               main: (await window.yachiyo.win.state()).alwaysOnTop };`);
    ok(both.menu === false && both.panel === false, '菜单和面板都不置顶', JSON.stringify(both));
    await m.evalJs(`window.yachiyo.ov.closeKind('menu'); return 1;`);
    await sleep(700);
    const afterMenu = await m.evalJs(`return (await window.yachiyo.win.state()).alwaysOnTop;`);
    ok(afterMenu === false, '关掉菜单、面板还开着 → 主窗口**仍然让位**（这一条最容易写错）',
      `主窗口 alwaysOnTop=${afterMenu}`);

    await m.evalJs(`window.yachiyo.ov.closeKind('panel'); return 1;`);
    await sleep(700);
    const afterAll = await m.evalJs(`return (await window.yachiyo.win.state()).alwaysOnTop;`);
    ok(afterAll === true, '两个都关了 → 主窗口按配置恢复置顶', `主窗口 alwaysOnTop=${afterAll}`);

    /* ============ ② 夜间模式白字 ============ */
    console.log('\n[2] 夜间模式文字颜色');
    await m.evalJs(`window.yachiyo.ov.open('panel', { page: 'habit' }); return 1;`);
    await sleep(800);
    await m.evalJs(`await window.yachiyo.cfg.set('theme', 'dark'); return 1;`);
    await sleep(800);

    const dark = await pnl.evalJs(`
      const cs = getComputedStyle(document.body);
      const el = document.querySelector('#pMain h2');
      return { varFg: cs.getPropertyValue('--fg').trim(),
               computed: el ? getComputedStyle(el).color : null,
               sub: cs.getPropertyValue('--sub').trim(),
               dark: document.body.classList.contains('dark') };`);
    console.log('   面板:', JSON.stringify(dark));
    ok(dark.dark, '面板切到深色了');
    ok(dark.varFg.toUpperCase() === '#FFFFFF', '--fg 是纯白', dark.varFg);
    ok(dark.computed === 'rgb(255, 255, 255)', '正文实际渲染出来是白的', dark.computed);

    const mainDark = await m.evalJs(`
      document.body.classList.contains('dark')
        ? getComputedStyle(document.documentElement).getPropertyValue('--fg').trim() : '（主窗口还是浅色）';`);
    console.log('   主窗口 --fg:', mainDark);
    await pnl.shot('01-夜间模式.png', 780, 580, 1.5);

    await m.evalJs(`await window.yachiyo.cfg.set('theme', 'light'); return 1;`);
    await sleep(600);

    /* ============ ③ 字体 ============ */
    console.log('\n[3] 界面字体');
    const list = await m.evalJs(`return await window.yachiyo.font.list();`);
    console.log('   字体目录里:', JSON.stringify(list));
    ok(Array.isArray(list), '能列出字体目录');

    if (list.length) {
      const before = await pnl.evalJs(MEASURE('八千代 Abc 123 测试'));
      await pnl.evalJs(`await window.yachiyo.cfg.set('fontFamily', ${JSON.stringify(list[0])}); return 1;`);
      await sleep(1200);

      const st = await pnl.evalJs(`
        const mod = await import('./ui/font.js');
        return mod.fontState();`);
      console.log('   字体状态:', JSON.stringify(st));
      // ⚠️ 判据必须是 registered 列表 —— `document.fonts.check()` 对
      //    **压根没注册过**的族也会返回 true（它拿兜底字体也能渲染），
      //    拿它当「加载成功没」会得到假绿灯。第一版就是这么被骗过去的。
      ok(/YachiyoUI:loaded/.test(st.registered.join(' ')),
        '字体注册成功了（file:// 直连会被 CORS 拒，所以走了 IPC）',
        st.registered.join(' ') || '（一个都没注册）');
      ok(/YachiyoUI/.test(st.family), '--font-ui 指到注册的那一族上了', st.family);

      const after = await pnl.evalJs(MEASURE('八千代 Abc 123 测试'));
      console.log(`   同一段文字宽度：默认 ${before} → 换后 ${after}`);
      ok(Math.abs(after - before) > 1,
        '**真的换掉了**（同样文字宽度变了，不是「选了没反应」）', `${before} → ${after}`);

      // 别的窗口也得跟着换 —— 五个页面各自是一个独立页面
      const mainFont = await m.evalJs(`
        const mod = await import('./ui/font.js');
        const f = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim();
        return { family: f, has: document.fonts.check('16px YachiyoUI'),
                 loaded: [...document.fonts].map((x) => x.family + ':' + x.status).join(' ') };`);
      ok(mainFont.loaded, '主窗口也注册了同一份字体（不然「面板换了、她还是雅黑」）',
        `${mainFont.family} · loaded=${mainFont.loaded}`);
      await pnl.shot('02-换字体.png', 780, 580, 1.5);

      // 换回默认，别把这个家的配置留成换过的
      await pnl.evalJs(`await window.yachiyo.cfg.set('fontFamily', ''); return 1;`);
      await sleep(600);
      const back = await pnl.evalJs(MEASURE('八千代 Abc 123 测试'));
      ok(Math.abs(back - before) < 1, '换回「系统默认」能回到原来的宽度', `${after} → ${back}`);
    } else {
      console.log('   （目录里没有字体，跳过宽度对比）');
    }

    /* ============ ① 音效音量 ============ */
    console.log('\n[4] 音效音量');
    // 面板里该有这一行
    const row = await pnl.evalJs(`
      const r = [...document.querySelectorAll('#pMain .row')]
        .find((x) => x.querySelector('.label')?.textContent.startsWith('音效音量'));
      if (!r) return { found: false };
      const sl = r.querySelector('input[type=range]');
      return { found: true, hasSlider: !!sl, min: sl?.min, max: sl?.max, value: sl?.value };`);
    console.log('   面板里:', JSON.stringify(row));
    ok(row.found && row.hasSlider, '设置面板里有「音效音量」滑块', JSON.stringify(row));

    // 右键菜单里不该有
    await m.evalJs(`window.yachiyo.ov.open('menu', { at: { x: 200, y: 200 } }); return 1;`);
    const mnu = await attachOverlay('menu.html');
    if (mnu) {
      await sleep(600);
      const inMenu = await mnu.evalJs(`
        return { sliders: document.querySelectorAll('#mList input[type=range]').length,
                 txt: [...document.querySelectorAll('#mList .txt')].map(e => e.textContent.trim()) };`);
      console.log('   菜单里:', JSON.stringify(inMenu));
      ok(inMenu.sliders === 0, '**右键菜单里没有滑块**（他要求只在设置面板）', `${inMenu.sliders} 根`);
      await mnu.shot('03-菜单.png', 244, 260, 2);
    }
    await m.evalJs(`window.yachiyo.ov.closeKind('menu'); return 1;`);
    await sleep(400);

    // 拖滑块 → 配置变 + Audio 实例的音量真的跟着变
    await m.evalJs(`await window.yachiyo.cfg.set('soundVolume', 25); return 1;`);
    await sleep(600);
    const snd = await m.evalJs(`
      const mod = await import('./ui/sound.js');
      const st = mod.soundStats().click || [];
      return { n: st.length, vols: st.map(s => s.volume), cfg: (await window.yachiyo.cfg.all()).soundVolume };`);
    console.log('   音量:', JSON.stringify(snd));
    ok(snd.cfg === 25, '配置写进去了', `soundVolume=${snd.cfg}`);
    ok(snd.vols.length && snd.vols.every((v) => Math.abs(v - 0.25) < 0.001),
      '已经建好的 Audio 实例音量**当场**跟着变了（不用重开）', snd.vols.join(','));

    await m.evalJs(`await window.yachiyo.cfg.set('soundVolume', 100); return 1;`);
    await sleep(400);
    const loud = await m.evalJs(`
      const mod = await import('./ui/sound.js');
      return (mod.soundStats().click || []).map(s => s.volume);`);
    ok(loud.every((v) => v === 1), '拉到 100% 就是 1.0', loud.join(','));

    await m.evalJs(`await window.yachiyo.cfg.set('soundVolume', 0); return 1;`);
    await sleep(400);
    const mute = await m.evalJs(`
      const mod = await import('./ui/sound.js');
      return (mod.soundStats().click || []).map(s => s.volume);`);
    ok(mute.every((v) => v === 0), '拉到 0 就是静音', mute.join(','));
  } finally {
    await killElectron();
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
}

main().catch(async (e) => { console.error(e); await killElectron(); process.exit(1); });
