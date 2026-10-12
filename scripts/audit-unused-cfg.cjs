/**
 * 只读体检 · 配置里"有旋钮但代码没读"的键 —— 2026-10-12
 *
 * 一个键写在 DEFAULTS 里、设置面板上也画出来了，但代码里**谁也不读它** ——
 * 那就是个拧不动的假旋钮。他一看"这项有啊"，拧两下没反应，
 * 然后来问"是不是没做"。这个脚本就是把这类键列出来。
 *
 * 跑法：node scripts/audit-unused-cfg.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

/* ── ① 从 DEFAULTS 里抠出所有键名 ── */
const cfgSrc = fs.readFileSync(path.join(ROOT, 'src/core/config.cjs'), 'utf8');
const block = cfgSrc.slice(cfgSrc.indexOf('const DEFAULTS'), cfgSrc.indexOf('function ensureDir'));
const keys = [...block.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*):/gm)].map((m) => m[1]);

/* ── ② 把所有源码拼起来（排除配置文件自己）── */
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (/node_modules|[/\\]assets|[/\\]persona|[/\\]rig$/.test(p)) continue;
      walk(p);
    } else if (/\.(cjs|js|html)$/.test(e.name)) {
      files.push(p);
    }
  }
})(path.join(ROOT, 'src'));

const code = files
  .filter((p) => !/config\.cjs$/.test(p))       // 配置文件自己不算"读了"
  .map((p) => `\n/*=== ${path.relative(ROOT, p)} ===*/\n` + fs.readFileSync(p, 'utf8'))
  .join('\n');

/* ── ③ 逐个找：这个键名在代码里出现过吗 ── */
const unused = [];
for (const k of keys) {
  // 键名当字符串字面量出现（cfg.get('x') / { x: ... } 之类都算）
  const asString = code.includes(`'${k}'`) || code.includes(`"${k}"`);
  // 或者当属性名出现（config 对象上是 cfg.get('petSize') 这种，所以主要看上面那条）
  if (!asString) unused.push(k);
}

console.log(`DEFAULTS 里共 ${keys.length} 个键，扫了 ${files.length} 个源文件。\n`);
console.log(`【代码里一次都没提到的键：${unused.length} 个】`);
for (const k of unused) console.log('  · ' + k);

/* ── ④ 设置面板上画出来了吗 ── */
const setSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/settings.js'), 'utf8');
const shown = unused.filter((k) => setSrc.includes(`'${k}'`));
console.log(`\n【其中**设置面板上画出来了**的（= 拧不动的假旋钮）：${shown.length} 个】`);
for (const k of shown) console.log('  ⚠️ ' + k);
if (!shown.length) console.log('  （没有 —— 好）');
