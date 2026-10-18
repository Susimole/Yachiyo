# tests/e2e —— 真机探针

这些是**端到端**的：起真的 Electron，用 CDP 连进渲染层，点按钮、量 DOM、看窗口状态。

## 跑之前

```bash
# 1) 先起一个带调试口的实例（另开一个窗口）
YACHIYO_CDP=9222 npm start

# 2) 再跑探针
node tests/e2e/probe-design.cjs
```

⚠️ **端口 9222 只允许一个实例占着**。上一个没关干净时，CDP 会连到**旧实例**，
探针就会报「新加的 UI 不存在」—— 这是假失败，先 `tasklist | findstr electron` 确认。

## 有哪些

| 探针 | 验什么 | 需要特殊准备 |
|---|---|---|
| `probe-design.cjs` | 界面调试台（22 个排版参数 / 文字可编辑 / 导出） | `--keep` 验重启后改动还在 |
| `probe-packaged.cjs` | 打包版该有的有、该没的没 | 要传打包版的 `preload.cjs` 路径 |
| `probe-ico.cjs` | 打包版图标真加载出来了吗（量 `naturalWidth`） | 打包版 |
| `probe-sleep-gate.cjs` | 睡着时说不说话、冒不冒气泡 | — |
| `probe-batchA/B/C.cjs` | 第 40 轮那三批改动 | — |
| `probe-wake.cjs` | 睡着被点一下会不会醒（气泡层 + 主进程层） | — |
| `probe-panelresize.cjs` | 设置面板边框锁住了没 | 会用真鼠标拖边 |
| `probe-hideshow.cjs` | 隐藏/显示之后鼠标消息还进不进来 | ⚠️ 见下 |
| `verify-down.cjs` | 隐藏/显示前后 `mousedown` 还在不在 | — |
| `verify-game.cjs` | 打游戏时她保持坐着 | — |
| `arm-record.cjs` | 装鼠标事件记录器（给真人点的那种排查用） | `--read` 读记录 |

## ⚠️ 三条血泪

1. **别用程序移鼠标来验交互。** `mouse_event` 的绝对坐标在这台机上落点不准
   （实测要 `300,300` 落到 `343,686`，要 `1800,1000` 落到 `83,619`）。
   要真实鼠标的验收，**请人点**，探针只负责记录。
2. **探针的判据会过期。** 改了源码之后顺手跑一下相关的探针 —— 曾经
   `probe-packaged.cjs` 断言"`ov.design` 还在"，而正式版里那块早就被 `DEV` 闸掉了。
3. **探针自己要干净**：开头清盘、结尾留证据，别把要检查的文件自己删了。

## 被故意留在仓库外的

- `look-tiers.cjs`（识屏三档）：要读 `桌面\test.txt` 里的真钥匙，**不进仓库**。
- `_*.cjs` 那批一次性调试脚本：历史垃圾，留在 `_dsh020\verify\`。
