/**
 * 口误 —— 偶尔"磕巴"一下：打错一个字，隔一会儿自己改回来。
 *
 * 他 2026-09-26 专门点过名的一条（「让 AI 偶尔打错字再纠正」）。
 *
 * ── ★★ 三条硬红线（旧工程原话，一条都不能破）──────────────────
 *   ① **绝不碰方括号、数字、英文、日文歌词** —— 只挑**汉字**下手
 *   ② **只改气泡上显示的字** ——
 *      聊天记录 / 记忆 / 学习里**永远是正确文本**。
 *      这是全部意义所在：她"手滑"是给人看的，不是真的记错。
 *      所以这个模块**只产出"该显示成什么样"**，绝不回写任何历史。
 *   ③ 默认低频（每条 5%），一个开关就能关掉
 *
 * ── 为什么单独一个文件，而且放在**渲染层** ────────────────
 *   渲染层是按目录服务的（`src/renderer/`），`import "../../core/x.mjs"`
 *   **取不到** —— 那不是 URL 能到的地方。所以纯函数放这儿，
 *   自检那边用 `await import()` 直接读（Node 认 ESM，不用打包）。
 *
 * ── 为什么不是写在 bubble.js 里 ──────────────────────────
 *   这堆判断（挑哪儿下手、安不安全）**纯是字符串活**，跟 DOM 没关系。
 *   放在渲染层里就没法自检了 —— 而"挑到方括号里下手"这种错
 *   **在界面上根本看不出来**（她只是偶尔把一个标记打错了，
 *   而标记本来就看不见）。所以抽出来，让自检钉死。
 *
 * @param {string} text 她要说的正确文本
 * @param {function} [rand] 注入随机源（自检用；默认 Math.random）
 */

'use strict';

/** 常见手滑对：左 = 对的，右 = 打错的 */
const PAIRS = {
  '在': '再', '再': '在', '的': '得', '得': '的', '他': '她', '她': '他',
  '做': '作', '作': '做', '吗': '嘛', '嘛': '吗', '呢': '呐', '呐': '呢',
  '那': '哪', '哪': '那', '吧': '罢', '到': '倒', '倒': '到', '话': '画',
  '已经': '己经', '自己': '自已', '因为': '因位', '什么': '什吗',
  '现在': '显在', '喜欢': '喜观', '应该': '因该', '知道': '知到',
};

/** 只认汉字（CJK 基本区） */
function isHan(ch) {
  const c = ch.codePointAt(0);
  return c >= 0x4E00 && c <= 0x9FA5;
}

/**
 * 这个位置能不能下手。
 *
 * ⚠️ 括号那两条最关键：`[心情 好]` / `【目标】` 里的字一个都不许动。
 *    判据是"往前看，最后一个 `[` 比 `]` 靠后" = 我们正待在方括号里面。
 */
function safeSite(text, index, len) {
  if (index < 0 || index + len > text.length) return false;
  for (const ch of text.slice(index, index + len)) if (!isHan(ch)) return false;

  const left = text.slice(0, index);
  if (left.lastIndexOf('[') > left.lastIndexOf(']')) return false;
  if (left.lastIndexOf('【') > left.lastIndexOf('】')) return false;
  return true;
}

/**
 * 挑一处"手滑"。
 * @returns {{index:number, len:number, wrong:string, good:string}|null}
 */
function pickEdit(text, rand = Math.random) {
  const s = String(text || '');
  if (s.length < 4) return null;          // 太短了，改一个字就面目全非

  const cands = [];

  // ① 常见手滑对
  for (const good of Object.keys(PAIRS)) {
    let from = 0;
    while (cands.length < 40) {
      const i = s.indexOf(good, from);
      if (i < 0) break;
      if (safeSite(s, i, good.length)) {
        cands.push({ index: i, len: good.length, wrong: PAIRS[good], good });
      }
      from = i + 1;
    }
  }

  // ② 没命中就兜底：把相邻两个字调个顺序（也像手滑）
  if (!cands.length) {
    for (let i = 0; i < s.length - 1; i++) {
      if (!safeSite(s, i, 2)) continue;
      const a = s[i], b = s[i + 1];
      if (a === b) continue;
      cands.push({ index: i, len: 2, wrong: b + a, good: a + b });
      if (cands.length >= 60) break;
    }
  }

  if (!cands.length) return null;
  return cands[Math.floor(rand() * cands.length)];
}

/**
 * 这一条回复要不要磕巴。
 * @returns {{rate:number, hit:boolean, edit:object|null, holdMs:number}}
 */
function roll(text, cfg = {}, rand = Math.random) {
  const on = cfg.typo !== false;
  const rate = Math.max(0, Math.min(100, Number(cfg.typoRate ?? 5) || 0));

  const out = { rate, hit: false, edit: null, holdMs: 0 };
  if (!on || rate <= 0) return out;
  if (rand() * 100 >= rate) return out;          // 没掷中

  const edit = pickEdit(text, rand);
  if (!edit) return out;                          // 没地方下手（比如整句都是数字和英文）

  /*
   * 停留多久再改回来。
   * ⚠️ 夹 [200, 5000]：填成 0 的话她"打错立刻改"，看着像抽搐；
   *    填成 60000 的话那个错字会挂在那儿一分钟，看着像坏了。
   */
  let hold = Number(cfg.typoHoldMs ?? 800);
  if (!Number.isFinite(hold) || hold < 200) hold = 800;
  hold = Math.min(5000, hold);

  out.hit = true;
  out.edit = edit;
  // ★ 800~1200 毫秒之间随机一下 —— 每次都一模一样的话像定时器，不像人
  out.holdMs = hold + Math.floor(rand() * 400);
  return out;
}

/** 把那一处换成打错的版本（给渲染层用） */
function applyEdit(text, edit) {
  if (!edit) return String(text || '');
  const s = String(text || '');
  return s.slice(0, edit.index) + edit.wrong + s.slice(edit.index + edit.len);
}

export { PAIRS, isHan, safeSite, pickEdit, roll, applyEdit };
