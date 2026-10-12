/**
 * 文本工具 —— 分词、相似度、截断。
 *
 * 这套东西是从旧工程（PowerShell 版）1:1 搬过来的**算法**，不是照抄代码：
 *   · Get-AiGramSet       → gramSet()
 *   · Get-AiTextSimilarity → similarity()
 *   · 画像剔空槽的 O50 正则 → stripEmptySlots()
 *
 * ⚠️ **这套检索全是关键词，没有向量、没有 embedding。**
 *    旧工程跑了几个月就是这个方案，够用，而且不要钱、不要额外模型、不要联网。
 *    想升级成向量再说 —— 但那是「换一套」，不是「补一块」。
 */

'use strict';

/** 注入提示词里块与块之间的分隔符。
 *  ⚠️ 必须是 CRLF —— 旧工程用 [Environment]::NewLine，Windows 上就是 \r\n。
 *     这块「精确格式」是他对着旧版一句句校过的，换行符错了就等于换了格式。 */
const CRLF = '\r\n';

/** 块与块之间 */
const GAP = CRLF + CRLF;

/**
 * 把一句话切成特征词集合。
 *
 * - 英文 / 数字：**整词**，长度 ≥2，转小写（"GPU" → "gpu"）
 * - 中文：相邻 **2 字**滑窗（"他会熬夜" → 他会 / 会熬 / 熬夜）
 *
 * 为什么中文用 2-gram 而不是分词：不用带词典、不用联网，
 * 而且「熬夜」这种词天然会被切出来。单字太泛（"的""了"到处都是），
 * 3-gram 又太严（换个说法就匹配不上）。
 */
function gramSet(s) {
  const out = new Set();
  const t = String(s == null ? '' : s).toLowerCase();
  if (!t) return out;

  for (const w of t.match(/[a-z0-9_]{2,}/g) || []) out.add(w);

  // 汉字段单独切 —— 中英混排时不能跨过标点去组 gram
  for (const run of t.split(/[^一-龥]+/)) {
    if (!run) continue;
    if (run.length === 1) continue;               // 单字不成词
    for (let i = 0; i + 2 <= run.length; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

/**
 * 两句话有多像。返回 0~1。
 *
 * 用的是**重叠系数**：|A∩B| ÷ min(|A|,|B|)。
 * ⚠️ 分母取 min 不取并集，是故意的 —— 短句子跟长句子比，
 *    只要短的那句被完全包住就算很像。去重场景（「这句是不是说过了」）
 *    要的就是这个：他那句话短，她记的那句长，反过来也一样。
 */
function similarity(a, b) {
  const A = gramSet(a), B = gramSet(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return hit / Math.min(A.size, B.size);
}

/* ============================================================
   ★★ 「两边都够像」的去重判据（2026-10-12 晚加，替代单看 similarity）
   ============================================================
   ⚠️⚠️ 为什么非要加这一套 —— 实测数据摆在这儿：

       该合的（同一件事换个说法）           min    交并比
         他不喜欢我熬夜 / 他好像不太喜欢…    0.67   0.29
         他今天心情不好 / 他今天心情不太好    0.83   0.63
         他老是忘记喝水 / 他常常忘了要喝水    0.17   **0.08**

       不该合的（共享句式，讲的是两件事）     min    交并比
         我以为他讨厌西瓜 / 我以为他讨厌闹钟  0.71   **0.56**
         我以为他要的是蓝色 / …是绿色        0.75   0.60

     看最后两行：**不该合的分数比该合的高好几倍**。
     根因是那截公共前缀「我以为他讨厌…」贡献了一大堆重复 gram，
     而**句子越短，公共部分占比越大** —— 于是纯粹靠阈值根本分不开。
     实测连着量了两轮，换过 min、交并比、两者一起，**都分不开**。

   ⇒ 治法不是调阈值，是**先把公共的头尾剃掉再比**：
       把长的那个按**公共前缀/后缀**削一遍，然后拿剃完的短句和长句比。
       「我以为他讨厌西瓜」 vs 「我以为他讨厌闹钟」→ 剃完是「西瓜」vs「闹钟」→ 0 ✓
       「他老是忘记喝水」 vs 「他常常忘了要喝水」→ 没有公共头尾，不动 → 0.08（还是不高，
         但这种「换了一整套说法」的本来就是 2-gram 的天花板，认了）

   ⚠️ 只在**去重**（心事合并 / 认错去重）用这一套 ——
      `similarity()` 本身不动，别的地方（梗库、画像）还照旧。
*/
/**
 * 剃掉公共的头或尾。
 *
 * @param {'head'|'tail'|'both'} mode
 *   ⚠️ **默认 'head'**（只剃头）。别用 'both' 去判"是不是同一条" ——
 *      同时剃头尾会把「他今天在家」/「他今天不在家」的头尾一起吃光，
 *      剩下「在」vs「不在」，看着就像同一条了（实际意思相反）。
 *      见 `isLikelySame` 里那两条血泪。
 */
function stripSharedEnds(a, b, mode = 'head') {
  const s = Array.from(String(a || ''));
  const l = Array.from(String(b || ''));
  let p = 0, e = 0;
  if (mode === 'head' || mode === 'both') {
    while (p < s.length && p < l.length && s[p] === l[p]) p++;
  }
  if (mode === 'tail' || mode === 'both') {
    while (e < s.length - p && e < l.length - p
           && s[s.length - 1 - e] === l[l.length - 1 - e]) e++;
  }
  return {
    a: s.slice(p, s.length - e).join(''),
    b: l.slice(p, l.length - e).join(''),
    trimmed: p + e,
  };
}

/**
 * 两个口径一起算。
 * @returns {{min:number, max:number, trimmed:number}}
 *   · `min` = 命中 ÷ **较小**那句 —— 老口径（短句被长句包住就算像）
 *   · `max` = 命中 ÷ **较大**那句 —— 第二道闸（长句得有足够比例被覆盖）
 */
function similarityBoth(a, b) {
  const A = gramSet(a), B = gramSet(b);
  if (!A.size || !B.size) return { min: 0, max: 0, trimmed: 0 };
  let hit = 0;
  for (const g of A) if (B.has(g)) hit++;
  return {
    min: hit / Math.min(A.size, B.size),
    max: hit / Math.max(A.size, B.size),
    trimmed: 0,
  };
}

/**
 * 去重用的判据：**先剃公共头尾，再要求两边都够像**。
 *
 * @param {string} a
 * @param {string} b
 * @param {number} minTh 较小句那一侧的阈值
 * @param {number} maxTh 较大句那一侧的阈值
 * @returns {{same:boolean, min:number, max:number, trimmed:number}}
 */
function isLikelySame(a, b, minTh = 0.85, maxTh = 0.7) {
  const s = String(a || ""), t = String(b || "");
  if (s === t) return { same: true, min: 1, max: 1, via: "identical" };

  /*
   * 候选比对一律收集起来，最后**取最好的那个**判一次。
   *
   * ⚠️⚠️ 别在某个候选上直接 return false —— 不同剃法各有各的用途：
   *    · **原始**：抓「只差标点/语气词」（gram 完全相同，字符串不等）
   *    · **剃头**：抓「他今天心情不好 / 不太好」这种前缀相同的
   *    · **剃尾**：抓「…他吃饭 / …他吃饭了」这种后缀多一个字的
   *    我第一版写了「剃完有一边空就当不同」的短路，结果
   *    「他说不用等他吃饭」vs「他说不用等他吃饭了」剃头之后是 `"" / "了"`，
   *    被判成 0 —— 而那**正是最该合的一条**。
   */
  const cands = [
    { via: "bare", r: similarityBoth(s, t) },
    { via: "head", r: (() => { const x = stripSharedEnds(s, t, "head"); return x.trimmed ? similarityBoth(x.a, x.b) : null; })() },
    { via: "tail", r: (() => { const x = stripSharedEnds(s, t, "tail"); return x.trimmed ? similarityBoth(x.a, x.b) : null; })() },
  ].filter((c) => c.r);

  let best = { min: 0, max: 0, via: "none" };
  for (const c of cands) {
    if (c.r.min > best.min || (c.r.min === best.min && c.r.max > best.max)) {
      best = { min: c.r.min, max: c.r.max, via: c.via };
    }
  }
  return { same: best.min >= minTh && best.max >= maxTh, min: best.min, max: best.max, via: best.via };
}

/** 截断，超了补一个省略号。`n` 是**字符数**（中文一个字算一个） */
function clip(s, n, tail = '…') {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + tail : t;
}

/**
 * 画像里的「空槽行」要剔掉。
 *
 * 实际场景：模型重写画像时会写出这种行 ——
 *     - 他在意什么：
 *     - 他的工作：
 * 一条内容都没有，但**不能原样喂回提示词**：她读到「他在意什么：」
 * 会理解成「他在意的东西是空的」，然后说话就不敢碰这个话题了。
 *
 * 正则来自旧工程 O50：`^[-*]\s*[^:：]{1,14}[:：]\s*$`
 *   → 项目符号 + 最多 14 个非冒号字符 + 一个中/英文冒号 + 后面就没了
 */
const EMPTY_SLOT = /^[-*]\s*[^:：]{1,14}[:：]\s*$/;

function stripEmptySlots(md) {
  return String(md == null ? '' : md)
    .split(/\r?\n/)
    .filter((ln) => !EMPTY_SLOT.test(ln.trim()))
    .join(CRLF)
    .replace(/(\r\n){3,}/g, GAP)   // 剔完留下的连续空行收一收
    .trim();
}

/** 多行文本统一成 CRLF，行尾空白清掉 */
function toCRLF(s) {
  return String(s == null ? '' : s).replace(/\r?\n/g, CRLF);
}

/** 01 / 02 … 补零 */
function pad2(n) { return String(n).padStart(2, '0'); }

/** 本地时间 → `yyyy-MM-dd` */
function day(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 本地时间 → `yyyy-MM-dd HH:mm:ss`（旧工程所有状态文件用的就是这个口径） */
function stamp(d = new Date()) {
  return `${day(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 本地时间 → `yyyy-MM-dd HH:mm` */
function stampMin(d = new Date()) {
  return `${day(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** `yyyy-MM-dd HH:mm:ss` → 毫秒时间戳；解析不了返回 0 */
function parseStamp(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(String(s || ''));
  if (!m) return 0;
  return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0)).getTime();
}

function daysBetween(a, b) {
  return Math.round((a - b) / 86400000);
}

module.exports = {
  CRLF, GAP, EMPTY_SLOT,
  gramSet, similarity, clip, stripEmptySlots, toCRLF,
  pad2, day, stamp, stampMin, parseStamp, daysBetween,
  // ★ 去重专用（先剃公共头尾，再要求两边都够像），见上面的长注释
  similarityBoth, stripSharedEnds, isLikelySame,
};
