/**
 * app.js —— 外壳的装配车间。
 *
 * 把骨架引擎、菜单、设置面板、气泡、鼠标穿透、拖拽、走动接在一起。
 * 这里是唯一知道「所有东西」的地方，别的模块尽量互不认识。
 *
 * 三层坐标别搞混（血泪）：
 *   ① 屏幕坐标   —— 屏幕物理像素 ÷ 缩放，Windows 里叫 DIP
 *   ② 窗口坐标   —— 窗口盖住整个工作区，所以 窗口坐标 = 屏幕坐标 − workArea 左上角
 *   ③ 画布坐标   —— 她在 #stage 里的 460.8 单位空间
 * 鼠标给的是 ②（clientX/Y），眼动要用 ③，走动改的是 ② 里 #stage 的位置。
 */

import { Rig, CANVAS_PX } from './rig/rig.js';
import { initBubble, showBubble, hideBubble, streamBubble, settleBubble, setSleeping, followPet } from './ui/bubble.js';
import { initSound, play as playSound, applyVolume } from './ui/sound.js';
import { applyFont } from './ui/font.js';
// ⚠️ 菜单 / 设置面板 / 聊天窗**不在这个页面里了** —— 它们各自搬去了独立的小窗口
//    （src/main/overlay.cjs 的文件头讲了为什么）。主窗口只剩她和气泡。

/* ============================================================
   状态
   ============================================================ */

let CFG = {};
let rig = null;
// ⚠️ stage = **窗口**的位置和大小。窗口现在只是屏幕底部一条带，
//    不再等于工作区 —— 算「她踩在哪儿」必须用它，不能拿 workArea 顶包。
let scr = {
  workArea: { width: 1920, height: 1080, x: 0, y: 0 },
  stage:    { x: 0, y: 900, width: 1920, height: 460 },
};

const stage = document.getElementById('stage');
const cvs   = document.getElementById('pet');

/** 她在窗口里的位置（px）—— config.petX / petY 存的就是这个 */
let pos = { x: 0, y: 0 };
/**
 * 朝向。
 *
 * ⚠️⚠️ 2026-10-12 **注释原来是写反的**，改成实测的结论：
 *
 *     `1`  = **朝右**（也是原立绘的朝向）
 *     `-1` = **朝左**（镜像）
 *
 *     原来写的是「1 = 朝左（立绘原朝向）」。可这条注释跟
 *     `nx = pos.x + facing * spd * dt` 是**矛盾**的 ——
 *     facing=1 是往 +x（右）走，注释却说朝左，那她就是在月球漫步。
 *     （他从来没提过她倒着走，说明是注释错了，不是代码错了。）
 *
 *     从素材几何上直接量了一遍（`rig.json` 的 side 套）：
 *         脸中心 x = 359 · 鼻子 375 · 瞳孔 368 · 后发 306.5
 *     鼻子和瞳孔都偏向脸中线的**右**边，后发甩在**左**边 —— 侧视立绘就是朝右的。
 *     ⇒ `flip = 1` 朝右，`flip = -1` 朝左，跟移动方向一致，没有倒着走这回事。
 *
 * ⚠️ 拖动时它会被 `setFacing()` 改（跟着鼠标走），松手**保留**；
 *    另外 `stepRoam` 撞墙那一刻也会翻。
 */
let facing = 1;

/** 拖动时翻身要越过多少像素才认 —— 太小会被鼠标抖动带得一路甩头 */
const FACE_STEP = 12;

/** 改朝向（`facing` 和 `rig.flip` 必须一起改，漏一个就是「脸和腿分家」） */
function setFacing(v) {
  if (facing === v) return;
  facing = v;
  if (rig) rig.flip = v;
}
let moving = false;
/*
 * 这里原来有个 `edgePause` 计时器（撞边 → 站住 N 秒 → 才转身）。
 * 2026-10-12 删了 —— 它有两个治不好的毛病：延后的转身可能在状态机换动作时
 * 整个丢掉（然后就「再度就近撞墙」），而且那段「站住」期间腿还在走。
 * 现在改成撞边当场转身 + 当场 rest()，不需要计时器了。
 */
let mouseIdle = 0;          // 鼠标静置秒数 —— 状态机拿它判跳跃资格
let lastAct = performance.now();

/* ============================================================
   尺寸 / 缩放
   ============================================================ */

/**
 * 按 petSize 调画布。
 * ⚠️ canvas 的 CSS 尺寸和绘制用的坐标空间是两回事：
 *    绘制坐标永远在 460.8 单位里，所以 dpr 要乘上缩放倍数 ——
 *    只改 style.width 不把 dpr 一起改，立绘会缩到左上角一块。
 */
function applyScale() {
  const k = (CFG.petSize || 100) / 100;
  const dpr = window.devicePixelRatio || 1;
  const css = CANVAS_PX * k;

  // ⚠️ 改 canvas.width 会把 2D context 的状态全部重置回默认值 ——
  //    包括 rig.render() 每帧设的那个 imageSmoothingQuality='high'。
  //    所以那边是每帧设的，不是设一次（见 rig.js）。
  cvs.width  = Math.round(CANVAS_PX * dpr * k);
  cvs.height = Math.round(CANVAS_PX * dpr * k);
  cvs.style.width  = css + 'px';
  cvs.style.height = css + 'px';
  stage.style.width  = css + 'px';
  stage.style.height = css + 'px';
  if (rig) rig.dpr = dpr * k;

  // ⚠️ 窗口要跟着画布一起变高 —— 窗口现在只是屏幕底部**一条带**，
  //    画布一大而窗口不变的话，她的头会被窗口顶边裁掉。
  //    主进程算完会推 win:stage 回来，那时再校正一次位置。
  //
  //    本地先按**同一套算法**估一份，这样位置立刻就是对的，
  //    不用等 IPC 回来（否则改一次大小她会先闪一下再归位）。
  scr.stage = {
    ...(scr.stage || {}),
    height: Math.min(petW(), scr.workArea.height),
  };
  try { window.yachiyo.win.setStage(); } catch { /* 桥还没接上就算了 */ }

  clampPos();
  setPos(pos.x, pos.y);
}

function petW() { return CANVAS_PX * ((CFG.petSize || 100) / 100); }

/**
 * 她踩的那条线（窗口内坐标）。
 *
 * 窗口底边 = 任务栏上沿，所以「脚踩在地面上」= 脚底落在窗口底边：
 *     她在窗口里的 y = 窗口高 − 脚在画布里的偏移
 * 站姿和坐姿的 footOffset 差 58.9 单位，所以这个值换套时会自己变 ——
 * 两套都能踩在同一条线上。
 */
function groundY() {
  // ⚠️ 窗口高以**渲染层自己的视口**为准（window.innerHeight），不能信主进程报的数。
  //    实测：主进程按 Math.round(460.8)=461 设的窗口，渲染层量到的是 466 ——
  //    中间隔着 DPI 取整和 Electron 自己的最小尺寸，差 5px。
  //    差多少不要紧，要紧的是「脚踩在窗口底边」这个等式必须用同一个数算，
  //    否则她要么悬空几个像素、要么整只脚踩到窗口外面去。
  const winH = window.innerHeight || (scr.stage && scr.stage.height) || petW();
  return Math.max(0, winH - footOffset());
}

/**
 * 把她放到某个位置。
 *
 * ⚠️⚠️ **y 传什么都不算数** —— 她只能在任务栏那条水平线上平移
 *    （他 2026-10-12 的要求：「不论如何拖动只能在任务栏平移」）。
 *
 *    这里刻意**吞掉 y 参数**而不是去改每一个调用点：调用点有十几处
 *    （拖动、走动、换套、改大小、恢复配置…），漏一处她就能纵向跑出去。
 *    在唯一的出口上锁死，怎么都漏不了。
 */
function setPos(x, _y) {
  pos.x = x;
  pos.y = groundY();
  stage.style.left = Math.round(pos.x) + 'px';
  stage.style.top  = Math.round(pos.y) + 'px';
  updateMask();
  /*
   * ★ 她换位置了，气泡跟着挪（2026-10-16 接上的）。
   *
   *    `bubble.followPet()` 早就写好了、也导出了，**但全仓没人调它** ——
   *    气泡的位置是 `place()` 一次性算死的，她走开了气泡就留在原地。
   *
   * ⚠️ 挂在 `setPos` 这**唯一出口**上（跟上面那个吞 y 参数一个道理）：
   *    调用点十几处（拖动 / 走动 / 换套 / 改大小 / 恢复配置），漏一处就漏一处。
   * ⚠️ 气泡没开的时候它在第一行就 return，走动时每帧叫它也不心疼。
   *    只有"她一边走一边正说着话"才会真的重排 —— 那正是要的效果。
   */
  followPet();
}

/**
 * 她**脚**在方框里的位置（窗口 CSS 像素，从方框顶边往下量）。
 *
 * ⚠️⚠️ 这个函数是 2026-10-11 他报的 bug ③「桌宠和任务栏不贴合」的修正。
 *
 * #stage 是个正方形方框，立绘只占中间一块 —— 实测她的脚下沿在方框的
 * **86.6%**，底下 13.4% 是空的（方框是 460.8 的固定画布，她多高都不变）。
 *
 * 之前的代码拿**方框底边**当她的脚：
 *   · 初始位置写 `workArea.height - w + 60`，指望这 60px 把脚「沉」到底
 *   · 可 `clampPos()` 立刻把 y 夹回 `workArea.height - w`，那 60px 当场被吃掉
 * ⇒ 她**永远悬空 13.4% 的方框高**：100% 时 62.6px，200% 时 122.8px。
 *    而且这是个跟缩放成正比的量，拿一个固定的 60 去补它，怎么调都不对。
 *
 * 正解：直接量当前套件里所有件下沿的最大值，那就是她真正的脚。
 * 站姿 / 坐姿各算各的，两套都能踩在同一块地面上。
 */
function footOf(set) {
  const k = (CFG.petSize || 100) / 100;
  if (!set || !set.parts) return CANVAS_PX * k * 0.866;   // 还没加载完，先给个接近值
  let low = 0;
  for (const key of set.order) {
    const p = set.parts[key];
    if (p) low = Math.max(low, p.y + p.h);
  }
  return (low || CANVAS_PX * 0.866) * k;
}
function footOffset() {
  return footOf(rig && rig.currentSet);
}

/** 别让她跑出屏幕（改大小 / 换分辨率 / 拖出去都要过这一关） */
function clampPos() {
  const maxX = Math.max(0, scr.workArea.width - petW());
  pos.x = Math.min(Math.max(0, pos.x), maxX);
  pos.y = groundY();          // 纵向没得商量：永远踩在那条线上
}

/* ============================================================
   鼠标穿透
   ============================================================ */

/**
 * 窗口默认整窗穿透（点得到桌面）。鼠标压到她身上 / 菜单上 / 面板上时才关穿透。
 *
 * ⚠️ 判定「有没有压到她」不能拿矩形算 —— #stage 是 460×460 的方框，
 *    可她是细长一条，方框四个角全是空气。用矩形的话她在屏幕右边站着，
 *    鼠标离她半米远也会把穿透关掉，桌面就点不动了。
 *    所以每几帧从画布缩出一张 48×48 的 alpha 掩码，按掩码判。
 */
const MASK = 48;
let maskData = null;
let maskTick = 0;
let maskAt = 0;          // 上一次真正回读画布的时刻（节流用，见 updateMask）
const mcv = document.createElement('canvas');
mcv.width = mcv.height = MASK;
const mctx = mcv.getContext('2d', { willReadFrequently: true });

function updateMask() {
  if (!rig || !rig.currentSet) return;

  /*
   * ⚠️ 节流（2026-10-16 加的）。
   *
   *    她**走动**的时候 `setPos()` 是**每帧**调的（见那边的调用），
   *    而这个函数每次都要 `drawImage` + `getImageData` —— **回读一次画布**。
   *    一秒 60 次像素回读纯属浪费，还很吃 CPU。
   *
   *    掩码只用来判「鼠标压到她身上没」，晚 60ms 更新肉眼看不出：
   *    48 格的掩码铺在 460px 的画布上，**一格约 9.6px**，
   *    她一秒也走不过一格。≈ 每秒最多 16 次，跟上面主循环那条 `% 4` 一个量级。
   */
  const now = performance.now();
  if (now - maskAt < 60) return;
  maskAt = now;

  mctx.clearRect(0, 0, MASK, MASK);
  mctx.drawImage(cvs, 0, 0, MASK, MASK);
  const fresh = mctx.getImageData(0, 0, MASK, MASK).data;

  /*
   * ⚠️ 别拿一张**全透明**的掩码去覆盖已有的好掩码。
   *
   *    什么时候会取到全透明的？
   *      · 启动早期画布还没画过（`boot()` 里 setPos → updateMask 那一次）
   *      · `applyScale()` 改了 canvas.width（改尺寸会把画布清空），
   *        紧接着就有一次 setPos
   *    这一下要是覆盖下去，在下一帧补上之前她**整只是点不着的** ——
   *    拖不动、点不出菜单，而画面上她好好地在动，最难查的那种。
   *
   *    空采样 = 「这一帧没信息」，那就把上一张留着用。
   */
  let any = false;
  for (let i = 3; i < fresh.length; i += 4) { if (fresh[i] > 10) { any = true; break; } }
  if (!any && maskData) return;

  maskData = fresh;
}

/*
 * ★★★ 2026-10-18：**收穿透的判定改用整块矩形** —— #6 的最后一块。
 *
 *   真机证据（他亲手点 + 120ms 精度盯系统 `WS_EX_TRANSPARENT`）：
 *     17:17:02.5 显示回来 → transparent=0（能点）
 *     17:17:06.3 → transparent=1（穿过去了，**持续 3 秒**）
 *     17:17:09.3 → 0（收回，只值 0.4 秒）
 *     17:17:09.7 → 1（又穿了）—— 他按下去就落在这段
 *
 *   为什么：`hitPet()` 用 **48×48 的 alpha 掩码**（带邻居搜索）判"在不在她身上"。
 *   她**呼吸/走路**时 `pos` 每帧都在动，掩码又是画完才采样的，
 *   鼠标压在发梢/裙角/脚边时「中/不中」会来回跳。一次判"没中" ⇒ 320ms 后就开穿透。
 *   这也正是他 10-17 那句「她睡觉时才互动」的成因 —— 睡着不动，判定就稳。
 *
 *   ⇒ **开不开穿透只看"鼠标在不在她这块矩形里"**：矩形跟着她走，但她**呼吸时纹丝不动**，
 *     判定稳如老狗。alpha 掩码继续留给"是不是真戳在她身上"（右键菜单那类判定用）。
 *   ⚠️ 代价：她矩形里的透明角落也归她（点那儿不会穿到桌面）。她 460×460，
 *      整条带 2048×560 ⇒ 最多占 18%，换来"点得着"，值。
 */
function nearPet(cx, cy) {
  const w = petW();
  const pad = 4;
  return cx >= pos.x - pad && cx <= pos.x + w + pad
      && cy >= pos.y - pad && cy <= pos.y + w + pad;
}

function hitPet(cx, cy) {
  const w = petW();
  const u = (cx - pos.x) / w;
  const v = (cy - pos.y) / w;
  if (u < 0 || u > 1 || v < 0 || v > 1) return false;
  if (!maskData) return true;

  // 多查一圈邻居 —— 她那几根头发丝在 48 格里可能整个没采样到，
  // 手明明压在她身上却判成空气，那就点不着了。
  const gx = Math.round(u * (MASK - 1));
  const gy = Math.round(v * (MASK - 1));
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = gx + dx, y = gy + dy;
      if (x < 0 || y < 0 || x >= MASK || y >= MASK) continue;
      if (maskData[(y * MASK + x) * 4 + 3] > 10) return true;
    }
  }
  return false;
}

let wantMouse = false;
let lastMouse = { x: -1, y: -1 };
/* ★ 主进程喂来的坐标 vs 真实 mousemove 坐标 —— 比较用，见下面的 debug() */
let feedLast = null;
let realMove = null;
let feedErr = null;
let feedRaw = null;

/*
 * ★ 诊断计数（2026-10-18 加的，为 #6）。
 *   为了分清「页面根本没发」和「发了但没生效」—— 光看结果猜不出来。
 */
let sendCount = 0;       // 一共发了几次穿透 IPC
let reassertCount = 0;   // 定期重申触发了几次（主循环那拍）
let shownCount = 0;      // 收到几次「窗口显示了」

/**
 * 真正发一次 IPC。
 * ⚠️ 分出来是为了**能重申**（见下面 reassertMouse）。
 */
function sendMouseMode() {
  sendCount++;
  try { window.yachiyo.win.ignoreMouse(!wantMouse); } catch { /* 桥还没接上就算了 */ }
}

function wantInteractive(on) {
  if (on === wantMouse) return;         // ★ 状态没变就别发 IPC，每帧发会卡
  wantMouse = on;
  sendMouseMode();
}

/*
 * ⚠️⚠️ **定期重申一次穿透状态** —— 2026-10-12 看他的录屏抓出来的真 bug。
 *
 *    症状（录屏第 11 秒）：他右键她，弹出来的却是 **Windows 桌面自己的右键菜单**
 *    （工具/搜索/查看/刷新…）—— 说明那一刻**右键穿透过去了**，被桌面接走。
 *
 *    机制：她的窗口常年是 `setIgnoreMouseEvents(true, {forward:true})`（这样桌面
 *    才点得动），鼠标压到她身上时才**异步发 IPC** 把穿透收回来。
 *    「状态变了才发」那道闸（上面那行 `if (on === wantMouse) return`）本身是对的，
 *    但它有个洞：**IPC 丢了 / 主进程那一下没落地，页面这边并不知道** ——
 *    于是页面以为"已经是收着的"，实际窗口还在穿透，之后所有的按下都会被桌面接走。
 *    手快的时候（鼠标刚挪上去就右键）特别容易撞上，也就是他说的"偶尔"。
 *
 *    ⇒ 每隔约半秒**无条件重申一次**当前想要的状态。
 *      正常时它只是白问一次（主进程那边值没变，开销可以忽略）；
 *      一旦哪次丢了，下一拍就自己纠回来，不用等他重启。
 */
let lastReassert = 0;
function reassertMouse(nowMs) {
  if (nowMs - lastReassert < 500) return;
  lastReassert = nowMs;
  reassertCount++;
  sendMouseMode();
}

/*
 * ★★★ 2026-10-18：**不允许"一次没中就立刻开门"** —— #6 的真正根因在这里。
 *
 *   真机证据（他亲手点 + 系统层面盯 WS_EX_TRANSPARENT，三份日志对到毫秒）：
 *     44.491 页面说"收回穿透" → 44.540 系统层面真变成 transparent=0   ✓ 传输没问题
 *     44.747 「被戳了一下」        → 只有 up 进来了，**down 一条都没有**
 *     45.179 页面说"打开穿透"     → 45.210 系统层面真变了
 *     45.506 又收回 / 45.720 又打开 —— **300ms 内反复开合**
 *   ⇒ 他按下的那一瞬，窗口正好在"打开穿透"的那半拍里，down 直接穿给桌面了。
 *
 *   为什么判定会抖：`hitPet()` 用的是 48×48 的 alpha 掩码（加邻居搜索），
 *   她**呼吸/走路**时 `pos` 一直在动，鼠标压在边缘（发梢、裙角）时
 *   「中/不中」就会来回跳。一次不中 ⇒ 立刻开门 ⇒ 下一次按下就废了。
 *   这也解释了他 10-17 说的那句「她睡觉时才互动」—— 睡着不动，判定就稳。
 *
 *   ⇒ 开穿透要**连续 OFF_GRACE_MS 都不中**才开；中途只要又中了就取消。
 *     关门（收回穿透）仍然**立刻**做 —— 宁可多要一次鼠标，也不要"点不着"。
 *   ⚠️ 光标真的离开整条带时（主进程的 `win:cursor-out`）走 `force`：
 *      那种情况等不到 mousemove，必须按时间硬开，否则桌面点不动。
 */
const OFF_GRACE_MS = 320;

/*
 * ★★★ 2026-10-18：**只留一个权威**（#6 的第五个根因，也是最后一个）。
 *
 *   真机三份日志对齐后看到的事实：
 *     17:29:22.527  页面 want=1 near=1 hit=1      ← 光标确实在她身上
 *     17:29:22.582  IPC 发 ignore=1（要穿）        ← 60ms 后自己顶回去了
 *     17:29:22.683  系统 穿透位=1                  ← 于是按下就丢
 *
 *   为什么：`want` 有**四个东西在改**，时钟各不相同 ——
 *     · `mousemove`（真实事件，不定时）
 *     · 主进程喂坐标（每 120ms）
 *     · `reassertMouse`（每 500ms）
 *     · 开穿透的 320ms 定时器（异步落地）
 *   于是出现「near=1 但 want=0」这种自相矛盾的采样，按下就落在缝里。
 *
 *   ⇒ 改成**单一权威**：只有 `mouseTick()` 会改 `want`，它每 50ms 跑一次，
 *     永远拿**最新的** `lastMouse` 去算 `nearPet`。其他来源**只更新坐标**。
 *     320ms 的宽限仍然保留（连续 320ms 都不中才开穿透），但判定不再由定时器
 *     异步"回查"，而是每拍自然重算 —— 竞态消失。
 */
let mouseTickTimer = null;
let offSince = 0;            // 从什么时候开始"不在她身上"
let lastCompute = { near: null, at: 0 };

function mouseTick() {
  const now = performance.now();
  const has = lastMouse.x >= 0 && lastMouse.y >= 0;
  const near = has ? nearPet(lastMouse.x, lastMouse.y) : false;
  lastCompute = { near, at: now };
  if (dragging) { wantInteractive(true); return; }
  if (near) {
    offSince = 0;
    wantInteractive(true);           // 中了就**立刻**收回穿透
    return;
  }
  if (!offSince) offSince = now;
  if (now - offSince >= OFF_GRACE_MS) wantInteractive(false);   // 连续 320ms 不中才开门
}

function startMouseTick() {
  if (mouseTickTimer) return;
  mouseTickTimer = setInterval(mouseTick, 50);
}

/* 兼容旧调用点：现在它们**只提供坐标**，判定一律交给 mouseTick */
function refreshMouse(e) {
  if (e) lastMouse = { x: e.clientX, y: e.clientY };
  mouseTick();
}

/*
 * ⚠️ 2026-10-12 的老教训留在这儿（别丢）：
 *   这里曾经是 `if (dragging || menuOpen() || panelOpen() || chatOpen()) wantInteractive(true)`
 *   —— 菜单/面板/聊天窗当时都在**这个窗口**里，要让它们能点，只能把整个窗口的穿透关掉；
 *   可这个窗口盖着屏幕，于是**打开一个 212×258 的菜单，整块屏幕都点不到后面的东西了**。
 *   现在那三个各自是独立小窗，主窗口只要管她自己 —— 判定只看「鼠标在不在她身上」。
 */

/*
 * ★ 她什么时候才「看着鼠标」—— 2026-10-17 加的（他报的「眼动跟随全局生效」）。
 *
 *   两道闸，缺一不可：
 *     · `rig.js` 的 `canGaze`：她得**歇着**（走路/跑动时眼睛看路，不追鼠标）
 *     · 这一道：`lastInteract` 得是**最近**的 —— 他碰过她之后的 `gazeFollowSec` 秒内
 *
 *   为什么非加后面这道：主窗口是**整屏宽、贴屏幕底下的那一条**
 *   （`main/index.cjs` 的 `placeWindow`），鼠标在那一条里动一下渲染层就收到 mousemove
 *   —— 她于是从头到尾追着鼠标转眼睛，哪怕他只是路过、根本没打算理她。
 *
 *   ⚠️ 不跟的时候 `_updateGaze` 会把 hx/hy/pupil 送回 0（过弹簧慢慢回正），
 *      所以她看起来是「看回正前方」，不是「眼珠僵住」。
 */
let lastInteract = 0;

/**
 * ★ 他是不是在全屏游戏里（2026-10-17 加的）。
 * 由主进程的 `core/gamedetect.cjs` 判定（全屏 + 进程两条一起看），
 * 通过 `game:changed` 推过来；这里只当标志用，**钉住坐着**在主循环里每帧兜。
 */
let gameMode = false;

/** 记一次「他碰她了」—— 按她 / 拖她 / 双击她 / 右键她都算（见各自的调用点） */
function markInteract() { lastInteract = performance.now(); }

function gazeActive() {
  const sec = Number(CFG.gazeFollowSec);
  if (!(sec > 0)) return false;            // 0 / 坏值 = 干脆不跟
  return performance.now() - lastInteract < sec * 1000;
}

/**
 * 右键 —— **只有点在她身上才弹菜单**。
 *
 * ⚠️⚠️ 2026-10-12 他报的：「右键小菜单应当只有右键点击桌宠才可唤出，
 *    而不是整个桌面范围」。
 *    根因：原来这条监听挂在 `document` 上，而主窗口（以前）盖着整个屏幕 ——
 *    所以满桌面随便哪点右键都会弹出菜单。现在加了 `hitPet()` 这一道。
 *
 * ⚠️ 菜单是**独立小窗口**，位置要主进程换算成屏幕坐标 ——
 *    传过去的 at 是**本窗口内**的坐标（见 main/overlay.cjs 的 ov:open）。
 */
function initContextMenu() {
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (!hitPet(e.clientX, e.clientY)) return;      // 没戳到她 → 什么都不做
    markInteract();                                 // ★ 右键她也是一次互动
    window.yachiyo.ov.open('menu', { at: { x: e.clientX, y: e.clientY } });
  });

  /*
   * 点她就把菜单收掉。
   *
   * ⚠️ 菜单在**另一个窗口**里，它自己收不到「点在菜单外面」那一下 ——
   *    那件事必须由**唯一还能收到鼠标事件的地方**（这儿）来做。
   *    「点外面关菜单」一共三条路，缺一不可：
   *      · 点她        → 这里
   *      · 点桌面/别的应用 → 菜单窗口失焦，自己关（ui/menu.js 的 blur）
   *      · 点菜单卡片外的空白 → 同理（那圈也是那个窗口，pointerdown 兜）
   */
  window.addEventListener('mousedown', () => { window.yachiyo.ov.closeKind('menu'); });
}

/* ============================================================
   拖拽 / 点击
   ============================================================ */

let dragging = null;

cvs.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  markInteract();          // ★ 他按她了 → 接下来这一小段她追鼠标（见 gazeActive）
  wakeUp();                // ★ 睡着的时候拖她/按她，也算「叫她」（见 wakeUp）
  dragging = {
    cx: e.clientX, cy: e.clientY,
    ox: pos.x, oy: pos.y,
    t0: performance.now(),
    moved: 0,
    // 记「上一次转身时鼠标在哪儿」（用的是**累计位移** dx，见下面的翻转判断）
    flipAt: 0,
  };
  stage.classList.add('dragging');
  wantInteractive(true);
  e.preventDefault();
});

window.addEventListener('mousemove', (e) => {
  mouseIdle = 0;
  lastAct = performance.now();
  /*
   * ★ 2026-10-18：留一份**真实 mousemove** 的坐标，专门跟主进程喂过来的那个比。
   *   单位要是对不上（跨进程 + 125% 缩放），差个一两百像素这里立刻看得出来。
   */
  realMove = { x: e.clientX, y: e.clientY, t: performance.now() };
  /*
   * ⚠️ 只比「光标在带里」的那些样本 —— 光标跑出带子时主进程给的 rx/ry 会是负数，
   *    乘出来是个离谱的坐标，算进最大偏差就成了假警报（实测 512px，全是这种）。
   */
  if (feedLast && feedLast.inside) {
    const d = Math.max(Math.abs(realMove.x - feedLast.x), Math.abs(realMove.y - feedLast.y));
    feedErr = Math.max(feedErr || 0, Math.round(d));
  }

  /*
   * ⚠️⚠️ 传进去之前要**除以缩放倍数 k**（2026-10-16 修的）。
   *
   *    `e.clientX - pos.x` 是 **CSS 像素**，而 `rig._updateGaze()` 里
   *    拿它跟 `CANVAS_PX / 2` 比 —— 那是**逻辑单位**（画布恒为 460.8）。
   *    可画布实际占 `CANVAS_PX × k` 个 CSS 像素 ⇒ 不换算的话，
   *    中性点会落在她身宽 **1/(2k)** 的位置上。
   *
   *    他配置里 `petSize: 60`（k=0.6）⇒ 中性点在 **83%** 处，
   *    光标搁画面正中也算出负数 —— **她几乎永远朝左看**，纵向同理偏上。
   *    （他报的原始现象就是「不是 100% 时眼动方向对不上」。）
   */
  if (rig) {
    const k = (CFG.petSize || 100) / 100;
    /*
     * ⚠️ `on` 不再是恒 `true`（2026-10-17 他报的「眼动跟随是全局生效」）。
     *    现在只有**刚互动过**（见 gazeActive / markInteract）才让她追鼠标 ——
     *    光把鼠标挪到屏幕底下那条里，她不再跟了。
     */
    rig.mouse = { x: (e.clientX - pos.x) / k, y: (e.clientY - pos.y) / k, on: gazeActive() };
  }

  if (dragging) {
    const dx = e.clientX - dragging.cx;
    const dy = e.clientY - dragging.cy;
    dragging.moved = Math.max(dragging.moved, Math.hypot(dx, dy));

    /*
     * ★ 面朝方向跟着鼠标走 —— 他 2026-10-12 要的：
     *   「拖动桌宠时桌宠面朝方向和鼠标移动方向同步，落地后保留同步后的面朝方向」。
     *
     * ⚠️ 用**累计位移 dx** + 一个「上次翻身点」做迟滞，而不是看每一帧的增量：
     *    鼠标的增量是抖的（±1px 的杂讯一直有），按增量翻的话她会一路抖着甩头。
     *    现在这样：鼠标往右越过上次翻身点 12px 才朝右，往左同理 ——
     *    手一抖不翻，真往回拖才翻。
     *
     * ⚠️ 「落地后保留」是白送的：`facing` 是模块级的，松手之后没人动它。
     *    （`stepRoam` 只在撞墙那一刻才改它。）
     */
    if (dx - dragging.flipAt > FACE_STEP)      { setFacing(1);  dragging.flipAt = dx; }
    else if (dragging.flipAt - dx > FACE_STEP) { setFacing(-1); dragging.flipAt = dx; }

    setPos(dragging.ox + dx, dragging.oy + dy);
    clampPos(); setPos(pos.x, pos.y);
    return;
  }
  refreshMouse(e);
});

/**
 * 双击判定。
 *
 * ⚠️ 刻意**不用 `dblclick` 事件**：她在窗口里是被 alpha 掩码挡住鼠标的
 *    （见 refreshMouse），`e.detail` / dblclick 那套要靠浏览器自己攒两次
 *    click，中间任何一次 mousedown 被吞掉（拖动起手、菜单抢焦点）就散架了。
 *    自己记时间戳最稳。
 *
 * ⚠️ 也不用「等 260ms 看有没有第二下再决定单击干嘛」那套 ——
 *    那样单击的反馈要迟到四分之一秒，戳一下等半天才吭声，手感很差。
 *    这里**单击立刻做**，第二下到了再把气泡撤掉、换输入条弹出来。
 */
const DBL_MS = 300;
let lastClickAt = 0;

window.addEventListener('mouseup', async (e) => {
  if (!dragging) return;
  const d = dragging;
  dragging = null;
  stage.classList.remove('dragging');
  draggedHandled = true;   // ← 告诉后面那条兜底：这一次已经正常收尾了，别重复处理

  if (d.moved < 6 && performance.now() - d.t0 < 500) {
    const now = performance.now();
    if (now - lastClickAt < DBL_MS) {
      lastClickAt = 0;
      onPetDoubleClick(e);
    } else {
      lastClickAt = now;
      onPetClick();
    }
  } else {
    // 松手才写盘 —— 拖的过程中一直写会把磁盘刷爆
    await window.yachiyo.cfg.patch({ petX: pos.x, petY: pos.y });
    /*
     * ⚠️ 这里原来还有一句 `speak('嘿咻～就放这儿吧')` —— 2026-10-17 他要求删掉：
     *    「删除桌宠拖动放下时的气泡台词『嘿咻~就放这儿吧』」。
     *    拖她本来就是高频动作，每松一次手都蹦一句，久了很吵；
     *    而「放这儿」这件事屏幕上的结果已经说清楚了，不需要嘴再讲一遍。
     *    （单击、双击那些**主动戳她**才触发的台词都留着，只删这一句。）
     */
  }
  refreshMouse(e);
});

/* ────────────────────────────────────────────────────────────────
 * ★★★ 拖拽的兜底（2026-10-12 他报「偶尔拖动不了」的修复）
 *
 * 病根：拖拽只有 `window` 上那三个监听，**没有任何兜底**。
 *   主窗口只有她那么大（一个 461 上下的方框），只要鼠标**先于窗口**跑出方框
 *   （手比窗口快一点点就会发生），`mouseup` 就**再也送不到渲染层**，
 *   于是 `dragging` 永远是 true，而 `refreshMouse()` 里这一句是**永久生效**的：
 *       `if (dragging) { wantInteractive(true); return; }`
 *   ⇒ 指针永远不还给桌面 —— 点不着、拖不动、桌面也点不动，只能重启。
 *   「偶尔」也解释得通：**手慢就没事，手快就中招**。
 *
 * 修法分三层，缺一层都还会漏：
 *   ① 这两条兜底监听挂在 **window 上、且不写 capture**，
 *      所以它们一定排在 cvs / window 那两条正式监听**之后**跑：
 *      · 正式链路正常收尾 → 已经置 `draggedHandled` → 这里直接跳过
 *      · 正式链路没收到 mouseup → 这里接手，**把状态清干净**
 *   ② `blur` 也接一手 —— 拖到一半用 Alt+Tab 切走，同样收不到 mouseup
 *   ③ `mouseleave` 那条加了 `dragging` 判断（见 boot() 里）
 */
let draggedHandled = false;

window.addEventListener('mouseup', (e) => {
  if (!dragging) {
    /*
     * ★★★ **mousedown 丢了的兜底**（2026-10-17 真机抓到的，他报的那个 bug）。
     *
     *   病根（实测记录，不是猜）：鼠标压在她身上时，页面这边 `want=true`
     *   （认为该把穿透收回来），可窗口**还没真正收回**的那几十毫秒里，
     *   **`mousedown` 会被桌面接走**、`mouseup` 却能进来。于是：
     *       dragging 建不起来 → mouseup 里 `if (!dragging) return` → **onPetClick 不执行**
     *   ⇒ 表现就是「点她没音效、没气泡」，而**右键照样能出菜单**
     *     （`contextmenu` 不依赖 mousedown，它自己在 up 之后触发 —— 实测对得上）。
     *   ⇒ 也解释了「她睡着的时候反而点得动」：睡着 = 她不动 ⇒ 鼠标早就落在她身上
     *     ⇒ 穿透早收回了 ⇒ mousedown 能进来。
     *
     *   修法不跟穿透抢时间，而是**让 up 自己就能完成一次点击**：
     *     up 的坐标如果命中了，就当这一下是点她。
     *
     *   ⚠️ 必须用 `e.clientX/Y` 判命中，**不能无脑当点击** ——
     *      `blur` 里那个合成的 mouseup 坐标是 (0,0)，`hitPet(0,0)` 为 false，正好滤掉。
     *   ⚠️ 拖动不受影响：真拖动时 `dragging` 是有的，走下面那条正式链路。
     */
    if (draggedHandled) { draggedHandled = false; return; }   // ★ 正式链路刚处理过，别再点一次
    /*
     * ⚠️⚠️ 两个必须判的（2026-10-17 他实测抓出来的，我第一版都漏了）：
     *   ① **只认左键** —— 不加 `button === 0`，他右键呼菜单时 `mouseup` 也会走这里，
     *      于是"右键出菜单"顺带弹一句互动台词（他说就是这个现象）。
     *   ② **先看 `draggedHandled`** —— 正式链路跑完会把 `dragging` 置 null，
     *      兜底紧接着看到"没有 dragging"就又点一次 ⇒ **一下被算成两下**
     *      ⇒ 撞进双击判定 ⇒ **直接开聊天窗**（他说"未隐藏/显示之前左键点击就直接开聊天框"）。
     */
    if (e && e.button === 0 && typeof e.clientX === 'number' && hitPet(e.clientX, e.clientY)) {
      const now = performance.now();
      if (now - lastClickAt < DBL_MS) {
        lastClickAt = 0;
        onPetDoubleClick();
      } else {
        lastClickAt = now;
        onPetClick();
      }
    }
    return;
  }
  if (draggedHandled) { draggedHandled = false; return; }   // 正式链路已经收过了
  const d = dragging;
  dragging = null;
  stage.classList.remove('dragging');
  draggedHandled = false;
  /*
   * 位置照旧写盘 —— 这是他松手时真正想要的结果。
   * ⚠️ 这里**不**判定单击/双击：正式链路没收到 mouseup，说明指针已经离开窗口，
   *    这一下算不算「点她」说不清，宁可不做，也别让气泡莫名其妙蹦出来。
   */
  if (d.moved >= 6 || performance.now() - d.t0 >= 500) {
    window.yachiyo.cfg.patch({ petX: pos.x, petY: pos.y }).catch(() => {});
  }
  refreshMouse(null);
});

/** 切走窗口（Alt+Tab / Win 键）→ 手上的那次拖拽就此作废，别让她卡住 */
window.addEventListener('blur', () => {
  window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});

/**
 * 她睡着的时候被碰 → **叫醒成坐着**（2026-10-17 他要求的）。
 *
 *   他的原话：「桌宠睡觉状态可以单/双击/拖动唤醒变成坐着状态，而非完全不可互动」。
 *
 *   ⚠️ 原来这条路是**半通**的：`rig.state.rest()` 会把她切到 idle（站着），
 *      而 idle 是「静止池」里的一员 —— 下一拍冷却结束重骰时**可能又骰回 sleep**
 *      （`sinceSleep` 那个守卫只管「刚睡过不能马上又睡」，睡久了就不拦了）。
 *      所以这里显式进 `sit`，并且给一段更长的安静时间。
 *
 *   ⚠️⚠️ **一次点击是两个事件**（mousedown → mouseup），两个地方都会调 wakeUp：
 *      第一次真把她叫起来了，第二次再看 `mode` 已经**不是** sleep —— 要是就这么
 *      返回 false，`onPetClick` 那边就会走 `rig.state.rest()` 把她**又改成站着**。
 *      实测就是这么坏的（探针量到 `sit` 瞬间变 `idle`）。
 *      ⇒ 所以「刚叫醒」也要算数：`WOKE_MS` 之内一律返回 true，别让第二下把她按回站姿。
 *
 *   ⚠️ `rest()` 内部是 `enter('idle')` —— 唤醒之后**不能**再调它。调用点要按返回值分流。
 *
 *   ⚠️⚠️ 还有**另一层「睡」**：主进程 `review.isSleeping()`（准备睡 / 夜间那条链）。
 *      那层页面这边改不了 —— `ui/bubble.js` 里「睡着了一个气泡都不冒」闸的就是它。
 *      也就是说：如果他碰她的时候她正处于那一层，这里把人叫起来了也**不会冒气泡**。
 *      那一层要不要一起改，得他定（2026-10-17 我先把能确定做对的这层做了）。
 *
 * @returns {boolean} 这次该不该「按叫醒处理」（真叫起来了，或者刚刚才叫起来）
 */
const WOKE_MS = 1200;
let wokeAt = 0;

function wakeUp() {
  if (!rig || !rig.state) return false;
  /*
   * ★ 先把**主进程那层**「准备睡」叫醒（2026-10-17 加的）。
   *
   *   「睡」有两层，别只叫一层：
   *     · 视觉层 = rig 的 sleep 姿态（下面这段管）
   *     · **气泡层** = 主进程 `review.isSleeping()` —— `ui/bubble.js` 里
   *       「睡着了一个气泡都不冒」闸的就是它，`chat:send` 还会拿它回「她睡了」
   *   他报的 #4（完全无法互动）确认就是**她当时睡着**：
   *   人坐起来了但不吭声，看着跟没反应一样。
   *
   *   ⚠️ **无条件发**、不看 `rig.state.mode` —— 那一层页面这边看不见，
   *      问了才知道；问了没睡她也不会有副作用（review.wake() 里有 if）。
   */
  try { window.yachiyo.pet.wake(); } catch { /* 桥没接上就算了 */ }

  const now = performance.now();
  if (rig.state.mode === 'sleep') {
    rig.state.enter('sit', '被叫醒');
    rig.state.left = 20;       // ⚠️ 别用 rest()，它会把 sit 改成 idle
    wokeAt = now;
    return true;
  }
  // 刚叫醒的那一下（同一次点击的 mouseup，或者他连着又戳一下）—— 也算
  return now - wokeAt < WOKE_MS;
}

/**
 * ★ 单击的「Q 弹」动效（2026-10-17 他点名要的）。
 *
 *   做法：给 `#pet` 挂一个 260ms 的 transform 动画（压 → 弹过头 → 回位），
 *   幅度和时长走 CSS 变量，由这里的配置实时塞进去 ——
 *   他在「高级 → 单击互动」拖滑块就能当场看出差别，不用改 CSS。
 *
 *   ⚠️ `void el.offsetWidth` 那句**不能删**：连着点她时，同一个 class
 *      第二次加是不重播的（浏览器认为没变）。强制读一次布局能把它"推"回去。
 *   ⚠️ 动画只挂在 `#pet` 的 transform 上，**不碰 rig 的步态/呼吸**
 *      （那套动的是画布里的像素，这个是整张图缩放，互不干扰）。
 *   `config.cjs` 里那三行是 `clickBounce` / `clickBounceMs` / `clickBouncePct`。
 */
function playClickBounce() {
  if (CFG.clickBounce === false) return;
  const el = document.getElementById('pet');
  if (!el) return;
  const pct = Math.max(0, Math.min(15, Number(CFG.clickBouncePct) || 0));
  if (!pct) return;                       // 幅度 0 = 关掉
  const ms = Math.max(120, Math.min(600, Number(CFG.clickBounceMs) || 260));
  el.style.setProperty('--qb', (1 - pct / 100).toFixed(3));
  el.style.setProperty('--qb-up', (1 + pct / 100).toFixed(3));
  el.style.setProperty('--qb-ms', ms + 'ms');
  el.classList.remove('qbounce');
  void el.offsetWidth;                    // ★ 见上面注释：不读一次就不重播
  el.classList.add('qbounce');
  clearTimeout(playClickBounce._t);
  playClickBounce._t = setTimeout(() => el.classList.remove('qbounce'), ms + 80);
}

function onPetClick() {
  if (!rig) return;
  rig.locked = false;
  // 睡着的时候戳她 = 叫醒（坐起来），不是「站住歇着」—— 见 wakeUp 的注释
  const didWake = wakeUp();
  if (!didWake) rig.state.rest();
  // ⚠️ 音效要在**做动作之前**叫 —— play() 是同步起播的，放后面的话
  //    她先站住了、隔一帧才响，听着像延迟
  playSound('click');
  /*
   * ★ 叫醒那一下**不弹**（2026-10-17 的取舍）：人刚坐起来，再"Q 弹"一下太闹；
   *   而且"叫醒"本身已经有视觉变化（躺 → 坐）了，不需要再加一层。
   *   真要改成"叫醒也弹"，把这行换成无条件的 `playClickBounce();` 就行。
   */
  if (!didWake) playClickBounce();
  speak(pick(['嗯？怎么啦～', '在的在的！', '呀，别戳我啦', '要聊天吗？']));
}

/**
 * 双击她 → **直接开聊天窗**（2026-10-17 他改的）。
 *
 *   原来是弹一条 380×56 的「快速问一句」输入条（`ask.html`），问完就没了。
 *     · 他要的：「双击不再呼出打字栏，而是直接呼出聊天框」，而且点名「优先」——
 *       因为它顺带把 #1（聊天窗消息顺序）那条路也简化了。
 *     · 另一条理由也站得住：那个小条**只问不记**，说过的话转头就散；
 *       聊天窗里有历史、能往上翻。双击的意图本来就是「想跟她说句话」。
 *
 *   ⚠️ `ask.html` / `ui/ask.js` 和 overlay 里那个 `ask` 窗格**一起删了** ——
 *      别只改入口：留着没人开的窗口，比没有更难查。
 */
function onPetDoubleClick() {
  if (!rig) return;
  rig.locked = false;
  if (!wakeUp()) rig.state.rest();
  playSound('click');
  api.openChat();
}

/*
 * 快速问一句的回复 —— 冒在头顶的气泡上。
 *
 * ⚠️ 事件名是 `bubble:*` 不是 `chat:*`（见 main/index.cjs 的 runChat）：
 *    聊天窗里正常聊天时不该同时在她头顶冒气泡。
 */
let quickBuf = '';
let quickOn = false;

window.yachiyo.on('bubble:delta', (t) => {
  quickBuf += t;
  quickOn = true;
  streamBubble(quickBuf);
});
window.yachiyo.on('bubble:done', (r) => {
  quickOn = false;
  /*
   * ★ 用主进程给的**成品**把气泡里的原文盖掉（2026-10-16 修的）。
   *   流式推的是原文（带 `[心情 好]` 这类标记），`bubble:done` 里那份
   *   `text` 才是 `brain.reply` 剥干净的。这个回调原来**不接参数**，
   *   所以气泡里一直留着标记。
   */
  if (r && r.text) streamBubble(r.text);
  else if (!quickBuf) streamBubble('……我没想好说什么。');
  settleBubble();          // 说完了才开始数自动关闭
  quickBuf = '';
});
window.yachiyo.on('bubble:error', (msg) => {
  quickOn = false;
  quickBuf = '';
  streamBubble('（说不出来…' + msg + '）');
  settleBubble(6);
});

/**
 * 她开口。有聊天窗就进聊天窗，没有才冒气泡。
 * （音效还没接，后面跟第 4 步的自言语一起做。）
 */
function speak(t) {
  // 聊天窗是独立的小窗，气泡该照样冒（她说话跟他打字是两回事）
  showBubble(t);
}

/**
 * ★ 她自己开口（第 4 步②的自言语）—— 主进程推过来的。
 *
 * ⚠️ 走的是**独立事件**，不是 `bubble:delta` 那条流。
 *    那条是"你问、她流式答"的，会在头顶滚着打字机冒出来；
 *    自言语是**一句完整的话**，直接冒完就完了。
 */
window.yachiyo.on('speak:say', (text, o) => {
  if (!text) return;
  // ⚠️ `o.seconds` = 这条链自己的停留时长（自言语在用；没给就按全局的来）
  showBubble(text, { sticky: false, seconds: o && o.seconds });
});

/**
 * ★ 主进程说「我要睡了 / 我醒了」—— 睡着之后气泡一律不冒。
 *
 * ⚠️ 为什么页面也要拦一道（主进程的 sayIt 不是已经挡了吗）：
 *    主进程挡的是"她要不要开口"，**挡不住"已经发出来的事件"**。
 *    而气泡不止 sayIt 一个来源（`bubble:*` 那条走 runChat 的流就绕开了它），
 *    以后新加的链更容易忘。这条闸搁在气泡自己的出口上，**谁都绕不过去**。
 *    真机探针实测：只加主进程那道时，直接重放 `speak:say` 照样冒泡。
 */
window.yachiyo.on('sleep:changed', (on) => setSleeping(!!on));

/**
 * 「气泡现在忙不忙」—— 自言语那边要问（忙就让人家这一轮）。
 *
 * ⚠️ 判断放在**页面里**、不放在主进程：主进程不知道气泡还在不在屏上
 *    （它是 DOM 里一个 class，只在页面里看得见）。
 *    主进程读这个值靠 `executeJavaScript`（见 main/index.cjs 的 bubbleBusy）。
 */
window.__yachiyoBubbleBusy = () => {
  const el = document.getElementById('bubble');
  return !!el && el.classList.contains('open');
};

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }

/* ============================================================
   走动
   ============================================================ */

/**
 * 她自己走。只有状态机说「在走 / 在跑」时她才挪地方。
 *
 * ⚠️ 走的是 #stage，不是窗口 —— 窗口盖着整个工作区不动，见 main/index.cjs 的注释。
 * ⚠️ 方向用 facing 管：1 朝左（原立绘朝向），-1 朝右。rig.flip 跟着它走。
 */
function stepRoam(dt) {
  // 跟人说话的时候她是站住的 —— 一边聊一边走，聊天窗还得跟着她挪，太晃
  if (!CFG.moveEnabled || dragging) { moving = false; return; }
  const m = rig.mode;
  if (m !== 'walk' && m !== 'run') { moving = false; return; }

  const maxX = Math.max(0, scr.workArea.width - petW());
  // 屏幕窄到装不下她 —— 那她哪儿也去不了，别让下面那套来回翻
  if (maxX <= 0) { moving = false; return; }

  moving = true;
  const base = m === 'run' ? 110 : 52;                       // px / 秒
  const spd = base * ((CFG.moveSpeed || 100) / 100) * ((CFG.activity || 100) / 100) ** 0.35;
  let nx = pos.x + facing * spd * dt;

  /*
   * ---- 撞到屏幕边了 ----
   *
   * ⚠️⚠️ 2026-10-12 他报的：「桌宠移动撞墙后应当**立刻转身并进入歇着状态**，
   *    并且**不会再度就近撞墙**」。
   *
   *    老代码是「先站住 edgePauseSeconds 秒，歇够了再回头」，
   *    用的是同一个 `edgePause` 计时器 + 一个**延后**的转身。三个毛病：
   *      ① 那段「站住」期间 `rig.mode` 还是 walk/run —— **位置不动但脚在动**，
   *         看着就是原地踏步。
   *      ② 转身是**延后**做的。这中间状态机只要换了动作（walk → sit），
   *         `stepRoam` 就整个 return 了，`edgePause` 干等着，
   *         **那个没执行的转身就丢了** —— 等它再走起来，facing 还是朝墙的，
   *         于是**当场又撞一次**。他说的「再度就近撞墙」就是这个。
   *      ③ 撞完没有任何状态反馈，就是贴着边站着。
   *
   *    现在改成一条直线：**贴边 → 当场转身 → 当场进「歇着」**。
   *    没有计时器，也就没有「转身可能丢」这回事。
   */
  if (nx < 0 || nx > maxX) {
    setPos(Math.min(Math.max(0, nx), maxX), pos.y);   // ① 贴到边上，位置就停在这儿

    setFacing(-facing);                                // ② 当场转身（facing 和 flip 一起改）

    // ③ 当场改成「歇着」—— 状态机那边也停，脚才真的不动
    //    ⚠️ 用 rest() 而不是直接改 mode：rest 会走完 onChange→setMode→换套/过渡
    //       那一整条，直接赋值只会让 rig.mode 和 rig.state.mode 对不上
    rig.locked = false;
    rig.state.rest(Number(CFG.edgePauseSeconds ?? 1.4));

    moving = false;
    return;
  }
  setPos(nx, pos.y);
}

/* ============================================================
   配置改动
   ============================================================ */

function applyTheme() {
  document.body.classList.toggle('dark',  CFG.theme === 'dark');
  document.body.classList.toggle('light', CFG.theme !== 'dark');
  if (CFG.accent) document.documentElement.style.setProperty('--accent', CFG.accent);
}

/** 「走动节奏」= 在活跃度上再乘一层 —— 活跃度是「换动作多勤」，这个是「愿不愿意挪窝」 */
const ROAM_K = { active: 1.6, normal: 1, quiet: 0.45 };

function applyActivity() {
  if (!rig) return;
  rig.state.activity = (CFG.activity || 100) * (ROAM_K[CFG.roam] ?? 1);
}

/**
 * 「桌宠移动」开关。
 *
 * ⚠️⚠️ 2026-10-12 他报的：「关闭桌宠移动之后脚还在动，很奇怪」。
 *
 *    这句只管**动画**那一半：关掉时她只允许落在 歇着 / 坐下 / 睡觉
 *    （状态机那边过滤，见 state.js 的 STAY_ONLY）。
 *    位置那一半在 stepRoam 里挡（那句 `if (!CFG.moveEnabled) return`）——
 *    **两处都要**，缺一个就会出现「原地踏步」或者「走了但动画不动」。
 *
 *    还有一件必须当场做的事：关掉的那一瞬间她可能**正在走**。
 *    光是让状态机以后不再骰 walk 没用 —— 当前这个 walk 要走完
 *    2~8 秒才结束，他会以为开关没生效。所以立刻按站住处理。
 */
function applyMoveEnabled() {
  if (!rig) return;
  const on = CFG.moveEnabled !== false;
  rig.state.allowMove = on;
  if (!on) {
    const m = rig.mode;
    if (m === 'walk' || m === 'run' || m === 'jump') rig.state.rest(6);
  }
}

/** 气泡的长相全走 CSS 变量，样式表里只写 var() 不写死值 */
function applyBubble() {
  const r = document.documentElement.style;
  r.setProperty('--bubble-w',   (CFG.bubbleW || 320) + 'px');
  r.setProperty('--bubble-fs',  (CFG.bubbleFontSize || 13.5) + 'px');
  r.setProperty('--bubble-ink', CFG.bubbleTextColor || 'inherit');
  r.setProperty('--bubble-a',   (CFG.bubbleAlpha ?? 92) / 100);
  r.setProperty('--bubble-maxh', CFG.bubbleH > 0 ? CFG.bubbleH + 'px' : 'none');
}

/**
 * 配置变了以后要做什么。
 *
 * ⚠️ 每条设置项都得有落点 —— 面板上能点、点了没反应，比直接报错还气人
 *    （他会以为是自己没点对）。加新项的时候这里必须跟着加一行，
 *    没接上的项在 settings.js 里挂 todo:true 标出来，别装作能用。
 */
function apply(key) {
  switch (key) {
    case 'petSize':   applyScale(); break;
    case 'theme':
    case 'accent':    applyTheme(); break;
    case 'shadow':    cvs.style.filter = CFG.shadow ? '' : 'none'; break;
    case 'gridN':     if (rig) rig.gridN = CFG.gridN; break;
    case 'meshK':     if (rig) rig.meshK = CFG.meshK; break;
    case 'hairK':     if (rig) rig.hairK = CFG.hairK; break;
    case 'breathStyle':   if (rig) rig.breathStyle = CFG.breathStyle; break;
    /*
     * ⚠️ 这里原来有一个 `case 'tiltDeg'`（一个叠在各姿态上的全局倾斜偏移）。
     *    2026-10-12 晚他改了口径 —— **要每个状态单独调**，
     *    于是那五个值改成直接存在 `rig.json` 的 presets 里，
     *    走 `win:set-tilts` 那条 IPC 现改内存（见下面 boot() 里的监听）。
     *    那个配置键已经撤掉，别再加回来 —— 两处管同一件事必然对不上。
     */
    case 'smoothQuality': if (rig) rig.smoothQuality = CFG.smoothQuality; break;
    case 'transitionMs':  if (rig) rig.transitionMs = CFG.transitionMs; break;
    case 'activity':
    case 'roam':      applyActivity(); break;
    case 'moveEnabled': applyMoveEnabled(); break;
    /*
     * ⚠️ 字体和音量都没法「存着等下次用」—— 它们必须**主动落地**：
     *    字体要让每个窗口去 document.fonts 里注册一遍，
     *    音量要刷到已经建好的那些 Audio 实例上。
     *    少一处就是「重开才生效」。
     */
    case 'fontFamily': applyFont(CFG); break;
    case 'soundVolume': applyVolume(); break;
    case 'bubbleW': case 'bubbleH': case 'bubbleAlpha':
    case 'bubbleFontSize': case 'bubbleTextColor': case 'bubbleOverflow':
      applyBubble(); break;
    // alwaysOnTop / petVisible 归主进程管（窗口属性），见 main/index.cjs
  }
}

const api = {
  cfg:     () => CFG,
  setCfg:  async (k, v) => {
    CFG[k] = v;
    apply(k);
    await window.yachiyo.cfg.set(k, v);
    // 菜单是独立窗口，主进程会广播 cfg:changed 过去，那边自己重画
  },
  reset:   async () => {
    CFG = await window.yachiyo.cfg.reset();
    applyTheme(); applyScale();
    showBubble('都恢复成出厂设置啦～');
  },
  openPanel: (page) => { window.yachiyo.ov.open('panel', { page }); },
  /**
   * 打开聊天窗（托盘 / 菜单都走这儿）。
   * ⚠️ 聊天窗是**独立的小窗**，所以开的时候顺手把头顶那个气泡收掉 ——
   *    两个一起出来会叠在同一片地方。
   */
  openChat:  async () => {
    hideBubble();
    window.yachiyo.ov.open('chat');
  },
  /*
   * ⚠️ 这里原来有个 `openAsk()`（弹「快速问一句」那条输入条，双击她时用）——
   *    **2026-10-17 删了**：他要「双击不再呼出打字栏，而是直接呼出聊天框」。
   *    连 `renderer/ask.html`、`renderer/ui/ask.js`、overlay 里那个 `ask` 窗格一起删。
   *    ⇒ 以后要再造「一句话快问」的入口，别复活这条：它**只问不记**，
   *      说过的话转头就散；而聊天窗有历史能往上翻。双击的落点就该是聊天窗。
   */
  quit:      () => window.yachiyo.win.quit(),
};

/* ============================================================
   主循环
   ============================================================ */

let last = performance.now();

function loop(now) {
  requestAnimationFrame(loop);

  // 帧率上限：rAF 跟着屏幕刷新率跑（60 / 144Hz 都有），想省电就隔几帧画一次。
  // ⚠️ last 只在【真正画】的时候更新 —— 没画的那些帧时间照样要算进 dt 里，
  //    不然限到 30fps 她走路速度会跟着慢一半。
  if (CFG.fpsLimit > 0 && now - last < 1000 / CFG.fpsLimit - 1) return;

  const dtMs = Math.min(now - last, 200);
  last = now;
  const dt = dtMs / 1000;

  if (!rig) return;

  // 鼠标静置 —— 状态机的跳跃资格要它
  mouseIdle += dt;
  rig.mouseIdleSec = mouseIdle;

  rig.step(dtMs);
  stepRoam(dt);

  /*
   * ⚠️⚠️ 顺序不能反：**先画，再取掩码**。
   *
   *    原来是 `updateMask(); rig.render();` —— 掩码取的是**上一帧**的画布。
   *    平时没事（差一帧而已），但**第一帧**取的是还没画过的空画布：
   *    掩码整张全透明，`hitPet()` 说她身上一个实心像素都没有。
   *    症状是自检里那句「扫不到她身上的实心像素 —— 掩码是空的？」，
   *    而且**时好时坏** —— 看自检 attach 得多快、正好卡在第几帧。
   *    实测（scripts/_dbg-mask.cjs）：起窗口后第一次问返回 null，
   *    而同一时刻画布上有 1085 个实心采样点 —— 就是这一行造成的。
   *
   * ⚠️ 计数从 0 开始：`maskTick % 4` 让**第 1 帧**就取一次，
   *    这样窗口一出来掩码就是好的，不用等 4 帧。
   */
  rig.render();
  if (maskTick % 4 === 0) updateMask();
  maskTick++;

  /*
   * ★ 打游戏时把她钉在「坐着」（2026-10-17 加的）。
   *
   *   为什么**每帧兜一次**而不是只在事件来的时候设一次：
   *   能改状态的地方太多了（点她 → rest()、冷却结束 → 重骰、被叫醒 → enter('sit')…），
   *   任何一处漏判她就会溜达起来 —— 而他正全屏打着游戏，根本不会去看她。
   *   ⇒ 这里当成**不变量**来维持：只要 `gameMode` 是真，状态不是 sit 就拉回来。
   *   ⚠️ `left = 1e6` 是让她"这一坐永远不结束"（状态机到点会自己换动作）。
   *   ⚠️ 只钉状态，**不碰识屏和自言自语** —— 他明确要求那两条不变。
   */
  if (gameMode && rig && rig.state && rig.state.mode !== 'sit') {
    rig.state.enter('sit', '他在打游戏');
    rig.state.left = 1e6;
  }

  // ★ 每约半秒重申一次「要不要收鼠标」—— 丢了能自愈，见 reassertMouse 的注释
  reassertMouse(now);
}

/* ============================================================
   启动
   ============================================================ */

async function boot() {
  CFG = await window.yachiyo.cfg.all();

  try { scr = await window.yachiyo.win.screen(); } catch { /* 拿不到就用默认值 */ }

  applyTheme();

  const res = await fetch('./assets/rig/rig.json');
  const data = await res.json();

  rig = new Rig(cvs, {
    activity: CFG.activity,
    allowMove: CFG.moveEnabled !== false,
    gridN: CFG.gridN,
    meshK: CFG.meshK,
    hairK: CFG.hairK,
    breathStyle: CFG.breathStyle,
    smoothQuality: CFG.smoothQuality,
    transitionMs: CFG.transitionMs,
    log: (s) => console.log('[rig] ' + s),

    /**
     * 换套了（站 ↔ 坐）—— 让**脚踩在原地不动**。
     *
     * ⚠️ 换套是瞬时的（`setName` 一改就换），而坐姿比站姿矮 58.9 单位，
     *    不补偿的话她坐下的一瞬间会往下弹 40 多像素，站起来又弹回去 ——
     *    看着像在蹦，不像在坐。
     *
     *    做法：记住换套前脚在**屏幕**上的位置（pos.y + 旧套的脚偏移），
     *    换完重新反推出 pos.y，让脚的世界坐标不变。
     */
    // 换套（站↔坐）—— 以前要手工补偿「脚的世界坐标不变」，
    // 现在脚永远被按在地面线上，两套的 footOffset 不同会自动反映到 pos.y 上，
    // 所以这儿只要重新摆一次位置就够了。
    onSetChange: () => { clampPos(); setPos(pos.x, pos.y); },
  });
  await rig.load(data);
  rig.resize(CANVAS_PX, CANVAS_PX);

  // 位置：第一次启动放右下角。纵向没得选 —— 她只能踩在那条线上（见 setPos）
  const w = petW();
  pos.x = (CFG.petX === null || CFG.petX === undefined) ? scr.workArea.width - w - 40 : CFG.petX;
  clampPos();

  initBubble(() => CFG);
  // 音效也是**收函数不收值** —— 设置面板里关掉/调音量要立刻见效
  initSound(() => CFG);
  // 字体不用在这儿单独叫 —— 下面那个 `for (const k of Object.keys(CFG)) apply(k)`
  // 会走到 `case 'fontFamily'`，跟改配置时走的是同一条路（少一条路少一个漏点）
  initContextMenu();

  // 开局把所有配置全应用一遍 —— 只调 applyTheme + applyScale 的话，
  // 上次关掉的影子、调过的网格精度这些要等到他再动一次滑块才生效
  applyBubble();
  for (const k of Object.keys(CFG)) if (k !== 'petSize') apply(k);
  applyScale();

  window.addEventListener('resize', () => { applyScale(); refreshMouse(null); });
  /*
   * ⚠️ `mouseleave` 必须判 `dragging` —— 原来是无条件 `wantInteractive(false)`。
   *    拖到一半鼠标滑出窗口边界是**常事**（窗口只有她那么大），
   *    那一下就穿透了，她当场卡住不动；运气不好连 mouseup 也收不到（见下面的兜底）。
   */
  window.addEventListener('mouseleave', () => {
    rig.mouse.on = false;
    /*
     * ⚠️⚠️ 这里**不再**把穿透打开（2026-10-17 改的，治法见下面那条监听）。
     *
     *   「鼠标离开窗口」原来是页面唯一的判据。可这个窗口常年处于
     *   `setIgnoreMouseEvents(true, {forward:true})`，而 Chromium **在那种状态下会误报
     *   `mouseleave`** ⇒ 于是成了死循环：
     *       收回穿透 → 误报"离开了" → 又把穿透打开 → 鼠标一动又要收回 → …
     *   他按下鼠标的那一下，正好撞在"穿透正开着"的那一半 ⇒
     *   **`mousedown` 被桌面接走**（真机记录：一条 down 都没有，up 却到了）
     *   ⇒ 点她没反应、更拖不动（拖动必须有 mousedown 才能起手）。
     *
     *   ⇒ 打开穿透这件事改由**主进程的守望**来判（`startCursorWatch`）：
     *      它手里有窗口矩形、也能问光标真实位置，分得清"真离开"和"假离开"。
     */
  });

  /*
   * 主进程说「光标出了窗口那条带」—— 这时候等不到 mousemove，
   * 必须让"不中"的计时**立刻开始**（否则桌面点不动）—— 但开不开仍由 mouseTick 统一决定。
   * 页面对 `mouseleave` 只切眼动，不碰穿透。
   */
  window.yachiyo.on('win:cursor-out', () => {
    // 光标出了整条带：等不到 mousemove 了，直接进入"不中"的计时（由 mouseTick 统一收口）
    if (!offSince) offSince = performance.now();
  });

  /*
   * ★★★ 主进程每 120ms 喂一次光标位置（2026-10-18，解 #6 的死锁）。
   *
   *   为什么必须走这条路：`setIgnoreMouseEvents(true,{forward:true})` 在 Windows 上
   *   **只转发 mouseup，不转发 mousemove**（真机日志：move 在 t=46.4s 之后一条都没有，
   *   而 up 一直有到 52s）。页面靠 mousemove 更新 `lastMouse`，一断就冻住
   *   ⇒ 永远判"不在她身上" ⇒ 穿透永远开着 ⇒ **再也点不着，而且自己解不开**。
   *
   *   ⇒ 位置改由主进程喂（它的 `startCursorWatch` 每 120ms 本来就在查光标）。
   *     ⚠️ 主进程**只喂坐标、不改穿透** —— 收不收回仍然只有这里说了算（铁律不破）。
   *     ⚠️ 主进程给的是**屏幕 DIP** 坐标，减掉 `window.screenX/screenY` 才是 client 坐标。
   */
  window.yachiyo.on('win:cursor-pos', (p) => {
    if (!p || typeof p.rx !== 'number') return;
    /* ⚠️ 主进程给的是 0~1 的比例（见那边的注释：绝对坐标跨进程单位对不上） */
    lastMouse = {
      x: Math.round(p.rx * window.innerWidth),
      y: Math.round(p.ry * window.innerHeight),
    };
    feedLast = { x: lastMouse.x, y: lastMouse.y, t: performance.now(), inside: !!p.inside };
    feedRaw = { raw: p.raw, bounds: p.bounds, sf: p.sf, rx: p.rx, ry: p.ry,
                iw: window.innerWidth, ih: window.innerHeight };
    if (!p.inside && !offSince) offSince = performance.now();
    mouseTick();                 // 统一走唯一权威（只更新坐标，判定在 mouseTick 里）
  });

  /*
   * ★★ 主窗口被显示了（2026-10-18 加的，为 #6「隐藏后再显示，左键拖不动」）。
   *
   *   为什么必须有这一条：页面**根本不知道**窗口被藏过又显示过。
   *   它手里只有 `wantMouse`；主进程那边（曾经）私自改过穿透的话，
   *   `wantInteractive(on)` 被「状态没变就别发 IPC」那道闸挡住 ⇒ **永远不重发**。
   *   上一轮那句 show 钩子就是这么把窗口卡在"忽略鼠标"里的。
   *
   *   ⇒ 一被显示，就地**无条件**重申一次（`sendMouseMode()` 不走那道闸）。
   *     ⚠️ 控制点仍然只在页面这边 —— 主进程只发事件，不碰 `setIgnoreMouseEvents`。
   */
  window.yachiyo.on('win:shown', () => {
    sendMouseMode();
    shownCount++;
  });

  /*
   * ★ 打游戏了 / 打完了（2026-10-17 加的，判定在主进程的 core/gamedetect.cjs）。
   *
   *   ⚠️ 这里**只记标志**，真正的"钉住坐着"在主循环里每帧兜（见那边的注释）——
   *      因为能改状态的地方太多，事件来的时候设一次根本兜不住。
   *   ⚠️ 挂到「打完了」就把 `left` 清零，让状态机下一拍自己重选动作：
   *      不然她会一直坐着，得等到下次重启。
   */
  window.yachiyo.on('game:changed', (st) => {
    const on = !!(st && st.on);
    gameMode = on;
    if (!rig || !rig.state) return;
    if (on) {
      rig.state.enter('sit', '他在打游戏');
      rig.state.left = 1e6;
    } else {
      rig.state.left = 0;          // 放开：下一拍冷却结束就换动作
    }
  });

  window.yachiyo.on('cfg:changed', ({ key, value }) => { CFG[key] = value; apply(key); });

  /*
   * ★ 每个姿态的倾斜角被改了（设置面板那 5 个滑块）——
   *   把**内存里这份 rig 参数**同步过去，不然他会看到「拖了没反应，重启才生效」。
   *   ⚠️ 这些值存在 rig.json 的 presets 里（不是 config），所以走的是单独一条事件。
   */
  window.yachiyo.on('win:tilts-changed', (tilts) => {
    if (rig && tilts) rig.setTilts(tilts);
  });

  // 窗口被主进程改了大小（改桌宠大小 / 换分辨率）—— 位置要跟着重算，
  // 因为「地面线」是拿窗口高算出来的
  window.yachiyo.on('win:stage', (box) => {
    if (!box || !box.height) return;
    scr.stage = box;
    clampPos();
    setPos(pos.x, pos.y);
  });
  window.yachiyo.on('tray:open-settings', () => api.openPanel('habit'));
  window.yachiyo.on('tray:open-chat', () => api.openChat());
  window.yachiyo.on('tray:toggle-show', () => { /* 主进程自己管显隐 */ });

  // 自检用的观察窗 —— 外面（scripts/selfcheck.cjs 走 CDP）靠它读她的实时状态、
  // 算鼠标该点哪儿。只是个只读视图，不给外部改内部状态的口子。
  window.__yachiyo = {
    get pos() { return { x: pos.x, y: pos.y }; },
    get size() { return petW(); },
    get rig() { return rig; },
    get cfg() { return CFG; },
    get mouseWanted() { return wantMouse; },
    get setName() { return rig.setName; },
    // 走动相关的两个量 —— 自检量「撞墙后有没有当场转身 + 停住」要用
    get facing() { return facing; },
    get moving() { return moving; },
    /**
     * 把她挪到某个 x —— 自检要造「她正好贴在屏幕边上」这种局面。
     * 光靠等她走过去太慢，撞哪一面墙也不由自己说了算。
     */
    place: (x) => { pos.x = x; clampPos(); setPos(pos.x, pos.y); },
    openChat:  () => api.openChat(),
    /*
     * ⚠️ 这里原来是 `openAsk(x, y)`（双击那条路的入口，自检手动叫它用）——
     *    2026-10-17 跟「快速问一句」一起删了。
     *    双击现在直接走 `openChat()`，探针要验双击就叫 `openChat()`。
     */
    openMenu:  (x, y) => window.yachiyo.ov.open('menu', { at: { x, y } }),
    /**
     * 找一个「确定落在她身上」的窗口坐标 —— 自检点鼠标用。
     *
     * ⚠️ 别拿 stage 的固定比例（比如 45%,60%）去猜：站立和坐姿在框里占的位置
     *    完全不一样，猜偏了鼠标就落在空气上，测试结果变成随机红绿，
     *    还以为是代码坏了。直接扫 alpha 掩码找最靠她重心的一块实心像素。
     */
    hitProbe: () => {
      const w = petW();
      const cx = (MASK - 1) / 2;
      const cy = MASK * 0.55;                 // 她的重心比框中心低一点
      let best = null, bestD = Infinity;
      if (maskData) {
        for (let y = 0; y < MASK; y++) {
          for (let x = 0; x < MASK; x++) {
            if (maskData[(y * MASK + x) * 4 + 3] < 200) continue;
            const d = (x - cx) ** 2 + (y - cy) ** 2;
            if (d < bestD) { bestD = d; best = { x, y }; }
          }
        }
      }
      if (!best) return null;
      return {
        x: pos.x + ((best.x + 0.5) / MASK) * w,
        y: pos.y + ((best.y + 0.5) / MASK) * w,
      };
    },

    /** 穿透判定的中间量 —— 自检里「鼠标挪开了还不恢复穿透」光看结果猜不出来 */
    debug: () => ({
      want: wantMouse,
      last: { ...lastMouse },
      dragging: !!dragging,
      // ⚠️ 菜单/面板/聊天窗现在是独立窗口，**不在这个页面里**，
      //    这儿问不出来。要查它们得另开一个 CDP target（自检里做了）。
      mask: !!maskData,
      hit: lastMouse.x >= 0 ? hitPet(lastMouse.x, lastMouse.y) : null,
      near: lastMouse.x >= 0 ? nearPet(lastMouse.x, lastMouse.y) : null,
      pos: { ...pos },
      /*
       * ★ 穿透诊断（2026-10-18）。#6 查不出来就是因为缺这几个数：
       *   sends=0   ⇒ 页面压根没发（比如 500ms 那拍停了）
       *   sends>0 但主进程 `win:state.ignore` 没跟着变 ⇒ 发是发了，落地失败
       */
      sends: sendCount,
      reasserts: reassertCount,
      showns: shownCount,
      lastReassertAt: lastReassert,
      /*
       * ★ 开穿透的「待发」状态（2026-10-18）：`pending=true` 说明这 320ms 内
       *   判定为"没中"，但还没真的开穿透。点不着的时候先看这个 ——
       *   `pending` 卡住不动 = 判定一直不中（真不在她身上）；
       *   频繁跳 true/false = 掩码判定在抖（那就是 #6 的形状）。
       */
      pending: !!(offSince && performance.now() - offSince < OFF_GRACE_MS),
      pendingSince: offSince,
      nearAt: lastCompute.at,
      /* ★ 坐标系对不对：`feedErr` 是「喂来的坐标」和「真实 mousemove」的最大偏差 */
      feed: feedLast ? { x: feedLast.x, y: feedLast.y } : null,
      feedRaw,
      real: realMove ? { x: realMove.x, y: realMove.y } : null,
      feedErr,
    }),
    speak,
  };

  startMouseTick();          // ★ 穿透判定的唯一时钟（见 mouseTick 的注释）
  console.log('[app] 起来了 —— 她有 ' + rig.currentSet.count + ' 个件');
  requestAnimationFrame(loop);

  setTimeout(() => speak('来啦～'), 900);
}

boot().catch((err) => {
  console.error('[app] 启动失败：' + (err && err.stack || err));
  document.body.innerHTML =
    `<pre style="color:#c33;padding:20px;font:12px/1.6 monospace;white-space:pre-wrap">启动失败：\n${err && err.stack || err}</pre>`;
});
