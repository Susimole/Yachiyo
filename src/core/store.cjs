/**
 * 状态文件读写 —— 所有「她记下来的东西」的公共底座。
 *
 * 旧工程里这套逻辑散在十几个函数里（Read-AiTextFile / Get-AiMind / Save-AiMind /
 * Get-AiHitState / Save-AiHitState …），每个都自己写一遍「读不到就返回空」
 * 「写之前先建目录」。新工程收成一份。
 *
 * 三条铁律（都是旧工程踩出来的）：
 *   ① **读不到 / 读坏了 → 返回兜底值，绝不抛异常。**
 *      记忆丢了可以重攒；桌宠因为一个 json 少了半个花括号就起不来，那是事故。
 *   ② **写盘用「先写临时文件再改名」。**
 *      旧工程 `.AppendLine()` 写到一半断电，文件就剩半行，下次读直接废。
 *   ③ **写坏的原文件不删，改名留证。** 出事的时候能翻回去看是哪儿坏的。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config.cjs');

/** `…\Yachiyo\data\` —— 对话历史、账本之外的「她记住的东西」都在这儿 */
const DATA = cfg.DATA;
/** 结构化状态（命中记录 / 跨会话 / 我说过什么） */
const STATE = path.join(DATA, 'state');
/** 只进不出 —— 归档的东西不删，挪个地方 */
const ARCHIVE = path.join(DATA, 'archive');

function ensure() {
  for (const d of [cfg.DIR, DATA, STATE, ARCHIVE]) {
    try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch { /* 建不了等写盘时报 */ }
  }
}

/**
 * 读一个文本文件。
 *
 * ⚠️ **BOM 一定要剥。** 旧工程的坑：同一个工程里有的文件带 BOM 有的不带，
 *    不剥的话 `JSON.parse` 直接抛 "Unexpected token"，
 *    而错误信息里那个 BOM 是**看不见的** —— 能对着文件看好几分钟看不出问题。
 */
function readText(file) {
  try {
    if (!fs.existsSync(file)) return null;
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (err) {
    console.error(`[store] 读不了 ${path.basename(file)}：${err.message}`);
    return null;
  }
}

/**
 * 原子写。
 * ⚠️ 临时文件必须跟目标在**同一个目录** —— 跨盘 rename 会失败（EXDEV）。
 */
function writeText(file, body, { bom = false } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, (bom ? '﻿' : '') + body, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error(`[store] 写不了 ${path.basename(file)}：${err.message}`);
    return false;
  }
}

/**
 * 追加一行。
 *
 * ⚠️ **追加绝不能带 BOM** —— 文件已经存在的话，BOM 会被插到**文件中间**，
 *    下次整份读出来中间多一个不可见字符，解析习惯库/梗库就串行了。
 */
function appendText(file, body) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, body, 'utf8');
    return true;
  } catch (err) {
    console.error(`[store] 追加不了 ${path.basename(file)}：${err.message}`);
    return false;
  }
}

/**
 * 读 JSON。读坏了 → **改名留证 + 返回兜底**。
 * 改名而不是删：他可能手改过这个文件，直接删等于把他的东西扔了。
 */
function readJson(file, fallback = null) {
  const raw = readText(file);
  if (raw == null || !raw.trim()) return fallback;
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch (err) {
    const bad = `${file}.bad-${Date.now()}`;
    try { fs.renameSync(file, bad); } catch { /* 改名失败也只能算了 */ }
    console.error(`[store] ${path.basename(file)} 坏了，已改名到 ${path.basename(bad)}：${err.message}`);
    return fallback;
  }
}

/** 写 JSON。缩进 2 格 —— 他会自己打开看 / 手改，压成一行就没法看了 */
function writeJson(file, obj) {
  return writeText(file, JSON.stringify(obj, null, 2) + '\n');
}

/** 文件的最后修改时间（毫秒）；不存在返回 0 */
function mtime(file) {
  try { return fs.statSync(file).mtimeMs; } catch { return 0; }
}

/** 文件大小（字节）；不存在返回 0 */
function size(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

module.exports = {
  DATA, STATE, ARCHIVE,
  ensure, readText, writeText, appendText, readJson, writeJson, mtime, size,
};
