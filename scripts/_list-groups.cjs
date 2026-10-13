/**
 * 只读：把 settings.js 里 PAGES 的结构精确打出来（页 → 组 → 组内的键）。
 *
 * ⚠️ 为什么不用正则数：`groups:[...]` 里套着 `rows:[...]`，还夹着大段注释，
 *    正则匹配 `]},` 会被注释里的花括号骗到。这里按**括号配平**扫，
 *    顺便跳过字符串和注释 —— 才数得准。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'ui', 'settings.js'), 'utf8');

/** 从 i 开始（src[i] 必须是 open），配平找匹配的闭合符号，跳过字符串/注释/模板串 */
function matchBracket(s, i) {
  const open = s[i];
  const close = { '[': ']', '{': '}', '(': ')' }[open];
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '/' && s[j + 1] === '/') { j = s.indexOf('\n', j); if (j < 0) break; continue; }
    if (c === '/' && s[j + 1] === '*') { j = s.indexOf('*/', j + 2); if (j < 0) break; j++; continue; }
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      for (j++; j < s.length; j++) { if (s[j] === '\\') { j++; continue; } if (s[j] === q) break; }
      continue;
    }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

// 找 PAGES = [
const pi = src.indexOf('export const PAGES = [');
const pend = matchBracket(src, src.indexOf('[', pi));
const body = src.slice(src.indexOf('[', pi) + 1, pend);

// 顶层页面对象：扫 k:'xxx'
const pages = [];
{
  let i = 0;
  while (i < body.length) {
    const m = /\{\s*\n\s*k:'(\w+)'/.exec(body.slice(i));
    if (!m) break;
    const start = i + m.index;
    const end = matchBracket(body, start);
    if (end < 0) break;
    pages.push({ k: m[1], text: body.slice(start, end + 1) });
    i = end + 1;
  }
}

for (const p of pages) {
  const gi = p.text.indexOf('groups:');
  const gend = matchBracket(p.text, p.text.indexOf('[', gi));
  const inner = p.text.slice(p.text.indexOf('[', gi) + 1, gend);
  const groups = [];
  let i = 0;
  while (i < inner.length) {
    const m = /\{\s*title:'([^']+)'/.exec(inner.slice(i));
    if (!m) break;
    const start = i + m.index;
    const end = matchBracket(inner, start);
    if (end < 0) break;
    const blk = inner.slice(start, end + 1);
    groups.push({ title: m[1], keys: [...blk.matchAll(/key:'(\w+)'/g)].map((x) => x[1]) });
    i = end + 1;
  }
  console.log('');
  console.log(`${p.k}  (${groups.length} 组)`);
  groups.forEach((g, n) => console.log(`  ${p.k}#${n}  ${g.title.padEnd(12)} [${g.keys.join(', ')}]`));
}
