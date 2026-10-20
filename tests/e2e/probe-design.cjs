/*
 * ⚠️ 本文件 2026-10-18 由 `桌面\八千代AI桌宠工作留痕\` / `_dsh020\verify\` 搬进仓库。
 *    搬的时候只改了一件事：把写死的 `D:/AI_work/Git` 换成 `path.resolve(__dirname,'..','..')`。
 *    逻辑一行没动 —— 这些探针每天都在用，改逻辑就是给自己找麻烦。
 *
 *    跑之前要先有一个**带 CDP 的实例**（`YACHIYO_CDP=9222 npm start`），
 *    否则会报"没连上主窗口"。见 tests/e2e/README.md。
 */
/**
 * 探针：设置面板的「界面调试台」端到端
 *
 * 验的是**接线通不通**，自检够不着的那一段：
 *   1. 高级页最下面那颗「界面调试台」按钮在不在、点不点得动
 *   2. 点下去之后面板有没有进调试态（.card.d-on）
 *   3. 底部参数栏、区域轮廓框、拖拽把手、可编辑文字 —— 四样齐不齐
 *   4. 退出来是不是**干净还原**（class 去掉、DOM 清空、CSS 变量清空）
 *
 * ⚠️ 第 4 条最关键：他平时用的面板不能因为调试台留了尾巴而变形。
 *
 * 跑法：node scripts/probe-design.cjs   （开发版，不需要先打包）
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..', '..');   // ⚠️ 2026-10-21 修：原来少一层，指到了 tests/ —— 搬进仓库那天起就起不来
const HOME = path.join(os.tmpdir(), 'yachiyo-design-probe');
const PORT = 9363;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killAll() {
  try {
    execSync('powershell.exe -NoProfile -Command "Get-Process electron,Yachiyo -ErrorAction SilentlyContinue | Stop-Process -Force"',
      { stdio: 'ignore', windowsHide: true });
  } catch { /* 没进程正好 */ }
}

const list = async () => (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();

/**
 * 连一个 CDP target。
 *
 * ⚠️ 这里**带重试**（2026-10-13 加的）：面板 / 聊天窗是懒建的，
 *    `ov.open` 之后 CDP 列表里立刻能看到它，但那一刻**连不上** ——
 *    `new WebSocket` 直接抛 `Invalid URL`，而**那个 URL 明明是好的**。
 *    固定 sleep 一下就去连，就会吃到这个（我在这儿连炸三次）。
 *    ⇒ 连不上就退后 800ms 再试，最多 6 次。
 */
async function connect(t, tries = 6) {
  const target = (t && typeof t === 'object') ? t.webSocketDebuggerUrl : t;
  if (typeof target !== 'string' || !/^ws/.test(target)) {
    throw new Error('connect() 拿到的东西不对：' + JSON.stringify(t));
  }
  let lastErr = null;
  let ws = null;
  for (let i = 0; i < tries; i++) {
    try {
      ws = new WebSocket(target);
      await new Promise((res, rej) => {
        ws.addEventListener('open', res, { once: true });
        ws.addEventListener('error', () => rej(new Error('ws error')), { once: true });
        setTimeout(() => rej(new Error('ws timeout')), 4000);
      });
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      ws = null;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  if (!ws) throw new Error('连不上 CDP（试了 ' + tries + ' 次）：' + (lastErr && lastErr.message) + ' ← ' + target);
  const pending = new Map();
  let seq = 0;
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const ev = async (expression) => {
    const id = ++seq;
    const p = new Promise((r) => pending.set(id, r));
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    const r = await p;
    if (r.result && r.result.exceptionDetails) {
      return { __err: String((r.result.exceptionDetails.exception || {}).description).slice(0, 300) };
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  return { ws, ev };
}

const pass = [];
const fail = [];
const chk = (name, ok, extra) => {
  (ok ? pass : fail).push(name);
  console.log(`  ${ok ? '✓' : '✗'} ${name}${extra !== undefined ? '   → ' + JSON.stringify(extra) : ''}`);
};

async function main() {
  killAll();
  await sleep(600);

  const env = { ...process.env };
  /* ⚠️ 开跑前先把上次的 design.json 清掉 —— 不然改动还在可能是上一轮的残留，
     测试就成了自欺欺人。（YACHIYO_HOME 是隔离的，只影响探针这次跑的目录。） */
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ATTACH_CONSOLE;
  env.YACHIYO_HOME = HOME;
  /*
   * ★ 跑法有两种：
   *    node scripts/probe-design.cjs            —— 正常跑，**先清盘**（干净起点）
   *    node scripts/probe-design.cjs --keep     —— 保留上次的 design.json，
   *                                                用来看"重启之后改动还在不在"
   * 他自己撞到的那个 bug 就是"改动会丢"，所以"重启还在"必须单独验一次。
   */
  const KEEP = process.argv.includes('--keep');
  if (!KEEP) { try { fs.rmSync(path.join(HOME, 'design.json'), { force: true }); } catch { /* 本来就没有 */ } }

  const electron = require('electron');
  const child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`],
    { cwd: ROOT, env, windowsHide: true });

  let mainT = null;
  for (let i = 0; i < 30 && !mainT; i++) {
    await sleep(900);
    try {
      const l = await list();
      mainT = l.find((t) => t.type === 'page' && t.url.includes('index.html'));
    } catch { /* 还没起来 */ }
  }
  if (!mainT) { console.log('✗ 主窗口起不来'); try { child.kill(); } catch { } process.exit(1); }

  const MAIN = await connect(mainT);
  await sleep(1500);

  /*
   * ★ `--keep` 模式：只看一件事 —— **上次改的东西，重启之后回来了没有**。
   *   这是"即时生效"的最终证明：改完落盘 → 关掉 → 再开 → 还在。
   */
  if (KEEP) {
    console.log('');
    console.log('=== ★ 重启持久化检查（--keep）===');
    const back = await MAIN.ev(`(async () => {
      const j = await window.yachiyo.ov.designLoad();
      return j ? { keys: Object.keys(j), side: (j.结构||{})['side-w'], textN: Object.keys(j.文字||{}).length } : null;
    })()`);
    chk('盘上的覆盖还在', !!back, back);
    chk('参数值还在（side-w 有数）', !!(back && back.side > 0), back && back.side);

    /*
     * ★★ 光"盘上有"不算数 —— 得看**面板真的把它用上了没有**。
     *    这才是他关心的：「重启之后我看到的是不是我调过的样子」。
     */
    await MAIN.ev(`window.yachiyo.ov.open('panel', {})`);
    /*
     * ⚠️ 面板窗口是**懒建**的：`ov.open` 之后它才创建，而 CDP 的 target 列表
     *    还要再等一拍才有 `webSocketDebuggerUrl`。
     *    固定 sleep 一下就去连，会拿到空 URL → `new WebSocket('')` 直接抛
     *    "Invalid URL"（我第一次就这么炸的）。⇒ 轮询等它真出现。
     */
    let pt = null;
    for (let i = 0; i < 15 && !(pt && pt.webSocketDebuggerUrl); i++) {
      await sleep(700);
      pt = (await list()).find((t) => t.type === 'page' && t.url.includes('panel.html'));
    }
    /*
     * ⚠️ 空**字符串**也能过 `!pt.ws` 这种判断 —— 得按类型查。
     *    面板窗口刚建出来时 CDP 可能给一个空 URL，直接 new WebSocket('') 就炸
     *    "Invalid URL"（我在这儿连炸两次）。
     */
    const wsOk = pt && typeof pt.webSocketDebuggerUrl === 'string' && pt.webSocketDebuggerUrl.startsWith('ws');
    if (!wsOk) { chk('重启后能打开面板', false, pt ? { url: pt.url, ws: String(pt.webSocketDebuggerUrl) } : '没找到面板 target'); }
    else {
      const Pp = await connect(pt.webSocketDebuggerUrl);
      await sleep(1800);
      const applied = await Pp.ev(`(() => {
        const card = document.querySelector('.card');
        return {
          sideW: getComputedStyle(document.querySelector('.p-side')).width,
          vars: card ? (card.getAttribute('style') || '') : '',
        };
      })()`);
      chk('★ 重启后左栏真的还是调过的宽度', applied && applied.sideW === '190px', applied && applied.sideW);
      chk('★ 重启后变量已套上（没点调试台）', !!(applied && /--d-side-w/.test(applied.vars)), applied && applied.vars);
    }
    try { child.kill(); } catch { }
    await sleep(700);
    killAll();
    console.log('');
    console.log(`=== 持久化：${pass.length} 通过 / ${fail.length} 失败 ===`);
    if (fail.length) for (const f of fail) console.log('  ✗ ' + f);
    process.exit(fail.length ? 1 : 0);
  }

  console.log('');
  console.log('=== ① 打开设置面板 ===');
  await MAIN.ev(`window.yachiyo.ov.open('panel', {})`);
  await sleep(2500);
  let l = await list();
  const panelT = l.find((t) => t.type === 'page' && t.url.includes('panel.html'));
  if (!panelT) { console.log('✗ 设置面板没起来'); try { child.kill(); } catch { } process.exit(1); }
  const P = await connect(panelT);
  await sleep(1200);

  console.log('');
  console.log('=== ② 切到「高级」页，找那颗按钮 ===');
  const navOk = await P.ev(`(() => {
    const n = [...document.querySelectorAll('#navs .nav')].find(x => x.dataset.k === 'adv');
    if (!n) return { err: '找不到高级页导航' };
    n.click();
    return { clicked: true };
  })()`);
  chk('高级页导航点得动', !!(navOk && navOk.clicked), navOk && navOk.err);
  await sleep(900);

  const btn = await P.ev(`(() => {
    const b = [...document.querySelectorAll('#pMain .btn')].find(x => x.textContent.trim() === '界面调试台');
    if (!b) return { err: '找不到按钮', all: [...document.querySelectorAll('#pMain .btn')].map(x => x.textContent.trim()) };
    return { found: true, cls: b.className, visible: b.getBoundingClientRect().width > 0 };
  })()`);
  chk('「界面调试台」按钮存在', !!(btn && btn.found), btn && (btn.err || btn.cls));
  chk('按钮是「不起眼」款（.quiet）', !!(btn && /quiet/.test(btn.cls || '')), btn && btn.cls);

  console.log('');
  console.log('=== ③ 点开调试台 ===');
  await P.ev(`(() => { const b=[...document.querySelectorAll('#pMain .btn')].find(x=>x.textContent.trim()==='界面调试台'); if(b) b.click(); })()`);
  await sleep(1500);

  const dom = await P.ev(`(() => {
    const card = document.querySelector('.card');
    return {
      onClass: card.classList.contains('d-on'),
      bar: !!document.querySelector('.d-bar'),
      inputs: document.querySelectorAll('.d-bar input[data-vk]').length,
      btns: [...document.querySelectorAll('.d-bar .d-btn')].map(b => b.textContent.trim()),
      cols: document.querySelectorAll('.d-bar-l .d-grp').length,
      marks: document.querySelectorAll('.d-mark').length,
      handles: document.querySelectorAll('.d-handle').length,
      editables: document.querySelectorAll('.d-editable').length,
      // ★ 行文字也挂上可编辑了吗（47 行的标签 / 提示）
      labelEditable: document.querySelectorAll('.d-editable.c-label').length,
      hintEditable: document.querySelectorAll('.d-editable.c-hint').length,
      gtitleEditable: document.querySelectorAll('.d-editable.c-gtitle').length,
      // ★ 跨区搬分组的两套控件
      grabs: document.querySelectorAll('.g-title.d-grab').length,
      sels: document.querySelectorAll('.d-gsel').length,
      varSet: card.style.getPropertyValue('--d-main-pb') || getComputedStyle(card).getPropertyValue('--d-main-pb').trim(),
    };
  })()`);
  chk('面板进了调试态 .card.d-on', !!dom.onClass, dom.onClass);
  chk('底部参数栏建出来了', !!dom.bar);
  chk('参数输入框数量对（22 条）', dom.inputs === 22, dom.inputs);
  chk('参数按类型分栏（4 栏）', dom.cols === 4, dom.cols);
  chk('参数栏三颗按钮', dom.btns.length === 3, dom.btns);
  chk('区域轮廓框画出来了', dom.marks > 0, dom.marks);
  chk('拖拽把手在（顶栏 + 左栏）', dom.handles === 2, dom.handles);
  chk('可编辑文字挂上了', dom.editables > 0, dom.editables);
  chk('47 行的标签都可编辑', dom.labelEditable > 5, dom.labelEditable);
  chk('行提示小字也可编辑', dom.hintEditable > 0, dom.hintEditable);
  chk('分组标题可编辑', dom.gtitleEditable > 0, dom.gtitleEditable);
  chk('每个分组都有拖拽把手', dom.grabs > 0, dom.grabs);
  chk('每个分组都有下拉兜底', dom.sels > 0, dom.sels);

  console.log('');
  console.log('=== ③a ★ 切页之后功能还在吗（他 2026-10-13 撞到的那个坑）===');
  /*
   * 他报的原话：「点了一下其他地方，又不能编辑文本和拖动分组了」。
   * 根因：`showPage` 把 `#pMain` 整片重建，挂在旧 DOM 上的
   *      可编辑文字 / 拖拽把手 / 下拉全没了 —— 而切页是**必经之路**。
   * 下面这段专门走一遍"切页 → 再量一次"，把这个回归锁死。
   */
  await P.ev(`(() => { const n = [...document.querySelectorAll('#navs .nav')].find(x => x.dataset.k === 'habit'); if (n) n.click(); })()`);
  await sleep(1300);
  const afterNav = await P.ev(`(() => ({
    labels: document.querySelectorAll('.d-editable.c-label').length,
    hints: document.querySelectorAll('.d-editable.c-hint').length,
    gtitle: document.querySelectorAll('.d-editable.c-gtitle').length,
    grabs: document.querySelectorAll('.g-title.d-grab').length,
    sels: document.querySelectorAll('.d-gsel').length,
    marks: document.querySelectorAll('.d-mark').length,
    bar: !!document.querySelector('.d-bar'),
  }))()`);
  chk('切页后行标签仍可编辑', afterNav.labels > 3, afterNav.labels);
  chk('切页后分组标题仍可编辑', afterNav.gtitle > 0, afterNav.gtitle);
  chk('切页后拖拽把手还在', afterNav.grabs > 0, afterNav.grabs);
  chk('切页后下拉兜底还在', afterNav.sels > 0, afterNav.sels);
  chk('切页后区域轮廓还在', afterNav.marks > 0, afterNav.marks);
  chk('切页后参数栏还在', afterNav.bar === true);

  // 再连切两页，确认不是"只对第一次有效"
  await P.ev(`(() => { const n = [...document.querySelectorAll('#navs .nav')].find(x => x.dataset.k === 'weather'); if (n) n.click(); })()`);
  await sleep(900);
  await P.ev(`(() => { const n = [...document.querySelectorAll('#navs .nav')].find(x => x.dataset.k === 'adv'); if (n) n.click(); })()`);
  await sleep(1000);
  const afterTwice = await P.ev(`(() => ({
    labels: document.querySelectorAll('.d-editable.c-label').length,
    grabs: document.querySelectorAll('.g-title.d-grab').length,
    sels: document.querySelectorAll('.d-gsel').length,
  }))()`);
  const twiceOk = !!(afterTwice && !afterTwice.__err
    && afterTwice.labels > 3 && afterTwice.grabs > 0 && afterTwice.sels > 0);
  chk('连切两页后依然在', twiceOk, afterTwice);

  console.log('');
  console.log('=== ③b 跨区搬分组 ===');
  const moved = await P.ev(`(async () => {
    // 先看清楚每个下拉对应哪个组（免得按第几个瞎猜）
    const sels = [...document.querySelectorAll('.d-gsel')];
    const info = sels.map((s) => ({
      grp: (s.closest('.g-title') || {}).textContent || '',
      opts: [...s.options].map(o => o.value),
    }));
    // 挑「说话」那个
    const sel = sels.find(s => /说话/.test((s.closest('.g-title')||{}).textContent||''));
    if (!sel) return { err: '没找到「说话」组的下拉', info };
    sel.value = 'habit';
    const fired = sel.dispatchEvent(new Event('change', { bubbles: true }));
    const m = await import('./ui/design.js');
    const st = await import('./ui/settings.js');
    await new Promise(r => setTimeout(r, 300));
    const ov = st.getGroupOverride();
    return {
      moved: true, fired,
      after: m.snapshotNow()['分组移动'],
      ovKeys: [...ov.keys()],
      habitTitles: (ov.get('habit') || []).map(g => g.title),
      deps: m.depsOk(),
      toast: (document.querySelector(".d-toast")||{}).textContent || null,
      advTitles: (ov.get('adv') || []).map(g => g.title),
    };
  })()`);
  chk('下拉能选目标页', !!(moved && moved.moved), moved);
  await sleep(1200);

  // 切到「习惯」页看它到没到
  const landed = await P.ev(`(() => {
    const n = [...document.querySelectorAll('#navs .nav')].find(x => x.dataset.k === 'habit');
    if (n) n.click();
    return true;
  })()`);
  await sleep(1200);
  const onHabit = await P.ev(`(() => {
    document.querySelectorAll('.d-editable').forEach(e => { e.contentEditable = 'false'; });
    return [...document.querySelectorAll('#pMain .group > .g-title')].map(t => t.textContent.replace(/^⠿/,'').trim());
  })()`);
  chk('搬过去的组出现在「习惯」页', Array.isArray(onHabit) && onHabit.some(t => /说话/.test(t)), onHabit && onHabit.slice(0, 4));
  chk('（附）下拉跟着显示当前页', landed === true);

  console.log('');
  console.log('=== ③c 「全部还原」能把分组搬回去 ===');
  await P.ev(`(() => { const b=[...document.querySelectorAll('.d-bar .d-btn')].find(x=>/全部还原/.test(x.textContent)); if(b) b.click(); })()`);
  await sleep(1200);
  await P.ev(`(() => { const n=[...document.querySelectorAll('#navs .nav')].find(x=>x.dataset.k==='habit'); if(n) n.click(); })()`);
  await sleep(1000);
  const afterReset = await P.ev(`(() => {
    document.querySelectorAll('.d-editable').forEach(e => { e.contentEditable = 'false'; });
    const t = [...document.querySelectorAll('#pMain .group > .g-title')].map(x => x.textContent.replace(/^⠿/,'').trim());
    return { titles: t, hasShuo: t.some(x => /说话/.test(x)) };
  })()`);
  chk('还原后「说话」组不在「习惯」页了', afterReset && afterReset.hasShuo === false, afterReset && afterReset.titles);

  console.log('');
  console.log('=== ③d ★ 即时生效 / 改动不丢（他 2026-10-13 要的）===');
  /*
   * 他报的原话：「改成我做修改即时生效吧，每次切换分组后都会让之前的改动失效」。
   *
   * 根因：`showPage` 重画 `#pMain` 时新 DOM 是从 PAGES 重新生成的，
   *      你 contenteditable 敲进去的字**没有任何地方存着**，重建一次就没了。
   *
   * 这段验四件事：
   *   ① 改了文字 → 当场落盘（design.json 里有）
   *   ② 切页再回来 → 改过的字**还在**（这条就是"不失效"）
   *   ③ 改了参数 → 也在盘里
   *   ④ 「全部还原」能把盘清掉
   */
  const edit1 = await P.ev(`(() => {
    document.querySelectorAll('.d-editable').forEach(e => { e.contentEditable = 'false'; });
    const n = [...document.querySelectorAll('#navs .nav')].find(x => x.dataset.k === 'adv');
    if (n) n.click();
    return true;
  })()`);
  await sleep(1200);

  const TAG = '【这行改过了】';
  const setIt = await P.ev(`(() => {
    const el = document.querySelector('#pMain .d-editable.c-label');
    if (!el) return { err: '没有可编辑的行标签' };
    const old = el.textContent;
    el.textContent = ${JSON.stringify(TAG)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return { old, nw: el.textContent, key: el.dataset.dscope + '/' + el.dataset.dbase };
  })()`);
  chk('能改行标签并触发保存', !!(setIt && !setIt.err), setIt && (setIt.err || setIt.key));
  await sleep(900);   // 等防抖落盘（400ms）

  /*
   * ⚠️ 直接问主进程要盘上的内容，**别信界面上的提示** ——
   *    「✓ 已生效」那种话自己说给自己听不算数。
   * ⚠️ 必须包成 async IIFE：`Runtime.evaluate` 的 awaitPromise 只等返回值，
   *    顶层裸 `await` 会直接抛 SyntaxError（踩过）。
   */
  const put = await MAIN.ev(`(async () => {
    const api = window.yachiyo && window.yachiyo.ov;
    if (!api || !api.designLoad) return -1;
    const j = await api.designLoad();
    return j ? JSON.stringify(j).length : 0;
  })()`);
  chk('改动已落到 design.json', typeof put === 'number' && put > 10, put);
  // 诊断：文件在不在、页面那边调 designPut 成功没
  const diagWhere = await MAIN.ev(`window.yachiyo.ov.designWhere()`);
  const diagExists = diagWhere ? fs.existsSync(diagWhere) : false;
  chk('（诊断）文件真的在盘上', diagExists, diagWhere);
  const putTry = await P.ev(`(async () => {
    try { const r = await window.yachiyo.ov.designPut({结构:{"probe":1},文字:{},分组移动:[]}); return r; }
    catch (e) { return { err: e.message }; }
  })()`);
  console.log('  （诊断）从**面板**直接 designPut：' + JSON.stringify(putTry));

  // ★★ 切页再回来 —— 这是"改动失效"的那一步
  await P.ev(`(() => { const n=[...document.querySelectorAll('#navs .nav')].find(x=>x.dataset.k==='habit'); if(n) n.click(); })()`);
  await sleep(1000);
  await P.ev(`(() => { const n=[...document.querySelectorAll('#navs .nav')].find(x=>x.dataset.k==='adv'); if(n) n.click(); })()`);
  await sleep(1200);
  const afterRound = await P.ev(`(() => {
    const els = [...document.querySelectorAll('#pMain .d-editable.c-label')];
    const hit = els.find(e => e.textContent.includes('这行改过了'));
    return { found: !!hit, sample: els.slice(0,3).map(e => e.textContent) };
  })()`);
  chk('★ 切页回来后改过的字还在', !!(afterRound && afterRound.found), afterRound);

  // 参数改动也要落盘
  const paramOk = await P.ev(`(() => {
    const inp = [...document.querySelectorAll('.d-bar input[data-vk]')].find(i => i.dataset.vk === '--d-side-w');
    if (!inp) return { err: '没有左栏宽输入框' };
    inp.value = '177';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return { set: true };
  })()`);
  await sleep(900);
  const paramDisk = await MAIN.ev(`(async () => {
    const j = await window.yachiyo.ov.designLoad();
    return (j && j.结构 && j.结构['side-w']) || null;
  })()`);
  chk('参数改动也落盘了（side-w=177）', paramDisk === 177, paramDisk);

  console.log('');
  console.log('=== ④ 改一个值，看有没有真的作用到样式 ===');
  const sideBefore = await P.ev(`getComputedStyle(document.querySelector('.p-side')).width`);
  const sideAfter = await P.ev(`(() => {
    const inp = [...document.querySelectorAll('.d-bar input[data-vk]')].find(i => i.dataset.vk === '--d-side-w');
    if (!inp) return { err: '找不到左栏宽度输入框' };
    inp.value = '190';
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    return getComputedStyle(document.querySelector('.p-side')).width;
  })()`);
  chk('改「左栏宽度」立刻生效', sideAfter === '190px', { 改前: sideBefore, 改后: sideAfter });

  console.log('');
  console.log('=== ⑤ 导出 JSON —— 验数据结构，不只验按钮 ===');
  /*
   * ⚠️ 导出现在是"**只导他改过的**"（从 `state` 出，不是扫当前页 DOM）——
   *    所以**得先改一处文字**，导出里才有东西。
   *    这也正是他 2026-10-13 报的那个 bug 的修法：以前只扫当前页，
   *    他改了 6 个页面，导出出来只有 AI 那一页。
   */
  await P.ev(`(() => {
    const el = document.querySelector('#pMain .d-editable.c-label');
    if (el) {
      el.textContent = '【导出用·改过的一行】';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
  })()`);
  await sleep(900);   // 等防抖落盘
  const json = await P.ev(`(async () => {
    const m = await import('./ui/design.js');
    return m.snapshotNow();
  })()`);
  chk('快照有「结构」段', !!(json && json.结构), json && Object.keys(json));
  chk('结构段是 22 条', !!(json && json.结构 && Object.keys(json.结构).length === 22),
    json && json.结构 && Object.keys(json.结构).length);
  chk('左栏宽度记成了刚改的 190', !!(json && json.结构 && json.结构['side-w'] === 190),
    json && json.结构 && json.结构['side-w']);
  chk('快照有「文字」段', !!(json && json.文字), json && json.文字);
  // 串页/重复检查（比只看一个键更能说明问题）
  const tk = Object.keys(json.文字 || {});
  /*
   * ★ 串页判据用**组 id 前缀**，不靠文案内容猜。
   *
   * ⚠️ 我第一版拿 `/倾斜角|帧率上限/` 这种关键词去匹配**文案** —— 那是错的：
   *    当前页（高级）本来就有「倾斜角」这一行，结果把**正常内容**报成了串页。
   *    而且换个页就得重挑关键词，脆得很。
   * 正确判据：这一页是 `adv`，那组键**只能**是 `adv#N/...`；
   *    冒出 `habit#` / `weather#` 才是真串了。
   */
  /*
   * ★★ 2026-10-13 行为改了：导出**只包含他改过的**（从 state 出）。
   *    ⚠️ 断言别按"导出全部"写 —— 那样他改完 6 个页面，
   *       导出的却只有当前那一页（这正是他报的那个 bug），
   *       而且会塞进一大堆没动过的默认值，文件又长又没用。
   */
  const crossPage = tk.filter(k => /^[a-z]+#\d+\//.test(k) && !k.startsWith('adv#'));
  chk('导出没有串进别的页的文案', crossPage.length === 0, crossPage);
  chk('★ 导出里有刚改过的那条', tk.includes('adv#0/r0.label'), tk);
  chk('★ 导出只含改过的（没动的不塞进来）', tk.length === 1, tk.length + ' 条');
  chk('键名不重复', new Set(tk).size === tk.length, tk.length + ' 个');

  // ★ 点了「导出 JSON」应该**弹出一个能看见内容的框**（他上一轮报「没找到 JSON 在哪」）
  await P.ev(`(() => { const b=[...document.querySelectorAll('.d-bar .d-btn')].find(x=>/导出/.test(x.textContent)); if(b) b.click(); })()`);
  await sleep(900);
  const expBox = await P.ev(`(() => {
    const box = document.querySelector('.d-export');
    if (!box) return { err: '没弹出导出框' };
    const ta = box.querySelector('.d-export-t');
    const v = ta ? ta.value : '';
    let parsed = null; try { parsed = JSON.parse(v); } catch { /* 不是合法 JSON */ }
    return {
      hasBox: true,
      visible: box.getBoundingClientRect().width > 100,
      len: v.length,
      parseOk: !!parsed,
      sections: parsed ? Object.keys(parsed) : null,
      btnLabels: [...box.querySelectorAll('.d-export-f .d-btn')].map(b => b.textContent.trim()),
      readonly: ta ? ta.readOnly : null,
    };
  })()`);
  chk('导出弹出可见的框', !!(expBox && expBox.hasBox && expBox.visible), expBox && (expBox.err || expBox.visible));
  chk('框里内容是合法 JSON', !!(expBox && expBox.parseOk), expBox && expBox.len);
  chk('JSON 三段齐全', !!(expBox && expBox.sections && expBox.sections.includes('结构') && expBox.sections.includes('文字')), expBox && expBox.sections);
  chk('框里有三颗按钮（复制/保存/关掉）', !!(expBox && expBox.btnLabels && expBox.btnLabels.length === 3), expBox && expBox.btnLabels);
  chk('文本框是只读的（防手滑改坏）', !!(expBox && expBox.readonly === true), expBox && expBox.readonly);
  chk('保存用的桥接上了', (await P.ev('typeof ((window.yachiyo||{}).ov||{}).designSave')) === 'function');
  // 关掉它，别挡着后面的检查
  await P.ev(`(() => { const b=[...document.querySelectorAll('.d-export-f .d-btn')].find(x=>/关掉/.test(x.textContent)); if(b) b.click(); })()`);
  await sleep(400);
  chk('「关掉」按钮能收掉它', (await P.ev(`!!document.querySelector('.d-export')`)) === false);

  console.log('');
  console.log('=== ⑥ 退出调试台 —— 必须干净还原 ===');
  await P.ev(`(() => { const b=[...document.querySelectorAll('.d-bar .d-btn')].find(x=>/退出/.test(x.textContent)); if(b) b.click(); })()`);
  await sleep(1200);

  const after = await P.ev(`(() => {
    const card = document.querySelector('.card');
    return {
      onClass: card.classList.contains('d-on'),
      bar: !!document.querySelector('.d-bar'),
      marks: document.querySelectorAll('.d-mark').length,
      handles: document.querySelectorAll('.d-handle').length,
      editables: document.querySelectorAll('.d-editable').length,
      inlineVars: card.getAttribute('style') || '',
      sideW: getComputedStyle(document.querySelector('.p-side')).width,
      // 标记（data-something）留着、但不可编辑 —— 这俩得分开量
      stillMarked: document.querySelectorAll('[data-dbase]').length,
    };
  })()`);
  chk('.d-on 去掉了', !after.onClass, after.onClass);
  chk('参数栏清掉了', !after.bar);
  chk('轮廓框清掉了', after.marks === 0, after.marks);
  chk('把手清掉了', after.handles === 0, after.handles);
  /*
   * ★★ 2026-10-13 行为改了：**退出调试台 ≠ 还原**。
   *
   *   退出 = 收起画图工具（手柄/轮廓/参数栏/可编辑样式）
   *   还原 = 撤销改动 —— 那是「全部还原」按钮的事
   *
   * 他要的是「即时生效」，那就得**退出之后照样看得见**，
   * 不然改完一退出就回原样，等于没改。
   * （旧的断言是"变量清空、宽度还原"，那是把两件事混一起了，已改。）
   */
  chk('可编辑样式收掉了（.d-editable 归零）', after.editables === 0, after.editables);
  chk('★ 改过的参数留着（变量还在）', /--d-side-w/.test(after.inlineVars), after.inlineVars);
  chk('★ 左栏宽度保持改过的值', after.sideW !== '158px', after.sideW);
  chk('文字仍带标记（退出后还能铺回来）', after.stillMarked > 0, after.stillMarked);

  console.log('');
  console.log(`=== 界面调试台：${pass.length} 项通过 / ${fail.length} 项失败 ===`);
  if (fail.length) { console.log('失败项：'); for (const f of fail) console.log('  ✗ ' + f); }

  try { child.kill(); } catch { }
  await sleep(900);
  killAll();
  /*
   * ⚠️⚠️ 这里**一个字都别删**（2026-10-13 栽的）。
   *
   *    我原来在这儿 `rmSync(HOME, {recursive:true})` 想"下次跑干净点" ——
   *    结果把 `design.json` 也一起删了，下一遍 `--keep` 读不到东西，
   *    持久化检查**自己把自己的证据删了**，报一个假失败过来，害我查了半天。
   *
   *    ⇒ 「干净起点」改到**开头**做（见上面 `if (!KEEP)` 那行清 design.json）。
   *      结尾留着文件 —— 那才是 `--keep` 要验的东西。
   *      目录落在系统 temp 里，系统会回收，不用我们操心。
   */
  process.exit(fail.length ? 1 : 0);
}

main().catch((e) => { console.error('探针炸了：' + e.stack); killAll(); process.exit(1); });
