/**
 * 主进程 · 字体（2026-10-18 从 index.cjs 里拆出来的第一块）
 *
 * ⚠️⚠️ 为什么要绕这么大一圈从主进程读字节，而不是页面上直接
 *     `@font-face { src: url('./assets/fonts/x.ttf') }`：
 *
 *     实测过 —— **file:// 下 Chromium 直接把字体加载拒了**。
 *     同一次实验里 `document.fonts` 报的是 `ZXFYunYuan: error`，
 *     `document.fonts.check()` 全程 false，两行文字宽度一模一样
 *     （说明根本没换字体），而且**不报错、不弹窗**。
 *
 *     根因：字体请求是 **CORS 模式**的，而 `file://` 是不透明源，
 *     自己加载自己也得过 CORS —— 过不了。
 *
 *     ⇒ 换一条根本不过网络的路径：主进程 `readFileSync` 把字节通过 IPC
 *       递给页面，页面用 `new FontFace(name, bytes)` 手搓一个字体加进去。
 *       ArrayBuffer 来源的 FontFace **不做任何 fetch**，CORS 无从谈起。
 *
 * ⚠️ 文件名要**掐死在这三个后缀**里，而且必须落在 fonts 目录内 ——
 *    这是从「页面」递过来的字符串，不校验就等于开了个任意文件读取的口子。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FONT_EXT = ['.ttf', '.otf', '.ttc'];

/**
 * 把页面递过来的文件名解析成 fonts 目录里的安全绝对路径。
 * @returns {string|null} 不合法 / 不存在 → null
 */
function fontFile(cfg, name) {
  const base = path.basename(String(name || ''));
  if (!FONT_EXT.includes(path.extname(base).toLowerCase())) return null;
  const full = path.join(cfg.FONTS, base);
  if (path.dirname(full) !== cfg.FONTS) return null;      // 双保险：不许跑出去
  return fs.existsSync(full) ? full : null;
}

/**
 * 挂上三个 IPC：
 *   `font:list`  —— 有哪些字体可选（设置面板那行下拉）
 *   `font:bytes` —— 把字体字节递过去（页面拿去 new FontFace）
 *   `font:dir`   —— 字体目录在哪（告诉他往哪儿丢字体）
 *
 * @param {import('electron').IpcMain} ipcMain
 * @param {object} cfg  core/config.cjs
 */
function register(ipcMain, cfg) {
  ipcMain.handle('font:list', () => {
    try {
      if (!fs.existsSync(cfg.FONTS)) return [];
      return fs.readdirSync(cfg.FONTS)
        .filter((f) => FONT_EXT.includes(path.extname(f).toLowerCase()))
        .sort();
    } catch { return []; }
  });

  ipcMain.handle('font:bytes', (_e, name) => {
    const p = fontFile(cfg, name);
    if (!p) return { ok: false, error: '找不到这个字体文件' };
    try {
      return { ok: true, name: path.basename(p), bytes: fs.readFileSync(p) };
    } catch (err) {
      return { ok: false, error: '读不出来：' + err.message };
    }
  });

  ipcMain.handle('font:dir', () => cfg.FONTS);
}

module.exports = { register, fontFile, FONT_EXT };
