/**
 * 只读体检 · 「写好了但没人调」的导出 —— 2026-10-12
 *
 * 比配置里的假旋钮更阴的一类问题：**函数实实在在地写好了、测过了，
 * 但没有任何地方调用它**。表现是"这个功能应该有啊" → 实际永远不生效，
 * 而且不报错、日志里也看不出来。
 *
 * 实例（这次扫出来的）：`memory.addSpoken` 一次都没被调过 →
 *                  「你最近自己说过的话」那块永远是空的 → 她会反复说同一句。
 *
 * ⚠️ 有几个是**故意**留着的（注释里写了理由），脚本会连注释一起打出来，
 *    由人判断。别看到红就删。
 *
 * 跑法：node scripts/audit-dead-exports.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CORE = path.join(ROOT, 'src/core');

/** 收集所有源码（core 自己排除掉被查的那个文件） */
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) {
      if (/node_modules|[/\\]assets|[/\\]persona|[/\\]rig$/.test(p)) continue;
      walk(p);
    } else if (/\.(cjs|js)$/.test(e.name)) files.push(p);
  }
})(path.join(ROOT, 'src'));
files.push(...fs.readdirSync(path.join(ROOT, 'scripts'))
  .filter((f) => f.endsWith('.cjs'))
  .map((f) => path.join(ROOT, 'scripts', f)));

/** 这些名字是「给测试/探针用的」，不算死 */
const TEST_ONLY = /^_/;
/** 这些整天在模块之间互调，跳掉免得刷屏 */
const SKIP = new Set(['FILE', 'DATA', 'STATE', 'DIR']);

let dead = 0, checked = 0;

for (const f of fs.readdirSync(CORE).filter((x) => x.endsWith('.cjs'))) {
  const full = path.join(CORE, f);
  const src = fs.readFileSync(full, 'utf8');

  // 抠出 module.exports 那一块里的名字
  const m = src.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\};/);
  if (!m) continue;
  const names = [];
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^\s{2}(?:\.\.\.)?([A-Za-z_][A-Za-z0-9_]*)\s*[,:]?/);
    if (mm) names.push(mm[1]);
  }

  // 其它所有文件拼起来
  const others = files
    .filter((p) => p !== full)
    .map((p) => fs.readFileSync(p, 'utf8'))
    .join('\n');

  const orphans = [];
  for (const n of names) {
    if (!n || TEST_ONLY.test(n) || SKIP.has(n)) continue;
    checked++;
    // 别人的代码里出现过 `xxx.name` 或 `{ name }` 解构 或 `name,` 解构
    const used =
      new RegExp(`\\b${n}\\b`).test(others);
    if (!used) orphans.push(n);
  }

  if (orphans.length) {
    dead += orphans.length;
    console.log(`\n${f}`);
    for (const o of orphans) console.log(`  ⚠️ ${o}`);
  }
}

console.log(`\n${'─'.repeat(50)}`);
console.log(`查了 ${checked} 个导出，其中 ${dead} 个在**其它文件里一次都没出现过**。`);
console.log('（有几个是故意留的接口 —— 看代码注释里的理由，别看到就删）');
