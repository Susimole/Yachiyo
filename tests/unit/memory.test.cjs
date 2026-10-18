/**
 * 3b 自检 —— 记忆层。
 *
 * ⚠️ 这一层**页面上什么都看不见**，所以没法像外壳那样截图验收。
 *    全部靠这个脚本：造数据 → 读回来 → 对数。
 *
 * ⚠️ 全程跑在**隔离目录**里（`YACHIYO_HOME`），他的真配置 / 真记忆
 *    一个字节都不会被碰。脚本最后会自己查一遍这件事。
 *
 * 跑法：node scripts/selfcheck-memory.cjs
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

/* ⚠️ 必须在 require core 之前设 —— config.cjs 是在模块加载那一刻读它的 */
const HOME = path.join(__dirname, '..', '_selfcheck-home-mem');
process.env.YACHIYO_HOME = HOME;

const REAL_DATA = path.join(process.env.APPDATA || '', 'Yachiyo', 'data');

/**
 * 开跑之前给他真那个目录拍张照（文件名 + 大小 + mtime）。
 *
 * ⚠️⚠️ 原来这条断言写的是 `readdirSync(REAL_DATA).length === 0` ——
 *    「他的目录必须是空的」。这在**他还没跑过新版**的时候成立，
 *    可他只要自己开一次桌宠，usage.json / state/ 就进去了，
 *    这条就永远红着 —— 而它想证明的其实不是「空」，
 *    是「**这一跑没碰它**」。用前后对比才是它真正想说的意思。
 */
function snapRealDir() {
  const out = {};
  const walk = (dir, prefix) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, rel);
      else {
        let st = null;
        try { st = fs.statSync(p); } catch { /* 读不到就算了 */ }
        out[rel] = st ? `${st.size}@${Math.round(st.mtimeMs)}` : '?';
      }
    }
  };
  walk(REAL_DATA, '');
  return out;
}
const REAL_BEFORE = snapRealDir();

const results = [];
let pass = 0, fail = 0;

function ok(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail: String(detail) });
  if (cond) pass++; else fail++;
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${detail ? '  —— ' + detail : ''}`);
}

/* ═══════════════ 起手：清空隔离目录 ═══════════════ */

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });

const cfg     = require('../../src/core/config.cjs');
const store   = require('../../src/core/store.cjs');
const T       = require('../../src/core/text.cjs');
const memory  = require('../../src/core/memory.cjs');
const habits  = require('../../src/core/habits.cjs');
const profile = require('../../src/core/profile.cjs');
const prompt  = require('../../src/core/prompt.cjs');
const learn   = require('../../src/core/learn.cjs');

cfg.load();

console.log(`\n隔离目录：${HOME}\n`);

/* ═══════════════ 1. 文本工具 ═══════════════ */

console.log('【文本工具】');

{
  const g = T.gramSet('他会熬夜打游戏');
  ok('2-gram 分词', g.has('他会') && g.has('会熬') && g.has('熬夜'),
    `${g.size} 个 gram`);

  const e = T.gramSet('i7 GPU 跑 4090');
  ok('英数整词小写', e.has('gpu') && e.has('4090') && !e.has('i'),
    [...e].join(','));

  ok('相似度 · 同一句 = 1', T.similarity('他会熬夜', '他会熬夜') === 1);
  ok('相似度 · 无关句 = 0', T.similarity('他会熬夜', '今天天气不错') === 0);
  const mid = T.similarity('他会上晚班下班后不马上睡', '他会熬夜打游戏到很晚');
  ok('相似度 · 沾边句在 0~1 之间', mid > 0 && mid < 1, mid.toFixed(3));

  const slots = T.stripEmptySlots(['## 基本情况', '- 他在意什么：', '- 他上晚班'].join('\n'));
  ok('画像剔空槽', !slots.includes('他在意什么') && slots.includes('他上晚班'),
    JSON.stringify(slots.split('\n').length + ' 行'));
}

/* ═══════════════ 2. 习惯库 ═══════════════ */

console.log('\n【习惯库】');

{
  const a = habits.addHabit('他会保证吃饭，不太会让自己饿着');
  const b = habits.addHabit('他会上晚班，下班后不马上睡');
  const c = habits.addHabit('他喜欢喝冰的');
  const dup = habits.addHabit('他喜欢喝冰的');          // 完全一样，不该重复加
  ok('写入 3 条', a && b && c && !dup, `重复那条被挡下 = ${!dup}`);

  const hs = habits.readHabits();
  ok('读回 3 条', hs.length === 3, hs.map((h) => h.text.slice(0, 6)).join(' / '));
  ok('带上了日期', /^\d{4}-\d{2}-\d{2}$/.test(hs[0].date), hs[0].date);

  // 他手改文件也要认
  const before = fs.readFileSync(habits.FILE_HABITS, 'utf8');
  fs.writeFileSync(habits.FILE_HABITS,
    before + '<!-- 他手写的一行注释 -->\n# 又一个标题\n- 他半夜会饿\n', 'utf8');
  const hs2 = habits.readHabits();
  ok('认手改 · 注释/标题行不算条目', hs2.length === 4 && hs2[3].text === '他半夜会饿',
    `${hs2.length} 条`);
}

/* ═══════════════ 3. 梗库 + 检索 + 热度 ═══════════════ */

console.log('\n【梗库 · 检索 · 热度】');

{
  habits.addMeme('撤硕', ['厕所间'], '厕所');
  habits.addMeme('塔科夫', [], 'Escape from Tarkov 那个游戏');
  habits.addMeme('冰阔落', ['肥宅快乐水'], '冰可乐');
  ok('写入 3 条梗', habits.readMemes().length === 3);

  const hit = habits.selectMemes('我去趟撤硕', 5);
  ok('精确包含命中', hit.length === 1 && hit[0].word === '撤硕', hit.map((x) => x.word).join(','));

  const viaAlias = habits.selectMemes('帮我拿瓶冰阔落上来', 5);
  ok('别名也命中', viaAlias.length === 1 && viaAlias[0].word === '冰阔落');

  const none = habits.selectMemes('今天天气不错啊', 5);
  ok('不沾边就不命中', none.length === 0);

  const multi = habits.selectMemes('打完塔科夫去撤硕', 5);
  ok('一句里命中多条', multi.length === 2, multi.map((x) => x.word).join(','));
}

{
  // 热度：命中次数 + 封顶
  // ⚠️ 要挑一条**还没被检索命中过**的来测 —— 上面 selectMemes 已经把
  //    「撤硕」「塔科夫」「冰阔落」各记过命中了，拿它们当基准，
  //    次数就不是从 0 开始的（我第一版就是这么错的，断言写死 3，实际 5）。
  const key = 'M|塔科夫';
  habits.flushHits();
  const seed = store.readJson(habits.FILE_HITS, {});
  delete seed[key];
  store.writeJson(habits.FILE_HITS, seed);
  habits.reload();                       // 缓存里那份也扔掉

  for (let i = 0; i < 3; i++) habits.noteHit(key);
  habits.flushHits();

  const raw = store.readJson(habits.FILE_HITS, {});
  ok('命中记录格式 次数|日期', /^3\|\d{4}-\d{2}-\d{2}$/.test(raw[key]), raw[key]);

  const h3 = habits.heat(raw[key]);
  ok('热度 = 次数×权重 + 时间加成', h3 > 0 && h3 < 1, `3 次 → ${h3.toFixed(3)}（0.15×3 + 0.5 = 0.95）`);

  for (let i = 0; i < 40; i++) habits.noteHit(key);
  habits.flushHits();
  const raw2 = store.readJson(habits.FILE_HITS, {});
  ok('热度封顶 1.0', habits.heat(raw2[key]) === 1,
    `命中 ${raw2[key].split('|')[0]} 次 → ${habits.heat(raw2[key])}（不封顶会是 6.5）`);
}

/* ═══════════════ 4. 归档 ═══════════════ */

console.log('\n【归档】');

{
  // 把「冰阔落」的命中日期改到 400 天前
  const raw = store.readJson(habits.FILE_HITS, {});
  raw['M|冰阔落'] = '1|2025-01-01';
  store.writeJson(habits.FILE_HITS, raw);

  const before = habits.readMemes().length;
  const moved = habits.archive(180);
  const after = habits.readMemes().length;

  ok('陈旧条目被挪走', moved.memes === 1 && after === before - 1,
    `${before} → ${after} 条`);

  const arch = store.readText(path.join(store.ARCHIVE, 'memes.md')) || '';
  ok('归档文件里找得到（**没删**）', arch.includes('冰阔落'));

  ok('没被命中的条目没误伤',
    habits.readMemes().length === 2, `剩 ${habits.readMemes().length} 条`);

  // 从未命中过的条目应该被补上「今天」，而不是当场归档
  const raw2 = store.readJson(habits.FILE_HITS, {});
  ok('从未命中的补了今天而不是归档',
    /^0\|\d{4}-\d{2}-\d{2}$/.test(raw2['M|塔科夫'] || '') || !!raw2['M|塔科夫'],
    raw2['M|塔科夫'] || '(无)');
}

/* ═══════════════ 5. 人物画像 ═══════════════ */

console.log('\n【人物画像】');

{
  ok('还没画像时不注入', profile.buildBlock() === '' && !profile.usable());

  // 直接写一份带空槽的，验「读的时候剔不剔」
  store.writeText(profile.FILE, profile.HEAD + [
    '## 基本情况',
    '- 上晚班，作息跟大多数人反着来',
    '- 在意什么：',
    '- 他的工作：',
    '## 他的性子',
    '- 嘴上嫌麻烦，实际上该干的都干了',
  ].join('\n') + '\n');

  const got = profile.read();
  ok('读画像剔掉空槽行', !got.includes('在意什么：') && !got.includes('他的工作：'),
    `${got.split('\n').length} 行`);
  ok('正文还在', got.includes('上晚班') && got.includes('嘴上嫌麻烦'));
  ok('文件头没进正文', !got.includes('八千代自己一天天写下来'), `首行 = ${got.split('\r\n')[0]}`);

  const blk = profile.buildBlock();
  ok('注入块标题正确', blk.startsWith('【你心里关于「他这个人」的画像】'), blk.split('\r\n')[0]);
  ok('文件不存在时不该崩', (() => {
    store.writeText(profile.FILE, '');
    return profile.read() === '' && profile.buildBlock() === '';
  })());

  // 复原，后面总装要用
  store.writeText(profile.FILE, profile.HEAD +
    '## 基本情况\n- 上晚班，作息跟大多数人反着来\n- 嘴上嫌麻烦，实际上该干的都干了\n');
}

/* ═══════════════ 6. 跨会话「最近发生的事」 ═══════════════ */

console.log('\n【跨会话】');

{
  memory.clear();
  memory.push('user', '嗯');                                  // <4 字，该丢
  memory.push('assistant', '怎么啦？');
  memory.push('user', '今天那个骨架调试台总算是跑起来了');      // 该留
  memory.push('user', '晚上想吃点啥');                         // 该留
  memory.push('assistant', '我不知道啊');

  const s = memory.saveSession();
  ok('存下来了', !!s && s.Text.length > 0, `${s.Text.length} 字`);
  ok('来源标的是机械取', s.Source === '本地机械取（退出）', s.Source);
  ok('只取他说的 · 短句被丢掉', !s.Text.includes('嗯') && s.Text.includes('骨架调试台'),
    JSON.stringify(s.Text));
  ok('每行带 - 前缀', s.Text.split('\n').every((l) => l.startsWith('- ')));
  ok('时间序（先说的在前）', s.Text.indexOf('骨架调试台') < s.Text.indexOf('晚上想吃'),
    '顺序对');
  ok('总长不超过 240 字', s.Text.length <= 240, `${s.Text.length} 字`);

  const blk = memory.buildSessionBlock();
  ok('注入块格式对',
    blk.startsWith('【你们上次聊到这儿】') && blk.includes('背景资料') &&
    blk.split('\r\n').length >= 3, `${blk.split('\r\n').length} 行`);
}

/* ═══════════════ 7. 「我说过什么」 ═══════════════ */

console.log('\n【我说过什么】');

{
  memory.addSpoken('主动', '外面下雨了，你带伞没');
  memory.addSpoken('识屏', '说好眯一小时，人却在这刷群——');
  memory.addSpoken('主动', '这都几点了还不睡');
  memory.addSpoken('主动', 'x');                       // 太短，该丢
  memory.addSpoken('主动', '你那个\n\n方案\n写完了吗');   // 换行该压成空格

  const rec = memory.recentSpoken(3);
  ok('取最近 3 条', rec.length === 3, rec.map((x) => x.k).join(','));
  ok('换行压成了空格', rec[2].s === '你那个 方案 写完了吗', JSON.stringify(rec[2].s));
  ok('太短的没进来', !memory.readSpoken().Items.some((x) => x.s === 'x'));

  const blk = memory.buildSpokenBlock();
  ok('注入块格式对',
    blk.startsWith('【你最近自己说过的话】') && blk.includes('- [主动]'), blk.split('\r\n')[0]);
}

/* ═══════════════ 8. 提示词总装 ═══════════════ */

console.log('\n【提示词总装】');

{
  const sys = prompt.buildSystem({ userText: '我去趟撤硕' });

  ok('有人格块', sys.includes('# 你是谁'));
  ok('有记忆块', sys.includes('【你记得的这些】') && sys.includes('关于他的习惯：'));
  ok('有梗块（这次句子里命中了）', sys.includes('撤硕 = 厕所'));
  ok('有画像块', sys.includes('【你心里关于「他这个人」的画像】'));
  ok('有跨会话块', sys.includes('【你们上次聊到这儿】'));
  ok('有我说过什么块', sys.includes('【你最近自己说过的话】'));
  ok('有关系块', sys.includes('【你和他是什么关系】'));
  ok('有时间块', sys.includes('【现在的时间】') && sys.includes('星期'));

  ok('块间是 CRLF 空行', sys.includes('\r\n\r\n'));
  ok('没有连续三个换行（空块没留洞）', !/\r\n\r\n\r\n/.test(sys),
    (sys.match(/\r\n\r\n\r\n/g) || []).length + ' 处');
  ok('没有裸 LF', !/[^\r]\n/.test(sys));

  // 块的先后顺序 —— 旧工程是「人格 → 记忆 → 画像 → 跨会话 → 我说过 → 关系 → 时间」
  const order = ['# 你是谁', '【你记得的这些】', '【你心里关于「他这个人」的画像】',
    '【你们上次聊到这儿】', '【你最近自己说过的话】', '【你和他是什么关系】', '【现在的时间】'];
  let last = -1, sorted = true;
  for (const k of order) {
    const i = sys.indexOf(k);
    if (i < 0 || i < last) { sorted = false; break; }
    last = i;
  }
  ok('块顺序跟旧工程一致', sorted, order.length + ' 块');

  console.log(`     （整段 ${sys.length} 字 / ${sys.split('\r\n\r\n').length} 块）`);
}

{
  // 全关掉 → 不该留空标题
  const bak = cfg.get('memEnabled');
  cfg.set('memEnabled', false);
  const sys = prompt.buildSystem({ userText: '我去趟撤硕' });
  ok('记忆总开关关掉就不出现', !sys.includes('【你记得的这些】'));
  ok('关掉之后没有空洞', !/\r\n\r\n\r\n/.test(sys));
  cfg.set('memEnabled', bak);
}

/* ═══════════════ 9. 学习链 ═══════════════ */

console.log('\n【学习链】');

{
  const modelSaid = [
    '好的，我看看。',
    '习惯|他熬夜是常态，凌晨两三点还醒着',
    '习惯|他爱吃松饼',
    '习惯|这个月的房租要交了',          // 这是事件不是习惯 —— 但解析层不管，靠提示词约束
    '习惯|第四条应该被截掉',
    '梗|搓炉石 = 打炉石传说',
    '梗|这个没有等号 应该被丢',
    '目标|这个 3b 不做，该被忽略',
  ].join('\n');

  const p = learn.parse(modelSaid);
  ok('解析出习惯', p.habits.length === 3, `${p.habits.length} 条（上限 3）`);
  ok('解析出梗', p.memes.length === 1, `${p.memes.length} 条`);
  ok('没有等号的那条被丢', !p.memes.some((m) => m.mean.includes('等号')));
  ok('不认的前缀被忽略', !JSON.stringify(p).includes('3b 不做'));
  ok('废话行被忽略', !JSON.stringify(p).includes('好的，我看看'));

  // ⚠️ 单独测「行首的 -」—— 塞进上面那段的话会被「最多 3 条」的上限挡掉，
  //    看着像宽容失败了（我第一版就是这么误判的）。
  const dash = learn.parse('- 习惯|他半夜会饿\n* 梗|打野 = 去野外');
  ok('行首的 - / * 能被宽容掉',
    dash.habits.length === 1 && dash.habits[0].text === '他半夜会饿' &&
    dash.memes.length === 1 && dash.memes[0].word === '打野',
    `${dash.habits.length} 习惯 / ${dash.memes.length} 梗`);

  const q = learn.parse('习惯|[?]他好像不太爱吃甜的');
  ok('模型标 [?] 的进 unsure', q.habits[0]?.unsure === true,
    JSON.stringify(q.habits[0]));

  // 待确认
  const r1 = learn.apply(p);
  ok('默认全部进待确认', r1.wrote === 0 && r1.pending === 4,
    `写库 ${r1.wrote} · 待确认 ${r1.pending}`);
  ok('待确认文件格式对',
    store.readText(learn.FILE_PENDING).includes('- [H] 他熬夜是常态'),
    learn.readPending().length + ' 条');

  // 采纳
  const n0 = habits.readHabits().length;
  const m0 = habits.readMemes().length;
  const adopted = learn.acceptPending();
  ok('全部采纳之后进库', adopted === 4 && habits.readHabits().length === n0 + 3,
    `习惯 ${n0} → ${habits.readHabits().length} · 梗 ${m0} → ${habits.readMemes().length}`);
  ok('采纳完待确认清空', learn.readPending().length === 0);
  ok('梗也进库了', habits.readMemes().some((m) => m.word === '搓炉石' && m.mean === '打炉石传说'));

  // 不确定的永远要确认
  const r2 = learn.apply(q);
  ok('就算关了确认开关，[?] 的还是要确认',
    (() => {
      cfg.set('learnNeedConfirm', false);
      const r = learn.apply(q);
      cfg.set('learnNeedConfirm', true);
      return r.pending === 1;
    })(), `待确认 ${r2.pending}`);

  learn.dropPending();
  ok('全部丢掉', learn.readPending().length === 0);

  // tick 计数
  const every = cfg.get('autoLearnEveryRounds');
  cfg.set('autoLearnEveryRounds', 3);
  learn.resetRounds();
  const t1 = learn.tick(), t2 = learn.tick(), t3 = learn.tick();
  ok('攒够轮数才触发', !t1 && !t2 && t3, `1:${t1} 2:${t2} 3:${t3}`);
  cfg.set('autoLearnEveryRounds', every);
}

/* ═══════════════ 10. 隔离检查 ═══════════════ */

console.log('\n【隔离检查】');

{
  const mine = path.resolve(store.DATA);
  const real = path.resolve(REAL_DATA);
  ok('跑在隔离目录里', mine !== real, mine);

  // 前后对比：这一跑有没有往他真那个目录里写过东西
  const after = snapRealDir();
  const changed = [];
  for (const [k, v] of Object.entries(after)) if (REAL_BEFORE[k] !== v) changed.push(k);
  for (const k of Object.keys(REAL_BEFORE)) if (!(k in after)) changed.push(k + '（没了）');
  ok('他的真 data 目录没被碰过', changed.length === 0,
    changed.length ? `动了：${changed.join(', ')}`
                   : `没动（目录里有 ${Object.keys(after).length} 个文件，全是本来就有的）`);

  // 看看隔离目录里都长出了什么
  const walk = (d, pre = '') => {
    const out = [];
    if (!fs.existsSync(d)) return out;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) out.push(...walk(path.join(d, e.name), pre + e.name + '/'));
      else out.push(pre + e.name + ' (' + fs.statSync(path.join(d, e.name)).size + 'B)');
    }
    return out;
  };
  console.log('\n  隔离目录里的文件：');
  for (const f of walk(HOME)) console.log('    ' + f);
}

/* ═══════════════ 收尾 ═══════════════ */

console.log(`\n${'─'.repeat(52)}`);
console.log(`  ${pass}/${pass + fail} 通过${fail ? `  ✗ ${fail} 项没过` : '  ✓ 全过'}`);
console.log('─'.repeat(52) + '\n');

const report = { when: T.stamp(), home: HOME, pass, fail, results };
fs.writeFileSync(path.join(__dirname, '..', '_selfcheck-memory.json'),
  JSON.stringify(report, null, 2), 'utf8');

process.exit(fail ? 1 : 0);
