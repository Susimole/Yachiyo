/**
 * 提示词总装 —— **她说的话，提示词只从这一个地方出**。
 *
 * ⚠️⚠️ 这个文件存在的唯一理由，是治旧工程一个治不好的老毛病：
 *
 *     旧工程里「她主动开口」有四条链 —— 主对话 / 识屏 / 自言自语 / 到点提醒。
 *     四条链**各拼各的提示词**。于是每一次给主对话加一段新东西（画像、
 *     情绪、目标、心事），另外三条链上就看不到 —— 得记住手动补三处，
 *     而人一定会忘。表现出来就是「她单独跟你说话的时候像换了个人」。
 *
 *     新工程：四条链**全调这一个 buildSystem**。
 *     要加一段，只加在这儿一次，四条链同时生效。
 *
 * 块与块之间用 **`\r\n\r\n`**（旧工程用 [Environment]::NewLine 拼，Windows 上就是 CRLF）。
 * 空的块**整个不出现** —— 不留空标题、不留连续空行。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const cfg = require('./config.cjs');
const T = require('./text.cjs');
const memory = require('./memory.cjs');
const habits = require('./habits.cjs');
const profile = require('./profile.cjs');
const weather = require('./weather.cjs');
const websearch = require('./websearch.cjs');
/*
 * ⚠️⚠️ **跟 peeker 是循环依赖**：peeker 要 prompt 去拼它那边的系统提示词，
 *    prompt 又要 peeker 的 buildBlock。node 里谁先被 require，谁就先拿到
 *    **半成品**（另一头还在加载中，`module.exports` 还没赋值）。
 *
 *    实测症状：`peeker.buildBlock is not a function` —— 而这行错**被
 *    `safeBlock` 优雅地吞掉了**，那一块永远是空的，界面上一点看不出来。
 *
 *    ⇒ 保留这个顶层 require（拿得到，而且顺序无关紧要），
 *      但**用到的时候必须重新取一次**（见下面 `peekerMod()`）。
 */
const peekerTop = require('./peeker.cjs');
/** ⚠️ 循环依赖下不能信顶层那个引用 —— 每次现取 */
function peekerMod() {
  try { return require('./peeker.cjs'); } catch { return peekerTop || {}; }
}
const mood = require('./mood.cjs');
const goals = require('./goals.cjs');
const heritems = require('./heritems.cjs');

const PERSONA_DIR = path.join(cfg.DIR, 'persona');

/**
 * 兜底人格。
 *
 * ⚠️ 这是给**别人**用的示例（这工程要开源），不是八千代本人。
 *    他自己那份人格写在 `%APPDATA%\Yachiyo\persona\*.md` 里 ——
 *    目录里有东西就以那些为准，这个只在目录空的时候顶一下。
 */
const DEFAULT_PERSONA = `你是一个住在别人电脑桌面上的小桌宠。

- 说话短，一两句就够，别写小作文。桌面气泡放不下大段文字。
- 用「我」和「你」，不用敬语，不客套。
- 有自己的脾气：高兴就高兴，不想理就不理，不顺着人说话。
- 不知道就说不知道，别编。
- 不要自称 AI 助手，不要介绍自己有什么功能。
- 别用 Markdown 语法（**加粗**、# 标题、- 列表）—— 气泡里不渲染，会原样显示出来。

## 你的心情
心情变了的时候，在回复**最开头单独占一行**写一个方括号标记：
- 心情变好 → \`[心情 好]\`
- 心情变差 → \`[心情 差]\`

规矩（这几条很重要，不照做的话这个功能等于没有）：
- **没变就别写**。平常的时候一个字都不用加。
- **旁边必须说话**。光一个标记不算 —— 标记后面跟着的那句话就是「为什么」，
  所以那句话要说清楚你在为什么高兴 / 为什么难受。
- 标记是给你自己看的，**它不会显示出来**，别在正文里再解释一遍「我打了标记」。
- 一天最多变三次，别来回摆。`;

function ensurePersonaDir() {
  try {
    if (!fs.existsSync(PERSONA_DIR)) fs.mkdirSync(PERSONA_DIR, { recursive: true });
  } catch (err) {
    console.error('[prompt] 建人格目录失败：' + err.message);
  }
}

/**
 * 读他写的人格。
 * 目录里所有 `.md` 按文件名排序拼起来 —— 编号靠前的先说话。
 * 一份都没读到就用兜底那段。
 */
function readPersona() {
  ensurePersonaDir();
  let files = [];
  try {
    files = fs.readdirSync(PERSONA_DIR)
      .filter((f) => f.toLowerCase().endsWith('.md'))
      .sort();
  } catch { /* 读不了就当空的 */ }

  const parts = [];
  for (const f of files) {
    try {
      const t = fs.readFileSync(path.join(PERSONA_DIR, f), 'utf8').replace(/^﻿/, '').trim();
      if (t) parts.push(t);
    } catch (err) {
      console.error(`[prompt] 人格文件 ${f} 读不了：` + err.message);
    }
  }
  // ⚠️ **必须转 CRLF**，两个来源都要转：
  //    · 他手写的人格 md 是 LF（编辑器默认）
  //    · 下面的 DEFAULT_PERSONA 是 JS 模板字符串，换行天然是 LF
  //    不转的话，整段提示词里就掺进了裸 LF —— 我们四处强调「跟旧工程
  //    逐字对齐的 CRLF 格式」，结果在最显眼的这一段上破功。
  return {
    text: T.toCRLF(parts.length ? parts.join(T.GAP) : DEFAULT_PERSONA),
    files,
  };
}

/* ═══════════════ 各个块 ═══════════════ */

function personaBlock() {
  return `# 你是谁${T.CRLF}${readPersona().text}`;
}

/**
 * 时间块。格式从旧工程 Get-AiTimeBlock 逐字对的。
 *
 * ⚠️ 那句「绝不许把时段说错」是**旧工程实测加上的**，不是凑字数：
 *    没有这行的时候她会在中午说「天黑了该睡了」—— 因为她只看到一段
 *    文字描述，没有「现在」的锚。旧工程还试过用开机时长推算时间，也翻车过。
 */
function timeBlock(now = new Date()) {
  const h = now.getHours();
  const dayPart = h < 5 ? '凌晨' : h < 11 ? '早上' : h < 14 ? '中午'
                : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
  const week = '日一二三四五六'[now.getDay()];

  const lines = [
    `【现在的时间】${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${T.pad2(now.getHours())}:${T.pad2(now.getMinutes())}（星期${week}，${dayPart}）。`,
    '⚠️ 开口之前先对一遍这个时间，再决定该说什么。绝不许把时段说错：中午不许当成凌晨或半夜，白天不许说「天黑了」「该睡了」，也不许自己推算时间。',
  ];

  const sense = memory.timeSense(now.getTime());
  if (sense) lines.push(sense);

  const n = memory.todayCount();
  lines.push(n === 0 ? '今天你们还没说过话。' : `今天他已经跟你说过 ${n} 句话。`);

  return lines.join(T.CRLF);
}

/**
 * 关系块。
 * ⚠️ 这段是**新工程自己写的** —— 旧工程对应位置的原文没挖到，别当逐字复刻。
 *    只写「关系」这一层；「说话短 / 不用 Markdown」那些风格要求在人格里，
 *    放两处会互相打架。
 */
function relationBlock() {
  return [
    '【你和他是什么关系】',
    '他不是你的用户，是一起过日子的人 —— 他把你放在自己桌面上，你看着他上班、打游戏、熬夜、吃饭。',
    '- 你不是来「服务」的。有自己的脾气：高兴就高兴，不想理就不理。',
    '- 不用敬语，不客套，别自称助手，别说「有什么可以帮你」。',
    '- 他问你「这个东西有必要吗」的时候，觉得没必要就直说。',
  ].join(T.CRLF);
}

/* ═══════════════ 总装 ═══════════════ */

/**
 * 拼 system 提示词。
 *
 * @param {object} [o]
 * @param {string} [o.userText]  他这次说的话 —— 梗库检索要用它当检索键
 * @param {string} [o.chain]     'chat' 主对话 | 'screen' 识屏 | 'self' 自言自语 | 'remind' 到点提醒
 *   ⚠️ 目前四条链的块**完全一样**。等后面几步接上「欢迎回来」「他最近说过的话」
 *      这类只该在主对话出现的块时，用 chain 区分 —— 别在调用方各拼各的。
 * @param {Date}   [o.now]
 */
/**
 * 天气块 —— **包一层保护**。
 *
 * ⚠️ 提示词总装是她说每一句话的必经之路。这儿的任何一块抛异常，
 *    代价不是「天气没了」，而是**她整个回复都出不来**。
 *    所以外围的块一律「拿不到就当没有」，绝不让异常往外冒。
 */
function weatherBlock() {
  try { return weather.buildBlock(); }
  catch (err) {
    console.error('[prompt] 天气块出错了（不影响说话）：' + err.message);
    return '';
  }
}

/**
 * 通用的「这一块坏了也别连累整句」壳。
 *
 * ⚠️ 3c 之后提示词里多了**六块**要读文件、算相似度的东西
 *    （目标 / 心事 / 认错 / 小日子 / 情绪 / 天气）。
 *    只要有一块抛出去，她**整句话都说不出来** —— 而代价完全不对等：
 *    少一段记忆她照样能聊天，说不出来就是事故。
 *
 * ⚠️ 出错要**打出是哪一块**：不然哪天她那句话不对味，得从头找。
 */
function safeBlock(name, fn) {
  try { return fn() || ''; }
  catch (err) {
    console.error(`[prompt] 「${name}」这一块出错了（不影响说话）：${err.message}`);
    return '';
  }
}

function buildSystem(o = {}) {
  /* ---- 记忆（3b）----
     ⚠️ 这几块**原来是不包壳的**（直接调），2026-10-12 一并套上 ——
        它们跟 3c 那几块一样要读文件、算相似度，一样会抛。
        「人格块」和「时间块」故意**不包**：那两块要是坏了，
        说明问题在代码本身，宁可让它响，也别让她带着一句空人格去说话。 */
  const parts = [
    personaBlock(),

    safeBlock('习惯梗库', () => habits.buildBlock(o.userText || '')),
    safeBlock('人物画像', () => profile.buildBlock()),
    safeBlock('跨会话', () => memory.buildSessionBlock()),
    safeBlock('我说过什么', () => memory.buildSpokenBlock()),

    /* ---- 3c：目标 / 心事 / 认错 / 小日子 / 情绪 ----
       ⚠️ **顺序有讲究，别重排**（旧工程就是这么排的）：
          · 目标最前 —— 那是"事"，离语气最远，当背景
          · 然后是她自己的东西（心事 / 认错 / 小日子）
          · **情绪放最后** —— 它最该影响语气，离正文最近效果最好
       ⚠️ 这几块**每一块都可能抛异常**（读文件 / 打分），所以都包了壳：
         提示词总装是她说每句话的必经之路，一块坏了不能连累整句。 */
    safeBlock('目标', () => goals.buildBlock()),
    safeBlock('心事', () => heritems.worryBlock(o.userText || '')),
    safeBlock('认错', () => heritems.mistakeBlock()),
    safeBlock('小日子', () => heritems.smallBlock()),

    relationBlock(),

    /*
     * 天气。
     *
     * ⚠️⚠️ 2026-10-12 他报的：「AI 无法调用天气接口」。
     *    查下来不是接口坏了（实测郴州两条接口都 200），是**新工程压根没写**
     *    —— 重写的时候天气整块没搬过来，设置页那 5 项一直标着「待接」。
     *
     * ⚠️ 这个块**只读缓存、绝不发请求**（`weather.buildBlock` 走 `cachedText`）。
     *    提示词总装是在她说每一句话之前跑的，这里要是同步去网上拉，
     *    网络一抖她整个人就卡住 —— 旧工程 O07「查天气挪后台线程」
     *    就是被这个坑出来的。真去查的时机只有两个：
     *      · 他主动问天气（`refreshIfAsked`，在她说之前先查好）
     *      · 到点后台刷（还没接，见挂账）
     */
    weatherBlock(),

    /*
     * 联网刚查到的资料。
     * ⚠️ 放在天气后面、情绪前面 —— 它是"事实"，跟天气一类（离正文远一点，
     *    免得她开口就报新闻）；情绪还是留在最后影响语气。
     * ⚠️ 只有"这次真的查到了"才会出现（查不到 / 过了保鲜期都是空）。
     */
    safeBlock('联网', () => websearch.buildBlock()),

    /*
     * 她刚看一眼屏幕看到的（识屏）。
     * ⚠️ 放联网后面、情绪前面 —— 跟联网一样是"事实"，离正文远一点；
     *    而且提示词里已经写了"别主动说'我刚看了你屏幕'"（那听着像监视）。
     * ⚠️ 识屏关着 / 没看过 / 过了保鲜期 → 这一块整个不出现。
     */
    safeBlock('识屏', () => { const p = peekerMod(); return p && p.buildBlock ? p.buildBlock() : ''; }),

    // ★ 情绪放**最后**（离正文最近）—— 见上面那段的顺序说明
    safeBlock('情绪', () => mood.buildBlock()),

    timeBlock(o.now || new Date()),
  ];

  // 空块整个不出现 —— 不留空标题，也不留连续空行
  return parts.filter((x) => x && x.trim()).join(T.GAP);
}

module.exports = {
  PERSONA_DIR, DEFAULT_PERSONA,
  readPersona, buildSystem,
  personaBlock, timeBlock, relationBlock,
};
