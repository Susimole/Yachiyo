/**
 * 骨架引擎 · 状态机
 *
 * 出处：规格 §3（8 个状态、转移权重表、时长与冷却、活跃度 A）
 *
 * 8 个状态：start 启动 / idle 歇着 / walk 步行 / run 跑动 /
 *           sit 坐下 / sleep 睡觉 / jump 跳跃 / touch 互动
 *
 * ⚠️ 规格里标了两处「旧工程没做完」：
 *   · sleep 的守卫规则（睡一次后要隔几个状态才能再睡）—— 旧工程只留了字段没实现，这里补上
 *   · touch 那一行权重在旧工程里到不了 —— 这里接成「被点一下就用互动表重骰」
 */

import { rand } from './math.js';

/** 转移权重表（每行合计 = 10）—— 原样抄规格 §3.1 */
export const TRANSITIONS = {
  start: [['walk', 6], ['sit', 4]],
  idle: [['idle', 2], ['walk', 5], ['sit', 3]],
  walk: [['walk', 2], ['run', 3.5], ['sit', 1.5], ['idle', 3]],
  run: [['run', 1.5], ['walk', 4.5], ['jump', 3.5], ['sit', 0.5]],
  sit: [['sit', 2], ['sleep', 4], ['idle', 4]],
  sleep: [['sit', 10]],
  jump: [['idle', 2], ['walk', 4.5], ['run', 3], ['sit', 0.5]],
  touch: [['sit', 1], ['walk', 4.5], ['run', 3.5], ['idle', 0.5], ['jump', 0.5]],
};

/** 时长区间（秒）—— 规格 §3.3 */
export const DURATION = {
  idle: [5, 15],
  walk: [2, 8],
  run: [1, 6],
  sit: [8, 20],
  sleep: [15, 40],
  jump: [1, 3],
};

/** 中文状态名 → 预设名（规格 §2.5 的 stateOf）—— 用来查 rig.json 的 presets */
export const PRESET_OF = {
  start: 'idle',
  idle: 'idle',
  walk: 'walk',
  run: 'run',
  sit: 'sit',
  sleep: 'sleep',
  jump: 'walk',
  touch: 'idle',
};

/** 静止类：它们的时长要 ÷ 活跃度 A */
const STILL = new Set(['idle', 'sit', 'sleep']);

/**
 * 关掉「桌宠移动」之后她**只允许**待在这三个状态里。
 *
 * ⚠️⚠️ 2026-10-12 他报的：「关闭桌宠移动之后，脚还在动，很奇怪」。
 *
 *    根因：`moveEnabled` 只管**位置**（app.js 的 stepRoam 里一句
 *    `if (!CFG.moveEnabled) return`），状态机那边还在照常骰 walk / run ——
 *    于是她**站在原地原地踏步**。位移没了、动画还在，看着像卡帧。
 *
 *    只在 stepRoam 里挡住是治不了的，得从**状态机**这儿断：
 *    她压根就不该被骰去走路。
 */
const STAY_ONLY = new Set(['idle', 'sit', 'sleep']);

/** 睡完要隔这么多个非睡状态，才能再睡（旧工程只留了字段没实现，这里定 3） */
const SLEEP_GUARD = 3;

export class RigState {
  constructor(opts = {}) {
    this.mode = 'start';
    this.left = 0; // 当前状态剩余秒数
    this.cool = 0; // 冷却剩余秒数
    this.activity = opts.activity ?? 100;
    /**
     * 允不允许她走动（配置里的「桌宠移动」）。
     * false 时 pick() 只会在 idle / sit / sleep 里挑 —— 见 STAY_ONLY。
     */
    this.allowMove = opts.allowMove !== false;
    this.mouseIdleSec = 0; // 鼠标静置秒数（跳跃资格用）
    this.sinceSleep = SLEEP_GUARD; // 距离上次睡觉过了几个状态
    this.onChange = opts.onChange ?? (() => {});
    this.log = opts.log ?? (() => {});
  }

  /** 活跃度系数 A —— 规格 §3.4 */
  get A() {
    return Math.max(0.2, Math.min(3, this.activity / 100));
  }

  /** 跳跃资格：鼠标静置 30~300 秒才有资格 —— 规格 §3.5 */
  jumpOk() {
    return this.mouseIdleSec >= 30 && this.mouseIdleSec <= 300;
  }

  /** 时长 —— 规格 §3.3 */
  duration(mode) {
    const d = DURATION[mode];
    if (!d) return 6; // 规格：缺失时返回 6.0
    let v = rand(d[0], d[1]);
    if (STILL.has(mode)) v = v / this.A;
    return Math.max(1.5, v);
  }

  /** 冷却 —— 规格 §3.3 */
  cooldown() {
    let cool = this.mode === 'walk' || this.mode === 'run' ? rand(0.6, 1.5) : rand(1, 3);
    cool = cool / this.A;
    return Math.max(0.2, cool);
  }

  /** 骰下一个状态 —— 规格 §3.1 的五步 */
  pick(from = this.mode) {
    const row = TRANSITIONS[from] || TRANSITIONS.idle;
    const weighted = [];
    let tot = 0;

    for (const [target, w0] of row) {
      let w = w0;
      let name = target;

      // ② 指向静止类的权重 ÷ A
      if (STILL.has(name)) w = w / this.A;

      // ③ 要跳但没资格 → 改判 idle（保留原权重）
      const isJumpButNotOk = name === 'jump' && !this.jumpOk();
      if (isJumpButNotOk) name = 'idle';

      // ③' 关掉「桌宠移动」→ 走 / 跑 / 跳整个不进池子。
      //     是 `continue`（丢掉这一项、tot 相应变小），不是把权重压成 0 ——
      //     效果一样，但少一次浮点除法，也读得懂。
      if (!this.allowMove && !STAY_ONLY.has(name)) continue;

      weighted.push([name, w]);
      tot += w;
    }

    // 全被滤掉理论上不会发生（每一行都至少有 idle 或 sit），
    // 但要是哪天真加了一行没有静止项的，宁可返回 idle 也别让 tot=0 断掉后面
    if (tot <= 0 || !weighted.length) return 'idle';

    // ④ 累计掷点
    let r = Math.random() * tot;
    let picked = 'idle';
    for (const [name, w] of weighted) {
      r -= w;
      if (r <= 0) {
        picked = name;
        break;
      }
    }

    // ⑤ 必须在白名单里
    if (!DURATION[picked]) picked = 'idle';

    // 睡觉守卫：刚睡过就不能马上又睡
    if (picked === 'sleep' && this.sinceSleep < SLEEP_GUARD) picked = 'idle';

    return picked;
  }

  /** 进入一个状态（只改内部值，换套由 Rig 做） */
  enter(mode, reason = '') {
    const prev = this.mode;
    this.mode = mode;
    this.left = this.duration(mode);
    this.cool = 0;
    this.sinceSleep = mode === 'sleep' ? 0 : this.sinceSleep + 1;
    this.log(`状态 ${prev} → ${mode}（${this.left.toFixed(1)}s${reason ? ' · ' + reason : ''}）`);
    this.onChange(mode, prev);
  }

  /**
   * 被点 / 被拖了一下 —— **站住歇着**，别表演。
   *
   * ⚠️ 2026-10-11 他报的 bug：「点击桌宠会不断切换动作」。
   *    根因就在这儿 —— 原来这个方法叫 `interrupt()`，
   *    实现是 `enter(this.pick('touch'))`，也就是**每点一下就重骰一个动作**。
   *    实测连点 6 次：sit / sit / walk / run / walk / run 三种轮着来。
   *    他戳她只是想打个招呼，不是让她汇报演出。
   *
   *    `sec` 是「安静多久」—— 不设的话 `enter` 会按 idle 的随机时长
   *    （活跃度低的时候可能只有 1.5 秒），刚站住就又骰走了，看着还是乱。
   */
  rest(sec = 8) {
    this.enter('idle', '被戳了一下');
    this.left = sec;
  }

  /** 每帧推进。返回本帧是否换了状态 */
  step(dtSec, mouseIdleSec) {
    this.mouseIdleSec = mouseIdleSec ?? this.mouseIdleSec;

    if (this.cool > 0) {
      this.cool -= dtSec;
      if (this.cool <= 0) {
        this.enter(this.pick(), '冷却结束');
        return true;
      }
      return false;
    }

    this.left -= dtSec;
    if (this.left <= 0) {
      this.cool = this.cooldown();
      return false;
    }
    return false;
  }
}
