/**
 * 用量与花费 —— 他说「用量与成本功能最好也要加入」。
 *
 * 存 `%APPDATA%\Yachiyo\data\usage.json`。
 * 记「今天」和「这个月」两档；跨天了、跨月了自动归零。
 *
 * ⚠️ 跨天不能靠「定时器到点就清零」—— 她是桌宠，可能开着开了三天，
 *    也可能今天压根没启动。所以要**每次读写时比对日期戳**，对不上就重置。
 *    这个坑旧工程踩过：日志里某天的花费算进了前一天。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DATA, ensureDir } = require('./config.cjs');

const FILE = path.join(DATA, 'usage.json');

const EMPTY = {
  day: '',           // '2026-10-11'
  month: '',         // '2026-10'
  todayCalls: 0,
  todayTokens: 0,    // 输入 + 输出
  todayCost: 0,      // 元
  monthCalls: 0,
  monthTokens: 0,
  monthCost: 0,
  totalCalls: 0,
  totalCost: 0,
  lastAt: 0,
};

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function thisMonth() { return today().slice(0, 7); }

let data = null;

function load() {
  if (data) return data;
  ensureDir();
  let raw = {};
  if (fs.existsSync(FILE)) {
    try { raw = JSON.parse(fs.readFileSync(FILE, 'utf8')); }
    catch (err) {
      console.error('[usage] 账本读坏了，重新开始记：' + err.message);
      raw = {};
    }
  }
  data = { ...EMPTY, ...raw };
  roll();
  return data;
}

/** 跨天 / 跨月归零 —— 每次读写都过一遍 */
function roll() {
  const d = today();
  const m = thisMonth();
  let changed = false;
  if (data.day !== d) {
    data.day = d;
    data.todayCalls = 0;
    data.todayTokens = 0;
    data.todayCost = 0;
    changed = true;
  }
  if (data.month !== m) {
    data.month = m;
    data.monthCalls = 0;
    data.monthTokens = 0;
    data.monthCost = 0;
    changed = true;
  }
  if (changed) save();
}

function save() {
  try {
    ensureDir();
    const tmp = FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch (err) {
    // 账记不上不该拦住她说话
    console.error('[usage] 账本写盘失败：' + err.message);
  }
}

/**
 * 记一笔。
 * @param {object} usage  provider 返回的原始 usage
 * @param {number} yuan   这一笔花了多少钱（provider.cost 算好的）
 */
function add(usage, yuan) {
  load();
  roll();
  const tok = (usage?.prompt_tokens || 0) + (usage?.completion_tokens || 0);
  data.todayCalls++;
  data.todayTokens += tok;
  data.todayCost += yuan;
  data.monthCalls++;
  data.monthTokens += tok;
  data.monthCost += yuan;
  data.totalCalls++;
  data.totalCost += yuan;
  data.lastAt = Date.now();
  save();
  return { ...data };
}

function all() { load(); roll(); return { ...data }; }

/** 今天花超了没有（设置里那个「花超了提醒我」用） */
function overLimit(limitYuan) {
  load();
  return limitYuan > 0 && data.monthCost >= limitYuan;
}

function reset() {
  data = { ...EMPTY, day: today(), month: thisMonth() };
  save();
  return { ...data };
}

module.exports = { FILE, load, add, all, overLimit, reset };
