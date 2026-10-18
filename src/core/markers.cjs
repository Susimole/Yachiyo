/**
 * 她回复里的**方括号标记** —— 解析 + 剥掉 + 落库。
 *
 * 出处：旧工程 `Finish-AiRound`（聊天窗.ps1:2309）那一套。
 * 规矩是「**先剥标记，再显示**」—— 标记是给她自己用的指令，
 * 一个字都不该让他在气泡里看见。
 *
 * 现在只做 3c 这一批（情绪）。后面几批（联网 / 看一眼 / 闹钟 / 唱歌 / 表情）
 * 各有各的链，等那几步接上时往 MARKERS 里加一条就行 —— **别在外面各写一遍正则**。
 *
 * ⚠️⚠️ 正则**同时接受半角 `[]` 和全角 `【】`**，这是旧工程实测的要求：
 *     模型经常混着吐，只认半角的话会漏掉一半标记，
 *     而漏掉的后果是**标记原样显示在他的气泡里**（「[心情 差]」几个字挂在那儿）。
 *
 * ⚠️ `[心情]` **必须锚在行首**（`^\s*`）—— 不然她正常说话里带个方括号、
 *    后面又碰巧有个"好"字，就会被误判成情绪标记。
 */

'use strict';

const mood = require('./mood.cjs');
const T = require('./text.cjs');

/** 情绪词 → 档位。两边都是他自己写的近义词，宽一点 */
const GOOD = '好|不错|开心|高兴|挺好|舒服';
const BAD = '差|不好|低落|糟|难受|烦|郁闷';

/*
 * ⚠️⚠️ 标记后面**不要写 `[^\r\n]*` 去"吃到行尾"** —— 那是个吃正文的坑。
 *
 *    我第一版写的就是 `…[\]】][^\r\n]*`，想着「把标记那一行整个吃掉」。
 *    结果 `[心情 不错]  好耶`（标记后面同一行还有话）整行被吞干净，
 *    回复变成空的。而且**只在"标记后面还有字、且这一行不是最后一行"时才露馅** ——
 *    典型的那种「大部分时候看着好好的」的 bug。
 *
 *    正解：**只吃掉标记本身**（加上它后面的水平空白），后面的正文原样留着。
 *    剥完再统一收空行（见下面那两行）。
 */
const RE_GOOD = new RegExp(`^[ \\t]*[\\[【]\\s*心情\\s*(${GOOD})\\s*[\\]】][ \\t]*`, 'gm');
const RE_BAD = new RegExp(`^[ \\t]*[\\[【]\\s*心情\\s*(${BAD})\\s*[\\]】][ \\t]*`, 'gm');

/**
 * 扫一遍她这句话。
 *
 * @param {string} text 模型原始回复
 * @param {object} [o]
 * @param {string} [o.chain] 哪条链来的（只进日志）
 * @returns {{text:string, marks:Array<{kind:string,mood:string}>}}
 *          `text` 是**剥干净**的（拿去显示 / 入库），`marks` 是扫到的标记
 */
function parse(text, o = {}) {
  let out = String(text == null ? '' : text);
  const marks = [];

  /*
   * ⚠️ 先扫出档位再删 —— 删完就没有"好/差"可看了。
   *    两遍代替一个复杂正则：GOOD 和 BAD 的词表是**分开维护**的，
   *    合成一个正则的话，将来加词要在一句话里改两边，容易漏。
   */
  for (const [re, m] of [[RE_GOOD, '高兴'], [RE_BAD, '低落']]) {
    re.lastIndex = 0;
    let hit;
    while ((hit = re.exec(out))) marks.push({ kind: 'mood', mood: m, raw: hit[0].trim() });
  }

  out = out.replace(RE_GOOD, '').replace(RE_BAD, '');

  /*
   * ⚠️⚠️ 剥完标记要**收干净空行**。
   *    标记占一整行的时候，剥掉会留下一个空行 —— 气泡里就是头顶一片空。
   *    `{2,}` 是因为：两行标记连在一起（很少见但不是不会）会留下两个。
   */
  /*
   * ⚠️ 先把 CRLF 归一成 LF（2026-10-16 修的）。
   *    `/^\s*[\r\n]/gm` 里的 `^` 在 **m 模式下也会匹配 `\r` 之后** ——
   *    于是碰上 `\r\n` 它只吃掉 `\n`、把 `\r` 留在正文里（一个孤零零的回车）。
   *    实测：`第一行\r\n[心情 不错]\r\n第二行` 剥完是 `第一行\r第二行`。
   *    归一之后 `[\r\n]` 只会剩 `\n` 一种，这种"半吃"就没法发生了。
   */
  out = out.replace(/\r\n?/g, '\n').replace(/^\s*[\r\n]/gm, '').replace(/\n{2,}/g, '\n').trim();

  // 落到数据层
  for (const mk of marks) {
    if (mk.kind !== 'mood') continue;
    /*
     * 「为什么」取**本轮剩下的正文**，截 40 字（旧工程如此）。
     * 空正文 —— 说明她只吐了个标记、没说话 —— 那就给一句兜底，
     * 别因为「没写原因」把这次情绪丢掉（标记都打了，说明她真想变）。
     */
    // ⚠️ 用 T.cut 不 slice —— 正文里带个 emoji 就会被切出半个字符（见 text.cjs 的 cut）
    const why = T.cut(out.replace(/[\r\n]+/g, ' ').trim(), 40) || '说不出为什么，就是不顺';
    const r = mood.set(mk.mood, why, { from: o.chain || '对话' });
    if (!r.ok) console.log(`[markers] 情绪没记：${r.why}`);
  }

  return { text: out, marks };
}

/** 有没有标记（调用方想省一次解析时用） */
function has(text) {
  RE_GOOD.lastIndex = 0; RE_BAD.lastIndex = 0;
  return RE_GOOD.test(String(text || '')) || RE_BAD.test(String(text || ''));
}

module.exports = { parse, has, RE_GOOD, RE_BAD };
