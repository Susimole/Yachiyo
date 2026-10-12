/**
 * 骨架引擎 · 网格形变
 *
 * 出处：规格 §8.2 的 ApplyWarp
 *
 * 两种形变：
 *   kind 1「髋铰链」—— 髋部以下整块绕髋转一点（衣服下摆、腿）
 *   kind 2「头发甩」—— 从发根往下越甩越开（只推水平位移）
 *
 * 它们的权重都只跟 y 有关，所以「整件沿 y 切横条、每条一个仿射」就够了 ——
 * 不用 WebGL，Canvas 2D 的 setTransform 能精确画出来。
 */

import { smooth, deg2rad } from './math.js';

export const WARP_NONE = 0;
export const WARP_HIP = 1;
export const WARP_HAIR = 2;

/**
 * 某个 y 处的形变权重（0~1）。y 是**变换后的全局 y**。
 * @param {number} kind
 * @param {number} y
 * @param {object} cfg  { hipY, hipX, pivotY, restBottom, legAvg, hairR, meshK }
 */
export function warpWeight(kind, y, cfg) {
  if (kind === WARP_HIP) return smooth(cfg.hipY - 10, cfg.hipY + 18, y);
  if (kind === WARP_HAIR) return smooth(cfg.pivotY, cfg.restBottom, y);
  return 0;
}

/**
 * 这一条的形变矩阵，返回 setTransform 的 [a, b, c, d, e, f]。
 *
 *   WARP_HIP ：p' = M·p + t，
 *              线性 = (1−w)·I + w·Rot(a)，平移 = w·(hip − Rot(a)·hip)
 *   WARP_HAIR：纯水平平移 −hairR·0.85·meshK · w²
 *
 * @param {number} kind
 * @param {number} w     该条的形变权重
 * @param {object} cfg
 */
export function warpMatrix(kind, w, cfg) {
  if (kind === WARP_HIP) {
    const rad = deg2rad(cfg.legAvg * cfg.meshK);
    const ca = Math.cos(rad);
    const sa = Math.sin(rad);
    const hx = cfg.hipX;
    const hy = cfg.hipY;

    const m00 = 1 - w + w * ca;
    const m01 = -w * sa;
    const m10 = w * sa;
    const m11 = 1 - w + w * ca;

    // Rot(hip) = (ca·hx − sa·hy, sa·hx + ca·hy)
    const rx = ca * hx - sa * hy;
    const ry = sa * hx + ca * hy;
    const tx = w * (hx - rx);
    const ty = w * (hy - ry);

    // setTransform(a, b, c, d, e, f)：x' = a·x + c·y + e ；y' = b·x + d·y + f
    return [m00, m10, m01, m11, tx, ty];
  }

  if (kind === WARP_HAIR) {
    // ⚠️ 规格原文是 ×0.85，但那是把「角度」当「像素」使 —— 量级差一个数量级：
    //    旧工程靠旋转 4° 甩头发，末梢位移约 17px；而 4×0.85 只有 3.4px，几乎看不见。
    //    所以系数抽出来做成可调（hairK），默认给 4。
    const amt = -cfg.hairR * (cfg.hairK ?? 4) * cfg.meshK;
    return [1, 0, 0, 1, amt * w * w, 0];
  }

  return [1, 0, 0, 1, 0, 0];
}

// ---------- 3×3 仿射矩阵工具（只用得上这几个）----------
// 一律用 [a,b,c,d,e,f] 这套表示，跟 canvas 一致

export function matMul(m, n) {
  // 先应用 n，再应用 m
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function matTranslate(x, y) {
  return [1, 0, 0, 1, x, y];
}

export function matRotate(rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

/** 绕 (px, py) 旋转 rad */
export function matRotateAbout(rad, px, py) {
  return matMul(matMul(matTranslate(px, py), matRotate(rad)), matTranslate(-px, -py));
}
