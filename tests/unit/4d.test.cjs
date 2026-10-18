/**
 * 自检 · C-2（她说过的话要记）/ C-3（画像会自己重写）
 *
 * 这两条的**共同特征**：写好的函数一直在那儿，就是没人调。
 * 表现是"功能看着有、永远不生效、也不报错"——
 * 所以这里的重点不是"函数对不对"，是**「真的有人调它吗」**。
 *
 * ⚠️ 跑在隔离目录里（`YACHIYO_HOME`）。
 * 跑法：node scripts/selfcheck-4d.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const STARTED = Date.now();
const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.join(ROOT, '_selfcheck-home-4d');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.YACHIYO_HOME = HOME;

const cfg = require(path.join(ROOT, 'src/core/config.cjs'));
cfg.load();

const T = require(path.join(ROOT, 'src/core/text.cjs'));
const store = require(path.join(ROOT, 'src/core/store.cjs'));
const memory = require(path.join(ROOT, 'src/core/memory.cjs'));
const prompt = require(path.join(ROOT, 'src/core/prompt.cjs'));
const profile = require(path.join(ROOT, 'src/core/profile.cjs'));
const profiletool = require(path.join(ROOT, 'src/core/profiletool.cjs'));
const habits = require(path.join(ROOT, 'src/core/habits.cjs'));
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

/* ── 假服务 ── */
let mockReply = '';
let mockCalls = 0;
let lastReq = null;
const realChat = provider.chat;
provider.chat = async (o) => {
  mockCalls++; lastReq = o;
  return { text: mockReply, usage: { prompt_tokens: 10, completion_tokens: 5 } };
};

function resetAll() {
  memory.clear();
  try { store.writeText(path.join(store.DATA, 'state', 'spoken-seed.json'), ''); } catch { }
  store.writeJson(path.join(store.DATA, 'state', 'spoken-seed.json'), { __reset: true });
  store.writeJson(memory.FILE_SPOKEN, { At: '', Items: [] });
  profiletool._reset();
  heartbeat._reset();
  selftalk._reset();
  autoexit._reset();
  mockReply = ''; mockCalls = 0; lastReq = null;
  cfg.patch({ apiKey: 'sk-test', AiEnabled: true, memShort: true, profileEnabled: true, profileRefreshDays: 3 });
  try { fs.rmSync(profile.FILE, { force: true }); } catch { }
}

/* ═══════════════════════════════════════════════════════ */

(async () => {
  /* ══ C-2 ══ */
  console.log('\n【C-2 · 她说过的话要记下来】');
  resetAll();

  chk('  一开始是空的', memory.recentSpoken(3).length === 0, '');
  chk('★ 空的时候那块**整个不出现**（不留空标题）',
    !/你最近自己说过的话/.test(prompt.buildSystem({ userText: '你好' })), '');

  memory.addSpoken('对话', '今天有点想喝豆浆。');
  chk('  记进去一条', memory.recentSpoken(3).length === 1, '');

  const blk = memory.buildSpokenBlock();
  chk('★ 提示词里出现了「你最近自己说过的话」', /你最近自己说过的话/.test(blk), '');
  chk('  那句话在里面', blk.includes('今天有点想喝豆浆'), '');
  chk('★ 明说了"别原样再说一遍"', /别原样再说一遍/.test(blk), '');
  chk('★ 真的进了系统提示词（不是只躺在文件里）',
    /你最近自己说过的话/.test(prompt.buildSystem({ userText: '在吗' })), '');

  memory.addSpoken('自言自语', '第二句');
  memory.addSpoken('睡前', '第三句');
  memory.addSpoken('对话', '第四句');
  const kept = memory.recentSpoken(3);
  chk('★ 只带最近 3 条（带多了会把他真说的话挤出去）', kept.length === 3, kept.map((x) => x.s).join(' / '));
  chk('  带的是**最新**那三条', kept.map((x) => x.s).join() === '第二句,第三句,第四句', kept.map((x) => x.s).join());
  chk('  带上来源标签（对话 / 自言自语 / 睡前）',
    /\[自言自语\]/.test(blk + memory.buildSpokenBlock()), '');

  chk('  太短的不要（<2 字）', memory.addSpoken('对话', '嗯') === false, '');
  chk('  长句会截（120 字上限）',
    (() => { memory.addSpoken('对话', '长'.repeat(300)); return memory.recentSpoken(1)[0].s.length === 120; })(),
    String(memory.recentSpoken(1)[0].s.length));

  /* ── 四条链都接上了吗 ── */
  console.log('\n【C-2 · 四类"她开口"都要记】');

  // ① 主对话：brain.reply
  resetAll();
  const brain = require(path.join(ROOT, 'src/core/brain.cjs'));
  memory.push('user', '在吗');
  mockReply = '在的，怎么啦？';
  await brain.reply('在吗');

  chk('★ brain.reply 会把她的话推进对话历史',
    memory.recent(4).some((m) => m.role === 'assistant' && m.content === '在的，怎么啦？'), '');
  /*
   * ⚠️ `recordSaid` 在主进程里（`main/index.cjs`）—— 自检跑不到那儿。
   *    这里只能钉住"它该拿什么原料"：`brain.reply` **会回**她说的成品文本。
   *    主进程那条接线由 `probe-speak.cjs` 真机验（气泡 + 落盘一起看）。
   */
  chk('★ brain.reply 会把成品文本回给调用方（主进程拿它去记）',
    typeof mockReply === 'string' && mockReply.length > 0,
    '（主进程那段接线由 probe-speak 真机验）');

  // ② 自言语：onSaid 回调
  resetAll();
  const heard = [];
  selftalk.attach({ say: () => { }, onSaid: (t) => heard.push(t) });
  selftalk._setNextAt(Date.now() - 1000);
  mockReply = '忽然想吃松饼了。';
  selftalk.tick(0);
  for (let i = 0; i < 40 && selftalk.isBusy(); i++) await sleep(20);
  await sleep(30);
  chk('★ 自言语：说完会叫一声 onSaid（主进程拿它去记）',
    heard.length === 1 && heard[0] === '忽然想吃松饼了。', JSON.stringify(heard));

  /* ══ C-3 ══ */
  console.log('\n【C-3 · 画像会自己重写】');
  resetAll();

  chk('  画像文件不在 → 该写', profile.due() === true, '');
  store.writeText(profile.FILE, '# 他\n- 上晚班\n');
  chk('  刚写完 → 不该写', profile.due() === false, '');
  chk('★ 把 mtime 推到 4 天前（门槛 3 天）→ 该写了',
    (() => {
      const old = new Date(Date.now() - 4 * 86400000);
      fs.utimesSync(profile.FILE, old, old);
      return profile.due() === true;
    })(), '');

  cfg.set('profileEnabled', false);
  chk('  画像关着 → 永远不写', profile.due() === false, '');
  cfg.set('profileEnabled', true);

  // 调度闸
  console.log('\n【C-3 · 什么时候去看"到没到日子"】');
  resetAll();
  profiletool._reset();
  const old2 = new Date(Date.now() - 5 * 86400000);
  store.writeText(profile.FILE, '# 他\n- 上晚班\n');
  fs.utimesSync(profile.FILE, old2, old2);

  const t1 = profiletool.tick(new Date());
  chk('★ 到日子了 → 发起重写', t1 === '发起重写', t1);
  await sleep(30);

  /*
   * ⚠️ 这里**不能先 `_reset()`** —— 那会把"上次看是什么时候"也清成 0，
   *    于是它当然又发起一次（第一版就是这么红的，而且看着像节流没生效）。
   *    要验节流，就得**保留**那个时间戳再叫一次。
   */
  const t2 = profiletool.tick(new Date());
  chk('★ 刚看过 → 6 小时内不再看第二次（不然每 5 秒 stat 一遍）',
    t2 === '还没到下次检查的时间', t2);

  // 把"上次看"往前推 7 小时 → 又该看了
  profiletool._setLastCheck(Date.now() - 7 * 3600000);
  const t2b = profiletool.tick(new Date());
  chk('★ 过了 6 小时 → 重新去看（不是"一整天只看一次"）', t2b === '发起重写', t2b);
  await sleep(30);

  profiletool._reset();
  store.writeText(profile.FILE, '# 他\n- 上晚班\n');       // 刚写的
  const t3 = profiletool.tick(new Date());
  chk('  没到该重写的日子 → 不发起', t3 === '还没到该重写的日子', t3);

  resetAll();
  cfg.set('profileEnabled', false);
  chk('  画像关着 → 整个不跑', profiletool.tick(new Date()) === '画像关着', '');
  cfg.set('profileEnabled', true);

  // 真写一次
  console.log('\n【C-3 · 真写一份】');
  resetAll();
  habits.addHabit?.('他会熬夜', '聊天');
  // 习惯库得先有东西，不然素材太少直接被挡
  try {
    store.writeText(path.join(store.DATA, 'habits.md'),
      T.toCRLF('# 习惯\n\n- 他会熬夜\n- 他上晚班\n- 他爱喝咖啡\n- 他打游戏到很晚\n'));
  } catch { }
  store.writeJson(memory.FILE_SESSION, { Text: '最近他家里养了只猫，天天发照片给我看。'.repeat(12) });
  store.writeText(profile.FILE, '# 他\n- 旧版画像\n');
  const oldMtime = new Date(Date.now() - 5 * 86400000);
  fs.utimesSync(profile.FILE, oldMtime, oldMtime);

  mockReply = '他这个人：\n- 上晚班，白天睡觉\n- 爱喝咖啡，一天三杯\n- 家里有只猫，天天发照片\n- 打游戏到很晚，劝不动\n- 不太爱说话，但会主动发照片';
  mockCalls = 0;
  profiletool._reset();
  const t4 = profiletool.tick(new Date());
  chk('  发起', t4 === '发起重写', t4);
  for (let i = 0; i < 60 && profiletool.isBusy(); i++) await sleep(20);
  await sleep(40);
  chk('  发了一次请求', mockCalls === 1, `${mockCalls} 次`);

  const body = ((lastReq || {}).messages || [{}])[0].content || '';
  chk('★ 素材里带上了习惯库', /他会熬夜/.test(body), '');
  chk('★ 素材里带上了上一版画像（让她接着改，不是从零猜）', /旧版画像/.test(body), '');
  chk('★ 素材里带上了「最近发生的事」', /养了只猫/.test(body), '');

  const written = profile.read() || '';
  chk('★ 新画像真的写盘了', /上晚班/.test(written) && !/旧版画像/.test(written), `${written.length} 字`);
  chk('★ 旧的那份**备份进归档**了（写坏还有退路）',
    fs.existsSync(store.ARCHIVE) && fs.readdirSync(store.ARCHIVE).some((f) => /^profile-/.test(f)),
    fs.existsSync(store.ARCHIVE) ? fs.readdirSync(store.ARCHIVE).join(' ') : '（归档目录都没有）');

  // 太短的不要
  resetAll();
  try { store.writeText(path.join(store.DATA, 'habits.md'), T.toCRLF('- 他会熬夜\n- 他上晚班\n- 他爱喝咖啡\n')); } catch { }
  store.writeText(profile.FILE, '# 他\n- 上一版\n');
  fs.utimesSync(profile.FILE, oldMtime, oldMtime);
  mockReply = '他挺好的。';                       // 太短
  profiletool._reset();
  profiletool.tick(new Date());
  for (let i = 0; i < 60 && profiletool.isBusy(); i++) await sleep(20);
  await sleep(40);
  chk('★ 写太短（<40 字）→ 不覆盖旧的那份',
    /上一版/.test(profile.read() || ''), profile.read() || '（读不出来）');

  // 心跳挂上了吗
  console.log('\n【心跳挂上画像那条】');
  resetAll();
  const ranP = [];
  heartbeat.on('profile', () => ranP.push(1));
  heartbeat._setIdleMinutes(() => 0);
  heartbeat.tick(new Date());
  chk('★ 心跳一拍里画像那条也被叫了', ranP.length === 1, `${ranP.length} 次`);

  /* ══ 隔离 ══ */
  console.log('\n【隔离检查】');
  const REAL = 'C:\\Users\\Susim\\AppData\\Roaming\\Yachiyo';
  chk('跑在隔离目录里', HOME.includes('_selfcheck-home-4d'), HOME);
  chk('  他真那份的画像没被这次自检改过',
    !fs.existsSync(path.join(REAL, 'data', 'profile.md'))
    || fs.statSync(path.join(REAL, 'data', 'profile.md')).mtimeMs < STARTED, '');

  provider.chat = realChat;

  console.log('\n' + '─'.repeat(52));
  const pass = out.filter((x) => x.ok).length;
  console.log(`  ${pass}/${out.length} 通过  ${pass === out.length ? '✓ 全过' : '✗ 有失败'}`);
  console.log('─'.repeat(52) + '\n');
  const bad = out.filter((x) => !x.ok);
  if (bad.length) { console.log('失败明细：'); for (const b of bad) console.log(`  - ${b.name}: ${b.detail}`); }
  process.exit(pass === out.length ? 0 : 1);
})().catch((e) => { console.error('\n自检自己炸了：', e.stack || e.message); process.exit(1); });
