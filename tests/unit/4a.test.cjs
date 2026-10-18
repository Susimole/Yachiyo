/**
 * 自检 · 第 4 步 ①（心跳 + 回顾链）
 *
 * **纯数据层，不起窗口，不发真请求** —— 跟 selfcheck-3c.cjs 一个路子。
 *
 * ⚠️ **必须跑在隔离目录里**（`YACHIYO_HOME`）。
 *    不然它会往他的真数据里写测试用的心事 / 心情 / 认错，
 *    还会把 `state/review.json` 的「今天回顾过」标记写成今天 ——
 *    那样他今晚真正的回顾就**永远不会跑**了。
 *
 * 跑法：node scripts/selfcheck-4a.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const STARTED = Date.now();          // 给最后的「他真数据没被碰过」用
const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.join(ROOT, '_selfcheck-home-4a');

// ★ 隔离：必须在 require 任何 core 模块**之前**设好（它们加载时就读 cfg.DIR）
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.YACHIYO_HOME = HOME;

const cfg = require(path.join(ROOT, 'src/core/config.cjs'));
cfg.load();

const T = require(path.join(ROOT, 'src/core/text.cjs'));
const store = require(path.join(ROOT, 'src/core/store.cjs'));
const memory = require(path.join(ROOT, 'src/core/memory.cjs'));
const mood = require(path.join(ROOT, 'src/core/mood.cjs'));
const her = require(path.join(ROOT, 'src/core/heritems.cjs'));
const goals = require(path.join(ROOT, 'src/core/goals.cjs'));
const provider = require(path.join(ROOT, 'src/core/provider.cjs'));
const heartbeat = require(path.join(ROOT, 'src/core/heartbeat.cjs'));
const review = require(path.join(ROOT, 'src/core/review.cjs'));
const log = require(path.join(ROOT, 'src/core/log.cjs'));
const usage = require(path.join(ROOT, 'src/core/usage.cjs'));

const out = [];
const chk = (name, ok, detail) => {
  out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail != null ? '  —— ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到回顾那趟异步跑完（最多 3 秒） */
async function waitReview(ms = 3000) {
  const t0 = Date.now();
  while (review.isBusy() && Date.now() - t0 < ms) await sleep(20);
  await sleep(30);            // 让 finally 里那一下也落定
}

/** 假服务：把模型回什么攥在手里 */
let mockReply = '';
let mockCalls = 0;
let mockThrows = null;
const realChat = provider.chat;
provider.chat = async () => {
  mockCalls++;
  if (mockThrows) throw new Error(mockThrows);
  return { text: mockReply, usage: null };
};

/** 清干净：数据层 + 回顾当日状态 + 心跳节流键 + 假服务 */
function resetAll() {
  mood._reset(); her._reset(); goals._reset();
  memory.clear();
  review._reset();
  heartbeat._reset();
  mockReply = ''; mockCalls = 0; mockThrows = null;
  usage.reset();
  cfg.patch({ AiEnabled: true, ReviewIdleMinutes: 55, apiKey: 'sk-test-selfcheck' });
}

/** 往对话历史里塞几句，凑够「今天聊过」 */
function seedChat(n = 3) {
  memory.push('user', '今天早上出去买了杯咖啡，路上还挺凉快的');
  memory.push('assistant', '哦哦，那你有穿外套吗');
  for (let i = 1; i < n; i++) {
    memory.push('user', `第 ${i} 句测试用的闲聊，随便说点什么都行`);
    memory.push('assistant', `第 ${i} 句回他的话`);
  }
}

(async () => {
  /* ══════════════════════════════════════════════════════
     心跳
     ══════════════════════════════════════════════════════ */
  console.log('\n【心跳 heartbeat】');
  resetAll();
  heartbeat._setIdleMinutes(() => 3);

  /*
   * ⚠️ 心跳那一拍挂的钩子（review 等）在**每一拍都会跑**，
   *    节流的是「小时维护」本身（情绪回落 / 心事衰减）。
   *    所以这里看的是 `ran` 里有没有 review —— 现在还是 null，
   *    等下面接上之后才推得出来。这里先钉住"钩子确实被叫了"。
   */
  heartbeat.on('review', () => {});
  let r = heartbeat.tick(new Date('2026-10-12T10:00:00'));
  chk('第一拍：钩子被叫了', r.ran.includes('review'), r.ran.join(' / '));
  chk('  小时维护这一拍是真跑了（没活儿时 done 是空的，但键推进了）',
    heartbeat._state().hourKey === '2026-10-12 10', heartbeat._state().hourKey);

  r = heartbeat.tick(new Date('2026-10-12T10:00:05'));
  chk('同一小时内第二拍：节流键没动（不重跑小时维护）',
    heartbeat._state().hourKey === '2026-10-12 10', '');

  r = heartbeat.tick(new Date('2026-10-12T11:00:00'));
  chk('★ 跨到下一小时：键跟上了（比的是小时键，不是"距上次多少毫秒"）',
    heartbeat._state().hourKey === '2026-10-12 11', heartbeat._state().hourKey);

  // 真让情绪回落一次：把变化时间戳改成 40 小时前
  heartbeat._reset();
  heartbeat._setIdleMinutes(() => 3);
  mood._reset();
  mood.set('低落', '他今天没怎么理我', { from: '对话' });
  {
    const m = store.readJson(mood.FILE, {});
    m.情绪.变了于 = T.stamp(new Date(Date.now() - 40 * 3600000));
    store.writeJson(mood.FILE, m);
  }
  r = heartbeat.tick(new Date());
  chk('★ 情绪超过 18 小时没变 → 这一拍真的回落了',
    r.hourly.includes('情绪回落'), r.hourly.join(' / ') || '（没跑）');
  chk('  回落成了「平常」', mood.read().现在 === '平常', mood.read().现在);

  chk('空闲时间问的是注入的那个（3 分钟）', Math.round(r.idleMin) === 3, r.idleMin);

  // 系统空闲时间：秒 → 分钟
  heartbeat._reset();
  heartbeat.attach({ powerMonitor: { getSystemIdleTime: () => 600 } });
  chk('★ 系统空闲 600 秒 → 10 分钟（它返回的是秒，忘除就是个 600 的假数）',
    Math.round(heartbeat.idleMinutes()) === 10, heartbeat.idleMinutes());
  heartbeat.attach({ powerMonitor: null });
  heartbeat._reset();          // 把上面注入的假空闲时间也清掉（_reset 会清）
  chk('拿不到空闲时间 → -1（调用方据此不做判断，而不是当成"他刚动过"）',
    heartbeat.idleMinutes() === -1, heartbeat.idleMinutes());

  // 总开关关着
  heartbeat._reset();
  heartbeat._setIdleMinutes(() => 3);
  cfg.set('AiEnabled', false);
  r = heartbeat.tick(new Date('2026-10-12T10:00:00'));
  const st = heartbeat._state();
  chk('总开关关着 → 小时维护不跑', r.hourly.length === 0, '');
  chk('★ 但节流键照样推进（不然关一小时再开，她会立刻"莫名其妙变了心情"）',
    st.hourKey === '2026-10-12 10' && st.dayKey === '2026-10-12', `${st.hourKey} / ${st.dayKey}`);
  cfg.set('AiEnabled', true);

  // 每日维护
  heartbeat._reset();
  heartbeat._setIdleMinutes(() => 3);
  const g = goals.add({ want: '想让他早点睡', from: '他昨天两点还在敲键盘', type: '关心' });
  chk('先造一条目标', g.ok === true, g.id || g.why);
  // ⚠️ goals 没有导出 writeAll —— 过期目标直接改盘上的文件
  {
    const f = store.readJson(goals.FILE, { goals: [] });
    f.goals[0].due = '2026-01-01';        // 手动改成过期
    store.writeJson(goals.FILE, f);
  }
  r = heartbeat.tick(new Date('2026-10-12T10:00:00'));
  chk('每日维护：过期目标搁下了', r.daily === 1, `${r.daily} 条`);
  r = heartbeat.tick(new Date('2026-10-12T11:00:00'));
  chk('同一天第二拍：每日维护不再跑', r.daily === 0, '');

  /* ══════════════════════════════════════════════════════
     回顾链 · 五道闸
     ══════════════════════════════════════════════════════ */
  console.log('\n【回顾链 · 五道闸】');
  resetAll();
  heartbeat._setIdleMinutes(() => 10);
  seedChat(3);

  let s = review.tick(10);
  chk('① 键鼠只停了 10 分钟（门槛 55）→ 不动', s === '他还在（不动）', s);
  chk('  没标记今天回顾过', review.reviewedToday() === false, '');
  chk('  没发请求', mockCalls === 0, `${mockCalls} 次`);

  // ④ 没材料
  resetAll();
  memory.push('user', '就一句');
  s = review.tick(600);
  chk('④ 今天只说过 1 句 → 跳过', s === '没材料，跳过并标记', s);
  chk('  没发请求（不编，也不花额度）', mockCalls === 0, `${mockCalls} 次`);
  chk('★ 但照样标记今天已回顾（不然每一拍都会重试）',
    review.reviewedToday() === true, '');
  s = review.tick(600);
  chk('  下一拍不再重试', s === '准备睡中', s);

  // ③ 今天回顾过
  resetAll();
  seedChat(3);
  review.tick(600);                       // 先把今天标记掉
  await waitReview();
  mockCalls = 0;
  resetAll0KeepDay();
  review._wake();                          // 先退出「准备睡」，才看得到"进准备睡"这一下
  s = review.tick(600);
  chk('③ 今天已经回顾过 → 只进「准备睡」，不再发请求',
    s === '今天回顾过了，进准备睡' && mockCalls === 0, `${s} · ${mockCalls} 次`);
  s = review.tick(600);
  chk('  已经准备睡了 → 再拍只报「准备睡中」，不重复做事', s === '准备睡中', s);

  function resetAll0KeepDay() {
    // 只清状态、**保留** review.json 里的当日标记和已「准备睡」的事实
    mood._reset(); her._reset(); goals._reset();
    heartbeat._reset();
    heartbeat._setIdleMinutes(() => 600);
    mockReply = ''; mockCalls = 0; mockThrows = null;
  }

  // ② 他回来了
  resetAll();
  seedChat(3);
  review.tick(600);
  await waitReview();
  chk('  先确认已经进了「准备睡」', review.isSleeping() === true, '');
  s = review.tick(2);
  chk('② 他回来了（idle 2 分钟）→ 静默取消准备睡',
    s === '他回来了，取消准备睡' && review.isSleeping() === false, s);
  mockCalls = 0;
  s = review.tick(600);
  chk('  再停够久也不会补回顾（今天已经过了）',
    s === '今天回顾过了，进准备睡' && mockCalls === 0, `${s} · ${mockCalls} 次`);

  // ⑤ 全过 → 发起
  console.log('\n【回顾链 · 发起那一趟】');
  resetAll();
  seedChat(3);
  mockReply = [
    '心事|在意 || 他这两天话比平时少 || 说话温和一点、少挑刺',
    '情绪|高兴 || 他今天主动来找我聊了三次',
    '认错|我以为他在熬夜刷视频 || 他早就躺床上了 || 还在，他今天睡到中午才起 || 屏幕亮着不等于人还在',
    '小日子|没成 || 想做茶碗蒸，蛋液比例没调对，蒸出来全是蜂窝',
  ].join('\n');

  s = review.tick(600);
  chk('⑤ 前四条都过 → 发起回顾', s === '发起回顾', s);
  chk('  进了「准备睡」', review.isSleeping() === true, '');
  chk('  标记了今天已回顾', review.reviewedToday() === true, '');
  await waitReview();
  chk('  发了一次请求', mockCalls === 1, `${mockCalls} 次`);

  const worries = (store.readJson(her.FILE_WORRY, { worry: [] }) || {}).worry || [];
  chk('  心事落库了', worries.length === 1, `${worries.length} 条`);
  chk('  档位认对了', worries[0] && worries[0].rank === '在意', worries[0] && worries[0].rank);
  chk('  内容对', worries[0] && worries[0].about === '他这两天话比平时少', worries[0] && worries[0].about);

  chk('  情绪落库了', mood.read().现在 === '高兴', mood.read().现在);
  chk('  情绪写了原因', (mood.read().为什么 || '').length > 2, mood.read().为什么);
  chk('  情绪记录了出处是「回顾」', mood.read().哪条 === '回顾', mood.read().哪条);

  const mists = (store.readJson(her.FILE_MISTAKE, { mistake: [] }) || {}).mistake || [];
  chk('  认错落库了', mists.length === 1, `${mists.length} 条`);
  chk('  「我以为」对', mists[0] && mists[0].thought === '我以为他在熬夜刷视频', mists[0] && mists[0].thought);
  chk('  「实际是」对', mists[0] && mists[0].actual === '他早就躺床上了', mists[0] && mists[0].actual);
  chk('★ 「问题还在」认出来了（写的是「还在…」不是纯"还在"）',
    mists[0] && mists[0].open === true, mists[0] && String(mists[0].open));
  chk('  教训对', mists[0] && mists[0].lesson === '屏幕亮着不等于人还在', mists[0] && mists[0].lesson);

  const smalls = (store.readJson(her.FILE_SMALL, { small: [] }) || {}).small || [];
  chk('  小日子落库了', smalls.length === 1, `${smalls.length} 条`);
  chk('  组认对了', smalls[0] && smalls[0].group === '没成', smalls[0] && smalls[0].group);

  /* ══════════════════════════════════════════════════════
     解析的边角
     ══════════════════════════════════════════════════════ */
  console.log('\n【解析 applyResult】');
  resetAll();

  // 模型爱加项目符号
  let p = review.applyResult('- 心事|重要 || 他老是熬夜，劝了也不听 || 睡前提醒他一句');
  const w2 = (store.readJson(her.FILE_WORRY, { worry: [] }) || {}).worry || [];
  chk('★ 行首的「- 」被剥掉了（不剥就匹配不上前缀，整行白写）',
    p.worry === 1 && w2.length === 1 && w2[0].about === '他老是熬夜，劝了也不听', w2[0] && w2[0].about);
  chk('  档位「重要」认对了', w2[0] && w2[0].rank === '重要', w2[0] && w2[0].rank);

  resetAll();
  p = review.applyResult('心事：他今天好像没睡够 || 说话轻一点');
  const w3 = (store.readJson(her.FILE_WORRY, { worry: [] }) || {}).worry || [];
  chk('  全角冒号也认', p.worry === 1 && w3.length === 1, `${p.worry} 条`);
  chk('  没有档位时默认「在意」', w3[0] && w3[0].rank === '在意', w3[0] && w3[0].rank);

  resetAll();
  p = review.applyResult('心事|算了 || x');       // 2 字 —— 低于 addWorry 的 3 字门槛
  chk('  太短的心事被 addWorry 挡掉（不计数）', p.worry === 0, `${p.worry}`);

  resetAll();
  p = review.applyResult('情绪|高兴 ||');
  chk('  情绪没写原因 → 不收（mood 那道闸拦住了）', p.mood === '' && mood.read().现在 !== '高兴', p.mood);

  resetAll();
  p = review.applyResult('情绪|随便 || 乱写的档位');
  chk('  情绪档位不认 → 不收', p.mood === '', p.mood);

  resetAll();
  p = review.applyResult('认错|我以为他睡了 || 他其实在打游戏 || 已经是过去的事了 || 别凭猜');
  const m2 = (store.readJson(her.FILE_MISTAKE, { mistake: [] }) || {}).mistake || [];
  chk('★ 「已经是过去的事了」→ open 判成 false（不是非空字符串就算"还在"）',
    m2.length === 1 && m2[0].open === false, m2[0] && String(m2[0].open));

  resetAll();
  p = review.applyResult('想说|今天不想想这些');
  chk('★ 「想说」是合法输出，不算错', p.skip === true, '');

  resetAll();
  p = review.applyResult('晚点关|再等半小时');
  chk('「晚点关」认出来了', p.lateAsk === '再等半小时', p.lateAsk);

  resetAll();
  p = review.applyResult('今天聊得挺开心的，他好像挺累的。');
  chk('★ 整段闲话 → 四样一样都不落（不许从散文里瞎猜）',
    p.worry === 0 && p.mood === '' && p.mistake === 0 && p.small === 0, '');

  resetAll();
  p = review.applyResult('');
  chk('  空回复 → 什么也不做，不报错',
    p.worry === 0 && p.mood === '' && p.mistake === 0 && p.small === 0, '');

  /* ══════════════════════════════════════════════════════
     日期翻篇 / 出错
     ══════════════════════════════════════════════════════ */
  console.log('\n【日期翻篇 · 出错】');
  resetAll();
  seedChat(3);
  review.tick(600);
  await waitReview();
  chk('  今天回顾过了', review.reviewedToday() === true, '');
  chk('★ 把标记改成昨天 → 今天就能再回顾（不是"永远只回顾一次"）',
    (() => {
      const st = store.readJson(review.FILE, {});
      st.lastDay = '2026-01-01';
      store.writeJson(review.FILE, st);
      return review.reviewedToday() === false;
    })(), '');

  resetAll();
  seedChat(3);
  mockThrows = '连不上 api.deepseek.com —— 检查网络';
  review.tick(600);
  await waitReview();
  chk('★ 请求失败 → 不当机、不重试轰炸，只记一笔', review.lastError().includes('连不上'), review.lastError());
  chk('  标记已经落了（不会每隔 5 秒重发一次）', review.reviewedToday() === true, '');
  r = review.tick(600);
  chk('  下一拍不重发', r === '准备睡中', r);

  resetAll();
  seedChat(3);
  cfg.set('apiKey', '');
  s = review.tick(600);
  await waitReview();
  chk('  没填 Key → 干脆不发', mockCalls === 0, `${mockCalls} 次`);

  /* ══════════════════════════════════════════════════════
     素材
     ══════════════════════════════════════════════════════ */
  console.log('\n【素材 buildMaterial】');
  resetAll();
  seedChat(4);
  const mat = review.buildMaterial();
  chk('  带上了对话', /【今天你们聊了什么】/.test(mat.text), '');
  chk('  他说的话标「他：」', /他：/.test(mat.text), '');
  chk('  她说的话标「你：」', /你：/.test(mat.text), '');
  chk('  数出了他说过几句', mat.userLines === 4, `${mat.userLines} 句`);
  chk('  没材料时不硬凑一段（识屏那两段还没做，就不出现）',
    !/屏幕|作息/.test(mat.text), '');

  const longOne = '这是一句特别特别长的话'.repeat(30);
  memory.push('user', longOne);
  const mat2 = review.buildMaterial();
  const tooLong = mat2.text.split(/\r?\n/).filter((l) => l.length > 90);
  chk('★ 每句截到 80 字（不截的话一篇长文就把整段素材挤爆）',
    tooLong.length === 0, tooLong.length ? `${tooLong[0].length} 字的那行` : '');

  /* ══════════════════════════════════════════════════════
     提示词里的硬规矩别丢
     ══════════════════════════════════════════════════════ */
  console.log('\n【提示词】');
  const pr = review.buildPrompt('【今天你们聊了什么】\n他：测试');
  chk('  心事最多 1 条那条在', /心事\*\*最多 1 条\*\*/.test(pr) || /最多 1 条/.test(pr), '');
  chk('  不许编那条在', /不许编/.test(pr), '');
  chk('  情绪必须写原因那条在', /必须写原因/.test(pr), '');
  chk('  认错要写「问题还在吗」那条在', /问题还在吗/.test(pr), '');
  chk('  小日子「没做就空着」那条在', /空着比编一条好/.test(pr), '');
  chk('  想说（今天不想想）那条在', /想说\|/.test(pr), '');
  chk('  用了 CRLF（跟旧工程一致，模型对换行敏感）', pr.includes('\r\n'), '');

  /* ══════════════════════════════════════════════════════
     落盘日志 + 记账
     ══════════════════════════════════════════════════════ */
  console.log('\n【落盘日志 · 记账】');
  resetAll();
  seedChat(3);
  mockReply = '心事|在意 || 他又说到两点还没睡 || 先别催他';
  review.tick(600);
  await waitReview();

  const lines = log.tail(200, '回顾');
  chk('★ 回顾在本月日志里留了行（不然"没回顾"是门槛没过还是写盘挂了，只能猜）',
    lines.length >= 2, `${lines.length} 行`);
  chk('  记了"素材多少字"', lines.some((l) => /开始想今天（素材 \d+ 字）/.test(l)), '');
  chk('★ 记了"她动手时的空闲分钟数 / 门槛"——这就是那个可验收指标',
    lines.some((l) => /键鼠停了\s*[\d.]+\s*分钟（门槛\s*\d+）/.test(l)),
    (lines.find((l) => /键鼠停了/.test(l)) || '').slice(-40));
  chk('  记了这趟的耗时和落库条数',
    lines.some((l) => /完成 · \d+ms · 心事 \d+ · 情绪/.test(l)), '');

  chk('★ 回顾这趟进账本了（不记的话「今天花了多少」会永远偏低）',
    usage.all().todayCalls >= 1, `todayCalls=${usage.all().todayCalls}`);

  /* ══════════════════════════════════════════════════════
     隔离
     ══════════════════════════════════════════════════════ */
  console.log('\n【隔离检查】');
  const REAL = 'C:\\Users\\Susim\\AppData\\Roaming\\Yachiyo';
  chk('跑在隔离目录里', HOME.includes('_selfcheck-home-4a'), HOME);
  chk('  真目录里的 review.json 没被这次自检写过（mtime 该早于今天开跑）',
    (() => {
      const f = path.join(REAL, 'data', 'state', 'review.json');
      if (!fs.existsSync(f)) return true;          // 本来就没有 = 更没被碰
      return fs.statSync(f).mtimeMs < STARTED;
    })(), path.join(REAL, 'data', 'state', 'review.json'));

  provider.chat = realChat;

  console.log('\n' + '─'.repeat(52));
  const pass = out.filter((x) => x.ok).length;
  console.log(`  ${pass}/${out.length} 通过  ${pass === out.length ? '✓ 全过' : '✗ 有失败'}`);
  console.log('─'.repeat(52) + '\n');

  const bad = out.filter((x) => !x.ok);
  if (bad.length) {
    console.log('失败明细：');
    for (const b of bad) console.log(`  - ${b.name}: ${b.detail}`);
  }
  process.exit(pass === out.length ? 0 : 1);
})().catch((e) => {
  console.error('\n自检自己炸了：', e.stack || e.message);
  process.exit(1);
});
