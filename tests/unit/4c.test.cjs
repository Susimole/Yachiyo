/**
 * 自检 · 备份（C-1）
 *
 * ⚠️ **必须跑在隔离目录里**（`YACHIYO_HOME`）—— 不然它会往他真那份
 *    数据目录里抄文件、建备份文件夹。
 *
 * 最要紧的一条：**zip 真能解开**。那个 zip 是手写的二进制格式
 * （不引第三方库），"我看了一遍觉得对"和"能解开"完全是两回事 ——
 * 所以这里直接拉 PowerShell 的 `Expand-Archive` 解一遍，
 * 再把里面的文件跟原件逐字节比。
 *
 * 跑法：node scripts/selfcheck-4c.cjs
 */
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const STARTED = Date.now();
const ROOT = path.resolve(__dirname, '..', '..');
const HOME = path.join(ROOT, '_selfcheck-home-4c');

fs.rmSync(HOME, { recursive: true, force: true });
fs.mkdirSync(HOME, { recursive: true });
process.env.YACHIYO_HOME = HOME;

const cfg = require(path.join(ROOT, 'src/core/config.cjs'));
cfg.load();

const T = require(path.join(ROOT, 'src/core/text.cjs'));
const store = require(path.join(ROOT, 'src/core/store.cjs'));
const backup = require(path.join(ROOT, 'src/core/backup.cjs'));

const out = [];
const chk = (name, ok, detail) => {
  out.push({ name, ok: !!ok, detail: detail == null ? '' : String(detail) });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail != null ? '  —— ' + detail : ''}`);
};

/* ── 造一份"她家"出来 ─────────────────────────────────── */

const DATA = cfg.DATA;
store.ensure();
fs.mkdirSync(path.join(DATA, '聊天记录', '2026-10'), { recursive: true });
fs.mkdirSync(path.join(DATA, '聊天记录', '2026-09'), { recursive: true });
fs.mkdirSync(path.join(cfg.DIR, 'persona'), { recursive: true });
fs.mkdirSync(path.join(cfg.DIR, 'logs'), { recursive: true });

/** 造一个文件，并把它 mtime 设成指定时刻 */
function put(file, text, when) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  if (when) fs.utimesSync(file, when, when);
}

const T10 = new Date(2026, 9, 13, 14, 25, 30);      // 2026-10-13 14:25:30
const T09 = new Date(2026, 8, 26, 12, 54, 57);      // 2026-09-26（上月）

/*
 * ⚠️ `chat.jsonl` 是**滚动文件**（一直在往下追加），所以它的 mtime
 *    永远是"最后说过话那一刻"。造数据时给它 9 月的 mtime ——
 *    它就**该**进 26-09 那档，这是"按文件自己的时间分档"这条规则在起作用，
 *    不是 bug。（第一版我把断言写成了"它该在 26-10"，红得没道理。）
 */
/*
 * ⚠️ 长度**别跟别的那份九月记录写成一样** —— 一样长的话会被
 *    "大小相同就不重复抄"那条挡掉，看着像"没备份上"。
 *    （第一版就是这么撞的：两份都是 37 字节。）
 */
put(path.join(DATA, 'chat.jsonl'),
  '{"role":"user","content":"今天回来挺晚的，路上还下了点雨"}\n' +
  '{"role":"assistant","content":"诶，那你衣服湿了没啊"}\n', T09);
put(path.join(DATA, '聊天记录', '2026-10', '2026-10-13_142530.jsonl'), '十月的那次\n', T10);
put(path.join(DATA, '聊天记录', '2026-09', '2026-09-26_125457.jsonl'), '九月的那次\n', T09);
put(path.join(DATA, 'habits.md'), '- 他会熬夜\n', T09);
put(path.join(DATA, 'memes.md'), '- 章鱼\n', T09);
put(path.join(DATA, 'profile.md'), '# 他\n- 上晚班\n', T10);
put(path.join(DATA, 'pending.md'), '- 待确认的一条\n', T09);
/* ★ 2026-10-21 加（外部审查 YCH-011）：这几份原来**一份都没进周备份** */
put(path.join(DATA, '她的心事.json'), '{"情绪":{"现在":"高兴"},"心事":[]}\n', T10);
put(path.join(DATA, '她认的错.json'), '{"items":[]}\n', T10);
put(path.join(DATA, '她的小日子.json'), '{"items":[]}\n', T10);
put(path.join(DATA, '她的目标.json'), '{"items":[]}\n', T10);
put(path.join(DATA, 'usage.json'), '{"todayCalls":3}\n', T10);
put(path.join(DATA, 'config.json'), '{"apiKey":"sk-SHOULD-NOT-BE-IN-ZIP"}\n', T10);
put(path.join(cfg.DIR, 'persona', '人格配置.md'), '你是辉夜\n', T10);
put(path.join(cfg.DIR, 'state-placeholder.txt'), 'x\n');
put(path.join(store.STATE, 'review.json'), '{"lastDay":"2026-10-13"}\n', T10);
put(path.join(store.STATE, 'mood.json'), '{"情绪":{"现在":"高兴"}}\n', T10);
put(path.join(store.ARCHIVE, 'profile-20260927.md'), '旧画像\n', T09);

// 日志：**一个月一个文件**，里面跨了两天
put(path.join(cfg.DIR, 'logs', '2026-10.log'),
  '[2026-10-12 22:50:41] [自言语] 第一天的第一行\n' +
  '[2026-10-12 22:51:00] [回顾] 第一天的第二行\n' +
  '[2026-10-13 09:01:02] [备份] 第二天的第一行\n', T10);
put(path.join(cfg.DIR, 'logs', '2026-09.log'),
  '[2026-09-26 12:54:57] [自言语] 九月那天\n', T09);

/* ═══════════════════════════════════════════════════════ */

(async () => {
  console.log('\n【文件夹名规则】');
  chk('★ 2026-10-13 → 「26-10」（他给的例子）',
    backup.monthFolder(new Date(2026, 9, 13)) === '26-10', backup.monthFolder(new Date(2026, 9, 13)));
  chk('  2027-01-05 → 「27-01」（月份补零）',
    backup.monthFolder(new Date(2027, 0, 5)) === '27-01', backup.monthFolder(new Date(2027, 0, 5)));
  chk('  2026-09-26 → 「26-09」',
    backup.monthFolder(new Date(2026, 8, 26)) === '26-09', backup.monthFolder(new Date(2026, 8, 26)));

  chk('★ 2026-10-19（周一）→ 那一周就是 2026-10-19',
    backup.mondayOf(new Date(2026, 9, 19)) === '2026-10-19', backup.mondayOf(new Date(2026, 9, 19)));
  chk('  2026-10-22（周四）→ 退回 2026-10-19',
    backup.mondayOf(new Date(2026, 9, 22)) === '2026-10-19', backup.mondayOf(new Date(2026, 9, 22)));
  chk('  2026-10-25（周日）→ 还是 2026-10-19（周日算上一周的尾巴）',
    backup.mondayOf(new Date(2026, 9, 25)) === '2026-10-19', backup.mondayOf(new Date(2026, 9, 25)));
  chk('  2026-10-26（下周一）→ 2026-10-26',
    backup.mondayOf(new Date(2026, 9, 26)) === '2026-10-26', backup.mondayOf(new Date(2026, 9, 26)));
  chk('  跨月：2026-11-01（周日）→ 2026-10-26',
    backup.mondayOf(new Date(2026, 10, 1)) === '2026-10-26', backup.mondayOf(new Date(2026, 10, 1)));

  /* ── 聊天记录 ── */
  console.log('\n【① 聊天记录 · 按年月分档】');
  const nChat = backup.backupChats(new Date(2026, 9, 13, 15, 0, 0));
  const chatRoot = path.join(backup.root(), '聊天记录');
  chk('  抄进去了', nChat >= 3, `${nChat} 份`);
  chk('★ 十月的聊天记录进「26-10」',
    fs.existsSync(path.join(chatRoot, '26-10', '2026-10', '2026-10-13_142530.jsonl')),
    fs.existsSync(path.join(chatRoot, '26-10')) ? fs.readdirSync(path.join(chatRoot, '26-10')).join(' / ') : '（26-10 没建出来）');
  chk('★ 九月的进「26-09」（**按文件自己的时间**分档，不是按"今天"）',
    fs.existsSync(path.join(chatRoot, '26-09', '2026-09', '2026-09-26_125457.jsonl')),
    fs.existsSync(path.join(chatRoot, '26-09')) ? fs.readdirSync(path.join(chatRoot, '26-09')).join(' / ') : '（26-09 没建出来）');
  /*
   * ★★ 主聊天记录 `data\chat.jsonl` 是**单独一条路**（它在 data 根目录，
   *    不在 `聊天记录\` 里面）—— 第一版漏了它，日常对话一份都没备上。
   */
  chk('★★ 主聊天记录 chat.jsonl 也备上了（它在 data 根目录，容易被漏掉）',
    fs.existsSync(path.join(chatRoot, '26-10', 'chat-2026-10-13.jsonl')),
    fs.readdirSync(path.join(chatRoot, '26-10')).join(' / '));
  chk('  按天存一份（不覆盖昨天那份）', /chat-\d{4}-\d{2}-\d{2}\.jsonl/.test(
    fs.readdirSync(path.join(chatRoot, '26-10')).join(' ')), '');
  chk('  内容一字不差',
    fs.readFileSync(path.join(chatRoot, '26-10', 'chat-2026-10-13.jsonl'), 'utf8')
      === fs.readFileSync(path.join(DATA, 'chat.jsonl'), 'utf8'), '');

  const srcStat = fs.statSync(path.join(DATA, '聊天记录', '2026-10', '2026-10-13_142530.jsonl'));
  const dstStat = fs.statSync(path.join(chatRoot, '26-10', '2026-10', '2026-10-13_142530.jsonl'));
  chk('★ 保住了原文件的修改时间（不然下次分档就认不出它属于哪个月）',
    Math.abs(dstStat.mtimeMs - srcStat.mtimeMs) < 2000,
    `源 ${new Date(srcStat.mtimeMs).toLocaleString('zh-CN')} / 备份 ${new Date(dstStat.mtimeMs).toLocaleString('zh-CN')}`);

  const nChat2 = backup.backupChats(new Date(2026, 9, 13, 16, 0, 0));
  chk('  同一天再跑一次 → 不重复抄（省 IO，也不动时间戳）', nChat2 === 0, `${nChat2} 份`);

  /* ── 日志 ── */
  console.log('\n【② 日志 · 按年月分档 + 按天拆开】');
  const nLog = backup.backupLogs(new Date(2026, 9, 13, 15, 0, 0));
  const logRoot = path.join(backup.root(), '日志');
  chk('  产出日文件', nLog >= 3, `${nLog} 个`);
  chk('★ 十月的两天**各一个文件**（不拆的话一个月档里只有一个 2026-10.log，越滚越大）',
    fs.existsSync(path.join(logRoot, '26-10', '2026-10-12.log'))
    && fs.existsSync(path.join(logRoot, '26-10', '2026-10-13.log')),
    fs.existsSync(path.join(logRoot, '26-10')) ? fs.readdirSync(path.join(logRoot, '26-10')).join(' / ') : '');
  chk('  九月的进「26-09」',
    fs.existsSync(path.join(logRoot, '26-09', '2026-09-26.log')), '');
  chk('★ 拆出来的内容**只含那一天**的行',
    (() => {
      const d12 = fs.readFileSync(path.join(logRoot, '26-10', '2026-10-12.log'), 'utf8');
      const d13 = fs.readFileSync(path.join(logRoot, '26-10', '2026-10-13.log'), 'utf8');
      return d12.includes('第一天的第一行') && d12.includes('第一天的第二行')
          && !d12.includes('第二天的第一行')
          && d13.includes('第二天的第一行') && !d13.includes('第一天的');
    })(), '');
  chk('  一天都没漏（3 行日志 → 3 行备份）',
    (() => {
      /*
       * ⚠️ 按**行数**数，别按关键词正则 ——
       *    "第二天的第一行"里同时含"第一天"，按词数会数成 4 个（第一版就这么红的）。
       */
      let lines = 0;
      for (const f of fs.readdirSync(path.join(logRoot, '26-10'))) {
        lines += fs.readFileSync(path.join(logRoot, '26-10', f), 'utf8')
          .split('\n').filter(Boolean).length;
      }
      return lines === 3;
    })(), '');
  const nLog2 = backup.backupLogs(new Date(2026, 9, 13, 16, 0, 0));
  chk('  内容没变 → 不重写（不然每天把过去每一天全重写一遍）', nLog2 === 0, `${nLog2} 个`);

  /* ── 记忆 ── */
  console.log('\n【③ 记忆 · 每周一个日期文件夹 + 一个 zip】');
  const mem = backup.backupMemory(new Date(2026, 9, 22, 10, 0, 0));   // 周四 → 该进 2026-10-19
  chk('  打包成功', mem.ok === true, mem.why || `${mem.files} 个文件`);
  const memDir = path.join(backup.root(), '记忆', '2026-10-19');
  chk('★ 落在「记忆\\2026-10-19\\」——用**那一周的周一**当文件夹名',
    fs.existsSync(memDir), fs.existsSync(path.join(backup.root(), '记忆'))
      ? fs.readdirSync(path.join(backup.root(), '记忆')).join(' / ') : '（记忆目录没建）');
  const zips = fs.existsSync(memDir) ? fs.readdirSync(memDir).filter((f) => f.endsWith('.zip')) : [];
  chk('  里面是一个 zip（不是散文件）', zips.length === 1, zips.join(' / '));
  const zipPath = zips.length ? path.join(memDir, zips[0]) : '';
  chk('★ zip 有内容（不是个空壳）',
    zipPath && fs.statSync(zipPath).size > 500, zipPath ? `${fs.statSync(zipPath).size} 字节` : '');

  // ★★ 最要紧的一条：真解开
  const exDir = path.join(HOME, '_unzip-test');
  let unzipErr = '';
  try {
    execSync(`powershell.exe -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${exDir}' -Force"`,
      { stdio: 'pipe', windowsHide: true });
  } catch (e) { unzipErr = String(e.stderr || e.message).slice(0, 200); }
  const unzipped = fs.existsSync(exDir) ? (function walk(d, b = d, o = []) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      e.isDirectory() ? walk(p, b, o) : o.push(path.relative(b, p));
    }
    return o;
  })(exDir) : [];
  chk('★★ zip 真的能解开（手写的二进制格式，不验就是"我以为对"）',
    unzipped.length > 0, unzipErr || `${unzipped.length} 个文件`);

  chk('  中文文件夹名没乱码（UTF-8 标志位设对了）',
    unzipped.some((f) => f.includes('聊天记录')), unzipped.slice(0, 3).join(' / '));
  chk('  人格带上了', unzipped.some((f) => /persona[\\/]人格配置\.md$/.test(f)), '');
  chk('  习惯 / 梗 / 画像都带上了',
    ['habits.md', 'memes.md', 'profile.md'].every((f) => unzipped.some((x) => x.endsWith(f))),
    '');
  chk('  状态带上了', unzipped.some((f) => /state[\\/]review\.json$/.test(f)), '');
  /*
   * ★ 2026-10-21 加（外部审查 YCH-011）：她自己的那几份 json 必须进包 ——
   *   漏了的话，真拿这份 zip 恢复，**情绪和心事是空的**。
   */
  chk('★★ 她的心事 / 认错 / 小日子 / 目标都进了包',
    ['她的心事.json', '她认的错.json', '她的小日子.json', '她的目标.json']
      .every((f) => unzipped.some((x) => x.endsWith(f))),
    unzipped.filter((f) => /她/.test(f)).join(' / ') || '（一份都没有）');
  chk('  用量账本也带上了（图的数据源）',
    unzipped.some((f) => /data[\\/]usage\.json$/.test(f)), '');
  chk('★ API Key **不进**备份包（zip 会被他拷出去）',
    !unzipped.some((f) => /config\.json|providers\.json/.test(f)) &&
    !unzipped.some((f) => {
      try { return /sk-SHOULD-NOT-BE-IN-ZIP/.test(fs.readFileSync(path.join(exDir, f), 'utf8')); }
      catch { return false; }
    }), '');
  chk('  归档带上了（那是人格的退路）',
    unzipped.some((f) => /archive[\\/]profile-20260927\.md$/.test(f)), '');

  chk('★★ 解出来的内容和原件**一字不差**',
    unzipped.some((f) => f.endsWith('profile.md'))
    && (() => {
      const got = fs.readFileSync(path.join(exDir, unzipped.find((f) => f.endsWith('profile.md'))), 'utf8');
      return got === fs.readFileSync(path.join(DATA, 'profile.md'), 'utf8');
    })(), '');

  /* ── 该不该备 ── */
  console.log('\n【该不该备 · 每天一次 / 每周一次】');
  backup._reset();
  const r1 = backup.tick(new Date(2026, 9, 22, 10, 0, 0));   // 周四
  chk('  第一次跑 → 三样都备了', r1.ran === true && r1.memory && r1.memory.ok === true, `日志 ${r1.logs} · 聊天 ${r1.chat}`);

  const r2 = backup.tick(new Date(2026, 9, 22, 20, 0, 0));   // 同一天稍晚
  chk('  同一天再跑 → 不重复（今天已备过）', r2.ran === false, r2.why);

  const r3 = backup.tick(new Date(2026, 9, 23, 10, 0, 0));   // 第二天
  chk('★ 第二天 → 聊天/日志**重备**，但记忆**不重打**（同一周）',
    r3.ran === true && r3.memory === null, `chat=${r3.chat} logs=${r3.logs} memory=${r3.memory}`);

  const r4 = backup.tick(new Date(2026, 9, 26, 10, 0, 0));   // 下周一
  chk('★ 到了下一周 → 记忆**重新打一份**进新的日期文件夹',
    r4.ran === true && r4.memory && r4.memory.ok === true,
    r4.memory ? r4.memory.dir.replace(HOME, '…') : '');

  cfg.set('backupDaily', false);
  const r5 = backup.tick(new Date(2026, 10, 2, 10, 0, 0));
  chk('  每日备份关着 → 整个不跑', r5.ran === false && /关着/.test(r5.why), r5.why);
  cfg.set('backupDaily', true);

  /* ── 自愈 ── */
  console.log('\n【备份自己不会把原件弄坏】');
  backup._reset();
  const before = fs.readFileSync(path.join(DATA, 'profile.md'), 'utf8');
  backup.tick(new Date(2026, 10, 2, 10, 0, 0));             // 周一
  chk('★ 备份跑完原件还在、内容没变（只抄不删）',
    fs.readFileSync(path.join(DATA, 'profile.md'), 'utf8') === before, '');

  /*
   * ★★ 真造一次**失败**，验"失败了不落周标记、下次还会重试"。
   *
   * ⚠️ 为什么非要真造：只测 `ran===true` 的话，成功和失败都是 true ——
   *    看着绿，其实验的是别的东西（第一版就这么写的）。
   *    失败会让那一周**静默漏掉**，而"静默"正是这条链最怕的。
   *
   * 造法：把 `backupDir` 指到一个**文件**上 —— 建目录必然失败。
   */
  backup._reset();
  const blocker = path.join(HOME, '_blocker');
  fs.writeFileSync(blocker, 'x', 'utf8');
  cfg.set('backupDir', blocker);
  const rf = backup.tick(new Date(2026, 10, 2, 10, 0, 0));   // 11-02 周一
  chk('  制造一次周备份失败', rf.memory && rf.memory.ok === false,
    rf.memory ? rf.memory.why.slice(0, 40) : '（memory 是 null）');
  chk('★ 失败之后**不落周标记**（不然这一周就再也不会重试）',
    backup.lastState().lastWeek !== '2026-11-02',
    'lastWeek=' + JSON.stringify(backup.lastState().lastWeek || ''));

  cfg.set('backupDir', '备份');                                // 修好
  const rr = backup.tick(new Date(2026, 10, 2, 12, 0, 0));     // 同一天再来
  chk('★ 同一天再启动一次 → 它**接着重试**，并且这次成功',
    rr.memory && rr.memory.ok === true, rr.memory ? `${rr.memory.files} 个文件` : '（没重试）');

  /*
   * ══════════════════════════════════════════════════════════════
   *  ★ 2026-10-21 加：写失败**不许假成功**（外部审查 YCH-006 / YCH-012）
   *
   *    这两条的共性：`store.writeText` / `store.writeFile` 失败时**只返回 false**，
   *    不抛异常。原来调用方把返回值丢掉、只 `log.error` 一句 —— 于是
   *      · 周备份：zip 没写进去也 `return ok:true` → `tick` 给这周盖章 → 一周不重试
   *      · 每日备份：聊天/日志没写进去，`tick` 的 try/catch 什么也抓不到 → 照样盖章
   *    也就是"备份看着备了"。这条链一假，等于**没有备份**。
   *
   *    ⚠️ 判据必须是"返回值/抛异常"这一层，不能只看日志有没有 error 行。
   * ══════════════════════════════════════════════════════════════
   */
  console.log('\n【写失败不许假成功】');

  const realWriteFile = store.writeFile;
  const realWriteText = store.writeText;

  /* ① 周备份：zip 写不进去 */
  store.writeFile = () => false;
  let memFail = null;
  try { memFail = backup.backupMemory(new Date(2026, 10, 9, 10, 0, 0)); }
  catch (e) { memFail = { ok: false, why: '抛异常：' + e.message }; }
  store.writeFile = realWriteFile;
  chk('★ 周备份 zip 写失败 → 返回 ok:false（不再假装成功）',
    memFail && memFail.ok === false, memFail && String(memFail.why).slice(0, 50));

  /* ② 每日备份：聊天记录写不进去 → 要抛，让 tick 判断成失败 */
  store.writeText = () => false;
  let threw = false;
  try { backup.backupChats(new Date(2026, 10, 9, 10, 0, 0)); } catch { threw = true; }
  store.writeText = realWriteText;
  chk('★ 聊天记录写失败 → backupChats 抛出去（tick 才判得出"今天没备成"）', threw === true);

  /* ③ 日志备份同理 */
  store.writeText = () => false;
  let threw2 = false;
  try { backup.backupLogs(new Date(2026, 10, 9, 10, 0, 0)); } catch { threw2 = true; }
  store.writeText = realWriteText;
  chk('★ 日志备份写失败 → backupLogs 也抛', threw2 === true);

  /* ④ 真跑一次 tick：写失败的日子**不许盖章** */
  backup._reset();
  store.writeText = () => false;
  const rBad = backup.tick(new Date(2026, 10, 10, 10, 0, 0));   // 周二
  store.writeText = realWriteText;
  chk('★ 写失败那天的 tick 报告 ran=true 但没盖章',
    rBad.ran === true && backup.lastState().lastDay !== '2026-11-10',
    'lastDay=' + JSON.stringify(backup.lastState().lastDay || '') + ' · why=' + String(rBad.why).slice(0, 30));
  const rRetry = backup.tick(new Date(2026, 10, 10, 14, 0, 0));  // 同一天修好了再来
  chk('★ 同一天再来一次 → 它真的重试了（不是"今天已经备过了"）',
    rRetry.ran === true, String(rRetry.why).slice(0, 40));

  console.log('\n【隔离检查】');
  const REAL = 'C:\\Users\\Susim\\AppData\\Roaming\\Yachiyo';
  chk('跑在隔离目录里', HOME.includes('_selfcheck-home-4c'), HOME);
  chk('  他真那份的备份目录没被这次自检碰过',
    !fs.existsSync(path.join(REAL, '备份'))
    || fs.statSync(path.join(REAL, '备份')).mtimeMs < STARTED,
    path.join(REAL, '备份'));

  console.log('\n' + '─'.repeat(52));
  const pass = out.filter((x) => x.ok).length;
  console.log(`  ${pass}/${out.length} 通过  ${pass === out.length ? '✓ 全过' : '✗ 有失败'}`);
  console.log('─'.repeat(52) + '\n');
  const bad = out.filter((x) => !x.ok);
  if (bad.length) { console.log('失败明细：'); for (const b of bad) console.log(`  - ${b.name}: ${b.detail}`); }
  process.exit(pass === out.length ? 0 : 1);
})().catch((e) => { console.error('\n自检自己炸了：', e.stack || e.message); process.exit(1); });
