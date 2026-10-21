# DEBUG.md —— 坏了怎么查

> 给「已经出问题了」的时候看。设计规矩 / 目录结构 / 怎么跑，看 `AGENTS.md`。
> 这份只干一件事：**把症状指到该看的那一行。**

一句话心法：**先问「她当时在干嘛」，再问「哪个环节该留痕却没留」。**
留不下痕迹的环节，就是下次还会反复查的环节 —— 那就补日志，别靠回忆。

---

## 0. 三十秒版

```bash
node scripts/diag-pack.cjs     # 收现场 → 桌面\八千代AI诊断包\Yachiyo-diag-<时间>\00-诊断摘要.txt
npm test                       # 20 套纯 node / 约 28 秒 —— 先确认「代码层」坏没坏
```

两条都不需要她正在跑。**先收现场，再重启** —— 重启会覆盖一批状态文件，痕迹就没了。

---

## 1. 日志：唯一说真话的地方

- 位置：`%APPDATA%\Yachiyo\logs\YYYY-MM.log`（一个月一个文件，UTF-8 无 BOM + 裸 LF）
- 格式：`[2026-10-21 19:27:18] [标签] 正文`
- 等级：`config.json` 的 `logLevel`（`error` < `warn` < `info` < `debug`）。
  **低于它的等级直接不写** —— 日志里"什么都没有"时，第一嫌疑是这儿被调高了。
- ⚠️ **打包版没有控制台**：Windows 上 `electron.exe` 是 GUI 子系统程序，`console.log`
  谁也不接。所有诊断信息必须走日志文件。

### 九个标签（`grep '\[标签\]'` 就能切出来）

| 标签 | 谁写的 | 什么时候出现 |
|---|---|---|
| `[识屏]` | `core/peeker.cjs` | 每次该看她屏幕了（含"前台是我们自己 → 跳过"） |
| `[回顾]` | `core/review.cjs` | 回顾链的五道闸，每道拦下都会写一行 |
| `[自言语]` | `core/selftalk.cjs` | 排下一次自言自语的时间 |
| `[画像]` | `core/profiletool.cjs` | 重写 `profile.md`，含"素材太少"这种拒绝原因 |
| `[备份]` | `core/backup.cjs` | 每日备份、按月分卷 |
| `[联网]` | `core/websearch.cjs` | 他问到需要现查的东西 |
| `[自动关闭]` | `core/autoexit.cjs` | 他动鼠标了 → 允许自动关闭 |
| `[自启]` | `core/autostart.cjs` | 注册表读写开机自启 |
| `[对话]` | `core/brain.cjs` | **每轮聊天一行**：模型 / 提示词字数 / 有无工具 / 正文 / 工具调用数 |

`[对话]` 这行是 2026-10-20 加的（`7de8683`），专门用来分「她没说话」和「说了但没送到屏幕上」。
**日志里连这行都没有 ⇒ 请求压根没发出去**（点击没到、或前置闸挡了）。

### 另外两个日志（在数据目录里，不在 `logs/`）

| 文件 | 内容 |
|---|---|
| `data/look.log` | 识屏每次的 `from= via= model= base= ms= px= kb=` —— **判断"她到底看没看见"就看 `via`** |
| `data/state/vision.json` | 上一次「模型没视觉」的证据（模型名 / 时间 / 服务端原文） |

---

## 2. 症状 → 去哪儿看

| 症状 | 先看哪儿 | 常见根因 | 怎么确认 |
|---|---|---|---|
| 她站着不动 / 不走 / 一直坐 | **没有日志**（`heartbeat.cjs` 不写盘） | 窗口被暂停、canvas 尺寸 0、帧循环挂了 | `YACHIYO_CDP=9222 npm start`，DevTools 里看有没有 JS 异常；照 `probe-pet.cjs` 的 `hitProbe()` 量命中区 |
| 点不动 / 拖不动 / 穿透失配 | `_ignore.log`（**只有探针模式才写**） | 主进程私自 `setIgnoreMouseEvents`，跟页面的 `wantMouse` 失配 | `YACHIYO_MS=15000 npm start` 复现一次，看 `_ignore.log` 里 `want` 和实际值对不对得上 |
| 我发消息她不回 | `[对话]` 有没有出现 | ① 消息没送到 ② API 报错 ③ 模型只回了工具调用 | `[对话]` 在但无正文 → 看 `via`/报错；整行没有 → 查点击链 |
| 她说了话，气泡里没字 | 气泡设置页 + DevTools | 字体/行高、`--bub-max` 太窄、`overflow` 裁了 | 照 `probe-settings` 的路子推一句**独一无二的长句**，看折不折 |
| 她说的话在聊天框里看不到 | `data/chat.jsonl` 最后几行 | 主进程里存在**同名局部函数把写入函数遮蔽**（2026-10-20 就是这么丢的） | `tail -3 data/chat.jsonl`，看有没有 `"kind":"识屏"` / `"kind":"自言语"` |
| 识屏「什么都没看见」 | `data/look.log` 那一行 | 截屏失败 / 网络不通 / 模型不回话（三者文案相同，**必须看 kb= 和 ms=**） | `kb=0` ⇒ 没截到图；`ms=` 很小 ⇒ 提前失败 |
| 提示「当前对话模型不具备视觉模块」 | `data/state/vision.json` | 主模型不支持图片（服务端 4xx 里带 image/vision 字样） | 换带视觉的模型，或删掉 `vision.json` 后重试 |
| 回顾 / 自言语从不触发 | `grep '\[回顾\]' '\[自言语\]'` | 门槛没过（键鼠没停够 / 素材太少），**都是静默的** | 日志里每道闸都有行，看最后一次是哪条 |
| 设置页一片空白 / 按钮没反应 | DevTools Console（渲染层异常**不进日志**） | JS 抛错中断挂载 / 循环 import | 跑 `node tests/e2e/probe-settings.cjs`（33 项，会点五页；⚠️ 会杀掉正在跑的客户端） |
| 用量图不动 / 数字对不上 | `data/usage.json` + `[对话]` 里的花费 | 数据没落盘 / 窗口 `span` 算错 | `node tests/unit/usage-series.test.cjs` |
| 打包版双击没反应 / 退出码 9 | 环境变量 `ELECTRON_RUN_AS_NODE` | 被父进程带进 spawn，electron 把自己当 node | 值必须是空。`scripts/start.cjs` 里已显式删，别在别处再加回来 |
| 打包版起来了但全透明 / 点不动 | 主进程 `additionalArguments` | preload 被静默丢掉（`require('electron').app` 在沙箱里不存在） | 页面里 `window.yachiyo` 是否 `undefined` |
| 备份没做 | `[备份]` | 路径不可写 / 日期分卷算错 | 看 `备份/日志/YY-MM/` 有没有当天文件 |
| 她重复说同一句 | `data/state/spoken.json` | 去重池被清 / 时间戳没推进 | 里面每条带时间；池空了她就会复读 |

---

## 3. 数据文件地图（删之前先备份）

| 路径（相对 `%APPDATA%\Yachiyo`） | 是什么 | 删了会怎样 |
|---|---|---|
| `config.json` | 全部设置（含 `apiKey`） | 回到默认，**要重新填密钥** |
| `design.json` | 立绘 / 描边的覆盖参数（设置页的"应用"） | 回默认样貌 |
| `data/providers.json` | 多服务商 + 各自密钥 | 只剩主配置那一个 |
| `data/chat.jsonl` | 聊天流水（他 / 她 / 识屏 / 自言语） | 聊天框空白 |
| `data/profile.md` | 她对他的画像（`[画像]` 链重写） | 下次重写，短期会"不认识他" |
| `data/usage.json` | 用量与花费（按天累计） | 用量图归零 |
| `data/她的心事.json` | 情绪 + 心事 + 认错 + 小日子（**同一个文件**，旧工程就这么存的） | 情绪回"平常"、丢记忆 |
| `data/state/spoken.json` | 说过的句子 + 时间（去重用） | 可能复读 |
| `data/state/session.json` | 跨会话接续 | 下次开机当第一次见面 |
| `data/state/last-exit.json` | 上次退出时刻 | "她睡了多久"算不准 |
| `data/state/screen.json` | 上次识屏结果 | 下次重新看 |
| `data/state/selftalk.json` | 下次自言语时间 | 重新排 |
| `data/state/vision.json` | 无视觉模块的证据 | 提示会重现（一般**删它就是为了再试一次**） |
| `logs/YYYY-MM.log` | 上面那套日志 | 历史痕迹没了（**排查前别删**） |

---

## 4. 探针怎么跑

```bash
npm test                          # 20 套纯 node（3 套要起窗口的会跳过），约 28 秒
npm run test:all                  # 连那 3 套一起 —— 会真的在她屏幕上开窗口
YACHIYO_CDP=9222 npm start        # 起客户端 + 开 CDP 调试口，e2e 探针要连它
node tests/e2e/probe-settings.cjs # 单独跑某个探针
```

- 每个单元自检都在自己的 `YACHIYO_HOME` 里跑，**不碰真数据**；全绿后
  `tests/run.cjs` 会自动扫掉那些隔离目录（**有红不扫**，留着当现场）。
- ⚠️ **`probe-settings.cjs` / `probe-pet.cjs` 会 `killAll()`** —— 他正在跑的客户端会被杀掉。
- ⚠️ **`plog()` 只在 `YACHIYO_MS>0` 时写**，所以 `_probe.log` / `_ignore.log` 平时是空的。
- ⚠️ **别用程序移鼠标验交互**：`mouse_event` 在这台机落点不准（要 `300,300` 落到 `343,686`）。
  要真实鼠标的验收，交给人手。
- ⚠️ **判据会过期**：改了源码要回头跑一遍相关探针，红的不一定是产品坏了，可能是断言老了。

最近一次全绿基线（2026-10-20～21 实测）：`probe-settings 33` · `probe-pet 9` · `probe-design 56` ·
`probe-sleep-gate 8` · `probe-packaged 8` · `probe-wake 11` · `verify-down 4` · `verify-game 6` ·
`probe-hideshow 5` · `probe-panelresize 3` · `probe-batchA 8` · `probe-batchB 20` · `probe-batchC 11`（要 `YACHIYO_HOME`）。

---

## 5. 收现场：`scripts/diag-pack.cjs`

```bash
node scripts/diag-pack.cjs                  # 落 桌面\八千代AI诊断包\Yachiyo-diag-<时间戳>\
node scripts/diag-pack.cjs D:\某处\现场     # 或指定目录
```

收进来：环境（版本 / 提交 / 屏幕与缩放 / 显卡 / 进程 / 是否打包版）、
配置（**`apiKey` 等密钥打码**）、日志尾部 400 行、`look.log`、
聊天流水尾部 200 行、用量、各个 `state/*.json`、`profile.md`。

- **只读复制**，一个字节都不改原数据。
- **不联网、不上报、不弹窗。**
- 打不开的项会在 `00-诊断摘要.txt` 里写「缺 xxx」，不是静默跳过。

---

## 6. 交付一次排查时，我该给他什么

1. 症状一句话 + 发生时间
2. `00-诊断摘要.txt` 全文
3. 相关的日志行（**原文**，不摘写）
4. 改前 → 改后的数字
5. 一句"这次没查出来"也行 —— **别给"应该没问题"**
