/**
 * 输入保存的「去抖 + 串行队列」—— 一个不碰 DOM 的小工具
 *
 * 为什么要有它（外部审查 YCH-009，2026-10-21）：
 *
 *   设置页那三行（接口地址 / API Key / 模型）挂的是 `input` 事件 —— 他每敲**一个字符**
 *   就 `providers:save` 一次。于是：
 *     · 打一个 32 位的 Key = 32 次 IPC + 32 次写盘；
 *     · 更要命的是**乱序**：每个请求各自异步，旧的那个晚回来就会把新值盖掉
 *       （他看到的输入框和盘上的值对不上，下次启动才知道"怎么变回去了"）。
 *
 *   所以这里做两件事：
 *     ① **去抖**：停手 `gap` 毫秒才真发一次（连打 10 个字只发 1 次）；
 *     ② **串行**：同一个 key 永远只有一条在飞；飞着的时候新值只更新"待发"，
 *        等它回来再发**最新的那个** —— 既不会并发、也不会覆盖。
 *
 *   ⚠️ 刻意不依赖 DOM：这样它能被纯 node 自检直接测（`tests/unit/savequeue.test.cjs`），
 *      不用起窗口。界面层只是它的调用方。
 *
 * @param {object} o
 * @param {number} [o.gap=300] 停手多久才发
 * @param {(key:string, payload:any, version:number)=>Promise<any>} o.send 真正发出去的那一步
 */
export function makeSaveQueue({ gap = 300, send } = {}) {
  if (typeof send !== 'function') throw new Error('makeSaveQueue 需要一个 send');

  /** key -> 最新一次待发的 { payload, version } */
  const latest = new Map();
  /** key -> 去抖定时器 */
  const timers = new Map();
  /** key -> 正在飞的那个 Promise */
  const inflight = new Map();
  let version = 0;
  let sent = 0;          // 发出去几次（自检要看）
  let dropped = 0;       // 因为"更新的一版已经在那了"而没发的次数

  function clearTimer(key) {
    const t = timers.get(key);
    if (t) { clearTimeout(t); timers.delete(key); }
  }

  /** 把这个 key 的待发值泵出去；已经有一条在飞就等它回来自己接着泵 */
  function pump(key) {
    const flying = inflight.get(key);
    if (flying) { dropped++; return flying; }

    const job = latest.get(key);
    if (!job) return Promise.resolve();

    latest.delete(key);
    sent++;
    const p = Promise.resolve()
      .then(() => send(key, job.payload, job.version))
      /* ⚠️ 发失败不能把队列卡死 —— 清掉在飞标记，下一版还能发 */
      .catch(() => {})
      .then(() => {
        inflight.delete(key);
        if (latest.has(key)) return pump(key);   // 期间又改了 → 接着发最新的
        return undefined;
      });
    inflight.set(key, p);
    return p;
  }

  return {
    /** 他敲了一下：只更新待发值，重置去抖计时 */
    push(key, payload) {
      version++;
      latest.set(key, { payload, version });
      clearTimer(key);
      timers.set(key, setTimeout(() => { timers.delete(key); pump(key); }, gap));
    },

    /** 立刻把某个 key 的待发值发出去（切预设 / 关面板之前用） */
    flush(key) {
      clearTimer(key);
      return pump(key);
    },

    /** 把所有待发值立刻发出去，并且等到真的发完（切预设之前必须等） */
    async flushAll() {
      for (const k of [...timers.keys()]) clearTimer(k);
      await Promise.all([...latest.keys()].map((k) => pump(k)));
      await Promise.all([...inflight.values()]);
    },

    /** 丢掉还没发的（关窗口了、反正下次打开会重读） */
    cancelAll() {
      for (const k of [...timers.keys()]) clearTimer(k);
      latest.clear();
    },

    /** 自检用：现在攒着几个、发过几次、因为在飞而跳过几次 */
    stats() {
      return { pending: latest.size, flying: inflight.size, sent, dropped };
    },
  };
}
