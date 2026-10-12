/**
 * 托盘 —— 图标 + 右键菜单。
 *
 * 托盘菜单和桌面右键菜单是同一套开关的两个入口，改文案时两边一起看，
 * 别在托盘里写「静音」、桌面里写「音效」。
 */
'use strict';

const path = require('node:path');
const { Tray, Menu, nativeImage } = require('electron');

let tray = null;

/**
 * ⚠️ 2026-10-12 他给的：`C:\Users\Susim\Desktop\Yachiyo_icon.ico`，
 *    要求「能用到 icon 的地方都用它」。已经拷进 assets/icon.ico。
 *
 *    为什么托盘用 .ico 而不是 .png：
 *    Windows 托盘图标是**多尺寸**的（16/20/24/32…，125% 缩放下常用 20 或 24）。
 *    .ico 里自带好几档，系统直接挑最合适的那张；
 *    单张 png 由系统缩，小尺寸下会糊。
 */
function iconPath() {
  return path.join(__dirname, '..', 'renderer', 'assets', 'icon.ico');
}

/**
 * @param {object} cfg  core/config.cjs
 * @param {object} api  { toggleShow, set, openSettings, openChat, quit }
 */
function create(cfg, api) {
  const img = nativeImage.createFromPath(iconPath());
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img);
  tray.setToolTip('八千代');
  tray.on('click', () => api.toggleShow());
  refresh(cfg, api);
  return tray;
}

function refresh(cfg, api) {
  if (!tray) return;
  const c = cfg.all();

  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: c.petVisible === false ? '显示八千代' : '隐藏八千代',
      click: () => api.toggleShow(),
    },
    { type: 'separator' },
    {
      label: '音效',
      type: 'checkbox',
      checked: !!c.sound,
      click: (item) => api.set('sound', item.checked),
    },
    {
      label: '夜间模式',
      type: 'checkbox',
      checked: c.theme === 'dark',
      click: (item) => api.set('theme', item.checked ? 'dark' : 'light'),
    },
    {
      label: '桌宠移动',
      type: 'checkbox',
      checked: !!c.moveEnabled,
      click: (item) => api.set('moveEnabled', item.checked),
    },
    { type: 'separator' },
    { label: '聊天…',   click: () => api.openChat() },
    { label: '设置…',   click: () => api.openSettings() },
    { type: 'separator' },
    { label: '退出',    click: () => api.quit() },
  ]));
}

function destroy() {
  if (tray) { tray.destroy(); tray = null; }
}

module.exports = { create, refresh, destroy, iconPath };
