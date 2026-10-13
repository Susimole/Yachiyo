/**
 * 外壳自检 —— 起一个真的八千代，用 CDP 连进去，把外壳上的东西挨个摸一遍。
 *
 * 为什么不用「改完手动启动看一眼」：
 *   · 看一眼只能看出「她画出来了」，看不出一堆开关是不是真的翻了、配置有没有落盘
 *   · 报错在页面的 console 里，主进程的 stdout 在 Windows 上根本看不见
 *   · 同一个东西改三回、每回都手动跑一遍，人一定会偷懒
 *
 * 跑法：node scripts/selfcheck.cjs
 * 产出：_探针结果\外壳自检-<时间戳>\*.png + report.json
 *
 * ⚠️ 它会真的启一个窗口几秒钟。正在全屏打游戏时别跑（虽然窗口是全穿透的，
 *    但截图会闪一下）。
 */
'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const electronPath = require('electron');

const CDP_PORT = 9333;
const FAKE_PORT = 8788;
const FAKE_URL = `http://127.0.0.1:${FAKE_PORT}`;
const RUN_MS = Number(process.env.SELFCHECK_MS || 42000);
const OUT = path.join('D:\\AI工作目录\\_探针结果', `外壳自检-${stamp()}`);
const SHOT_W = 1000;            // 截图裁成这么宽 —— 全窗 2560px 的图看着太费劲

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/* ============================================================
   CDP 小客户端
   ============================================================ */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pend = new Map();
    this.logs = [];
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pend.has(m.id)) {
        const { res, rej } = this.pend.get(m.id);
        this.pend.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
        return;
      }
      if (m.method === 'Runtime.consoleAPICalled') {
        const text = (m.params.args || [])
          .map((a) => (a.value !== undefined ? a.value : a.description || a.type)).join(' ');
        this.logs.push({ level: m.params.type, text });
      }
      if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails;
        this.logs.push({ level: 'exception', text: (d.exception && d.exception.description) || d.text });
      }
    });
  }

  /**
   * 连上一个 target。
   *
   * ⚠️⚠️ 2026-10-12：菜单 / 面板 / 聊天窗各自是**独立窗口**之后，
   *    一条 CDP 连接只能看到**一个页面** —— 从主窗口那条连接里
   *    执行 `document.getElementById('menu')` 永远是 null（页面里根本没它了）。
   *    所以要按 URL 找对应的 target，一个窗口连一条。
   *
   * @param {string} [urlPart] 目标页面 URL 里要有的一段；不给就连主窗口
   */
  static async attach(urlPart) {
    const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();
    const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    const page = urlPart
      ? pages.find((t) => (t.url || '').includes(urlPart))
      : pages.find((t) => !/(menu|panel|chat|ask)\.html/.test(t.url || ''));
    if (!page) {
      throw new Error(`没找到 target（想要 ${urlPart || '主窗口'}）：` +
        JSON.stringify(pages.map((t) => t.url)));
    }
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP 连不上')), { once: true });
    });
    const c = new CDP(ws);
    await c.send('Runtime.enable');
    // 浮层的 target 不一定给 Page 域（截图那步就没法走）—— 不给也别连不上
    try { await c.send('Page.enable'); } catch { /* 算了 */ }
    return c;
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((res, rej) => {
      this.pend.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pend.has(id)) { this.pend.delete(id); rej(new Error(method + ' 超时')); }
      }, 15000);
    });
  }

  /**
   * 在页面里跑一段表达式，返回它的值。
   * ⚠️ 包的是 async IIFE —— 用普通 IIFE 的话，脚本里写 await 会直接语法错误，
   *    报错还停在「await is only valid in async functions」上，看不出来是包装层的锅。
   */
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expr} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text);
    }
    return r.result.value;
  }

  /** 真的动鼠标（走 CDP 的输入通道，跟真人操作走同一条路） */
  async mouse(type, x, y, button = 'none', clicks = 0) {
    await this.send('Input.dispatchMouseEvent', {
      type, x, y, button, clickCount: clicks, buttons: button === 'left' ? 1 : 0,
    });
  }

  /**
   * 把鼠标挪过去，**并且确认页面真的收到了**。
   *
   * ⚠️ CDP 的 `Input.dispatchMouseEvent(mouseMoved)` 大概每三次会丢一次 ——
   *    实测：发到 (1773,906)，页面那边最后记的还是 (1231,989)（上一处）。
   *    表现就是「穿透该切没切」这条断言时而绿时而红，查半天以为是产品代码的锅。
   *    真实鼠标每秒几十个 mousemove，丢一两个无所谓；CDP 一次只发一个，丢了就是丢了。
   *
   *    重试时故意先偏 1px 再回来 —— 相同坐标的连续事件会被浏览器合并掉。
   */
  async mouseTo(x, y, tries = 6) {
    /*
     * ⚠️⚠️ **先甩开再回来** —— 这是 2026-10-12 加的，治的是一条偶发假红灯。
     *
     *    症状：同一天连跑三次自检，**中间那次挂在「压到她身上 → 收回穿透」**，
     *    诊断写着 `事件到了=false · 页面记的鼠标=(1207,165)` —— 那个 (1207,165)
     *    是自检**自己早先发的那一下「挪开」**，说明后面 5 次 mousemove **一次都没送到**。
     *
     *    实测（单独写了个小实验连打 6 轮）：**每轮前面先来一发远处的 move，
     *    6/6 全中**；不预热直接打，就时不时整串丢光。
     *    原因是主窗口平时是 `setIgnoreMouseEvents(true, {forward:true})`，
     *    事件要经过 Chromium 的转发层才到渲染层 —— 转发有明显迟滞，
     *    第一发经常还没建立起链路就被下一发顶掉了。
     *
     *    ⇒ 每次 mouseTo 开头先往左上角（块外的空地）打一发，让转发层先醒过来。
     *      这一发**不发到目标点上**，所以不会干扰断言。
     */
    await this.mouse('mouseMoved', 900, 120);
    await sleep(90);

    const seen0 = await this.evalJs(`return window.__yachiyo.debug().last;`);
    if (Math.abs(seen0.x - x) <= 2 && Math.abs(seen0.y - y) <= 2) {
      // 极端巧合：上一发之后我们还想再去同一个点 —— 也补一发，保证有事件
      await this.mouse('mouseMoved', x + 3, y + 3);
      await sleep(80);
    }

    const tried = [];
    for (let i = 0; i < tries; i++) {
      if (i > 0) { await this.mouse('mouseMoved', x + 2, y + 2); await sleep(70); }
      await this.mouse('mouseMoved', x, y);
      await sleep(150);
      const seen = await this.evalJs(`return window.__yachiyo.debug().last;`);
      tried.push(`${Math.round(seen.x)},${Math.round(seen.y)}`);
      if (Math.abs(seen.x - x) <= 2 && Math.abs(seen.y - y) <= 2) return true;
    }
    /*
     * ⚠️ 失败时**把每一发之后页面记到的位置都带出去** —— 不然后面只能看到
     *    `事件到了=false`，猜不出是「一发都没到」还是「到了旧位置」。
     */
    this.lastMouseTrace = `目标(${Math.round(x)},${Math.round(y)}) 试了${tries}发，页面依次记到：${tried.join(' → ')}`;
    return false;
  }

  async screenshot(file) {
    // ⚠️ clip 必须包在 {format, clip:{...}} 里，而且 clip.scale 是【必填】的。
    //    漏了不报错，只是一张图都不落盘 —— 这个坑踩过一次。
    const r = await this.send('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: SHOT_W * 2, height: 1200, scale: 0.5 },
    });
    fs.writeFileSync(path.join(OUT, file), Buffer.from(r.data, 'base64'));
    return file;
  }
}

/* ============================================================
   流程
   ============================================================ */

const report = { steps: [], errors: [], notes: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 假模型服务的进程 —— 收尾要关掉，不然下次跑端口被占 */
let fakeProc = null;
/** 她那个进程 —— 提到模块作用域，好让 main() 挂掉的 catch 也能把它收了（见文件末尾） */
let child = null;

function ok(name, detail) { report.steps.push({ name, ok: true, detail }); console.log(`  ✓ ${name}${detail ? ' — ' + detail : ''}`); }
function bad(name, detail) { report.steps.push({ name, ok: false, detail }); report.errors.push(`${name}: ${detail}`); console.log(`  ✗ ${name} — ${detail}`); }

/**
 * 连一个浮层窗口（menu.html / panel.html / chat.html）。
 *
 * ⚠️ 浮层是**独立窗口**，从主窗口那条 CDP 连接里看不见它们的 DOM
 *    （见 app.js 的 `debug()` 注释）。每个浮层要单独连一条。
 * ⚠️ 窗口是**懒建**的 —— 第一次 open 之前 target 根本不存在，
 *    所以这儿要轮询等，不能连一次就放弃。
 */
/**
 * 把上一个跑剩下的 electron 收干净，**并且确认真的收干净了**。
 *
 * ⚠️⚠️ 2026-10-12 踩的：原来就一句 execSync(kill) + sleep(600) 就往下走。
 *    上一个进程（自检自己挂掉那次、或者刚跑完的探针）要是还没退完，
 *    新起的这个一启动就撞**单实例锁**、静默退出，而 CDP 连上的是**旧那个** ——
 *    于是「刚起来菜单就开着」「面板开出来停在别的页」这种看不懂的失败全来了，
 *    而且**时好时坏**（就看上一次退得快不快）。
 *    杀一次不保险，要轮询到进程表里真的没有为止。
 */
function electronKillCmd() {
  const pat = path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\');
  return 'powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | ' +
    `Where-Object { $_.Path -like '${pat}*' } | ForEach-Object { $_.Kill() }"`;
}

function countElectron() {
  try {
    const pat = path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\');
    const out = execSync(
      'powershell -NoProfile -Command "@(Get-Process electron -ErrorAction SilentlyContinue | ' +
      `Where-Object { $_.Path -like '${pat}*' }).Count"`,
      { encoding: 'utf8' });
    return Number(String(out).trim()) || 0;
  } catch { return 0; }
}

async function waitNoElectron(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    if (countElectron() === 0) return true;
    try { execSync(electronKillCmd(), { stdio: 'ignore' }); } catch { /* 没了 */ }
    await sleep(400);
  }
  return countElectron() === 0;
}

async function attachOverlay(urlPart, tries = 20) {
  for (let i = 0; i < tries; i++) {
    try { return await CDP.attach(urlPart); } catch { await sleep(150); }
  }
  return null;
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });

  // ⚠️⚠️ 给她一个**临时身份**，整个自检跑在这个家里。
  //    不隔开的话，自检要试「填个 Key 能不能聊」，就会把假 Key 写进
  //    他真正的 %APPDATA%\Yachiyo\config.json —— 而且自检还会改 petSize、
  //    主题、置顶这些，虽然每次都复位，但不该碰他的东西。
  const TMP_HOME = path.join(ROOT, '_selfcheck-home');
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
  fs.mkdirSync(path.join(TMP_HOME, 'data'), { recursive: true });
  fs.writeFileSync(path.join(TMP_HOME, 'config.json'), JSON.stringify({
    apiBase: FAKE_URL,
    apiKey: 'sk-fake-for-selfcheck',
    model: 'deepseek-flash',
    thinking: true,          // 保留：要验请求体里发没发 thinking / reasoning_effort
  }, null, 2), 'utf8');

  // 假的模型服务 —— 他没填 Key，对话链不能因此就没法验
  fakeProc = spawn(process.execPath, [path.join(__dirname, 'fake-llm.cjs'), String(FAKE_PORT)],
    { stdio: 'ignore' });
  await sleep(700);

  // 清掉上次没退干净的（单实例锁会让这一跑静默退出）——
  // ⚠️ 要**轮询到进程表里真的没有**为止，杀一次不保险（见 waitNoElectron 的注释）
  const clean = await waitNoElectron();
  if (!clean) {
    console.error('还是有一个 electron 没退干净 —— 这一跑的结果不可信，先停下');
    report.errors.push('上一个 electron 没收干净');
    return finish(null);
  }
  await sleep(400);

  console.log('起窗口…');
  child = spawn(electronPath, [
    `--remote-debugging-port=${CDP_PORT}`, ROOT,
  ], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: undefined,
      YACHIYO_MS: String(RUN_MS),
      YACHIYO_HOME: TMP_HOME,          // ← 临时身份，别碰他真的配置
    },
    stdio: 'ignore',
  });

  let cdp = null;
  for (let i = 0; i < 40 && !cdp; i++) {
    await sleep(500);
    try { cdp = await CDP.attach(); } catch { /* 还没起来 */ }
  }
  if (!cdp) { console.error('窗口起不来，放弃'); report.errors.push('CDP 连不上'); return finish(child); }

  console.log('连上了，开始摸…\n');

  /* ---- 1. 她画出来了没有 ---- */
  await sleep(2500);
  const alive = await cdp.evalJs(`
    if (!window.__yachiyo) throw new Error('__yachiyo 没挂上 —— boot() 挂了');
    const r = window.__yachiyo;
    return { parts: r.rig.currentSet.count, mode: r.rig.mode, set: r.setName,
             x: r.pos.x, y: r.pos.y, size: r.size };
  `);
  // ⚠️ 件数别写死一个数 —— 三套各记各的，她开局用哪一套看状态机骰出什么。
  //    2026-10-12 加第三套「睡觉」：单张画好的图，1 个件、没有骨架。
  const wantParts = { side: 17, sit: 16, sleep: 1 }[alive.set] ?? -1;
  if (alive.parts === wantParts) ok('骨架加载', `${alive.set} 套 ${alive.parts} 个件 · 状态 ${alive.mode}`);
  else bad('骨架加载', `${alive.set} 套有 ${alive.parts} 个件，应该是 ${wantParts}`);

  /* ---- 2. 画布真的画上东西了吗（不是一块空白） ---- */
  const painted = await cdp.evalJs(`
    const c = document.getElementById('pet');
    const g = c.getContext('2d');
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let solid = 0;
    for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 40) solid++;
    return { sampled: Math.ceil(d.length / (4 * 97)), solid };
  `);
  if (painted.solid > 20) ok('画面有东西', `采样 ${painted.sampled} 点，${painted.solid} 点有颜色`);
  else bad('画面有东西', `只采到 ${painted.solid} 个有颜色的点，她可能是透明的`);

  await cdp.screenshot('01-她.png');

  // 刚起来的时候浮层就该是关着的 —— 要是这会儿就开着，那是代码自己开的
  // ⚠️ 菜单/面板/聊天窗是**独立窗口**，主窗口的 DOM 里没有它们 ——
  //    以前那句 `document.getElementById('panel').classList.contains('open')`
  //    现在一定抛 null。显隐只有主进程知道，走 ov.isOpen。
  const atBoot = await cdp.evalJs(`
    return { panel: await window.yachiyo.ov.isOpen('panel'),
             menu:  await window.yachiyo.ov.isOpen('menu'),
             chat:  await window.yachiyo.ov.isOpen('chat'),
             ask:   await window.yachiyo.ov.isOpen('ask') };
  `);
  if (!atBoot.panel && !atBoot.menu && !atBoot.chat && !atBoot.ask) ok('开局干净', '菜单/面板/聊天窗/输入条都是关着的');
  else bad('开局干净', `刚起来浮层就开着：${JSON.stringify(atBoot)}`);

  /* ---- 3. 鼠标压到她身上 → 窗口该收鼠标 ---- */
  // ⚠️ 先把她钉在原地别动 —— 她在走动时 pos 每帧都在变，鼠标明明停在空地上，
  //    她走过去撞上来，hitPet 就成 true 了。这一条之前翻过一次车，
  //    不是代码的问题，是自检自己没把变量按住。
  // ⚠️ 光改 state.mode 没用 —— rig.mode 是 Rig.setMode() 设的，两个不同步，
  //    她照样在 stepRoam 里走。她一动 pos 就变，刚取到的「她身上的点」
  //    立刻就不是她身上的了，下一步 mousemove 落在空气上，判定当然不变。
  await cdp.evalJs(`
    const r = window.__yachiyo.rig;
    r.state.mode = 'idle'; r.state.left = 9999; r.state.cool = 0;
    r.setMode('idle');
    return true;
  `);
  // 面板/菜单开着的时候穿透是【故意】关掉的（不然上面的按钮点不着），
  // 拿它俩当背景测穿透必然失败 —— 先收干净。
  const overlays = await cdp.evalJs(`
    return { panel: await window.yachiyo.ov.isOpen('panel'),
             menu:  await window.yachiyo.ov.isOpen('menu') };
  `);
  if (overlays.panel || overlays.menu) {
    report.notes.push(`自检开始时面板/菜单就是开着的（panel=${overlays.panel} menu=${overlays.menu}）—— 已经替它关掉了`);
    await cdp.evalJs(`
      window.yachiyo.ov.closeKind('panel');
      window.yachiyo.ov.closeKind('menu');
      return true;
    `);
    await sleep(200);
    await cdp.mouse('mouseMoved', 900, 120);
    await sleep(120);
  }
  await sleep(200);

  /*
   * ⚠️⚠️ 这条断言**不能一次就判死**（2026-10-12 修的偶发）。
   *
   *    实测：同一天连跑三次，**第一次挂在这儿、后两次全过**。
   *    根因不是产品坏了，是**掩码天生要晚一两帧**：
   *    `updateMask()` 是在主循环里每 4 帧跑一次的，而自检刚把状态机拨回 idle
   *    就立刻来问 —— 那一瞬间 `maskData` 可能还是 null / 旧的空表。
   *    `app.js` 里那套「全透明的采样不许覆盖已有好掩码」是**故意**这么设计的
   *    （防的是启动早期拿空画布把掩码冲掉），所以这里只能**等**，不能逼它。
   *
   *    ⇒ 重试到掩码建好为止，最多 12 次（约 1.2 秒）。
   *      这种「探针自己太急」的假红灯最费时间 —— 报的是「掩码是空的？」，
   *      看着像产品 bug，其实改产品一点用都没有。
   */
  let hit = null;
  for (let i = 0; i < 12; i++) {
    hit = await cdp.evalJs(`
      const r = window.__yachiyo;
      const p = r.hitProbe();
      return p ? { cx: p.x, cy: p.y, before: r.mouseWanted } : null;
    `);
    if (hit) break;
    await sleep(100);
  }
  if (!hit) throw new Error('扫不到她身上的实心像素 —— 掩码一直是空的（等了 1.2 秒）');
  const arrived = await cdp.mouseTo(hit.cx, hit.cy);
  const diag = await cdp.evalJs(`return window.__yachiyo.debug();`);
  if (diag.want === true) ok('压到她身上 → 收回穿透', '真的收到了鼠标事件');
  else bad('压到她身上 → 收回穿透',
    `before=${hit.before} after=${diag.want} 事件到了=${arrived} · 鼠标点=(${Math.round(hit.cx)},${Math.round(hit.cy)}) ` +
    `· 页面记的鼠标=(${Math.round(diag.last.x)},${Math.round(diag.last.y)}) ` +
    `${cdp.lastMouseTrace || ""} · · hit=${diag.hit} mask=${diag.mask} · 她在 ${Math.round(diag.pos.x)},${Math.round(diag.pos.y)} ` +
    `· menu=${diag.menu} panel=${diag.panel}`);

  // 挪到远处的空地 → 该恢复穿透
  // ⚠️ 别用「她左边 + 700px」这种算法 —— 她站在屏幕右侧时会算出窗口外的坐标，
  //    CDP 对越界坐标**一个事件都不派发**（也不报错），页面那头鼠标就停在原地，
  //    症状是「挪开了但穿透没恢复」。改成挑离她最远的那个角，永远在窗口里。
  const away = await cdp.evalJs(`
    const r = window.__yachiyo;
    const w = window.innerWidth, h = window.innerHeight;
    const cx = r.pos.x + r.size / 2, cy = r.pos.y + r.size / 2;
    let best = [60, 60], bd = -1;
    for (const c of [[60,60],[w-60,60],[60,h-60],[w-60,h-60]]) {
      const d = Math.hypot(c[0] - cx, c[1] - cy);
      if (d > bd) { bd = d; best = c; }
    }
    return { x: best[0], y: best[1], d: Math.round(bd) };
  `);
  const awayOk = await cdp.mouseTo(away.x, away.y);
  if (!awayOk) report.notes.push(`鼠标挪到 (${away.x},${away.y}) 一直送不到，穿透这条结果不可信`);
  const d = await cdp.evalJs(`return window.__yachiyo.debug();`);
  if (d.want === false) ok('挪开 → 恢复穿透', '桌面又点得动了');
  else bad('挪开 → 恢复穿透',
    `还占着鼠标；鼠标=${Math.round(d.last.x)},${Math.round(d.last.y)} ` +
    `她在 ${Math.round(d.pos.x)},${Math.round(d.pos.y)} · hit=${d.hit} mask=${d.mask} ` +
    `dragging=${d.dragging}`);

  /* ---- 4. 右键菜单（独立窗口 menu.html） ---- */
  await cdp.mouse('mousePressed', hit.cx, hit.cy, 'right', 1);
  await cdp.mouse('mouseReleased', hit.cx, hit.cy, 'right', 1);
  const mnu = await attachOverlay('menu.html');
  if (!mnu) {
    bad('右键菜单', '右键之后菜单窗口没建出来');
  } else {
    await sleep(500);
    const menu = await mnu.evalJs(`
      const items = [...document.querySelectorAll('#mList .m-item .txt')].map(e => e.textContent);
      const sws = [...document.querySelectorAll('#mList .m-item .sw')].map(e => e.classList.contains('on'));
      const card = document.querySelector('.card').getBoundingClientRect();
      const pad = document.querySelector('.pad');
      return { items, sws,
               w: Math.round(card.width), h: Math.round(card.height),
               winH: window.innerHeight,
               // 自动收高：卡片必须把窗口填满（差 2px 以上 = 窗口比内容大或小）
               fitErr: Math.round(Math.abs(card.height - window.innerHeight)),
               // 内容有没有被切掉
               clipped: pad.scrollHeight > pad.clientHeight + 1 };
    `);
    if (menu.items.length === 5) ok('右键菜单', `${menu.items.join(' / ')}`);
    else bad('右键菜单', `菜单项 ${menu.items.length} 个，应该是 5`);
    if (menu.fitErr <= 2 && !menu.clipped) ok('菜单窗口贴着内容', `卡片 ${menu.w}×${menu.h} · 窗口高 ${menu.winH} · 没有被切`);
    else bad('菜单窗口贴着内容', `卡片高 ${menu.h} / 窗口高 ${menu.winH}（差 ${menu.fitErr}）· 被切=${menu.clipped}`);
    // 开关的 on 必须长在 .sw 自己身上
    const swOn = menu.sws;
    await mnu.screenshot('02-菜单.png');

    /* ---- 5. 切一个开关 → 配置要真的落盘 ---- */
    const swBefore = await mnu.evalJs(`return (await window.yachiyo.cfg.all()).sound;`);
    await mnu.evalJs(`
      const rows = [...document.querySelectorAll('#mList .m-item')];
      rows[1].querySelector('.sw').click();
      return true;
    `);
    await sleep(700);
    const swAfter = await mnu.evalJs(`return (await window.yachiyo.cfg.all()).sound;`);
    if (swBefore !== swAfter) ok('菜单开关', `音效 ${swBefore} → ${swAfter}`);
    else bad('菜单开关', `点了没反应，还是 ${swAfter}`);
    // 切回来
    await mnu.evalJs(`document.querySelectorAll('#mList .m-item')[1].querySelector('.sw').click(); return true;`);
    await sleep(500);
    void swOn;
  }

  /* ---- 6. 从菜单进设置面板 ---- */
  if (mnu) {
    /*
     * ⚠️ **按文字找，别按下标**。
     *    这里原来写的是 `[4]`，于是菜单项一改顺序（2026-10-12 我挪过分组）
     *    它就点到别的项上去了 —— 报出来是"点菜单进面板 失败了"，
     *    看着像面板坏了，其实是测试自己记死了一个会变的数。
     */
    await mnu.evalJs(`
      const it = [...document.querySelectorAll('#mList .m-item')]
        .find(x => x.textContent.includes('API'));
      if (it) it.click();
      return !!it;`);
  }
  const panel = await attachOverlay('panel.html');
  if (!panel) {
    bad('点菜单进面板', '面板窗口没建出来');
  } else {
    await sleep(600);
    const p = await panel.evalJs(`
      return { page: document.querySelector('#navs .nav.on span')?.textContent,
               rows: document.querySelectorAll('#pMain .row').length,
               groups: document.querySelectorAll('#pMain .group').length };
    `);
    if (p.page === 'AI 接入' && p.rows > 0) ok('点菜单进面板', `${p.page} · ${p.groups} 组 ${p.rows} 行`);
    else bad('点菜单进面板', JSON.stringify(p));
    await panel.screenshot('03-面板-AI接入.png');

    /* ---- 7. 五页挨个翻一遍，看有没有报错/空白 ---- */
    const pages = await panel.evalJs(`return [...document.querySelectorAll('#navs .nav')].map(n => n.dataset.k);`);
    for (const k of pages) {
      await panel.evalJs(`document.querySelector('#navs .nav[data-k="${k}"]').click(); return true;`);
      await sleep(350);
      const info = await panel.evalJs(`
        const m = document.getElementById('pMain');
        const rows = m.querySelectorAll('.row').length;
        const bad = [...m.querySelectorAll('svg')].filter(s => s.children.length === 0).length;
        return { rows, bad, h: m.scrollHeight, name: m.querySelector('h2').textContent };
      `);
      if (info.rows > 0) ok(`设置页 ${k}`, `${info.name} · ${info.rows} 行`);
      else bad(`设置页 ${k}`, '一行都没有');
      await panel.screenshot(`04-设置-${k}.png`);
    }

    /* ---- 8. 面板里改一个值 → 配置落盘 + 她会变 ---- */
    await panel.evalJs(`document.querySelector('#navs .nav[data-k="habit"]').click(); return true;`);
    await sleep(300);
    const sizeBefore = await cdp.evalJs(`return window.__yachiyo.size;`);
    await panel.evalJs(`
      const rows = [...document.querySelectorAll('#pMain .row')];
      const row = rows.find(r => r.dataset.rk === 'petSize');
      const sl = row.querySelector('input[type=range]');
      sl.value = 200; sl.dispatchEvent(new Event('input')); sl.dispatchEvent(new Event('change'));
      return true;
    `);
    await sleep(700);
    const sizeAfter = await cdp.evalJs(`return { size: window.__yachiyo.size, cfg: window.__yachiyo.cfg.petSize };`);
    if (sizeAfter.cfg === 200 && Math.abs(sizeAfter.size - sizeBefore * 2) < 1) {
      ok('改桌宠大小', `${Math.round(sizeBefore)}px → ${Math.round(sizeAfter.size)}px`);
    } else {
      bad('改桌宠大小', `cfg=${sizeAfter.cfg} size=${sizeAfter.size}（之前 ${sizeBefore}）`);
    }
    await cdp.screenshot('05-放大200.png');
    await panel.evalJs(`
      const rows = [...document.querySelectorAll('#pMain .row')];
      const row = rows.find(r => r.dataset.rk === 'petSize');
      const sl = row.querySelector('input[type=range]');
      sl.value = 100; sl.dispatchEvent(new Event('input')); sl.dispatchEvent(new Event('change'));
      return true;
    `);
    await sleep(500);

    /* ---- 9. 深色（深浅色在「习惯」页的通用组里，不在高级页） ---- */
    const clicked = await panel.evalJs(`
      document.querySelector('#navs .nav[data-k="habit"]').click();
      const rows = [...document.querySelectorAll('#pMain .row')];
      // ⚠️ 按 **key** 找，不按文案 —— 他改个标签名就把自检搞崩过一次
      const row = rows.find(r => r.dataset.rk === 'theme');
      if (!row) return '没找到主题那一行（data-rk=theme）';
      const btn = row.querySelector('.seg button[data-v="dark"]');
      if (!btn) return '那一行里没有 dark 按钮';
      btn.click();
      return 'ok';
    `);
    if (clicked !== 'ok') bad('切深色', clicked);
    await sleep(600);
    // ⚠️ 主窗口和面板是两个页面，主题都得跟着变（配置是广播的）
    const darkMain  = await cdp.evalJs(`return { dark: document.body.classList.contains('dark'), cfg: window.__yachiyo.cfg.theme };`);
    const darkPanel = await panel.evalJs(`return document.body.classList.contains('dark');`);
    if (darkMain.dark && darkMain.cfg === 'dark' && darkPanel) ok('夜间模式', '主窗口和面板都变深色了');
    else bad('夜间模式', `主窗口=${JSON.stringify(darkMain)} 面板=${darkPanel}`);
    await panel.screenshot('06-深色.png');
    await panel.evalJs(`
      const rows = [...document.querySelectorAll('#pMain .row')];
      const row = rows.find(r => r.dataset.rk === 'theme');
      row.querySelector('.seg button[data-v="light"]').click();
      return true;
    `);
    await sleep(400);

    /* ---- 10. 关面板 → 该把焦点还回去，并恢复穿透 ---- */
    await panel.evalJs(`document.getElementById('pClose').click(); return true;`);
    await sleep(600);
    const closed = await cdp.evalJs(`
      return { open: await window.yachiyo.ov.isOpen('panel'),
               mouse: window.__yachiyo.mouseWanted };
    `);
    if (!closed.open) ok('关面板', `穿透状态 ${closed.mouse}`);
    else bad('关面板', '面板还开着');
  }

  /* ---- 11. 气泡 ---- */
  await cdp.evalJs(`window.__yachiyo.speak('自检：这是一句测试台词，看看气泡贴在哪儿～'); return true;`);
  await sleep(800);
  const bub = await cdp.evalJs(`
    const b = document.getElementById('bubble');
    const r = window.__yachiyo, s = document.getElementById('stage').getBoundingClientRect();
    const bb = b.getBoundingClientRect();
    const petTop = s.top + s.height * 0.25;
    const petLeft = s.left + s.width * 0.26;
    const petRight = s.left + s.width * 0.70;
    return { open: b.classList.contains('open'), x: bb.left, y: bb.top, w: bb.width, h: bb.height,
             petTop, petLeft, petRight, text: document.getElementById('bText').textContent };
  `);
  if (bub.open && bub.text.length > 0) {
    const gapY = Math.round(bub.petTop - (bub.y + bub.h));
    const gapX = Math.round(Math.min(Math.abs(bub.x + bub.w - bub.petLeft), Math.abs(bub.petRight - bub.x)));
    ok('气泡', `宽 ${Math.round(bub.w)} 高 ${Math.round(bub.h)}，离她上方 ${gapY}px、横向压过来 ${gapX}px`);
    if (gapY < 0 || gapY > 60) report.notes.push(`气泡离她头顶 ${gapY}px，看着可能远了`);
  } else {
    bad('气泡', JSON.stringify(bub));
  }
  await cdp.screenshot('07-气泡.png');

  /* ---- 12. 那些「页面改了、主进程要落地」的项 ---- */
  // 面板刚才被关掉了，重新开起来 —— 走 ov.open，不从菜单那条路
  await cdp.evalJs(`await window.yachiyo.ov.open('panel', { page: 'habit' }); return true;`);
  await sleep(700);
  const pnl = (await CDP.attach('panel.html')) || panel;

  /*
   * 置顶：页面改 → 主进程 setAlwaysOnTop 要真的落到窗口上。
   *
   * ⚠️⚠️ 这条断言 2026-10-12 改过：**面板本身就是不置顶的**，
   *    而「不置顶的浮层开着时，主窗口要临时让位」是设计要求 ——
   *    所以面板开着的时候 `win.state().alwaysOnTop` **必然是 false**，
   *    拿它前后对比永远相等，只能得出「主进程没落地」这个错结论。
   *
   *    改成两段，比原来更严：
   *      ① 点开关 → **配置**要翻（这是那个开关真正做的事）
   *      ② 关掉面板 → 窗口落到跟配置一致的值（这才是「落地」）
   */
  const before = await cdp.evalJs(`return (await window.yachiyo.cfg.all()).alwaysOnTop;`);
  await pnl.evalJs(`
    document.querySelector('#navs .nav[data-k="habit"]').click();
    const rows = [...document.querySelectorAll('#pMain .row')];
    const row = rows.find(r => r.dataset.rk === 'alwaysOnTop');
    if (!row) throw new Error('习惯页里找不到「总在最前」那一行');
    row.querySelector('.sw').click();
    return true;
  `);
  await sleep(600);
  const after = await cdp.evalJs(`return (await window.yachiyo.cfg.all()).alwaysOnTop;`);
  if (before !== after) ok('置顶开关 · 配置', `alwaysOnTop ${before} → ${after}`);
  else bad('置顶开关 · 配置', `点了没反应，还是 ${after}`);

  // 面板关掉 → 主窗口该落到跟配置一致的值
  await cdp.evalJs(`window.yachiyo.ov.closeKind('panel'); return true;`);
  await sleep(700);
  const landed = await cdp.evalJs(`
    return { win: (await window.yachiyo.win.state()).alwaysOnTop,
             cfg: (await window.yachiyo.cfg.all()).alwaysOnTop };`);
  if (landed.win === landed.cfg) ok('置顶开关 · 落到窗口', `关掉面板后窗口 = 配置 = ${landed.win}`);
  else bad('置顶开关 · 落到窗口', `配置是 ${landed.cfg}，窗口却是 ${landed.win}`);

  // 切回来（面板重新开起来，后面的用例还要用）
  await cdp.evalJs(`window.yachiyo.ov.open('panel', { page: 'habit' }); return true;`);
  await sleep(600);
  await pnl.evalJs(`
    const rows = [...document.querySelectorAll('#pMain .row')];
    const row = rows.find(r => r.dataset.rk === 'alwaysOnTop');
    row.querySelector('.sw').click();
    return true;
  `);
  await sleep(500);

  /* ---- 13. 走动节奏要真的传到状态机上 ---- */
  // ⚠️ 页面在 pnl 那边，状态机在主窗口这边 —— 点归点、量归量，别混着来
  const roam = await pnl.evalJs(`
    const btns = [...document.querySelectorAll('#pMain .row')]
      .find(r => r.dataset.rk === 'roam')
      .querySelectorAll('.seg button');
    btns[0].click();
    return true;
  `);
  await sleep(400);
  const roamActive = await cdp.evalJs(`return window.__yachiyo.rig.state.activity;`);
  const quiet = await pnl.evalJs(`
    const btns = [...document.querySelectorAll('#pMain .row')]
      .find(r => r.dataset.rk === 'roam')
      .querySelectorAll('.seg button');
    btns[2].click();
    return true;
  `);
  await sleep(400);
  const quietActive = await cdp.evalJs(`return window.__yachiyo.rig.state.activity;`);
  if (roamActive > quietActive && quietActive > 0) {
    ok('走动节奏', `活跃=${roamActive.toFixed(0)} → 安静=${quietActive.toFixed(0)}，状态机跟着变了`);
  } else {
    bad('走动节奏', `活跃=${roamActive} 安静=${quietActive} —— 没传到状态机`);
  }
  void roam; void quiet;
  await pnl.evalJs(`
    const btns = [...document.querySelectorAll('#pMain .row')]
      .find(r => r.dataset.rk === 'roam')
      .querySelectorAll('.seg button');
    btns[1].click();
    return true;
  `);

  /* ---- 14. 气泡的长相项（宽/字号/透明度/字色） ---- */
  await pnl.evalJs(`document.querySelector('#navs .nav[data-k="bubble"]').click(); return true;`);
  await sleep(300);
  const bubBefore = await cdp.evalJs(`
    window.__yachiyo.speak('气泡外观测试台词，看看宽度和字号跟不跟得上配置的变化～');
    await new Promise(r => setTimeout(r, 300));
    const b = document.getElementById('bubble');
    return { w: b.offsetWidth, fs: getComputedStyle(b).fontSize, a: getComputedStyle(b).opacity };
  `);
  await pnl.evalJs(`
    const rows = [...document.querySelectorAll('#pMain .row')];
    for (const [key, val] of [['bubbleW','460'],['bubbleFontSize','18']]) {
      const row = rows.find(r => r.dataset.rk === key);
      const sl = row.querySelector('input[type=range]');
      sl.value = val; sl.dispatchEvent(new Event('input')); sl.dispatchEvent(new Event('change'));
    }
    return true;
  `);
  await sleep(700);
  const bubAfter = await cdp.evalJs(`
    const b = document.getElementById('bubble');
    return { w: b.offsetWidth, fs: getComputedStyle(b).fontSize };
  `);
  if (bubAfter.w > bubBefore.w && parseFloat(bubAfter.fs) > parseFloat(bubBefore.fs)) {
    ok('气泡外观', `宽 ${bubBefore.w}→${bubAfter.w}px · 字号 ${bubBefore.fs}→${bubAfter.fs}`);
  } else {
    bad('气泡外观', `没跟着配置变：${JSON.stringify(bubBefore)} → ${JSON.stringify(bubAfter)}`);
  }
  await cdp.screenshot('08-气泡加宽.png');
  // 复位
  await pnl.evalJs(`
    const rows = [...document.querySelectorAll('#pMain .row')];
    for (const [key, val] of [['bubbleW','320'],['bubbleFontSize','13.5']]) {
      const row = rows.find(r => r.dataset.rk === key);
      const sl = row.querySelector('input[type=range]');
      sl.value = val; sl.dispatchEvent(new Event('input')); sl.dispatchEvent(new Event('change'));
    }
    return true;
  `);
  await sleep(400);

  /* ---- 15. 标了「待接」的项，配置里必须真的存在 ---- */
  const todos = await pnl.evalJs(`
    const out = [];
    // 页面是懒渲染的，逐页翻一遍才看得到所有 todo 标记
    for (const n of [...document.querySelectorAll('#navs .nav')]) {
      n.click();
      await new Promise(r => setTimeout(r, 150));
      for (const el of document.querySelectorAll('#pMain .label .todo')) {
        out.push(el.closest('.label').textContent.replace(/待接/, '').trim());
      }
    }
    return out;
  `);
  ok('待接标记', `${todos.length} 项标着「待接」：${todos.join(' / ')}`);

  /* ============================================================
     16~ 对话链（走本地假模型，不联网、不花钱）
     ============================================================ */

  await cdp.evalJs(`window.yachiyo.ov.closeKind('panel'); return true;`);
  await sleep(400);

  await cdp.evalJs(`window.__yachiyo.openChat(); return true;`);
  const cht = await attachOverlay('chat.html');
  if (!cht) {
    bad('聊天窗打开', '聊天窗窗口没建出来');
  } else {
    await sleep(700);
    const chatUi = await cht.evalJs(`
      const card = document.querySelector('.card').getBoundingClientRect();
      return { open: await window.yachiyo.ov.isOpen('chat'),
               w: Math.round(card.width), h: Math.round(card.height),
               winW: window.innerWidth, winH: window.innerHeight,
               body: document.getElementById('cBody').clientHeight };
    `);
    const filled = Math.abs(chatUi.w - chatUi.winW) <= 2 && Math.abs(chatUi.h - chatUi.winH) <= 2;
    if (chatUi.open && filled && chatUi.body > 60) {
      ok('聊天窗打开', `${chatUi.w}×${chatUi.h}，消息区 ${chatUi.body}px`);
    } else {
      bad('聊天窗打开', JSON.stringify(chatUi));
    }
  }

  // 发一句，看流式 —— 输入框和消息列表都在**聊天窗那个页面**里
  await cht.evalJs(`document.getElementById('cInput').value = '你在吗'; return true;`);
  await cht.evalJs(`document.getElementById('cSend').click(); return true;`);
  await sleep(2600);

  const conv = await cht.evalJs(`
    const rows = [...document.querySelectorAll('#cBody .c-row')];
    const last = rows[rows.length - 1];
    return {
      rows: rows.length,
      mine: [...document.querySelectorAll('#cBody .c-row.user .c-bub')].map(e => e.textContent),
      hers: [...document.querySelectorAll('#cBody .c-row.ai .c-bub')].map(e => e.textContent),
      note: [...document.querySelectorAll('#cBody .c-note')].map(e => e.textContent),
      pending: last ? last.classList.contains('pending') : null,
    };
  `);
  if (conv.mine.includes('你在吗') && conv.hers.length && conv.hers[conv.hers.length - 1].length > 0) {
    ok('一问一答', `她回了「${conv.hers[conv.hers.length - 1]}」`);
  } else {
    bad('一问一答', JSON.stringify(conv));
  }
  if (!conv.pending) ok('流式收尾', '气泡封口了，没卡在「正在说」');
  else bad('流式收尾', '一直在 pending，收尾那步没跑到');
  // ⚠️ 2026-10-12 他说的：「聊天框不必每次对话后都弹出本轮消耗」。
  //    只有出错才在聊天窗里留一行 —— 正常一轮里 c-note 必须是空的。
  if (conv.note.length === 0) ok('聊天窗不留消耗行', '正常一轮没往对话里插流水');
  else bad('聊天窗不留消耗行', `聊完插了 ${conv.note.length} 行：${conv.note.join(' / ')}`);
  await cht.screenshot('09-聊天窗.png');

  // 主进程到底发了什么参数给模型 —— 这才是「接对了没有」的硬证据
  const sent = await (await fetch(`${FAKE_URL}/__last`)).json();
  const b = sent.last?.body || {};
  const sys = (b.messages || []).find((m) => m.role === 'system');
  const checks = [
    ['model 用配置里的值', b.model === 'deepseek-flash', `model=${b.model}`],
    ['带 system 提示词', !!sys && sys.content.length > 50, `system ${sys ? sys.content.length : 0} 字`],
    ['system 里有人格', !!sys && /你是谁/.test(sys.content), ''],
    ['带 thinking 参数', b.thinking?.type === 'enabled', JSON.stringify(b.thinking)],
    ['带 reasoning_effort', b.reasoning_effort === 'low', `reasoning_effort=${b.reasoning_effort}`],
    ['思考模式下不发 temperature', b.temperature === undefined, `temperature=${b.temperature}`],
    ['带历史消息', (b.messages || []).length >= 2, `${(b.messages || []).length} 条`],
  ];
  for (const [name, pass, detail] of checks) {
    if (pass) ok('请求参数 · ' + name, detail);
    else bad('请求参数 · ' + name, detail || '不对');
  }

  // 记账
  const ledger = await cdp.evalJs(`
    const u = await window.yachiyo.usage.get();
    return { calls: u.todayCalls, tokens: u.todayTokens, cost: u.todayCost };
  `);
  if (ledger.calls >= 1 && ledger.tokens > 0) {
    ok('用量记账', `今日 ${ledger.calls} 次 / ${ledger.tokens} token / ¥${ledger.cost.toFixed(5)}`);
  } else {
    bad('用量记账', JSON.stringify(ledger));
  }

  // 落盘：历史 + 账本
  const histFile = path.join(TMP_HOME, 'data', 'chat.jsonl');
  const usageFile = path.join(TMP_HOME, 'data', 'usage.json');
  const hist = fs.existsSync(histFile) ? fs.readFileSync(histFile, 'utf8').trim().split('\n') : [];
  if (hist.length >= 2) ok('对话落盘', `chat.jsonl ${hist.length} 条`);
  else bad('对话落盘', `chat.jsonl 只有 ${hist.length} 条`);
  if (fs.existsSync(usageFile)) ok('账本落盘', 'usage.json 在');
  else bad('账本落盘', 'usage.json 没生成');

  // 多轮：第二句要带上第一句的上下文
  // ⚠️ 得先确认她上一句【说完了】再发 —— 页面里她还没回完时点发送会被
  //    挡住（typing 锁），这时候去查 /__last 看到的还是上一轮的请求，
  //    断言就会「假通过」。
  await cht.evalJs(`
    for (let i = 0; i < 60; i++) {
      if (!document.querySelector('#cBody .c-row.pending')) return true;
      await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('上一轮一直没说完');
  `);
  // 这个词要能命中假服务的关键词表（「报个数」里并没有连续的「报数」两个字，
  // 一开始就是这么翻的车 —— 假服务按全字面匹配，不认中间夹字的）
  await cht.evalJs(`document.getElementById('cInput').value = '报数'; return true;`);
  await cht.evalJs(`document.getElementById('cSend').click(); return true;`);
  await sleep(2600);
  const sent2 = await (await fetch(`${FAKE_URL}/__last`)).json();
  const msgs2 = sent2.last?.body?.messages || [];
  const hasPrevUser = msgs2.some((m) => m.role === 'user' && m.content === '你在吗');
  const hasPrevAi   = msgs2.some((m) => m.role === 'assistant' && m.content.length > 0);
  if (hasPrevUser && hasPrevAi) {
    ok('多轮上下文', `第二句带上了 ${msgs2.length} 条（含上一轮问答）`);
  } else {
    bad('多轮上下文', `带了 ${msgs2.length} 条 · 上一句=${hasPrevUser} 她的回复=${hasPrevAi}`);
  }

  const answered = await cht.evalJs(`
    const hers = [...document.querySelectorAll('#cBody .c-row.ai .c-bub')];
    return hers[hers.length - 1]?.textContent || '';
  `);
  if (/一二三/.test(answered)) ok('读到了内容', `她按关键词回的：「${answered}」`);
  else bad('读到了内容', `她回的是「${answered}」，不是按关键词那句`);

  await cht.screenshot('10-多轮.png');

  // 关掉聊天窗 → 穿透要还回去
  await cdp.evalJs(`window.yachiyo.ov.closeKind('chat'); return true;`);
  await cdp.mouseTo(1500, 100);
  const afterChat = await cdp.evalJs(`
    return { chat: await window.yachiyo.ov.isOpen('chat'),
             mouse: window.__yachiyo.mouseWanted };
  `);
  if (!afterChat.chat && afterChat.mouse === false) ok('关聊天窗', '穿透还回去了');
  else bad('关聊天窗', JSON.stringify(afterChat));

  await sleep(300);
  finish(child);
}

/* ============================================================
   收尾
   ============================================================ */

let finished = false;
function finish(child) {
  if (finished) return;
  finished = true;

  // 页面里的 console 单独收集一遍（主进程那份在 Windows 上看不见）
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  const pass = report.steps.filter((s) => s.ok).length;
  console.log(`\n=== ${pass}/${report.steps.length} 通过 ===`);
  if (report.notes.length) console.log('备注：\n  - ' + report.notes.join('\n  - '));
  if (report.errors.length) console.log('失败：\n  - ' + report.errors.join('\n  - '));
  console.log('产出：' + OUT);

  try { child?.kill(); } catch { /* 已经退了 */ }
  try { fakeProc?.kill(); } catch { /* 没起来 */ }
  setTimeout(() => {
    try {
      require('node:child_process').execSync(
        `powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\')}*' } | ForEach-Object { $_.Kill() }"`,
        { stdio: 'ignore' }
      );
    } catch { /* 干净退了 */ }
    process.exit(report.errors.length ? 1 : 0);
  }, 800);
}

main().catch((err) => {
  console.error('自检自己挂了：', err);
  report.errors.push('自检脚本异常：' + err.message);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  /*
   * ⚠️⚠️ 挂了也必须把她杀掉。
   *
   *    2026-10-12 踩的：这条 catch 原来只 process.exit(1) —— Electron
   *    还活着、还占着**单实例锁**。下一次自检 spawn 出来的进程一启动就
   *    「已经有一个八千代在跑了」自己退了，而 CDP 连上的是**上一跑那个**
   *    （还带着上一跑开着的菜单/面板）。
   *    症状 = 「刚起来浮层就开着」「面板开出来停在别的页」这种看不懂的失败，
   *    查了半天才发现是尸体在作答。
   */
  try { child?.kill(); } catch { /* 已经没了 */ }
  try { fakeProc?.kill(); } catch { /* 没起来 */ }
  try {
    require('node:child_process').execSync(
      `powershell -NoProfile -Command "Get-Process electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${path.join(ROOT, 'node_modules', 'electron').replace(/\\/g, '\\\\')}*' } | ForEach-Object { $_.Kill() }"`,
      { stdio: 'ignore' }
    );
  } catch { /* 干净退了 */ }
  process.exit(1);
});
