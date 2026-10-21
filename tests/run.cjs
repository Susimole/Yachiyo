#!/usr/bin/env node
/**
 * tests/run.cjs —— 一键跑纯 node 自检
 *
 * ★ 2026-10-18 加的（T-006 洗澡第 ③ 步）：以前这 23 套散在
 *   `桌面\八千代AI桌宠工作留痕\selfcheck自检\` 里，**仓库里一个都没有** ——
 *   任何新会话（包括下一个我）打开仓库都看不到测试，只能靠上一轮的叙述判断"改坏没有"。
 *
 * 用法：
 *   node tests/run.cjs                只跑纯 node 的（快，不起窗口）
 *   node tests/run.cjs --all          连要起 Electron 的那几套一起
 *   node tests/run.cjs chat memory    只跑名字里含这些词的
 *
 * ⚠️ 每套跑在自己的 `YACHIYO_HOME` 里，不碰他真实的 `%APPDATA%\Yachiyo`。
 * ⚠️ 起 Electron 的那几套会**真的在她屏幕上开窗口** —— 默认不跑。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const UNIT = path.join(__dirname, 'unit');
const HOMES = path.join(__dirname, '.homes');

const args = process.argv.slice(2);
const all = args.includes('--all');
const filters = args.filter((a) => !a.startsWith('--'));

if (!fs.existsSync(UNIT)) {
  console.error('✗ 没有 tests/unit 目录');
  process.exit(1);
}

const files = fs.readdirSync(UNIT).filter((f) => f.endsWith('.test.cjs')).sort();
const picked = [];
const skipped = [];

for (const f of files) {
  const src = fs.readFileSync(path.join(UNIT, f), 'utf8');
  const needsGui = /\bspawn(Sync)?\s*\([^)]*electron|require\(['"]electron['"]\)|electron\s*--/.test(src);
  if (filters.length && !filters.some((k) => f.includes(k))) continue;
  if (needsGui && !all) { skipped.push(f); continue; }
  picked.push(f);
}

console.log('纯 node 自检：' + picked.length + ' 套'
  + (skipped.length ? '（跳过要起窗口的 ' + skipped.length + ' 套：' + skipped.join(', ') + '）' : ''));
console.log('');

fs.mkdirSync(HOMES, { recursive: true });

let pass = 0;
const fails = [];
const t0 = Date.now();

for (const f of picked) {
  const name = f.replace(/\.test\.cjs$/, '');
  const home = path.join(HOMES, name);
  fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });

  const env = { ...process.env, YACHIYO_HOME: home };
  delete env.ELECTRON_RUN_AS_NODE;

  const r = spawnSync(process.execPath, [path.join(UNIT, f)], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 180000, windowsHide: true,
  });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const last = out.split('\n').filter((s) => s.trim()).pop() || '(没有输出)';
  const ok = r.status === 0;

  if (ok) pass++; else fails.push(f);
  console.log((ok ? '  ✓ ' : '  ✗ ') + name.padEnd(16) + ' ' + last.slice(0, 90));
  if (!ok) {
    const tail = out.split('\n').filter((s) => /✗|Error|错误/.test(s)).slice(0, 6);
    for (const l of tail) console.log('      ' + l.slice(0, 120));
  }
}

fs.rmSync(HOMES, { recursive: true, force: true });

/* ★ 2026-10-21 加：全绿就顺手把散在仓库根 / tests 下的隔离家目录扫掉。
 *   来由：15 套自检各自把 `YACHIYO_HOME` 写死成 `ROOT/_selfcheck-home-<名>`
 *   （不看 run.cjs 塞的 env），跑完就留在仓库里 —— 清一次又生一次。
 *   ⚠️ 有红**不扫**：红的时候那个目录就是现场，删了等于毁证据。 */
if (!fails.length) {
  for (const dir of [ROOT, __dirname]) {
    for (const n of fs.readdirSync(dir)) {
      if (!/^_selfcheck-(home|.*\.json$)/.test(n)) continue;
      fs.rmSync(path.join(dir, n), { recursive: true, force: true });
    }
  }
}

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log('');
console.log((fails.length ? '✗ 有红' : '★ 全绿') + '　' + pass + '/' + picked.length + ' 套，用时 ' + secs + ' 秒');
if (fails.length) console.log('  红的：' + fails.join(', '));
process.exit(fails.length ? 1 : 0);
