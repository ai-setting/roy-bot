# Task #5109 P7 — TUI 斜杠命令：摸底报告 + 命令清单

> 分片：roy-bot interactive TUI 对齐 opencode 工程（Task #4954）P7。
> 摸底基线：opencode v2.2.5（/tmp/opencode-src）vs roy-bot main @ 421e2002（P5 已合入）。
> 日期：2026-11-06

---

## 1. opencode 的命令面（摸底结论）

### 1.1 命令定义形状（`packages/plugin/src/tui/context.ts:407-433`）

```ts
export interface KeymapCommand {
  readonly id?: string            // 稳定标识（配置 keybind 用）
  readonly title?: string         // 展示名（discovery / palette UI）
  readonly description?: string   // 长描述
  readonly group?: string         // 分组（palette/keyboard-help UI 分节）
  readonly enabled?: boolean | (() => boolean)
  readonly bind?: false | string
  readonly palette?: true         // 进命令面板
  readonly slash?: {              // 进输入框 / 斜杠补全
    readonly name: string
    readonly aliases?: string[]
    readonly arguments?: true     // 保留原文并传 raw input 给 run
  }
  readonly suggested?: boolean | (() => boolean)
  readonly run: (input?, event?) => void | false | Promise<void>
}
```

**结构**：`slash.name` + `aliases` + `description` + `group` + `run(input)`。
别名实例：`/exit` → aliases `["quit","q"]`（app.tsx:1180）、`/sessions` → `["resume","continue"]`（app.tsx:768）、`/pair` → `["web"]`。

### 1.2 opencode app.tsx 斜杠命令全集（`packages/tui/src/app.tsx:768-1180`）

| slash 名 | 别名 | 分类 | 说明 |
|---|---|---|---|
| sessions | resume, continue | Session | 切换会话 |
| new | — | Session | 新会话 |
| clear | — | Session | 清空会话 |
| open | projects, project | Session | 打开会话/项目 |
| models | — | Agent | 切换模型 |
| agents | — | Agent | 切换 agent |
| usage | — | Agent | 查看用量 |
| mcps | — | Agent | MCP 服务器 |
| variants | thinking, effort | Agent | 模型 variant |
| **connect** | — | Integration | **连接集成**（DialogIntegration 选 provider，成功后接模型选择） |
| highlights | — | System | 发布亮点 |
| settings | — | System | 设置 |
| status | — | System | 状态 |
| update | — | System | 更新 opencode |
| pair | web | System | 设备配对 |
| restart | — | System | 重启服务 |
| reload | — | System | 重载配置 |
| debug | — | System | 调试面板 |
| **themes** | — | System | 主题列表对话框（DialogThemeList） |
| theme.switch_mode | （无 slash，palette-only） | System | dark/light 直接切换（app.tsx:1138-1152） |
| help | — | System | 帮助 |
| exit | quit, q | System | 退出 |

### 1.3 输入框补全交互（`packages/tui/src/mini/footer.prompt.tsx` + `prompt/display.ts`）

- **触发**：`slashTriggerIndex()`（display.ts:33-41）——光标前最近 `/` 且 `/` 在行首或前一字符是空白；query 里无空白、无第二个 `/`。即**敲 `/`（行首）即触发**，继续输入成为过滤词。
- **补全面板**：`slashOptions` = 内置（editor/settings/new/compact/exit/quit/q）+ 注册表的 `commands()`（去重、按 `display` 排序）（footer.prompt.tsx:507-543）。
- **过滤**：fuzzysort（keys: name/display/description）（footer.prompt.tsx:562-570）。
- **键位**（`packages/tui/src/config/keybind.ts:276-280`）：
  - `up/ctrl+p` 上一项；`down/ctrl+n` 下一项
  - `escape` 关面板
  - `return` 选中执行（select）
  - `tab` 补全（complete；与 select 在斜杠场景几乎同义）
- **选中执行**：`select()`（footer.prompt.tsx:1030-1070）把 `/name` 替换进输入框并立即 submitPrompt；带参命令留 trailing space。空 query 面板打开时 Enter=执行高亮项。
- **执行端**：`submitPrompt`（footer.prompt.tsx:1367-1420）——exit 命令直接 `input.onExit()`；`parseSlashCommand` 解析 `command/arguments`。
- **历史模式**：↑↓ 在**无面板**时走历史导航；面板打开时 ↑↓ 是面板选择（分层 keymap，footer.prompt.tsx:1283-1335）。

### 1.4 命令面板（command-palette.tsx）——本轮不做

opencode 的 `CommandPaletteDialog` 是全局面板（74 行，DialogSelect 包装），roy-bot 本轮范围是**输入框斜杠补全**（用户原话「输入框通过 / 斜杠命令操作」）。面板复用同一注册表，后续分片可挂。

---

## 2. roy-bot interactive 现状（main @ 421e2002）

- **分发器已存在**：`packages/cli/src/slash.ts`（Task #2610）——纯函数 `dispatchSlashCommand(raw, ctx)`，run REPL 用。已支持 `/help /clear /exit /quit /model /history /workdir /max-lines`。
- **interactive 已接入**：`tui-solid/RunScreen.tsx:745-790` 的 `handleSubmit` 调用 `dispatchSlashCommand`，按 `SlashResult.kind` 分支（exit / handled / unknown / set-max-lines / pass）。
- **输入框**：`tui-solid/TextInput.tsx` —— `useKeyboard` 单一处理器（Ctrl-C / Enter / Backspace / Delete / ←→ / Home / End / ↑↓ 历史），可打印字符走 `key.sequence`。
- **主题**：`tui-solid/theme.ts`（P5）—— `resolveSolidTheme(env)` 按 `NO_COLOR` / `TERM=dumb` / `ROY_TUI_THEME=light` 解析；**当前是每次 render 读 env，没有运行时切换状态**。
- **组件**：`App.tsx`（scrollbox 消息区 + 底部区 StatusBar/输入框/错误）、`StatusBar.tsx`、`Markdown.tsx`、`Spinner.tsx`、`ToolCall.tsx` —— P5 已全部 token 化。

### 现状缺口（对照 opencode）

| 缺口 | opencode 有 | roy-bot 现状 |
|---|---|---|
| 斜杠补全面板 | footer.prompt.tsx 全套（触发/过滤/↑↓/Tab/Enter/Esc） | ❌ 无 |
| 命令注册表 | KeymapCommand + slash{name,aliases} | ❌ 无（slash.ts 是 switch-case 硬编码） |
| 运行时主题切换 | theme.switch_mode（app.tsx:1138） | ❌ 无（只有启动前 env） |
| /connect 语义 | DialogIntegration（选 provider 集成） | ❌ 无对应概念 |

---

## 3. 命令清单与语义映射（roy-bot interactive 场景）

### 3.1 首版命令集（进入补全面板 + 可执行）

| 命令 | 别名 | 分类 | 说明 | 与 opencode 对应 |
|---|---|---|---|---|
| `/help` | — | System | 列出可用斜杠命令 | `help` |
| `/exit` | `/quit`, `/q` | System | 退出 interactive | `exit`（别名一致） |
| `/clear` | — | Session | 清空当前会话历史 | `clear` |
| `/model` | — | Agent | 显示当前模型 | `models`（本仓只读显示，非切换） |
| `/theme` | — | System | 运行时切换 dark/light 主题 | `themes`（本仓是 mode 直切，无主题列表） |

补充保留（**不在 P7 注册表里**，仍由 `slash.ts` 的 legacy 分发器兜底 ——
`RunScreen.handleSubmit` 在注册表未命中时调用 `dispatchSlashCommand`）：
`/history`、`/workdir`、`/max-lines N`。

> ⚠️ **DS r4 MINOR-3 修正**：早期版本这里写的是「本轮纳入注册表」——
> 实际注册表只有 5 条（§3.1），这三条**不在面板里**，但**能用**（legacy 兜底）。
> P7 已在 `/help` 输出里补一行 `Also: /history /workdir /max-lines N (legacy)`
> 以保证可发现性；并由 `TextInput.p7-slash.test.tsx` 的回归用例锁住
> 「面板不得劫持它们」（DS r3 MAJOR-1）。

### 3.2 `/connect` 的语义结论：**本轮不做，但给替代 + 明确理由**

**opencode 的 /connect 做什么**：`DialogIntegration` —— 配置第三方服务集成（auth 账号），成功后接模型选择（app.tsx:1019-1031）。它是 **provider 认证/集成接入** 的 UI。

**roy-bot interactive 里的语义判定**：

roy-bot 的 provider / auth 接入**不在 interactive 进程内**，而在：
- 配置文件 `~/.config/roy-bot/config.jsonc` 的 `provider` 块（provider id / baseURL / apiKey 引用）；
- `roy-bot auth` 子命令（若存在）；
- 环境变量（API key）。

也就是说，**roy-bot 的「接入」是配置态而非运行时态**：interactive 进程启动时已加载 config，运行中改 provider 需要重载配置 + 重启会话。

**结论**：
1. **本轮不实现 `/connect` 交互式接入对话框**——那属于「配置对话框」范畴（opencode 侧对应 `dialog-config.tsx` / `DialogIntegration`），工作量与 P7 的「输入框补全 + 命令执行」不同量级，且需要 auth 凭据写入路径的单独设计。
2. **替代**：`/model` 显示当前 provider/model（`props.model` 已有），并在描述里提示接入方式是编辑 `~/.config/roy-bot/config.jsonc` 的 provider 块；`/status` 类信息由 P7 首版 `/help` 与现有 StatusBar 承载。
3. **不做的理由（写进本文件，供后续分片引用）**：interactive 是**单会话前台进程**，接入第三方账号需要 auth 流程 + 凭据落盘 + provider 列表刷新三件事，与 opencode 的 server-side session 管理不同构；opencode 之所以能弹窗接入，是因为它有常驻 server + `client.api.location.reload`（app.tsx:1100-1116）。roy-bot 没有等价的服务端连接层 ⇒ **照搬会产生「看起来能点、实际没法用」的假入口**。

### 3.3 明确不做 / 后续分片

| opencode 命令 | 本轮 | 理由 |
|---|---|---|
| `/connect` | ❌ | 见 §3.2 |
| `/sessions` `/new` `/open` | ❌ | 需要会话列表 UI（分片 P8 候选） |
| `/models`（切换） | 只读 `/model` | 切换模型需要 `local.model` 状态 + provider 列表（P8） |
| `/agents` `/mcps` `/usage` `/variants` | ❌ | 依赖 runtime 数据源，P8 |
| `/settings` `/status` `/debug` `/reload` | ❌ | 依赖配置/服务层 |
| `/pair` `/update` `/restart` | ❌ | 无对应概念 |
| 命令面板（ctrl+x ctrl+c） | ❌ | 本轮只做输入框斜杠补全；注册表结构为其预留 |

---

## 4. 实现设计要点

### 4.1 命令注册表（新增 `packages/cli/src/tui-solid/slash-registry.ts`）

```ts
export interface SlashCommandSpec {
  name: string;                 // 主名（不含 /）
  aliases?: string[];           // 别名（不含 /）
  description: string;          // 面板里的一行描述
  group?: string;               // 分组
  run: (args: string) => SlashCommandOutcome;   // handler
}
```

- 纯函数、无 I/O ⇒ 可确定性测试（TDD 友好）。
- `matchSlashCommand(specs, raw)`：按 name/aliases 匹配，返回 `{ spec, args }`。
- `filterSlashCommands(specs, query)`：过滤（name 前缀 + description 子串，命中 name 优先排序）。

### 4.2 补全面板（新增 `packages/cli/src/tui-solid/SlashPalette.tsx` + 状态机 `slash-palette-state.ts`）

- 状态机纯函数：`{ open, query, selectedIndex }`，迁移：
  - `open`（输入框首字符 `/`）→ `filter`（继续输入）
  - `up` / `down` → 移动 selectedIndex（**clamp**，不循环，与 opencode footer.menu 一致）
  - `escape` → close
  - `tab` → 选中并把 `/name ` 写入输入框（补全，不立即执行）
  - `return` → 选中并执行
- **键位冲突**：TextInput 的 `↑↓` 是历史导航 ⇒ 面板打开时 ↑↓ 必须被面板**接管**（历史不动）。这与 opencode 的分层 keymap（`enabled: visible()`）语义一致。
- **Esc 冲突**：RunScreen 的常驻 `useKeyboard` 把 ESC 当「打断流式」⇒ 面板打开时 ESC 必须**只关面板**，不打断。

### 4.3 /theme 运行时切换

- `theme.ts` 新增**运行时 mode 状态**：`setTuiThemeMode(mode)` / `getTuiThemeMode()`，默认从 env 解析（`resolveSolidTheme` 保持既有语义）。
- `resolveSolidTheme()` 改为「运行时 mode 优先，env 仅作初始值」。
- 切换后需要**重绘** ⇒ 通过 opentui 的 `renderer.requestRender()`（组件层可拿 renderer）或让依赖 theme 的组件订阅一个 signal。
- **颜色一律走 token**（P5 体系）⇒ 面板本身也用 `theme.backgroundPanel` / `borderActive` / `textMuted` / `primary`，不得新增硬编码色。

### 4.4 交付物

| 交付物 | 路径 | 状态 |
|---|---|---|
| 摸底 + 命令清单 | `docs/task-5109-p7-slash-commands.md`（本文件） | ✅ |
| 命令注册表 | `packages/cli/src/tui-solid/slash-registry.ts` | ✅ |
| 补全面板状态机 | `packages/cli/src/tui-solid/slash-palette-state.ts` | ✅ |
| 补全面板 UI | `packages/cli/src/tui-solid/SlashPalette.tsx` | ✅ |
| 主题运行时切换 | `packages/cli/src/tui-solid/theme.ts`（扩展） | ✅ |
| 接线 | `packages/cli/src/tui-solid/TextInput.tsx` + `RunScreen.tsx` | ✅ |
| 测试 | 5 个新文件 + 全量 0 fail | ✅ |
### Test evidence (cross-file reference)
- slash-registry.test.ts: 17 pass
- slash-palette-state.test.ts: 20 pass  
- theme.p7.test.ts: 9 pass
- interactive-slash-commands.test.ts: 10 pass
- SlashPalette.test.tsx: 8 pass (--conditions=browser)
- tui-solid full: 404 pass / 11 skip / 0 fail (browser mode)
- tui-solid full: 241 pass / 179 skip / 0 fail (serial mode)

---

## 附录 A. P7 收尾补记（2026-11-06 验收轮）

### A.1 /connect 用户澄清（推翻 §3.2 部分前提 → 立项 P7.1/P8）

用户 2026-11-06 17:24 飞书补充：`/connect` 的期望不是 server 侧集成，而是
**本机 auth.json 配置弹窗**——展示 provider 列表 + 可添加 provider 与 apikey，
持久化到 `~/.roy-bot/auth.json`。

- 这推翻了 §3.2「无 server 连接层 ⇒ 不做」的理由（该理由针对 DialogIntegration
  auth 流程，而用户要的是本机配置 UI）。
- 事实核查：roy-bot 读侧已支持 `~/.roy-bot/auth.json` providers
  （`llm.config-fallback` 读侧证据在库），缺的是 **UI 弹窗 + 写侧持久化**。
- 结论：作为 **P7.1 / P8 首条命令立项**，不在本轮 P7 范围内实现。

### A.2 帧级截图（goals 子项 7 补齐）

| 文件 | 状态 | 内容（understand_image 核验） |
|---|---|---|
| `/tmp/tui-p7/p7-01-idle.png` | ✅ | 无面板，输入框 + "( / for commands)" 提示 |
| `/tmp/tui-p7/p7-02-slash-trigger.png` | ✅ | 面板展开：5 条命令 + 描述，/help 高亮（▶ + 橙色 + 亮底） |
| `/tmp/tui-p7/p7-03-filter-he.png` | ✅ | 过滤后仅剩 /help /model /theme（/exit /clear 被滤除） |

- 截图链路：`scripts/tui-solid/frame-shot-p7.tsx`（bun --conditions=browser）
  → frame-*.txt + spans-*.json → `scripts/tui-solid/frames-to-png-p7.py`（PIL）。
- 为什么不用 RunScreen + typeText：bun 内置 JSX 急求值 ⇒ typeText 后帧不重绘
  （RunScreen.anchor 的 REPAINTABLE=false 同一实测约束）。SlashPalette 是
  **受控组件**（query/selectedIndex/visible 全 props），初始 props 即状态
  ⇒ 首帧即真实面板内容。
