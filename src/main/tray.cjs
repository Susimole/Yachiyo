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
  /*
   * ⚠️ 左键**什么都不做**（2026-10-17 他定的）。
   *
   *    这里原来挂的是 `tray.on('click', () => api.toggleShow())` ——
   *    单击托盘图标就让她隐藏/显示。他原话：「单击状态栏桌宠图标会隐藏/显示桌宠，
   *    这是刻意的设计吗，我们的桌宠并不需要这个设计」。
   *
   *    是刻意的，但理由不成立：他要看/藏她，右键菜单里第一项就是
   *    「显示八千代 / 隐藏八千代」，而且那一条还会跟着当前状态换字。
   *    两个入口并排摆着，左键那条还**没有提示**（点一下人突然没了），
   *    所以留右键那一条就够，左键保持安静。
   */
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
