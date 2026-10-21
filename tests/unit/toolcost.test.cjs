#!/usr/bin/env node
/**
 * selfcheck-toolcost —— 一轮里打了**两次**模型时，账要记全
 *
 * ★ 2026-10-21 新建，对应外部审查 **YCH-003**（确定复现）。
 *
 *   她的「看屏幕」是**工具调用**：第一次请求带 tools 出去、模型可能只回一个
 *   `look_screen`、正文是空的；我们截完屏、把描述塞成 `role:'tool'`，**再问第二次**。
 *
 *   改前：第二次的 `out` 直接把第一次的覆盖掉了 ⇒ 第一次那笔账（一整段系统提示
 *   + 历史的 prompt token）**连钱带 token 一起丢**，调用次数也只 +1。
 *   审查复现：两次各 24 token，账本只记 24（实际 36）。
 *
 * 这个自检钉三件事：
 *   ① 一轮两次 → 账本 +2 次调用、token 是两次之和
 *   ② 钱是两次之和（**大于只有第二次那笔**，这条才是真正防回归的判据）
 *   ③ 第二次失败时**不多记**（只算成功的那一次）
 *
 * 跑在隔离家目录（`YACHIYO_HOME`）里，不碰他真实的 `%APPDATA%\Yachiyo`。
 * 全部打桩：不发真请求、不截真屏。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ---------- 隔离（必须在 require 产品代码之前）---------- */
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-toolcost-'));
process.env.YACHIYO_HOME = HOME;

let pass = 0;
let fail = 0;
const chk = (name, ok, detail) => {
  if (ok) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '   → ' + detail : '')); }
};

const ROOT = path.resolve(__dirname, '..', '..');
const cfg = require(path.join(ROOT, 'src/core/config.cjs'));
const provider = require(path.join(ROOT, 'src/core/provider.cjs'));
const looktool = require(path.join(ROOT, 'src/core/looktool.cjs'));
const memory = require(path.join(ROOT, 'src/core/memory.cjs'));
const usage = require(path.join(ROOT, 'src/core/usage.cjs'));
const brain = require(path.join(ROOT, 'src/core/brain.cjs'));

console.log('selfcheck-toolcost —— 一次对话两笔账');
console.log('家目录：' + HOME);
console.log('');

/* ---------- 桩：模型 / 看屏幕 ---------- */

const U1 = { prompt_tokens: 20, completion_tokens: 4 };   // 第一次（带工具）
const U2 = { prompt_tokens: 8, completion_tokens: 4 };    // 第二次（带工具结果）

let mode = 'ok';          // 'ok' | 'second-fails'
let calls = 0;            // 桩被调了几次
let lastMessages = null;

const realChat = provider.chat;
provider.chat = async (o) => {
  calls++;
  lastMessages = o.messages;
  if (calls === 1) {
    return {
      text: '',
      usage: { ...U1 },
      toolCalls: [{ id: 'call_look', name: 'look_screen', args: '{}' }],
    };
  }
  if (mode === 'second-fails') throw new Error('第二次挂了（模拟）');
  return { text: '屏幕上是个编辑器，你在写代码。', usage: { ...U2 }, toolCalls: [] };
};

const realDescribe = looktool.describe;
looktool.describe = async () => ({ text: '一个代码编辑器，深色主题', via: 'chat', ms: 120 });

/* ---------- 量尺 ---------- */

const price = () => ({ in: cfg.get('priceIn'), out: cfg.get('priceOut'), hit: cfg.get('priceCacheHit') });
const costOf = (u) => provider.cost(u, price());

function reset() {
  memory.clear();
  usage.reset();
  calls = 0;
  lastMessages = null;
  cfg.patch({ apiKey: 'sk-test-toolcost', memShort: true });
}

/* ═══════════════════════════════════════════════════════ */

(async () => {
  /* ── ① 两次都成功 ── */
  console.log('── ① 她调了一次 look_screen（两次请求都成功）──');
  reset();
  mode = 'ok';
  const before = usage.all();
  const r = await brain.reply('你现在看到啥了');
  const after = usage.all();

  chk('真的打了两次模型', calls === 2, 'calls=' + calls);
  chk('第二次请求里带着 role:"tool" 的结果（说明确实走了工具那条链）',
    Array.isArray(lastMessages) && lastMessages.some((m) => m.role === 'tool'),
    lastMessages ? lastMessages.map((m) => m.role).join(',') : 'null');
  chk('★ 返回值报告 calls=2', r.calls === 2, String(r.calls));

  const tokWant = (U1.prompt_tokens + U1.completion_tokens) + (U2.prompt_tokens + U2.completion_tokens);
  chk('★ 账本 token 是两次之和（' + tokWant + '，不是只有第二次的 12）',
    after.todayTokens - before.todayTokens === tokWant,
    '记了 ' + (after.todayTokens - before.todayTokens));
  chk('★ 调用次数 +2（原来只 +1）',
    after.todayCalls - before.todayCalls === 2,
    '记了 ' + (after.todayCalls - before.todayCalls));

  const wantCost = costOf(U1) + costOf(U2);
  chk('★ 钱是两次之和',
    Math.abs((after.todayCost - before.todayCost) - wantCost) < 1e-9,
    '记了 ' + (after.todayCost - before.todayCost).toFixed(8) + ' / 应为 ' + wantCost.toFixed(8));
  /* 这条是真正的回归判据：只记第二次的话，钱会比这个少 */
  chk('★ 记的钱**大于**"只算第二次"那笔（第一次没被吞）',
    (after.todayCost - before.todayCost) > costOf(U2) + 1e-12,
    '总数 ' + (after.todayCost - before.todayCost).toFixed(8) + ' vs 只算第二次 ' + costOf(U2).toFixed(8));
  chk('返回值里的 usage 也是合并后的', r.usage && r.usage.prompt_tokens === U1.prompt_tokens + U2.prompt_tokens,
    r.usage ? JSON.stringify(r.usage) : 'null');

  /* ── ② 第二次失败：不许把失败那次算成钱 ── */
  console.log('');
  console.log('── ② 第二次挂了（工具看完了，模型没回话）──');
  reset();
  mode = 'second-fails';
  const b2 = usage.all();
  const r2 = await brain.reply('你看看我在干嘛');
  const a2 = usage.all();

  chk('仍然只算一次调用', a2.todayCalls - b2.todayCalls === 1, '记了 ' + (a2.todayCalls - b2.todayCalls));
  chk('token 只算成功那一次（24）',
    a2.todayTokens - b2.todayTokens === U1.prompt_tokens + U1.completion_tokens,
    '记了 ' + (a2.todayTokens - b2.todayTokens));
  chk('钱只算成功那一次',
    Math.abs((a2.todayCost - b2.todayCost) - costOf(U1)) < 1e-9,
    '记了 ' + (a2.todayCost - b2.todayCost).toFixed(8));
  chk('★ 但她还是把看到的东西说出来了（别让他白等）',
    typeof r2.text === 'string' && r2.text.includes('代码编辑器'), JSON.stringify(r2.text));

  /* ── ③ 没调工具：一笔就一笔 ── */
  console.log('');
  console.log('── ③ 普通一问一答（没调工具）──');
  reset();
  mode = 'ok';
  calls = 1;              // 桩按 calls===1 返回工具调用；这里先推一格让它走"第二次"分支
  const b3 = usage.all();
  await brain.reply('你好');
  const a3 = usage.all();
  chk('只算一次调用', a3.todayCalls - b3.todayCalls === 1, '记了 ' + (a3.todayCalls - b3.todayCalls));
  chk('token 是那一次的 12', a3.todayTokens - b3.todayTokens === U2.prompt_tokens + U2.completion_tokens,
    '记了 ' + (a3.todayTokens - b3.todayTokens));

  /* ---------- 收尾 ---------- */
  provider.chat = realChat;
  looktool.describe = realDescribe;
  fs.rmSync(HOME, { recursive: true, force: true });

  console.log('');
  console.log('─'.repeat(52));
  console.log('  ' + pass + '/' + (pass + fail) + ' 通过' + (fail ? '  ✗ ' + fail + ' 项没过' : '  ✓ 全过'));
  console.log('─'.repeat(52));
  process.exit(fail ? 1 : 0);
})().catch((err) => {
  console.error('自检本身炸了：' + (err && err.stack || err));
  process.exit(1);
});
