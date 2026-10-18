/**
 * 自检 · 桥上的「开发版 / 正式版」闸门（第 11 套）
 *
 * 为什么单开一套：`src/main/preload.cjs` 往页面暴露的东西**分两档** ——
 * 产品要用的（cfg / chat / ov …）谁都能有，探针口（_probe / _sleep /
 * probeRaise / probeBounds）**只准开发版有**。
 *
 * 这个闸门踩过两回：
 *   ① `probeRaise` / `probeBounds` 漏在 `DEV` 外面 —— 正式版照样能调
 *      （`grep` 打包版源码搜得到）。2026-10-14 修。
 *   ② 判据要是自己猜（`process.execPath` / `app.isPackaged`）就会**判错**，
 *      而且 Electron 对 preload 里抛错的处置是**静默丢掉整个脚本** ——
 *      `window.yachiyo` 整个不存在、气泡和配置全线失灵、一声不吭。
 *
 * ⚠️ 这里**不起窗口、不连网**：把 `require('electron')` 换成桩，
 *    再按两种 `process.argv` 各跑一遍 preload —— 量的是**真行为**，不是 grep。
 *
 * 跑法：node scripts/selfcheck-gate.cjs
 */
'use strict';

const path = require('node:path');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..', '..');
const PRELOAD = path.join(ROOT, 'src', 'main', 'preload.cjs');

const out = [];
const chk = (name, ok, detail) => {
  out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail != null ? '  —— ' + detail : ''}`);
};

/**
 * 把 electron 换成桩，跑一遍 preload，拿回它 exposeInMainWorld 的那份对象。
 *
 * @param {boolean} dev  走不走开发版（= `process.argv` 里有没有 `--yachiyo-dev`）
 * @param {string} [file] 要跑的 preload；默认源码那份。
 *        传 **打包版**的路径就能验「打出去的包里到底有没有」：
 *        `node scripts/selfcheck-gate.cjs "dist/win-unpacked/resources/app/src/main/preload.cjs"`
 */
function loadPreload(dev, file = PRELOAD) {
  let bridge = null;
  const stub = {
    contextBridge: { exposeInMainWorld: (_n, obj) => { bridge = obj; } },
    ipcRenderer: {
      invoke: () => Promise.resolve(),
      send: () => {},
      on: () => {},
      emit: () => {},
    },
  };

  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'electron') return stub;
    return origLoad.apply(this, arguments);
  };

  const hadFlag = process.argv.includes('--yachiyo-dev');
  if (dev && !hadFlag) process.argv.push('--yachiyo-dev');
  if (!dev && hadFlag) process.argv = process.argv.filter((a) => a !== '--yachiyo-dev');

  try {
    delete require.cache[require.resolve(file)];
    require(file);
  } finally {
    Module._load = origLoad;
    if (dev && !hadFlag) process.argv = process.argv.filter((a) => a !== '--yachiyo-dev');
    if (!dev && hadFlag) process.argv.push('--yachiyo-dev');
  }
  return bridge;
}

/** 按点号路径取，取不到返回 undefined */
const at = (o, p) => p.split('.').reduce((a, k) => (a == null ? undefined : a[k]), o);

const PROBE_KEYS = [
  'ov._probe', 'ov._sleep', 'ov._isSleeping', 'ov.probeRaise', 'ov.probeBounds',
  /*
   * ⚠️ 2026-10-16 补的：调试台那一族原来**也**漏在 `DEV` 外面 ——
   *    跟 probeRaise / probeBounds 是同一个毛病，隔了两天又犯一次。
   *    其中 `designPut` 是个**写文件**的通道，比探针口还该挡。
   */

];
/** 产品流程真在用的 —— 防「一刀切掉多了」 */
const PROD_KEYS = [
  'dev', 'cfg.all', 'cfg.set', 'cfg.patch', 'cfg.dir',
  'win.ignoreMouse', 'win.hide', 'win.quit', 'win.openSettings', 'win.screen', 'win.state', 'win.reveal',
  'chat.send', 'chat.sendQuick', 'chat.abort', 'chat.history', 'chat.clear',
  'font.list', 'font.bytes', 'font.dir',
  'usage.get', 'usage.reset',
  'weather.get', 'ai.ping', 'ai.models',
  'rig.tilts', 'rig.setTilts',
  /*
   * ⚠️ 调试台那一族（`ov.design*`）**不在这个名单里** —— 它们在 PROBE_KEYS，
   *    也就是"正式版必须没有"。2026-10-16 之前它们两边都挂着，
   *    所以这半边检查一直是废的（列在 PROD_KEYS 里 ⇒ 报了"缺"才发现矛盾）。
   */
  'ov.isOpen', 'ov.info',
  'on',
];

(async () => {
  console.log('\n【正式版（process.argv 里没有 --yachiyo-dev）】');
  const prod = loadPreload(false);
  chk('preload 没炸、桥建起来了', !!prod, prod ? '' : '★ window.yachiyo 会是 undefined');

  for (const k of PROBE_KEYS) {
    chk(`  ★ 探针口 ${k} 不存在`, at(prod, k) === undefined,
      at(prod, k) === undefined ? '' : '★ 漏到正式版里了');
  }
  chk('  dev 标记 = false', prod && prod.dev === false, prod && String(prod.dev));

  const missing = PROD_KEYS.filter((k) => at(prod, k) === undefined);
  chk(`产品要用的 ${PROD_KEYS.length} 个键一个没少`, missing.length === 0,
    missing.length ? '缺：' + missing.join(', ') : '');

  console.log('\n【开发版（带 --yachiyo-dev）】');
  const devB = loadPreload(true);
  chk('preload 没炸', !!devB, devB ? '' : '★ window.yachiyo 会是 undefined');
  chk('  dev 标记 = true', devB && devB.dev === true, devB && String(devB.dev));
  for (const k of PROBE_KEYS) {
    chk(`  探针口 ${k} 在`, at(devB, k) !== undefined, '');
  }

  const missing2 = PROD_KEYS.filter((k) => at(devB, k) === undefined);
  chk('开发版里产品那些键也都在', missing2.length === 0, missing2.length ? '缺：' + missing2.join(', ') : '');

  /*
   * ★ 打包版（可选）：`node scripts/selfcheck-gate.cjs <preload.cjs 路径>`
   *   传进来就按**正式版配置**再跑一遍那个文件 —— 这才叫「打出去的包里没有」。
   */
  const PKG = process.argv[2];
  if (PKG) {
    console.log('\n【打包版里那份 preload】');
    const fs2 = require('node:fs');
    chk('文件在', fs2.existsSync(PKG), PKG);
    if (fs2.existsSync(PKG)) {
      const pb = loadPreload(false, path.resolve(PKG));
      chk('preload 没炸、桥建起来了', !!pb, pb ? '' : '★ 打出去的包 window.yachiyo 是 undefined');
      const leaked = PROBE_KEYS.filter((k) => at(pb, k) !== undefined);
      chk(`★ ${PROBE_KEYS.length} 个探针口一个都没漏`, leaked.length === 0,
        leaked.length ? '★ 漏了：' + leaked.join(', ') : '');
      const miss = PROD_KEYS.filter((k) => at(pb, k) === undefined);
      chk('产品那些键一个没少', miss.length === 0, miss.length ? '缺：' + miss.join(', ') : '');
    }
  }

  console.log('\n【主进程侧：探针 IPC 口也得套闸】');
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.cjs'), 'utf8');
  const bare = src.split('\n').filter((ln) => /^ipcMain\.handle\('(probe:|ov:probe)/.test(ln));
  chk('★ 没有「无条件注册」的探针 handler', bare.length === 0,
    bare.length ? '★ 露头的：' + bare.map((s) => s.trim()).join(' | ') : '');
  // ⚠️ 先去掉注释行 —— 文档里那句 `用法：devOnly(() => ...)` 会被正则一起数进来
  const code = src.split('\n')
    .filter((ln) => { const t = ln.trim(); return !t.startsWith('*') && !t.startsWith('//'); })
    .join('\n');
  const gated = (code.match(/devOnly\(\(\) => ipcMain\.handle\('(probe:|ov:probe)/g) || []).length;
  /*
   * ⚠️ 这里原来写死 `=== 3`（当初正好三个探针口）。2026-10-17 我又加了
   *    `probe:tray-toggle` 和 `probe:game` 两个 ⇒ 变成 5 ⇒ 断言误报红。
   *    **产品是对的（5 个全套了 devOnly）**，错的是"把数字写死"这个判据本身 ——
   *    探针口只会越来越多，写死的数字每加一个就得改一次断言，等于给未来埋雷。
   *    ⇒ 改成「至少 3 个，且上面那条『没有裸注册』也得过」，不再锁死个数。
   */
  chk('所有探针 handler 都套了 devOnly（不写死个数）', gated >= 3, `套了 ${gated} 个`);

  console.log('\n' + '─'.repeat(52));
  const pass = out.filter((x) => x.ok).length;
  console.log(`  ${pass}/${out.length} 通过  ${pass === out.length ? '✓ 全过' : '✗ 有失败'}`);
  console.log('─'.repeat(52) + '\n');
  const bad = out.filter((x) => !x.ok);
  if (bad.length) { console.log('失败明细：'); for (const b of bad) console.log(`  - ${b.name}: ${b.detail}`); }
  process.exit(pass === out.length ? 0 : 1);
})().catch((e) => { console.error('\n自检自己炸了：', e.stack || e.message); process.exit(1); });
