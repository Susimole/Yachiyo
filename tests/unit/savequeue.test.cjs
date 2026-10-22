#!/usr/bin/env node
/**
 * selfcheck-savequeue —— 服务商三行「每敲一个字就写盘 + 乱序覆盖」
 *
 * ★ 2026-10-22 新建，对应外部审查 **YCH-009**（静态确认）。
 *
 *   改前：`input` 事件里直接 `providers.save(...)`，fire-and-forget。
 *     · 打一个 32 位 Key = 32 次 IPC + 32 次写盘
 *     · 每个请求各自异步，**旧的晚回来会盖掉新值** —— 输入框和盘上的值对不上
 *
 *   改后：`ui/savequeue.js` 负责「停手 300ms 才发 + 同一个 key 永远只有一条在飞」。
 *
 *   ⚠️ 这个模块刻意不碰 DOM，所以能在这儿直接测（不用起窗口、不用探针）。
 *     界面那侧的"确实用上了它"由静态断言盯一眼（光写模块不接 = 白写）。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let pass = 0, fail = 0;
const chk = (n, ok, d) => {
  if (ok) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d !== undefined ? '   → ' + d : '')); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.resolve(__dirname, '..', '..');
const MOD = path.join(ROOT, 'src/renderer/ui/savequeue.js');

(async () => {
  const { makeSaveQueue } = await import(pathToFileURL(MOD).href);

  console.log('selfcheck-savequeue —— 敲字保存的去抖与顺序');
  console.log('');

  /* ── ① 连打 10 个字符 → 只发 1 次，发的是最后那个值 ── */
  console.log('── ① 连打十下（改前：10 次 IPC + 10 次写盘）──');
  {
    const sentList = [];
    const q = makeSaveQueue({
      gap: 60,
      send: async (key, payload) => { sentList.push({ key, ...payload }); },
    });
    for (const ch of 'sk-abcdefg') q.push('p1', { key: 'sk-' + ch });
    await sleep(200);
    chk('★ 只发了 1 次', sentList.length === 1, '发了 ' + sentList.length + ' 次');
    chk('★ 发的是最后一个值', sentList[0] && sentList[0].key === 'sk-g', sentList[0] && sentList[0].key);
    chk('  队列空了', q.stats().pending === 0, JSON.stringify(q.stats()));
  }

  /* ── ② 在飞的时候又改：不许并发，回来的顺序必须是先旧后新 ── */
  console.log('');
  console.log('── ② 老的还在飞，他又改了（这就是乱序覆盖那一幕）──');
  {
    const order = [];
    let release = null;
    const q = makeSaveQueue({
      gap: 10,
      send: (key, payload) => new Promise((res) => {
        order.push(payload.v);
        if (payload.v === 1) release = res;      // 第一条卡住，模拟"慢请求"
        else res();
      }),
    });

    q.push('p1', { v: 1 });
    await sleep(40);
    chk('第一条已经在飞了', order.length === 1 && order[0] === 1, JSON.stringify(order));

    /* 飞着的时候他接着敲了三下 */
    q.push('p1', { v: 2 });
    q.push('p1', { v: 3 });
    q.push('p1', { v: 4 });
    await sleep(40);
    chk('★ 在飞期间没有并发第二条（同一 key 只有一条）', order.length === 1, JSON.stringify(order));

    release && release();                   // 第一条回来
    await sleep(80);
    chk('★ 第一条回来之后才发第二条', order.length === 2, JSON.stringify(order));
    chk('★ 第二条发的是**最新**的值（v=4，中间的 2、3 被合并掉）', order[1] === 4, JSON.stringify(order));
    chk('  没有倒回去发旧值', order.join(',') === '1,4', order.join(','));
  }

  /* ── ③ flush：切预设之前必须立刻发完，不能等那 300ms ── */
  console.log('');
  console.log('── ③ 切预设前 flush ──');
  {
    const got = [];
    const q = makeSaveQueue({ gap: 5000, send: async (k, p) => { got.push(p.v); } });
    q.push('p1', { v: 7 });
    chk('还没到点，什么都没发', got.length === 0, JSON.stringify(got));
    await q.flushAll();
    chk('★ flushAll 之后立刻发掉了（不用等 5 秒）', got.length === 1 && got[0] === 7, JSON.stringify(got));
  }

  /* ── ④ 发失败了不能把队列卡死 ── */
  console.log('');
  console.log('── ④ 一次发送失败之后 ──');
  {
    let n = 0;
    const q = makeSaveQueue({
      gap: 10,
      send: async () => { n++; if (n === 1) throw new Error('写盘失败（模拟）'); },
    });
    q.push('p1', { v: 1 });
    await sleep(60);
    q.push('p1', { v: 2 });
    await sleep(60);
    chk('★ 失败之后还能继续发（队列没卡死）', n === 2, '发了 ' + n + ' 次');
    chk('  没有卡在"在飞"里', q.stats().flying === 0, JSON.stringify(q.stats()));
  }

  /* ── ⑤ 接线：界面那侧真的用上了吗 ── */
  console.log('');
  console.log('── ⑤ 接线（静态查 settings-mounts.js）──');
  {
    const src = fs.readFileSync(path.join(ROOT, 'src/renderer/ui/settings-mounts.js'), 'utf8');
    chk('引了 makeSaveQueue', /import\s*\{\s*makeSaveQueue\s*\}\s*from\s*'\.\/savequeue\.js'/.test(src));
    chk('★ input 事件里走的是队列（不再是裸的 providers.save）',
      /provQ\.push\(/.test(src) && !/window\.yachiyo\.providers\.save\(provState\.active,\s*patch\)\.catch/.test(src));
    chk('切预设之前先 flush（不然最后那一下会丢）', /provQ\.flushAll\(\)/.test(src));
  }

  console.log('');
  console.log('─'.repeat(52));
  console.log(`  ${pass}/${pass + fail} 通过${fail ? '  ✗ ' + fail + ' 项没过' : '  ✓ 全过'}`);
  console.log('─'.repeat(52));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('自检自己炸了：' + (e.stack || e.message)); process.exit(1); });
