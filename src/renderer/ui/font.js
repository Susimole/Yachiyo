/**
 * 界面字体 —— 五个窗口共用这一份。
 *
 * 他 2026-10-12 要的：「增加字体更换项（现在用的默认字体保留，增加一个预设）」。
 *
 * ⚠️⚠️ 为什么不写 `@font-face { src: url('./assets/fonts/x.ttf') }`：
 *
 *     **file:// 下 Chromium 会把字体加载拒掉**。我实测过 ——
 *     `document.fonts` 报 `ZXFYunYuan: error`、`check()` 全程 false、
 *     两行文字宽度一模一样（说明根本没换成），而且**一声不吭**。
 *
 *     根因：字体的请求是 CORS 模式的，而 file:// 是不透明源，
 *     自己加载自己也得过 CORS，过不了。
 *
 *     ⇒ 走主进程：`font:bytes` 把文件读成字节递过来，
 *       这边 `new FontFace(名, ArrayBuffer)` 手搓一个加进 document.fonts。
 *       ArrayBuffer 来源的 FontFace **不发起任何 fetch**，CORS 无从谈起。
 *
 * ⚠️ 注册用的族名固定成 `YachiyoUI`，不跟着文件名走 ——
 *    CSS 里那句 `--font-ui` 要是个稳定值，不然一切换字体就得重算一遍样式表。
 */

/** 默认那套（原来就写死在 style.css / overlay.css 里的） */
export const DEFAULT_STACK = '"Microsoft YaHei UI","Microsoft YaHei",system-ui,sans-serif';

/** 用户字体的注册名 —— 固定的，见文件头 */
const FAMILY = 'YachiyoUI';

/** 已经把哪个文件注册进来了（切字体时用来判断要不要重新读字节） */
let loadedFile = null;
/** 正在加载的那个 Promise，以及**它对应哪个文件** —— 见下面并发那一段 */
let loading = null;
let loadingFile = null;
/** 已经加进 document.fonts 的那一个 face —— 切字体时要把旧的摘掉 */
let curFace = null;

/**
 * 按配置把界面字体落到 `--font-ui` 上。
 *
 * @param {object} cfg 配置对象（页面本地那份就行）
 * @returns {Promise<{ok:boolean, file:string, error?:string}>}
 */
export async function applyFont(cfg) {
  const file = String((cfg && cfg.fontFamily) || '').trim();

  // 没选 = 系统默认
  if (!file) {
    document.documentElement.style.setProperty('--font-ui', DEFAULT_STACK);
    return { ok: true, file: '' };
  }

  // 已经注册过同一个了，只把变量指过去
  if (loadedFile === file) {
    document.documentElement.style.setProperty('--font-ui', `"${FAMILY}",${DEFAULT_STACK}`);
    return { ok: true, file };
  }

  /*
   * 并发调用时共用同一次加载（三个窗口 + 主题切换会同时叫）。
   *
   * ⚠️ 这里原来写的是 `if (loading === file)` —— **恒不成立**：
   *    `loading` 装的是**一个 Promise**（见下面 `loading = job`），
   *    `file` 是个字符串。所以这个去重从来没生效过，
   *    快速切字体时会真的并发读两遍字节、注册两个 face。
   *    （2026-10-16 修的：另存一个 `loadingFile` 来比。）
   */
  if (loading && loadingFile === file) { await loading; return applyFont(cfg); }

  const job = (async () => {
    const r = await window.yachiyo.font.bytes(file);
    if (!r || !r.ok) throw new Error((r && r.error) || '读不到字体');
    // ⚠️ IPC 回来的是 Uint8Array（结构化克隆），FontFace 也吃它；
    //    但显式取一下 buffer 更稳，某些 Electron 版本给的是裸 Buffer
    const ff = new FontFace(FAMILY, r.bytes.buffer ?? r.bytes);
    await ff.load();
    /*
     * ⚠️ 加新的之前先把**上一个摘掉**（2026-10-16 加的）。
     *    注册用的族名是固定的 `YachiyoUI`（见文件头），不摘的话
     *    document.fonts 里会攒下一堆**同名**的 face —— 而且全文件
     *    从来没有任何一处 `delete` 过。来回切几次就一直往上堆。
     *    摘失败就算了（可能压根没加进去），别让切字体挂在这儿。
     */
    if (curFace) { try { document.fonts.delete(curFace); } catch { /* 不在集合里 */ } }
    document.fonts.add(ff);
    curFace = ff;
    return file;
  })();

  loading = job;
  loadingFile = file;
  try {
    await job;
    loadedFile = file;
    document.documentElement.style.setProperty('--font-ui', `"${FAMILY}",${DEFAULT_STACK}`);
    return { ok: true, file };
  } catch (err) {
    /*
     * ⚠️ 失败要**退回默认字体**，不能把 --font-ui 指到一个不存在的族上 ——
     *    那样浏览器会拿 serif 兜底，整个界面变成宋体，比不改还难看。
     */
    loadedFile = null;
    document.documentElement.style.setProperty('--font-ui', DEFAULT_STACK);
    return { ok: false, file, error: err.message };
  } finally {
    loading = null;
    loadingFile = null;
  }
}

/** 自检要量「字体到底换没换」—— 拿两行同样文字的宽度比 */
export function fontState() {
  return {
    family: getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim(),
    loaded: loadedFile,
    registered: [...document.fonts].map((f) => `${f.family}:${f.status}`),
    has: document.fonts.check(`16px ${FAMILY}`),
  };
}
