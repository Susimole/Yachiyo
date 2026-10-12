/**
 * 骨架引擎 · 纯数学工具
 *
 * 全部与渲染无关，可以在浏览器控制台里单独跑。
 * 出处：规格 §7 —— 弹簧参数表抄自 Coopanion 的 kit/body.js（抄的是**参数**不是代码）。
 *
 * ⚠️ 时间单位混用是这套东西的固有设计，别「顺手统一」：
 *     相位（Ph / PhSit）用 **毫秒**
 *     弹簧和低通用 **秒**（k / c 是按秒标定的）
 */

export const TAU = Math.PI * 2;

export const deg2rad = (d) => (d * Math.PI) / 180;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 二阶弹簧。
 *   V += ((t - X) * K - V * C) * dt
 *   X += V * dt
 *   超过 Lim 就夹断并把速度清零
 */
export class Spring {
  constructor(k, c, lim) {
    this.X = 0;
    this.V = 0;
    this.K = k;
    this.C = c;
    this.Lim = lim;
  }
  step(target, dt) {
    this.V += ((target - this.X) * this.K - this.V * this.C) * dt;
    this.X += this.V * dt;
    if (Math.abs(this.X) > this.Lim) {
      this.X = Math.sign(this.X) * this.Lim;
      this.V = 0;
    }
    return this.X;
  }
  reset() {
    this.X = 0;
    this.V = 0;
  }
}

/**
 * 一阶低通（脚专用）。
 *   kf = 1 - exp(-40 * ks * dt)
 * ks = 0 时直接跟随（kf = 1），也就是完全刚性。
 * 那个 40 是规格里的硬编码常量，不是随手写的。
 */
export function lowpass(cur, target, ks, dt) {
  const kf = ks > 0 ? 1 - Math.exp(-40 * ks * dt) : 1;
  return cur + (target - cur) * kf;
}

/**
 * smoothstep：t²(3-2t)，两头平、中间快。
 * 用在两处：网格形变的权重、步态里「迈得干脆」的那段。
 */
export function smooth(a, b, x) {
  if (b === a) return x < a ? 0 : 1;
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/** 区间随机（闭开），给状态机骰时长/冷却用 */
export function rand(lo, hi) {
  return lo + Math.random() * (hi - lo);
}
