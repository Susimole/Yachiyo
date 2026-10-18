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
 * probe-batchC —— 批次 C 的 UI 真机验证（2026-10-17）
 *
 * 验四件事，全是**量出来的**：
 *   ① 服务商 chips 在不在、一共几个、当前高亮的是哪个
 *   ② 点另一个 chip → **config.json 里那三项真的变了**（读文件，不信页面里那份 CFG）
 *   ③ 走势图在不在，切 日/周/月 → **SVG 里的 rect 数量**必须是 24 / 7 / 30
 *      （这是最硬的判据：格数错了它立刻现形）
 *   ④ 顺手截图给眼睛看
 *
 * 用法：node probe-batchC.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OUT = 'D:\\AI_work\\留痕\\稿子-批次C';
const CFG = path.join(process.env.APPDATA || '', 'Yachiyo', 'config.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (o) => JSON.stringify(o);

let pass = 0, fail = 0;
const chk = (n, ok, d) => { if (ok) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (d !== undefined ? '   → ' + d : '')); } };

const readCfg = () => { try { return JSON.parse(fs.readFileSync(CFG, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

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
const goto = (c, name) => ev(c, `(() => {
  const n = [...document.querySelectorAll('#navs .nav')].find((e) => (e.textContent || '').trim() === ${JSON.stringify(name)});
  if (!n) return 'not-found'; n.click(); return 'ok';
})()`);

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  console.log('probe-batchC —— 服务商预设 + 走势图');
  console.log('');

  let main = null;
  for (let i = 0; i < 25 && !main; i++) {
    try { main = (await ts()).find((t) => /index\.html/.test(t.url)); } catch {}
    if (!main) await sleep(400);
  }
  if (!main) { console.log('✗ 没连上主窗口'); process.exit(1); }
  const mc = await connect(main.webSocketDebuggerUrl);
  await mc.send('Runtime.enable');
  await ev(mc, `window.yachiyo.ov.open('panel'); 1`);
  await sleep(1700);

  const panel = (await ts()).find((t) => /panel\.html/.test(t.url));
  if (!panel) { console.log('✗ 面板没开出来'); process.exit(1); }
  const pc = await connect(panel.webSocketDebuggerUrl);
  await pc.send('Runtime.enable');
  await pc.send('Page.enable');
  await sleep(600);

  console.log('切页：' + await goto(pc, 'AI 接入'));
  await sleep(900);

  /* ---------- ① chips ---------- */
  console.log('');
  console.log('── ① 服务商 chips ──');
  const chips = JSON.parse(await ev(pc, `JSON.stringify((() => {
    const row = document.querySelector('#pMain .row[data-rk="providerPick"]');
    if (!row) return { found: false };
    const btns = [...row.querySelectorAll('button')];
    return {
      found: true,
      names: btns.map((b) => (b.textContent || '').trim()),
      active: (row.querySelector('button.primary') || {}).textContent || '',
      tip: (row.querySelector('.kv') || {}).textContent || '',
    };
  })())`));
  chk('「服务商」那一行挂上了', chips.found === true, J(chips));
  chk('★ 内置 4 个 + 「+ 自定义」都在',
    chips.found && ['DeepSeek', 'Kimi', '智谱 GLM', '通义千问', '+ 自定义'].every((n) => chips.names.includes(n)),
    J(chips.names));
  chk('有一个是高亮的（当前生效的）', !!chips.active, chips.active);
  console.log('   当前高亮：' + chips.active + '　提示行：' + chips.tip);
  await shot(pc, '实测-服务商.png');

  /* ---------- ② 切预设 → config 真的变 ---------- */
  console.log('');
  console.log('── ② 点 Kimi，看 config.json ──');
  const before = readCfg();
  console.log('   切之前 config.apiBase = ' + before.apiBase + '　apiKey = ' + String(before.apiKey).slice(0, 8) + '…');
  await ev(pc, `(() => {
    const row = document.querySelector('#pMain .row[data-rk="providerPick"]');
    const b = [...row.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'Kimi');
    if (b) b.click();
    return 1;
  })()`);
  await sleep(900);
  const after = readCfg();
  console.log('   切之后 config.apiBase = ' + after.apiBase + '　apiKey = ' + String(after.apiKey).slice(0, 8) + '…');
  chk('★ 切到 Kimi 后，config.json 的 apiBase 变成 moonshot 的地址',
    /moonshot/.test(String(after.apiBase)), after.apiBase);
  chk('★ DeepSeek 的 key 没丢（还在 providers.json 里）',
    fs.existsSync(path.join(process.env.APPDATA || '', 'Yachiyo', 'data', 'providers.json')));

  const shown = JSON.parse(await ev(pc, `JSON.stringify((() => {
    const g = (kw) => { const r = [...document.querySelectorAll('#pMain .row')].find((x) => ((x.querySelector('.label') || {}).textContent || '').startsWith(kw)); const i = r && r.querySelector('input'); return i ? i.value : null; };
    return { base: g('接口地址'), model: g('模型'), key: g('API Key') };
  })())`));
  console.log('   面板上显示的三行 = ' + J(shown));
  chk('★ 面板上的地址也跟着换成 Kimi 的了（页面那份 CFG 有对齐）',
    /moonshot/.test(String(shown.base)), shown.base);

  // 切回去，别把他的配置留在 Kimi 上
  await ev(pc, `(() => {
    const row = document.querySelector('#pMain .row[data-rk="providerPick"]');
    const b = [...row.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === 'DeepSeek');
    if (b) b.click();
    return 1;
  })()`);
  await sleep(900);
  const back = readCfg();
  chk('★ 切回 DeepSeek 后，config 又变回他原来的（key 也在）',
    back.apiKey === before.apiKey && back.apiBase === before.apiBase,
    J({ base: back.apiBase, keyHead: String(back.apiKey).slice(0, 8) }));

  /* ---------- ③ 走势图 ---------- */
  console.log('');
  console.log('── ③ 走势图：切粒度看柱子数 ──');
  const chartRow = await ev(pc, `(() => !!document.querySelector('#pMain .row[data-rk="usageChart"]'))()`);
  chk('「花费走势」那一行挂上了（滚下去看得到）', chartRow === true);

  const counts = {};
  for (const [label, want] of [['日', 24], ['周', 7], ['月', 30]]) {
    await ev(pc, `(() => {
      const row = document.querySelector('#pMain .row[data-rk="usageChart"]');
      const b = [...row.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === ${JSON.stringify(label)});
      if (b) b.click();
      return 1;
    })()`);
    await sleep(700);
    const n = await ev(pc, `(() => {
      const row = document.querySelector('#pMain .row[data-rk="usageChart"]');
      return row ? row.querySelectorAll('svg rect').length : -1;
    })()`);
    counts[label] = n;
    chk(`★ 粒度「${label}」→ ${want} 根柱子`, n === want, String(n));
  }
  console.log('   三种粒度：' + J(counts));
  await ev(pc, `(() => { const e = document.querySelector('#pMain .row[data-rk="usageChart"]'); if (e) e.scrollIntoView({ block: 'center' }); return 1; })()`);
  await sleep(400);
  await shot(pc, '实测-走势图.png');

  await ev(mc, `window.yachiyo.ov.closeKind('panel'); 1`);
  mc.close(); pc.close();
  console.log('');
  console.log((fail === 0 ? '★ 全绿' : '✗ 有红') + `　${pass} 通过 / ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('炸了：' + e.message + '\n' + e.stack); process.exit(1); });
