# AGENTS.md —— 给 AI / 接手方的说明书

> 这份文件是给**代码助手**看的（Claude Code / Codex / DSH 这类），不是给用户看的。
> 用户文档看 `README.md`。
>
> 2026-10-18 建。来由：之前**仓库里一个测试、一个规则文件都没有**，任何新会话
> 打开这个项目，看到的是「没有测试、没有规则、没提交」—— 只能靠上一轮的叙述
> 判断"改坏没有"，于是同一个 bug 反复找、同一个坑反复踩。

---

## 1. 这是什么

一个 Windows 上的桌面宠物（Electron + 原生 Canvas，**无构建步骤**）。
她会走动 / 坐着 / 睡觉，能聊天（接 OpenAI 兼容接口）、能看屏幕、有记忆和情绪。

- 技术栈：Electron 44，CommonJS（`.cjs`），**没有打包器、没有 TypeScript、没有框架**
- 主进程：`src/main/`　渲染层：`src/renderer/`　纯逻辑：`src/core/`
- 数据（配置/日志/记忆）：`%APPDATA%\Yachiyo\`

---

## 2. 五条设计规矩（改代码前必读，破了会很难查）

1. **`src/core/` 里不许 `require('electron')`。**
   需要 Electron 能力的地方（空闲时间、截屏）由主进程 `attach()` 塞进来。
   原因：core 要能被纯 node 直接 require —— 这是**所有单元测试能跑的前提**。

2. **提示词只从 `src/core/prompt.cjs` 出。** 别在别处拼系统提示词。

3. **穿透（`setIgnoreMouseEvents`）只有一个控制点：页面的 `app.js`。**
   主进程**只发事件**（`win:cursor-out` / `win:cursor-pos` / `win:shown`），
   绝不许自己调 `setIgnoreMouseEvents` —— 一改就跟页面手里的 `wantMouse` 失配，
   而页面**不会知道**，表现就是"点不动、拖不动"。
   > 2026-10-17 就是这么翻的车：主进程在 `win.on('show')` 里加了一句"保险"，
   > 结果显示之后窗口永久忽略鼠标。

4. **凡是可能"假成功"的链，必须留一个可验收指标写进日志。**
   反例（都真实发生过）：
   - 识屏三级降级的 `via`（是哪个模型看见的）被丢弃 → 「她真看见了」和「她说固定文案」在记录里长得一模一样
   - `setIgnoreMouseEvents` 只记了去重后的变化 → 「页面没发」和「发了没生效」分不清

5. **心跳只管「什么时候」。** 每样活的实现在各自模块（`heartbeat.cjs` + 各链）。

---

## 3. 怎么跑

```bash
npm start                 # 起客户端
YACHIYO_CDP=9222 npm start # 起客户端并开 CDP 调试口（e2e 探针要连它）
npm test                  # 跑纯 node 单元自检（20 套，约 30 秒，不起窗口）
npm run test:all          # 连要起 Electron 的那几套一起（会真的开窗口）
```

- 环境变量 `YACHIYO_HOME=<目录>` 可以**整个换一个数据家**（自检和探针都靠它隔离，
  不碰用户真实的 `%APPDATA%\Yachiyo`）。
- 环境变量 `YACHIYO_MS=<毫秒>` 会进"探针模式"：写 `_probe.log`、每 3 秒截一张图、
  到点自动退出。**日常别设它**（`plog()` 在非探针模式下是空函数，这也是一处坑：
  排查问题时忘了开它，日志会一片空白）。

---

## 4. 测试在哪（这就是以前缺的那页）

```
tests/
  run.cjs              一键跑（npm test）
  unit/*.test.cjs      20 套纯 node 自检（每个文件自带断言，最后打印 "N 通过 / M 失败"）
  unit/fake-llm.cjs    假模型服务，**必须跟自检同目录**
  e2e/*.cjs            真机探针（起真 Electron + CDP 连进渲染层）
```

**单元自检注意：**

- 每套跑在自己的 `YACHIYO_HOME` 里。要测"读盘之后的行为"，**必须另起子进程**
  （config/store 是模块级缓存，同进程换 home 不生效）。
- `fake-llm.cjs` 当年被搬到了别的目录 → 自检 spawn 它时 `ECONNREFUSED` →
  跑到第 26 项自己挂了。**搬家时别把它们拆开。**

**e2e 探针注意：**

- 跑之前必须先有一个**带 CDP 的实例**：`YACHIYO_CDP=9222 npm start`
- `probe-packaged.cjs` 要传打包版的 `preload.cjs` 路径
- **别用程序移鼠标来验交互**（`mouse_event` 在这台机上落点不准，实测
  要 `300,300` 会落到 `343,686`）。要真实鼠标的验收，**交给人手**。
- 探针的判据会**悄悄过期**：`probe-packaged.cjs` 里曾断言"`ov.design` 还在"
  —— 后来正式版里那块被 `DEV` 闸掉了，探针报红，其实是判据过时了。
  **改源码之后顺手跑一下相关的探针。**

---

## 5. 这台机器上的坑（精选，别全抄）

- **`core.autocrlf` 是系统级 true** → 用 `.gitattributes` 按死 LF，否则整仓库行尾被改写。
- **`ELECTRON_RUN_AS_NODE=1`** 会被环境带进 spawn → electron 把自己当 node 用，
  主进程第一行就炸。`scripts/start.cjs` 里显式删掉了它。
- **preload 沙箱里没有 `require('electron').app`** → 写 `app.isPackaged` 会让 Electron
  **静默丢掉整个 preload**（`window.yachiyo` 全没）。改用主进程 `additionalArguments` 传标志。
- **事件白名单是静默丢弃的**：`preload.cjs` 里那个 `on()` 只接受白名单里的频道，
  没登记的**主进程照发、页面照收不到，而且不报错**。加新事件必须同时登记。
- **DPI**：页面 `clientX/Y` 是 CSS 像素；`powershell.exe` 是 DPI-unaware，它读写的光标坐标
  也是 DIP —— 两者一致，**别乘 `devicePixelRatio`**（乘了会把鼠标指到屏幕外）。
- 跨进程传坐标用 **0~1 的相对比例**最稳，绝对坐标在"主进程 / 渲染层 / 无头脚本"
  之间单位对不上。

---

## 6. 版本与许可

- 版本：见 `package.json`（0.1.x）
- 许可：MIT（`Copyright (c) 2026 速食面`）
- ⚠️ **立绘素材不在 MIT 范围内**，别把它们当代码分发。
