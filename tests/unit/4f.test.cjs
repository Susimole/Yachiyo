/**
 * 自检 · 识屏（B）
 *
 * ⚠️ 抓屏那两条路（desktopCapturer / GDI）**在 node 里跑不了** ——
 *    一个要 Electron，一个要真截屏。所以这里钉的是**能在 node 里跑的那部分**：
 *    · 取样判黑（旧工程 O80 的坑：点太稀会把深色主题当成全黑）
 *    · 哈希去重
 *    · 时段倍率 / 排期 / 每日上限 / 五道闸
 *    · 提示词那一块
 *    真机那两条路由 `probe-screen.cjs` 验。
 *
 * ⚠️ 跑在隔离目录里。跑法：node scripts/selfcheck-4f.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const STARTED = Date.now();
const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.join(ROOT, '_selfcheck-home-4f');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.YACHIYO_HOME = HOME;

const cfg = require(path.join(ROOT, 'src/core/config.cjs'));
cfg.load();

const T = require(path.join(ROOT, 'src/core/text.cjs'));
const store = require(path.join(ROOT, 'src/core/store.cjs'));
const capture = require(path.join(ROOT, 'src/core/capture.cjs'));
const peeker = require(path.join(ROOT, 'src/core/peeker.cjs'));
const prompt = require(path.join(ROOT, 'src/core/prompt.cjs'));
const heartbeat = require(path.join(ROOT, 'src/core/heartbeat.cjs'));

const out = [];
const chk = (name, ok, detail) => {
  out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail != null ? '  —— ' + detail : ''}`);
};

/* ── 造一张假 BGRA 位图 ── */
function bmp(w, h, level) {
  const b = Buffer.alloc(w * h * 4);
  for (let i = 0; i < b.length; i += 4) { b[i] = level; b[i + 1] = level; b[i + 2] = level; b[i + 3] = 255; }
  return b;
}
/** 全黑，但只在**最边上**亮 → 取样应该还是判黑（取样点避开了边） */
function bmpEdgeLit(w, h) {
  const b = bmp(w, h, 0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < w * 0.03 || x > w * 0.97 || y < h * 0.03 || y > h * 0.97) {
      const i = (y * w + x) * 4; b[i] = 255; b[i + 1] = 255; b[i + 2] = 255;
    }
  }
  return b;
}

/* ═══════════════════════════════════════════════════════ */

(async () => {
  /* ── 取样判黑 ── */
  console.log('\n【取样判黑（旧工程 O80 的坑）】');
  const W = 1280, H = 720;
  chk('  全亮的图 → 不是黑', capture.sample(bmp(W, H, 200), W, H).blank === false, '');
  chk('  纯黑图 → 判黑', capture.sample(bmp(W, H, 0), W, H).blank === true, '');

  const dark = capture.sample(bmp(W, H, 10), W, H);
  chk('★ 亮度 10（全都低于阈值 12）→ 判黑', dark.blank === true, `max=${dark.max} lit=${dark.lit}`);

  const dim = capture.sample(bmp(W, H, 14), W, H);
  chk('★ 亮度 14（刚过阈值 12）→ **不判黑**（深色主题不该被当成黑）',
    dim.blank === false && dim.lit === 25, `max=${dim.max} lit=${dim.lit}`);

  const edge = capture.sample(bmpEdgeLit(W, H), W, H);
  chk('★ 只有**最边上**亮 → 还是判黑（取样点避开边，不然任务栏会把黑屏救回来）',
    edge.blank === true, `lit=${edge.lit} max=${edge.max}`);

  const big = capture.sample(bmp(2560, 1440, 200), 2560, 1440);
  chk('  2560×1440 也数得出 25 个点', big.lit === 25, `lit=${big.lit}`);
  chk('  刚好 25 个点（5×5）', capture.sample(bmp(W, H, 200), W, H).lit === 25, '');
  chk('  尺寸给 0 也不炸（当黑处理）', capture.sample(bmp(10, 10, 200), 0, 0).blank === true, '');

  /* ── 哈希 ── */
  console.log('\n【哈希去重】');
  const a1 = Buffer.from('一模一样的内容');
  const a2 = Buffer.from('一模一样的内容');
  const b1 = Buffer.from('稍微不一样的内');
  chk('  同样内容 → 同一个哈希', capture.hashOf(a1) === capture.hashOf(a2), '');
  chk('  差一个字 → 不同哈希', capture.hashOf(a1) !== capture.hashOf(b1), '');

  /* ── 时段倍率 ── */
  console.log('\n【时段倍率】');
  const reset = () => {
    peeker._reset();
    heartbeat._reset();
    cfg.patch({
      AiEnabled: true, screenEnabled: true, screenEveryMinutes: 12, screenCapture: 'auto',
      screenMaxPerDay: 0, screenShots: 1, screenShotGapSeconds: 6,
      screenTimeFactors: true, screenDayFactor: 1, screenEveningFactor: 1, screenNightFactor: 3,
      screenUseForeground: true, screenAvoidRepeat: true, screenQuietWhenGaming: false,
    });
    peeker.attach({ say: () => { }, onLook: () => { }, thinking: () => false, sleeping: () => false });
    /*
     * ⚠️ **"真去看一眼"换成假的** —— node 里没有 desktopCapturer，
     *    真那个必然失败，而且它是异步的、会把 `busy` 占住 → 后面的闸全测不到。
     *    闸的逻辑跟"怎么截屏"是两件事，分开测。
     */
    peeker._setLook(async () => ({ ok: false, why: '（自检：假装看了）', look: null }));
  };
  reset();
  chk('  白天 10 点 → 1', peeker.factor(new Date(2026, 9, 13, 10)) === 1, String(peeker.factor(new Date(2026, 9, 13, 10))));
  chk('★ 深夜 1 点 → 3（旧工程默认 ×3，深夜别那么吵）',
    peeker.factor(new Date(2026, 9, 13, 1)) === 3, String(peeker.factor(new Date(2026, 9, 13, 1))));
  cfg.set('screenTimeFactors', false);
  chk('  倍率关掉 → 恒 1', peeker.factor(new Date(2026, 9, 13, 1)) === 1, '');
  reset();
  cfg.set('screenNightFactor', 0.6);
  chk('★ 倍率调小 → 不会掉到 0（不然她会**一直**截屏）',
    peeker.factor(new Date(2026, 9, 13, 1)) >= 0.5, String(peeker.factor(new Date(2026, 9, 13, 1))));
  cfg.set('screenNightFactor', 999);
  chk('★ 倍率调太大 → 夹到 10', peeker.factor(new Date(2026, 9, 13, 1)) === 10, String(peeker.factor(new Date(2026, 9, 13, 1))));
  reset();

  /* ── 排期 ── */
  console.log('\n【排期：时间可设】');
  const intervals = [];
  for (let i = 0; i < 6; i++) intervals.push(Math.round((peeker.schedule(new Date(2026, 9, 13, 10)) - new Date(2026, 9, 13, 10).getTime()) / 60000));
  chk('★ 间隔就是配置那个数 × 倍率（白天 ×1）', intervals.every((m) => m === 12), `${intervals.join('/')} 分钟`);

  cfg.set('screenEveryMinutes', 5);
  chk('★ **时间可设**：改成 5 → 5 分钟一跳',
    Math.round((peeker.schedule(new Date(2026, 9, 13, 10)) - new Date(2026, 9, 13, 10).getTime()) / 60000) === 5, '');
  cfg.set('screenEveryMinutes', 0);
  chk('★ 填 0 → 不会变成"每 5 秒截一次"（夹到最少 1 分钟）',
    Math.round((peeker.schedule(new Date(2026, 9, 13, 10)) - new Date(2026, 9, 13, 10).getTime()) / 60000) >= 1, '');
  cfg.set('screenEveryMinutes', 12);
  cfg.set('screenTimeFactors', true);
  cfg.set('screenNightFactor', 3);
  chk('★ 深夜那一跳真的 ×3（12 → 36）',
    Math.round((peeker.schedule(new Date(2026, 9, 13, 1)) - new Date(2026, 9, 13, 1).getTime()) / 60000) === 36, '');
  reset();

  /* ── 五道闸 ── */
  console.log('\n【五道闸】');
  /*
   * ⚠️ `tick` 里**一到点就先排下一次**（故意的，见 peeker.js 的注释）——
   *    所以**每测一道闸都得重新让它到点**，只设一次的话第二道闸就永远"还没到点"。
   *    第一版就是这么红的。
   */
  const due = () => peeker._setNextAt(Date.now() - 1000);
  /** ⚠️ 让假的 look 那趟异步跑完、把 busy 放掉（不然下一道闸永远拿到"上一眼还没看完"） */
  const settle = () => new Promise((r) => setTimeout(r, 20));

  cfg.set('screenEnabled', false); due();
  chk('① 识屏关着 → 不看', peeker.tick(0) === '识屏关着', peeker.tick(0));
  reset();

  cfg.set('AiEnabled', false); due();
  chk('  总开关关着 → 不看', peeker.tick(0) === '总开关关着', '');
  reset();

  peeker._setNextAt(Date.now() + 600000);
  chk('  还没到点 → 不看', peeker.tick(0) === '还没到点', '');
  reset();

  /*
   * ⚠️ 「不看自己」那条**在 node 里测不了** —— 它要等截屏成功之后才走到
   *    「前台是我们自己的进程吗」那一步，而 node 里没有 desktopCapturer。
   *    这里改测**它依据的那个东西**：进程 id 对不对得上。
   */
  capture.setOwnPid(process.pid);
  chk('★ "不看自己"依据的进程 id 设对了', capture._state().ownPid === process.pid, String(capture._state().ownPid));
  chk('  ★ 他没走、她闲着 → 看一眼', (() => { due(); return peeker.tick(0) === '看一眼'; })(), '');
  await settle();
  reset();

  due();
  const away = peeker.tick(45);
  chk('★ 他已离开 45 分钟 → 跳过', away === '他不在（不看）', away);
  chk('  ★ 但**把下一次排好了**（不然他回来那一拍会立刻截）', peeker.nextAt() > Date.now(), '');
  reset();

  peeker.attach({ say: () => { }, onLook: () => { }, thinking: () => true, sleeping: () => false });
  due();
  /* ⚠️ 传 0 不传 45 —— 45 分钟超过「他不在」的 30 分钟门槛，
     **第一道闸就拦了**，走不到「她正忙」那一步（第一版就是这么红的）。 */
  chk('  她正在想别的（说话中）→ 跳过', (() => { due(); return peeker.tick(0) === '她正忙'; })(), '');
  await settle();
  reset();

  peeker.attach({ say: () => { }, onLook: () => { }, thinking: () => false, sleeping: () => true });
  due();
  chk('  「准备睡」挡着 → 跳过', (() => { due(); return peeker.tick(0) === '准备睡中'; })(), '');
  await settle();
  reset();

  /* ── 每日上限 ── */
  console.log('\n【每日上限】');
  reset();
  cfg.set('screenMaxPerDay', 2);
  peeker._bumpToday(); peeker._bumpToday();
  chk('★ 到上限 → 不看', (() => { due(); return peeker.tick(0) === '今天看够了'; })(), '');
  await settle();
  cfg.set('screenMaxPerDay', 0);
  reset();
  chk('★ 0 = 不限（旧工程拍板：识屏本身就有间隔，再限次数中午就用光了）',
    peeker.countToday() === 0, '');

  /* ── 提示词 ── */
  console.log('\n【提示词那一块】');
  reset();
  chk('  没看过 → 那一块整个不出现', peeker.buildBlock() === '', '');
  chk('★ 没看过时系统提示词里也没有「你刚看了一眼他屏幕」',
    !/你刚看了一眼他屏幕/.test(prompt.buildSystem({ userText: '你好' })), '');

  peeker._setLastLook({
    text: '峡谷里雾挺大的，他站在悬崖边上。', work: '摸鱼',
    at: Date.now(), title: 'ELDEN RING', proc: 'eldenring.exe',
  });
  const blk = peeker.buildBlock();
  chk('★ 看过之后出现了', /你刚看了一眼他屏幕/.test(blk), '');
  chk('  带上了他看到的东西', /峡谷里雾挺大的/.test(blk), '');
  chk('★ 带上了前台窗口标题（不截图也知道他在干嘛）', /ELDEN RING/.test(blk), '');
  chk('★ 带上了 [工作]/[摸鱼] 那个状态', /摸鱼/.test(blk), '');
  chk('  真的进了系统提示词', /你刚看了一眼他屏幕/.test(prompt.buildSystem({ userText: '嗯' })),
    // ⚠️ 红的时候要能一眼看出是"哪一步断了"：是那一块本身空了，还是没接进提示词
    peeker.buildBlock() ? '（那一块有内容，是没接进提示词）' : '（那一块本身是空的）');

  chk('★ 过了保鲜期（10 分钟）→ 当没有',
    (() => {
      peeker._setLastLook({ text: '旧的', work: '其他', at: Date.now() - (peeker.LOOK_FRESH_MS + 60000) });
      return peeker.lastLook() === null && peeker.buildBlock() === '';
    })(), '');
  reset();

  /* ── 跨轮去重 ── */
  console.log('\n【跨轮去重（画面没变就不看）】');
  reset();
  chk('  第一次（没有上一次的哈希）→ 不算重复', peeker.isSameAsLast('ABC') === false, '');
  peeker._setLastHash('ABC');
  chk('★ 哈希一样 → 判重复（他一直盯着同一个页面，她没必要每 12 分钟念一遍）',
    peeker.isSameAsLast('ABC') === true, '');
  chk('  哈希变了 → 不重复', peeker.isSameAsLast('XYZ') === false, '');
  reset();

  /* ── 解析她的回复 ── */
  console.log('\n【解析她的话（开头/末尾的状态标签）】');
  const p1 = peeker.parseLook('他在打 Boss，血条快空了。[摸鱼]');
  chk('★ 末尾的 [摸鱼] 抠出来了', p1.work === '摸鱼', p1.work);
  chk('  正文里不留标签', !/\[摸鱼\]/.test(p1.text), p1.text);

  const p2 = peeker.parseLook('[工作] 屏幕上是代码，他改了半天了。');
  chk('★ 开头的 [工作] 也认', p2.work === '工作', p2.work);
  chk('  正文里不留标签', !/\[工作\]/.test(p2.text), p2.text);

  const p3 = peeker.parseLook('看不出在干嘛。');
  chk('  没标签 → 归「其他」', p3.work === '其他', p3.work);

  const p4 = peeker.parseLook('[别的] 乱写的标签');
  chk('  乱写的标签不算，也归「其他」', p4.work === '其他', p4.work);

  /* ── 心跳挂钩子 ── */
  console.log('\n【心跳挂上识屏那条】');
  reset();
  /*
   * ⚠️ 五个钩子**一次性挂齐、推同一个计数器**。
   *    第一版把 screen 推到一个数组、另外四条推到另一个对象，断言读的是对象 ——
   *    screen 永远是 0，红得莫名其妙（**测试自己的锅**）。
   */
  const hit = { review: 0, selfTalk: 0, autoExit: 0, profile: 0, screen: 0 };
  for (const n of Object.keys(hit)) heartbeat.on(n, () => { hit[n]++; });
  heartbeat._setIdleMinutes(() => 0);
  heartbeat.tick(new Date());

  chk('★ 心跳一拍里识屏那条被叫了', hit.screen === 1, `${hit.screen} 次`);
  chk('★ 五条链在**同一拍**里都被叫了（别为了加识屏把哪条挤掉了）',
    Object.values(hit).every((v) => v === 1), JSON.stringify(hit));
  chk('  认得出是哪条没挂上（红的时候直接看这个）',
    Object.entries(hit).filter(([, v]) => v !== 1).map(([k]) => k).join(',') || '（都挂上了）', '');

  /* ── 隔离 ── */
  console.log('\n【隔离检查】');
  const REAL = 'C:\\Users\\Susim\\AppData\\Roaming\\Yachiyo';
  chk('跑在隔离目录里', HOME.includes('_selfcheck-home-4f'), HOME);
  chk('  他真那份的识屏状态没被动过',
    !fs.existsSync(path.join(REAL, 'data', 'state', 'screen.json'))
    || fs.statSync(path.join(REAL, 'data', 'state', 'screen.json')).mtimeMs < STARTED, '');

  console.log('\n' + '─'.repeat(52));
  const pass = out.filter((x) => x.ok).length;
  console.log(`  ${pass}/${out.length} 通过  ${pass === out.length ? '✓ 全过' : '✗ 有失败'}`);
  console.log('─'.repeat(52) + '\n');
  const bad = out.filter((x) => !x.ok);
  if (bad.length) { console.log('失败明细：'); for (const b of bad) console.log(`  - ${b.name}: ${b.detail}`); }
  process.exit(pass === out.length ? 0 : 1);
})().catch((e) => { console.error('\n自检自己炸了：', e.stack || e.message); process.exit(1); });
