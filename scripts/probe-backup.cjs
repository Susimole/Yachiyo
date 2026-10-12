/**
 * 端到端探针 · 备份（C-1）
 *
 * 自检（selfcheck-4c.cjs）验的是**备份本身**（分档、拆天、zip 能解开）。
 * 这个探针验的是**接线** —— 它挂在 `main/index.cjs` 里，
 * 而自检根本不跑主进程，那一整段它一个字都验不到。
 *
 * 要证明的两件事：
 *   ① 启动之后**真的自己备了**（不是"函数能用"）
 *   ② 备出来的东西落在**他说的那种文件夹**里（`26-10` / `2026-10-19`…）
 *
 * 跑法：node scripts/probe-backup.cjs
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');
const HOME = path.join(ROOT, '_probe-bk-home');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const fail = [];
  const ok = (cond, msg, extra) => {
    console.log(`  ${cond ? '✓' : '✗'} ${msg}${extra ? '   ' + extra : ''}`);
    if (!cond) fail.push(msg);
  };

  /* ── 造一个"她家" ── */
  fs.rmSync(HOME, { recursive: true, force: true });
  const T10 = new Date(2026, 9, 13, 14, 0, 0);
  const put = (p, t, w) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, t, 'utf8');
    if (w) fs.utimesSync(p, w, w);
  };
  put(path.join(HOME, 'data/chat.jsonl'), '{"role":"user","content":"测试一句"}\n', T10);
  put(path.join(HOME, 'data/聊天记录/2026-10/2026-10-13_140000.jsonl'), '那次对话\n', T10);
  put(path.join(HOME, 'data/habits.md'), '- 他会熬夜\n', T10);
  put(path.join(HOME, 'data/profile.md'), '# 他\n', T10);
  put(path.join(HOME, 'persona/人格配置.md'), '你是辉夜\n', T10);
  put(path.join(HOME, 'logs/2026-10.log'), '[2026-10-13 14:00:00] [自言语] 测试行\n', T10);
  fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
    apiKey: '', AiEnabled: false, autostart: false, sound: false, moveEnabled: false,
    backupDaily: true, backupWeeklyMemory: true, backupDir: '备份',
  }, null, 2), 'utf8');

  // ⚠️ `_probe.log` 是**共享**的（主进程按工程根写）—— 先删掉，免得读到上一次的
  try { fs.rmSync(path.join(ROOT, '_probe.log'), { force: true }); } catch { }

  try { execSync("powershell.exe -NoProfile -Command \"Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | ForEach-Object { $_.Kill() }\"", { stdio: 'ignore', windowsHide: true }); } catch { }
  await sleep(600);

  const child = spawn(electronPath, [ROOT], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, YACHIYO_MS: '25000', YACHIYO_HOME: HOME },
    stdio: 'ignore',
  });

  /*
   * 备份是**延迟 8 秒**才跑的（见 index.cjs 里的注释：不跟她启动争 IO），
   * 所以这里至少得等 8 秒 + 一点余量。
   */
  console.log('\n  …等她启动，然后等那 8 秒的备份窗口过去…\n');
  await sleep(20000);
  try { child.kill(); } catch { }
  try { execSync("powershell.exe -NoProfile -Command \"Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*node_modules*electron*' } | ForEach-Object { $_.Kill() }\"", { stdio: 'ignore', windowsHide: true }); } catch { }
  await sleep(500);

  /* ── ① 主进程日志里有没有那一行 ── */
  const plog = (() => { try { return fs.readFileSync(path.join(ROOT, '_probe.log'), 'utf8'); } catch { return ''; } })();
  const line = (plog.split('\n').find((l) => l.includes('[备份]')) || '').trim();
  console.log(`  主进程那行：[备份] ${line.replace(/^.*\[备份\]\s*/, '') || '（没有）'}`);
  ok(!!line, '★ 备份真的在启动时跑了（主进程日志里有它那一行）', '');
  ok(/跑了/.test(line), '  而且不是"没跑"（今天首次启动）', line);
  ok(!/出错/.test(line), '  也没报错', '');

  /* ── ② 落盘结构对不对 ── */
  const B = path.join(HOME, '备份');
  const rel = (p) => path.relative(HOME, p).replace(/\\/g, '/');
  const all = (function walk(d, b = d, o = []) {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return o; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      e.isDirectory() ? walk(p, b, o) : o.push(path.relative(b, p).replace(/\\/g, '/'));
    }
    return o;
  })(B);

  console.log('\n  备份目录里的东西：');
  for (const f of all) console.log('    ' + f);

  const YM = new Date().getFullYear().toString().slice(-2) + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
  ok(all.some((f) => f.startsWith(`聊天记录/${YM}/`)),
    `★ 聊天记录按年月进了「${YM}」文件夹`, '');
  ok(all.some((f) => /^聊天记录\/[0-9]{2}-[0-9]{2}\/chat-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)),
    '  主聊天记录 chat.jsonl 也备上了（按天一份）', '');
  ok(all.some((f) => f.startsWith(`日志/${YM}/`)), `★ 日志也按年月进了「${YM}」`, '');
  ok(all.some((f) => /^日志\/[0-9]{2}-[0-9]{2}\/\d{4}-\d{2}-\d{2}\.log$/.test(f)),
    '  日志按天拆开了（不是一个月一个大文件）', '');
  ok(all.some((f) => /^记忆\/\d{4}-\d{2}-\d{2}\/.*\.zip$/.test(f)),
    '★ 记忆进了「记忆\\YYYY-MM-DD\\」里的一个 zip',
    (all.find((f) => f.startsWith('记忆/')) || ''));

  /* ── ③ zip 能解开 ── */
  const zipRel = all.find((f) => /^记忆\/.*\.zip$/.test(f));
  if (zipRel) {
    const exDir = path.join(HOME, '_unzip');
    let err = '';
    try {
      execSync(`powershell.exe -NoProfile -Command "Expand-Archive -LiteralPath '${path.join(B, zipRel)}' -DestinationPath '${exDir}' -Force"`,
        { stdio: 'pipe', windowsHide: true });
    } catch (e) { err = String(e.stderr || e.message).slice(0, 160); }
    const n = (function walk(d, b = d, o = []) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        e.isDirectory() ? walk(p, b, o) : o.push(path.relative(b, p));
      }
      return o;
    })(exDir).length;
    ok(n > 0, '★★ zip 真的能解开（手写的二进制格式）', err || `${n} 个文件`);
  }

  /* ── ④ 原件一个没动 ── */
  ok(fs.readFileSync(path.join(HOME, 'data/profile.md'), 'utf8') === '# 他\n',
    '★ 原件没被碰过（只抄不删）', '');

  console.log(`\n==== ${fail.length ? '✗ ' + fail.length + ' 项没过' : '✓ 全过'} ====`);
  if (fail.length) { for (const f of fail) console.log('   ✗ ' + f); process.exitCode = 1; }
})().catch((e) => { console.error(e); process.exit(1); });
