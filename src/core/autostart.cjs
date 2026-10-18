/**
 * 开机自启 —— 往注册表写一条"开机把她拉起来"。
 *
 * ── 为什么走注册表，不用 Electron 自带的 ──────────────────
 *   `app.setLoginItemSettings()` **打包成 exe 之后才认**（它写的是
 *   exe 自己的路径）。开发期跑源码的话它写进去的是 electron.exe、
 *   却**不带工程路径** —— 开机只会弹出一个空白的 Electron。
 *   所以在开发期它给不出一个"能用的"自启项，等于没做。
 *
 *   注册表 `HKCU\...\Run` 是**同一条路的两头都能用**：
 *     · 开发期：`"…\electron.exe" "D:\AI_work\Git"`
 *     · 打包后：`"…\Yachiyo.exe"`
 *   而且**不需要管理员权限**（HKCU 就是当前用户）。
 *
 * ── 旧工程是怎么做的（对照，别混）──────────────────────────
 *   旧工程用的是**任务计划程序** + 一个 `start-delayed.vbs`（延迟 30 秒）。
 *   为什么不用 VBS：本机有个安全层会把"内容可疑"的脚本文件清掉
 *   （实测 VBS + `WScript.Shell` + 隐藏窗口 会被整个删掉）。
 *   新工程是 Electron，**进程本身就够重量了**，而且她起来之后
 *   本来就有 8 秒的备份延迟之类的软启动，不需要再靠 VBS 拖时间。
 *   ⇒ 所以这里不用任务计划、也不用 VBS，直接一条 Run 项。
 *
 * ⚠️ 只在**用户点头**（设置里勾上）的时候写。写之前先读一遍，
 *    值一样就什么都不做 —— 别每次启动都刷一次注册表。
 */

'use strict';

const { execFileSync } = require('node:child_process');
const log = require('./log.cjs');

/** Run 项的名字（注册表里显示的就是它） */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'YachiyoPet';

/**
 * 该往注册表里写的那条命令。
 *
 * ⚠️ 两个路径**都要加引号** —— Program Files 之类的路径里有空格，
 *    不加引号的话 Windows 会在空格处断开，把后半截当成参数。
 *
 * ⚠️⚠️ **工程目录必须由调用方传进来，绝不能读 `process.argv[1]`。**
 *    2026-10-13 探针实测抓到的：带命令行开关启动时（`electron --some-flag .`），
 *    `argv[1]` 拿到的是**那个开关**，不是工程目录 —— 写进注册表就成了
 *      `"…\electron.exe" "--remote-debugging-port=9348"`
 *    开机跑这条：electron 找不到 app，**弹一个空白窗口**就完了，
 *    而且不报错、不写日志，看着像"自启没生效"。
 *    主进程那边传 `app.getAppPath()`（Electron 自己算的，稳）。
 *
 * @param {string} [appDir] 打包后传空（那时 exe 自己就是全部）
 */
function command(appDir) {
  const exe = process.execPath;
  const dir = String(appDir || '').trim();
  // ⚠️ 就算传进来了，也得是个真实存在的目录 —— 不然还不如不写
  const okDir = dir && (() => { try { return require('node:fs').statSync(dir).isDirectory(); } catch { return false; } })();
  return okDir ? `"${exe}" "${dir}"` : `"${exe}"`;
}

function reg(args) {
  return execFileSync('reg.exe', args, { encoding: 'utf8', windowsHide: true });
}

/** 现在注册表里那条是什么（没有就返回 ''） */
function read() {
  if (process.platform !== 'win32') return '';
  try {
    const out = reg(['query', RUN_KEY, '/v', RUN_NAME]);
    // 输出形如：`    YachiyoPet    REG_SZ    "C:\...\electron.exe" "D:\AI_work\Git"`
    const m = out.split(/\r?\n/).find((l) => l.includes(RUN_NAME));
    if (!m) return '';
    const parts = m.trim().split(/\s{2,}/);
    return parts.length >= 3 ? parts.slice(2).join('  ').trim() : '';
  } catch {
    // ⚠️ 查不到（项不存在）reg.exe 会**返回非 0**，那是正常情况不是错误
    return '';
  }
}

/**
 * 打开 / 关掉自启。
 * @param {boolean} on
 * @returns {{ok:boolean, why:string, value:string}}
 */
function set(on, appDir) {
  if (process.platform !== 'win32') {
    return { ok: false, why: '只有 Windows 上有这道', value: '' };
  }
  const want = command(appDir);
  const cur = read();

  try {
    if (on) {
      if (cur === want) return { ok: true, why: '本来就是这条，没动', value: cur };
      reg(['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', want, '/f']);
      log.info('自启', `打开：${want}`);
      return { ok: true, why: '', value: want };
    }
    if (!cur) return { ok: true, why: '本来就没开', value: '' };
    reg(['delete', RUN_KEY, '/v', RUN_NAME, '/f']);
    log.info('自启', '关掉了');
    return { ok: true, why: '', value: '' };
  } catch (err) {
    log.error('自启', `写注册表失败：${err.message}`);
    return { ok: false, why: err.message, value: cur };
  }
}

/**
 * 启动时对账 —— 设置里勾着但注册表里没有（比如换了电脑 / 挪了目录）→ 补上。
 * ⚠️ **只补不改**：设置里没勾、注册表里却有（他手动加的）→ 不动它。
 *    那是他的东西，不该被程序悄悄删掉。
 */
function sync(enabled, appDir) {
  if (process.platform !== 'win32') return { ok: true, why: '非 Windows，跳过' };
  if (enabled === false) return { ok: true, why: '设置里没开' };
  const want = command(appDir);
  const cur = read();
  if (cur === want) return { ok: true, why: '已经是对的' };

  /*
   * ⚠️ 值不一样时，要分清「这条是**我们自己写的旧路径**」还是「他手动加的」
   *    （2026-10-16 修的）。
   *
   *    原来一律落进"不是我们写的，不碰"那一支 ⇒ **挪了目录也永远不修**：
   *      ① 他先 `npm start` → 写进去的是 `electron.exe D:\AI_work\Git`
   *      ② 之后装打包版 → want 变成 `Yachiyo.exe <安装目录>`，而旧的 cur 还在
   *      ③ ⇒ 开机启的还是**旧路径**，而文件头写的却是"挪了目录会自动补上"。
   *    （这台机器的注册表现在就正好是那个开发版路径，实测过。）
   *
   *    认领的判据：整条里出现过**我们的可执行文件名**。
   *    ⚠️ 认领之后才覆盖；真不是我们的一律不碰 —— 文件头那条规矩没变。
   */
  if (cur && isOurs(cur)) {
    const r = set(true, appDir);
    if (r.ok) log.info('自启', `发现旧路径，已改成：${want}`);
    return r;
  }
  if (cur) return { ok: true, why: '注册表里那条不是我们写的，不碰' };
  return set(true, appDir);
}

/**
 * 注册表里那一条是不是**我们自己写的**。
 * ⚠️ 键名（`YachiyoPet`）本来就是我们专用的，但值是**可以被手改成任意东西**的 ——
 *    所以按"里面有没有我们的可执行文件"来认，不认键名。
 */
function isOurs(value) {
  const v = String(value || '').toLowerCase();
  return v.includes('yachiyo.exe') || v.includes('electron.exe');
}

module.exports = { RUN_KEY, RUN_NAME, command, read, set, sync, _isDev: () => !!process.defaultApp };
