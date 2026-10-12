/**
 * 人物画像的**调度** —— 「什么时候该重写」。
 *
 * ── 为什么要单独一个文件，不塞进 `profile.cjs` ──────────────
 *   `profile.cjs` 是**读写画像本身**的（读、拼块、写盘、备份），
 *   纯数据层，好测、不碰网络调度。
 *   这个文件管的是**节奏**：多久看一次、什么时候真发起、失败了怎么退避。
 *   两者混一起的话，"测画像内容"和"测它多久跑一次"会互相绊住。
 *
 * ── 节奏（照旧工程 Update-AiProfile）────────────────────────
 *   · 心跳每拍都来问一声（她可能几天不关机）
 *   · 但**最多每 6 小时**才去看一次"到没到该重写的日子" ——
 *     不然每 5 秒 stat 一次文件，纯白烧 IO
 *   · `profile.due()` 才算真到期（判据 = 文件 mtime 超过 `profileRefreshDays` 天）
 *   · 发起之后**不阻塞**：心跳那一拍不能等它几十秒
 *
 * ⚠️ 重写**不看「准备睡」** —— 那是"他不在"的安静期，正是重写的好时候。
 *    （回顾链才需要那道闸，因为它会说话。）
 */

'use strict';

const cfg = require('./config.cjs');
const memory = require('./memory.cjs');
const profile = require('./profile.cjs');
const provider = require('./provider.cjs');
const usage = require('./usage.cjs');
const log = require('./log.cjs');

/** 隔这么久才去看一次"到没到日子"（旧工程也是 6 小时） */
const CHECK_EVERY_MS = 6 * 3600000;

let busy = false;
let lastCheck = 0;
let lastError = '';

/**
 * 心跳每拍叫一次。
 * @param {Date} [now]
 * @returns {string} 这一拍做了什么
 */
function tick(now = new Date()) {
  if (cfg.get('profileEnabled') === false) return '画像关着';
  if (busy) return '上一次还在写';
  if (now.getTime() - lastCheck < CHECK_EVERY_MS) return '还没到下次检查的时间';

  lastCheck = now.getTime();          // ⚠️ 先记时间 —— 失败也不该每 5 秒重试

  if (!profile.due(now.getTime())) return '还没到该重写的日子';

  const c = cfg.all();
  if (!c.apiKey) return '还没填 API Key';

  /*
   * 素材 = 「最近发生的事」（跨会话那段）。
   * ⚠️ 拿**裸正文**，不要 `buildSessionBlock()` —— 那个带了
   *    「这是上一次聊天整理出来的背景资料…」这层壳，
   *    那是给**她**看的提醒，不是给"写画像"的素材。
   */
  let recent = '';
  try { recent = String((memory.readSession() || {}).Text || ''); } catch { /* 没有就算了 */ }

  busy = true;
  const t0 = Date.now();
  log.info('画像', `开始重写（素材：近况 ${recent.length} 字）`);

  profile.rewrite({ chat: provider.chat, cfg: c, recent })
    .then((r) => {
      if (r.ok) {
        log.info('画像', `写好了 · ${Date.now() - t0}ms · ${r.chars} 字` +
          (r.backup ? ` · 旧的那份备份在 ${r.backup.split(/[\\/]/).pop()}` : ''));
      } else {
        lastError = r.why || '';
        log.info('画像', '这次没写成：' + r.why);
      }
    })
    .catch((err) => {
      lastError = err.message;
      log.error('画像', '重写出错：' + err.message);
    })
    .finally(() => { busy = false; });

  return '发起重写';
}

/*
 * ⚠️ **画像这趟没记账**，不是漏了 —— 是 `profile.rewrite` 只回
 *    `{text}` 不保证带 `usage`，硬记会往里塞 `undefined`。
 *    旧工程这条也没单独记账。想记的话得先让 `rewrite` 把 usage 传回来，
 *    那是另一件事，别在这儿猜。
 */

module.exports = {
  CHECK_EVERY_MS, tick,
  isBusy: () => busy,
  lastError: () => lastError,
  /** 自检用：把"上次看是什么时候"直接摆到某个时刻（验那 6 小时节流） */
  _setLastCheck(t) { lastCheck = Number(t) || 0; },
  _reset() { busy = false; lastCheck = 0; lastError = ''; },
  _state: () => ({ busy, lastCheck, lastError }),
};
