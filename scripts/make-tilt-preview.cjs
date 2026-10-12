/**
 * 生成「整体倾斜角」预览页（一次性工具，产物给用户看）。
 *
 * ⚠️ 为什么要单独做个预览：
 *    他要调的 `lean`（老调试台叫「前倾角」）**在新引擎里已经没人读了** ——
 *    `gait.js` 把 `bodyRTarget` 恒设为 0，所以产品里调不到。
 *    要重新接上就得定一个口径（全局倾斜？只走路倾斜？），
 *    这种视觉参数**先出稿给他看**，别直接改工程。
 *
 * 用法：node scripts/make-tilt-preview.cjs
 * 产物：桌面\八千代AI桌宠工作留痕\八千代-整体倾斜角-预览-<日期>.html
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = 'C:\\Users\\Susim\\Desktop\\八千代AI桌宠工作留痕';

/**
 * 现场把 rig 素材读成 base64 内联进去。
 *
 * ⚠️ 为什么要内联（4 MB 也认了）：
 *    这份 html 是要**双击直接打开**的 —— 而 `file://` 下 Chromium 会把
 *    同目录的图片请求当跨源拒掉（字体那件事已经栽过一次）。内联成 data URL
 *    就一个请求都没有，搬到哪儿都不裂。
 */
function loadRig() {
  const rig = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/renderer/assets/rig/rig.json'), 'utf8'));
  const base = path.join(ROOT, 'src/renderer/assets/rig');
  const out = { canvas: rig.canvas, sets: {} };
  for (const [setName, set] of Object.entries(rig.sets)) {
    const parts = [];
    for (const key of set.order) {
      const p = set.parts[key];
      const fp = path.join(base, p.file);          // ⚠️ file 里已经带了子目录名（side/xxx.png）
      if (!fs.existsSync(fp)) { console.error('缺件：' + fp); continue; }
      parts.push({
        k: key, x: p.x, y: p.y, w: p.w, h: p.h,
        src: 'data:image/png;base64,' + fs.readFileSync(fp).toString('base64'),
      });
    }
    out.sets[setName] = parts;
  }
  return out;
}
const raw = loadRig();

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>八千代 · 整体倾斜角预览</title>
<style>
  :root{
    --bg:#F4F6F9; --card:#FFFFFF; --line:#E3E7EE; --fg:#22262E; --sub:#6B7280;
    --accent:#0A7EA4; --well:#F2F4F7;
  }
  *{box-sizing:border-box}
  body{
    margin:0; background:var(--bg); color:var(--fg);
    font:14px/1.6 "Microsoft YaHei","Segoe UI",sans-serif;
  }
  .wrap{max-width:1180px; margin:0 auto; padding:26px 22px 60px}
  h1{font-size:20px; margin:0 0 6px}
  .lead{color:var(--sub); margin:0 0 22px}
  .card{
    background:var(--card); border:1px solid var(--line); border-radius:14px;
    padding:18px 20px; margin-bottom:18px;
  }
  .card h2{font-size:15px; margin:0 0 12px; font-weight:600}
  .row{display:flex; gap:22px; align-items:flex-start; flex-wrap:wrap}
  canvas{display:block; background:
    repeating-conic-gradient(#E9ECF2 0% 25%, #F7F8FA 0% 50%) 50%/16px 16px;
    border:1px solid var(--line); border-radius:10px}
  .big{width:340px; height:340px}
  /* ⚠️ 7 张对照要挤在**一行**里（宽度算过：1180 − 左右内边距 − 6 个 22px 间隙，
         每张最多 ~140）。别改大，一改就换行。 */
  .mini{width:132px; height:132px}
  #strip{gap:14px; flex-wrap:nowrap}
  .mini-wrap{text-align:center}
  .mini-wrap b{display:block; margin-top:6px; font-size:12.5px; color:var(--sub)}
  .mini-wrap.on b{color:var(--accent); font-weight:700}
  .ctrls{min-width:280px; flex:1}
  .kv{display:flex; align-items:center; gap:12px; margin-bottom:14px}
  .kv label{width:96px; color:var(--sub); flex:none}
  input[type=range]{flex:1; accent-color:var(--accent)}
  .num{
    width:76px; font:inherit; padding:5px 9px; text-align:right;
    border:1px solid var(--line); border-radius:8px; background:var(--well); color:var(--fg);
  }
  .btns{display:flex; gap:8px; flex-wrap:wrap; margin-top:4px}
  .btns button{
    font:inherit; padding:6px 13px; border:1px solid var(--line); border-radius:999px;
    background:var(--card); color:var(--fg); cursor:pointer;
  }
  .btns button:hover{border-color:var(--accent); color:var(--accent)}
  .btns button.on{background:var(--accent); border-color:var(--accent); color:#fff; font-weight:600}
  .note{color:var(--sub); font-size:12.5px; line-height:1.8}
  .note code{background:var(--well); padding:1px 5px; border-radius:4px}
  table{border-collapse:collapse; font-size:13px; margin-top:10px}
  td,th{border:1px solid var(--line); padding:6px 12px; text-align:left}
  th{background:var(--well); font-weight:600}
</style>
</head>
<body>
<div class="wrap">
  <h1>八千代 · 整体倾斜角（前倾角）预览</h1>
  <p class="lead">你要的那个「骨架调试台里的整体倾斜角调整项」—— 它在新引擎里被砍断了，这份稿子是来定口径的。</p>

  <div class="card">
    <h2>① 一排对照（先看整体感觉）</h2>
    <div class="row" id="strip"></div>
  </div>

  <div class="card">
    <h2>② 自己拖一个试试 <span style="font-weight:400;color:#6B7280;font-size:13px">（拖下面那根滑块，或者直接改右边那个数字框，</span><span style="font-weight:400;color:#0A7EA4;font-size:13px">上面的 7 张会跟着一起变</span><span style="font-weight:400;color:#6B7280;font-size:13px">）</span></h2>
    <div class="row">
      <canvas id="big" class="big"></canvas>
      <div class="ctrls">
        <div class="kv">
          <label>倾斜角</label>
          <input type="range" id="sl" min="-10" max="10" step="0.5" value="0">
          <input type="number" id="num" class="num" min="-10" max="10" step="0.5" value="0">
        </div>
        <div class="btns" id="presets"></div>
        <p class="note" style="margin-top:16px">
          <b>正数 = 往后倒</b>（头顶往右偏）　<b>负数 = 往前倾</b>（头顶往左偏）<br>
          ⚠️ 她面朝<b>右</b>站着，所以「-2°」看着像微微前倾，「+3°」像微微后仰。<br>
          旋转的<b>支点是她的脚下沿</b>（不是图片中心）—— 所以倾斜时脚是钉在地上的，
          不会整张图平移。这一点跟引擎一致。
        </p>
      </div>
    </div>
  </div>

  <div class="card">
    <h2>③ 现在是什么状态（要你拍板的）</h2>
    <p class="note">
      引擎里 <code>lean</code> 这个参数<b>还在 rig.json 里躺着</b>，但代码已经没人读它了 ——
      <code>gait.js</code> 里 <code>bodyRTarget</code> 被写死成 <b>0</b>。
      当初（10-12）砍掉的理由是「走路时一直歪着看久了别扭」，那次只改了走路。
    </p>
    <table>
      <tr><th>姿态</th><th>现在</th><th>老调试台里的值</th></tr>
      <tr><td>待机 idle</td><td>0°</td><td><b>-2°</b></td></tr>
      <tr><td>走路 walk</td><td>0°</td><td>1°（实际乘 0.35 ≈ 0.35°）</td></tr>
      <tr><td>坐 sit</td><td>0°</td><td><b>-6°</b></td></tr>
      <tr><td>睡 sleep</td><td>0°</td><td>-1°</td></tr>
    </table>
    <p class="note" style="margin-top:14px">
      <b>要你定的两件事：</b><br>
      ① 这个倾斜角是<b>一个全局值</b>（不管什么姿态都用同一个数），<br>
      　 还是<b>每个姿态各一个</b>（像上表那样待机 -2、坐着 -6）？<br>
      ② 数值定多少。（我建议先给一个全局值，你拖到满意为止，再决定要不要分姿态。）
    </p>
  </div>
</div>

<script id="rigdata" type="application/json">${JSON.stringify(raw).replace(/</g, '\\u003c')}</script>
<script>
(function(){
  const DATA = JSON.parse(document.getElementById('rigdata').textContent);
  const SET = DATA.sets.side;           // 只看站姿 —— 倾斜角跟哪套无关
  const CANVAS = DATA.canvas;           // 640 拆件单位

  // 把 base64 先都建成 Image，别在 draw 里现 new
  const imgs = SET.map(p => { const im = new Image(); im.src = p.src; return im; });

  /** 按当前角度把一套件画到 ctx 上 —— 跟引擎的 render() 同一套顺序：
   *  先绕【画布中心】转（那就是她的脚下沿），再逐件按 x/y 摆。 */
  function draw(ctx, cssSize, deg){
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const px = Math.round(cssSize * dpr);
    if (ctx.canvas.width !== px) { ctx.canvas.width = px; ctx.canvas.height = px; }
    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,px,px);

    const k = px / CANVAS;
    const gcx = px / 2, gcy = px / 2;

    ctx.save();
    ctx.translate(gcx, gcy);
    ctx.rotate(deg * Math.PI / 180);
    ctx.translate(-gcx, -gcy);

    for (let i = 0; i < SET.length; i++){
      const p = SET[i], im = imgs[i];
      if (!im.complete || !im.naturalWidth) continue;
      ctx.drawImage(im, Math.round(p.x*k), Math.round(p.y*k),
                        Math.round(p.w*k), Math.round(p.h*k));
    }
    ctx.restore();
  }

  const ANGLES = [-6,-4,-2,0,2,4,6];

  // ① 一排对照
  const strip = document.getElementById('strip');
  const minis = [];
  ANGLES.forEach(a => {
    const box = document.createElement('div');
    box.className = 'mini-wrap';
    const c = document.createElement('canvas');
    c.className = 'mini';
    box.appendChild(c);
    const b = document.createElement('b');
    b.textContent = (a > 0 ? '+' : '') + a + '°';
    box.appendChild(b);
    strip.appendChild(box);
    minis.push({ ctx: c.getContext('2d'), box, a });
  });

  // ② 大图
  const big = document.getElementById('big');
  const bctx = big.getContext('2d');
  const sl = document.getElementById('sl');
  const num = document.getElementById('num');

  const presets = document.getElementById('presets');
  [-6,-2,0,2,3.5].forEach(v => {
    const b = document.createElement('button');
    b.textContent = (v>0?'+':'') + v + '°';
    b.dataset.v = v;
    b.onclick = () => setVal(v);
    presets.appendChild(b);
  });

  function setVal(v){
    v = Math.max(-10, Math.min(10, Number(v) || 0));
    sl.value = v; num.value = v;
    [...presets.children].forEach(b => b.classList.toggle('on', Number(b.dataset.v) === v));
    minis.forEach(m => m.box.classList.toggle('on', m.a === v));
    paint();
  }
  function paint(){
    const v = Number(sl.value);
    draw(bctx, 340, v);
    minis.forEach(m => draw(m.ctx, 132, m.a));
  }
  sl.oninput = () => { num.value = sl.value; setVal(sl.value); };
  num.oninput = () => setVal(num.value);

  // 图加载完再画（不然第一帧是空的）
  let left = imgs.length;
  imgs.forEach(im => { const done = () => { if (--left <= 0) setVal(0); };
                       im.onload = done; im.onerror = done; });
  if (!left) setVal(0);
  window.__tiltReady = false;
  setTimeout(() => { setVal(0); window.__tiltReady = true; }, 400);
})();
</script>
</body>
</html>
`;

fs.mkdirSync(OUT_DIR, { recursive: true });
const outFile = path.join(OUT_DIR, '八千代-整体倾斜角-预览-20261012.html');
fs.writeFileSync(outFile, html, 'utf8');
console.log('写好：' + outFile);
console.log('大小：' + (fs.statSync(outFile).size / 1024 / 1024).toFixed(2) + ' MB');
