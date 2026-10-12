/**
 * 骨架引擎 · 主类
 *
 * 出处：规格 §2（rig.json 字段）、§5（摆位 / 缩放）、§8（渲染循环 + 网格形变）
 *
 * 渲染：Canvas 2D。
 *   刚体件 → 一次 drawImage
 *   挂形变的件 → 沿 y 切横条，每条一个仿射（因为两种形变的权重都只跟 y 有关）
 *
 * ⚠️ 坐标系：rig.json 里全是**拆件单位**；动画参数（lift / bob / FootSep…）
 *    全是**调试台像素** = 拆件单位 × 0.72。读进来第一件事就是 × 0.72。
 */

import { deg2rad, Spring } from './math.js';
import { computePose } from './gait.js';
import { RigState, PRESET_OF } from './state.js';
import {
  WARP_NONE, WARP_HIP, WARP_HAIR,
  warpWeight, warpMatrix,
  matMul, matTranslate, matRotateAbout,
} from './warp.js';

/** 拆件单位 → 调试台像素（规格 §0） */
export const PX_PER_UNIT = 0.72;
/** rig.json 的 canvas 字段（拆件单位） */
export const CANVAS_UNITS = 640;
/** 画布逻辑尺寸（调试台像素） */
export const CANVAS_PX = CANVAS_UNITS * PX_PER_UNIT; // 460.8

/** 头部件 —— 规格 §1.3 的 HEAD_PARTS（不含 neck） */
/**
 * 呼吸的最强幅度（纵向伸缩比例）。
 * 3% —— 100% 倍率时她高约 400px，头顶上下约 12px。
 * 再大就像在蹦，再小看不见。
 */
const BREATH_AMP = 0.03;

/**
 * 站坐过渡 —— C 方案「挤压展开」的参数（他 2026-10-12 从四稿里选的）。
 *
 * 数值直接照搬那份预览的默认值（预览文件名见桌面留痕夹的
 * `八千代-站坐过渡-方案对比-*.html`），免得「预览好看、落地不一样」：
 *
 *   outK   = 2.2   → 站立层在 t = 1/2.2 ≈ 0.455 处淡完（前半段就走完）
 *   inFrom = 0.3   → 坐姿层从 t = 0.3 才开始淡入（跟站立压扁有一段重叠）
 *   squash = 0.16  → 压到 1−0.16 = 0.84，也就是纵向压掉 16%
 *
 * 为什么是「压扁」而不是「淡入淡出」：
 *   她本来就有个从脚往上伸缩的 Q 弹呼吸，压扁跟它是同一套手感 ——
 *   看着像「她真的蹲下去了」，而不是「一张图换成了另一张图」。
 * 压扁的锚点是**脚下沿**（跟呼吸同一个），所以整个过渡里她都踩在地上。
 */
const XF = { outK: 2.2, inFrom: 0.3, squash: 0.16 };

/** 三次缓入缓出 —— 跟预览那一份完全一样，别换成别的曲线 */
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);

const HEAD_PARTS = new Set([
  'face', 'nose', 'mouth', 'eyewhite', 'irides', 'eyebrow', 'eyelash',
  'ears', 'headwear', 'front hair',
]);

export class Rig {
  constructor(canvas, opts = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;

    this.data = null;
    this.images = new Map();
    this.sets = {};
    this.setName = 'side';
    this.mode = 'idle';
    this.presetName = 'idle';
    this.sitting = false;

    this.ph = 0;
    this.phSit = 0;

    this.foot = { a: { x: 0, y: 0, rot: 0 }, b: { x: 0, y: 0, rot: 0 } };
    this.bodyY = 0;
    this.bodyRot = 0;
    /**
     * 全局倾斜偏移（度）—— 叠在**每个姿态自己的** `lean` 上。
     * 他 2026-10-12 定的口径是「每个姿态各一个值」，这个是总旋钮：
     * 想整体再歪一点/正一点，调它一个就行，不用去改三套预置。
     */
    this.leanOffset = 0;
    this.breath = 0;
    /**
     * 呼吸怎么做：
     *   'squash'（默认）= **脚不动**，从脚往上的部分纵向伸缩 —— Q 弹
     *   'shift'        = 老做法，整体上下平移（他的原话：「像在飘」）
     * 两个都在，是留一条一键回退的路。
     */
    this.breathStyle = opts.breathStyle ?? 'squash';
    /** 缩小时用的采样质量 —— 'high' 治低倍率锯齿；'low' 是 Canvas 默认值 */
    this.smoothQuality = opts.smoothQuality ?? 'high';
    this.mouseIdleSec = 0;

    /** 眼动跟随：鼠标位置 + 算出来的头/瞳孔偏移 */
    this.mouse = { x: 0, y: 0, on: false };
    this.flip = opts.flip ?? 1;   // 1 = 朝左（立绘原朝向）；-1 = 镜像
    this.gaze = { hx: 0, hy: 0, pupil: 0, follow: false, ang: null };

    /** 形变总强度（规格 §8.2 的 MeshK）：1 = 全开，0 = 全刚性 */
    this.meshK = opts.meshK ?? 1;
    /** 头发甩的系数（规格写 0.85，量级不对，见 warp.js 注释） */
    this.hairK = opts.hairK ?? 4;
    /** 每件切几格网格（规格的 RigGridN）；横条数 = 这个 × 4 */
    this.gridN = opts.gridN ?? 4;
    /** 锁住状态机 */
    this.locked = false;

    /** 站坐过渡的进行时状态：{ t, ms, from }；不在过渡里就是 null */
    this.xf = null;
    /** 过场时长，来自配置（0 = 关掉，瞬间换套） */
    this.transitionMs = opts.transitionMs ?? 420;

    this._newSprings();

    this.state = new RigState({
      activity: opts.activity ?? 100,
      // 关掉「桌宠移动」时她只在 歇着 / 坐下 / 睡觉 里挑（见 state.js 的 STAY_ONLY）
      allowMove: opts.allowMove !== false,
      onChange: (m) => {
        this.setMode(m);
        this.opts.onStateChange?.(m);
      },
      log: opts.log ?? (() => {}),
    });
    this.state.mode = 'idle';
    this.setMode('idle');
  }

  _newSprings() {
    // ⚠️ HeadX / HeadY 必须各一个对象，共用一个会互相抢
    this.springs = {
      bodyY: new Spring(80, 11, 24),
      bodyR: new Spring(60, 10, 12),
      // 呼吸量 —— 参数跟 bodyY 同款（欠阻尼），过冲出来的那点余韵就是「Q 弹」
      breath: new Spring(80, 11, 24),
      headX: new Spring(70, 10, 26),
      headY: new Spring(70, 10, 20),
      hair: new Spring(55, 7, 16),
      armA: new Spring(60, 9, 60),
      armB: new Spring(60, 9, 60),
      sitFoot: new Spring(45, 7, 1.2),
      // 眼动的头位移 —— 跟 HeadX / HeadY 同一组参数
      gazeX: new Spring(70, 10, 26),
      gazeY: new Spring(70, 10, 20),
    };
  }

  /**
   * 眼动跟随（出处：旧调试台第 635~660 行）
   *
   *   只在 idle 跟；超出 eyeMaxDeg 就不跟；
   *   amt = 1 − (|ang|/180)×0.6 —— 角度越大跟得越保守；
   *   头过弹簧（慢慢转），瞳孔不过（立刻转过去）。
   */
  _updateGaze(dt, ks) {
    let hx = 0, hy = 0, pupil = 0, follow = false, angNow = null;

    const canGaze = this.mode === 'idle' && this.mouse.on;
    if (canGaze) {
      const ref = this._headRef();

      /*
       * ⚠️⚠️ 2026-10-12 他报的：「朝左时眼动跟随是反的」。
       *
       *    横向要用**画布中心**当基准，不能用头的 x。
       *    因为镜像（flip）是绕**画布中心**做的 —— 整个立绘左右翻过来，
       *    画布中心这个点不动。而 `ref.x`（头中心）在翻转后会跑到对面去，
       *    拿它当基准算出来的方向正好差 180°。
       *
       *    本来头就在画布正中，两个数很接近，所以只有 `* flip` 那一项在捣乱 ——
       *    实测 flip=1 时鼠标放她左边算出 hx=0（她根本不跟），
       *    flip=-1 时鼠标放右边也是 0。
       *
       *    纵向没有镜像问题，仍然以头的 y 为基准。
       */
      const gcx = CANVAS_PX / 2;
      const lx = (this.mouse.x - gcx) * this.flip;
      const ly = this.mouse.y - ref.y;
      const ang = (Math.atan2(ly, lx) * 180) / Math.PI;
      angNow = ang;

      const maxDeg = this.P('eyeMaxDeg');
      if (Math.abs(ang) <= maxDeg) {
        follow = true;
        const amt = 1 - (Math.abs(ang) / 180) * 0.6;
        const rad = deg2rad(ang);
        hx = Math.cos(rad) * 16 * this.P('eyeHead') * amt * this.flip;
        hy = Math.sin(rad) * 12 * this.P('eyeHead') * amt;
        pupil = Math.cos(rad) * 7 * this.P('eyePupil') * amt * this.flip;
      }
    }

    this.gaze.hx = ks > 0 ? this.springs.gazeX.step(hx, dt * ks) : hx;
    this.gaze.hy = ks > 0 ? this.springs.gazeY.step(hy, dt * ks) : hy;
    this.gaze.pupil = pupil;      // 瞳孔不过弹簧
    this.gaze.follow = follow;
    this.gaze.ang = angNow;
  }

  /**
   * 她**脚下沿**在画布里的 y（CANVAS_PX 尺度）。
   *
   * 呼吸缩放的锚点 —— 绕这个点转，脚才踩得住不飘。
   * 跟 app.js 的 `footOffset()` 是同一个量，只是那边换算成了屏幕倍率；
   * 两边都直接取「所有件下沿的最大值」，不写死 86.6% 那个数。
   */
  _footY() {
    const cur = this.currentSet;
    if (!cur || !cur.parts) return CANVAS_PX * 0.866;
    let low = 0;
    for (const key of cur.order) {
      const p = cur.parts[key];
      if (p) low = Math.max(low, p.y + p.h);
    }
    return low || CANVAS_PX * 0.866;
  }

  /** 头的屏幕参考点（眼动以它为原点） */
  _headRef() {
    const cur = this.currentSet;
    const f = cur && cur.parts['face'];
    if (!f) return { x: CANVAS_PX / 2, y: CANVAS_PX / 2 };
    return { x: f.x + f.w / 2, y: f.y + f.h / 2 };
  }

  /** 眼动的三个参数不在 animKeys 里，得自己兜底 */
  P(key) {
    if (this.data.gaze && this.data.gaze[key] !== undefined) return this.data.gaze[key];
    const fallback = { eyeHead: 0.3, eyePupil: 0.6, eyeMaxDeg: 75 };
    return fallback[key] ?? 0;
  }

  _resetMotion() {
    this.ph = 0;
    this.phSit = 0;
    this.foot = { a: { x: 0, y: 0, rot: 0 }, b: { x: 0, y: 0, rot: 0 } };
    this._newSprings();
  }

  /**
   * 改「每个姿态各自的倾斜角」—— 设置面板那 5 个滑块用的。
   *
   * ⚠️⚠️ `rig.json` 是**启动时 fetch 进来的**，改了文件**不会自动生效** ——
   *    跑着的这一份 `this.data` 还是旧的。所以设置面板改完
   *    （主进程已经写进 rig.json）之后，还要叫这一声把**内存里这份也改掉**，
   *    不然他会看到「拖了滑块没反应，重启才生效」。
   *
   * @param {object} tilts `{ idle:-2, walk:1, run:5, sit:-6, sleep:0 }`（只给要改的也行）
   */
  setTilts(tilts) {
    if (!this.data || !this.data.presets) return false;
    for (const [mode, raw] of Object.entries(tilts || {})) {
      const p = this.data.presets[mode];
      const v = Number(raw);
      if (p && Number.isFinite(v)) p.lean = v;
    }
    return true;
  }

  // ============================================================
  //  加载
  // ============================================================

  async load(rigData, baseUrl = './assets/rig') {
    this.data = rigData;
    this.baseUrl = baseUrl;

    const jobs = [];
    for (const setName of Object.keys(this.data.sets)) {
      for (const p of Object.values(this.data.sets[setName].parts)) {
        if (this.images.has(p.file)) continue;
        jobs.push(this._loadImage(`${baseUrl}/${p.file}`).then((img) => this.images.set(p.file, img)));
      }
    }
    await Promise.all(jobs);

    for (const setName of Object.keys(this.data.sets)) {
      this.sets[setName] = this._buildSet(setName);
    }
    this.setName = 'side';
    this._resetMotion();
    return this;
  }

  _loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('贴图加载失败: ' + src));
      img.src = src;
    });
  }

  _buildSet(setName) {
    const raw = this.data.sets[setName];
    const order = raw.order;
    const parts = {};
    let minX = Infinity, maxX = -Infinity, maxBottom = -Infinity;

    for (let i = 0; i < order.length; i++) {
      const key = order[i];
      const p = raw.parts[key];
      if (!p) continue;

      // dx / dy 是调试台里手动微调的量（拆件单位）—— 直接加在 rig.json 的坐标上。
      // 上了网格形变之后有个别件位置会差一点，用这个修，不用回头改素材。
      // ⚠️ 必须 Number() 兜底：手改 JSON 很容易写成字符串 "-3"，
      //    那样 354 + "-3" 会拼成 "354-3"，再乘系数就是 NaN —— 整个件画丢、还不报错。
      const x = (p.x + (Number(p.dx) || 0)) * PX_PER_UNIT;
      const y = (p.y + (Number(p.dy) || 0)) * PX_PER_UNIT;
      const w = p.w * PX_PER_UNIT;
      const h = p.h * PX_PER_UNIT;
      const j = raw.joints ? raw.joints[key] : null;

      parts[key] = {
        name: key,
        x, y, w, h,
        z: 0.02 * i,
        img: this.images.get(p.file),
        pivotX: j ? j[0] * PX_PER_UNIT : x + w / 2,
        pivotY: j ? j[1] * PX_PER_UNIT : y + h / 2,
        deg: 0, tx: 0, ty: 0,
        warpKind: WARP_NONE,
        warpCfg: null,
      };
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x + w);
      maxBottom = Math.max(maxBottom, y + h);
    }

    // ---- 形变配置（规格 §8.2 Build-RigSet）----
    // 髋关节：sit 套用 legwear（没有就退回 topwear）；side 套用 topwear
    const hipKey = setName === 'sit'
      ? (parts['legwear'] ? 'legwear' : 'topwear')
      : 'topwear';
    const hip = parts[hipKey];
    const hipCfg = hip ? { hipX: hip.pivotX, hipY: hip.pivotY } : { hipX: 0, hipY: 0 };

    if (hip) {
      hip.warpKind = WARP_HIP;
      hip.warpCfg = hipCfg;
    }
    for (const k of ['back hair', 'front hair']) {
      const h = parts[k];
      if (!h) continue;
      h.warpKind = WARP_HAIR;
      h.warpCfg = { pivotY: h.pivotY, restBottom: h.y + h.h };
    }

    // 两脚基准间距（规格 §4.3）
    const fa = parts['foot_a'], fb = parts['foot_b'];
    let footSep = 0, footSepSign = 1;
    if (fa && fb) {
      const ca = fa.x + fa.w / 2;
      const cb = fb.x + fb.w / 2;
      footSep = Math.abs(cb - ca);
      footSepSign = cb > ca ? 1 : -1;
    }

    const face = parts['face'];
    return {
      name: setName,
      label: raw.label,
      order,
      parts,
      footSep,
      footSepSign,
      minX, maxX, maxBottom,
      faceCX: face ? face.x + face.w / 2 : 0,
      count: order.length,
    };
  }

  // ============================================================
  //  状态 / 参数
  // ============================================================

  setMode(mode) {
    /*
     * 状态 → 用哪一套素材。
     *
     * ⚠️ 2026-10-12：睡觉**自己单独一套**（sleep），不再借坐姿套。
     *    他给了一张画好的睡姿图，明确说「这个状态不需要做骨架」。
     *    所以 sleep 套就是**单件**（order: ['body']）—— 一张整图，
     *    不切网格、不做姿态覆盖，只吃全局变换和那个 Q 弹呼吸。
     *    摆位（x/y/w/h）在 rig.json 里，脸对齐另外两套的 359、底边踩 555。
     */
    const wantSet = mode === 'sleep' ? 'sleep'
                  : mode === 'sit'   ? 'sit'
                  : 'side';
    if (wantSet !== this.setName && this.sets[wantSet]) {
      // 两套开局都建好，这里只切显隐、不重建（规格 §3.6：现场重建会卡 500ms）
      const before = this.sets[this.setName];
      this.setName = wantSet;
      /*
       * 站坐过渡：把**退场的那一套**留在手里，接下来这一小段时间两层一起画。
       * 退场层的姿态就停在换套前那一帧（它已经不在 step() 的更新范围里了）——
       * 反正 190ms 就淡完了，冻住正好，比继续算还稳。
       */
      const ms = Number(this.transitionMs) || 0;
      if (ms > 0 && before && before.count) {
        this.xf = { t: 0, ms, from: before };
      } else {
        this.xf = null;
      }
      this._resetMotion();
      // 把换套前的那一套交出去 —— 外面要拿它算「脚原来在哪儿」。
      // 坐姿比站姿矮 58.9 单位，不补偿的话她换套瞬间会往下弹一下。
      this.opts.onSetChange?.(wantSet, before);
    }
    this.mode = mode;
    this.presetName = PRESET_OF[mode] ?? 'idle';
    this.sitting = this.setName === 'sit';
  }

  D(key) {
    const preset = this.data.presets ? this.data.presets[this.presetName] : null;
    if (preset && preset[key] !== undefined) return preset[key];
    return this.data.defaults[key] ?? 0;
  }

  get currentSet() {
    return this.sets[this.setName];
  }

  // ============================================================
  //  每帧
  // ============================================================

  step(dtMs) {
    const dms = Math.min(dtMs, 120);   // 卡一下别让相位跳一大截（规格 §4.1）
    const dt = dms / 1000;
    const cur = this.currentSet;
    if (!cur) return;

    if (!this.locked) this.state.step(dt, this.mouseIdleSec);

    // 站坐过渡往前推；到点就把它扔掉，回到「只画一套」的老路
    if (this.xf) {
      this.xf.t = Math.min(1, this.xf.t + dms / this.xf.ms);
      if (this.xf.t >= 1) this.xf = null;
    }

    const pose = computePose({
      mode: this.mode,
      D: (k) => this.D(k),
      ph: this.ph,
      phSit: this.phSit,
      footSep: cur.footSep,
      footSepSign: cur.footSepSign,
      ks: this.D('springK'),
      springs: this.springs,
      dt,
      dms,
      sitting: this.sitting,
      breathStyle: this.breathStyle,
      // ★ 全局倾斜偏移（设置面板那个旋钮）—— 叠在每个姿态自己的 lean 上
      leanOffset: this.leanOffset || 0,
      prev: this.foot,
    });

    this.ph = pose.ph;
    this.phSit = pose.phSit;
    this.foot = pose.foot;
    this.bodyY = pose.bodyY;
    this.bodyRot = pose.bodyRot;
    this.breath = pose.breath || 0;

    // 眼动：只在 idle 跟鼠标
    this._updateGaze(dt, this.D('springK'));

    // 形变要用的两个量（规格 §8.2 ApplyWarp 的输入）
    this.legAvg = (pose.legDeg.a + pose.legDeg.b) / 2;
    this.hairR = pose.hairDeg;

    for (const key of cur.order) {
      const p = cur.parts[key];
      if (!p) continue;
      p.deg = 0; p.tx = 0; p.ty = 0;

      if (key === 'foot_a') {
        // ★ 坐姿：脚不平移，只绕脚踝摆（pivot 正好落在脚踝上）。
        //   之前只换了角度、忘了停平移，所以她坐着时脚还在按步态左右划。
        if (this.sitting) {
          p.tx = 0; p.ty = 0; p.deg = pose.sitFoot.a;
        } else {
          p.tx = pose.foot.a.x; p.ty = pose.foot.a.y; p.deg = pose.foot.a.rot;
        }
      } else if (key === 'foot_b') {
        if (this.sitting) {
          p.tx = 0; p.ty = 0; p.deg = pose.sitFoot.b;
        } else {
          p.tx = pose.foot.b.x; p.ty = pose.foot.b.y; p.deg = pose.foot.b.rot;
        }
      } else if (key === 'hand_a') {
        p.tx = pose.hand.a.tx; p.ty = pose.hand.a.ty; p.deg = pose.hand.a.deg;
      } else if (key === 'hand_b') {
        p.tx = pose.hand.b.tx; p.ty = pose.hand.b.ty; p.deg = pose.hand.b.deg;
      } else if (HEAD_PARTS.has(key)) {
        // 头部件 = 状态给的偏移 + 眼动
        p.tx = pose.head.tx + this.gaze.hx;
        p.ty = pose.head.ty + this.gaze.hy;
        // 瞳孔（irides）额外横移 —— 眼睛比头先到
        if (key === 'irides') p.tx += this.gaze.pupil;
      }

      if (key === 'back hair' || key === 'front hair') p.deg = pose.hairDeg;
    }

    // 睡觉覆盖（规格 §6）：除 foot / hand 外所有件压低 + 低头
    // ⚠️ 只对**骨架版**睡姿生效。sleep 套是单张画好的整图，
    //    再叠一层「压低 + 低头」就是画蛇添足 —— 图里她本来就低着头闭着眼。
    if (this.mode === 'sleep' && pose.sleep && this.setName !== 'sleep') {
      for (const key of cur.order) {
        const p = cur.parts[key];
        if (!p) continue;
        if (key.startsWith('foot') || key.startsWith('hand')) continue;
        p.tx = pose.sleep.tx; p.ty = pose.sleep.ty; p.deg = pose.sleep.deg;
      }
      // 睡觉时头发不甩（摆着别动）
      this.hairR = 0;
    }
  }

  // ============================================================
  //  渲染
  // ============================================================

  render() {
    const ctx = this.ctx;
    const cur = this.currentSet;
    const dpr = this.dpr || 1;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    /*
     * ⚠️⚠️ 低倍率锯齿（2026-10-11 他报的 bug ①）—— 就这一行。
     *
     * 症状：放大率 50% 以下时她边缘全是锯齿。
     * 根因：件是从 1280 系的拆件 PNG 直接 `drawImage` 缩到画布上的。
     *       50% 时一个几百像素宽的件要缩到几十像素 —— **降采样超过 4 倍**，
     *       而 Canvas 默认的 `imageSmoothingQuality` 是 `'low'`（双线性），
     *       采样点根本落不到边缘的中间色上，抗锯齿的半透明过渡带被抹平成硬边。
     *
     * 实测（scripts/probe-bugs.cjs，量她轮廓的「半透明过渡带」宽度，物理像素）：
     *       倍率   low      high
     *       100%    2        2      ← 本来就没问题
     *        50%    1        2      ← 硬边 → 正常抗锯齿
     *        25%    1        3
     *        15%    1        3
     *   1 像素的过渡 = 硬边 = 他看到的锯齿。
     *
     * ⚠️ 必须写在**每帧**（不能在构造/setup 里设一次）——
     *    改 `canvas.width` 会把 2D context 的所有状态重置回默认值，
     *    而 `applyScale()` 每次改桌宠大小都会重设 width，设一次等于没设。
     *    每帧一次属性赋值，开销可以忽略。
     */
    ctx.imageSmoothingQuality = this.smoothQuality;

    ctx.clearRect(0, 0, CANVAS_PX, CANVAS_PX);
    if (!cur) return;

    const gcx = CANVAS_PX / 2;
    const gcy = CANVAS_PX / 2;

    // 全局变换：绕画布中心转 BodyRot，再整体加 BodyY
    const globalM = matMul(
      matMul(matTranslate(gcx, gcy + this.bodyY), matRotateAbout(deg2rad(this.bodyRot), 0, 0)),
      matTranslate(-gcx, -gcy)
    );

    // 镜像 —— 她面朝左（原立绘朝向）时 flip = 1，朝右走时 flip = -1。
    // ⚠️ 翻的是【全局变换】这一层：件自己的 pivot、形变矩阵都在局部坐标系里，
    //    跟着一起翻才是对的（头发的甩动方向也该反）。所以在最外圈套一层。
    //    动手在局部翻会让她左右件（hand_a / hand_b）跑到对方位置上去。
    let gm = this.flip === -1
      ? matMul(matMul(matTranslate(gcx, 0), matMul([-1, 0, 0, 1, 0, 0], matTranslate(-gcx, 0))), globalM)
      : globalM;

    /*
     * 呼吸 —— **脚踩死，从脚往上的部分纵向伸缩**。
     *
     * ⚠️ 2026-10-11 他提的：「呼吸会改变桌宠的 Y 轴位置，能不能不动 Y 轴、
     *    改成上下 Q 弹」。原来的做法是 `bodyY` 整体平移 ±1.2 单位 ——
     *    连脚一起动，看着像整个人在飘。
     *
     *    现在：以她的**脚下沿**为不动点做纵向缩放。
     *    数学上是 `y' = foot + (y − foot) × s`，展开成矩阵就是
     *    `[1, 0, 0, s, 0, foot × (1 − s)]` —— 纵向缩 s 倍、再往下挪一点点，
     *    让 foot 这个点保持原位。
     *
     *    脚不动 ⇒ 她踩在地板上「呼吸」，而不是浮起来。
     *    幅度 `BREATH_AMP` 取 3%：100% 倍率时头顶上下约 12px，看得见但不夸张。
     */
    if (this.breathStyle === 'squash' && Math.abs(this.breath) > 0.001) {
      const fy = this._footY();
      const s = 1 + this.breath * BREATH_AMP;
      gm = matMul([1, 0, 0, s, 0, fy * (1 - s)], gm);
    }

    /*
     * 站坐过渡（C 方案「挤压展开」）——
     * 退场那套先画（压在下面），当前这套后画（盖在上面）。
     *
     * ⚠️ 压扁同样锚在**脚下沿**，跟呼吸一个锚点 —— 不然换套时会看到她
     *    一边压扁一边往地上陷。两层的底边都是 555，本来就同一条线，
     *    再各自绕自己的脚下沿压，肉眼看到的就是「原地蹲下去」。
     */
    if (this.xf) {
      const t = easeInOut(this.xf.t);
      const outA  = Math.min(1, t * XF.outK);                 // 站立层淡出进度
      const inB   = Math.max(0, (t - XF.inFrom) / (1 - XF.inFrom)); // 坐姿层淡入进度
      this._drawSet(ctx, this.xf.from, gm, 1 - outA, 1 - XF.squash * outA);
      this._drawSet(ctx, cur,            gm, inB,      1 - XF.squash * (1 - inB));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalAlpha = 1;
      return;
    }

    this._drawSet(ctx, cur, gm, 1, 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
  }

  /**
   * 画一套素材。
   *
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} cur    哪一套（this.sets.xxx）
   * @param {Array}  gm     已经算好的**全局变换**（含镜像 / BodyY / 呼吸；不含缩放）
   * @param {number} alpha  这一层的整体不透明度（过场用；平时是 1）
   * @param {number} squashY 纵向缩放（过场用；平时是 1）。锚在**这套自己的脚下沿**
   */
  _drawSet(ctx, cur, gm, alpha = 1, squashY = 1) {
    if (!cur) return;
    if (alpha <= 0.004) return;          // 全透明就别画了，白费一遍 32 条切片
    const dpr = this.dpr || 1;

    if (squashY !== 1) {
      let fy = 0;
      for (const key of cur.order) {
        const p = cur.parts[key];
        if (p) fy = Math.max(fy, p.y + p.h);
      }
      fy = fy || CANVAS_PX * 0.866;
      gm = matMul([1, 0, 0, squashY, 0, fy * (1 - squashY)], gm);
    }
    ctx.globalAlpha = alpha;

    const slices = Math.max(1, Math.round(this.gridN * 4));

    for (const key of cur.order) {
      const p = cur.parts[key];
      if (!p || !p.img) continue;

      // 件自身：绕 pivot 转 + 平移
      const pivotM = matMul(
        matTranslate(p.tx, p.ty),
        matRotateAbout(deg2rad(p.deg), p.pivotX, p.pivotY)
      );
      const partM = matTranslate(p.x, p.y);          // 件内局部 → 画布
      const afterGlobal = matMul(gm, pivotM);

      // ---- 不挂形变：一次画完 ----
      if (p.warpKind === WARP_NONE || this.meshK <= 0) {
        const M = matMul(afterGlobal, partM);
        ctx.setTransform(dpr * M[0], dpr * M[1], dpr * M[2], dpr * M[3], dpr * M[4], dpr * M[5]);
        ctx.drawImage(p.img, 0, 0, p.w, p.h);
        continue;
      }

      // ---- 挂形变：沿 y 切横条 ----
      // 形变强度可以按状态给（他走和跑要的量不一样）；preset 里没有就用全局值
      const pset = this.data.presets ? this.data.presets[this.presetName] : null;
      const cfg = Object.assign({
        meshK: (pset && pset.meshK !== undefined) ? pset.meshK : this.meshK,
        hairK: (pset && pset.hairK !== undefined) ? pset.hairK : this.hairK,
        legAvg: this.legAvg || 0,
        hairR: this.hairR || 0,
      }, p.warpCfg);
      const imgH = p.img.naturalHeight || p.img.height;
      const dstStep = p.h / slices;
      const srcStep = imgH / slices;

      // ⚠️ 切片接缝 —— 这个坑踩了两回，记牢：
      // drawImage 的目标高度是小数（比如 126.7px ÷ 32 = 3.96px）时，上下边缘各留一个
      // 半透明像素。相邻两片用 source-over 叠上去只有 0.96 + 0.04×(1-0.96) ≈ 0.9616，
      // 补不满 1 —— 32 条切片就变成 32 条淡淡的横线，横贯整个立绘。
      // 试过「边界取整」，更糟：片高在 4/3 之间跳，源图和目标的比例对不上，采样更差。
      // 正解 = 每片上下各多画 PAD 像素，让相邻片重叠，后画的那片把前一片的半透明边整个盖掉。
      const PAD = 1;
      const padSrc = Math.ceil(PAD * (imgH / p.h));

      for (let i = 0; i < slices; i++) {
        const sy0 = Math.max(0, Math.round(i * srcStep) - padSrc);
        const sy1 = Math.min(imgH, Math.round((i + 1) * srcStep) + padSrc);
        const sh = sy1 - sy0;
        if (sh <= 0) continue;

        const ly0 = i * dstStep - PAD;                    // 这一片的目标起点（含重叠）
        const lh = dstStep + PAD * 2;
        const gy = p.y + ly0 + lh / 2;                    // 近似的画布 y（不含 warp）
        const w = warpWeight(p.warpKind, gy, cfg);
        const M = w <= 0.0005
          ? matMul(afterGlobal, matTranslate(p.x, p.y + ly0))                       // 这条没形变，走快路
          : matMul(afterGlobal, matMul(warpMatrix(p.warpKind, w, cfg),
                                       matTranslate(p.x, p.y + ly0)));
        ctx.setTransform(dpr * M[0], dpr * M[1], dpr * M[2], dpr * M[3], dpr * M[4], dpr * M[5]);
        ctx.drawImage(p.img, 0, sy0, p.img.width, sh, 0, 0, p.w, lh);
      }
    }
  }

  resize(cssW = CANVAS_PX, cssH = CANVAS_PX) {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    this.canvas.width = Math.round(cssW * dpr);
    this.canvas.height = Math.round(cssH * dpr);
    this.canvas.style.width = cssW + 'px';
    this.canvas.style.height = cssH + 'px';
  }
}
