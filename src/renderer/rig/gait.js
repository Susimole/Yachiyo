/**
 * 骨架引擎 · 姿态计算
 *
 * 出处：规格 §4（步行 / 跑动的数学）、§5.4（坐姿翘脚）、§6（睡觉）
 * 全部是纯数学 —— 输入「当前状态 + 参数」，输出「每个可动件这一帧的姿态」。
 * 渲染层拿到结果只管画，不碰公式。
 */

import { TAU, lowpass, smooth } from './math.js';

/**
 * 解一只脚。
 *   phi = 相位 + 这件自己的相位偏移（±50% = 半个周期）
 *   w0  = (1 - cos φ) / 2        0 → 1 → 0
 *   uu  = w0²(3 - 2w0)           smoothstep：两头站住、中间迈得干脆
 *   sw  = (uu - 0.5) * 2         ∈ -1 .. 1
 */
export function solveFoot(ph, phasePct) {
  const phi = ph + (phasePct / 100) * TAU;
  const w0 = (1 - Math.cos(phi)) / 2;
  const uu = w0 * w0 * (3 - 2 * w0);
  return { phi, uu, sw: (uu - 0.5) * 2 };
}

/**
 * 算这一帧的全部姿态。
 *
 * @param {object} o
 * @param {string} o.mode        状态名：idle / walk / run / sit / sleep / jump / start / touch
 * @param {(k:string)=>number} o.D  取参数（34 个 animKeys 里当前状态生效的那套）
 * @param {number} o.ph          步态相位（毫弧度，按毫秒推进）
 * @param {number} o.phSit       坐姿翘脚相位
 * @param {number} o.footSep     两脚基准间距（调试台像素）
 * @param {number} o.footSepSign +1 / -1
 * @param {number} o.ks          弹性总开关（= springK，0 则全刚性）
 * @param {object} o.springs     弹簧对象池
 * @param {number} o.dt          本帧秒数（弹簧/低通用）
 * @param {number} o.dms         本帧毫秒（相位用）
 * @param {boolean} o.sitting    是否在用坐姿套
 * @param {object} o.prev        上一帧的脚状态 { a:{x,y,rot}, b:{x,y,rot} }
 * @returns {object} 本帧姿态
 */
export function computePose(o) {
  const { mode, D, ph, phSit, footSep, footSepSign, ks, springs, dt, dms, sitting, prev } = o;
  const sleeping = mode === 'sleep';
  const jumping = mode === 'jump';
  const walking = mode === 'walk' || mode === 'run';

  // ---------- ① 相位推进（规格 §4.1）----------
  // 只有非睡、非跳才推进；跑动 speedF=0.42 → 周期更短 = 更快
  const stepMs = Math.max(80, D('stepMs'));
  const speedF = mode === 'run' ? 0.42 : 1;
  // 呼吸走「脚不动」那套时，身体平移要让位（见下面 ④ 的注释）
  const squashBreath = o.breathStyle === 'squash';

  const phNext = sleeping || jumping ? ph : ph + (TAU * dms) / (stepMs * speedF);
  const phSitNext = phSit + (TAU * dms) / Math.max(200, D('sitFootMs'));

  // ---------- ② 脚（规格 §4.2）----------
  const fa = solveFoot(phNext, D('faPhase'));
  const fb = solveFoot(phNext, D('fbPhase'));

  // 两只脚共用同一对落点 A / B：a 走 +、b 走 −，同为 uu
  // ⇒ xa + xb 恒定，只有两个落点
  const sep = footSep;
  const sg = footSepSign;
  const tAx = sep * D('stride') * D('faAmp') * fa.sw * sg + D('faOff');
  const tBx = -sep * D('stride') * D('fbAmp') * fb.sw * sg + D('fbOff');
  // 抬脚必须跟「往前迈」同相位（写反会「没迈的那只抬」）
  const tAy = -D('lift') * (D('faLift') / 100) * Math.max(0, Math.sin(fa.phi));
  const tBy = -D('lift') * (D('fbLift') / 100) * Math.max(0, Math.sin(fb.phi));
  const tAr = D('faRot') * Math.sin(fa.phi);
  const tBr = D('fbRot') * Math.sin(fb.phi);

  // 腿角（髋铰链形变用）：硬编码系数 22
  const legAdeg = fa.uu * 22;
  const legBdeg = -fb.uu * 22;

  // 脚走一阶低通（ks=0 时直接跟随）
  const footA = {
    x: lowpass(prev.a.x, tAx, ks, dt),
    y: lowpass(prev.a.y, tAy, ks, dt),
    rot: lowpass(prev.a.rot, tAr, ks, dt),
  };
  const footB = {
    x: lowpass(prev.b.x, tBx, ks, dt),
    y: lowpass(prev.b.y, tBy, ks, dt),
    rot: lowpass(prev.b.rot, tBr, ks, dt),
  };

  // ---------- ③ 手跟对侧腿（规格 §4.4）----------
  // 左手 ↔ 右脚、右手 ↔ 左脚（交叉）
  const aAT = D('followK') * -legBdeg + D('haAmp') * Math.sin(phNext + (D('haPhase') / 100) * TAU) + D('haCenter');
  const aBT = D('followK') * -legAdeg + D('hbAmp') * Math.sin(phNext + (D('hbPhase') / 100) * TAU) + D('hbCenter');
  const handAdeg = ks > 0 ? springs.armA.step(aAT, dt * ks) : aAT;
  const handBdeg = ks > 0 ? springs.armB.step(aBT, dt * ks) : aBT;

  // ---------- ④ 身体 / 头 / 头发（规格 §4.5）----------
  let bodyYTarget = 0;
  let bodyRTarget = 0;
  let breathTarget = 0;          // 0~1「吸气量」—— 只有 squash 呼吸用得上
  let sleepPhase = 0;            // 睡觉的呼吸相位（比坐姿慢，见下面的推导）

  /*
   * ★★ 整体倾斜角（`lean`）—— 2026-10-12 他拍板「**每个姿态各一个值**」。
   *
   * ⚠️ 这条线之前在 10-12 被**砍断过**（`bodyRTarget` 恒等于 0），
   *    当时只改了走路那条，理由是「走路时一直歪着看久了别扭」。
   *    结果连带把**待机/坐姿的倾斜也没了** —— 他在调试台里调不到那个滑块，
   *    才报的「待机时人物倾斜角需要回正」。其实不是"回正"，是**参数丢了**。
   *
   * 现在恢复成读参数：
   *   · 每个姿态用自己的 `lean`（在 rig.json 的 presets 里：待机 -2 / 走路 1 / 坐姿 -6）
   *   · 再加一个**全局偏移** `leanOffset`（设置面板里那一行，默认 0）
   *     —— 这样他有一个总旋钮，不用为每个姿态各调一遍
   *   · 走路**不再乘 0.35** —— 老代码那个系数是当年配合旧公式的手感，
   *     现在直接给整值，要小就把 presets 里的 1 调小
   */
  const leanDeg = D('lean') + (o.leanOffset || 0);

  if (walking) {
    bodyYTarget = -D('bob') * Math.abs(Math.sin(phNext));
    bodyRTarget = leanDeg;
  } else if (mode === 'sit') {
    bodyYTarget = squashBreath ? 0 : Math.sin(phSitNext * 0.6) * 1.0;
    breathTarget = breathCurve(phSitNext * 0.6);
    bodyRTarget = leanDeg;
  } else if (sleeping) {
    /*
     * 睡觉的呼吸。
     *
     * ⚠️⚠️ 2026-10-12 —— 原来这里用的是 `phNext`，但**睡觉时相位根本不推进**
     *     （上面那行 `sleeping || jumping ? ph : ph + …`）：
     *     跳的时候不推进是对的（跳是位移不是周期），睡觉却是要一直呼吸的。
     *     所以睡着之后 `Math.sin(phNext*0.5)` 是个**常量** —— 她一动不动。
     *
     *     现在改走 `phSitNext`（它一直在推进），再乘一个换算系数，
     *     把周期从「坐姿那套」换成 `sleepBreathMs`：
     *
     *         phSit 的推进速率是 TAU / sitFootMs 每毫秒
     *         乘上 sitFootMs / sleepBreathMs 之后，等效速率就是 TAU / sleepBreathMs ✓
     *
     *     他 2026-10-12 的要求：「呼吸要比坐着更慢」。
     *        坐姿周期 = sitFootMs / 0.6 = 1500 / 0.6 = 2500 ms
     *        睡姿周期 = sleepBreathMs          = 5000 ms   ⇒ 慢一倍
     *     5 秒一次 ≈ 一分钟 12 次，正好是睡着的节奏。
     */
    sleepPhase = phSitNext * (Math.max(200, D('sitFootMs')) / Math.max(800, D('sleepBreathMs')));
    bodyYTarget = squashBreath ? 0 : Math.sin(sleepPhase) * 1.6;
    /*
     * ⚠️ 睡姿这里**默认给 0**（`presets.sleep` 里没有 lean，会落到 defaults）。
     *    理由：睡姿图本来就是歪着头画好的，再转一下整张图是「整个相框斜了」，
     *    不是她在歪头。但**照样读参数** —— 万一他以后想给睡姿调一点，
     *    在 presets.sleep 里加一个 lean 就生效，不用再改代码。
     */
    bodyRTarget = leanDeg;
    breathTarget = breathCurve(sleepPhase);
  } else if (mode === 'idle') {
    // ⚠️ squash 模式下**必须把 bodyY 归零** ——
    //    它是整体平移，连脚一起动。不关的话「脚不动」这个卖点就是假的：
    //    实测两个叠在一起，脚下还是起伏 2.4px。
    bodyYTarget = squashBreath ? 0 : Math.sin(phNext * 0.6) * 1.2;
    breathTarget = breathCurve(phNext * 0.6);
    // ★ 待机也有倾斜（就是他报的这条）—— 值来自 presets.idle.lean，默认 -2
    bodyRTarget = leanDeg;
  }

  const bodyY = ks > 0 ? springs.bodyY.step(bodyYTarget, dt * ks) : bodyYTarget;
  // 呼吸量过同一个弹簧 —— 欠阻尼，所以会有过冲和一点点余韵，那就是「Q 弹」的手感
  const breath = ks > 0 ? springs.breath.step(breathTarget, dt * ks) : breathTarget;
  const bodyRot = ks > 0 ? springs.bodyR.step(bodyRTarget, dt * ks) : bodyRTarget;

  // 走路点头：只在 walking 时非零
  const headBob = walking ? -D('headBob') * (0.4 + 0.6 * Math.abs(Math.sin(phNext))) : 0;
  const headTY = ks > 0 ? springs.headY.step(headBob, dt * ks) : headBob;
  const headTX = ks > 0 ? springs.headX.step(0, dt * ks) : 0;

  const hairTarget = D('hairRot') * Math.sin(phNext - 0.7);
  const hairDeg = ks > 0 ? springs.hair.step(hairTarget, dt * ks) : hairTarget;

  // ---------- ⑤ 坐姿翘脚（规格 §5.4）----------
  // ⚠️ 只滤「共用幅度」这一个值 —— 两只脚别共用同一个弹簧对象，会互相抢、顶到上限
  let sitFootA = 0;
  let sitFootB = 0;
  if (sitting) {
    const sRaw = Math.sin(phSitNext);
    const ss = ks > 0 ? springs.sitFoot.step(sRaw, dt * ks) : sRaw;
    sitFootA = D('sitFootDeg') * ss;
    sitFootB = -D('sitFootDeg') * ss; // 两脚角度相反
  }

  // ---------- ⑥ 睡觉：低头（规格 §6）----------
  // 「闭眼」不在骨架里 —— 那是表情系统的事
  const sitDown = sitting && sleeping ? D('sitHeadDeg') : 0;

  return {
    ph: phNext,
    phSit: phSitNext,
    foot: { a: footA, b: footB },
    footDeg: { a: tAr, b: tBr }, // 原始目标角（形变用）
    sitFoot: { a: sitFootA, b: sitFootB },
    hand: {
      a: { tx: 0, ty: D('haOff'), deg: handAdeg },
      b: { tx: 0, ty: D('hbOff'), deg: handBdeg },
    },
    legDeg: { a: legAdeg, b: legBdeg },
    bodyY,
    bodyRot,
    breath,
    head: { tx: headTX, ty: headTY },
    hairDeg,
    // 睡觉时逐件覆盖用的值（⚠️ 只给骨架版睡姿用；单图那套不看它）
    sleep: sleeping ? { tx: headTX, ty: Math.sin(sleepPhase) * 1.6, deg: -0.8 + sitDown } : null,
  };
}

/** 网格形变权重：髋铰链（kind1）—— 沿 y 从髋部往下平滑过渡 */
/**
 * 呼吸曲线 —— **刻意不用正弦**。
 *
 * 正弦是「均匀地鼓起来、均匀地瘪下去」，看着像整个身子在上下飘 ——
 * 他 2026-10-11 说的就是这个：「呼吸会改变桌宠的 Y 轴位置」。
 *
 * 真人的呼吸是**快吸慢呼**：前面一小段把胸口撑起来，剩下大半段慢慢放掉。
 * 前 1/4 周期吸气、后 3/4 呼气，就是那个手感。
 * 再叠上欠阻尼弹簧（`springs.breath`）就有了过冲和余韵 —— 那才是「Q 弹」。
 *
 * ⚠️ 这个函数本身**不动位置**，它只输出一个 0~1 的量；
 *    「脚不动、从脚往上伸缩」那件事是 rig.js 的 render 里做的（纵向缩放）。
 *
 * @param {number} t 相位（弧度）
 * @returns {number} 0 = 呼尽，1 = 吸满
 */
export function breathCurve(t) {
  const u = ((t / TAU) % 1 + 1) % 1;
  return u < 0.25
    ? Math.sin((u / 0.25) * (Math.PI / 2))              // 快吸
    : Math.cos(((u - 0.25) / 0.75) * (Math.PI / 2));    // 慢呼
}

export function hipWeight(gy, hipY) {
  return smooth(hipY - 10, hipY + 18, gy);
}

/** 网格形变权重：头发甩（kind2）—— 从锚点往下越来越甩 */
export function hairWeight(gy, pivotY, restBottom) {
  return smooth(pivotY, restBottom, gy);
}
