/**
 * 长期记忆 · 习惯库 + 梗库 + 命中热度 + 归档。
 *
 * 这是旧工程「记忆」六层里的 L2。两个库都是**纯文本 Markdown**，
 * 不是 json —— 因为他会**自己打开改**。json 少个逗号整份就废了，
 * md 少一行什么都不影响。
 *
 * ── 两个库的定位不一样，别混 ──
 *
 *   **习惯库**（habits.md）：记「他平时是什么样」。写入靠学习链从聊天里提炼。
 *      ⚠️ 注入时**整份常驻**（旧工程 O36 的决定）。为什么不用检索挑：
 *      习惯是**背景**，她需要随时知道「他上晚班」「他不太会饿着自己」，
 *      而不是等他提到「熬夜」才想起来。挑着给会让她显得没记性。
 *      ⚠️ 正因为整份常驻，**它不能记命中** —— 每次都全给，等于每次都算命中，
 *      热度会虚高到封顶，归档永不触发，库只涨不消。
 *
 *   **梗库**（memes.md）：记「他说某个词是什么意思」。这个**要检索**，
 *      因为梗太多了，全塞进去会挤掉正文。判定用**精确包含**：
 *      他那句话里出现了梗或别名，就命中。
 *
 * ── 热度 ──
 *   分数 = min(命中次数, 10) × 权重 + 最近用过的时间加成，**封顶 1.0**。
 *   封顶是旧工程 O76 的决定：不封顶的话「越用越用」—— 常出现的条目热度
 *   滚到 2.0，而文本相关度通常只有 1~3，等于热度只手遮天。
 *   封顶后热度最多相当于 1 次文本命中，只当**同分时的先后**用。
 */

'use strict';

const path = require('node:path');
const cfg = require('./config.cjs');
const store = require('./store.cjs');
const T = require('./text.cjs');

const FILE_HABITS = path.join(store.DATA, 'habits.md');
const FILE_MEMES  = path.join(store.DATA, 'memes.md');
const FILE_HITS   = path.join(store.STATE, 'hits.json');

const HEAD_HABITS = `# 习惯库

> 这里记的是「他平时是什么样」—— 她跟你聊着聊着，一点点攒下来的。
> 一条一行。直接改这个文件也行：删掉一行就当她忘了，加一行就当她记住了。
> 格式：\`- 内容 [日期]\`（方括号里的日期可以省）

`;

const HEAD_MEMES = `# 梗库

> 这里记的是「你说某个词是什么意思」。
> 一条一行，格式：\`- 词 / 别名 = 意思\`（别名可以省，多个用 / 隔开）

`;

/* ═══════════════ 解析 ═══════════════ */

/**
 * 从 Markdown 里挑出「条目行」。
 * 认的是行首 `- `，忽略 `#` 标题、`>` 引言和空行 —— 这样他自己往文件里
 * 写注释不会被当成条目。
 */
function entryLines(md) {
  return String(md || '')
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter((ln) => /^[-*]\s+\S/.test(ln))
    .map((ln) => ln.replace(/^[-*]\s+/, ''));
}

/** `- 内容 [日期]` → { text, date }；日期缺省为今天 */
function parseHabit(s) {
  const m = /^(.*?)\s*\[(\d{4}-\d{2}-\d{2})\]\s*$/.exec(s);
  if (m) return { text: m[1].trim(), date: m[2] };
  return { text: s.trim(), date: '' };
}

/** `- 词 / 别名 = 意思` → { word, aliases, mean } */
function parseMeme(s) {
  const i = s.indexOf('=');
  if (i < 0) return null;
  const left = s.slice(0, i).trim();
  const mean = s.slice(i + 1).trim();
  if (!left || !mean) return null;
  const parts = left.split('/').map((x) => x.trim()).filter(Boolean);
  if (!parts.length) return null;
  return { word: parts[0], aliases: parts.slice(1), mean };
}

/** 读习惯库。**每次都读盘** —— 他会自己改文件，缓存了就等于看不见他的改动 */
function readHabits() {
  return entryLines(store.readText(FILE_HABITS)).map(parseHabit).filter((h) => h.text);
}

function readMemes() {
  return entryLines(store.readText(FILE_MEMES)).map(parseMeme).filter(Boolean);
}

/* ═══════════════ 写入 ═══════════════ */

function ensureFile(file, head) {
  if (store.readText(file) == null) store.writeText(file, head);
}

/**
 * 加一条习惯。**完全一样的不重复加**（近似重复交给学习链去挡）。
 * @returns {boolean} 真的写进去了
 */
function addHabit(text, date) {
  const t = String(text || '').trim();
  if (t.length < 2) return false;
  ensureFile(FILE_HABITS, HEAD_HABITS);

  const d = date || T.day();
  const exists = readHabits().some((h) => h.text === t);
  if (exists) return false;

  return store.appendText(FILE_HABITS, `- ${t} [${d}]\n`);
}

/**
 * 加一条梗。
 * ⚠️ 去重按**词**（不是按意思）—— 「撤硕」已经记过了，再学一遍
 *    「撤硕 = 厕所间」会让检索出两条，注入块里看着像复读。
 */
function addMeme(word, aliases, mean) {
  const w = String(word || '').trim();
  const m = String(mean || '').trim();
  if (!w || !m) return false;
  ensureFile(FILE_MEMES, HEAD_MEMES);

  if (readMemes().some((x) => x.word === w)) return false;

  const al = (Array.isArray(aliases) ? aliases : String(aliases || '').split('/'))
    .map((x) => String(x).trim()).filter(Boolean);
  const left = [w, ...al].join(' / ');
  return store.appendText(FILE_MEMES, `- ${left} = ${m}\n`);
}

/* ═══════════════ 命中记录与热度 ═══════════════ */

/**
 * 命中记录。顶层扁平 map，key 是 `H|条目原文` 或 `M|词`，
 * value 是 `次数|yyyy-MM-dd`（新格式）或纯日期（旧格式，当用过 1 次）。
 *
 * ⚠️ 为什么 key 里带条目原文而不是编号：他能手改 md 文件，编号会错位；
 *    带原文的话删了一行只是那条记录变成孤儿，**后面 Save 时会被剔掉**。
 */
function readHits() {
  const v = store.readJson(FILE_HITS, {});
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** `"2|2026-09-28"` / `"2026-09-28"` → { n, date }。解析不了当没记过 */
function parseHit(v) {
  const s = String(v || '');
  const m = /^(\d+)\|(.+)$/.exec(s);
  if (m) return { n: +m[1], date: m[2] };
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return { n: 1, date: s };   // 旧格式当用过 1 次
  return { n: 0, date: '' };
}

/**
 * 热度分。**封顶 1.0**（见文件头说明）。
 * 时间加成的口径跟旧工程一致：7 天内 +0.5，30 天内 +0.2，再久不加。
 */
function heat(hitValue, now = Date.now()) {
  const w = Number(cfg.get('memoryHeatWeight')) || 0.15;
  const { n, date } = parseHit(hitValue);
  if (!n) return 0;

  let s = Math.min(n, 10) * w;
  const t = T.parseStamp(date);
  if (t) {
    const d = (now - t) / 86400000;
    if (d <= 7) s += 0.5;
    else if (d <= 30) s += 0.2;
  }
  return Math.min(s, 1);
}

/** 内存里那份命中记录 —— 改了先留在这儿，攒着一起落盘 */
let cache = null;
let dirty = false;

function hits() {
  if (!cache) cache = readHits();
  return cache;
}

/**
 * 丢掉内存缓存。他手改 `hits.json` 之后（或者测试里）要用一下，
 * 不然读到的还是内存里那份旧的。
 */
function reload() { cache = null; dirty = false; }

/**
 * 记一次命中。**内存里改，攒着**，由 flushHits() 统一落盘 ——
 * 一次对话里可能命中好几条梗，每条都写一次盘不值得。
 *
 * ⚠️ 必须走 `hits()`（缓存），不能走 `readHits()`（重读盘）。
 *    重读的话：这一轮刚记的三条命中，会被下一次读盘**覆盖回去**，
 *    最后只有最后一条活下来。
 */
function noteHit(key, now = Date.now()) {
  if (!cfg.get('memoryHeatEnabled')) return;
  const all = hits();
  const { n } = parseHit(all[key]);
  all[key] = `${n + 1}|${T.day(new Date(now))}`;
  dirty = true;
}

/**
 * 落盘。写之前**把已经不在库里的 key 剔掉** ——
 * 他删了一行习惯，那条记录就没用了，留着只会让文件越来越胖。
 *
 * ⚠️ 过滤后如果**一条都不剩**，就不过滤、也不覆盖 ——
 *    旧工程踩过：某次两个库都读成空（文件正在被写），
 *    结果把整份命中记录清空了，所有热度归零。
 */
function flushHits() {
  if (!dirty) return false;
  dirty = false;
  const all = hits();

  const alive = new Set([
    ...readHabits().map((h) => `H|${h.text}`),
    ...readMemes().map((m) => `M|${m.word}`),
  ]);
  if (!alive.size) return false;

  const out = {};
  for (const [k, v] of Object.entries(all)) if (alive.has(k)) out[k] = v;

  cache = out;
  return store.writeJson(FILE_HITS, out);
}

/* ═══════════════ 检索 ═══════════════ */

/**
 * 挑该给她看的梗。
 *
 * **精确包含**：他那句话里出现了梗或任一别名 → 命中。
 * 分数 = **最长匹配长度** + 热度。用最长匹配长度而不是命中个数：
 * 「撤硕」和「硕」都命中时，长的那条显然更贴题。
 */
function selectMemes(userText, topK) {
  const t = String(userText || '');
  if (!t) return [];
  const k = Number(topK) || 5;
  const h = hits();
  const now = Date.now();
  const out = [];

  for (const m of readMemes()) {
    let best = 0;
    for (const w of [m.word, ...m.aliases]) {
      if (w && t.includes(w) && w.length > best) best = w.length;
    }
    if (!best) continue;
    out.push({
      ...m,
      score: best + heat(h[`M|${m.word}`], now),
      hitKey: `M|${m.word}`,
    });
  }

  out.sort((a, b) => b.score - a.score);
  const picked = out.slice(0, k);
  for (const p of picked) noteHit(p.hitKey);   // ⚠️ 只给挑中的记命中
  return picked;
}

/* ═══════════════ 归档 ═══════════════ */

/**
 * 很久没被用到的条目挪进归档。**不删。**
 *
 * 旧工程踩过的一个细节：**从来没命中过的条目，第一次见到时先记上今天**，
 * 而不是立刻归档 —— 否则刚学到的两条新习惯，因为「还没被用过」
 * 当场就被扫进归档里了。
 */
function archive(decayDays) {
  if (!cfg.get('memoryArchiveEnabled')) return { habits: 0, memes: 0 };

  // ⚠️ 顺序不能反：
  //   ① 先把攒在内存里的命中**落盘** —— 不落的话下面 ② 的重读会把它盖掉
  //   ② 再**重读盘**，不 `hits()` 拿缓存 —— 归档是低频操作（一天一次），
  //      读一次盘无所谓；拿缓存的话，任何绕过 noteHit 的改动（比如
  //      他自己手改 hits.json，或者测试脚本）都看不见，
  //      结果就是「明明 400 天没用了，怎么都不归档」。
  flushHits();
  const h = readHits();
  cache = h;

  const days = Number(decayDays || cfg.get('memoryDecayDays')) || 180;
  const now = Date.now();
  let touched = false;

  /**
   * ⚠️ 判据是「**有没有日期**」，不是「次数是不是 0」。
   *    写成看次数的话：从没命中过的条目会被补上 `0|今天`，下次再看还是 0，
   *    又补一次今天 —— **日期永远往前滚，这条永远归档不掉**。
   *    有日期了就该按日期老老实实算。
   */
  const tooOld = (key) => {
    const { date } = parseHit(h[key]);
    if (!date) {                   // 完全没记录过 → 补今天，别急着归档
      h[key] = `0|${T.day(new Date(now))}`;
      touched = true;
      return false;
    }
    const t = T.parseStamp(date);
    return t ? (now - t) / 86400000 > days : false;
  };

  const moved = { habits: [], memes: [] };
  for (const x of readHabits()) if (tooOld(`H|${x.text}`)) moved.habits.push(x);
  for (const x of readMemes())  if (tooOld(`M|${x.word}`)) moved.memes.push(x);

  if (touched) { cache = h; dirty = true; }
  if (!moved.habits.length && !moved.memes.length) {
    flushHits();                   // 补的那些「今天」也要落盘，别留在内存里
    return { habits: 0, memes: 0 };
  }

  const stamp = T.stamp();
  if (moved.habits.length) {
    store.appendText(path.join(store.ARCHIVE, 'habits.md'),
      `\n## ${stamp} 归档\n` +
      moved.habits.map((x) => `- ${x.text}${x.date ? ` [${x.date}]` : ''}`).join('\n') + '\n');
  }
  if (moved.memes.length) {
    store.appendText(path.join(store.ARCHIVE, 'memes.md'),
      `\n## ${stamp} 归档\n` +
      moved.memes.map((x) => `- ${x.word}${x.aliases.length ? ' / ' + x.aliases.join(' / ') : ''} = ${x.mean}`).join('\n') + '\n');
  }

  // 从库里摘掉（整份重写，保留文件头）
  if (moved.habits.length) {
    const gone = new Set(moved.habits.map((x) => x.text));
    const keep = readHabits().filter((x) => !gone.has(x.text));
    store.writeText(FILE_HABITS, HEAD_HABITS + keep.map((x) => `- ${x.text}${x.date ? ` [${x.date}]` : ''}`).join('\n') + '\n');
  }
  if (moved.memes.length) {
    const gone = new Set(moved.memes.map((x) => x.word));
    const keep = readMemes().filter((x) => !gone.has(x.word));
    store.writeText(FILE_MEMES, HEAD_MEMES + keep.map((x) => `- ${[x.word, ...x.aliases].join(' / ')} = ${x.mean}`).join('\n') + '\n');
  }

  flushHits();
  return { habits: moved.habits.length, memes: moved.memes.length };
}

/* ═══════════════ 注入 ═══════════════ */

/**
 * 拼「你记得的这些」这一段。格式是从旧工程逐字对的，别改标点。
 *
 * ⚠️ 两个小节**条件输出** —— 库是空的时候连小标题都不出现。
 *    给一句「关于他的习惯：」后面什么都没有，她会以为自己把习惯全忘了。
 * ⚠️ 两库都空 → 返回空串，整块不注入。
 */
function buildBlock(userText) {
  // ⚠️ 写 `!== false` 不写 `!cfg.get(...)` —— 老配置升级上来时这个键可能
  //    压根不存在，取到 undefined，`!undefined` 会把整块记忆直接关掉。
  if (cfg.get('memEnabled') === false) return '';

  const hs = readHabits();                                    // 习惯整份常驻
  const ms = selectMemes(userText, cfg.get('memeTopK'));      // 梗要检索
  if (!hs.length && !ms.length) return '';

  const lines = ['【你记得的这些】'];

  if (hs.length) {
    lines.push('关于他的习惯：');
    for (const h of hs) lines.push(`- ${h.text}`);
  }
  if (ms.length) {
    lines.push('这些梗你知道是什么意思：');
    for (const m of ms) lines.push(`- ${m.word} = ${m.mean}`);
  }

  return lines.join(T.CRLF);
}

/** 给学习链用的：把已有清单摆给模型看（坑 6：不摆就会滚出一堆重复条目） */
function listForPrompt() {
  return {
    habits: readHabits().map((h) => h.text),
    memes: readMemes().map((m) => `${m.word} = ${m.mean}`),
  };
}

module.exports = {
  FILE_HABITS, FILE_MEMES, FILE_HITS,
  readHabits, readMemes, addHabit, addMeme,
  selectMemes, buildBlock, listForPrompt,
  readHits, noteHit, flushHits, heat, archive, reload,
};
