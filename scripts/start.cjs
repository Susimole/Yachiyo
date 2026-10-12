/**
 * 启动 Yachiyo。
 *
 * 为什么不直接写 "electron ." 而要包一层：
 *
 * 开发环境（Cherry Studio 的工具链）注入了两个环境变量：
 *     ELECTRON_RUN_AS_NODE=1
 *     ELECTRON_NO_ATTACH_CONSOLE=1
 *
 * 第一个是致命的 —— 它一存在，electron.exe 会把自己当成 node 用：
 *     require('electron')   → 返回的是 exe 的路径字符串，不是 API 对象
 *     process.type          → undefined（正常主进程是 'browser'）
 *     app / BrowserWindow / ipcMain 全是 undefined → 主进程第一行就炸
 *
 * 症状特别难认：报错停在 `ipcMain.on(...)` 上，看着像代码写错了。
 *
 * 普通用户不会遇到（这不是 Electron 的问题，是 Cherry 的工具链习惯用
 * Electron 二进制当 Node 使）。但我们的开发机天天跑在它下面，所以在进程
 * 创建时显式摘掉，而不是靠命令行 `set X=` —— 那样很容易踩到
 * 「set X= 后面的空格被当成值」的坑（空格字符串在 JS 里是真值，照样触发）。
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

// 纯 Node 环境下，这拿到的是 electron.exe 的绝对路径 —— 正是我们要的
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;

const appRoot = path.join(__dirname, '..');

/*
 * 调试端口 —— 设了 YACHIYO_CDP=9222 就开。
 *
 * 开了之后外面能用 CDP 连进渲染进程，一边执行 JS 一边截图：
 * 点菜单、翻设置页、量 DOM 尺寸、看运行时报错，全靠它。
 * 不然验证只能靠「每次改完手动启动看一眼」，太慢也太容易漏。
 *
 * ⚠️ 参数必须排在 appRoot 【前面】—— 排在后面 Electron 会把它当成
 *    传给应用自己的 argv，调试端口根本不会开（而且不报错）。
 */
const extra = [];
if (process.env.YACHIYO_CDP) {
  extra.push(`--remote-debugging-port=${process.env.YACHIYO_CDP}`);
}

const child = spawn(electronPath, [...extra, appRoot, ...process.argv.slice(2)], {
  stdio: 'inherit',
  windowsHide: false,
  env,
});

child.on('close', (code, signal) => {
  if (signal) {
    console.error('[start] Electron 被信号结束:', signal);
    process.exit(1);
  }
  process.exit(code ?? 0);
});
