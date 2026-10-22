#!/usr/bin/env node
/**
 * selfcheck-listmodels-timeout —— 「检测模型」会不会永远转圈
 *
 * ★ 2026-10-22 新建，对应外部审查 **YCH-004**（确定复现）。
 *
 *   现象：地址写对了、**响应头也回来了**，但服务端迟迟不发 body
 *        （限流 / 中间设备扣着 / 它自己卡住）。
 *   改前：`clearTimeout` 写在读 body **之前** ⇒ 头一到超时就没了 ⇒
 *        `res.text()` 能等一辈子 ⇒ IPC 一直 pending，设置页那颗按钮永远转圈。
 *   改后：timer 留到 body 读完；body 读超了照样 abort。
 *
 *   ⚠️ 判据必须是"**在限定时间内抛出来**"，不是"最后会不会抛" ——
 *      改前那个实现**永远不会抛**，只写"应该 reject"是测不出来的。
 *
 *   全打桩：不联网。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-listms-'));
process.env.YACHIYO_HOME = HOME;
/* ⚠️ 必须在 require provider 之前设 —— LIST_MS 是模块加载时算的 */
process.env.YACHIYO_LIST_MS = '400';

let pass = 0, fail = 0;
const chk = (n, ok, d) => {
  if (ok) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d !== undefined ? '   → ' + d : '')); }
};

const provider = require(path.join(__dirname, '..', '..', 'src', 'core', 'provider.cjs'));
const realFetch = global.fetch;

console.log('selfcheck-listmodels-timeout —— 响应头回了、body 卡住');
console.log('LIST_MS 被压到 400ms（自检专用钩子）');
console.log('');

/** 桩：头立刻回来，body 永远不结束；abort 时才让它 reject */
function stubStuckBody() {
  return (url, opt) => Promise.resolve({
    ok: true,
    status: 200,
    text: () => new Promise((resolve, reject) => {
      const sig = opt && opt.signal;
      if (sig) sig.addEventListener('abort', () => reject(new Error('aborted')));
    }),
  });
}

(async () => {
  /* ── ① body 卡住：必须在 ~1 秒内抛，而不是永远挂着 ── */
  console.log('── ① 头回来了、body 不回 ──');
  global.fetch = stubStuckBody();
  const t0 = Date.now();
  let err = null;
  try {
    await provider.listModels({ base: 'http://127.0.0.1:9/v1', key: 'sk-test' });
  } catch (e) { err = e; }
  const ms = Date.now() - t0;

  chk('★ 抛出来了（改前这里会永远 pending）', !!err, err ? '' : '没抛 —— 就是那个 bug');
  chk('★ 是在超时之后抛的，不是别的错', err && /响应|读完|卡住|没回话/.test(err.message),
    err && err.message);
  chk('★ 没有等太久（< 3 秒）', ms < 3000, ms + 'ms');
  console.log('    实测：' + ms + 'ms · ' + (err ? err.message : '（无异常）'));

  /* ── ② 正常响应：别把好的也误杀 ── */
  console.log('');
  console.log('── ② 正常响应还是好的（没误伤）──');
  global.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }),
  });
  let out = null, err2 = null;
  try { out = await provider.listModels({ base: 'http://x/v1', key: 'sk-test' }); } catch (e) { err2 = e; }
  chk('正常列表拿得到', !!out && !err2, err2 && err2.message);
  chk('模型名解析对了', out && out.ids.join(',') === 'deepseek-chat,deepseek-reasoner',
    out && out.ids.join(','));

  /* ── ③ 读到一半断线：报人话，别报"不是 JSON" ── */
  console.log('');
  console.log('── ③ 读到一半断了 ──');
  global.fetch = () => Promise.resolve({
    ok: true,
    status: 200,
    text: async () => { throw new Error('ECONNRESET'); },
  });
  let err3 = null;
  try { await provider.listModels({ base: 'http://x/v1', key: 'sk-test' }); } catch (e) { err3 = e; }
  chk('★ 报的是「读断了」，不是「回的不是 JSON」', !!err3 && /断|读完|卡住/.test(err3.message),
    err3 && err3.message);

  global.fetch = realFetch;
  fs.rmSync(HOME, { recursive: true, force: true });
  console.log('');
  console.log('─'.repeat(52));
  console.log(`  ${pass}/${pass + fail} 通过${fail ? '  ✗ ' + fail + ' 项没过' : '  ✓ 全过'}`);
  console.log('─'.repeat(52));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('自检自己炸了：' + (e.stack || e.message)); process.exit(1); });
