/**
 * 自检 · 第 4 步 ②（自言语 + 准备睡 + 自动关闭）
 *
 * **纯数据层，不起窗口，不发真请求**。
 *
 * ⚠️ **必须跑在隔离目录里**（`YACHIYO_HOME`）——
 *    不然它会往他的真数据里写"见过活人""今天延过关机"这些标记，
 *    还会把自言语的"最近说过什么"塞进他真那份。
 *
 * 跑法：node scripts/selfcheck-4b.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const STARTED = Date.now();
const ROOT = path.resolve(__dirname, '..');
const HOME = path.join(ROOT, '_selfcheck-home-4b');

// ★ 隔离：必须在 require 任何 core 模块**之前**设好
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.YACHIYO_HOME = HOME;

const cfg = require(path.join(ROOT, 'src/core/config.cjs'));
cfg.load();

const T = require(path.join(ROOT, 'src/core/text.cjs'));
const store = require(path.join(ROOT, 'src/core/store.cjs'));
const prompt = require(path.join(ROOT, 'src/core/prompt.cjs'));
const mood = require(path.join(ROOT, 'src/core/mood.cjs'));
const her = require(path.join(ROOT, 'src/core/heritems.cjs'));
const review = require(path.join(ROOT, 'src/core/review.cjs'));
const selftalk = require(path.join(ROOT, 'src/core/selftalk.cjs'));
const autoexit = require(path.join(ROOT, 'src/core/autoexit.cjs'));
const heartbeat = require(path.join(ROOT, 'src/core/heartbeat.cjs'));
const provider = require(path.join(ROOT, 'src/core/provider.cjs'));

const out = [];
const chk = (name, ok, detail) => {
  out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail != null ? '  —— ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── 假服务 ───────────────────────────────────────────── */

let mockReply = '今天有点想喝豆浆。';
let mockCalls = 0;
let mockThrows = null;
let lastReq = null;
const realChat = provider.chat;
provider.chat = async (o) => {
  mockCalls++;
  lastReq = o;
  if (mockThrows) throw new Error(mockThrows);
  return { text: mockReply, usage: { prompt_tokens: 100, completion_tokens: 10 } };
};

/* ── 收集"她说了什么" ─────────────────────────────────── */

const said = [];
let busyFlag = false;
let sleepingFlag = false;
let quitCalled = 0;
let reviewBusyFlag = false;

function wire() {
  selftalk.attach({
    say: (t, o) => said.push({ t, kind: (o || {}).kind }),
    busy: () => busyFlag,
    sleeping: () => sleepingFlag,
  });
  autoexit.attach({
    say: (t, o) => said.push({ t, kind: (o || {}).kind }),
    quit: () => { quitCalled++; },
    reviewBusy: () => reviewBusyFlag,
  });
}

function resetAll() {
  said.length = 0;
  mockReply = '今天有点想喝豆浆。';
  mockCalls = 0; mockThrows = null; lastReq = null;
  busyFlag = false; sleepingFlag = false; quitCalled = 0; reviewBusyFlag = false;
  selftalk._reset(); autoexit._reset(); review._reset(); heartbeat._reset();
  mood._reset(); her._reset();
  cfg.patch({
    AiEnabled: true, apiKey: 'sk-test-selfcheck',
    SelfTalkEnabled: true, SelfTalkMinMinutes: 20, SelfTalkMaxMinutes: 60,
    SelfTalkTimeFactors: true, SelfTalkDayFactor: 1.5, SelfTalkEveningFactor: 1, SelfTalkNightFactor: 2,
    SelfTalkAvoidRepeat: true, SelfTalkUseWeather: true,
    AutoExitEnabled: true, AutoExitIdleMinutes: 60,
  });
  wire();
}

/**
 * 让她"立刻到点"。
 *
 * ⚠️ 它写的是**盘上**那份（`_setNextAt` 走的跟真实路径同一条）。
 *    写内存的话会被 `tick` 里那次 `restoreSchedule`（读盘）盖掉 ——
 *    排期只有一个出处，测试也得遵守。
 */
const due = () => selftalk._setNextAt(Date.now() - 1000);

/** 等自言语那趟跑完 */
async function waitSay(ms = 2000) {
  const t0 = Date.now();
  while (selftalk.isBusy() && Date.now() - t0 < ms) await sleep(20);
  await sleep(30);
}

/* ═══════════════════════════════════════════════════════ */

(async () => {
  /* ── 频率 ── */
  console.log('\n【自言语 · 时段倍率】');
  resetAll();
  chk('白天 10 点 → 1.5', selftalk.factor(new Date(2026, 9, 12, 10)) === 1.5, selftalk.factor(new Date(2026, 9, 12, 10)));
  chk('晚上 20 点 → 1', selftalk.factor(new Date(2026, 9, 12, 20)) === 1, selftalk.factor(new Date(2026, 9, 12, 20)));
  chk('深夜 1 点 → 2', selftalk.factor(new Date(2026, 9, 12, 1)) === 2, selftalk.factor(new Date(2026, 9, 12, 1)));
  chk('清晨 5 点 → 2（凌晨那档，不是白天）',
    selftalk.factor(new Date(2026, 9, 12, 5)) === 2, selftalk.factor(new Date(2026, 9, 12, 5)));
  cfg.set('SelfTalkTimeFactors', false);
  chk('倍率关掉 → 恒 1', selftalk.factor(new Date(2026, 9, 12, 1)) === 1, '');
  cfg.set('SelfTalkTimeFactors', true);
  cfg.set('SelfTalkNightFactor', 0);
  chk('★ 倍率被改成 0 → 不会退回 0（不然她每 5 秒说一句）',
    selftalk.factor(new Date(2026, 9, 12, 1)) === 1, selftalk.factor(new Date(2026, 9, 12, 1)));
  cfg.set('SelfTalkNightFactor', 999);
  chk('★ 倍率被改成 999 → 夹到 10',
    selftalk.factor(new Date(2026, 9, 12, 1)) === 10, selftalk.factor(new Date(2026, 9, 12, 1)));
  cfg.set('SelfTalkNightFactor', 2);

  console.log('\n【自言语 · 排期】');
  resetAll();
  cfg.patch({ SelfTalkMinMinutes: 20, SelfTalkMaxMinutes: 60, SelfTalkDayFactor: 1, SelfTalkEveningFactor: 1, SelfTalkNightFactor: 1 });
  const times = [];
  for (let i = 0; i < 40; i++) times.push(selftalk.schedule(new Date()) - Date.now());
  const mins = times.map((d) => Math.round(d / 60000));
  chk('排出来的间隔落在 [min, max] 里',
    mins.every((m) => m >= 20 && m <= 60), `${Math.min(...mins)} ~ ${Math.max(...mins)} 分钟`);
  chk('不是每次都一样（真的在掷骰子）', new Set(mins).size > 3, `${new Set(mins).size} 种`);
  chk('★ 排期落盘了（重启能接着上次）', Number(store.readJson(selftalk.FILE, {}).nextAt) > 0, '');
  cfg.set('SelfTalkNightFactor', 2);

  console.log('\n【自言语 · 五道闸】');
  resetAll();
  cfg.set('SelfTalkEnabled', false);
  due();
  chk('① 自言语关着 → 不说', selftalk.tick(0) === '自言语关着', selftalk.tick(0));
  resetAll();
  cfg.set('AiEnabled', false);
  due();
  chk('  总开关关着 → 不说', selftalk.tick(0) === '总开关关着', '');

  resetAll();
  due();
  selftalk.schedule(new Date());          // 正常排一个（20~60 分钟后）
  chk('  还没到点 → 不说', selftalk.tick(0) === '还没到点', '');

  resetAll();
  busyFlag = true; due();
  chk('③ 气泡正忙 → 让这一轮', selftalk.tick(0) === '气泡正忙，让一轮', '');
  chk('  ★ 让一轮之后**照样把下一次排好了**（不然会一直重试同一拍）',
    selftalk.nextAt() > Date.now(), `${Math.round((selftalk.nextAt() - Date.now()) / 60000)} 分钟后`);

  resetAll();
  sleepingFlag = true; due();
  chk('④ 准备睡中 → 不说', selftalk.tick(0) === '准备睡中，不说', '');

  resetAll();
  due();
  chk('② 他离开 30 分钟 → 不说（不对着空椅子说话）',
    selftalk.tick(30) === '他不在（先不说）', selftalk.tick(30));

  resetAll();
  heartbeat._setIdleMinutes(() => -1);
  due();
  chk('★ 拿不到空闲时间（-1）→ **照说**（不然这个数一坏她从此闭嘴，还不报错）',
    selftalk.tick(-1) === '说一句', selftalk.tick(-1));
  await waitSay();
  heartbeat._setIdleMinutes(() => 0);

  await sleep(10);

  console.log('\n【自言语 · 真说一句】');
  resetAll();
  due();
  const r = selftalk.tick(0);
  chk('到点 + 他在 → 说', r === '说一句', r);
  await waitSay();
  chk('  发了一次请求', mockCalls === 1, `${mockCalls} 次`);
  const msgs = (lastReq && lastReq.messages) || [];
  chk('  系统提示词带上了（人格在）', /你是谁/.test((msgs[0] || {}).content || ''), '');
  chk('★ 用户那侧是**场景**不是聊天记录', /他在电脑前/.test((msgs[1] || {}).content || ''), '');
  chk('  场景里带了现在几点', /【现在的时间】/.test((msgs[1] || {}).content || ''), '');
  chk('  场景里明说了"这是你自己想开口"', /不需要回答任何问题/.test((msgs[1] || {}).content || ''), '');
  chk('★ 有"别每句都围着他转"那几句（他特意加的）',
    /不是整天盯着他操心的大姐/.test((msgs[1] || {}).content || ''), '');
  chk('★ 不走思考模式（随口一句，开思考要几十秒）',
    lastReq && lastReq.thinking === false, String(lastReq && lastReq.thinking));
  chk('  她说的话推出来了', said.length === 1 && said[0].kind === '自言自语', JSON.stringify(said[0]));
  chk('  记进了"最近说过什么"', selftalk.recents().length === 1, selftalk.recents()[0]);

  console.log('\n【自言语 · 沉默与复读】');
  resetAll();
  mockReply = '沉默';
  due();
  selftalk.tick(0);
  await waitSay();
  chk('★ 她说「沉默」是**合法的**，不算失败、也不冒气泡',
    said.length === 0, JSON.stringify(said));

  resetAll();
  mockReply = '（沉默）';
  due();
  selftalk.tick(0);
  await waitSay();
  chk('  括号包着的沉默也认', said.length === 0, JSON.stringify(said));

  resetAll();
  mockReply = '今天我想沉默一会儿，因为有点累。';
  due();
  selftalk.tick(0);
  await waitSay();
  chk('★ 但"想沉默一会儿因为…"是她真要说话 → 照说', said.length === 1, JSON.stringify(said[0]));

  resetAll();
  mockReply = '长'.repeat(500);
  due();
  selftalk.tick(0);
  await waitSay();
  chk('  太长的截到 200 字（自言自语不是开讲座）',
    said[0] && said[0].t.length === 200, said[0] ? `${said[0].t.length} 字` : '');

  resetAll();
  mockReply = '第一句';
  due(); selftalk.tick(0); await waitSay();
  mockReply = '第二句';
  due(); selftalk.tick(0); await waitSay();
  mockReply = '第三句';
  due(); selftalk.tick(0); await waitSay();
  mockReply = '第四句';
  due(); selftalk.tick(0); await waitSay();
  const ctx = selftalk.context();
  chk('★ "最近说过什么"只留 3 条（带多了会把他的话挤出去）',
    selftalk.recents().length === 3, `${selftalk.recents().length} 条`);
  chk('  场景里列出了"你最近已经说过这些话了，别重复"',
    /别重复/.test(ctx), '');
  chk('  最近这几句真的写进场景了', ctx.includes('第四句') || ctx.includes('第三句'), '');

  resetAll();
  mockThrows = '连不上 api.deepseek.com';
  due();
  selftalk.tick(0);
  await waitSay();
  chk('  请求失败 → 不当机、不冒气泡', said.length === 0 && selftalk.isBusy() === false, '');
  chk('  失败也把下一次排好了', selftalk.nextAt() > Date.now(), '');

  /* ── 自动关闭 ── */
  console.log('\n【自动关闭 · 四道闸】');
  resetAll();
  cfg.set('AutoExitEnabled', false);
  chk('  开关关着 → 不关', autoexit.tick(999) === '自动关闭关着', '');
  resetAll();
  cfg.set('AiEnabled', false);
  chk('  总开关关着 → 不关', autoexit.tick(999) === '总开关关着', '');

  resetAll();
  chk('  拿不到空闲时间（-1）→ 不判断（宁可开着也不误关）',
    autoexit.tick(-1) === '拿不到空闲时间（不判断）', '');

  resetAll();
  chk('① 只停了 30 分钟（门槛 60）→ 不关', autoexit.tick(30) === '还没停够', '');
  chk('  （他走了 30 分钟，这一拍不算见过活人）', autoexit.sawUserActive() === false, '');
  chk('★ 他刚动过（空闲 3 分钟）→ 记下见过活人',
    (() => { autoexit.tick(3); return autoexit.sawUserActive() === true; })(), '');

  resetAll();
  chk('② ⚠️ 这一趟**没见过活人**、一上来就"停了 999 分钟" → **不关**（防秒关）',
    autoexit.tick(999) === '这一趟还没见过他动过（不关）', autoexit.tick(999));

  resetAll();
  autoexit._setSawActive(true);
  reviewBusyFlag = true;
  const r3 = autoexit.tick(999);
  chk('③ ⚠️ 回顾还在跑 → 不关（他标了「切记切记」）',
    r3 === '回顾还在跑（不关）' && quitCalled === 0, r3);
  reviewBusyFlag = false;

  chk('  门槛填成 3（小于 10）→ 按 60 算',
    (() => { resetAll(); autoexit._setSawActive(true); cfg.set('AutoExitIdleMinutes', 3); return autoexit.tick(20) === '还没停够'; })(),
    '');
  cfg.set('AutoExitIdleMinutes', 60);

  console.log('\n【自动关闭 · 真关一次】');
  resetAll();
  autoexit.tick(1);                       // 先"见他动了一下"
  chk('  记到了"见过活人"', autoexit.sawUserActive() === true, '');
  const r5 = autoexit.tick(75);
  chk('④ 门槛都过了 → 留晚安，准备退出', r5 === '留晚安，准备退出', r5);
  chk('  晚安说出来了', said.length === 1 && said[0].kind === '睡前', JSON.stringify(said[0]));
  chk('  默认那句', said[0] && said[0].t === '我有点困了，先去睡啦', said[0] && said[0].t);
  await sleep(30);
  chk('  说晚安的那一拍还没退（给他看清气泡的时间）', quitCalled === 0, '');
  await sleep(2200);
  chk('  ★ 等一下之后真退了', quitCalled === 1, `${quitCalled} 次`);
  autoexit.tick(80);
  await sleep(100);
  chk('  再判也不会重复退（防重入）', quitCalled === 1, `${quitCalled} 次`);
  chk('  也不会重复留晚安', said.length === 1, `${said.length} 句`);

  console.log('\n【自动关闭 · 晚安按心情】');
  resetAll();
  mood.set('高兴', '他今天主动来找我聊了', { from: '对话' });
  chk('  高兴 → 「今天挺好的，我先睡啦」', autoexit.byeText() === '今天挺好的，我先睡啦', autoexit.byeText());
  resetAll();
  mood.set('低落', '他今天没怎么理我', { from: '对话' });
  chk('  低落 → 「我先去躺会儿」', autoexit.byeText() === '我先去躺会儿', autoexit.byeText());
  resetAll();
  chk('  平常 → 默认那句', autoexit.byeText() === '我有点困了，先去睡啦', autoexit.byeText());

  console.log('\n【自动关闭 · 晚点关】');
  resetAll();
  autoexit.tick(1);
  chk('  第一次说"想晚点关" → 认', autoexit.askLate().ok === true, '');
  const r6 = autoexit.tick(999);
  chk('★ 延时生效一次（这一拍不关）', r6.includes('再等 30 分钟') && quitCalled === 0, r6);
  const r7 = autoexit.tick(999);
  chk('  ★★ 延时**只生效一次** —— 第二拍照关（不然永远关不掉）',
    r7 === '留晚安，准备退出', r7);
  await sleep(2200);
  chk('  第二拍之后真退了', quitCalled === 1, `${quitCalled} 次`);

  resetAll();
  autoexit.tick(1);
  autoexit.askLate();
  autoexit.askLate();
  const used = autoexit.lateUsedToday();
  chk('★ 今天的那次"晚点关"用掉之后，当天再要就不给了',
    (() => { const a = autoexit.askLate(); return a.ok === false && /今天已经延过/.test(a.why); })(),
    String(used));

  /* ── 心跳挂钩子 ── */
  console.log('\n【心跳挂上三条链】');
  resetAll();
  const ran = [];
  heartbeat.on('review', () => ran.push('review'));
  heartbeat.on('selfTalk', () => ran.push('selfTalk'));
  heartbeat.on('autoExit', () => ran.push('autoExit'));
  heartbeat._setIdleMinutes(() => 0);
  heartbeat.tick(new Date());
  chk('★ 心跳一拍里三条链都被叫了（不是只叫一条）',
    ran.length === 3 && ran.includes('review') && ran.includes('selfTalk') && ran.includes('autoExit'),
    ran.join(' / '));

  /* ── 隔离 ── */
  console.log('\n【隔离检查】');
  const REAL = 'C:\\Users\\Susim\\AppData\\Roaming\\Yachiyo';
  chk('跑在隔离目录里', HOME.includes('_selfcheck-home-4b'), HOME);
  chk('  真目录里没多出 selftalk / autoexit 的状态文件（这次自检没碰他的）',
    !fs.existsSync(path.join(REAL, 'data', 'state', 'selftalk.json'))
    || fs.statSync(path.join(REAL, 'data', 'state', 'selftalk.json')).mtimeMs < STARTED,
    '');

  provider.chat = realChat;

  console.log('\n' + '─'.repeat(52));
  const pass = out.filter((x) => x.ok).length;
  console.log(`  ${pass}/${out.length} 通过  ${pass === out.length ? '✓ 全过' : '✗ 有失败'}`);
  console.log('─'.repeat(52) + '\n');
  const bad = out.filter((x) => !x.ok);
  if (bad.length) { console.log('失败明细：'); for (const b of bad) console.log(`  - ${b.name}: ${b.detail}`); }
  process.exit(pass === out.length ? 0 : 1);
})().catch((e) => { console.error('\n自检自己炸了：', e.stack || e.message); process.exit(1); });
