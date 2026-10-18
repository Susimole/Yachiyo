/**
 * 配置层 —— 所有可调项的唯一出处。
 *
 * 存 %APPDATA%\Yachiyo\config.json。
 *   文件不在 → 用默认值建一份
 *   读坏了   → 备份成 config.bad-<时间戳>.json 再重建，绝不让程序因为配置读不了而打不开
 * 只在主进程里用；渲染进程通过 preload 的 IPC 拿。
 *
 * ⚠️ 新增一项就只改这个文件（DEFAULTS 里加一行），别的地方都不用动。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');

/**
 * 配置放哪儿。
 *
 * ⚠️ `YACHIYO_HOME` 是给**自检和测试**用的：设了就整个换一个家，
 *    自己那份 config / 对话历史 / 账本都不会被碰到。
 *    加这个的直接原因 —— 自检要试「填假 Key 能不能聊」，不隔开就会
 *    把假 Key 写进他的真配置，而且自检还会改 petSize / 主题 / 置顶。
 */
const DIR  = process.env.YACHIYO_HOME
  ? path.resolve(process.env.YACHIYO_HOME)
  : path.join(ROOT, 'Yachiyo');
const FILE = path.join(DIR, 'config.json');
const DATA = path.join(DIR, 'data');

/**
 * 用户字体放这儿。
 *
 * ⚠️ 为什么不塞进 `src/renderer/assets/`：
 *    字体是有版权的（他给的那份内部名是 `ZXFYunYuan` v2.00），
 *    第 5 步要开源，**不能把一个来源不明的 ttf 打进仓库**。
 *    放用户目录里，程序能扫到、能用，仓库里干干净净。
 *    开源用户自己往这个目录丢 ttf 就能在设置里选到。
 */
const FONTS = path.join(DIR, 'fonts');

const DEFAULTS = {
  /* ---------- 窗口 / 外观 ---------- */
  petSize: 100,          // 5–300 %
  petX: null,            // null = 首次启动自己放右下角
  petY: null,
  /*
   * 浮层窗口（菜单 / 设置面板 / 聊天窗）上次摆在哪儿、多大。
   *
   * 形状：`{ menu: {x,y}, panel: {x,y,width,height}, chat: {...} }`
   * ⚠️ 它是**一个对象**，不是三个散键 —— 好处是加窗口类型不用再动配置表，
   *    而且 `cfg.set('winGeom', {...})` 一次写完，不会出现「存了 x 没存 y」那种半截状态。
   * ⚠️ 菜单**只存 x/y**：它的高度是按内容自动收的（见 overlay.cjs 的 fit()），
   *    存下来会把下一次的内容裁掉。
   * ⚠️ 恢复时会**夹回屏幕内** —— 不然外接屏拔掉之后，窗口会开在看不见的地方，
   *    用户以为「设置面板打不开了」。
   */
  winGeom: {},
  shadow: true,
  alwaysOnTop: true,
  petVisible: true,
  moveEnabled: true,

  /* ---------- 行为 ---------- */
  roam: 'normal',        // active | normal | quiet
  moveSpeed: 100,        // 20–300 %
  /*
   * 撞到屏幕边之后「歇着」多久（秒）。
   *
   * ⚠️ 2026-10-12 语义变了：原来是「先站住多久**再**回头」，现在是
   *    「回头**并且**歇着多久」—— 转身提前到撞上那一瞬间了（见 stepRoam）。
   *    键名没改，他调过的值继续生效。
   */
  edgePauseSeconds: 1.4,
  activity: 100,         // 20–300 %
  /*
   * 眼动跟随的「有效期」（秒）—— 只在他**刚跟她互动过**的这一段时间里，她才追鼠标。
   *
   * ⚠️ 2026-10-17 他报的：「桌宠眼动跟随是全局生效，改为互动点击互动后的 15 秒内
   *    可跟随（可配置时长）」。
   *
   *    原来那道闸只有 `rig.js` 里的 `canGaze`（「她歇着 + 鼠标在画面里」）——
   *    可主窗口是**整屏宽、贴屏幕底部的一条**（见 main/index.cjs 的 placeWindow），
   *    鼠标在那一条里随便哪儿动，她都在追。他手一挪到屏幕右下角，她的眼珠就跟着转，
   *    看着像被遥控；而且她本来只是自己在那儿站着，不该一直盯着鼠标看。
   *    ⇒ 现在再加一道：**互动过（按她/拖她/双击/右键她）之后的 N 秒内才跟**。
   *
   *    0 = 关掉跟随（她只看正前方）。
   */
  gazeFollowSec: 15,
  /*
   * ★ 单击互动的「Q 弹」动效（2026-10-17 他点名要的，参数放「高级」页）。
   *   `clickBounce`     开/关（怕他嫌它跳）
   *   `clickBounceMs`   时长，120–600ms
   *   `clickBouncePct`  幅度（%），0–15 —— 3 是"几乎看不出来"，10 以上就有点夸张了
   *   ⚠️ 只在他**主动点她**时触发：拖动、双击、睡着时被叫醒都不弹
   *      （拖动时整块缩放会跟"跟着鼠标走"打架；双击是要开聊天窗，不该先弹一下）。
   */
  clickBounce: true,
  clickBounceMs: 260,
  clickBouncePct: 6,
  /*
   * ★ 打游戏时保持坐着（2026-10-17 他定的：**全屏检测 + 进程检测**，「这样更准」）。
   *   `gameDetect`  开/关
   *   `gameExclude` 「就算全屏也不当游戏」的进程名（小写，前缀匹配）
   *                  ⚠️ `null` = 用 `core/gamedetect.cjs` 里的默认表
   *                     （浏览器、播放器、编辑器、远控……全屏放视频不该让她坐着）
   *   ⚠️ 只影响「她走不走动」。识屏和自言自语**不动** —— 那是他明确要求的。
   */
  gameDetect: true,
  gameExclude: null,

  /* ---------- 说话 ---------- */
  sound: true,
  /*
   * 音效音量 %。
   * ⚠️ 只在**设置面板**里有这一行，右键菜单里不放滑块 ——
   *    那是个 244×250 的小菜单，塞一根滑块进去太挤，而且他明确说了「只在设置菜单中」。
   */
  soundVolume: 70,
  /*
   * ⚠️ 这里原来有个 `talkChance: 35`（主动开口概率）—— **2026-10-13 删掉了**。
   *
   *    他 2026-10-08（第 34 轮）砍到点提醒那一批的时候就说过：
   *      「以后『随口提一句他还没吃饭』归**心跳自选 A 类**，
   *        由她自己判断该不该说（第 35 轮落地）」
   *    ⇒ 他要的是**看着情形自己决定**，不是"按定时器找你说话"。
   *      心跳自选没落地，所以这个键从来没被读过一个字节。
   *
   *    2026-10-13 我问他"恢复还是删掉"，他选**删**。理由跟我给的一致：
   *    按概率定时开口 = 他第 34 轮嫌吵砍掉的那个东西；
   *    他真想要的那个（看着你在干什么再决定）得等识屏 —— 那是后面的事。
   *
   *    ⚠️ **别再加回来**。要开口就等识屏接上，走「心跳自选」那条路。
   */
  /*
   * 口误（他 2026-09-26 点名要的「让 AI 偶尔打错字再纠正」）。
   *
   * ⚠️⚠️ **只改气泡上显示的字** —— 聊天记录 / 记忆 / 学习里永远是正确文本。
   *    她"手滑"是给人看的，不是真记错。规矩都钉在 `renderer/ui/typo.js` 顶上。
   * ⚠️ 只在 `typewriter: false`（打字机开着的情况）下才看得出来 ——
   *    打字机在逐字吐的时候那个错字会被后面的字盖掉，看着像闪了一下，
   *    所以 `startTypo` 是**整句说完之后**才下手的。
   */
  typo: true,
  typoRate: 5,           // 每条回复有几个点会磕巴（%）
  typoHoldMs: 800,       // 错字挂多久才改回来（会再加 0~400 随机；夹 200~5000）
  typewriter: false,

  /* ---------- 气泡 ---------- */
  bubbleW: 320,          // px —— 旧 PowerShell 版的 242 是 WPF 的 DIP，尺度对不上
  bubbleH: 180,          // 0 = 自动
  bubbleAlpha: 92,
  bubbleAnchor: 'tl',    // 气泡挂在她哪个角：tl/tr 在上方，bl/br 在下方
  /*
   * ★ 气泡位置**微调**（2026-10-17 他加的：「气泡的位置和透明度设为可调」）。
   *   四角预设管方位，这两个管微调 —— 他明确选了「四角 + 偏移量」这个方案
   *   （原话「a（工作量小，bug少）」），不是要十个预设、也不是要拿鼠标拖着跑。
   *   ⚠️ 单位 px，范围给他 ±300。
   *   ⚠️ 偏移**加在窗口 clamp 之前**（见 ui/bubble.js 的 place()）——
   *      加在后面会被夹回窗口内，表现就是"设了没反应"。
   */
  bubbleOffX: 0,
  bubbleOffY: 0,
  bubbleTextColor: '#1B1A1E',
  bubbleFontSize: 13.5,
  bubbleSeconds: 8,
  bubbleOverflow: 'wrap',// wrap | clip

  /* ---------- 画面 ---------- */
  gridN: 8,
  fpsLimit: 0,           // 0 = 跟随显示器
  meshK: 1.65,
  hairK: 2,
  /*
   * 整体倾斜角偏移（度）。
   *
   * ⚠️⚠️ 2026-10-12 晚改口径：他先要「一个总旋钮」，后改成
   *    **「改成每个状态单独调整」** —— 所以这个全局偏移键**废掉了**。
   *    五个姿态各自的倾斜角现在**直接存在 `rig.json` 的 presets 里**
   *    （待机 -2 / 走路 1 / 跑动 5 / 坐姿 -6 / 睡觉 0），
   *    设置面板那 5 个滑块改的就是它 —— 见 `core/rigparams.cjs` 的长注释
   *    （为什么不再在 config 里另存一份）。
   *
   *    这里**故意不再放一个 `tiltDeg` 键**：留着一个不生效的键，
   *    以后一定会有人（包括我）以为它有用。
   */
  // tiltDeg 已废 —— 见上面那段
  // 呼吸怎么做：
  //   squash（默认）= 脚踩死不动，从脚往上的部分纵向伸缩 —— 上下 Q 弹
  //   shift        = 整体上下平移（老做法，看着像在飘）
  breathStyle: 'squash',
  // 低倍率的采样质量：high = 缩小时用更好的滤波（治锯齿），low = 老样子
  smoothQuality: 'high',
  /*
   * 站坐过渡（他 2026-10-12 选的 C 方案「挤压展开」）。
   * 换素材的那一瞬间不再硬切：站立先被压扁淡出，坐姿从压扁弹开。
   * 0 = 关掉，瞬间换（老行为）。
   */
  transitionMs: 420,

  /* ---------- 天气 ---------- */
  city: '北京',
  tempUnit: 'c',
  weatherAuto: false,
  weatherRefreshMin: 12,
  weatherVoice: 'read',  // read = 照着念 | own = 用自己的话

  /* ---------- AI ---------- */
  // ⚠️ 这几个默认值是从旧工程实测能跑的那套抄的，别凭印象改：
  //    旧工程 ApiBase 不带 /v1，模型是 deepseek-flash，
  //    思考走 `thinking:{type}` + `reasoning_effort`（low/medium/high）
  apiBase: 'https://api.deepseek.com',
  model: 'deepseek-flash',     // deepseek-flash | deepseek-chat | deepseek-reasoner
  apiKey: '',
  temperature: 0.8,            // 思考模式打开时这一项会被忽略
  thinking: true,
  thinkingDepth: 'low',        // low | medium | high
  /*
   * `thinking` / `reasoning_effort` 是 **DeepSeek 私有字段**，不是 OpenAI 接口的。
   *   always（默认）= 一直发 —— 跟加这一项之前的行为完全一样
   *   auto          = 地址里带 deepseek 才发
   *   off           = 永远不发（对面会因为这个字段 400 时用）
   *
   * ⚠️ 默认**必须是 always**。我第一版写成 auto，结果「他开着思考模式、
   *    程序却按地址猜着把它关掉了」—— 从没要求过的事不能替用户决定。
   *    （他报的那个 404 是模型名写死造成的，跟这个字段无关。）
   */
  thinkingStyle: 'always',
  /* ---------- 联网 ----------
   * ⚠️⚠️ **这条链走的是 Anthropic 兼容端点，不是 OpenAI 那套。**
   *    原因见 `core/websearch.cjs` 顶上那段 —— 简单说：
   *    `/responses` + `tools=[{type:'web_search'}]` 那个内置工具类型
   *    **被服务端静默忽略**，返回 200 但一次都没搜，模型拿旧知识编答案。
   *    他为此被**骗了整整一天**。
   *
   * ⚠️ 换接口地址的时候：地址里要能提供 `/anthropic/v1/messages`。
   *    不想走 Anthropic 那套的话，`webApiUrl` 可以直接写死一个完整地址。
   */
  webEnabled: true,
  // '' = 按 apiBase 拼（`<apiBase>/anthropic/v1/messages`）
  webApiUrl: '',
  webMaxUses: 3,               // 单次最多让服务端搜几次
  webMaxOutputTokens: 1500,    // Anthropic 那套里 max_tokens 是必填
  /*
   * ⚠️ 20 秒。旧值 12 是按 `/responses` 定的，而那条链是整个响应 29.6 秒才回来，
   *    所以每次都撞超时。新端点实测 3.6 秒 —— 20 秒有 5 倍余量。
   */
  webTimeoutSeconds: 20,
  // 0 = 不限。查一次要钱，但拦太死会在真需要的时候查不到
  webMaxPerDay: 20,

  /* ---------- 识屏 ----------
   * 隔一阵偷偷看一眼他的屏幕，然后说一句。
   *
   * ⚠️ **默认关**（他 2026-10-13 拍板）—— 这条会把**他的屏幕截图发出去**，
   *    第一次该由他亲手在设置里打开，不该装完就偷偷发。
   *
   * ⚠️ **「时间可设」是他明确要求的**：`screenEveryMinutes` 就是那个间隔。
   *    底下那一整套（每日上限 / 分时段倍率 / 截几张）都是照旧工程搬的。
   */
  screenEnabled: false,
  screenEveryMinutes: 12,      // ★ 基础间隔（分钟）—— 他要的那个旋钮
  screenMaxPerDay: 0,          // 一天最多看几次，**0 = 不限**
                               //  （旧工程拍板过：识屏本身就有间隔，再限次数中午就用光了）
  screenShots: 1,              // 一次截几张（两张一样只发一张，省图片钱）
  screenShotGapSeconds: 6,     // 两张之间隔几秒
  // 抓屏走哪条路。auto = 先 desktopCapturer（不起子进程），拿不到再退 GDI
  // ⚠️ 2026-10-13 在他 ELDEN RING 全屏里实测：**两条都抓得到真画面**（不是全黑）
  screenCapture: 'auto',       // auto | desktopCapturer | gdi
  screenTimeFactors: true,     // 分时段倍率：乘在间隔上
  screenDayFactor: 1,
  screenEveningFactor: 1,
  screenNightFactor: 3,        // 深夜 ×3（12 分钟变 36 分钟）—— 别那么吵
  screenUseForeground: true,   // 带上"他现在的前台窗口"（截图挂了这条也有效）
  screenAvoidRepeat: true,     // 画面跟上一轮一模一样就不看（他一直盯着同一页）
  /*
   * ⚠️ 看图要**支持视觉的模型**。默认跟主模型一样；万一主模型看不见图，
   *    在这儿单独指一个 —— 不然画面到了她也是"看不见"，而且**不报错**。
   *
   * ★★ 2026-10-18：识图这一档**可以整套独立**（地址 / 密钥 / 模型），不用再蹭主模型。
   *    原因是实测撞出来的：`screenModel` 只有模型名时，请求仍然发往 `apiBase + apiKey`
   *    （主对话那套）—— 填个 Kimi 的模型名去问 DeepSeek，必然失败，而且报错看着像"没填对"。
   *    ⇒ 三个都留空 = 跟主模型完全一致（老行为不变）。
   */
  screenModel: '',
  screenBase: '',        // 识图用的地址；留空 = 用 apiBase
  screenKey: '',         // 识图用的密钥；留空 = 用 apiKey（⚠️ 它是密钥，见 index.cjs 的 SECRET_KEYS）

  /* ---------- 记忆 · 短期 ---------- */
  memShort: true,        // 关了就不带对话历史（她只看得到今天这一句）
  memShortCount: 30,     // 带多少条 —— 还有一道 12,000 字符的闸在 memory.cjs 里

  /* ---------- 记忆 · 长期 ---------- */
  // ⚠️ 这些键是照旧工程 [记忆] 段一项项对过来的，名字尽量保持不变 ——
  //    他翻旧配置的时候能对上号。
  memEnabled: true,          // 记忆总开关（关掉 = 习惯和梗都不进提示词）
  memeTopK: 5,               // 梗检索取前几条
  // ⚠️ 旧工程有个 `HabitTopK`，但 O36 之后对习惯库**已经失效**了（改成整份常驻）。
  //    新工程**不设这个键** —— 留着就是个拧不动的假旋钮。

  /* ---------- 记忆 · 跨会话 ---------- */
  midTermEnabled: true,      // 退出时把「最近发生的事」存下来，下次开机接着聊

  /* ---------- 记忆 · 热度与归档 ---------- */
  memoryHeatEnabled: true,   // 按「用过几次」给梗加权
  memoryHeatWeight: 0.15,    // 每命中一次的权重（总分封顶 1.0，见 habits.cjs）
  memoryArchiveEnabled: true,
  memoryDecayDays: 180,      // 多少天没被用到就挪进归档（**不删**）

  /* ---------- 记忆 · 人物画像 ---------- */
  profileEnabled: true,      // 她隔几天自己重写一遍「你是个什么样的人」
  profileRefreshDays: 3,

  /* ---------- 记忆 · 自动学习 ---------- */
  // ⚠️ 学习 = 从聊天里提炼「习惯 / 梗」，这是习惯库**唯一的写入途径**。
  //    关掉它，习惯库就只能靠手改文件。
  autoLearnEnabled: true,
  autoLearnEveryRounds: 30,  // 每聊满多少轮学一次
  autoLearnOnClose: true,    // 收窗时也学一次
  // ⚠️ 旧工程有个 `LearnSelfCheck`（让模型自己再筛一遍）。新工程**不设这个键** ——
  //    「别记隐私、别记工具噪音」那几条要求直接写进了学习提示词里（learn.cjs），
  //    单独立个开关等于多一个没人会去关的旋钮。
  learnNeedConfirm: true,    // 学到的先放「待确认」，他点头才进库

  /* ---------- 情绪 （3c 接） ---------- */
  mood: true,
  /*
   * ---- 3c：情绪 / 目标 / 她自己的东西 ----
   *
   * ⚠️ `MoodMaxChangesPerDay` 和 `MoodDecayHours` 这两道闸**别拆**：
   *    不封顶她能在十分钟里从高兴摆到低落再摆回来（那不叫有情绪，叫抽搐）；
   *    不定时回落的话，一次难过会一直挂着，三天后她还阴沉着而「为什么」早就过期了。
   */
  MoodMaxChangesPerDay: 3,     // 一天最多变几次心情
  MoodDecayHours: 18,          // 距上次变化多少小时自动淡回「平常」
  goalEnabled: true,           // 目标（她惦记着要为你做成的事）
  worryEnabled: true,          // 心事
  mistakeEnabled: true,        // 认错
  smallEnabled: true,          // 她的小日子

  /* ---------- 第 4 步：心跳 / 回顾 / 自言语 / 唱歌 / 自动关闭 ----------
   * ⚠️ 默认值全部照旧工程 `ai\Ai-Config.ini` 抄的（那是他自己调过的）。
   *    改之前先看 `heartbeat.cjs` 里对应那道闸的注释 —— 每一条都有理由。 */
  ReviewIdleMinutes: 55,       // ★ 键鼠停这么久才回顾。设小了会在你打字时突然"回顾"
  AutoExitEnabled: true,       // 停够久自动退出
  AutoExitIdleMinutes: 60,

  SelfTalkEnabled: true,
  SelfTalkMinMinutes: 20,      // 自言语间隔下限（会乘一个时段倍率）
  SelfTalkMaxMinutes: 60,
  SelfTalkUseTime: true,       // 开口时带上"现在几点"
  SelfTalkUseWeather: true,    // 带上天气（拿不到就不带）
  SelfTalkUseMemory: true,     // 带上记忆
  SelfTalkBubbleSeconds: 8,    // 自言自语那口气泡留多久
  SelfTalkAvoidRepeat: true,   // 短期内不重复说同一句
  // 时段倍率：白天她话多、深夜她话少（乘在间隔上，数越大越少开口）
  SelfTalkTimeFactors: true,
  SelfTalkDayFactor: 1.5,
  SelfTalkEveningFactor: 1,
  SelfTalkNightFactor: 2,

  /*
   * ── 唱歌 ── **他 2026-10-12 拍板：这一版不做。**
   *   原话：「本次不做唱歌，我后期训练让她学会就行」——
   *   也就是他要的不是"从歌词文件里随机挑一段念"（旧工程那套），
   *   而是**真会唱**，那得靠后面的训练。
   *
   *   ⚠️ 所以这两个键现在**谁也没读**，而且**故意不接**。
   *      留着是为了记住"这件事有过一个决定"，不是为了能用。
   *      别哪天真把它接上了 —— 他要的是训练出来的唱，不是拼出来的唱。
   */
  SingEnabled: true,
  SingChance: 25,              // 到点时有多大概率改成哼一段歌词（%）

  /* ---------- 用量与成本 ---------- */
  // 显示和计价用哪种货币。⚠️ 只影响**显示和单价口径**，不改实际账单 ——
  // DeepSeek 是按人民币扣的，切到 $ 只是换算个感觉，汇率写死在这儿。
  currency: 'cny',       // cny | usd
  usdRate: 7.25,         // 1 美元 = 多少人民币
  priceIn: 2.00,         // 元 / 百万 token
  priceOut: 8.00,
  priceCacheHit: 0.50,
  spendAlert: true,
  spendLimit: 50,

  /* ---------- 高级 · 备份 ----------
   * ⚠️ 分三档（他 2026-10-12 定的），各自的**时间档**都不一样：
   *     聊天记录 / 日志 = **每天**，按**年月**分文件夹（`26-10`）
   *     记忆文件        = **每周**，按**那一周的周一**建文件夹（`2026-10-19`）
   *    理由：聊天和日志是流水，一个月一档翻起来是一整段时期；
   *    记忆是"她是谁"，一周一档才看得出变化 —— 天天备只会得到一堆一模一样的她。
   */
  backupDaily: true,           // 每天备聊天记录 + 日志
  backupWeeklyMemory: true,    // 每周打一次记忆的包
  /**
   * 备份放哪儿（相对 `%APPDATA%\Yachiyo\`）。
   * ⚠️ 默认**搁在她自己家里** —— 方便他一键打开就能看见、直接拷走。
   *    想更保险的话把它指到别的盘（比如 `D:\Yachiyo备份`）——
   *    配置项认绝对路径。
   */
  backupDir: '备份',
  logLevel: 'info',

  /* ---------- 通用 ---------- */
  /*
   * ⚠️ 默认 **false**（2026-10-16 改的，原来是 true）。
   *
   *    `autostart.sync()` **每次启动都跑**，而它只看这个键 ——
   *    默认 true 等于「第一次运行就悄悄往 `HKCU\...\Run` 写一条」，
   *    他根本没点过设置面板里那个开关。
   *    而 `autostart.cjs` 的文件头明写着「**只在用户同意后**」——
   *    默认值跟这条规矩本来就是矛盾的。
   *
   *    ⚠️ 改默认值**不会动已经存过的配置**：他这份 `config.json` 里
   *      `autostart` 是显式写着的，所以他的自启行为一个字节都不变；
   *      受影响的只是「全新安装、还没碰过设置」那种情况。
   */
  autostart: false,
  theme: 'light',        // light | dark
  accent: '#0A7EA4',
  /*
   * 界面字体。
   *   '' (空) = 用系统默认那套（微软雅黑 → 系统 UI）
   *   其它    = `%APPDATA%\Yachiyo\fonts\` 里某个字体文件的**文件名**
   *
   * ⚠️ 存的不是字体名而是文件名：字体内部名（他给的那份叫 ZXFYunYuan）
   *    五花八门，拿它当键容易对不上；文件名是他自己丢进去的，一眼认得。
   */
  fontFamily: '',

  /* ---------- 内部 ---------- */
  schemaVersion: 1,
  firstRun: true,
};

function ensureDir() {
  for (const d of [DIR, DATA, FONTS]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

/**
 * 递归拷一份（只处理普通对象和数组，别的原样返回）。
 * ⚠️ 给 `merge()` 用 —— 它必须**深拷**（不然默认值和配置会共用同一个对象），
 *    见那边的注释。
 */
function deepCopy(v) {
  if (Array.isArray(v)) return v.map(deepCopy);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = deepCopy(v[k]);
    return o;
  }
  return v;
}

/** 用默认值补全缺项（老配置升级上来时不会缺字段），但不覆盖用户改过的值 */
function merge(base, over) {
  /*
   * ⚠️ 先**深拷**一份 base（2026-10-16 修的）。
   *
   *    原来写的是 `{ ...base }` —— 只拷一层。像 `winGeom` 这种对象，
   *    DEFAULTS 里那份和返回值里那份**是同一个引用**：
   *    后面谁就地改 `cfg.winGeom.x`，等于把 DEFAULTS 也改了，
   *    连 `reset()` 之后都还带着脏值。实测 `DEFAULTS.winGeom === cfg.all().winGeom`
   *    就是 true。
   *
   *    目前 overlay 写之前会自己拷一份副本，所以还没发作 —— 属于埋着的雷。
   */
  const out = deepCopy(base);
  for (const k of Object.keys(over || {})) {
    const v = over[k];
    if (v && typeof v === 'object' && !Array.isArray(v) &&
        base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = merge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

let cfg = null;

function load() {
  ensureDir();
  if (!fs.existsSync(FILE)) {
    cfg = merge(DEFAULTS, {});
    save();
    return cfg;
  }
  try {
    /*
     * ⚠️⚠️ 读之前**先去 BOM**（2026-10-15 修的）。
     *
     *    他要是拿记事本之类存成「UTF-8 带 BOM」，JSON.parse 会当场抛错 ——
     *    下面那条 catch 就把整份配置当"读坏了"、写回默认值，
     *    ⇒ **apiKey 和全部设置一起没**。实测过。
     *    `store.readText()` 一直就是这么干的（store.cjs:45），这里当初漏了。
     *
     * ⚠️ 别改成 `require('./store.cjs')` 来复用 —— store **反过来** require 了
     *    本文件，那是循环依赖，正是清单 #1 栽的那种坑（先加载的一方拿到空对象）。
     *    就一行 `.replace()`，值不得冒那个险。
     */
    cfg = merge(DEFAULTS, JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, '')));
  } catch (err) {
    const bad = path.join(DIR, `config.bad-${Date.now()}.json`);
    try { fs.copyFileSync(FILE, bad); } catch {}
    console.error(`[config] 配置读坏了，原文件备份到 ${bad}\n         原因：${err.message}`);
    cfg = merge(DEFAULTS, {});
    save();
  }
  return cfg;
}

function save() {
  ensureDir();
  // 先写临时文件再改名 —— 断电/崩溃时不会把原来的配置写成半截
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2), 'utf8');
  fs.renameSync(tmp, FILE);
}

function all()  { return cfg || load(); }
function get(k) { return all()[k]; }
function set(k, v) { all()[k] = v; save(); return v; }
function patch(obj) { Object.assign(all(), obj); save(); return all(); }
function reset() { cfg = merge(DEFAULTS, {}); save(); return cfg; }

module.exports = { DIR, FILE, DATA, FONTS, DEFAULTS, ensureDir, load, save, all, get, set, patch, reset };
