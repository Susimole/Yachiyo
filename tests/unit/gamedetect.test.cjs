#!/usr/bin/env node
/**
 * selfcheck-gamedetect —— 游戏检测的判定逻辑（第 40 轮 · 批次 D）
 *
 * 只测**纯函数**（`parseLine` / `judge`）—— 起 PowerShell 那部分在探针里验，
 * 这里保证"给定一行输出，判定对不对"，那才是真正容易写错的地方。
 *
 * 他定的口径：**全屏 + 进程检测**，两者都要（「这样更准」）。
 * 最容易翻车的两件事：
 *   ① 浏览器/播放器**全屏放视频**不能被当成游戏（否则她会一直坐着）
 *   ② 无边框全屏游戏（窗口比屏幕小几像素）不能被漏判
 *
 * 用法：node selfcheck-gamedetect.cjs
 */
'use strict';

let pass = 0;
let fail = 0;
const chk = (n, ok, d) => {
  if (ok) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d !== undefined ? '   → ' + d : '')); }
};

const g = require('../../src/core/gamedetect.cjs');
const SCREEN = { w: 2048, h: 1152 };   // 他这台机（125% 缩放下的逻辑分辨率）

console.log('selfcheck-gamedetect —— 判定逻辑');
console.log('');

/* ---------- ① 解析 ---------- */
console.log('── ① 解析 PowerShell 那两行 ──');
const fg = g.parseLine('FG|25532|AweSun|524|236|1000|640|0');
chk('FG 行解析出来了', !!fg && fg.kind === 'fg', JSON.stringify(fg));
chk('进程名转小写', fg && fg.proc === 'awesun', fg && fg.proc);
chk('尺寸对', fg && fg.w === 1000 && fg.h === 640, fg && fg.w + 'x' + fg.h);
chk('caption=0 读成 false', fg && fg.caption === false);
const sc = g.parseLine('SCREEN|2048|1152');
chk('SCREEN 行解析出来了', !!sc && sc.w === 2048 && sc.h === 1152, JSON.stringify(sc));
chk('空行 / 垃圾行返回 null', g.parseLine('') === null && g.parseLine('随便什么') === null);

/* ---------- ② 全屏判定 ---------- */
console.log('');
console.log('── ② 全屏判定（含容差）──');
const mk = (o) => Object.assign({ kind: 'fg', pid: 1, proc: 'somegame', l: 0, t: 0, w: 2048, h: 1152, caption: false }, o);

chk('★ 正正好全屏 + 未知进程 ⇒ 是游戏',
  g.judge(SCREEN, mk({}), g.DEFAULT_EXCLUDE).isGame === true);
chk('★ 无边框全屏少 6px ⇒ 仍然算（容差 8）',
  g.judge(SCREEN, mk({ w: 2042, h: 1146 }), g.DEFAULT_EXCLUDE).isGame === true,
  JSON.stringify(g.judge(SCREEN, mk({ w: 2042, h: 1146 }), g.DEFAULT_EXCLUDE)));
chk('★ 少 200px（窗口化）⇒ 不算',
  g.judge(SCREEN, mk({ w: 1848, h: 1000 }), g.DEFAULT_EXCLUDE).isGame === false);
chk('只宽度够、高度不够 ⇒ 不算',
  g.judge(SCREEN, mk({ h: 900 }), g.DEFAULT_EXCLUDE).isGame === false);
chk('拿不到屏幕尺寸时保守判"不是游戏"', g.judge(null, mk({}), g.DEFAULT_EXCLUDE).isGame === false);

/* ---------- ③ 进程检测 ---------- */
console.log('');
console.log('── ③ 进程检测（全屏放视频不能当游戏）──');
for (const p of ['chrome', 'msedge', 'potplayermini64', 'vlc', 'code', 'awesun']) {
  chk(`全屏的 ${p} ⇒ 不算游戏`, g.judge(SCREEN, mk({ proc: p }), g.DEFAULT_EXCLUDE).isGame === false);
}
chk('★ 全屏的未知进程 ⇒ 算游戏（他没在排除名单里）',
  g.judge(SCREEN, mk({ proc: 'eldenring' }), g.DEFAULT_EXCLUDE).isGame === true);
chk('默认排除名单里**没有**常见游戏名',
  !g.DEFAULT_EXCLUDE.some((x) => /elden|counter|genshin|cs2|dota|minecraft|steam/i.test(x)),
  g.DEFAULT_EXCLUDE.slice(0, 6).join(','));
chk('排除名单是"前缀匹配"（potplayermini64 也能挡住 potplayer）',
  g.judge(SCREEN, mk({ proc: 'potplayermini64' }), ['potplayer']).isGame === false);
chk('进程名拿不到（?）⇒ 保守判不是游戏', g.judge(SCREEN, mk({ proc: '?' }), g.DEFAULT_EXCLUDE).isGame === false);

/* ---------- ④ 配置能覆盖 ---------- */
console.log('');
console.log('── ④ 配置能覆盖默认 ──');
chk('★ 他自定义排除名单后，名单生效',
  g.judge(SCREEN, mk({ proc: 'eldenring' }), ['eldenring']).isGame === false);
chk('名单为空数组时不会"谁都不排除"崩掉', typeof g.judge(SCREEN, mk({}), []).isGame === 'boolean');

/* ---------- ⑤ 常量 ---------- */
console.log('');
console.log('── ⑤ 常量 ──');
chk('探测间隔 2000ms（够快也不费电）', g.INTERVAL_MS === 2000, String(g.INTERVAL_MS));
chk('容差 8px', g.EDGE_TOL === 8, String(g.EDGE_TOL));

console.log('');
console.log((fail === 0 ? '★ 全绿' : '✗ 有红') + `　${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
