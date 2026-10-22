#!/usr/bin/env node
/**
 * selfcheck-cancel —— 点「停止」之后，preflight 那两步（天气 / 联网）真能停下吗
 *
 * ★ 2026-10-22 新建，对应外部审查 **YCH-010**（静态确认）。
 *
 *   现象：`chat:abort` 只 abort 了 `provider.chat`。前面查天气（5 秒上限）、
 *        联网（最长 20 秒）完全够不着 —— 他点了停止还得干等，
 *        看着像按钮坏了，而且那一次联网的钱照样花掉。
 *
 *   这条链横跨主进程（`index.cjs` 的 preflight）和两个 core 模块，
 *   而 `index.cjs` 要 Electron，起不了 → 所以分两半验：
 *     ① **行为**：给 weather / websearch 传一个 signal，abort 之后必须
 *        在 ~1 秒内返回「取消了」（原来是等它自己超时）；
 *     ② **接线**：静态查 index.cjs —— preflight 有没有收 signal、
 *        两个分支是不是都 (a) 先看一眼 stopped() (b) 把 signal 传下去。
 *        光改 core 不接线，等于白改（这种"函数写好了没人调"的坑踩过好几次）。
 *
 *   全打桩：不联网。
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'yachiyo-cancel-'));
process.env.YACHIYO_HOME = HOME;

let pass = 0, fail = 0;
const chk = (n, ok, d) => {
  if (ok) { pass++; console.log('  ✓ ' + n); }
  else { fail++; console.log('  ✗ ' + n + (d !== undefined ? '   → ' + d : '')); }
};

const ROOT = path.resolve(__dirname, '..', '..');
const cfg = require(path.join(ROOT, 'src/core/config.cjs'));
const weather = require(path.join(ROOT, 'src/core/weather.cjs'));
const websearch = require(path.join(ROOT, 'src/core/websearch.cjs'));

const realFetch = global.fetch;

/** 桩：永远不回；只认 abort */
function stubHang() {
  return (url, opt) => new Promise((resolve, reject) => {
    const sig = opt && opt.signal;
    if (sig) {
      if (sig.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }
  });
}

console.log('selfcheck-cancel —— 点停止能不能真停下');
console.log('家目录：' + HOME);
console.log('');

(async () => {
  cfg.patch({ apiKey: 'sk-test-cancel', apiBase: 'http://127.0.0.1:9/v1', city: '北京', webEnabled: true });

  /* ── ① 联网：abort 之后立刻返回「取消了」 ── */
  console.log('── ① 联网（websearch.search）──');
  global.fetch = stubHang();
  {
    const ctl = new AbortController();
    const t0 = Date.now();
    const p = websearch.search('今天有什么新鲜事', { signal: ctl.signal });
    setTimeout(() => ctl.abort(), 120);
    const r = await p;
    const ms = Date.now() - t0;
    chk('★ abort 之后回来了（不是干等它自己的超时）', ms < 2000, ms + 'ms');
    chk('★ 报的是「取消了」', r.ok === false && /取消/.test(String(r.why)), JSON.stringify(r.why));
    console.log('    实测：' + ms + 'ms · why=' + r.why);
  }

  /* 已经 aborted 再进去：一步都不许发 */
  {
    const ctl = new AbortController();
    ctl.abort();
    let called = 0;
    global.fetch = (...a) => { called++; return stubHang()(...a); };
    const r = await websearch.search('再问一句', { signal: ctl.signal });
    chk('★ 进来前就已经停了 ⇒ 一次请求都不发', called === 0 && /取消/.test(String(r.why)),
      `fetch 被调了 ${called} 次 · why=${r.why}`);
  }

  /* ── ② 天气：同样 ── */
  console.log('');
  console.log('── ② 天气（weather.fetchWeather）──');
  global.fetch = stubHang();
  {
    const ctl = new AbortController();
    const t0 = Date.now();
    const p = weather.fetchWeather({ signal: ctl.signal });
    setTimeout(() => ctl.abort(), 120);
    const r = await p;
    const ms = Date.now() - t0;
    chk('★ abort 之后回来了', ms < 3000, ms + 'ms');
    chk('★ 报的是「取消了」', r.ok === false && /取消/.test(String(r.why || '')), JSON.stringify(r.why));
    console.log('    实测：' + ms + 'ms · why=' + r.why);
  }

  /* ── ③ 接线：index.cjs 里那两处真的接上了吗 ── */
  console.log('');
  console.log('── ③ 接线（静态查 index.cjs）──');
  const src = fs.readFileSync(path.join(ROOT, 'src/main/index.cjs'), 'utf8');
  const code = src.split('\n').filter((ln) => {
    const t = ln.trim();
    return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('/*');
  }).join('\n');

  chk('preflight 的签名收了 signal', /async function preflight\(msg, ev, signal = null\)/.test(code));
  chk('调用处把 ctl.signal 传进去了', /preflight\(msg, ev, ctl\.signal\)/.test(code));
  chk('★ 天气那步先看 stopped()', /if \(!stopped\(\) && weather\.isAsking\(msg\)\)/.test(code));
  chk('★ 联网那步先看 stopped()', /if \(!stopped\(\) && websearch\.shouldSearch\(msg\)\)/.test(code));
  chk('★ 天气调用带上了 signal', /weather\.fetchWeather\(\{ signal \}\)/.test(code));
  chk('★ 联网调用带上了 signal', /websearch\.search\(msg, \{ signal \}\)/.test(code));

  global.fetch = realFetch;
  fs.rmSync(HOME, { recursive: true, force: true });

  console.log('');
  console.log('─'.repeat(52));
  console.log(`  ${pass}/${pass + fail} 通过${fail ? '  ✗ ' + fail + ' 项没过' : '  ✓ 全过'}`);
  console.log('─'.repeat(52));
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('自检自己炸了：' + (e.stack || e.message)); process.exit(1); });
