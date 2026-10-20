/**
 * 设置面板里那些「自定义行」的挂载函数。
 *
 * 2026-10-20 从 `settings.js` 搬出来的（洗澡 ⑥ 第二刀）：
 * 那个文件 1,261 行里，有 615 行是这堆 `mountXxx(cell)` —— 每一行都自带一套
 * 「建 DOM / 读配置 / 绑事件 / 防重入」的小逻辑，跟页面描述、渲染器混在一起谁也看不清。
 *
 * ⚠️ **和 `settings.js` 是循环引用**（它 import 这里的 mount 函数，这里 import 它的
 *    `api` / `esc` / `selRow` / `curInfo` / `showPage` / `DEV`）。
 *    能这么干的前提：两边在**模块顶层都只是定义，不调用**，真正的取用全在函数里。
 *    ⇒ **别在这个文件顶层读 `api` / `showPage`**，那会儿还可能是空的（TDZ / 未赋值）。
 *    `api` 是 settings.js 的 `export let`，initSettings 里赋值后这边立刻能看到（活绑定）。
 *
 * ⚠️ 这里的 `usagePaint` / `usageChartPaint` / `syncModelInput` 也被 settings.js 的
 *    `apply()` 调（切货币 / 切模型时重画），所以下面要 export 出去。
 */
import { svg } from './icons.js';
import { fontState } from './font.js';
import { api, esc, curInfo, selRow, showPage, DEV } from './settings.js';

let usagePaint = null;

/** 用量与成本那块统计卡 —— 数字从主进程的账本读（`%APPDATA%\Yachiyo\data\usage.json`） */
async function mountUsage(cell) {
  const fmt = (n) => Number(n || 0).toLocaleString('zh-CN');
  let last = null;                      // 账本原文，切货币时重画不用再问主进程

  /** ⚠️ 2026-10-12：金额一律走 curInfo —— ¥/$ 切换要连**统计卡**一起换才自洽 */
  const money = (n) => {
    const { sym, div } = curInfo(api.cfg());
    return sym + (Number(n || 0) / div).toFixed(2);
  };

  const paint = (u) => {
    if (u) last = u;
    if (!last) return;
    const cur = curInfo(api.cfg());
    cell.innerHTML =
      `<div class="stats">
         <div class="stat"><div class="k">今日请求</div><div class="v">${fmt(last.todayCalls)}</div></div>
         <div class="stat"><div class="k">今日 token</div><div class="v">${fmt(last.todayTokens)}</div></div>
         <div class="stat hl"><div class="k">今日花费</div><div class="v">${money(last.todayCost)}</div></div>
         <div class="stat"><div class="k">本月花费</div><div class="v">${money(last.monthCost)}</div></div>
       </div>
       <div class="kv" style="margin-top:8px">累计 ${fmt(last.totalCalls)} 次请求 · ${money(last.totalCost)}</div>`
       + (cur.usd
          ? `<div class="kv" style="margin-top:4px">按 1$ = ${cur.div}¥ 折算，实际账单是人民币</div>`
          : '');
  };

  usagePaint = () => paint(null);
  try { paint(await window.yachiyo.usage.get()); }
  catch { cell.innerHTML = '<span class="kv">账本读不出来。</span>'; }
}

/* ============================================================
   AI 服务商预设（2026-10-17 加，稿子见 留痕\稿子-批次C\稿A2-*.png）
   ============================================================ */

/** 这一页当下的状态：当前是哪个预设、它那份值 */
const provState = { active: '', item: null };
let provSyncArmed = false;

/** 转义 —— 自定义预设的名字是他手输的，直接拼进 innerHTML 不稳 */
const te = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** 按左栏文字找那一行的输入框（面板里的行没有 id，只能这么找） */
function inputOf(labelStart) {
  const row = [...document.querySelectorAll('#pMain .row')]
    .find((r) => ((r.querySelector('.label') || {}).textContent || '').startsWith(labelStart));
  return row ? row.querySelector('input') : null;
}

/** 把地址 / 模型 / Key 三行刷成某个预设的值（⚠️ 找不到那一行就跳过，不抛） */
function fillApiRows(item) {
  if (!item) return;
  const put = (kw, v) => { const i = inputOf(kw); if (i && i.value !== (v ?? '')) i.value = v ?? ''; };
  put('接口地址', item.base);
  put('模型', item.model);
  put('API Key', item.key);
}

/**
 * ★ 他在那三行里改了东西 → **顺手写进当前预设**。
 *
 *   挂 `input` 而不是 `change`：change 要**失焦**才触发，
 *   他改完地址**直接去点另一个服务商** —— change 永远不会来，那一改当场丢。
 *
 *   ⚠️ 只注册一次（模块级）：`showPage` 每次重画都会调一次挂载函数，
 *      监听要是在那儿挂，切十次页就有十个监听一起跑。
 */
function armProviderSync() {
  if (provSyncArmed) return;
  provSyncArmed = true;
  document.addEventListener('input', (e) => {
    const inp = e.target;
    if (!inp || inp.tagName !== 'INPUT' || !provState.active) return;
    const lab = (inp.closest('.row')?.querySelector('.label')?.textContent) || '';
    let patch = null;
    if (lab.startsWith('接口地址')) patch = { base: inp.value };
    else if (lab.startsWith('API Key')) patch = { key: inp.value };
    else if (lab.startsWith('模型')) patch = { model: inp.value };
    if (!patch) return;
    window.yachiyo.providers.save(provState.active, patch).catch(() => {});
  });
}

async function mountProviderPick(cell) {
  let list = { active: '', items: [] };
  try { list = await window.yachiyo.providers.list(); }
  catch { cell.innerHTML = '<span class="kv">预设读不出来。</span>'; return; }

  /** 切完预设之后统一做的一件事：把页面手里的 CFG 和下面三行对齐 */
  const follow = (item) => {
    if (!item) return;
    /*
     * ⚠️ 主进程那边的 config 变了，可**页面手里这份 CFG 还是旧的** ——
     *    所以不能拿 api.cfg() 去刷下面三行，得用刚拿到的这份。
     */
    Object.assign(api.cfg(), { apiBase: item.base || '', apiKey: item.key || '', model: item.model || '' });
    fillApiRows(item);
  };

  const paint = () => {
    const cur = list.items.find((x) => x.id === list.active) || null;
    provState.active = list.active;
    provState.item = cur;

    const chips = list.items.map((p) =>
      `<button type="button" class="btn${p.id === list.active ? ' primary' : ''}" data-pid="${te(p.id)}">${te(p.name)}</button>`
    ).join('');
    /*
     * ⚠️ 按钮之间的间距用 `.cwrap`（它自带 `gap:10px`），**别再内联 `gap`** ——
     *    他 2026-10-17 看过截图说「服务商的按钮中间要有一点间距」，
     *    第一版塞在 `.mrow-top` 里（那层是给「按钮 + 说明文字」用的），间距被挤没了。
     * ⚠️ 那行「某某 —— 它自己的地址 / Key / 模型，切回来还在」的说明**去掉了**：
     *    他明确说「服务商项不用备注」。行为靠按钮高亮 + 下面三行跟着变就能看出来。
     */
    cell.innerHTML =
      `<div class="cwrap">${chips}<button type="button" class="btn" data-padd="1">+ 自定义</button>` +
      `${cur && !cur.builtin ? '<button type="button" class="btn" data-pdel="1">删除</button>' : ''}</div>`;

    cell.querySelectorAll('[data-pid]').forEach((b) => {
      b.onclick = async () => {
        if (b.dataset.pid === list.active) return;
        const r = await window.yachiyo.providers.activate(b.dataset.pid);
        if (!r.ok) return;
        follow(r.item);
        list = await window.yachiyo.providers.list();
        paint();
      };
    });

    const addBtn = cell.querySelector('[data-padd]');
    if (addBtn) {
      addBtn.onclick = () => {
        /*
         * ⚠️ 别用 window.prompt —— Electron 里它被禁掉了（返回 null + 控制台报错），
         *    他点一下会「什么都没发生」。就地变一个输入框出来。
         */
        addBtn.outerHTML = '<input type="text" data-pname="1" placeholder="服务商名字，回车确定">';
        const inp = cell.querySelector('[data-pname]');
        if (!inp) return;
        inp.focus();
        inp.onkeydown = async (e) => {
          if (e.key === 'Escape') { paint(); return; }
          if (e.key !== 'Enter') return;
          const name = inp.value.trim();
          if (!name) { paint(); return; }
          const r = await window.yachiyo.providers.add(name);
          if (!r.ok) { paint(); return; }
          await window.yachiyo.providers.activate(r.id);
          list = await window.yachiyo.providers.list();
          follow(list.items.find((x) => x.id === r.id));
          paint();
        };
      };
    }

    const delBtn = cell.querySelector('[data-pdel]');
    if (delBtn) {
      delBtn.onclick = async () => {
        const r = await window.yachiyo.providers.remove(list.active);
        if (!r.ok) return;
        list = await window.yachiyo.providers.list();
        follow(list.items.find((x) => x.id === list.active));
        paint();
      };
    }
  };

  armProviderSync();
  paint();
  /*
   * ⚠️ 下面那三行**不是**这个挂载函数建的（它们是 R() 建的），所以这里主动对一次账：
   *    万一页面手里的 CFG 跟预设不一致（比如刚从别处切过预设），先把三行刷成预设里的值。
   */
  follow(list.items.find((x) => x.id === list.active));
}

/* ---------- 用量走势图（2026-10-17 加）---------- */

let usageChartPaint = null;

async function mountUsageChart(cell) {
  let range = 'day';
  let data = null;
  /*
   * ★ 2026-10-21：**窗口状态**（日和月用）。`null` = 贴最右端，也就是"看最近的"。
   * ⚠️ 它只在闭包里，**不进配置** —— 写配置会触发面板重画，滑块会被换掉。
   */
  let winPos = null;
  /** 一次显示几格：日 6 小时 · 月 7 天 · 周全显示（本来就 7 根） */
  const winSpan = () => (range === 'day' ? 6 : range === 'month' ? 7 : Number.MAX_SAFE_INTEGER);
  /** 窗口起点（自动夹在合法范围里；null → 最右） */
  const winIndex = (total, span) => {
    if (span >= total) return 0;
    const maxStart = total - span;
    if (winPos === null || !Number.isFinite(winPos)) return maxStart;
    return Math.min(maxStart, Math.max(0, Math.round(winPos)));
  };
  const money = (n) => { const { sym, div } = curInfo(api.cfg()); return sym + (Number(n || 0) / div).toFixed(2); };

  /**
   * 手画柱状图。
   * ⚠️ **不引任何图表库** —— 引了就要跟着进 dist、跟着 Electron 升级，不值当；
   *    就这么几根柱子，SVG 手写比配一个库便宜。
   */
  const chart = () => {
    /*
     * ★★ 2026-10-21：**日和月加"窗口 + 滑块"，字号统一放大 25%**（他要的）。
     *   他原话：「字体好小看不清……日和月做个可拖动小滑块，显示范围只显示最近
     *   6 小时 / 7 天，并且将日/周/月的数据显示放大 25%」。
     *   ⇒ 日视图一次露 6 格、月视图 7 格（每格撑到 ~90px，字才看得清），
     *     剩下一段靠滑块平移；周视图本来 7 根就放得下，不加滑块。
     *   ⚠️ 窗口位置存在**闭包**里（`winPos`），不进配置 —— 存配置会触发面板重画，
     *      重画就把手里正拖着的滑块换掉了（跟调色板那次同一个坑）。
     */
    const span = winSpan();
    const i0 = winIndex(data.points.length, span);
    const P = data.points.slice(i0, i0 + span);
    const W = 640; const H = 196; const PAD = 16;
    const n = P.length;
    /* 窗口化之后最多 7 根 ⇒ 宽度可以给足；仍留一档给周视图 */
    const BW = n >= 7 ? 62 : n >= 4 ? 78 : 96;
    const gap = (W - PAD * 2 - BW * n) / Math.max(1, n - 1);
    const max = Math.max(data.peak, 1e-9);

    /** token 数 → 短标签：日/周 用 k；月按量级 k / m（他 2026-10-21 定的） */
    const tok = (v) => {
      const x = Math.round(Number(v) || 0);
      if (!x) return '0';
      if (range === 'month' && x >= 1e6) return (x / 1e6).toFixed(x >= 1e7 ? 0 : 1) + 'm';
      const k = x / 1000;
      return (k >= 10 ? Math.round(k) : Math.round(k * 10) / 10) + 'k';
    };
    /*
     * 字号：窗口化后每格 ~90px，三档统一**放大 25%**（他要求 ×1.25）。
     * 周 10→12.5 / 日 6.5→8.1 / 月 5.5→6.9（单位、金额同比例）。
     */
    const K = 1.25 * 1.75;   // 2026-10-21 追加：再放大 75%
    const base = n <= 8 ? { num: 10, unit: 6, money: 7.5 } : { num: 6.5, unit: 4, money: 5.5 };
    const S = { num: base.num * K, unit: base.unit * K, money: base.money * K };

    let bars = '';
    P.forEach((p, i) => {
      const h = Math.max(2, Math.round((p.cost / max) * (H - 22 - 88)));
      const x = PAD + i * (BW + gap);
      const y = H - 22 - h;
      const gIdx = i0 + i;                             // 在整段里的真实下标
      const isNow = gIdx === data.points.length - 1;    // 最后一格 = 现在
      /* `<title>` 必须写在 rect **里面** —— SVG 里它是子元素，放外面挂不上 */
      bars += `<rect x="${x.toFixed(1)}" y="${y}" width="${BW}" height="${h}" rx="${Math.min(4, BW / 3)}"`
        + ` fill="var(--accent)" opacity="${isNow ? 1 : 0.42}">`
        + `<title>${te(p.label)} · ${te(tok(p.tokens))} token · ${te(money(p.cost))}</title></rect>`;

      const cx = (x + BW / 2).toFixed(1);
      const ny = Math.round(Math.max(12, y - 64));      // 三行标签上移（12 + 追加 28 = 40；放大后间距要跟着缩放）
      bars += `<text x="${cx}" y="${ny}" font-size="${S.num}" text-anchor="middle"`
        + ` fill="var(--accent)" font-weight="600">${te(tok(p.tokens))}</text>`
        + `<text x="${cx}" y="${ny + S.num + 1}" font-size="${S.unit}" text-anchor="middle"`
        + ` fill="var(--sub)">token</text>`
        + `<text x="${cx}" y="${ny + S.num + S.unit + 4}" font-size="${S.money}" text-anchor="middle"`
        + ` fill="var(--accent)">${p.cost > 0 ? te(money(p.cost)) : '—'}</text>`;

      /* 窗口里最多 7 根 ⇒ **每根都标时间**（以前是首/中/尾） */
      bars += `<text x="${cx}" y="${H - 6}" font-size="10.5"`
        + ` text-anchor="middle" fill="var(--sub)">${te(p.label)}</text>`;
    });
    return `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}">` +
      `<line x1="${PAD}" y1="${H - 22}" x2="${W - PAD}" y2="${H - 22}" stroke="var(--line)" stroke-width="1"></line>` +
      `${bars}</svg>`;
  };

  const paint = () => {
    if (!data) return;
    const seg = [['day', '日'], ['week', '周'], ['month', '月']]
      .map(([k, t]) => `<button class="btn${k === range ? ' primary' : ''}" data-range="${k}">${t}</button>`).join('');
    const tip = { day: '近 24 小时 · 按小时', week: '近 7 天 · 按天', month: '近 30 天 · 按天' }[range];
    const unit = range === 'day' ? '时' : '天';
    /*
     * ★★ 2026-10-21：**日和月加"窗口 + 滑块"**（他要的）。
     *   日视图一次只露 6 格、月视图 7 格 —— 每格撑到 ~90px，字才看得清；
     *   剩下的部分靠滑块平移。周视图本来 7 根就放得下，不加滑块。
     *   ⚠️ 窗口位置存在闭包里（`winPos`），**不进配置** —— 存配置会触发面板重画，
     *      重画就把滑块复位了（跟调色板那次同一个坑）。
     */
    const total = data.points.length;
    const span = winSpan();
    const i0 = winIndex(total, span);
    const slider = span >= total ? '' :
      `<input type="range" class="uchart-range" min="0" max="${total - span}" step="1" value="${i0}"`
      + ` title="拖这里看更早的">`;
    cell.innerHTML =
      `<div style="display:flex; flex-direction:column; gap:8px; width:100%">
         <div class="mrow-top"><div class="cwrap">${seg}</div></div>
         <div class="uchart">${chart()}</div>
         ${slider}
         <div class="kv">${tip} · 合计 ${te(money(data.sum.cost))} · 峰值 ${te(money(data.peak))} · 平均 ${te(money(data.sum.cost / Math.max(1, data.points.length)))}/${unit}</div>
       </div>`;
    cell.querySelectorAll('[data-range]').forEach((b) => {
      b.onclick = async () => { range = b.dataset.range; winPos = null; await load(); };
    });
    const sl = cell.querySelector('.uchart-range');
    if (sl) {
      /* 只重画图那一块 —— 整页重画会把手里正拖着的滑块换掉 */
      sl.oninput = () => { winPos = Number(sl.value); cell.querySelector('.uchart').innerHTML = chart(); };
    }
  };

  const load = async () => {
    try { data = await window.yachiyo.usage.series(range); }
    catch { cell.innerHTML = '<span class="kv">走势图读不出来。</span>'; return; }
    paint();
  };

  usageChartPaint = () => paint();     // 切 ¥/$ 时也要重画（跟统计卡一样）
  await load();
}

/**
 * 「检测模型」—— 问接口地址「你有哪些模型」。
 *
 * 他 2026-10-12 要的：「检测地址关联的模型以及可用性」。
 *
 * ⚠️ 跟下面那个「测试连接」是**互补**的两件事，别混：
 *    · 检测模型 = `GET /models` —— **免费、快**（一两秒），问出「有哪些名字」
 *                  但**不能证明某个模型真能生成**（有的中转站列了却在后台限权）
 *    · 测试连接 = 真发一句话 —— 花钱、慢（思考模式十几秒），但那是真的能用
 *    ⇒ 所以这里检测完要**顺手提示一句**「挑好再点测试连接」，
 *      不然他会以为检测通过了就等于配好了。
 */

/** 把「模型」那一行的输入框刷成配置里的值（别处改了模型名时用） */
function syncModelInput() {
  const inp = [...document.querySelectorAll('#pMain .row')]
    .find((r) => r.querySelector('.label')?.textContent.startsWith('模型'))
    ?.querySelector('input');
  if (inp) inp.value = api.cfg().model ?? '';
}

/**
 * 「界面字体」那一行。
 *
 * 他 2026-10-12 要的：「增加字体更换项（现在用的默认字体保留，增加一个预设）」。
 *
 * ⚠️ 候选是**现扫出来的**，不是写死的：`%APPDATA%\Yachiyo\fonts\` 里有什么
 *    就列什么，他在那儿多丢几个 ttf 就多几个选项。
 *    ⚠️ 这也是为什么字体文件放在**用户目录**而不是仓库里 ——
 *       字体的版权说不清，第 5 步要开源，不能把一个来源不明的 ttf 打进去。
 */
function mountFontPick(cell) {
  cell.innerHTML = '<span class="kv" id="fontWait">读取中…</span>';

  (async () => {
    let list = [];
    let dir = '';
    try { [list, dir] = await Promise.all([window.yachiyo.font.list(), window.yachiyo.font.dir()]); }
    catch (err) { cell.innerHTML = `<span class="kv">字体读不出来：${esc(err.message)}</span>`; return; }

    const cur = api.cfg().fontFamily || '';
    const opts = [['', '系统默认（微软雅黑）'], ...list.map((f) => [f, f.replace(/\.[^.]+$/, '')])];

    cell.innerHTML = (list.length ? '' : '<div class="kv" style="margin-top:6px">'
          + `字体目录还是空的 —— 把 .ttf / .otf 丢进 <code>${esc(dir)}</code>，再回来选。</div>`)
      + '<div class="kv" style="margin-top:6px" id="fontOut"></div>';

    const out = cell.querySelector('#fontOut');

    // ⚠️ 这里原来也是原生 <select>（同一个「蓝白菜单」的毛病），换自绘的
    cell.insertBefore(
      selRow(opts, cur, async (v) => {
        await api.setCfg('fontFamily', v);
        /* ⚠️ 改完要**当场验证**：字体文件可能在、但坏了 / 不是字体。
           实测过 file:// 直接加载会被 CORS 拦（所以走了 IPC），
           万一这条路也不通，至少让他看见一句人话，而不是「选了没反应」。 */
        const st = fontState();
        const okNow = v === '' || st.has;
        out.style.color = okNow ? '' : '#e5484d';
        out.textContent = v === ''
          ? '已换回系统默认。'
          : (okNow ? `换好了 · ${st.registered.join(' ')}` : '没换成 —— 那个文件可能不是字体，或者读不了。');
      }),
      cell.firstChild);
  })();
}

/**
 * 「倾斜角」那一行 —— **5 个姿态各一根滑块**。
 *
 * ⚠️⚠️ 这 5 个值不在 `config.json` 里，在 **`rig.json` 的 presets** 里
 *    （见 `src/core/rigparams.cjs` 顶部的长注释：那个文件本来就是
 *      "每个姿态那套参数"的唯一真源，另外存一份必然两边对不上）。
 *    所以这里**不能用 `ctx.set`** —— 那个是写 config 的。
 *    走 `window.yachiyo.rig.setTilts()`，主进程写完 rig.json 会广播回来，
 *    主窗口那边立刻 `rig.setTilts()` 改内存 —— 不然就是「拖了没反应，重启才生效」。
 */
async function mountTiltPoses(cell) {
  cell.classList.add('stack');
  cell.innerHTML = '<span class="kv" id="tiltWait">读取中…</span>';

  const POSES = [
    ['idle', '待机'], ['walk', '走路'], ['run', '跑动'],
    ['sit', '坐下'], ['sleep', '睡觉'],
  ];

  let cur = {};
  try { cur = await window.yachiyo.rig.tilts(); }
  catch (err) {
    cell.innerHTML = `<span class="kv">倾斜角读不出来：${esc(err.message)}</span>`;
    return;
  }

  cell.innerHTML = '<div class="tilt-rows"></div><div class="kv" id="tiltOut"></div>';
  const box = cell.querySelector('.tilt-rows');
  const out = cell.querySelector('#tiltOut');

  for (const [mode, label] of POSES) {
    const row = document.createElement('div');
    row.className = 'tilt-row';

    const name = document.createElement('span');
    name.className = 'tilt-name';
    name.textContent = label;

    const sl = document.createElement('input');
    sl.type = 'range';
    sl.min = '-10'; sl.max = '10'; sl.step = '0.5';
    sl.value = String(cur[mode] ?? 0);
    sl.dataset.mode = mode;

    const val = document.createElement('span');
    val.className = 'tilt-val';
    const show = () => {
      const v = Number(sl.value);
      val.textContent = (v > 0 ? '+' : '') + v.toFixed(1) + '°';
    };
    show();

    // 拖动时只改显示，松手才落盘（一路写会把磁盘刷爆）
    sl.oninput = show;
    sl.onchange = async () => {
      const v = Number(sl.value);
      const r = await window.yachiyo.rig.setTilts({ [mode]: v }).catch((e) => ({ ok: false, why: e.message }));
      if (!r || r.ok === false) {
        out.style.color = '#e5484d';
        out.textContent = '没改成：' + ((r && r.why) || '未知原因');
        return;
      }
      out.style.color = '';
      out.textContent = `改好了：${label} ${(v > 0 ? '+' : '') + v.toFixed(1)}°（已经生效，不用重启）`;
    };

    row.append(name, sl, val);
    box.appendChild(row);
  }

  out.textContent = '正值往后倒，负值往前倾。她面朝右，所以「-2°」看着是微微前倾。';
}

/**
 * 天气「试一下」—— 真去查一次给他看。
 *
 * ⚠️ 查不到时要把**原因**原样说出来（旧工程专门修过这条）：
 *    「城市表没拉到」和「省名写错了」是两回事，
 *    一律报「没认出城市」会把人往错处引 —— 他会以为自己城市名填错了。
 */
function mountWeatherTest(cell) {
  cell.classList.add('stack');
  cell.innerHTML =
    '<div class="mrow-top">'
    +   '<button class="btn primary" id="wTestBtn">查一下</button>'
    +   '<span class="kv" id="wTestOut">填好城市再点它</span>'
    + '</div>'
    + '<div class="mlist" id="wTestBody"></div>';

  const btn  = cell.querySelector('#wTestBtn');
  const out  = cell.querySelector('#wTestOut');
  const body = cell.querySelector('#wTestBody');

  btn.onclick = async () => {
    const before = btn.textContent;
    btn.disabled = true; btn.textContent = '正在查…';
    out.style.color = ''; out.textContent = '正在问中国天气网…';
    body.innerHTML = '';

    let r;
    try { r = await window.yachiyo.weather.get(true); }
    catch (err) { r = { ok: false, error: err.message }; }

    btn.disabled = false; btn.textContent = before;

    if (!r.ok) {
      out.style.color = '#e5484d';
      out.textContent = '× ' + (r.error || r.why || '没查到');
      return;
    }
    out.textContent = (r.cached ? '拿到（缓存那份）' : '拿到了') + (r.city ? ` · ${r.city}` : '');
    // 提示词里看到的就是这几行 —— 让他一眼知道她「知道」了什么
    body.innerHTML = '<pre class="wtext"></pre>';
    body.querySelector('.wtext').textContent = r.text;
  };
}

/**
 * 「模型调试」那一行 —— **两个按钮 + 一块结果区**，一次建出来。
 *
 * ★ 2026-10-12 他要求的顺序：
 *     接口地址 → 检测模型（免费，只认地址）→ 填 Key → 测试连接（花钱，真发一句）
 *
 * ⚠️⚠️ 两个按钮**必须在同一次 innerHTML 里建**。
 *    分开写两次 `cell.innerHTML = …`（原来是那样）的话，
 *    第二次会把第一次建好的按钮连同它的事件一起抹掉 ——
 *    那个按钮还在屏幕上，点着**一点反应都没有**，而且不报错。
 *    这是「假开关」那一类，最难查。
 */
function mountAiDebug(cell) {
  cell.classList.add('stack');
  cell.innerHTML =
    '<div class="mrow-top">'
    +   '<button class="btn primary" id="aiMdBtn">检测模型</button>'
    +   '<button class="btn" id="aiPingBtn">测试连接</button>'
    +   '<span class="kv" id="aiDbgOut"></span>'
    + '</div>'
    + '<div class="mlist" id="aiDbgList"></div>';

  const mBtn  = cell.querySelector('#aiMdBtn');
  const pBtn  = cell.querySelector('#aiPingBtn');
  const out   = cell.querySelector('#aiDbgOut');
  const list  = cell.querySelector('#aiDbgList');

  /* ── 检测模型：GET /models，免费、只要地址 ───────────────── */
  mBtn.onclick = async () => {
    const before = mBtn.textContent;
    mBtn.disabled = true; mBtn.textContent = '正在问…';
    out.style.color = ''; out.textContent = '正在问这个地址…';
    list.innerHTML = '';

    let r;
    try { r = await window.yachiyo.ai.models(); }
    catch (err) { r = { ok: false, error: err.message }; }

    mBtn.disabled = false; mBtn.textContent = before;

    if (!r.ok) {
      /*
       * ⚠️ 两种情况都**不是红字**，因为都不是「坏了」：
       *    · noList   —— 这家没实现 /models，不代表地址写错
       *    · needsKey —— 地址是通的，只是要钥匙才肯给清单（官方端点都这样）
       *    只有真错（连不上 / 超时）才标红。
       */
      const soft = r.noList || r.needsKey;
      out.style.color = soft ? '' : '#e5484d';
      out.textContent = (r.noList ? '（问不出清单）' : r.needsKey ? '（只差钥匙）' : '× ') + r.error;
      return;
    }

    const cur = r.current || '';
    const has = r.ids.includes(cur);
    out.textContent = (r.keyed ? '通了（带 Key）' : '通了') + ` · 地址认得 ${r.ids.length} 个模型`;

    // 候选灌进「模型」那一行的 datalist（原生下拉，手打也照样能用）
    let dl = document.getElementById('aiModelList');
    if (!dl) {                       // 页面重画过就自己补一个
      dl = document.createElement('datalist');
      dl.id = 'aiModelList';
      cell.appendChild(dl);
    }
    dl.innerHTML = r.ids.map((id) => `<option value="${esc(id)}"></option>`).join('');

    list.innerHTML = r.ids.length
      ? r.ids.map((id) => `<button class="mchip${id === cur ? ' on' : ''}" data-id="${esc(id)}">${esc(id)}</button>`).join('')
      : '<span class="kv">地址没列出任何模型 —— 可能它不支持 /models，手打模型名就行</span>';

    // 点一下就填进「模型」那一行，不用回去手敲
    list.querySelectorAll('.mchip').forEach((b) => {
      b.onclick = async () => {
        await api.setCfg('model', b.dataset.id);
        list.querySelectorAll('.mchip').forEach((x) => x.classList.toggle('on', x === b));
        syncModelInput();
      };
    });

    // 当前配的那个在不在清单里 —— 不在多半是名字拼错了，得说出来
    const warn = document.createElement('div');
    warn.className = 'kv';
    warn.style.marginTop = '6px';
    if (!cur) {
      warn.textContent = '还没填模型名 —— 点下面一个，或者自己敲。';
    } else if (has) {
      warn.textContent = `当前用的是 ${cur} —— 在清单里 ✓`;
    } else if (r.ids.length) {
      warn.style.color = '#e5484d';
      warn.textContent = `当前用的是 ${cur} —— 清单里没有这个名字，八成拼错了。`;
    }
    list.appendChild(warn);

    // 免费的那半做完了，提醒他还有花钱的那半
    if (cur && has) {
      const tip = document.createElement('div');
      tip.className = 'kv';
      tip.style.marginTop = '2px';
      tip.textContent = '清单里有 ≠ 一定能用（有的中转站列了却在后台限权）。想要准信儿就点旁边的「测试连接」真发一句。';
      list.appendChild(tip);
    }
  };

  /* ── 测试连接：真发一句话，花钱、慢 ─────────────────────── */
  pBtn.onclick = async () => {
    const before = pBtn.textContent;
    pBtn.disabled = true; pBtn.textContent = '正在问…';
    out.style.color = ''; out.textContent = '（思考模式可能要等十几秒）';
    try {
      const r = await window.yachiyo.ai.ping();
      if (r.ok) { out.textContent = `通了 · 她回了「${r.text.trim()}」· ${r.ms} ms`; }
      else {
        out.style.color = r.needsKey ? '' : '#e5484d';
        out.textContent = r.error;
      }
    } catch (err) {
      out.style.color = '#e5484d'; out.textContent = err.message;
    } finally {
      pBtn.disabled = false; pBtn.textContent = before;
    }
  };
}

function mountCfgPath(cell) {
  cell.innerHTML = `<span class="kv" id="cfgPathTxt">读取中…</span>`;
  window.yachiyo.cfg.dir().then((d) => {
    const el = document.getElementById('cfgPathTxt');
    if (el) el.textContent = d;
  });
}

/**
 * 界面调试台的入口 —— **他 2026-10-13 要的，而且要求「最好是不起眼」**。
 *
 * 所以这里故意只给一个灰扑扑的小字按钮，没有强调色、没有图标。
 * 正常用面板的人扫一眼就过去了；要找它的人知道它在高级页最底下。
 *
 * 点开之后：面板上出现虚线轮廓 + 可拖的把手 + 可直接改的文字，
 * 底部弹出一条参数栏。退出时全部销毁，面板一个像素都不变（见 design.js 文件头）。
 */
function mountDesignEntry(cell) {
  /*
   * ⚠️⚠️ **正式版里这个按钮根本不存在**（他 2026-10-13 说的：
   *    「调试台可不能打包进去」）。
   *
   * 判据是 `window.yachiyo.dev` —— 由 preload 按主进程的 `app.isPackaged` 给。
   * 正式版它为 false ⇒ 这里直接 return，**连按钮都不建**，
   * 而且 `design.js` 走的是**动态 import**，所以那个模块在正式版里
   * 连加载都不会加载（顶层副作用一个都不跑）。
   *
   * ⚠️ 别改成静态 `import * as design from './design.js'` —— 那样不管用不用，
   *    模块都会被拉进打包产物并执行。现在的写法才叫"没打包进去"。
   */
  if (!DEV()) return;

  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn quiet';
  b.textContent = '界面调试台';
  b.onclick = () => {
    // 点了才去加载 —— 平时它连模块都不进
    import('./design.js').then((m) => m.enable()).catch(() => { /* 加载不了就算了 */ });
  };
  cell.appendChild(b);
}

/* ============================================================
   渲染
   ============================================================ */

/** 独立窗口，加载完直接起 —— 不用等谁调 openPanel */

export {
  mountUsage,
  mountProviderPick,
  mountUsageChart,
  mountFontPick,
  mountTiltPoses,
  mountWeatherTest,
  mountAiDebug,
  mountCfgPath,
  mountDesignEntry,
  usagePaint,
  usageChartPaint,
  syncModelInput,
};
