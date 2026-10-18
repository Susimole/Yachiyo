/**
 * `rig.json` 的读写 —— 只做一件事：**把五个姿态的倾斜角存回去**。
 *
 * ⚠️⚠️ 为什么倾斜角存在 `rig.json` 而**不是** `config.json`：
 *
 *     `rig.json` 里的 `presets` 就是**每个姿态那套参数的唯一真源**
 *     （待机 -2 / 走路 1 / 跑 5 / 坐 -6 / 睡 0，都是当年在调试台上调出来的）。
 *     倾斜角本来就是其中一个参数（老调试台那个「前倾角」滑块）。
 *
 *     要是在 `config.json` 里再存一份"用户覆盖值"，就变成**两处都在管同一件事** ——
 *     以后调试台改了预置、设置面板的覆盖值还是旧的，两边对不上，
 *     而且要 debug「到底哪个生效」得翻两个文件。
 *
 *     ⇒ 所以：**设置面板直接改 `rig.json`**。
 *       调试台、设置面板、引擎，三边看到的永远是同一个数。
 *
 * ⚠️ 写之前**先备份**（`rig.json.bak-tilt`）—— 这个文件里还有整套骨架参数，
 *    写坏了整个立绘就散了，那不是"重调一下"能救回来的。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE = path.join(__dirname, '..', 'renderer', 'assets', 'rig', 'rig.json');
const BAK = FILE + '.bak-tilt';

/** 五个可调倾斜的姿态 —— 显示名跟设置面板、`gait.js` 里的 mode 一一对应 */
const POSES = [
  { mode: 'idle', preset: 'idle', label: '待机' },
  { mode: 'walk', preset: 'walk', label: '走路' },
  { mode: 'run', preset: 'run', label: '跑动' },
  { mode: 'sit', preset: 'sit', label: '坐下' },
  { mode: 'sleep', preset: 'sleep', label: '睡觉' },
];

function read() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (err) {
    console.error('[rigparams] rig.json 读不了：' + err.message);
    return null;
  }
}

/**
 * 读出五个姿态当前的倾斜角。
 * @returns {object} `{ idle: -2, walk: 1, run: 5, sit: -6, sleep: 0 }`
 *                  读不到 / 某项缺 → 落到 `defaults.lean`
 */
function tilts() {
  const d = read();
  if (!d) return {};
  const def = Number(d.defaults && d.defaults.lean) || 0;
  const out = {};
  for (const p of POSES) {
    const v = d.presets && d.presets[p.preset] && d.presets[p.preset].lean;
    out[p.mode] = Number.isFinite(Number(v)) ? Number(v) : def;
  }
  return out;
}

/**
 * 改其中几个姿态的倾斜角。
 *
 * @param {object} patch `{ sit: -4, walk: 0 }` 这种（只给要改的）
 * @returns {{ok:boolean, why:string, tilts:object}}
 */
function setTilts(patch = {}) {
  const d = read();
  if (!d) return { ok: false, why: 'rig.json 读不了', tilts: {} };
  /*
   * ⚠️ 给 presets 兜个底（2026-10-16 修的）—— 他手改 rig.json 时把 presets
   *    整段删掉/写坏的话，下面 `d.presets[p.preset]` 会当场抛
   *    「Cannot read properties of undefined」（实测）。
   *    注意只兜这一层：该不该写回去是 `read()` 的事，这里不动文件。
   */
  if (!d.presets || typeof d.presets !== 'object') d.presets = {};

  const valid = new Set(POSES.map((p) => p.mode));
  const changes = [];
  for (const [mode, raw] of Object.entries(patch)) {
    if (!valid.has(mode)) continue;
    const v = Number(raw);
    if (!Number.isFinite(v)) continue;
    const clamped = Math.max(-10, Math.min(10, Math.round(v * 10) / 10));
    const p = POSES.find((x) => x.mode === mode);
    if (!d.presets[p.preset]) d.presets[p.preset] = {};
    if (Number(d.presets[p.preset].lean) !== clamped) {
      changes.push(`${mode} ${d.presets[p.preset].lean} → ${clamped}`);
      d.presets[p.preset].lean = clamped;
    }
  }
  if (!changes.length) return { ok: true, why: '', tilts: tilts() };

  // ★ 先备份再写 —— 这个文件写坏了整套立绘就散了
  try {
    if (!fs.existsSync(BAK)) fs.copyFileSync(FILE, BAK);
  } catch (err) {
    console.error('[rigparams] 备份失败（还是要写）：' + err.message);
  }

  try {
    // ⚠️ 缩进 2 格 —— 他会自己打开看，也是一直以来的格式
    fs.writeFileSync(FILE, JSON.stringify(d, null, 2) + '\n', 'utf8');
  } catch (err) {
    return { ok: false, why: '写不进去：' + err.message, tilts: tilts() };
  }

  console.log('[rigparams] 倾斜角改了：' + changes.join('，'));
  return { ok: true, why: '', tilts: tilts() };
}

module.exports = { FILE, POSES, tilts, setTilts, read };
