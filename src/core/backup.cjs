/**
 * 备份 —— 她攒下来的东西，抄一份出去。
 *
 * ── ★ 分三档，各按各的时间来（他 2026-10-12 定的）──────────────
 *
 *   **聊天记录 · 每天** → `备份\聊天记录\26-10\2026-10-13_142530.jsonl`
 *       文件夹名 `YY-MM`（26 = 2026 年，10 = 10 月）—— 按**年月**分组，
 *       一个月一档，翻起来是一整段时期。
 *
 *   **日志 · 每天** → `备份\日志\26-10\2026-10-12.log`
 *       同上按年月分组。⚠️ 日志是**按天一个文件**的，所以进档时
 *       也要按天拆开 —— 不然每个月的档里都是同一个 `2026-10.log`，
 *       等于只有最后一天那版（那是假成功，看着有文件、内容是错的）。
 *
 *   **记忆文件 · 每周** → `备份\记忆\2026-10-19\` 整个文件夹
 *       文件夹名 `YYYY-MM-DD`（那天是**当周的周一**）——
 *       一周一档，一次看得出"那周她是什么样"。
 *       里面是一份 zip（不是散文件）：散着放的话，一周几十个文件，
 *       想还原还得一个个挑；zip 一个文件拿走就是那一刻的完整她。
 *
 * ── 三条硬规矩 ─────────────────────────────────────────────
 *   ① **只抄不删**。备份这辈子不碰原件。（旧工程原话）
 *   ② **不弹窗**。他可能在打游戏或者在睡 —— 备份是后台的事。
 *   ③ **失败只记日志**，绝不能因为它挂了而影响她说话。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config.cjs');
const store = require('./store.cjs');
const T = require('./text.cjs');
const log = require('./log.cjs');

/** 备份状态（上次备到哪天）—— 放 state 里，跟别的状态一起 */
const FILE = store.STATE + '/backup.json';

/** 日志文件在哪儿（`%APPDATA%\Yachiyo\logs\YYYY-MM.log`，见 log.cjs） */
const LOG_DIR = path.join(cfg.DIR, 'logs');

/* ── 路径 ─────────────────────────────────────────────── */

/**
 * 备份总目录。
 * ⚠️ **绝对路径也认**（`D:\Yachiyo备份` 这种）—— 他想挪到别的盘就挪。
 *    `path.isAbsolute` 不认的话，`path.join` 会把它拼成
 *    `…\Yachiyo\D:\Yachiyo备份` 这种谁都认不出来的东西，而且不报错。
 */
function root() {
  const v = String(cfg.get('backupDir') || '备份').trim();
  const d = path.isAbsolute(v) ? v : path.join(cfg.DIR, v);
  try { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); } catch { /* 写的时候再报 */ }
  return d;
}

/**
 * 按年月分组的文件夹名：`26-10`。
 * ⚠️ 年份取**后两位** —— 他给的例子就是 `26-10`。
 */
function monthFolder(now = new Date()) {
  const y = String(now.getFullYear()).slice(-2);
  return `${y}-${T.pad2(now.getMonth() + 1)}`;
}

/** 那一周的周一（周备份的文件夹名用它，好认） */
function mondayOf(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const wd = d.getDay();                       // 0=周日
  const back = wd === 0 ? 6 : wd - 1;          // 退到周一
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${T.pad2(d.getMonth() + 1)}-${T.pad2(d.getDate())}`;
}

/** `2026-10-13_142530` —— 文件名里的时间戳 */
function stampFile(now = new Date()) {
  return `${T.day(now)}_${T.pad2(now.getHours())}${T.pad2(now.getMinutes())}${T.pad2(now.getSeconds())}`;
}

/* ── 状态 ─────────────────────────────────────────────── */

function readState() {
  const v = store.readJson(FILE, null);
  return (v && typeof v === 'object') ? v : {};
}
function writeState(o) { return store.writeJson(FILE, o); }

/* ── 抄一份 ───────────────────────────────────────────── */

/** 目录里所有文件（**递归**，返回相对路径） */
function walk(dir, base = dir, out = []) {
  let ents = [];
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, base, out);
    else if (e.isFile()) out.push(path.relative(base, p));
  }
  return out;
}

/**
 * 复制一个文件，**保时间戳**。
 *
 * ⚠️ 时间戳要保住 —— 备份目录是按"文件是什么时候写的"分档的，
 *    复制完变成"复制那一刻"的话，下次再备就认不出它属于哪个月了。
 * ⚠️ `copyFileSync` 不会建父目录，得自己建。
 */
function copyOne(src, dst) {
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    const st = fs.statSync(src);
    fs.utimesSync(dst, st.atime, st.mtime);
    return true;
  } catch (err) {
    log.error('备份', `抄 ${path.basename(src)} 时出错：${err.message}`);
    return false;
  }
}

/* ── ① 聊天记录（每天 · 按月分档）─────────────────────── */

/**
 * 把 `data/聊天记录/**` 抄进 `备份/聊天记录/YY-MM/`。
 *
 * ⚠️ **按每个文件自己的最后修改时间归档**，不是按"今天"。
 *    今天备份时，一个月前写的那份历史还在那儿 —— 它该进上个月那档，
 *    放进这个月的话，上个月那档就永远是空的。
 * @returns {number} 抄了几份
 */
function backupChats(now = new Date()) {
  let n = 0;

  /*
   * ★★ **主聊天记录是 `data\chat.jsonl`，不在 `聊天记录\` 里面** ——
   *    2026-10-12 第一版就是漏在这儿：只走了 `data\聊天记录\**`，
   *    结果**日常对话一份都没备上**（那两条红线正是"该进来却不在"）。
   *
   * ⚠️ 它是个**滚动文件**（`memory.cjs` 只留最近 30 轮就往前切），
   *    所以"抄一份"抄到的是**那一刻的快照**。为了让它可追溯，
   *    备份时按天存一份：`chat-2026-10-13.jsonl`。
   *    直接覆盖 `chat.jsonl` 的话，昨天那份就永远没了 ——
   *    而"留痕"正是他要的。
   */
  const rolling = path.join(store.DATA, 'chat.jsonl');
  if (fs.existsSync(rolling)) {
    const day = T.day(now);
    const dir = path.join(root(), '聊天记录', monthFolder(now));
    const dst = path.join(dir, `chat-${day}.jsonl`);
    const body = fs.readFileSync(rolling, 'utf8');
    try {
      if (fs.readFileSync(dst, 'utf8') !== body) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dst, body, 'utf8');
        n++;
      }
    } catch {
      try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(dst, body, 'utf8'); n++; }
      catch (err) { log.error('备份', '抄主聊天记录时出错：' + err.message); }
    }
  }

  const src = path.join(store.DATA, '聊天记录');
  const files = walk(src);
  for (const rel of files) {
    const full = path.join(src, rel);
    let mtime;
    try { mtime = fs.statSync(full).mtime; } catch { continue; }
    const dir = path.join(root(), '聊天记录', monthFolder(mtime));
    const dst = path.join(dir, rel);
    // 已经有一份**一模一样大**的就不重复抄（省 IO，也免得把时间戳动来动去）
    try {
      const d = fs.statSync(dst);
      if (d.size === fs.statSync(full).size) continue;
    } catch { /* 没有这份，往下走 */ }
    if (copyOne(full, dst)) n++;
  }
  return n;
}

/* ── ② 日志（每天 · 按月分档 · **按天拆**）────────────── */

/**
 * 把 `logs/YYYY-MM.log` **按天拆开**抄进 `备份/日志/YY-MM/YYYY-MM-DD.log`。
 *
 * ⚠️⚠️ 为什么要拆：日志是**按月一个文件**的（`2026-10.log`）。
 *    直接整份抄进月档的话，
 *      · 同一档里永远是同一个文件名，后一天把前一天盖掉；
 *      · 而且它一直在长 —— 看着"有备份"，实际内容是错的。
 *    拆成一天一个文件，才是真的按天留档。
 *
 * ⚠️ 每行有 `[2026-10-12 22:50:41]` 这个前缀（见 log.cjs 的格式），
 *    拿它当分行的依据；认不出的行**挂到上一条那一行**后面，不丢。
 * @returns {number} 产出了几个日文件
 */
function backupLogs(now = new Date()) {
  let names = [];
  try { names = fs.readdirSync(LOG_DIR).filter((f) => /^\d{4}-\d{2}\.log$/.test(f)); }
  catch { return 0; }

  let n = 0;
  for (const name of names) {
    let text = '';
    try { text = fs.readFileSync(path.join(LOG_DIR, name), 'utf8'); } catch { continue; }

    const perDay = new Map();       // '2026-10-12' -> [行…]
    let cur = '';
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\[(\d{4}-\d{2}-\d{2}) /);
      if (m) { cur = m[1]; if (!perDay.has(cur)) perDay.set(cur, []); }
      if (!cur) continue;           // 开头的空行 / 认不出的杂行
      perDay.get(cur).push(line);
    }

    for (const [day, lines] of perDay) {
      const d = new Date(`${day}T12:00:00`);                 // 只用它的年月
      const dir = path.join(root(), '日志', monthFolder(d));
      const dst = path.join(dir, `${day}.log`);
      /*
       * ⚠️ **内容没变就别写** —— 否则每天备份都会把过去每一天的日志
       *    全部重写一遍（一个月就是 30 个文件），而且会不停动 mtime。
       */
      const body = lines.join('\n') + '\n';
      try { if (fs.readFileSync(dst, 'utf8') === body) continue; } catch { /* 没有，写 */ }
      try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(dst, body, 'utf8');                   // ⚠️ 无 BOM + 裸 LF
        n++;
      } catch (err) { log.error('备份', `写日志备份 ${day} 时出错：${err.message}`); }
    }
  }
  return n;
}

/* ── ③ 记忆（每周 · 一个日期文件夹 + 一个 zip）────────── */

/**
 * 往一个空 zip 里塞目录（**不引第三方库**，Node 自带 zlib）。
 *
 * ⚠️ 用 **store（STORE 模式，不压缩）**，不是 deflate。
 *    这些文件加起来几 MB，压缩省不下多少，而 STORE 不需要
 *    把整个包在内存里拼一遍 —— 出错的窗口小得多。
 * ⚠️ 中文文件名：`ZipArchive` 那一套在 Windows 上会按本地代码页解，
 *    所以这里显式置 **UTF-8 标志位（bit 11）**，跟旧工程对齐。
 */
function zipDir(zipPath, entries) {
  const zlib = require('node:zlib');
  const { Buffer } = require('node:buffer');

  const parts = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'), 'utf8');
    const crc = zlib.crc32 ? zlib.crc32(data) : crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);          // 本地文件头签名
    local.writeUInt16LE(20, 4);                  // 需要的版本
    local.writeUInt16LE(0x0800, 6);              // ★ bit 11 = 文件名是 UTF-8
    local.writeUInt16LE(0, 8);                   // 压缩方法 = STORE
    local.writeUInt16LE(0, 10);                  // 时间
    local.writeUInt16LE(0x21, 12);               // 日期（1980-01-01，够了）
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(data.length, 18);        // 压缩后
    local.writeUInt32LE(data.length, 22);        // 原始
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);                  // 扩展区长度

    parts.push(local, nameBuf, data);

    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);            // 中央目录头签名
    cen.writeUInt16LE(20, 4);                    // 制作版本
    cen.writeUInt16LE(20, 6);                    // 需要的版本
    cen.writeUInt16LE(0x0800, 8);                // ★ bit 11
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc >>> 0, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cen, nameBuf]));

    offset += local.length + nameBuf.length + data.length;
  }

  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  fs.writeFileSync(zipPath, Buffer.concat([...parts, cenBuf, end]));
}

/** Node 22 的 `zlib.crc32` 不一定有 —— 没有就自己算（照 IEEE 802.3） */
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[i] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * 周备份：把「她是谁、她记得什么」整个打包。
 *
 * 装进去的东西（= 丢了就得从头攒的）：
 *   语言习惯\ 状态\ 归档\ 聊天记录\ + data 根目录下那几个 md（习惯/梗/画像/待确认）+ 她的*.json
 *
 * @returns {{ok:boolean, dir:string, files:number, bytes:number, why:string}}
 */
function backupMemory(now = new Date()) {
  const entries = [];
  const add = (abs, rel) => {
    if (!fs.existsSync(abs)) return;
    let st; try { st = fs.statSync(abs); } catch { return; }
    if (st.isDirectory()) {
      for (const f of walk(abs)) {
        try {
          entries.push({ name: `${rel}/${f}`, data: fs.readFileSync(path.join(abs, f)) });
        } catch { /* 单个文件读不了不该毁掉整次备份 */ }
      }
    } else {
      try { entries.push({ name: rel, data: fs.readFileSync(abs) }); } catch { }
    }
  };

  add(path.join(cfg.DIR, 'persona'), 'persona');        // 人格
  add(path.join(cfg.DIR, 'fonts'), 'fonts');            // 字体（他丢进来的，丢了要重找）
  add(store.STATE, 'data/state');
  add(store.ARCHIVE, 'data/archive');
  add(path.join(store.DATA, '聊天记录'), 'data/聊天记录');
  for (const f of ['habits.md', 'memes.md', 'profile.md', 'pending.md', 'chat.jsonl']) {
    add(path.join(store.DATA, f), `data/${f}`);
  }

  if (!entries.length) return { ok: false, dir: '', files: 0, bytes: 0, why: '一个文件都没找到' };

  const dir = path.join(root(), '记忆', mondayOf(now));
  const zipPath = path.join(dir, `${T.day(now)}_${T.pad2(now.getHours())}${T.pad2(now.getMinutes())}.zip`);
  try {
    fs.mkdirSync(dir, { recursive: true });
    zipDir(zipPath, entries);
  } catch (err) {
    log.error('备份', '打包记忆失败：' + err.message);
    return { ok: false, dir, files: 0, bytes: 0, why: err.message };
  }

  const bytes = entries.reduce((s, e) => s + e.data.length, 0);
  log.info('备份', `周备份打好了：${entries.length} 个文件 → 记忆/${mondayOf(now)}/` +
    `${path.basename(zipPath)}（原始 ${(bytes / 1024).toFixed(0)} KB）`);
  return { ok: true, dir, files: entries.length, bytes, why: '' };
}

/* ── 该不该备 ─────────────────────────────────────────── */

/**
 * 每天一次 / 每周一次。
 * @param {Date} [now]
 * @returns {object} 这次干了什么（日志和探针要看）
 */
function tick(now = new Date()) {
  const out = { ran: false, day: '', chat: 0, logs: 0, memory: null, why: '' };

  if (cfg.get('backupDaily') === false) { out.why = '每日备份关着'; return out; }

  const today = T.day(now);
  const s = readState();

  /* ① 每天：聊天记录 + 日志 */
  if (s.lastDay !== today) {
    out.ran = true;
    try { out.chat = backupChats(now); } catch (err) { log.error('备份', '聊天记录失败：' + err.message); }
    try { out.logs = backupLogs(now); } catch (err) { log.error('备份', '日志失败：' + err.message); }
    s.lastDay = today;
    writeState(s);
    log.info('备份', `每日备份完成：聊天记录 ${out.chat} 份 · 日志 ${out.logs} 个日文件`);
  } else {
    out.why = '今天已经备过了';
  }

  /* ② 每周：记忆打包 */
  if (cfg.get('backupWeeklyMemory') !== false) {
    const week = mondayOf(now);
    if (s.lastWeek !== week) {
      out.ran = true;
      out.memory = backupMemory(now);
      if (out.memory.ok) {
        s.lastWeek = week;
        writeState(s);
      } else {
        // ⚠️ 失败**不记**周一标记 —— 不然这周就再也不会重试了（静默漏一周）
        log.warn('备份', '这周的周备份没成功，下次启动再试：' + out.memory.why);
      }
    } else if (!out.why) {
      out.why = '这周已经备过了';
    }
  }

  return out;
}

/* ── 状态 / 工具 ──────────────────────────────────────── */

module.exports = {
  FILE, LOG_DIR, root, monthFolder, mondayOf, stampFile,
  backupChats, backupLogs, backupMemory, tick, zipDir,
  lastState: () => readState(),
  _reset() { writeState({}); },
};
