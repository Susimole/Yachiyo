/**
 * 设置面板的**页面描述**（纯数据，没有一个 DOM 操作）。
 *
 * 2026-10-20 从 `settings.js` 搬出来的（那个文件 1,661 行，洗澡 ⑥ 第一刀）：
 * 这里只描述"哪一页、哪一组、哪一行长什么样"，怎么画在 `settings.js` 的 `rowEl` 里。
 * 加一个设置项 = 在这个文件里加一行，别的地方不用动。
 *
 * ⚠️ 全是字面量数据 + `R()` / `N()` 两个小工厂 —— **别往这里塞 DOM / 网络 / 定时器**，
 *    它必须能在任何时机被安全 import（界面调试台也会拿它做 diff）。
 */

/* ── 两个小工厂 ───────────────────────────── */
export const R = (key, label, min, max, step, fmt, hint) =>
  ({ t:'range', key, label, min, max, step, fmt, hint });

/**
 * 预设主题色 —— **从她立绘上取的**，不是随便挑的色板。
 * 这样面板的配色跟人物本身是一套，不会出现「面板蓝、人物粉」那种割裂。
 * 顺序：默认 → 发梢/章鱼 → 裙子 → 和服 → 头发 → 发饰
 */
/** 数字输入框（不是滑块）—— 单价这种要精确填的数，滑块拖不准 */
export const N = (key, label, step, hint) =>
  ({ t:'num', key, label, step: step || 0.01, hint });

/* ── 预设主题色（从她立绘上取的，不是随便挑的色板）─── */
export const PRESET_COLORS = [
  ['#0A7EA4', '海蓝（默认）'],
  ['#D96A8E', '桃粉 · 发梢和章鱼'],
  ['#2E9E8F', '青玉 · 裙子'],
  ['#2B3A6B', '藏青 · 和服'],
  ['#8A87B8', '月白 · 头发'],
  ['#C99A2E', '鎏金 · 发饰'],
];

/* ── 五个页面的全部行 ─────────────────────── */
export const PAGES = [
  {
    k:'habit', icon:'pulse', name:'习惯', title:'习惯',
    desc:'常规设置栏',
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
        { t:'seg', key:'theme', label:'日/夜间模式',
          opts:[['light','浅色'],['dark','深色']] },
        { t:'colors', key:'accent', label:'主题色',
          hint:'预设是从她立绘上取的；右边那颗可以自己调' },
        { t:'sw', key:'alwaysOnTop', label:'置顶', hint:'别被别的窗口盖住' },
        /*
         * ⚠️ 他 2026-10-12 说的：「音效大小可调滑块（**只在设置菜单中，不在右键菜单**）」。
         *    右键菜单是 244×250 的小窗，塞一根滑块进去太挤；那边只留「音效」开关。
         *    关掉音效时这一行没意义，但**不藏** —— 藏了会跳行，他调音量得先开音效。
         */
        R('soundVolume','互动音效音量', 0, 100, 5, v => v + '%'),
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
        { t:'seg', key:'roam', label:'行为习惯', hint:'更爱走还是更爱待着',
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
    desc:'气泡参数调整栏',
    groups:[
      { title:'位置', rows:[
        { t:'seg', key:'bubbleAnchor', label:'气泡固定点', hint:'气泡挂在她哪个角',
          opts:[['tl','左上'],['tr','右上'],['bl','左下'],['br','右下']] },
        /*
         * ★ 位置微调（2026-10-17 他要求的：气泡位置可调）。
         *   他选的是「四角预设 + 偏移量」—— 工作量小、bug 少。
         *   ⚠️ 偏移在 `ui/bubble.js` 的 `place()` 里是**加在窗口 clamp 之前**的，
         *      所以往窗口外推会被夹回来，这是刻意的（不让她把气泡挪到看不见的地方）。
         */
        R('bubbleOffX','左右偏移', -300, 300, 1, v => (v > 0 ? '+' : '') + v + 'px'),
        R('bubbleOffY','上下偏移', -300, 300, 1, v => (v > 0 ? '+' : '') + v + 'px'),
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
        R('bubbleSeconds','滞留时长', 2, 60, 1, v => v + ' 秒'),
      ]},
    ],
  },
  {
    k:'weather', icon:'sun', name:'天气', title:'天气',
    desc:'天气接口栏，数据来自中国天气网',
    groups:[
      { title:'城市', rows:[
        { t:'text', key:'city', label:'城市', ph:'湖南省郴州市',
          hint:'要带省名，建议格式「省-市-区」' },
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
    desc:'AI接口、消耗查询以及部分参数设置栏，默认预设DeepSeek',
    groups:[
      { title:'连接', rows:[
        /*
         * ★ 服务商预设那一排 chip（2026-10-17 加的，稿子见 留痕\稿子-批次C\）。
         *
         *   每个平台**各自存一份**地址/Key/模型；切换 = 把那份**写回 config**
         *   （见 core/providers.cjs 顶上那段 —— 就因为这个设计，
         *    provider/peeker/profile/websearch 那些读 config 的模块一行都不用改）。
         *
         *   ⚠️ 它是 `custom` 行，**下面那三行（地址/模型/Key）一个字没动** ——
         *      这样 R() 里那套「输入框 oninput → cfg.set」的现成机制照旧管用，
         *      不用给它们另写一套保存逻辑。
         */
        { t:'custom', key:'providerPick', label:'服务商' },
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
        { t:'sw', key:'thinking', label:'思考模式', hint:'' },
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
          hint:'默认根据地址决定，本地模型选「谁都不发」' },
        // ⚠️ 思考模式开着时温度不生效 —— 旧工程干脆不发这个参数，
        //    所以这一行要标出来，不然他会以为滑块坏了
        R('temperature','发散度', 0, 2, 0.05, v => v.toFixed(2), '思考模式开着时这项无效；如要开启建议0.6~1.0'),
        { t:'sel', key:'thinkingDepth', label:'思考强度',
          opts:[['low','浅'],['medium','中'],['high','深']] },
      ]},
      { title:'识屏', rows:[
        /*
         * ⚠️ **默认关**。这条会**把他的屏幕截图发出去** ——
         *    第一次该由他亲手打开，不该装完就偷偷发。他 2026-10-13 拍板的。
         */
        { t:'sw', key:'screenEnabled', label:'AI识屏',
          hint:'' },
        /*
         * ★ **「时间可设」是他明确要求的那一条**。
         *   `screenEveryMinutes` 就是这个间隔。
         */
        R('screenEveryMinutes','识屏间隔', 1, 120, 1, v => v + ' 分钟',
          ''),
        R('screenMaxPerDay','识屏上限', 0, 100, 5, v => v === 0 ? '不限' : v + ' 次',
          '每日'),
        // ⚠️ 深夜那一档默认 ×3 —— 12 分钟变 36 分钟，别半夜老盯他
        R('screenNightFactor','深夜降频', 0.5, 10, 0.5, v => '×' + v,
          ''),
        { t:'sel', key:'screenCapture', label:'识屏方式', opts:[
          ['auto','自动'],
          ['desktopCapturer','Electron'],
          ['gdi','GDI'],
        ], hint:'建议自动' },
        /*
         * ★★ 2026-10-20：**识图那三格删了**（他拍板），连同后来加的「视觉模块」提示行
         *   也一起撤了（他当晚要求：「去除设置中的『视觉模块』那一条」）。
         *
         *   识图从此跟对话模型走（`apiBase` / `apiKey` / `model`），没有第二套连接。
         *   为什么删：那三格是 2026-10-18 为了"填了 Kimi 也不炸"加的补丁，
         *   结果自己长出新的病 —— `peeker` 只认模型名不认地址，同一个 400
         *   换了个地方重演。**两套能各说各话的连接，就是这类 bug 的土壤。**
         *
         *   看不了图时她会在对话里直接说「当前对话模型不具备视觉模块」，
         *   不再靠在设置页里提示 —— 那句话该出现在**说话的地方**，不是设置里。
         */
        { t:'sw', key:'screenUseForeground', label:'进程识别',
          hint:'不截图她也能知道你在干什么' },
        { t:'sw', key:'screenAvoidRepeat', label:'静置静默',
          hint:'识屏检测画面无变动则不会说话' },
      ]},
      // ★ 「记忆与情绪」这块 2026-10-12 搬到「高级」页去了（他要求的）
      { title:'用量与成本', rows:[
        /*
         * ★ 花费走势图（2026-10-17 加的）。
         *   粒度是他定的：日 = 近 **24 小时**（按小时）· 周 = 近 **7 天** · 月 = 近 **30 天**。
         *   数据来自账本新加的两个桶（见 core/usage.cjs 的 hourly / daily + series()）。
         * ⚠️ 放在统计卡**前面** —— 先看走势，再看那四个数字（稿子就是这么排的）。
         */
        { t:'custom', key:'usageChart' },
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
        { t:'sw', key:'spendAlert', label:'每月超额提醒' },
        N('spendLimit','每月上限', 1, '到了这个数提醒你'),
      ]},
    ],
  },
  {
    k:'adv', icon:'gear', name:'高级', title:'高级',
    desc:'调试用的，没事别动',
    groups:[
      /*
       * ★ 单击互动（2026-10-17 他要求：Q 弹动效的开关/时长/幅度放**高级**页）。
       * ⚠️ 三个参数都只影响 `#pet` 的 transform，不碰 rig 的步态/呼吸。
       */
      { title:'单击互动', rows:[
        { t:'sw', key:'clickBounce', label:'Q 弹动效', hint:'点她时压一下再弹回来' },
        R('clickBounceMs','弹多久', 120, 600, 10, v => v + ' ms'),
        R('clickBouncePct','弹多狠', 0, 15, 1, v => v + '%'),
      ]},
      /*
       * ★ 打游戏时（2026-10-17 他要求的：游戏时保持坐着，识屏和自言自语不变）。
       *   ⚠️ 检测方式是**全屏 + 进程**两条一起看，见 `core/gamedetect.cjs`。
       *      全屏放视频（浏览器/播放器）不算游戏 —— 那有默认排除名单，改 `gameExclude` 就行。
       *   ⚠️ 这里只给一个开关；排除名单在 config 里（`gameExclude`，null = 用默认表）。
       */
      { title:'打游戏时', rows:[
        { t:'sw', key:'gameDetect', label:'保持坐着',
          hint:'全屏游戏时她原地坐着，不乱走' },
      ]},
      { title:'性能', rows:[
        R('fpsLimit','帧率上限', 0, 144, 5, v => v ? v + ' fps' : '跟随屏幕'),
      ]},
      /*
       * ★ 这两块是 2026-10-12 从「习惯」页搬过来的（他要求的）。
       *   搬的理由：它们都是**调试/微调**向的东西，平时不该占「习惯」的位置。
       */
      { title:'说话', rows:[
        { t:'sw', key:'typewriter', label:'逐字输出', hint:'' },
        /*
         * ⚠️ 这里原来有一行「主动开口（talkChance）」—— **2026-10-13 删了**。
         *    他 2026-10-08 第 34 轮砍到点提醒的时候就定了：那个"随口提一句"
         *    要归**心跳自选**（看着你在干什么自己判断该不该说），
         *    不是按概率定时开口。心跳自选还没做，所以这行从来没生效过。
         *    2026-10-13 问他要恢复还是删，他选**删**。
         *    ⇒ 别再加回来；要加就等识屏接上，走「心跳自选」那条路。
         */
        { t:'sw', key:'typo', label:'偶尔错字', hint:'' },
        { t:'range', key:'typoRate', label:'错字概率', min:1, max:30, step:1,
          fmt:v => v + '%' },
      ]},
      { title:'画面', rows:[
        R('gridN','网格精度', 2, 12, 1, v => v + ' 格', '越高形变越顺，越吃性能'),
        R('meshK','形变强度', 0, 4, 0.05, v => v.toFixed(2)),
        R('hairK','头发甩动强度', 0, 6, 0.1, v => v.toFixed(1)),
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
        { t:'custom', key:'tiltPoses', label:'姿态倾斜角',
          hint:'每个姿态各自的（正值往后倒）' },
        { t:'sel', key:'breathStyle', label:'呼吸', opts:[
          ['squash','上下 Q 弹（脚不动）'],
          ['shift','整体上下平移'],
        ]},
        { t:'sel', key:'smoothQuality', label:'缩小方案', opts:[
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
        { t:'sel', key:'logLevel', label:'日志类型',
          opts:[['error','只记错误'],['info','常规'],['debug','全部']] },
        // ★ 备份（2026-10-12 落地）：聊天记录/日志每天、记忆每周
        { t:'sw', key:'backupDaily', label:'记录/日志备份',
          hint:'' },
        { t:'sw', key:'backupWeeklyMemory', label:'记忆每周备份',
          hint:'' },
        { t:'text', key:'backupDir', label:'备份位置',
          hint:'默认相对路径；也可以填绝对路径挪到别的盘' },
        { t:'btn', label:'备份文件夹', text:'打开备份文件夹', act:(a) => a.revealBackup?.() },
        /*
         * ★ 2026-10-20 加的。他报「在 Yachiyo 配置文件夹里没找到聊天记录文件」——
         *   因为聊天记录不在根目录，在 `data\` 子目录里（`chat.jsonl`），
         *   而页面上只有"打开备份文件夹"这一颗，没有任何东西指向 data。
         *   ⚠️ 主进程那条 `app:reveal` 早就支持 data / logs / config 三种，
         *      只是页面上没接 —— 所以这里**没有加新 IPC**，只是把现成的口子接出来。
         */
        { t:'btn', label:'数据文件夹', text:'打开数据文件夹（聊天记录在这）', act:(a) => a.revealData?.() },
      ]},
      { title:'联网', rows:[
        /*
         * ⚠️ 联网**只走 Anthropic 兼容端点**（`<接口地址>/anthropic/v1/messages`），
         *    因为 OpenAI 那套的 `tools=[{type:'web_search'}]` 会被服务端**静默忽略** ——
         *    返回 200、一次都没搜、模型拿旧知识编答案。他为此被骗过一整天。
         *    详见 core/websearch.cjs 顶上那段。
         */
        { t:'sw', key:'webEnabled', label:'AI联网',
          hint:'' },
        R('webMaxUses','单次搜索上限', 1, 6, 1, v => v + ' 次', ''),
        // ⚠️ 0 = 不限。拦太死会在真需要的时候查不到；20 次/天对日常够用
        R('webMaxPerDay','每日联网上限', 0, 100, 5, v => v === 0 ? '不限' : v + ' 次'),
        { t:'text', key:'webApiUrl', label:'联网地址',
          ph:'留空＝按接口地址拼 /anthropic/v1/messages',
          hint:'无联网功能的模型需配置' },
        N('webTimeoutSeconds','超时', 1, ''),
        N('webMaxOutputTokens','最大消耗', 50, '查回来的答案最多增加多少 token'),
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
