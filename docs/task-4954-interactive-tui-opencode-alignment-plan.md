# roy-bot interactive TUI 对齐 opencode —— 摸底报告 + 分片改造方案（v2）

> Task #4954 · 2026-11-04 · 方案先行（本轮不动产品代码）
> v2 修订：用户看过 6 张对比截图后方向性反馈（飞书 om_x100b61840e59d8acc4e70414a2f5ce7）——
> 「opencode 启动后是全新 UI 不与命令行混，roy-bot interactive 很乱、输入框未锚定底部、
> 展示元素粗糙。全面对标 opencode 的 UI」。**核心架构决策变更：split-footer → 全屏 alt-screen**。
> 证据：截图 `/tmp/tui-baseline/` 下 6 张基准（roy 3 + opencode 3）+ 用户 3 张实测截图；
> 取证脚本 `scripts/tui-solid/capture-4954/`（退出码 0=复现成功，复用 #4279 pty+pyte+PIL 模式）

---

## 0. 结论速览（v2）

### 0.1 用户反馈 → 根因 → 归片

| 用户反馈（原话要点） | pty/截图实测 | 根因 | 归片 |
|---|---|---|---|
| 「opencode 是全新 UI，不跟命令行混；roy-bot 混在一起」 | roy boot 截图上方完整可见 shell 历史；opencode 全屏接管 | roy 用 `screenMode:"split-footer"`（内联滚动缓冲）；opencode 用 opentui 默认 `alternate-screen`（ESC[?1049h 全屏） | **P0 全屏架构** |
| 「输入框没有被锚定在屏幕底部」 | 对话中输入框被内容顶走；opencode 输入框恒沉底 | split-footer 历史走 write-once scrollback + 自管视口，输入行非 flex 常驻底 | **P0/P1 布局** |
| 「很乱：横幅删除线残影」 | 图3 青色横幅删除线残影卡在历史中间 | 滚动缓冲重绘残留（内联模式固有） | **P0**（alt screen 后自然消失，需验证） |
| 「markdown 原样裸奔（##、**、表格管道符）」 | 图3 实锤 | `render/markdown.ts:185-190` heading 保留 `#` 前缀；表格 ASCII `|`/`-+-` | **P4 markdown 真渲染** |
| 「ASCII 表格中文对不齐」 | 图3 实锤 | `visibleLength` 只剥 ANSI 不算 CJK 双宽（markdown.ts:298-301） | **P4** |
| 「提示语冗余（Ctrl+C to exit / working… ESC / /exit to quit 三份）」 | 图2/3 实锤 | 各组件各写各的提示，无统一 hint 策略 | **P1 状态栏统一** |
| 「图标混杂（人形剪影/🤖/贴图不一）」 | 图2/3 实锤 | ROLE_PREFIX 用 emoji（App.tsx:106-113），跨终端字形不一致 | **P4 图标统一** |
| 「无法 copy/paste」（v1 反馈，仍有效） | bracketed paste 注入 0 响应（opencode 对照=`[Pasted ~3 lines]`） | TextInput 无 paste 通道 | **P2 粘贴** |
| 「无法上下滚动」（v1 反馈，仍有效） | 滚轮可用但无键盘滚动/滚动条 | 自管 scroll-viewport 滚轮专用 | **P3 滚动** |

### 0.2 架构决策变更（v1 → v2）

| | v1 方案 | v2 方案（本版） |
|---|---|---|
| screenMode | 保留 split-footer | **改 alternate-screen**（全屏接管，对标 opencode） |
| 历史承载 | write-once scrollback + 自管视口重绘 | **消息渲染进 scrollbox 树**（opencode 同款：scrollbox + For rows） |
| externalOutputMode | capture-stdout | **passthrough**（opentui 强校验：capture-stdout 必须配 split-footer，否则 throw） |
| 输入框 | 动态区最后一行（近似锚定） | **flex 常驻底部**（scrollbox flexGrow=1 + 底部 flexShrink=0，opencode 同款布局） |
| 历史滚动 | 滚轮专用自管视口 | **scrollbox 原生**（键盘+鼠标+滚动条+加速度） |
| P0 粘贴 | 最高优先 | 让位于 P0 全屏（用户最新痛感排序：先「混在一起/不锚定」） |

> **为什么不提前判死 split-footer**：#4278 选它是为保守兼容（flicker-free 已验证）。
> 用户现在明令「全面对标」，而 opencode 本身就是 alternate-screen + 全树渲染——
> 同框架下照抄它的架构选择是阻力最小路径，且 0.6.6 已具备全部所需 API（screenMode 枚举、
> scrollbox、Textarea onPaste、renderer 默认值链）。

---

## 1. opencode TUI 摸底（v2.2.5 源码，本地 /tmp/opencode-src）

架构：`packages/tui`（12808 行 TSX）+ `@opentui/core/solid/keymap` **0.8.0**（roy 用 0.6.6）+ `@opencode/theme`。

### 1.1 滚动机制（双通道：鼠标 + 键盘）

| 能力 | 实现 | file:line |
|---|---|---|
| 视图容器 | `<scrollbox>`（opentui 原生 ScrollBox）+ `stickyScroll` + `stickyStart="bottom"` + `scrollAcceleration` | routes/session/index.tsx:1511-1560 |
| 鼠标滚轮 | `onMouseScroll` → scrollbox 内建处理；外层 pane 用 `sessionScroll.processMouseEvent(new MouseEvent(...))` 转发 | session-frame.tsx:308-315 |
| 键盘翻页 | `session.page.up/down` = pageup/pagedown；`half.page` = ctrl+alt+u/d；line = ctrl+alt+y/e；first/last = home/end | config/keybind.ts:181-187；routes/session/index.tsx:914-970（`moveTranscript(scroll.height/2)` 等） |
| 键位系统 | `@opentui/keymap` Keymap 层 + `createDefaultOpenTuiKeymap(renderer)` + 自定义 binding expander | context/keymap.tsx:52-88 |
| 滚动条 | `verticalScrollBar` + `session.toggle.scrollbar` 开关 + track 配色 | index.tsx:1518-1528; keybind.ts:102 |
| 加速度 | 默认 `CustomSpeedScroll(3)`；可配 macOS 加速度 | util/scroll.ts:26-33 |
| 跟底提示 | awayFromBottom → 「Jump to latest ↓」 | index.tsx:1561-1580 |

### 1.2 粘贴处理（bracketed paste + 剪贴板双通道）

| 能力 | 实现 | file:line |
|---|---|---|
| 输入控件 | **`TextareaRenderable`**（非手写 text），原生支持 `handlePaste(PasteEvent)` | @opentui/core Textarea.d.ts:43 |
| paste 事件 | `<textarea onPaste={...}>`：`event.preventDefault()` + `decodePasteBytes(event.bytes)` + CRLF 归一化 | component/prompt/index.tsx:1798-1820; mini/footer.prompt.tsx:914-917 |
| 粘贴队列 | `pasteQueue` promise 串行化，防止并发粘贴乱序 | footer.prompt.tsx:857-911 |
| 剪贴板读 | `createTuiClipboard`：host 剪贴板 + terminal (OSC52) 双通道；支持读 **image/png** → 图片附件 | clipboard.ts:1-60 |
| 粘贴后刷新 | `invalidateIntrinsicSize()` + `renderer.requestRender()`（防 layout 陈旧） | footer.prompt.tsx:229-256 |
| 图像粘贴 | `resolvePastedAttachments` → 图片转 data URI 附件 | footer.prompt.tsx:874-884 |

### 1.3 视觉样式

| 能力 | 实现 | file:line |
|---|---|---|
| 主题引擎 | `@opencode/theme`：30 个内置 JSON 主题（defs + oklch 色彩空间 + dark/light 双模式） | packages/theme/src/tui/；assets/opencode.json |
| Token 集 | primary/secondary/accent/error/warning/success/info/text/textMuted/background/backgroundPanel/backgroundElement/border/borderActive/borderSubtle… | assets/opencode.json |
| 用户消息 | 左侧 `border:["left"]` rail（SplitBorder `┃`）+ `backgroundPanel` 底 + hover 加深 + paddingTop/Bottom 1 | routes/session/index.tsx UserMessage |
| Reasoning | 左边框 rail + 流式 `<code filetype="markdown" streaming>` | message-parts.tsx:77-118 |
| Markdown | `<markdown syntaxStyle tableOptions={{style:"grid", cellPaddingX:1}}>` | message-parts.tsx:173-196 |
| 布局 | 统一 `paddingLeft={3}` 左导轨；窄终端自适应降为 1 | message-parts.tsx 多处 |
| Renderer | `targetFps:60, useMouse, exitOnCtrlC:false, useKittyKeyboard:{}, externalOutputMode:"passthrough"` | app.tsx:250-261 |

---

## 2. roy-bot interactive 现状（1.7.72 standalone pty 实测）

架构：`commands/interactive.ts` → `createCliRenderer({screenMode:"split-footer", footerHeight:12, useMouse:true})`（interactive.ts:1005-1039）→ `tui-solid/`（opentui/solid 0.6.6）→ 历史走 `writeSolidToScrollback`（write-once，不在 renderable 树）。

### 2.1 滚动：自管视口（wheel-only）

- `tui-solid/scroll-viewport.ts`：`offset()` 信号（0=跟随最新，>0=回退 N 行），`onScroll` 仅处理滚轮方向，步进 1 行，maxOffset 1000。
- 两路接线：动态区滚轮→根节点 `onMouseScroll`（RunScreen.tsx:756-763）；历史区滚轮→opentui 丢弃→`wheel-interceptor.ts` 截原始序列→`onHistoryWheel`（interactive.ts:1017-1037）。
- 回退时把历史窗口**重渲染进动态区**（RunScreen.tsx:769-785）+ 提示「↑ 已回退 N 行」/「↓ 有 N 条新内容」。
- **缺口**：无键盘滚动键位；无滚动条；步进固定 1 行；无加速度；历史窗重绘整窗。

### 2.2 粘贴：完全没有 paste 通道（实锤 0 响应，有 opencode 对照）

**对照实验**（同 pty、同几何 112×30、同注入序列 `ESC[200~line1\nline2\nline3ESC[201~`）：
- **opencode v2.2.5** → 输入框显示 **`[Pasted ~3 lines]`**（折叠占位，提交时展开全文；逻辑 component/prompt/index.tsx:1464-1475：≥3 行或 >150 字符折叠为占位符，extmark 追踪原文）。截图 opencode-03-paste.png。
- **roy-bot 1.7.72** → **0 字节响应**，输入框无任何变化。截图 02-paste-fail.png。

- `tui-solid/TextInput.tsx`：手写 `<text>` + `useKeyboard` 逐键处理（:67-166）；`key.sequence` 只收 `>=0x20` 的单字符（:159-166）→ 多字节 paste 序列被逐键丢弃或触发歧义行为。
- `tui-solid/text-input-editing.ts`：editReducer 只有 home/end/left/right/backspace/delete/set/insert —— **无 paste action**。
- 对照：opentui 0.6.6 自带 `TextareaRenderable.handlePaste(PasteEvent)` + `PasteEvent` 类型（renderables/Textarea.d.ts:43、lib/KeyHandler.d.ts:30）——**能力在库里，roy 没接**。
- 实测：boot 后 bracketed paste 注入 → 0 字节响应、屏幕零变化（02-paste-fail.png）；`\r` 直接触发提交（对照组 ctrl2）。

### 2.3 样式：ANSI 名色 + emoji

- `tui/theme.ts`：`{primary:"cyan", accent:"yellow", success:"cyan", warning:"yellow", error:"red", muted:"gray", user:"green", assistant:"cyan", tool:"yellow"}`（:64-71）——无背景/边框/surface 概念。
- `ROLE_PREFIX` 用 emoji 👤🤖🔧（App.tsx:106-113）→ 无字形终端豆腐块（截图已见 🤖📁 □）。
- Banner rounded border cyan；StatusBar 4 档 tier；无 rail、无 hover、无 markdown 表格 grid、无滚动条。

---

## 3. 差距清单（逐项 + 根因）

| # | 维度 | opencode | roy-bot | 根因 |
|---|---|---|---|---|
| G1 | 鼠标滚轮 | scrollbox 内建+加速度+滚动条 | 自管 viewport 重绘（可用） | 架构选择：write-once scrollback vs 全量树 |
| G2 | 键盘滚动 | pageup/pagedown/ctrl+alt+u/d/home/end | **无** | useKeyboard 只接 escape（RunScreen.tsx:281-286）；TextInput home/end 是**光标**移动不是滚动 |
| G3 | 滚动条 | verticalScrollBar 可开关 | 无 | 同 G1 |
| G4 | bracketed paste | Textarea onPaste + decodePasteBytes + 队列 | **0 通道** | TextInput 未用 Textarea，无 onPaste 接线 |
| G5 | 剪贴板读（OSC52/host） | createTuiClipboard 双通道+图片 | 无 | 未接 @opentui/core clipboard API |
| G6 | 多行输入 | Textarea 多行编辑 | 单行（\r 即提交） | 手写单行编辑器 |
| G7 | 主题 | 30 主题 JSON + oklch + dark/light | 6 个 ANSI 名色 | 无 theme 工程 |
| G8 | 消息样式 | 左 rail + panel 底 + hover + grid 表格 | emoji 前缀 + 名色 | 组件未做视觉语言 |
| G9 | 键位框架 | @opentui/keymap 层+leader+palette | 逐 key.name if 链 | 无 keymap 抽象 |
| G10 | markdown 渲染 | 原生 `<markdown>` streaming + tableOptions | render/markdown.ts 预渲染 ANSI | 框架差异（可渐进） |

---

## 3A. v2 补充摸底（alt-screen 生命周期 / 锚定 / 状态栏 / markdown 根因）

### 3A.1 opentui screenMode 与生命周期（P0 精确参照）
- 枚举：`"alternate-screen" | "main-screen" | "split-footer"`（`@opentui/core/renderer.d.ts:66`）。
- **默认即 alternate-screen**：`resolveModes` 里 `config.screenMode ?? "alternate-screen"`；
  env `OTUI_USE_ALTERNATE_SCREEN` 可强制（chunk-node-2rg7pskw.js:671752/671883）。
- ANSI：`switchToAlternateScreen: ESC[?1049h`、`switchToMainScreen: ESC[?1049l`（:636792）；
  `destroy()` 恢复主屏 ⇒ 退出后 shell 历史仍在（alt screen 只是显示层切换）。
- opencode 不显式传 screenMode ⇒ 用默认 alternate-screen；退出后补印 epilogue
  （logo + `Session <title>` + `Continue: opencode -s <id>`，`util/presentation.ts:25-40`）。

### 3A.2 输入框锚定（P1 参照）
opencode 会话路由的 flex 布局（routes/session/index.tsx:1501-1580）：
```
<box flexDirection="row" flexGrow={1}>        ← 消息区占满
  <scrollbox flexGrow={1} stickyScroll stickyStart="bottom">…rows…</scrollbox>
</box>
<box height={1} flexShrink={0}>…Jump to latest…</box>   ← flexShrink=0 常驻
<box flexShrink={0}>…Composer/输入框…</box>              ← flexShrink=0 常驻沉底
```
⇒ roy 侧同构：`<scrollbox flexGrow=1>` + 底部输入/状态行 `flexShrink=0`，即得「输入框永远贴底、不随内容滚走」。

### 3A.3 状态栏（P1 参照）
opencode statusline（mini/footer.view.tsx:479-520 `footerStatuslinePolicy`）分组：
- status（含 `esc interrupt`）· work hints（queued/subagents/bg）· **model+variant** ·
- **context %（ctx 用量）** · cost · menu（ctrl+p）· spinner（▪）。
用 `·` 连接、宽度不足时折行策略有专门测量（statusRows）。roy 对标需做**单一来源**的 hint 分组
（现三处提示语各写各的=图3 冗余根因）。

### 3A.4 markdown 根因（P4，file:line 已定位）
- `render/markdown.ts:185-190` heading：`"#".repeat(depth) + " "` 前缀保留 ⇒ `## 核心能力` 裸奔。
- `:298-301` `visibleLength()` 只剥 ANSI 不算 CJK 双宽 ⇒ 表格列宽按半角算，中文挤爆对不齐。
- 表格分隔用 ASCII `|`/`-+-`（:253-296），opencode 用原生 `<markdown tableOptions={{style:"grid"}}>`。
- 两条路：A) 增强 ANSI renderer（去 # 前缀、wcwidth 双宽、边框表格）；B) 直接迁 opentui 0.8 原生
  `<markdown>`（与 P6 合并评估）。v2 建议 **P4 走 A（不依赖升级），P6 升级后再评估 B**。

### 3A.5 usage 元信息行（P4 参照）
roy 已有纯模块 `tui/usage-format.ts`（formatUsageFooter：cache%/in/out；UsageLike 与 core UsageInfo 兼容）。
对标 opencode `Build · model · 5.1s · 11.1 tok/s` 需补：turn 耗时（开始/结束时间戳）与
tok/s（completionTokens / duration）；模型名 StatusBar 已有。

### 3A.6 残影问题（P0 副产品验证点）
图3 横幅删除线残影 = split-footer 下滚动缓冲重绘残留（内联模式固有）。
切 alternate-screen 后整屏由 renderer 全权重绘 ⇒ **理论上残影自然消失**；
P0 验收含专项截图验证（对话多轮 + resize 后无残影）。

### 3A.7 P0 结构工作量（真实成本，勿低估）
`writeToScrollback` 强校验 `screenMode==="split-footer" && externalOutputMode==="capture-stdout"`
否则 **throw**（opentui chunk 实现级校验）⇒ 切 alt-screen 必须同步：
1. renderer options：`screenMode:"alternate-screen"` + `externalOutputMode:"passthrough"`（两处一起改）。
2. **历史承载重构**：`commitHistory()` 链路从 `writeSolidToScrollback` 改为「push 进响应式 rows 数组 →
   scrollbox 内 `<For each={rows}>`」（opencode 同款）。`historyBuffer` 数据结构保留，仅渲染出口换。
3. **自管视口退役**：scroll-viewport.ts/wheel-interceptor.ts 保留代码但主路径切 scrollbox 原生
   （P3 再清理）。
4. **通知通道回归**：externalOutputMode 变 passthrough 后裸 `console.log` 会打穿 TUI 帧 ⇒
   writeFallback 策略需改为「onNotice 渠道 / renderer suspend 期间缓冲」（interactive.ts:139-200 的
   三级分派保留，仅兜底出口换）。
5. **退出补印 epilogue**：destroy 后打 Session/Continue 行（对齐 opencode，用户从 alt screen 回来
   不失上下文）。

---

## 4. 分片改造方案 v2（P0→P6，每片带验收+截图验证点）

> 原则：**全面对标 opencode**（用户明令）。P0 是架构地基，P1-P5 在其上补齐；
> 每片独立 commit/验收/截图，走 #4278 片模式（TDD + DS 交叉验证 + 不 merge main 等授权）。

### P0 全屏架构切换（对标「不混命令行」，最高优先）
- `interactive.ts:1005-1009`：`screenMode:"split-footer"` → `"alternate-screen"`；
  `externalOutputMode:"capture-stdout"` → `"passthrough"`（强绑定校验，必须同改）。
- 历史承载：commitHistory 链路 `writeSolidToScrollback` → 响应式 rows + scrollbox `<For>`；
  输入框 flex 常驻底部（scrollbox flexGrow=1 + 底部 flexShrink=0）。
- 通知兜底出口改造（passthrough 下 console.log 打穿帧）。
- 退出恢复主屏 + epilogue（Session/Continue 行，对齐 opencode）。
- **验收**：①boot 时上方**无任何** shell 历史（pyte 断言第 0 行起即 TUI）；②对话多轮+resize 后
  无残影；③退出后 shell 提示符+epilogue 正常；④通知（sendLark 模拟）不丢不错序。
- **截图**：boot 全屏 vs opencode-02-home.png 并排；退出后终端态。

### P1 布局结构（三段式+状态栏统一）
- 三段式：消息区（scrollbox）+ 沉底输入框 + **全宽状态栏**（单一来源 hints）。
- 状态栏对齐 opencode 分组：`esc interrupt · model · ctx% · ctrl+p commands · git 分支`
  （git 分支：roy 现无，需接 detectGitBranch——已有 main 护栏测试的模块）。
- 提示语收敛：Ctrl+C to exit / working… / /exit to quit → 状态栏统一一处。
- **验收**：①输入框恒贴底（长内容不被顶走）；②状态栏分组与 opencode 语义一一对应；
  ③窄终端降级不溢出。
- **截图**：对话中全屏 vs 用户图1（opencode 会话态）并排。

### P2 粘贴通道（原 P0，痛点②）
- 换 `<textarea>`（opentui solid 组件，原生 handlePaste/PasteEvent）或手写编辑器+renderer paste
  事件接线：`decodePasteBytes` → CRLF 归一化 → 折叠占位。
- **对齐 opencode 折叠行为**（已实测确认）：≥3 行或 >150 字符 → 输入框显示 `[Pasted ~N lines]`
  占位（原文入粘贴缓冲，提交时全量带上）；<3 行直接入框
  （参照 component/prompt/index.tsx:1464-1475）。
- `ctrl+v` → 剪贴板（OSC52/host）→ 同一 paste 路径。
- **验收**：pty 注入 `ESC[200~line1\nline2\nline3ESC[201~` → 显示 `[Pasted ~3 lines]` 且提交完整
  （对照 roy 现状 0 响应）；短粘贴直接入框。
- **截图**：roy-paste-after vs opencode-03-paste.png 并排。

### P3 键盘滚动 + 滚动条（原 P1，痛点①）
- scrollbox 原生能力 + 键位接 `@opentui/keymap`（或最小 useKeyboard 层）：
  pageup/pagedown 半页、home/end 首尾、ctrl+alt+u/d 半页（对齐 opencode keybind.ts:181-187）。
- 滚轮步进对齐 opencode 默认 3 行（CustomSpeedScroll(3)，util/scroll.ts:26-33）。
- 右侧 1 列滚动条（scrollbox verticalScrollBarOptions，opencode 同款 track 配色）+
  非钉底「Jump to latest ↓」（index.tsx:1561-1580 同款）。
- **验收**：SGR pageup → 视口回退 ≈ height/2；home → 顶；滚动条位置随 offset 变化；
  新内容到达未钉底时提示可见。
- **截图**：滚动中态（滚动条+Jump 提示）。

### P4 消息视觉 + markdown 真渲染（痛点③主体）
- 用户消息块：深灰底（backgroundPanel）+ 左竖条（border-left rail，opencode UserMessage 同款）
  + hover 加深。
- assistant 元信息行：`Build · <model> · <耗时>s · <tok/s>`（补 turn 计时与 tok/s；
  纯 formatter 扩展 usage-format.ts）。
- Thought 折叠行：`+ Thought · <耗时>`（#4278 已有 thinking 点击展开，补计时+行样式对齐）。
- markdown 真渲染：heading 去 `#` 前缀改主题色加粗、表格 grid 边框 + **CJK 双宽列宽**
  （wcwidth 或等价）、代码块样式对齐。
- 图标统一：role 标签纯文本化（You/Agent/Build），emoji 仅在支持字形时叠加。
- **验收**：①回复含 `##`/`**`/表格的渲染无裸奔符号；②表格中文列对齐（pyte 逐列断言）；
  ③元信息行数据正确（耗时/tok/s 与 usage 一致）；④无豆腐块。
- **截图**：三类消息 + markdown 表格 vs opencode 会话态并排。

### P5 主题工程（原 P3）
- `tui-solid/theme/`：Token 集（primary/secondary/accent/error/warning/success/text/textMuted/
  background/backgroundPanel/backgroundElement/border/borderActive/borderSubtle）+ dark/light +
  默认主题对齐 opencode.json（深灰阶+蓝 accent）。
- 组件全部改读 token；NO_COLOR 降级保留。
- **验收**：换主题全 UI 色变；NO_COLOR 全灰；色值与 opencode 基准截图逐段比对。
- **截图**：默认主题 vs opencode-02-home.png 并排。

### P6 opentui 升级 0.6.6→0.8.2（收益放大器，可选）
- 解锁：Textarea onPaste 成熟化、原生 `<markdown>`（tableOptions grid）、MacOSScrollAccel、
  keymap addons。升级后评估 P2/P4 是否换原生实现。
- 风险：0.6.6→0.8.x breaking（split-footer 行为/alt-screen 细节/事件名）需全套回归。
- **验收**：`bun --conditions=browser test packages/cli/src/tui-solid/` 全绿 +
  e2e-interactive-solid.py 五场景全绿 + 本方案全部截图验证点复跑。
- **截图**：升级前后 boot/对话并排（零回归确认）。

### 建议顺序
**P0（全屏地基）→ P1（布局+状态栏）→ P2（粘贴）→ P4（视觉+markdown）→ P3（滚动）→ P5（主题）→ P6（升级）**。
P0/P1 完成即解决用户最新反馈的两大主诉（不混命令行 + 输入框锚定）；P2-P4 补齐 v1 三痛点；
P5/P6 打磨。每片独立可交付，用户可在任意分片后验收观感。

---

## 5. 风险清单 v2（新增 alt-screen 专项）

| 风险 | 等级 | 缓解 |
|---|---|---|
| alt-screen 后终端 scrollback 历史「不可见」（用户习惯往上翻 shell） | 中 | 对齐 opencode 语义：会话历史在 TUI 内滚动（P3）；退出恢复主屏+epilogue；长期可做 export/transcript |
| capture-stdout→passthrough 后裸 console.log 打穿 TUI 帧 | 高 | P0 专项：通知兜底改 onNotice/缓冲；e2e 断言不错序 |
| 历史承载重构（scrollback→scrollbox）引入 flicker/性能回退 | 高 | opencode 同架构已验证可行；opentui testRender+mockMouse 断言 + #4278 e2e 全套回归 |
| streaming 高频重绘整树（rows 数组 signal 更新） | 中 | 对齐 opencode：rows 分片 commit + scrollbox 只重算可视区；必要时节流 |
| P4 CJK 宽度改造影响 run 链路共用 render/markdown.ts | 中 | fork 或加 opt-in 参数；#4278 先例（tui-solid fork 策略） |
| P6 升级 breaking | 高 | 独立分片最后做；不升级也能交付 P0-P5 |
| resize 时 alt screen 重绘异常 | 低 | opencode 有 resizeDebounce（100ms）先例；截图验证点覆盖 |

## 6. 工作量评估 v2

| 分片 | 规模 | 预估（含 TDD+截图） |
|---|---|---|
| P0 全屏架构 | options 2 处 + 历史承载重构 + 通知通道 + epilogue | **1.5~2.5 天** |
| P1 布局+状态栏 | 三段式 flex + statusline 分组 + git 分支接线 | 1 天 |
| P2 粘贴 | textarea 或 paste 接线 + 折叠占位 | 0.5~1 天 |
| P3 滚动 | 键位 + 滚动条 + Jump | 0.5~1 天 |
| P4 视觉+markdown | 4 组件 + markdown.ts 增强（CJK/heading/表格） | 1.5~2 天 |
| P5 主题 | theme 模块 + 全组件接线 | 1~2 天 |
| P6 升级 opentui | 全量回归 | 1~2 天 |
| **合计** | | **6.5~10 天** |

## 7. 截图验证方案 v2

- **基准已备**：`/tmp/tui-baseline/` 6 张（roy boot/paste-fail/wheel-5up +
  opencode whatsnew/home/paste）+ 用户 3 张实测截图（全屏会话态是 P0/P1 目标观感）。
- **方法**：同几何（112×30）真 pty + pyte + PIL（scripts/tui-solid/capture-4954/ 已有 6 脚本），
  每片验收时产出「改前/改后 vs opencode 基准」三联 PNG；图片按 reports/ 惯例 gitignore，脚本 commit。
- **断言升级**：P0 用 pyte 断言「boot 时第 0 行即 TUI 内容」（无 shell 历史混入）；
  P1 断言输入行恒在最后一行；P4 逐列断言表格对齐。

## 8. 与 v1 方案的差异摘要

- 架构：split-footer → alternate-screen（核心变更）
- 分片：原 P0-P5 → 新 P0-P6（粘贴 P0→P2、键盘滚动 P1→P3、主题 P3→P5、升级 P5→P6；新增 P0 全屏/P1 布局）
- 优先级：按用户最新反馈重排——先「不混命令行+锚定」（P0/P1），再 v1 三痛点（P2/P3/P4），后打磨（P5/P6）
- 验收：全部带与 opencode 基准同几何并排截图；P0 增加无残影/无历史混入专项断言
