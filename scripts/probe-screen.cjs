/**
 * 端到端探针 · 识屏的**抓屏**那两条路
 *
 * ⚠️ 这一条**只能在真 Electron 里验** —— `desktopCapturer` 是 Electron 的 API，
 *    node 里根本没有（自检那 52 条全跑在 node 上，这条它够不着）。
 *
 * 要证明的：
 *   ① `desktopCapturer` 真能截到图（不是全黑、有内容）
 *   ② GDI 那条也真能截到
 *   ③ 前台窗口读得到（标题 + 进程名）—— 这条不依赖截图，对独占全屏 100% 有效
 *
 * ⚠️ 主进程那边有个探针口：`YACHIYO_MS > 0` 时会真截一张写到 `_cap-probe/`。
 *    产物 + `_probe.log` 就是这里的判据。
 *
 * 跑法：node scripts/probe-screen.cjs [auto|desktopCapturer|gdi]
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');
const HOME = path.join(ROOT, '_probe-cap-home');
const OUT = path.join(ROOT, '_cap-probe');

const METHOD = process.argv[2] || 'auto';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const fail = [];
  const ok = (cond, msg, extra) => {
    console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '   ' + extra : ''}`);
    if (!cond) fail.push(msg);
  };

  fs.rmSync(HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(HOME, 'data', 'state'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    apiKey: '', AiEnabled: false, autostart: false, sound: false, moveEnabled: false,
    backupDaily: false, profileEnabled: false, screenEnabled: false, screenCapture: METHOD,
  }, null, 2), 'utf8');

  try { fs.rmSync(OUT, { recursive: true, force: true }); } catch { /* 没有就算 */ }
  try { fs.rmSync(path.join(ROOT, '_probe.log'), { force: true }); } catch { /* 没有就算 */ }

  try { execSync("powershell.exe -NoProfile -Command \"Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | ForEach-Object { $_.Kill() }\"", { stdio: 'ignore', windowsHide: true }); } catch { }
  await sleep(600);

  console.log(`\n  （抓屏方式：${METHOD}）\n`);

  const child = spawn(electronPath, [ROOT], {
    env: {
      ...process.env, ELECTRON_RUN_AS_NODE: undefined,
      YACHIYO_MS: '25000', YACHIYO_HOME: HOME, YACHIYO_CAPTURE: METHOD,
    },
    stdio: 'ignore',
  });

  // 主进程延后 6 秒才截，这里给足余量
  await sleep(16000);
  try { child.kill(); } catch { }
  try { execSync("powershell.exe -NoProfile -Command \"Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | ForEach-Object { $_.Kill() }\"", { stdio: 'ignore', windowsHide: true }); } catch { }
  await sleep(500);

  /* ── 主进程那行日志 ── */
  const plog = (() => { try { return fs.readFileSync(path.join(ROOT, '_probe.log'), 'utf8'); } catch { return ''; } })();
  const line = (plog.split('\n').find((l) => l.includes('[抓屏探针]')) || '').trim();
  console.log(`  主进程那行：${line.replace(/^.*\[抓屏探针\]\s*/, '') || '（没有）'}`);
  ok(!!line, '★ 主进程真的去截了（探针口跑到了）', '');
  ok(!/出错/.test(line), '  没报错', '');

  /* ── 产物 ── */
  const metaF = path.join(OUT, 'meta.json');
  const fgF = path.join(OUT, 'fg.json');
  const jpg = path.join(OUT, 'shot.jpg');

  ok(fs.existsSync(metaF), '  写了 meta.json', '');
  const meta = fs.existsSync(metaF) ? JSON.parse(fs.readFileSync(metaF, 'utf8')) : null;
  if (meta) {
    console.log(`\n  【截图】${meta.usedMethod} ${meta.w}×${meta.h} ` +
      `${(meta.bytes / 1024).toFixed(0)} KB · 采样点亮 ${meta.lit}/25 · max ${meta.max}`);
    ok(meta.ok === true, '★ 截屏成功（不是失败返回）', meta.why || '');
    ok(!meta.blank, '★★ **不是全黑**（全黑 = 抓不到画面）', `lit=${meta.lit}/25`);
    ok(meta.w >= 640 && meta.h >= 360, '  尺寸合理（>=640×360，够她看清）', `${meta.w}×${meta.h}`);
    ok(meta.bytes > 20000, '★ 图有内容（>20KB，不是一张纯色）', `${(meta.bytes / 1024).toFixed(0)} KB`);
    ok(!!meta.hash, '  算了哈希（跨轮去重要用）', meta.hash.slice(0, 12));
    /*
     * ★★ 这条是 2026-10-13 补的 —— 上面那条 `blank===false` 断言**不够**：
     *    GDI 那条绕过判定时 blank 也是 false，看着照样"过"。
     *    要盯**判定到底跑没跑**（decoded）。
     */
    ok(meta.decoded === true, '★★ 全黑判定**真的跑了**（不是绕过去了当 false）',
      meta.decoded === undefined ? '（meta 里没有 decoded 字段 —— 老版本）' : String(meta.decoded));
    ok(meta.lit > 0, '★★ 采样真的读到亮像素了', `lit=${meta.lit}/25 max=${meta.max}`);
    ok(fs.existsSync(jpg), '  图落盘了', '');
  }

  /* ── 前台窗口 ── */
  ok(fs.existsSync(fgF), '  写了 fg.json（前台窗口）', '');
  const fg = fs.existsSync(fgF) ? JSON.parse(fs.readFileSync(fgF, 'utf8')) : null;
  if (fg) {
    console.log(`\n  【前台窗口】「${fg.title}」 · ${fg.proc || '（读不到进程名）'} · pid ${fg.pid}`);
    ok(fg.ok === true, '★ 读得到前台窗口（**不截图也知道他在干嘛**这一条）', fg.why || '');
    ok(!!fg.proc, '  读到了进程名（游戏就是靠这个认的）', fg.proc);
  }

  /* ── 给一句人话总结 ── */
  console.log('');
  if (meta && meta.ok && !meta.blank) {
    console.log(`  ✅ ${meta.usedMethod} 抓到了真画面 —— 识屏这条路可用`);
  } else if (meta) {
    console.log(`  ⚠️ 没抓到画面：${meta.why || '全黑'} —— 换一种方式再试：` +
      `node scripts/probe-screen.cjs gdi`);
  }

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
})().catch((e) => { console.error(e.message); process.exit(1); });
