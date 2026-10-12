/**
 * 音效 —— 她身上发生的事发个声。
 *
 * ⚠️ 2026-10-12 他给的素材：`D:\AI工作目录\Yachiyo\assets\noise\叮咚.mp3`，
 *    已经拷进 `src/renderer/assets/sound/叮咚.mp3`（23,252 B）。
 *    搬进工程是为了第 5 步开源化 —— 不能让仓库依赖桌面上那个旧工程目录。
 *
 * ⚠️ 文件名是中文。file:// 下 Chromium 会把非 ASCII 路径百分号编码，
 *    这个没问题（拆件的 `back hair.png` 带空格也是这么过来的）。
 *    但**加载是异步的**：第一次点击如果音频还没解码完，play() 会静默什么都不做。
 *    所以 init 的时候就把两个都 `load()` 上。
 *
 * ⚠️ 不自建 `AudioContext` —— 那玩意儿一旦被创建，Electron 会多开一条音频线程；
 *    而且它受**自动播放策略**管，窗口 `focusable:false` 的时候更麻烦。
 *    `new Audio()` + play() 走的还是同一套策略，但 Electron 的默认
 *    `autoplayPolicy` 就是 `no-user-gesture-required`，实测能响。
 */

/** 名字 → 文件。以后加音效往这儿补一行就行 */
const FILES = {
  click: './assets/sound/叮咚.mp3',
};

/** 每个音效留**两条**备用实例：点得快的时候，一条还在响，另一条立刻接上 */
const POOL = 2;

const pool = new Map();          // name → { list, i }
let getCfg = () => ({ sound: true });

/**
 * 音量（0~1）。
 *
 * ⚠️ **每次都现读配置**，不能只在 init 的时候设一次 ——
 *    他在设置面板里拖音量滑块，已经建好的那些 Audio 实例得跟着变，
 *    不然「拖了半天没反应，重启才生效」。
 * ⚠️ 配置里存的是**百分数**（`soundVolume: 70`），Ui 上看着直观；
 *    这一层负责 ÷100。夹在 0~1 —— 拖出界或者手改配置文件都不至于炸。
 */
function vol() {
  const n = Number(getCfg()?.soundVolume);
  if (!Number.isFinite(n)) return 0.7;
  return Math.max(0, Math.min(1, n / 100));
}

/** 把当前音量刷到所有实例上（设置面板拖滑块时叫它） */
export function applyVolume() {
  for (const p of pool.values()) for (const a of p.list) a.volume = vol();
}

/** 配置的引用要**一直是最新的** —— 设置面板里关掉音效要立刻见效 */
export function initSound(cfgFn) {
  if (typeof cfgFn === 'function') getCfg = cfgFn;

  for (const [name, src] of Object.entries(FILES)) {
    const list = [];
    for (let i = 0; i < POOL; i++) {
      const a = new Audio(src);
      a.preload = 'auto';
      a.volume = vol();
      // ⚠️ 别设 crossorigin —— 本地 file:// 加了这个反而会被拦
      try { a.load(); } catch { /* 加载失败就是没声音，不该影响别的 */ }
      list.push(a);
    }
    pool.set(name, { list, i: 0 });
  }
}

/**
 * 放一声。
 * @param {string} name FILES 里的键，默认 click
 */
export function play(name = 'click') {
  // ⚠️ 判空：配置还没读回来的时候 getCfg() 可能是 undefined，
  //    那种时候按「开」处理 —— 他装完第一次点她，没声音比有声音更像坏了
  if (getCfg()?.sound === false) return;

  const p = pool.get(name);
  if (!p) return;

  const a = p.list[p.i];
  p.i = (p.i + 1) % p.list.length;

  try {
    a.volume = vol();            // 拖过滑块之后立刻按新音量放
    a.currentTime = 0;           // 同一实例连点两次时从头放，而不是「第二次没反应」
    const r = a.play();
    // ⚠️ play() 返回 Promise，被策略挡下来时会 reject —— 必须接住，
    //    不然控制台会刷一屏 unhandled rejection
    if (r && typeof r.catch === 'function') r.catch(() => {});
  } catch { /* 放不出来就算了，别把点击这件事带崩 */ }
}

/** 还没开始播就把音频解码好（自检里用得上：探针要在点之前就读到 duration） */
export function soundStats() {
  const out = {};
  for (const [name, p] of pool) {
    out[name] = p.list.map((a) => ({
      src: a.src.split('/').pop(),
      readyState: a.readyState,      // 4 = HAVE_ENOUGH_DATA
      duration: Number.isFinite(a.duration) ? +a.duration.toFixed(3) : null,
      error: a.error ? a.error.code : null,
      volume: a.volume,
    }));
  }
  return out;
}
