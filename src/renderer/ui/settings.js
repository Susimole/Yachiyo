/**
 * 设置面板 —— 五页：习惯 / 对话框 / 天气 / AI 接入 / 高级
 *
 * 声明式：下面 PAGES 里描述一行长什么样，renderPage 负责造 DOM。
 * 加一个设置项 = 在 PAGES 里加一行，别的地方都不用动。
 * 每一项都直接读写 config.json 的键（键名跟 src/core/config.cjs 一一对应）。
 */

import { svg } from './icons.js';
import { fontState } from './font.js';
import { makeHost } from './host.js';

let api = null;       // { cfg, setCfg, reset, onChanged }
let curPage = 'habit';

/**
 * 现在跑的是开发版吗 —— 由 preload 按主进程的 `app.isPackaged` 给（`window.yachiyo.dev`）。
 *
 * 全工程**只有一处**判断（就是这儿），给「界面调试台」那道锁用：
 *   正式版里那颗按钮不建、整组不画、`design.js` 也不加载。
 * 用函数而不是顶层常量：preload 的注入时机不保证在模块求值之前。
 */
const DEV = () => !!(window.yachiyo && window.yachiyo.dev);

/* ============================================================
   页面描述
   ============================================================ */

const R = (key, label, min, max, step, fmt, hint) =>
  ({ t:'range', key, label, min, max, step, fmt, hint });

/**
 * 预设主题色 —— **从她立绘上取的**，不是随便挑的色板。
 * 这样面板的配色跟人物本身是一套，不会出现「面板蓝、人物粉」那种割裂。
 * 顺序：默认 → 发梢/章鱼 → 裙子 → 和服 → 头发 → 发饰
 */
/** 数字输入框（不是滑块）—— 单价这种要精确填的数，滑块拖不准 */
const N = (key, label, step, hint) =>
  ({ t:'num', key, label, step: step || 0.01, hint });

/**
 * 货币符号和换算。
 * ⚠️ DeepSeek 实际是按**人民币**扣款的。切到 $ 只是给你一个价格感觉，
 *    不改真实账单 —— 所以用配置里那个写死的汇率，不联网查。
 */
export function curInfo(cfg) {
  const usd = cfg.currency === 'usd';
  return { usd, sym: usd ? '$' : '¥', div: usd ? (Number(cfg.usdRate) || 7.25) : 1 };
}

/* ============================================================
   自绘下拉 —— 替掉原生 <select>
   ============================================================
   ⚠️⚠️ 为什么非换不可（他 2026-10-12 贴了截图）：

      原生 `<select>` 的**弹出菜单是 Chromium 自己画的，CSS 管不着**。
      闭合那只框我们能上样式，但点开之后那张白底蓝高亮的列表是系统级的 ——
      实测就是这样，而且**没有 `::picker()` 那种选择器能碰它**
      （Chromium 那个新伪元素要 `appearance: base-select` 才生效，
       而开了那个连闭合态都跟着变，得不偿失）。

      所以整条链自己来：按钮 + 一张浮层卡片，**跟面板同一套变量**
      （--bg-solid / --line / --accent / --r-card），深色模式也自动跟着走。

   ⚠️ 浮层挂在 `.card` 上（它是 `position:absolute; inset:0`，是现成的定位父级），
      **不能挂进 #pMain** —— 那是 `overflow-y:auto` 的滚动区，浮层会被裁掉。
   ⚠️ 全局只留一张浮层：面板重画（showPage）时上一张必须收掉，否则会叠在页面上。
   ============================================================ */
let closeOpenPop = null;

export function closeSelectPop() { if (closeOpenPop) closeOpenPop(); }

function selRow(opts, cur, onPick) {
  const wrap = document.createElement('div');
  wrap.className = 'cwrap';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'sel-trig';

  const labelOf = (v) => {
    const hit = opts.find(([val]) => String(val) === String(v));
    return hit ? hit[1] : (opts[0] ? opts[0][1] : '');
  };
  trigger.innerHTML = `<span class="sel-txt"></span><span class="sel-car">▾</span>`;
  trigger.querySelector('.sel-txt').textContent = labelOf(cur);
  wrap.appendChild(trigger);

  let pop = null;

  const close = () => {
    if (!pop) return;
    pop.remove(); pop = null;
    trigger.classList.remove('open');
    document.removeEventListener('mousedown', onOutside, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close, true);
    if (closeOpenPop === close) closeOpenPop = null;
  };

  const onOutside = (e) => { if (pop && !pop.contains(e.target) && !wrap.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };

  trigger.onclick = (e) => {
    e.stopPropagation();
    if (pop) { close(); return; }
    closeSelectPop();                       // 别的地方可能还开着一张

    pop = document.createElement('div');
    pop.className = 'sel-pop';
    for (const [val, txt] of opts) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'sel-item';
      /*
       * ⚠️ 加在**按钮自己身上**（`.sel-item.on`），不是行上 ——
       *    跟 .seg / .switch 一个道理，加错了选择器匹配不上，选中态就不显示。
       */
      if (String(val) === String(cur)) item.classList.add('on');
      item.innerHTML = `<span class="sel-tick">${String(val) === String(cur) ? '✓' : ''}</span>`
                     + `<span class="sel-item-t"></span>`;
      item.querySelector('.sel-item-t').textContent = txt;
      item.onclick = async (ev) => {
        ev.stopPropagation();
        cur = val;
        trigger.querySelector('.sel-txt').textContent = labelOf(val);
        close();
        await onPick(val);
      };
      pop.appendChild(item);
    }

    // 定位父级 = 整张卡片
    const host = document.querySelector('.card') || wrap.parentElement || document.body;
    host.appendChild(pop);

    // 先量再摆 —— 弹出前必须已经在 DOM 里（否则 clientHeight 是 0）
    const hb = host.getBoundingClientRect();
    const tb = trigger.getBoundingClientRect();
    let x = tb.left - hb.left;
    const py = pop.offsetHeight;
    let y = tb.bottom - hb.top + 6;
    if (y + py > hb.height - 8) y = Math.max(8, tb.top - hb.top - py - 6);  // 下面放不下就往上翻
    if (x + pop.offsetWidth > hb.width - 8) x = Math.max(8, hb.width - pop.offsetWidth - 8);
    pop.style.left = Math.round(x) + 'px';
    pop.style.top  = Math.round(y) + 'px';

    trigger.classList.add('open');
    document.addEventListener('mousedown', onOutside, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close, true);
    closeOpenPop = close;
  };

  wrap._closeSel = close;      // 面板重画时收掉（showPage 里用）
  return wrap;
}

export const PRESET_COLORS = [
  ['#0A7EA4', '海蓝（默认）'],
  ['#D96A8E', '桃粉 · 发梢和章鱼'],
  ['#2E9E8F', '青玉 · 裙子'],
  ['#2B3A6B', '藏青 · 和服'],
  ['#8A87B8', '月白 · 头发'],
  ['#C99A2E', '鎏金 · 发饰'],
];

export const PAGES = [
  {
    k:'habit', icon:'pulse', name:'习惯', title:'习惯',
    desc:'她平时干什么、多久动一次、多大一只。',
    groups:[
      /*
       * ★★ 2026-10-12 他要求的挪动，**两件事要分开看**（我第一轮把第二件当成做完了，其实没有）：
       *   · 「说话」「画面」两块 **搬去「高级」** ✓ 那次真做了
       *   · 「通用」**提到本页第一排** ✗ 那次**没做** ——
       *     我只是把中间两块删掉，它自然就落到了最后；我误当成"已经提到第一排"。
       *     （他第二次报「通用不在首排」时我还以为是他没重启 —— 是我错了。）
       *
       * ⚠️ 搬块要连着**挂载点**一起改（见 showPage 里那几行 querySelector）——
       *    「界面字体」跟着「通用」走，那个挂载是**全局现查**的，所以不受影响。
       */
      { title:'通用', rows:[
        { t:'seg', key:'theme', label:'深浅色',
          opts:[['light','浅色'],['dark','深色']] },
        { t:'colors', key:'accent', label:'主题色',
          hint:'预设是从她立绘上取的；右边那颗可以自己调' },
        { t:'sw', key:'alwaysOnTop', label:'总在最前', hint:'别被别的窗口盖住' },
        /*
         * ⚠️ 他 2026-10-12 说的：「音效大小可调滑块（**只在设置菜单中，不在右键菜单**）」。
         *    右键菜单是 244×250 的小窗，塞一根滑块进去太挤；那边只留「音效」开关。
         *    关掉音效时这一行没意义，但**不藏** —— 藏了会跳行，他调音量得先开音效。
         */
        R('soundVolume','音效音量', 0, 100, 5, v => v + '%'),
        /*
         * 字体。
         *   ⚠️ 候选是**动态**的 —— 扫 `%APPDATA%\Yachiyo\fonts\` 里有什么 ttf，
         *      所以走自定义行，不能用写死 opts 的 `sel`。
         */
        { t:'custom', key:'fontPick', label:'界面字体',
          hint:'字库放在「字体」文件夹里，丢进去就能选' },
        /* ★ 2026-10-13 接上了：往 HKCU...Run 写一条。
         *   ⚠️ 为什么不用 Electron 的 setLoginItemSettings —— 它**打包后才认**，
         *      开发期跑源码它写的是 electron.exe 却不带工程路径，开机只弹一个空白窗口。
         *      注册表这条两头都能用（见 core/autostart.cjs 顶上那段）。 */
        { t:'sw', key:'autostart', label:'开机自启', hint:'开机跟着系统起来' },
      ]},
      { title:'行为', rows:[
        { t:'seg', key:'roam', label:'走动节奏', hint:'更爱走还是更爱待着',
          opts:[['active','活跃'],['normal','默认'],['quiet','安静']] },
        R('moveSpeed','移动速度', 20, 300, 5, v => v + '%', '她走动时挪多快'),
        R('activity','活跃度', 20, 300, 5, v => v + '%', '越高换动作越勤'),
        { t:'sw',  key:'moveEnabled', label:'桌宠移动', hint:'关掉她就原地待着不动' },
      ]},
      { title:'外观', rows:[
        R('petSize','桌宠大小', 5, 300, 5, v => v + '%', '相对原始立绘的尺寸'),
        { t:'sw', key:'shadow', label:'影子', hint:'立绘下方的投影' },
      ]},
    ],
  },
  {
    k:'bubble', icon:'chat', name:'对话框', title:'对话框',
    desc:'她说话时那张气泡的位置、大小和长相。',
    groups:[
      { title:'位置', rows:[
        { t:'seg', key:'bubbleAnchor', label:'固定点', hint:'气泡挂在她哪个角',
          opts:[['tl','左上'],['tr','右上'],['bl','左下'],['br','右下']] },
        R('bubbleW','宽度', 120, 520, 2, v => v + 'px'),
        R('bubbleH','最大高度', 0, 600, 10, v => v ? v + 'px' : '自动'),
      ]},
      { title:'外观', rows:[
        R('bubbleAlpha','不透明度', 20, 100, 1, v => v + '%'),
        R('bubbleFontSize','字号', 10, 22, 0.5, v => v + 'px'),
        { t:'color', key:'bubbleTextColor', label:'文字颜色' },
        { t:'sel', key:'bubbleOverflow', label:'字太多时',
          opts:[['wrap','换行'],['clip','截断']] },
      ]},
      { title:'时间', rows:[
        R('bubbleSeconds','停留时长', 2, 60, 1, v => v + ' 秒'),
      ]},
    ],
  },
  {
    k:'weather', icon:'sun', name:'天气', title:'天气',
    desc:'她看天气、念天气的方式。数据来自中国天气网。',
    groups:[
      { title:'城市', rows:[
        { t:'text', key:'city', label:'城市', ph:'湖南省郴州市',
          hint:'要带省名；也可直接填 9 位 ID' },
        { t:'seg', key:'tempUnit', label:'温度单位',
          opts:[['c','摄氏 °C'],['f','华氏 °F']] },
        // 填了城市就能当场验一次 —— 不然「填了没反应」又变成假开关
        { t:'custom', key:'weatherTest', label:'试一下' },
      ]},
      { title:'播报', rows:[
        { t:'sw', key:'weatherAuto', label:'每天自动播报' },
        R('weatherRefreshMin','刷新间隔', 5, 120, 1, v => v + ' 分钟'),
        { t:'seg', key:'weatherVoice', label:'念法',
          opts:[['read','照着念'],['own','用自己的话']] },
      ]},
    ],
  },
  {
    k:'ai', icon:'chip', name:'AI 接入', title:'AI 接入',
    desc:'她的大脑接在哪、花多少钱。默认预设 DeepSeek。',
    groups:[
      { title:'连接', rows:[
        { t:'text', key:'apiBase', label:'接口地址', ph:'https://api.deepseek.com' },
        /*
         * ⚠️ 2026-10-12 他说的：「模型接入那里选择模型项需要有一个检测模型按钮，
         *    目的是检测地址关联的模型以及可用性」。
         *
         *    原来这一行是三个写死的下拉项，地址换了、供应商换了就抓瞎 ——
         *    自建服务或者中转站的模型名它一个都不认得。
         *    现在改成**输入框 + 候选下拉**：
         *      · 下面那个「检测模型」按钮会把地址真实认得的模型名灌进候选里
         *      · 但照样能手打（自建服务未必提供 /models 接口）
         */
        { t:'text', key:'model', label:'模型', ph:'deepseek-flash', list:'aiModelList' },
        { t:'key', key:'apiKey', label:'API Key', ph:'sk-…' },
        /*
         * ★ 2026-10-12 他的要求，两块并成一行：
         *   「在填入接口地址后应当可以先检测接口地址是否有对应模型，而不是让用户
         *     填写 API 后才能检测（填入 API 后是测试连接的事了），并且将测试连接
         *     和模型检测放在一行，**最左边写那一栏别空着，写个「模型调试」**」
         *
         * 顺序按「先免费后花钱」排：
         *   检测模型 = GET /models，不花钱，只要地址（本地服务连 Key 都不用）
         *   测试连接 = 真发一句话，花钱、思考模式要十几秒 —— 那是填完 Key 之后的事
         * ⚠️ 两块并成一行后，**两个按钮的 DOM 必须在同一次 innerHTML 里建出来**，
         *    否则先建的那批会被后一次的 innerHTML 抹掉，点着没反应（还看不出哪儿错）。
         */
        { t:'custom', key:'aiDebug', label:'模型调试' },
      ]},
      { title:'回复', rows:[
        { t:'sw', key:'thinking', label:'思考模式', hint:'回得慢但更稳' },
        /*
         * ⚠️ 这一行是给「不用 DeepSeek」的人的：thinking / reasoning_effort
         *    是 DeepSeek 私有字段，往别家发有的服务会直接 400。
         *    默认 auto：地址里带 deepseek 才发。
         */
        { t:'sel', key:'thinkingStyle', label:'思考参数', opts:[
          ['always','一直发'],
          ['auto','看地址决定'],
          ['off','谁都不发'],
        ],
          /*
           * ⚠️ hint 要短 —— 左列只有 92px 宽（`.row .label`），
           *    实测一行约 7 个汉字。写「问的是要不要把 thinking / reasoning_effort
           *    发出去」那种长句会**挤成五行、把整行撑高一倍**（看图就知道多难看）。
           *    全面板的 hint 惯例是 24~33 字，这里跟着走。
           *    详细解释放「高级」页，别堆在这行上。
           */
          hint:'别的服务可能不认这俩，本地模型选「谁都不发」' },
        // ⚠️ 思考模式开着时温度不生效 —— 旧工程干脆不发这个参数，
        //    所以这一行要标出来，不然他会以为滑块坏了
        R('temperature','发散度', 0, 2, 0.05, v => v.toFixed(2), '思考模式开着时这项无效'),
        { t:'sel', key:'thinkingDepth', label:'思考深度',
          opts:[['low','浅'],['medium','中'],['high','深']] },
      ]},
      { title:'联网', rows:[
        /*
         * ⚠️ 联网**只走 Anthropic 兼容端点**（`<接口地址>/anthropic/v1/messages`），
         *    因为 OpenAI 那套的 `tools=[{type:'web_search'}]` 会被服务端**静默忽略** ——
         *    返回 200、一次都没搜、模型拿旧知识编答案。他为此被骗过一整天。
         *    详见 core/websearch.cjs 顶上那段。
         */
        { t:'sw', key:'webEnabled', label:'联网查资料',
          hint:'他问新鲜事的时候她真去网上查一次' },
        R('webMaxUses','最多搜几次', 1, 6, 1, v => v + ' 次', '单次让服务端搜几次'),
        // ⚠️ 0 = 不限。拦太死会在真需要的时候查不到；20 次/天对日常够用
        R('webMaxPerDay','每天上限', 0, 100, 5, v => v === 0 ? '不限' : v + ' 次'),
        { t:'text', key:'webApiUrl', label:'联网地址',
          ph:'留空＝按接口地址拼 /anthropic/v1/messages',
          hint:'换服务商时可能要单独指一个' },
        N('webTimeoutSeconds','超时', 1, '等多久算超时（秒）'),
        N('webMaxOutputTokens','最长回复', 50, '查回来的答案最多多少 token'),
      ]},
      { title:'识屏', rows:[
        /*
         * ⚠️ **默认关**。这条会**把他的屏幕截图发出去** ——
         *    第一次该由他亲手打开，不该装完就偷偷发。他 2026-10-13 拍板的。
         */
        { t:'sw', key:'screenEnabled', label:'看她屏幕',
          hint:'她隔一阵偷看一眼你在干嘛，然后说一句' },
        /*
         * ★ **「时间可设」是他明确要求的那一条**。
         *   `screenEveryMinutes` 就是这个间隔。
         */
        R('screenEveryMinutes','多久看一次', 1, 120, 1, v => v + ' 分钟',
          '白天按这个来；深夜会乘倍率变安静'),
        R('screenMaxPerDay','每天最多', 0, 100, 5, v => v === 0 ? '不限' : v + ' 次',
          '0 = 不限'),
        // ⚠️ 深夜那一档默认 ×3 —— 12 分钟变 36 分钟，别半夜老盯他
        R('screenNightFactor','深夜倍率', 0.5, 10, 0.5, v => '×' + v,
          '乘在上面的间隔上（默认 ×3）'),
        { t:'sel', key:'screenCapture', label:'抓屏方式', opts:[
          ['auto','自动'],
          ['desktopCapturer','Electron'],
          ['gdi','GDI'],
        ], hint:'自动＝先试 Electron 再退 GDI（两条都抓得到全屏游戏）' },
        { t:'text', key:'screenModel', label:'看图用模型',
          ph:'留空＝跟主模型一样',
          hint:'⚠️ 要支持视觉的模型，不然她"看不见"还不报错' },
        { t:'sw', key:'screenUseForeground', label:'带上窗口名',
          hint:'不截图也知道你在用什么程序' },
        { t:'sw', key:'screenAvoidRepeat', label:'画面没变就不说',
          hint:'你一直盯着同一页时她不会反复念叨' },
      ]},
      // ★ 「记忆与情绪」这块 2026-10-12 搬到「高级」页去了（他要求的）
      { title:'用量与成本', rows:[
        { t:'custom', key:'usageStats' },
        // ⚠️ 他明确要求过：「数值滑块改为输入框」—— 单价是要精确填的数，
        //    滑块一格 0.1 拖不出 2.37 这种值。
        { t:'seg', key:'currency', label:'货币',
          opts:[['cny','¥ 人民币'],['usd','$ 美元']],
          hint:'只换显示，不改账单' },
        /*
         * ⚠️ 单价这三项**永远按人民币填** —— 官方是按 ¥ 扣款的，
         *    存进去的就是账单口径那个数。切到 $ 时上面的统计卡会自己换算，
         *    这里故意不跟着换：跟着换就得在「用户输入」和「存储」之间来回
         *    乘除一次汇率，四舍五入几轮数字就飘了。
         */
        N('priceIn','输入单价', 0.01, '人民币 / 每百万 token'),
        N('priceOut','输出单价', 0.01, '人民币 / 每百万 token'),
        N('priceCacheHit','缓存命中价', 0.01, '人民币，命中的那部分便宜很多'),
        N('usdRate','汇率', 0.01, '一刀换多少人民币（切 $ 时才用）'),
        { t:'sw', key:'spendAlert', label:'花超了提醒我' },
        N('spendLimit','每月上限', 1, '到了这个数提醒你'),
      ]},
    ],
  },
  {
    k:'adv', icon:'gear', name:'高级', title:'高级',
    desc:'调试用的，一般不用动。',
    groups:[
      { title:'性能', rows:[
        R('fpsLimit','帧率上限', 0, 144, 5, v => v ? v + ' fps' : '跟随屏幕'),
      ]},
      /*
       * ★ 这两块是 2026-10-12 从「习惯」页搬过来的（他要求的）。
       *   搬的理由：它们都是**调试/微调**向的东西，平时不该占「习惯」的位置。
       */
      { title:'说话', rows:[
        { t:'sw', key:'typewriter', label:'打字机效果', hint:'一个字一个字蹦出来' },
        /*
         * ⚠️ 这里原来有一行「主动开口（talkChance）」—— **2026-10-13 删了**。
         *    他 2026-10-08 第 34 轮砍到点提醒的时候就定了：那个"随口提一句"
         *    要归**心跳自选**（看着你在干什么自己判断该不该说），
         *    不是按概率定时开口。心跳自选还没做，所以这行从来没生效过。
         *    2026-10-13 问他要恢复还是删，他选**删**。
         *    ⇒ 别再加回来；要加就等识屏接上，走「心跳自选」那条路。
         */
        { t:'sw', key:'typo', label:'偶尔打错字', hint:'像真人那样，打完自己改（只改气泡上显示的字）' },
        { t:'range', key:'typoRate', label:'错字频率', min:1, max:30, step:1,
          fmt:v => v + '%' },
      ]},
      { title:'画面', rows:[
        R('gridN','网格精度', 2, 12, 1, v => v + ' 格', '越高形变越顺，越吃性能'),
        R('meshK','形变强度', 0, 4, 0.05, v => v.toFixed(2)),
        R('hairK','头发甩动', 0, 6, 0.1, v => v.toFixed(1)),
        /*
         * 整体倾斜角 —— 他 2026-10-12 要的（原来只在调试台里有）。
         * ⚠️ 它是**偏移量**：叠在每个姿态自己的基础值上
         *    （待机 -2 / 走路 1 / 坐姿 -6，见 rig.json 的 presets）。
         *    所以这里写 0 不等于「她站得笔直」，而是「各姿态按各自的基础值来」。
         *    hint 要短 —— 左列只有 92px 宽（一行约 7 个汉字），超了会把整行撑高。
         */
        /*
         * ★ 每个姿态各自的倾斜角（他 2026-10-12 晚改的口径：
         *   「桌宠的倾斜角配置项改为每个状态单独调整」）。
         *
         * ⚠️ 这 5 个**不走 config**，走的是 `rig.json` 的 presets
         *    （那个文件本来就是"每个姿态那套参数"的唯一真源，
         *      另存一份到 config 必然两边对不上）。见 core/rigparams.cjs。
         * ⚠️ 所以用 `custom` 行 + 在 showPage 里挂载，不能用普通的 `R(...)` ——
         *    普通的 R 走的是 `ctx.set(key, val)` → 写 config。
         */
        { t:'custom', key:'tiltPoses', label:'倾斜角',
          hint:'每个姿态各自的（正值往后倒）' },
        { t:'sel', key:'breathStyle', label:'呼吸', opts:[
          ['squash','上下 Q 弹（脚不动）'],
          ['shift','整体上下平移'],
        ]},
        { t:'sel', key:'smoothQuality', label:'缩小画质', opts:[
          ['high','清晰（推荐）'],
          ['low','快，但小尺寸会出锯齿'],
        ]},
        R('transitionMs','站坐过渡', 0, 900, 20, v => v ? v + ' ms' : '关（硬切）',
          '坐下/站起来那一瞬间的挤压展开，0 = 直接换'),
      ]},
      // ★ 这块 2026-10-12 从「AI 接入」页搬过来（他要求的）
      { title:'记忆与情绪', rows:[
        { t:'sw', key:'memShort', label:'短期记忆' },
        R('memShortCount','记住几条', 5, 100, 1, v => v + ' 条'),
        { t:'sw', key:'memLong', label:'长期记忆' },
        { t:'sw', key:'mood', label:'情绪' },
      ]},
      { title:'日志与备份', rows:[
        // ⚠️ `logLevel` **不是**待接 —— `core/log.cjs` 一直在读它。
        //    它原来挂着 `todo:true` 是标错了（那会儿还没接日志）。2026-10-12 摘掉。
        { t:'sel', key:'logLevel', label:'日志级别',
          opts:[['error','只记错误'],['info','常规'],['debug','全部']] },
        // ★ 备份（2026-10-12 落地）：聊天记录/日志每天、记忆每周
        { t:'sw', key:'backupDaily', label:'每日备份',
          hint:'聊天记录和日志：每天一次，按年月归档' },
        { t:'sw', key:'backupWeeklyMemory', label:'每周备份记忆',
          hint:'人格+习惯+心事+状态：每周打包一份' },
        { t:'text', key:'backupDir', label:'备份位置',
          hint:'相对路径搁在她家里；也可以填绝对路径挪到别的盘' },
        { t:'btn', label:'备份文件夹', text:'打开备份文件夹', act:(a) => a.revealBackup?.() },
      ]},
      { title:'配置文件', rows:[
        { t:'custom', key:'cfgPath' },
        { t:'btn', label:'恢复默认', text:'全部恢复默认', act:(a) => a.reset() },
      ]},
      /*
       * ⚠️ 这一组是**他 2026-10-13 要的**：「在高级选项最下面加一个小按钮，最好是不起眼」。
       *    所以它是整个面板的**最后一行**，按钮走 `.btn.quiet`（灰的，没有强调色）。
       *    它干什么用、怎么退出，见 ui/design.js 的文件头。
       */
      { title:'界面调试', devOnly:true, rows:[
        { t:'custom', key:'designEntry' },
      ]},
    ],
  },
];

/* ============================================================
   分组覆盖表 —— 界面调试台搬动分组用
   ============================================================
   ⚠️ `PAGES` 是**静态数据**，分组搬走了不该改它本身（改了就没法"还原"）。
      所以调试台把"哪些组搬到哪儿"记在这个 Map 里，
      `showPage` 渲染时拿它和 PAGES 合并 —— 撤回只要把键删掉。

   键 = 页面 key（'habit' / 'ai' / ...），值 = 该页**完整的**分组数组。

   ⚠️ 这个 Map 是**模块级**的：调试台搬完东西会调 `showPage` 重画，
      重画时数据得还在。退出调试台时由 design.js 清空。
   ============================================================ */
const groupOverride = new Map();

/*
 * ★ 给每个分组发一张"身份证"（`__gid` = 原来在哪页 + 第几组）。
 *
 * 为什么需要：调试台要能把组搬到别页去，那就得**认得出"这是同一个组"** ——
 *   它搬到新页面之后，在数组里的下标会变、前后邻居也变了，
 *   只有这个 id 是跟着它走的。还原的时候也靠它找回原位。
 *
 * ⚠️ 是**原地改 PAGES 对象**（加一个字符串字段），不是深拷贝 ——
 *   PAGES 里那些 `rows` 里的函数引用（`act: (a) => a.reset()`）深拷会丢语义。
 */
for (const p of PAGES) {
  p.groups.forEach((g, i) => { if (!g.__gid) g.__gid = p.k + '#' + i; });
}

export function setGroupOverride(map) { groupOverride.clear(); if (map) for (const [k, v] of map) groupOverride.set(k, v); }
export function getGroupOverride() { return groupOverride; }

/**
 * ★ 给调试台用的两个口：
 *   `PAGES_FOR_DESIGN()` —— 拿原始页面结构（它按 `__gid` 找"这个组本来在哪一页"）
 *   `ALL_GROUPS()`       —— 把所有组摊平成一张表，调试台搬动分组时按 id 取原件
 *
 * ⚠️ 返回的是**原件不是副本** —— 搬动只改 `groupOverride` 那个 Map，
 *    PAGES 本身一个字都不动，所以「还原」永远有得可还原。
 */
export const PAGES_FOR_DESIGN = () => PAGES;
export function ALL_GROUPS() {
  const byId = new Map();
  for (const p of PAGES) for (const g of p.groups) byId.set(g.__gid, { page: p.k, group: g });
  return byId;
}

/**
 * 调试台把某个自定义行搬到别的页之后，原来"按页挂载"的逻辑就找不着它了。
 * 这张表按**标记**找，跟在哪一页无关。
 *
 * ⚠️ 别删——`lang` 那几个是老代码留下来没用的（`if (el)` 会跳过），
 *    留着是为了以后真要加时有个现成位置。
 */
const MOUNTS = {
  usageStats: (el) => mountUsage(el),
  aiDebug: (el) => mountAiDebug(el),
  weatherTest: (el) => mountWeatherTest(el),
  cfgPath: (el) => mountCfgPath(el),
  designEntry: (el) => mountDesignEntry(el),
  tiltPoses: (el) => mountTiltPoses(el),
  fontPick: (el) => mountFontPick(el),
  lang: () => { /* 语言那一行一直是占位，从来没有实现 */ },
};

/** 把某一页里所有 `t:'custom'` 的行挂上——**按标记找，跟页面无关** */
function mountCustoms(root) {
  for (const el of root.querySelectorAll('[data-custom]')) {
    const fn = MOUNTS[el.dataset.custom];
    if (fn) { try { fn(el); } catch (err) { console.error('[设置] 挂载 ' + el.dataset.custom + ' 失败：' + err.message); } }
  }
}

/* ============================================================
   造 DOM
   ============================================================ */

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));

function rowEl(row, ctx) {
  const d = document.createElement('div');
  d.className = 'row';

  if (row.t === 'custom') {
    /*
     * ⚠️ `label` 要给**整列的样式**（.row .label 是固定 92px 宽），
     *    不能只塞个字符串进去 —— 原来这里写 `row.label || ''`，
     *    连 `<div class="label">` 都没给，所以他看到左边那一栏是空的。
     */
    d.innerHTML = `<div class="label">${esc(row.label || '')}`
                + (row.hint ? `<small>${esc(row.hint)}</small>` : '')
                + '</div><div class="body" data-custom="' + esc(row.key) + '"></div>';
    return d;
  }

  const label = row.label
    ? `<div class="label">${esc(row.label)}`
      + (row.todo ? '<i class="todo">待接</i>' : '')
      + (row.hint ? `<small>${esc(row.hint)}</small>` : '')
      + '</div>'
    : '';
  d.innerHTML = `${label}<div class="body"></div>`;
  const body = d.querySelector('.body');
  const v = ctx.cfg()[row.key];

  switch (row.t) {
    case 'sw': {
      const sw = document.createElement('span');
      sw.className = 'sw' + (v ? ' on' : '');     // ★ on 要加在开关自己身上，不是行上
      sw.onclick = () => { sw.classList.toggle('on'); ctx.set(row.key, sw.classList.contains('on')); };
      body.appendChild(sw);
      break;
    }

    case 'seg': {
      const seg = document.createElement('div');
      seg.className = 'seg';
      for (const [val, txt] of row.opts) {
        const b = document.createElement('button');
        b.textContent = txt;
        if (String(v) === String(val)) b.classList.add('on');
        b.onclick = () => {
          seg.querySelectorAll('button').forEach(x => x.classList.remove('on'));
          b.classList.add('on');
          ctx.set(row.key, val);
        };
        seg.appendChild(b);
      }
      body.appendChild(seg);
      break;
    }

    /*
     * 数字输入框 —— 他明确要求「数值滑块改为输入框」的那几项用这个。
     * ⚠️ 用 `change` 不用 `input`：`input` 每敲一个字符就写一次配置，
     *    他输入「2.37」的中间态「2」「2.」都会被当成真值存进去，
     *    面板上别的地方（用量那块的单价）会跟着跳。
     */
    case 'num': {
      const wrap = document.createElement('div');
      wrap.className = 'cwrap';

      const inp = document.createElement('input');
      inp.type = 'number';
      inp.className = 'num-in';
      inp.step = String(row.step ?? 0.01);
      inp.min = '0';
      inp.value = v ?? 0;
      inp.onchange = async () => {
        const n = Number(inp.value);
        if (!Number.isFinite(n) || n < 0) { inp.value = ctx.cfg()[row.key] ?? 0; return; }
        await ctx.set(row.key, n);
      };
      wrap.appendChild(inp);

      const sym = document.createElement('span');
      sym.className = 'hex';
      sym.textContent = row.fmt ? row.fmt(v) : '';
      wrap.appendChild(sym);

      body.appendChild(wrap);
      break;
    }

    /*
     * 主题色 —— 预设色卡 + 调色盘。
     *
     * ⚠️ 预设色不是随便挑的，是**从她立绘上取的**（他说的「就用桌宠的主题色就行」）：
     *    头发、发梢、和服、裙子、章鱼、发饰。这样配色跟人物是一套，
     *    不会出现「面板蓝、人物粉」那种割裂。
     * ⚠️ 调色盘的 <input type=color> 是原生控件，`oninput` 边拖边生效 ——
     *    用 `onchange` 要松手才变，调的时候看不到效果。
     */
    case 'colors': {
      const wrap = document.createElement('div');
      wrap.className = 'cwrap';

      const box = document.createElement('div');
      box.className = 'swatches';

      const mark = () => {
        for (const s of box.children) {
          s.classList.toggle('on', String(s.dataset.c).toLowerCase() === String(ctx.cfg()[row.key]).toLowerCase());
          s.style.color = s.dataset.c;      // ‹on› 那圈描边用 currentColor
        }
        hex.textContent = ctx.cfg()[row.key] || '';
      };

      for (const [c, name] of PRESET_COLORS) {
        const s = document.createElement('div');
        s.className = 'swatch';
        s.dataset.c = c;
        s.style.background = c;
        s.title = name;
        s.onclick = async () => { await ctx.set(row.key, c); mark(); };
        box.appendChild(s);
      }
      wrap.appendChild(box);

      const picker = document.createElement('input');
      picker.type = 'color';
      picker.value = /^#[0-9a-f]{6}$/i.test(v) ? v : '#0A7EA4';
      picker.title = '自己调一个';
      picker.oninput = async () => { await ctx.set(row.key, picker.value); mark(); };
      wrap.appendChild(picker);

      const hex = document.createElement('span');
      hex.className = 'hex';
      wrap.appendChild(hex);

      body.appendChild(wrap);
      mark();
      break;
    }

    case 'range': {
      const sl = document.createElement('input');
      sl.type = 'range'; sl.min = row.min; sl.max = row.max; sl.step = row.step;
      sl.value = v ?? row.min;
      const out = document.createElement('span');
      out.className = 'val';
      const show = () => out.textContent = row.fmt(Number(sl.value));
      show();
      sl.oninput = show;
      // 拖动时一直写会把磁盘刷爆 —— 松手才落盘，中途只改显示
      sl.onchange = () => ctx.set(row.key, Number(sl.value));
      body.append(sl, out);
      break;
    }

    case 'text': case 'key': {
      const inp = document.createElement('input');
      inp.type = row.t === 'key' ? 'password' : 'text';
      inp.value = v ?? '';
      inp.placeholder = row.ph || '';
      inp.onchange = () => ctx.set(row.key, inp.value.trim());
      /*
       * 可选的下拉候选（原生 <datalist>）。
       * 「模型」那一行用它 —— 候选由「检测模型」现问出来，
       * 但**仍然可以手打**（自建服务未必给 /models）。
       * ⚠️ datalist 的 id 要全局唯一，同时挂在 #pMain 里，
       *    页面重画（showPage）会连它一起换掉，所以取值时现查不缓存。
       */
      if (row.list) {
        inp.setAttribute('list', row.list);
        inp.autocomplete = 'off';
      }
      body.appendChild(inp);
      break;
    }

    case 'color': {
      const inp = document.createElement('input');
      inp.type = 'color'; inp.value = v || '#000000';
      inp.className = 'colorin';
      inp.onchange = () => ctx.set(row.key, inp.value);
      const code = document.createElement('span');
      code.className = 'val'; code.style.minWidth = '70px'; code.textContent = v;
      inp.onchange = () => { code.textContent = inp.value; ctx.set(row.key, inp.value); };
      body.append(inp, code);
      break;
    }

    case 'sel': {
      /*
       * ⚠️ 原来是原生 `<select>` —— 它点开之后那张**白底蓝高亮的菜单是
       *    Chromium 自己画的**，css 一行都碰不到，跟面板风格完全对不上
       *    （他 2026-10-12 贴了截图）。现在换成自绘的下拉浮层。
       */
      body.appendChild(selRow(row.opts, v, (val) => ctx.set(row.key, val)));
      break;
    }

    case 'btn': {
      const b = document.createElement('button');
      b.className = 'btn' + (row.cls ? ' ' + row.cls : '');
      b.textContent = row.text;
      b.onclick = () => row.act(ctx);
      body.appendChild(b);
      break;
    }
  }
  return d;
}

/**
 * 用量统计卡的重画入口。
 * ⚠️ 不在这儿 `window.yachiyo.on('cfg:changed')` —— preload 的 on 没有 off，
 *    showPage 每进一次 AI 页就挂一个，切十次就是十个监听器。
 *    走 initSettings 传给 makeHost 的那个 onChange 回调，天生只有一份。
 */
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
let _booted = false;
export function bootSettings() {
  if (_booted) return;
  _booted = true;
  initSettings();
}

export function initSettings() {
  /*
   * ⚠️ 这个页面现在是一个**独立的小窗口**（panel.html），不再长在主窗口里。
   *    所以宿主自己建，而不是等 app.js 传进来 —— 主窗口那边已经没有它的
   *    任何引用了。菜单 / 聊天窗同理，三页共用 ui/host.js。
   */
  api = makeHost((k) => {
    // 主题/强调色变了 → 整页重画（样式变量是内联的，不重画会有一半是旧的）
    if (k === 'theme' || k === 'accent') { showPage(curPage); return; }
    // ¥/$ 和汇率变了 → 只重画用量卡上的金额（其余一个字不用动）
    if (k === 'currency' || k === 'usdRate') { usagePaint?.(); return; }
    /*
     * 模型名是从别处改的 → 把「模型」那一行的输入框同步过来。
     * ⚠️ 不能 `showPage('ai')` 重画整页 —— 那样刚检测出来的模型清单就被抹了。
     *    只动那一个 input。
     */
    if (k === 'model') syncModelInput();
  });

  // 主进程开这个窗口时会把 state 推过来（比如「直接开 AI 接入那一页」）
  window.yachiyo.on('ov:open', (st) => { if (st && st.page) showPage(st.page); });
  const navs = document.getElementById('navs');
  navs.innerHTML = '';

  for (const p of PAGES) {
    const n = document.createElement('div');
    n.className = 'nav' + (p.k === curPage ? ' on' : '');
    n.dataset.k = p.k;
    n.innerHTML = svg(p.icon, 16) + `<span>${p.name}</span>`;
    n.onclick = () => showPage(p.k);
    navs.appendChild(n);
  }

  document.getElementById('pMin').innerHTML  = svg('min', 15);
  document.getElementById('pClose').innerHTML = svg('close', 15);
  document.getElementById('pClose').onclick = () => closePanel();
  document.getElementById('pMin').onclick   = () => closePanel();

  showPage(curPage);
}

bootSettings();

export function showPage(k) {
  const p = PAGES.find(x => x.k === k) || PAGES[0];
  curPage = p.k;

  /*
   * ⚠️ 整页要重画了 —— 先把还开着的那张下拉浮层收掉。
   *    浮层挂在 `.card` 上，**不在 #pMain 里**，下面那句 `innerHTML = …`
   *    抹不到它 ⇒ 不收掉就会有一张孤儿卡片浮在新页面上（还点不掉）。
   */
  closeSelectPop();

  document.querySelectorAll('#navs .nav').forEach(n =>
    n.classList.toggle('on', n.dataset.k === p.k));

  const ctx = {
    cfg: api.cfg,
    set: (key, val) => api.setCfg(key, val),
    reset: () => api.reset(),
    /**
     * 在资源管理器里打开备份文件夹。
     * ⚠️ 主进程那边**只认白名单里的几个目录、而且必须在 cfg.DIR 底下** ——
     *    `shell.openPath` 能打开任意路径，不设闸等于把整台机器递出去。
     */
    revealBackup: () => window.yachiyo.win.reveal('backup'),
  };

  const main = document.getElementById('pMain');
  main.scrollTop = 0;
  main.innerHTML = `<h2>${esc(p.title)}</h2><div class="desc">${esc(p.desc)}</div>`;

  /*
   * ⚠️ 分组列表**可能被调试台改过**（他把某个组搬到别页去了）——
   *    所以先看覆盖表，没有才用 PAGES 里写死的。见上面 groupOverride 那段。
   */
  const groups = groupOverride.get(p.k) || p.groups;

  for (const g of groups) {
    /*
     * ⚠️ 标了 `devOnly` 的组**正式版整组不画** —— 连那个框带标题一起。
     *    我第一版只在行里判断（`mountDesignEntry` 里 `if (!DEV) return`），
     *    结果正式版里留下一个**只有标题的空框**：「界面调试」四个字照样露出来。
     *    探针（probe-packaged.cjs 第 ④ 组）当场抓到的。
     */
    if (g.devOnly && !DEV()) continue;
    const box = document.createElement('div');
    box.className = 'group';
    // 调试台靠这个认人（拖拽时要知道拖的是哪个组、松手时往哪儿插）
    if (g.__gid) box.dataset.dgroup = g.__gid;
    if (g.title) box.innerHTML = `<div class="g-title">${esc(g.title)}</div>`;
    for (const row of g.rows) box.appendChild(rowEl(row, ctx));
    main.appendChild(box);
  }

  /*
   * ★ 自定义行的挂载**按标记找，不再按页面找**。
   *
   * ⚠️ 原来这里是 `if (p.k === 'ai') { … }` 一串 —— 那种写法跟"这个自定义项在哪一页"
   *    绑死了：调试台一旦把「联网」组从 AI 页搬到高级页，里面若有自定义项就没人挂。
   *    改成按 `data-custom` 标记找，**搬到哪儿都自动跟上**。
   */
  mountCustoms(main);

  /*
   * 调试台把这一页的组**全搬走了** → 留个话，别让他以为是面板坏了。
   * 只在调试态显示（`showPage` 每次都整片重建 innerHTML，所以不存在"重复加"）。
   */
  if (!main.querySelector('.group') && document.querySelector('.card.d-on')) {
    const tip = document.createElement('div');
    tip.className = 'd-empty';
    tip.textContent = '（这一页的组都搬走了 —— 用左栏的下拉搬回来，或点「还原」）';
    main.appendChild(tip);
  }
}

/**
 * 切到某一页。
 *
 * ⚠️ 这里**不管窗口显隐** —— 那归主进程（overlay.cjs）。
 *    原来这个函数还顺手做了两件事：
 *      · `#panel` 加 `.open` —— 那是「卡片从她旁边弹出来」的动画，现在整页
 *        就是卡片，没得弹
 *      · `win.focusable(true)` —— 因为面板当时跟她在**同一个窗口**里，而那个
 *        窗口平时 focusable:false（免得抢他打游戏的按键）。面板现在是独立
 *        窗口，天生就收键盘，不用再动主窗口
 */
export function openPanel(page) {
  if (page) showPage(page);
}

/** 关掉自己这个窗口（其实是 hide，主进程复用） */
export function closePanel() {
  try { window.yachiyo.ov.close(); } catch { /* 桥没接上就算了 */ }
}

/**
 * 只是个占位 —— **窗口显隐现在归主进程管**（overlay.isOpen('panel')），
 * 这个页面自己问不出来。
 * ⚠️ 删掉它会把 main/index.cjs 里 import 的那几处一起打断，所以留着。
 */
export const panelOpen = () => false;
