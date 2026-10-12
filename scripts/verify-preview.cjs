/**
 * 验一个「单文件预览稿」是不是真的能看。
 *
 * ⚠️ 为什么不能靠肉眼开一次就算：
 *   内嵌 base64 的稿很容易出三种「看着好好的，其实废了」的情况 ——
 *     ① 素材路径拼错 → 图全不加载 → 舞台上**空白**，但页面结构完全正常
 *     ② 占位符没替换干净 → JS 直接报错 → 也是空白
 *     ③ 两套立绘的脚没对齐 → 图都在，但过渡时她会**上下一跳**
 *   这三种截图上看都只是「一片格子」，不看数字分不出来。
 *
 * 跑法：node_modules\.bin\electron scripts\verify-preview.cjs <html的绝对路径>
 */

'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const FILE = process.argv[process.argv.length - 1];
const OUT = path.join(__dirname, '..', '_preview-check');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 量一个 canvas 上不透明像素的包围盒（返回 canvas 自身坐标系里的像素） */
const MEASURE = `
  (() => {
    const out = [];
    for (const cv of document.querySelectorAll('canvas')) {
      const g = cv.getContext('2d');
      const W = cv.width, H = cv.height;
      let d;
      try { d = g.getImageData(0, 0, W, H).data; } catch (e) { out.push({ err: e.message }); continue; }
      let minY = H, maxY = -1, minX = W, maxX = -1, solid = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (d[(y * W + x) * 4 + 3] > 16) {
          if (y < minY) minY = y; if (y > maxY) maxY = y;
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          solid++;
        }
      }
      out.push({
        cls: cv.className, w: W, h: H, solid,
        top: minY, bottom: maxY, left: minX, right: maxX,
        opacity: +(cv.style.opacity || 1),
      });
    }
    return {
      canvases: out,
      cells: document.querySelectorAll('.cell').length,
      title: document.title,
      // 内嵌素材有没有真的加载完（脚本里 pending 归零才会 build）
            // ⚠️ __ASSETS__ 是 const，挂在 script 作用域上，不在 window 里 ——
      //    写 window.__ASSETS__ 永远读到 0（第一版就是这么假报的）
      imgs: (typeof __ASSETS__ !== 'undefined') ? Object.keys(__ASSETS__).length : -1,
    };
  })()
`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  if (!fs.existsSync(FILE)) { console.error('文件不存在：' + FILE); app.exit(1); }

  const win = new BrowserWindow({
    /*
     * ⚠️⚠️ 窗口必须**弹在屏幕外**。
     *    第一版是 x:40,y:40 弹在左上角 —— 他正在用电脑，鼠标扫过去就把稿里的
     *    格子点中了（实测抓到两次 selected 被改成 squash / cross）。
     *    验证结果被用户的鼠标污染，比不验证还危险。
     *    ⚠️ 但也不能用 show:false —— 隐藏窗口的 rAF 会被暂停，
     *    「过渡在不在跑」就永远验不出来。放屏幕外是唯一两头都占的写法。
     */
    width: 1600, height: 1150, show: true, x: -4000, y: 0,
    skipTaskbar: true, focusable: false, resizable: false,
    webPreferences: { backgroundThrottling: false, contextIsolation: false, nodeIntegration: false },
  });

  const errs = [];
  win.webContents.on('console-message', (_e, level, msg) => {
    // ⚠️ Electron 自带的那条 CSP 安全警告会混进来，它不是页面的错，剔掉
    if (/Security Warning|Content Security Policy/i.test(msg)) return;
    if (level >= 2) errs.push(msg);
  });
  win.webContents.on('did-fail-load', (_e, code, desc) => errs.push(`加载失败 ${code} ${desc}`));

  await win.loadFile(FILE);
  await sleep(2000);

  // ⚠️ 这个验证窗口是**真的弹在屏幕上**的，鼠标扫过去会点到格子，
  //    把 selected 改掉（实测抓到过 selected="squash"）。验证前强制全员播放。
  await win.webContents.executeJavaScript(`if (typeof selected !== 'undefined') selected = 'all'; 1`);
  await sleep(600);

  const r = await win.webContents.executeJavaScript(MEASURE);

  console.log(`\n文件 ${(fs.statSync(FILE).size / 1048576).toFixed(2)} MB`);
  console.log(`标题 ${r.title}`);
  console.log(`格子 ${r.cells} 个 · 内嵌素材 ${r.imgs} 张 · canvas ${r.canvases.length} 块\n`);

  if (errs.length) {
    console.log('页面报错：');
    for (const e of errs.slice(0, 8)) console.log('  ✗ ' + e);
    console.log('');
  }

  /*
   * ⚠️⚠️ 先卡「有没有 canvas」再谈内容。
   *    第一版直接 `filter(空的)` —— canvas 一块都没有时，空数组也是「全通过」，
   *    页面明明整个崩了（RIG is not defined），检查结果却是绿色的「每块 canvas
   *    都画上了」。**这就是坑 59 说的假成功**：报错比这个安全得多。
   */
  if (!r.canvases.length) {
    console.log('  ✗ 一块 canvas 都没有 —— 页面 JS 大概率崩了（看上面的报错）');
    console.log('\n结论：稿是坏的，别给他。\n');
    await sleep(200);
    app.exit(1);
    return;
  }

  // 1) 每块 canvas 上有东西
  const empty = r.canvases.filter((c) => !c.solid || c.solid < 500);
  console.log(empty.length ? `  ✗ 有 ${empty.length} 块 canvas 是空的` : '  ✓ 每块 canvas 都画上了');

  // 2) 包围盒的大小合理（她该占画面一大块）
  const c0 = r.canvases[0];
  if (c0 && c0.solid) {
    const fill = (c0.solid / (c0.w * c0.h) * 100).toFixed(1);
    console.log(`  ✓ 第 1 块：${c0.right - c0.left}×${c0.bottom - c0.top}px，` +
      `占画布 ${fill}%，底部在 y=${c0.bottom}（画布高 ${c0.h}）`);
  }

  // 3) 两套的脚底对齐（奇偶成对：0=站立 1=坐姿）
  let misaligned = 0;
  for (let i = 0; i + 1 < r.canvases.length; i += 2) {
    const a = r.canvases[i], b = r.canvases[i + 1];
    if (!a.solid || !b.solid) continue;
    const d = Math.abs(a.bottom - b.bottom);
    if (d > 3) misaligned++;
  }
  console.log(misaligned
    ? `  ✗ 有 ${misaligned} 组的脚底没对齐（>3px）—— 过渡时她会上下跳`
    : `  ✓ 站立/坐姿的脚底全对齐（差 ≤3px）`);

  /* 4) 过渡确实在跑。
   *
   * ⚠️ 不能只隔一次就下结论 —— 时间轴是「过渡 dur + 停顿 hold」，停留段
   *    占了 2/3 的时间，只采两次有接近一半的概率**两次都落在停顿里**，
   *    看着像「动画没跑」。改成连采 12 次（总共 2.4 秒），只要出现过
   *    两种以上不同的状态就算在跑。 */
  const seen = new Set();
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const s = await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('canvas')].map(c => c.style.opacity).join(',')`);
    seen.add(s);
    samples.push(s);
    await sleep(200);
  }
  console.log(seen.size > 1
    ? `  ✓ 过渡在跑（12 次采样出现 ${seen.size} 种状态）`
    : `  ✗ 12 次采样全都一样（${[...seen][0]}）—— 动画没在跑`);

  // 页面里的关键变量 —— 出问题的时候光看截图猜不出来
  const dbg = await win.webContents.executeJavaScript(`({
    sel: typeof selected !== 'undefined' ? selected : '(取不到)',
    plans: typeof PLANS !== 'undefined' ? PLANS.map(p => p.id) : [],
    phase: typeof phase !== 'undefined' ? +phase.toFixed(3) : null,
    paused: typeof paused !== 'undefined' ? paused : null,
  })`);
  console.log(`  页面状态：selected=${JSON.stringify(dbg.sel)} · 方案=${dbg.plans.join('/')} ` +
    `· phase=${dbg.phase} · paused=${dbg.paused}`);

  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT, 'preview.png'), img.toPNG());
  console.log(`\n截图 ${path.join(OUT, 'preview.png')}\n`);

  await sleep(300);
  app.exit(0);
}

app.whenReady().then(main);
