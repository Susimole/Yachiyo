/**
 * 把她的 system 提示词**原样导出来看**。
 *
 * 记忆层在页面上什么都看不见 —— 想确认「她到底看到了什么」，
 * 唯一的办法就是把拼好的提示词打出来。
 *
 * ⚠️ 跑在**隔离目录**里（跟 selfcheck-memory.cjs 同一个家），
 *    他的真配置一个字节都不碰。
 * ⚠️ 先跑 `node scripts/selfcheck-memory.cjs` 把数据造出来，再跑这个。
 *
 * 跑法：node scripts/dump-prompt.cjs [他会说的一句话]
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const HOME = path.join(__dirname, '..', '_selfcheck-home-mem');
process.env.YACHIYO_HOME = HOME;

if (!fs.existsSync(path.join(HOME, 'config.json'))) {
  console.error('\n隔离目录里还没有数据。先跑：node scripts/selfcheck-memory.cjs\n');
  process.exit(1);
}

const cfg    = require('../src/core/config.cjs');
const prompt = require('../src/core/prompt.cjs');
const memory = require('../src/core/memory.cjs');
const T      = require('../src/core/text.cjs');

cfg.load();

const userText = process.argv[2] || '我去趟撤硕，顺便把塔科夫开了';
const sys = prompt.buildSystem({ userText });

const BAR = '═'.repeat(64);

const out = [
  BAR,
  `  她的 system 提示词（${T.stamp()}）`,
  BAR,
  '',
  `  他会说的一句话：「${userText}」`,
  `  整段 ${sys.length} 字 · ${sys.split('\r\n\r\n').length} 块 · 块间用 CRLF 空行`,
  '',
  BAR,
  '',
  // 把 CRLF 显形，好看出是不是真的都是 CRLF
  sys.replace(/\r\n/g, '\n'),
  '',
  BAR,
  '  逐块清点',
  BAR,
  '',
].join('\n');

const blocks = sys.split('\r\n\r\n');
blocks.forEach((b, i) => {
  const head = b.split('\n')[0].slice(0, 40);
  const sub = head.startsWith('# ') || head.startsWith('【') ? head : '（接着上一块）';
  console.log(`  ${String(i + 1).padStart(2)}. ${String(b.length).padStart(4)} 字  ${sub}`);
});

console.log('\n' + out);

// 顺手报一下 CRLF 体检
const lfOnly = (sys.match(/(?<!\r)\n/g) || []).length;
console.log(`  CRLF 体检：裸 LF ${lfOnly} 处 · 连续三换行 ${(sys.match(/\r\n\r\n\r\n/g) || []).length} 处`);
console.log(`  她的记忆：习惯 ${require('../src/core/habits.cjs').readHabits().length} 条 · ` +
  `梗 ${require('../src/core/habits.cjs').readMemes().length} 条 · ` +
  `跨会话 ${memory.readSession() ? '有' : '没有'} · ` +
  `最近自己说过 ${memory.recentSpoken(3).length} 条\n`);
