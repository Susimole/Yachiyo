#!/usr/bin/env node
/**
 * selfcheck-gamemode —— 「游戏时她该坐着」只能有一个入口
 *
 * ★ 2026-10-23 新建，对应外部审查 **YCH-013**（静态确认）。
 *
 *   改前：这件事被写了**两遍** —— `game:changed` 事件里一遍、主循环每帧一遍。
 *   当时是能兜住的（verify-game 一直全绿），但两处写同一件事，以后谁只改一半就打架：
 *   比如给"坐下"加冷却或音效，事件那边改了、主循环每帧还把她拉回去 ⇒ 卡在某个动作。
 *   这种问题页面不报错、只是行为怪，最难查。
 *
 *   现在统一走 `reconcileGameMode()`。这个自检钉的就是"别再退回去"：
 *     · 函数只有一个
 *     · 事件处理器里**不许**再出现 `enter(` / `.left =`（只更新标志 + 喊一声）
 *     · 主循环里必须还在每帧喊它（不变量不能丢）
 *     · `gameMode` 的写入只有一个地方（除了声明）
 *
 *   ⚠️ 行为那一半（真的坐得住、退游戏能放开）在 `tests/e2e/verify-game.cjs`，
 *      那条要起真窗口；这里是纯 node 的结构护栏。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
const chk = (n, ok, d) => {
  if (ok) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d !== undefined ? '   → ' + d : '')); }
};

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src/renderer/app.js');
const src = fs.readFileSync(SRC, 'utf8');

console.log('selfcheck-gamemode —— 游戏模式单一入口');
console.log('');

/* ---------- ① 函数只有一个 ---------- */
console.log('── ① 入口函数 ──');
const defs = (src.match(/function reconcileGameMode\s*\(/g) || []).length;
chk('★ `reconcileGameMode()` 只定义了一次', defs === 1, '定义了 ' + defs + ' 次');

/* ---------- ② 事件处理器里不许再动状态机 ---------- */
console.log('');
console.log('── ② game:changed 处理器 ──');
const start = src.indexOf("on('game:changed'");
chk('找得到 `game:changed` 的注册处', start > 0, String(start));

let handler = '';
if (start > 0) {
  // 从注册处往后取到这一段的结尾（配平括号，别用一刀切的长度）
  const from = src.indexOf('{', src.indexOf('=>', start));
  let depth = 0, i = from;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  handler = src.slice(from, i);
}
chk('处理器里不许出现 `enter(`（状态机只归 reconcile 管）',
  !/\.enter\s*\(/.test(handler), handler.slice(0, 120));
chk('处理器里不许直接改 `.left`', !/\.left\s*=/.test(handler), handler.slice(0, 120));
chk('★ 处理器里要喊一次 `reconcileGameMode()`', /reconcileGameMode\s*\(\s*\)/.test(handler),
  handler.slice(0, 120));

/* ---------- ③ 主循环里还留着每帧的不变量 ---------- */
console.log('');
console.log('── ③ 主循环（不变量不能丢）──');
/* 主循环的标志：里面还调着 reassertMouse() */
const loopAt = src.indexOf('reassertMouse(now)');
const loopChunk = loopAt > 0 ? src.slice(Math.max(0, loopAt - 3000), loopAt) : '';
chk('找得到主循环那段（reassertMouse 那一行）', loopAt > 0, String(loopAt));
chk('★ 主循环每帧还在喊 `reconcileGameMode()`', /reconcileGameMode\s*\(\s*\)/.test(loopChunk),
  '那一段里找不到调用');
chk('主循环里不许再自己 `enter(` / 改 `.left`',
  !/\.enter\s*\(/.test(loopChunk) && !/\.left\s*=/.test(loopChunk),
  (loopChunk.match(/\.enter\s*\(|\.left\s*=/g) || []).join(','));

/* ---------- ④ gameMode 的写入点只剩一个 ---------- */
console.log('');
console.log('── ④ gameMode 只有一个写入点 ──');
/*
 * ⚠️ 先把注释行剥掉再数（注释里到处都是 gameMode`）。
 * ⚠️ 声明那行是 `let gameMode = false;` —— 用 `^\s*gameMode` 是数不到它的，
 *    第一版就栽在这儿（只数到 1 处，还以为产品写错了）。
 */
const code = src.split('\n')
  .filter((ln) => {
    const t = ln.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  })
  .join('\n');
const allHs = code.split('\n').filter((l) => /gameMode\s*=/.test(l));
const decls = allHs.filter((l) => /^\s*(?:let|const|var)\s+gameMode\s*=/.test(l));
const writes = allHs.filter((l) => !/^\s*(?:let|const|var)\s+gameMode\s*=/.test(l));
chk('★ 声明只有一处', decls.length === 1, decls.map((s) => s.trim()).join(' | '));
chk('★ 赋值只有一处（除了声明）', writes.length === 1,
  '数到 ' + writes.length + ' 处：' + writes.map((s) => s.trim()).join(' | '));
chk('  那一处就是 game:changed 里的赋值',
  writes.length === 1 && /!!\(st && st\.on\)/.test(writes[0]),
  writes.map((s) => s.trim()).join(' | '));

/* ---------- ⑤ 「被叫醒就坐下」那条路别被误伤 ---------- */
console.log('');
console.log('── ⑤ 别的坐下入口还在（这条只是提醒，不是硬判据）──');
chk('  「被叫醒」那条路自己还在（它跟游戏无关，别一起删）',
  /enter\('sit', '被叫醒'\)/.test(src), '找不到就说明拆过头了');

console.log('');
console.log('─'.repeat(52));
console.log(`  ${pass}/${pass + fail} 通过${fail ? '  ✗ ' + fail + ' 项没过' : '  ✓ 全过'}`);
console.log('─'.repeat(52));
process.exit(fail ? 1 : 0);
