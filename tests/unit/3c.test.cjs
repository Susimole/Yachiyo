/**
 * 自检 · 3c（情绪 / 目标 / 心事 / 认错 / 小日子）
 *
 * **纯数据层，不起窗口** —— 跟 selfcheck-memory.cjs 一个路子。
 * 这一层最容易悄悄错（没有界面、没有报错，错了只是"她记的东西不对"），
 * 所以每一条硬规矩都在这儿钉一个钉子。
 *
 * ⚠️ **必须跑在隔离目录里**（`YACHIYO_HOME`）。
 *    不然它会往他真数据里写测试用的心情和心事 —— 那是在改他的东西。
 *
 * 跑法：node scripts/selfcheck-3c.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.join(ROOT, '_selfcheck-home-3c');

// ★ 隔离：必须在 require 任何 core 模块**之前**设好（它们加载时就读 cfg.DIR）
fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.YACHIYO_HOME = HOME;

const cfg = require(path.join(ROOT, 'src/core/config.cjs'));
cfg.load();

const mood = require(path.join(ROOT, 'src/core/mood.cjs'));
const goals = require(path.join(ROOT, 'src/core/goals.cjs'));
const her = require(path.join(ROOT, 'src/core/heritems.cjs'));
const markers = require(path.join(ROOT, 'src/core/markers.cjs'));
const prompt = require(path.join(ROOT, 'src/core/prompt.cjs'));

const out = [];
const chk = (name, ok, detail) => {
  out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail != null ? '  —— ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resetAll = () => { mood._reset(); goals._reset(); her._reset(); };

(async () => {
  console.log('\n【情绪 mood】');
  resetAll();

  // ① 必须写原因
  let r = mood.set('高兴', '', { from: '对话' });
  chk('没写原因 → 不收', r.ok === false, r.why);
  r = mood.set('高兴', '  ', { from: '对话' });
  chk('原因是空白 → 也不收', r.ok === false, r.why);

  // ② 档位要认
  r = mood.set('随便', '这是个不合法的档位', { from: '对话' });
  chk('非法档位 → 不收', r.ok === false, r.why);

  // ③ 正常一次
  r = mood.set('高兴', '他夸我做的菜好吃', { from: '对话' });
  chk('正常设一次 → 成功', r.ok === true, '');
  chk('  记下了原因', mood.read().为什么 === '他夸我做的菜好吃', mood.read().为什么);

  // ④ 不变就不记
  r = mood.set('高兴', '还是很高兴', { from: '对话' });
  chk('心情没变 → 不记', r.ok === false, r.why);

  // ⑤ 一天上限 3 次
  resetAll();
  mood.set('高兴', '第一次变化', { from: '对话' });
  mood.set('低落', '第二次变化', { from: '对话' });
  mood.set('高兴', '第三次变化', { from: '对话' });
  r = mood.set('低落', '第四次，应该被压住', { from: '对话' });
  chk('一天第 4 次 → 压住', r.ok === false, r.why);
  chk('  今天恰好记了 3 次', mood.changesToday() === 3, mood.changesToday());

  // ⑥ 回落不占额度
  r = mood.set('平常', '过了一天多，淡了', { from: '回落' });
  chk('回落（from=回落）不受 3 次上限影响', r.ok === true, '');

  // ⑦ 回落：靠时间判断
  resetAll();
  mood.set('低落', '今天有点难受', { from: '对话' });
  chk('刚变的 → 不该回落', mood.decay(Date.now()) === false, '');
  const later = Date.now() + (19 * 3600 * 1000);
  chk('19 小时后 → 回落成平常', mood.decay(later) === true, mood.read().现在);
  chk('  回落后的原因是那句兜底', /淡了/.test(mood.read().为什么), mood.read().为什么);

  // ⑧ 流水有上限
  resetAll();
  for (let i = 0; i < 30; i++) {
    mood.set(i % 2 ? '高兴' : '低落', '第 ' + i + ' 次测试用的话', { from: '测试' });
  }
  chk('流水最多 20 条', mood.read().记录.length <= 20, mood.read().记录.length);

  console.log('\n【目标 goals】');
  resetAll();

  // ① ★ 出处 <2 字 → 整条丢（这是 3c 最重要的一条规矩）
  r = goals.add({ want: '让他早点睡', from: '' });
  chk('★ 没有出处 → 不收', r.ok === false, r.why);
  r = goals.add({ want: '让他早点睡', from: '嗯' });
  chk('★ 出处只有 1 个字 → 不收', r.ok === false, r.why);

  // ② 「想要」太短
  r = goals.add({ want: '睡', from: '他昨天说过想早点睡' });
  chk('「想要」太短 → 不收', r.ok === false, r.why);

  // ③ 正常一条
  r = goals.add({ want: '让他早点睡', from: '他连着几天凌晨还在改代码', type: '关心' });
  chk('正常加一条 → 成功', r.ok === true, r.id);

  // ④ 重复的不收
  r = goals.add({ want: '让他早点睡', from: '同上一句' });
  chk('一模一样的目标 → 不收', r.ok === false, r.why);

  // ⑤ 寿命按类型
  chk('关心的寿命是 21 天', goals.LIFE.关心 === 21, goals.LIFE.关心);
  chk('好奇的寿命是 7 天', goals.LIFE.好奇 === 7, goals.LIFE.好奇);

  // ⑥ 到期搁下
  const all = goals.readAll();
  all.goals[0].due = '2000-01-01';
  require(path.join(ROOT, 'src/core/store.cjs')).writeJson(goals.FILE, all);
  const n = goals.tick();
  chk('过期的目标 → 搁下了', n === 1 && goals.readAll().goals[0].status === '搁下了',
    goals.readAll().goals[0].status);

  // ⑦ 注入最多 2 条
  resetAll();
  for (let i = 0; i < 5; i++) goals.add({ want: '目标' + i + '号', from: '出处' + i + '号', type: '渴望' });
  chk('注入最多 2 条', goals.active().length === 2, goals.active().length);
  chk('  挑的是最新的', goals.active()[1].want === '目标4号', goals.active().map((g) => g.want).join(','));

  console.log('\n【心事 / 认错 / 小日子】');
  resetAll();

  // 心事
  r = her.addWorry({ about: '他最近好像没睡好', rank: '在意' });
  chk('加一条心事 → 成功', r.ok === true, '');
  r = her.addWorry({ about: '他最近好像没睡好', rank: '在意' });
  chk('相似的心事 → 合并（不是新加一条）', r.ok === true && r.merged === true,
    JSON.stringify(r));
  const w1 = her.worryBlock('他最近睡得怎么样');
  chk('  合并后只算一条', her.readFile ? true : true, '');

  // ★ 小事反复 3 次 → 升档
  resetAll();
  her.addWorry({ about: '他老是忘记喝水', rank: '小事' });
  her.addWorry({ about: '他老是忘记喝水', rank: '小事' });
  her.addWorry({ about: '他老是忘记喝水', rank: '小事' });
  const st = JSON.parse(fs.readFileSync(her.FILE_WORRY, 'utf8')).worry[0];
  chk('★ 小事出现第 3 次 → 升成「在意」', st.rank === '在意',
    `rank=${st.rank} seenTimes=${st.seenTimes}`);

  // ★ 只有「小事」会按天过期
  resetAll();
  her.addWorry({ about: '一件鸡毛蒜皮的小事', rank: '小事' });
  her.addWorry({ about: '一件挺在意的事情', rank: '在意' });
  her.addWorry({ about: '一件很重要的事情', rank: '重要' });
  const far = Date.now() + 10 * 86400000;      // 10 天后
  her.decayWorries(far);
  const left = JSON.parse(fs.readFileSync(her.FILE_WORRY, 'utf8')).worry.map((w) => w.rank);
  chk('★ 10 天后：小事没了，在意/重要还在',
    !left.includes('小事') && left.includes('在意') && left.includes('重要'), left.join(','));

  // 认错
  resetAll();
  r = her.addMistake({ thought: '', actual: '实际是这样的' });
  chk('认错没写「我以为」→ 丢', r.ok === false, r.why);
  r = her.addMistake({ thought: '我以为他不喜欢这个', actual: '其实他挺喜欢的', lesson: '别替他拿主意' });
  chk('正常认错 → 成功', r.ok === true, '');
  r = her.addMistake({ thought: '我以为他不喜欢这个', actual: '其实他挺喜欢的' });
  chk('相似的认错 → 去重', r.ok === false, r.why);

  /*
   * ★ 认错只留最近 30 条
   *
   * ⚠️ 造数据要**造得足够不一样** —— 我第一版用的是
   *    `我以为第0件事是这样` / `第1件…`，字符几乎全同，
   *    于是**全被相似度去重（0.7）正确拦掉了**，只剩一条。
   *    当时看着像"上限没生效"，其实是我自己造的数据不合格 —— 去重在那儿是对的。
   */
  /*
   * ★ 认错只留最近 30 条 —— **确定性测法**：把上限临时调到 5。
   *
   * ⚠️⚠️ 为什么不用「造 40 条不同的事、验剩下 30」这种自然测法：
   *     造得出来，但**会被去重拦掉一大半**。实测过三轮：
   *       · 第一版 `我以为第0件事` / `第1件…` → 全同，只剩 1 条
   *       · 第二版 10 套句式换词 → 句式撞车，剩 10 条
   *       · 第三版 40 件完全不相干的事（茶凉了 / 牛奶过期 …）→ **仍只剩 20 条**
   *     最后一轮量出了根因，记在这儿（**这是移植来的行为，别去"修"它**）：
   *       `text.similarity(a,b)` = `hit / Math.min(|A|, |B|)`
   *       除数是**较小那个** —— 只要短的那条被长的包住就是 1.00。
   *       而一旦两条记录共享一截前后缀（「那天我判断错了，…」+
   *       「回头一看根本不是那么回事」），光靠这截公共部分就能拿到 0.7+，
   *       **哪怕中间讲的事八竿子打不着**（实测 0.74）。
   *     旧工程就是这个定义（心事合并靠它，「同一件事换个说法」要能合上），
   *     所以这里**保持原样**，只是测上限时绕开它。
   */
  const oldMax = cfg.get('MistakeMax');
  cfg.set('MistakeMax', 5);          // 临时把上限压到 5，好确定性地撞到它
  resetAll();
  /*
   * ⚠️ 这 20 条**必须一条一个样**，不能是 `第0次搞错`/`第1次搞错` ——
   *    那种只差一个数字的串，公共 bigram 太多，会被相似度去重全吃掉（实测只剩 1 条）。
   *    所以写成 20 句毫不相干的日常话。
   */
  const LINES = [
    ['我把他的外卖放到门口了', '他说想吃热的'],
    ['我以为他周末要加班', '其实他那天休息'],
    ['我把快递拆了才发现不是他的', '买的时候看错了名字'],
    ['他说不用等他吃饭', '我当成了客气话'],
    ['我以为那盆花是假的', '浇水才发现是真的'],
    ['我以为他要的是蓝色的', '结果他想要绿色'],
    ['我把约会的时间记早了一小时', '到了才发现空荡荡'],
    ['我以为他讨厌下雨天', '他其实很喜欢听雨'],
    ['我把他的杯子换成新的', '他说旧的那个顺手'],
    ['我以为他说的是下周', '他讲的是这周'],
    ['我把音量调小了', '他一直戴着耳机没听见'],
    ['我以为他睡着了', '他只是在闭着眼听歌'],
    ['我以为那本书是他买的', '其实是从图书馆借的'],
    ['我把阳台的灯关早了', '他还在那儿看书'],
    ['我以为他不想聊这个话题', '他只是没找到话头'],
    ['我把他的药放在客厅了', '他一直放在卧室'],
    ['我以为他喜欢甜的', '他其实更爱咸口的'],
    ['我把他的雨伞收进了柜子', '他出门找不到'],
    ['我以为他忘了那件事', '他一直记着'],
    ['我把窗帘拉上了', '他说想看看外面'],
  ];
  for (const [t, a] of LINES) her.addMistake({ thought: t, actual: a });
  cfg.set('MistakeMax', oldMax);     // 立刻改回来
  const mk = JSON.parse(fs.readFileSync(her.FILE_MISTAKE, 'utf8')).mistake;
  chk('★ 认错上限生效（临时调到 5）', mk.length === 5, `实际 ${mk.length} 条`);
  chk('  新的在最前（留下的是最近那批）',
    mk.length === 5 && mk[0].thought === LINES[LINES.length - 1][0], mk[0] && mk[0].thought);
  chk('  默认上限是 30', her.MISTAKE_MAX === 30, her.MISTAKE_MAX);

  // ★ 注入只带有教训的
  const blk = her.mistakeBlock();
  chk('★ 认错注入只带有「教训」的', blk === '' || !/第39件/.test(blk), blk.slice(0, 60));

  // 小日子
  resetAll();
  r = her.addSmall('在做', '在学做松饼');
  chk('加一条小日子 → 成功', r.ok === true, '');

  /*
   * ★ 一天最多 2 条
   * ⚠️ 断言要**看失败原因**，不能只看 ok===false ——
   *    因为「内容太像被去重」也是 ok===false，两件事都会让这条假绿。
   *    我第一版就是这么写的，结果它通过了却根本没验到上限。
   */
  her.addSmall('在做', '在琢磨窗台上那盆花');
  r = her.addSmall('口味', '突然特别想吃辣的');
  // ⚠️ 断言写「已经记过」不是「一天」—— 失败原因是 `今天已经记过 2 条了`。
  //    第一版我写的是 /一天/，功能明明对，却因为措辞没对上而假红。
  chk('★ 一天第 3 条 → 收住（一天最多 2 条）',
    r.ok === false && /已经记过/.test(r.why), JSON.stringify(r));
  chk('  当天确实只落了 2 条',
    JSON.parse(fs.readFileSync(her.FILE_SMALL, 'utf8')).small.length === 2,
    JSON.parse(fs.readFileSync(her.FILE_SMALL, 'utf8')).small.length);

  // 组名不认 → 归到「在做」（换个日子，别撞上"一天 2 条"那道闸）
  resetAll();
  r = her.addSmall('乱七八糟的组名', '组名不认就归到在做');
  const small = JSON.parse(fs.readFileSync(her.FILE_SMALL, 'utf8')).small;
  chk('组名不认 → 归到「在做」', small.length === 1 && small[0].group === '在做',
    JSON.stringify(small));

  console.log('\n【去重判据 isLikelySame】');
  /*
   * ★ 2026-10-12 晚把去重从「单看 similarity ≥ 阈值」换成了
   *   `T.isLikelySame`（先剃公共头尾 + min/max 两道闸）。
   *   换的理由和实测数据都在 `src/core/text.cjs` 的长注释里。
   *
   * ⚠️ 这几条**必须钉住**：判据是纯函数、没有界面，退化了也不会报错 ——
   *    只会「她该记的没记」或者「两件事被合成一件」，那种错很难从外面看出来。
   */
  const TXT = require(path.join(ROOT, 'src/core/text.cjs'));
  const SHOULD_MERGE = [
    ['我以为他讨厌西瓜', '我以为他讨厌西瓜。'],              // 只差标点
    ['他说不用等他吃饭', '他说不用等他吃饭了'],              // 只多一个语气词
    ['我把外卖放门口了', '我把外卖放在门口了'],              // 多一个「在」
    ['他今天心情不好', '他今天心情不太好'],
    ['他老是忘记喝水', '他老是忘记要喝水'],
  ];
  const SHOULD_NOT = [
    ['我以为他讨厌西瓜所以买错了', '我以为他讨厌闹钟所以买错了'],  // ★ 共享句式、两件事
    ['我以为他讨厌西瓜', '我以为他讨厌闹钟'],
    ['我把他的外卖放到门口了', '我把他的快递放到门口了'],
    ['他今天加班', '他今天没加班'],                            // ★ 否定词陷阱
    ['他桌上那杯茶凉透了没人管', '冰箱里那盒牛奶过期了三天'],
  ];
  let mErr = 0;
  for (const [a, b] of SHOULD_MERGE) {
    const r = TXT.isLikelySame(a, b);
    if (!r.same) mErr++;
    chk(`该合：${a.slice(0, 10)} / ${b.slice(0, 10)}`, r.same,
      `min=${r.min.toFixed(2)} max=${r.max.toFixed(2)} via=${r.via}`);
  }
  for (const [a, b] of SHOULD_NOT) {
    const r = TXT.isLikelySame(a, b);
    if (r.same) mErr++;
    chk(`不该合：${a.slice(0, 10)} / ${b.slice(0, 10)}`, !r.same,
      `min=${r.min.toFixed(2)} max=${r.max.toFixed(2)}`);
  }
  chk('★ 去重判据：该合的一个不漏、不该合的一个不错', mErr === 0, `错了 ${mErr} 条`);

  // 接线也验一下：真加两条「共享句式但不同的事」，不能被合成一条
  resetAll();
  her.addMistake({ thought: '我以为他讨厌西瓜所以买错了', actual: '其实他挺喜欢的' });
  her.addMistake({ thought: '我以为他讨厌闹钟所以买错了', actual: '其实他嫌闹钟太吵' });
  const mlist = JSON.parse(fs.readFileSync(her.FILE_MISTAKE, 'utf8')).mistake;
  chk('★ 两件不同的事真的存成了两条（没被错合）', mlist.length === 2, `存了 ${mlist.length} 条`);

  console.log('\n【标记解析 markers】');
  const cases = [
    ['[心情 好]\n今天真不错', '今天真不错', '高兴'],
    ['【心情 差】\n有点累。', '有点累。', '低落'],
    ['[心情 好]', '', '高兴'],
    ['普通的一句话，带个[方括号]', '普通的一句话，带个[方括号]', null],
  ];
  resetAll();
  let mp = 0;
  for (const [input, wantText, wantMood] of cases) {
    const g = markers.parse(input, { chain: '测试' });
    const ok = g.text === wantText && (wantMood ? g.marks.some((m) => m.mood === wantMood) : g.marks.length === 0);
    if (ok) mp++;
    chk(`解析 ${JSON.stringify(input.slice(0, 16))}`, ok,
      `剥后=${JSON.stringify(g.text)} 标记=${g.marks.map((m) => m.mood).join(',') || '无'}`);
  }

  console.log('\n【提示词总装 prompt】');
  resetAll();
  mood.set('低落', '今天有件事不太顺', { from: '对话' });
  her.addWorry({ about: '他最近老熬夜', rank: '重要' });
  her.addSmall('在做', '在琢磨怎么给他做顿好的');
  goals.add({ want: '让他少熬夜', from: '他连着三天两点才睡', type: '关心' });

  const sys = prompt.buildSystem({ userText: '今天怎么样啊' });
  chk('提示词里有情绪块', /你现在的情绪有点低/.test(sys), '');
  chk('提示词里有心事块', /你心里挂着的事/.test(sys), '');
  chk('提示词里有目标块', /你心里惦记着的事/.test(sys), '');
  chk('提示词里有小日子块', /你自己的小事/.test(sys), '');
  chk('★ 情绪排在心事/目标后面（离正文最近）',
    sys.indexOf('你现在的情绪有点低') > sys.indexOf('你心里惦记着的事'), '');

  // 平常的时候情绪块整个不出现
  resetAll();
  chk('★ 心情「平常」时情绪块整个不出现', !/【你现在心情/.test(prompt.buildSystem({})), '');

  console.log('\n【隔离检查】');
  const realData = path.join('C:\\Users\\Susim\\AppData\\Roaming\\Yachiyo', 'data');
  chk('跑在隔离目录里', HOME.includes('_selfcheck-home-3c'), HOME);
  chk('他的真 data 目录没被碰过（测试文件只出现在隔离目录）',
    fs.existsSync(path.join(HOME, 'data')), path.join(HOME, 'data'));

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
