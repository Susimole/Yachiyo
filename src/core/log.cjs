/**
 * 落盘日志 —— 她自己那条条链上「干了什么、为什么没干」的**唯一**去处。
 *
 * 为什么非要有这个：
 *   `console.log` 在打包后的 Electron 里**谁也看不见**（Windows 上 electron.exe
 *   是 GUI 子系统程序，stdout 不接任何管道）。于是「回顾没触发」这种事
 *   只能靠猜 —— 是门槛没过？没材料？还是接口挂了？
 *
 *   ⚠️⚠️ 更要命的是**假成功**：回顾链里有五道闸，任何一道拦下来都是**静默**的。
 *     没有日志的话，"她今天没回顾"和"她回顾了但是写盘失败了"长得一模一样。
 *     凡是可能假成功的链，**必须留一个可验收的指标写进日志**。
 *
 * 格式（一行一条，跟旧工程一个路子，他能直接翻）：
 *   [2026-10-12 17:20:08] [回顾] 键鼠停了 61.2 分钟（门槛 55）→ 发起回顾
 *
 * 落哪儿：`%APPDATA%\Yachiyo\logs\YYYY-MM.log`（按月一个文件）
 * ⚠️ **UTF-8 不带 BOM + 裸 LF** —— 日志不该有 BOM，`grep` 会被它噎到。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config.cjs');

const DIR = path.join(cfg.DIR, 'logs');

/** 等级：数越小越重要。低于 `logLevel` 配置的那档就不写 */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function file(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  return path.join(DIR, `${y}-${m}.log`);
}

function stamp(now) {
  const p = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ` +
         `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

/** 当前配置的等级阈值 */
function threshold() {
  const lv = String(cfg.get('logLevel') || 'info');
  return LEVELS[lv] == null ? LEVELS.info : LEVELS[lv];
}

/**
 * 写一条。
 * @param {'error'|'warn'|'info'|'debug'} level
 * @param {string} chain 哪条链（'回顾' / '心跳' / '自言语' …）
 * @param {string} msg
 */
function write(level, chain, msg) {
  if (LEVELS[level] > threshold()) return false;
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const line = `[${stamp(new Date())}] [${chain}] ${msg}\n`;
    fs.appendFileSync(file(), line, 'utf8');
    return true;
  } catch {
    // ⚠️ 日志写不了**绝不能**影响主流程 —— 她该说话还得说话
    return false;
  }
}

/**
 * 取最近几行（探针/自检用，也给他"看一眼她今天干了啥"）。
 * @param {number} n
 * @param {string} [needle] 只要含这个串的行
 */
function tail(n = 50, needle = '') {
  try {
    const all = fs.readFileSync(file(), 'utf8').split('\n');
    const hit = needle ? all.filter((l) => l.includes(needle)) : all;
    return hit.filter(Boolean).slice(-n);
  } catch { return []; }
}

module.exports = {
  DIR, file, tail,
  info:  (chain, msg) => write('info', chain, msg),
  warn:  (chain, msg) => write('warn', chain, msg),
  error: (chain, msg) => write('error', chain, msg),
  debug: (chain, msg) => write('debug', chain, msg),
};
