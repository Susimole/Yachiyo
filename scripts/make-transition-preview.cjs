/**
 * 生成「站坐过渡方案对比」的 HTML 稿。
 *
 * 为什么要生成而不是直接写个 html：
 *   立绘是 38 个 PNG（合计 2.7MB），从桌面双击打开的话取不到工程目录里的素材
 *   （file:// 下 fetch 会被 CORS 拦）。
 *   ⇒ 把贴图和 rig.json **内嵌成 base64**，产出一个双击就能开的单文件。
 *
 * 跑法：node scripts/make-transition-preview.cjs
 * 产出：桌面\八千代AI桌宠工作留痕\八千代-站坐过渡-方案对比-<日期>.html
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer', 'assets', 'rig');
const TPL = path.join(__dirname, 'preview-src', 'transition.html');
const OUT_DIR = 'C:\\Users\\Susim\\Desktop\\八千代AI桌宠工作留痕';

const rig = JSON.parse(fs.readFileSync(path.join(SRC, 'rig.json'), 'utf8'));

/** 只嵌**真正会被画的件** —— rig.json 里两套用到的全部 file */
const files = new Set();
for (const s of Object.values(rig.sets)) {
  for (const p of Object.values(s.parts)) if (p.file) files.add(p.file);
}

const assets = {};
let bytes = 0;
const missing = [];
for (const f of files) {
  const p = path.join(SRC, f);
  if (!fs.existsSync(p)) { missing.push(f); continue; }
  const buf = fs.readFileSync(p);
  bytes += buf.length;
  assets[f] = 'data:image/png;base64,' + buf.toString('base64');
}

if (missing.length) {
  console.error('有件找不到：\n  ' + missing.join('\n  '));
  process.exit(1);
}

let html = fs.readFileSync(TPL, 'utf8');

/*
 * 占位符替换。
 *
 * ⚠️⚠️ 用 `split(锚点).join(替换串)`，**别**用 `split(锚点)[0] + 替换串 + [1]`。
 *    后者会把锚点那一行**整个吃掉** —— 第一版就是这么写的，
 *    `const RIG = __RIG__;` 被切掉之后，页面直接 `RIG is not defined`，
 *    四个格子一个都不出来。而 join 是把锚点**替换**成新内容，语义正好。
 *
 * ⚠️ 也**不要**用 `String.replace` —— 素材是 base64，里面可能有 `$&`、`$1`
 *    这类序列，`replace` 会把它们当替换模式解析，把内容改坏。
 */
const payload =
  'const __RIG__ = ' + JSON.stringify(rig) + ';\n' +
  'const __ASSETS__ = ' + JSON.stringify(assets) + ';\n' +
  'const RIG = __RIG__;';

const ANCHOR = 'const RIG = __RIG__;';
if (!html.includes(ANCHOR)) {
  console.error('模板里找不到锚点 ' + ANCHOR + ' —— 模板改过了？');
  process.exit(1);
}
html = html.split(ANCHOR).join(payload);

const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}`;
const out = path.join(OUT_DIR, `八千代-站坐过渡-方案对比-${stamp}.html`);
fs.writeFileSync(out, html, 'utf8');

console.log(`内嵌 ${Object.keys(assets).length} 张图 / 源 ${(bytes / 1048576).toFixed(2)} MB`);
console.log(`产出 ${out}`);
console.log(`大小 ${(fs.statSync(out).size / 1048576).toFixed(2)} MB`);
