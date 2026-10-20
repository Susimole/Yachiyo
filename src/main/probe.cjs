/**
 * 只给探针开的那些口子（2026-10-21 从 `main/index.cjs` 搬出来的，洗澡 ⑥ 第三刀）。
 *
 * 七个 IPC：`design:load/put/clear/save`（界面调试台）+ `probe:sleep` +
 * `ov:probe-raise` / `ov:probe-bounds` + `probe:tray-toggle` / `probe:game`。
 *
 * ⚠️ **全部套在 `devOnly()` 里** —— 正式版（`app.isPackaged`）一个都不注册。
 *    这是刻意的：它们是"为了不改产品代码就能量到真实行为"的临时口子，
 *    不能让它们在用户的正式版里活着。
 *
 * ⚠️ 依赖主进程的活状态（`win` 会被重建、`trayApi` 在别处定义），
 *    所以这里不 import 任何东西 —— 全部由 `register(ctx)` 注入。
 *    `win` 特别用了 `getWin()`：注册那一刻它可能还是 null。
 */

function registerProbes(ctx) {
  const {
    ipcMain, devOnly, overlay, review, probeBoundsLog, trayApi, getWin,
    design: { readDesign, writeDesign, designClear, designSave, DESIGN_FILE },
  } = ctx;

devOnly(() => {
  ipcMain.handle('design:load', () => readDesign());
  ipcMain.handle('design:put', (_e, data) => writeDesign(data && typeof data === 'object' ? data : {}));
  ipcMain.handle('design:clear', designClear);
  ipcMain.handle('design:where', () => DESIGN_FILE());
});

devOnly(() => ipcMain.handle('design:save', designSave));

devOnly(() => ipcMain.handle('probe:sleep', (_e, on) => {
  // `on` 给 null 就是**纯查询**，不改状态（探针要分开问"设成功没"和"现在什么状态"）
  if (on === null || on === undefined) return review.isSleeping();
  review._setSleeping(!!on);
  // 立刻把状态推给页面 —— 不然要等下一拍心跳（5 秒）才生效，探针得干等
  overlay.broadcast('sleep:changed', review.isSleeping());
  return review.isSleeping();
}));

devOnly(() => ipcMain.handle('ov:probe-raise', (_e, kind, afterHwnd) => {
  const w = overlay.list().get(kind);
  if (!w || w.isDestroyed()) return { ok: false, why: '窗口不在' };
  const raw = afterHwnd ? parseInt(String(afterHwnd), 10) : 0;
  if (raw) {
    // `insertAfter` 第二参要的是 NodeBuffer / number hwnd
    const Buffer = require('node:buffer').Buffer;
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(BigInt(raw));
    try { w.insertAfter(buf); } catch (err) { return { ok: false, why: err.message }; }
  } else {
    try { w.moveTop(); } catch (err) { return { ok: false, why: err.message }; }
  }
  return { ok: true };
}));

devOnly(() => ipcMain.handle('ov:probe-bounds', (_e, kind, on) => {
  const w = overlay.list().get(kind);
  if (!w || w.isDestroyed()) return { ok: false, why: '窗口不在' };
  if (on === false) { w.__probeBounds = false; return { ok: true, log: probeBoundsLog.get(kind) || [] }; }

  probeBoundsLog.set(kind, []);
  const orig = w.setBounds.bind(w);
  w.setBounds = (b, ...rest) => {
    const from = w.getBounds();
    const r = orig(b, ...rest);
    const to = w.getBounds();
    if (from.x !== to.x || from.y !== to.y || from.width !== to.width || from.height !== to.height) {
      const log = probeBoundsLog.get(kind) || [];
      log.push({ t: Date.now(), from: { x: from.x, y: from.y, w: from.width, h: from.height },
                 to: { x: to.x, y: to.y, w: to.width, h: to.height } });
      probeBoundsLog.set(kind, log);
    }
    return r;
  };
  return { ok: true };
}));

devOnly(() => ipcMain.handle('probe:tray-toggle', () => {
  trayApi.toggleShow();
  return { visible: !!(getWin() && !getWin().isDestroyed() && getWin().isVisible()) };
}));

devOnly(() => ipcMain.handle('probe:game', (_e, on) => {
  overlay.broadcast('game:changed', { on: !!on, why: '探针' });
  return { sent: !!on };
}));
};

module.exports = { register: registerProbes };
