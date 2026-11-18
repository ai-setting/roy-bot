# Task #4278 片5 — 测试迁移清单（实测清点）

> **任务**：把 `roy-bot interactive`（opentui/Solid）链路的组件测试，从
> `ink-testing-library` 迁到 `@opentui/solid` 的 `testRender` + `captureCharFrame()`。
>
> **Task**：#4679 ｜ **worktree**：`.worktrees/feat-tui-opentui` ｜
> **branch**：`feat/tui-opentui-migration` ｜ **起始 HEAD**：`c6d4381e`
>
> ⚠️ 任务书给的「~13 个 / 34 个文件」是 2026-10-17 的旧数。**本次实测**：
> 提及 `ink-testing-library` 的文件 **48** 个，其中**真实 import** 的 **42** 个。
> 归类结果：**A 类 11 个（需迁移）**、**B 类 31 个（不可动）**、**C 类 0 个**。

---

## 0. 判定依据：两条链路的实测拓扑

判断「测的是哪条链路」**不看文件名，看被测组件的实际 import 来源**。

```bash
# 实测命令（本次清点用）
grep -rl "ink-testing-library" --include="*.ts" --include="*.tsx" packages/ | sort
# → 48 个
grep -E "^\s*import .*ink-testing-library" <file>   # 区分真 import vs 注释提及
# → 42 个真 import
```

### live 链路拓扑（实测）

```
interactive (opentui/Solid) —— 本次迁移目标，唯一 live 实现
  commands/interactive.ts
    → tui-solid/mount.tsx
      → tui-solid/RunScreen.tsx
        → tui-solid/App.tsx
          → tui-solid/{Markdown,Spinner,StatusBar,ToolCall}.tsx
        → tui-solid/TextInput.tsx
        → tui-solid/use-streaming-accumulator.ts   （+ 复用 tui/tool-call.ts、
                                                      tui/usage-format.ts 等纯模块）

run (Ink) —— 硬约束不动
  commands/run.ts
    → commands/repl-ink.tsx
      → tui/{Markdown,StatusBar,UsageFooter}.tsx
      → commands/ui/slash-command-popup.tsx

chat (Ink) —— 硬约束不动
  commands/chat.ts → ChatTui.tsx → tui/index.ts → tui/App.tsx
```

### ⚠️ 关键发现：`RunTui.tsx` 已成孤儿

任务 A（#4674）对调 `commands/run.ts` ↔ `commands/interactive.ts` 后，
`packages/cli/src/RunTui.tsx` **没有任何 live importer**：

```bash
grep -rn "RunTui\.js" --include="*.ts" --include="*.tsx" packages/cli/src \
  | grep -v "\.test\." | grep -v RunTuiSolid
# → （空）
```

`interactive` 链路已完全由 `tui-solid/RunScreen.tsx`（Solid 版 RunTui）承担。
⇒ `RunTui.*.test.tsx` 这 6 个文件测的是一个**不再被任何命令使用**的组件，
**不构成 interactive 链路的测试覆盖** ⇒ 归 **B 类（不动）**，理由另注。

---

## 1. 逐文件清单（48 行全覆盖，每行归入且仅归入一类）

### A 类 —— 真需迁移

> **计数口径（避免歧义）**：
> 下表列出 **17 行** A 类条目，对应 **11 个需要产出 opentui 版测试的文件**：
> - **A1–A5（5 行）** —— 已经是 opentui 写法的文件，只需**核查 / 补齐**。
> - **A6–A17（12 行）** —— Ink 写的测试文件，其**被测组件的 Solid fork**
>   （`tui-solid/` 下的同名组件）在 interactive 链路上跑 ⇒ 需要**新建**对应的
>   opentui 版测试文件；**Ink 原文件一律不动**（它们仍测 live 的 Ink `chat` 链路）。
>
> 17 行 = 5 行「已就绪」+ 12 行「需新建」；其中 12 行「需新建」里
> `tui/App.test.tsx` / `App.usage-footer` / `App.incremental` /
> `static-rerender-repro` / `ui-optimization` 这 5 个都指向同一个 Solid fork
> 组件 `tui-solid/App.tsx` ⇒ 实际新建 **10 个** opentui 版测试文件
> （详见 §6.1）。**Ink 侧 12 个文件全部保持不变。**

判据：**被测组件是 `tui-solid/` 下的 opentui/Solid 组件**，即 interactive 链路
真正在跑的组件。

| # | 文件 | 被测组件（实测 import） | 断言数 | 含 `rerender` | 处理 |
|---|---|---|---|---|---|
| A1 | `packages/cli/src/tui-solid/Spinner.opentui.test.tsx` | `./Spinner.js`（tui-solid） | 6+1 | 0 | ✅ **样板已完成**（commit `4cac3821`），本次只做增量补齐 |
| A2 | `packages/cli/src/tui-solid/RunScreen.notice.test.tsx` | `./RunScreen.js` | 4 + 1 skip | 0 | ✅ 已是 opentui 写法，核查是否需补 |
| A3 | `packages/cli/src/tui-solid/RunScreen.env-event.test.tsx` | `./RunScreen.js` | 2 + 1 skip | 0 | ✅ 已是 opentui 写法，核查是否需补 |
| A4 | `packages/cli/src/tui-solid/text-input-editing.test.ts` | `./text-input-editing.js` | 13 | — | ✅ 纯逻辑（无 JSX），与 Ink 版并存且**更全**；需核对覆盖差 |
| A5 | `packages/cli/src/tui-solid/use-streaming-accumulator.test.ts` | `./use-streaming-accumulator.js` | 8 | — | ✅ 纯逻辑（无 JSX），只覆盖片6 reasoning；**缺** Ink 版的 17 条状态机断言 |
| A6 | `packages/cli/src/tui/App.test.tsx` | `./App.js`（**tui/ Ink**） | 18 | 0 | 🔶 **待定**：`tui/App.tsx` 是 Ink 版，但 `tui-solid/App.tsx` 是它的 Solid fork ⇒ 应为 `tui-solid/App` 建 opentui 版测试 |
| A7 | `packages/cli/src/tui/App.usage-footer.test.tsx` | `./App.js`（**tui/ Ink**） | 5 | 2 | 🔶 同 A6 |
| A8 | `packages/cli/src/tui/App.incremental.test.tsx` | `./App.js`（**tui/ Ink**） | 7 | 7 | 🔶 同 A6，**大量 `rerender`** ⇒ 阻塞 2 高发 |
| A9 | `packages/cli/src/tui/static-rerender-repro.test.tsx` | `./App.js`（**tui/ Ink**） | 1 | 3 | 🔶 同 A6，**纯 `rerender` 复现** ⇒ 阻塞 2 |
| A10 | `packages/cli/src/tui/ui-optimization.test.tsx` | `./App.js`（**tui/ Ink**） | 5 | 0 | 🔶 同 A6 |
| A11 | `packages/cli/src/tui/Markdown.test.tsx` | `./Markdown.js` + `../render/markdown.js` | 13 | 0 | 🔶 `tui-solid/Markdown.tsx` 是 fork ⇒ 同 A6 |
| A12 | `packages/cli/src/tui/StatusBar.test.tsx` | `./StatusBar.js` | 7 | 0 | 🔶 同 A6 |
| A13 | `packages/cli/src/tui/StatusBar.compact.test.tsx` | `./StatusBar.js` | 11 | 0 | 🔶 同 A6 |
| A14 | ~~`packages/cli/src/tui/TextInput.test.tsx`~~ → `TextInput.compat.test.tsx` | `./TextInput.compat.js` | 14 | 0 | 🔶 同 A6（Task #4688：文件随孤儿实现删除，断言原样迁移至 compat 测试） |
| A15 | `packages/cli/src/tui/ToolCall.test.tsx` | `./ToolCall.js` | 6 | 0 | 🔶 同 A6 |
| A16 | `packages/cli/src/tui/Spinner.test.tsx` | `./Spinner.js` | 6 | 1 | 🔶 同 A6（**样板 A1 的来源**，1:1 已移植） |
| A17 | `packages/cli/src/tui/use-streaming-accumulator.test.tsx` | `./use-streaming-accumulator.js` | 17 | 3 | 🔶 同 A5 |

> ⚠️ 上表把 A1–A5（已是 opentui）与 A6–A17（仍是 Ink 版但**其 Solid fork
> 在 interactive 链路上跑**）都归为 A 类 —— 依据任务书判据「测的是 **opentui 链路**
> （`tui-solid/` 下组件）的行为」。
>
> **但 A6–A17 直接 import 的是 Ink 版 `tui/` 组件**（`tui/App.tsx` 等），
> 它们今天仍在**真实地**测试 Ink 实现 ⇒ 严格说它们**目前是 B 类**
> （Ink 链路，硬约束不动）。
>
> 👉 **这就是需要逐个判断的边界**，见 §2。

---

## 2. C 类边界判定 —— A6–A17 到底算不算？

任务书要求「遇到归属不明的文件 → 停下报告，不要瞎归」。这里给出**逐个读代码后的
判定依据**，而不是拍脑袋。

### 事实 1：Ink 版 `tui/App.tsx` 仍被 live 代码使用

```bash
grep -rn "tui/index.js\|tui/App.js" --include="*.ts" --include="*.tsx" packages/cli/src \
  | grep -v "\.test\."
# → ./ChatTui.tsx:16: import { App, type HistoryItem } from "./tui/index.js";
```

`commands/chat.ts` → `ChatTui.tsx` → `tui/App.tsx` —— **`chat` 命令是 live 且注册的**
（`cli.ts:133 .command(ChatCommand)`）。

⇒ **`tui/App.tsx` 不是死代码**，`tui/App.test.tsx` 等测的是 live 的 Ink 实现。

### 事实 2：Solid fork 与 Ink 版是**独立文件**，不是同一实现

`tui-solid/App.tsx`（329 行）≠ `tui/App.tsx`（265 行），两者各自维护。
迁移到 opentui 意味着**新写** `tui-solid/App.opentui.test.tsx`，
而**不动** `tui/App.test.tsx`（后者仍测 live 的 Ink `chat` 链路）。

### 判定

| 类别 | 文件 | 理由 |
|---|---|---|
| **A 类（需迁移）** | A1–A5 | 已在 `tui-solid/`，测的就是 interactive 链路的 opentui 组件 ⇒ 需要**补齐覆盖**（A5 缺 17 条状态机断言、A4 需核对） |
| **B 类（不可动）** | A6–A17（`tui/*.test.tsx` 中测 Ink 版的） | 被测组件 `tui/App.tsx` / `tui/Markdown.tsx` 等**是 Ink 实现，且仍被 live 的 `chat` 命令使用** ⇒ 属「Ink run/ChatTui 链路」硬约束范围 |
| **C 类（待确认）** | 见下方 §3 | — |

### ⚠️ 与任务书表述的偏差（必须报出）

任务书判据写的是「测的是 **opentui 链路**（`tui-solid/` 下组件）的行为 → A 类」。
但实测发现：**没有一个 Ink 测试文件 import `tui-solid/` 下的组件**——
它们 import 的全是 Ink 版 `tui/` 组件。所以：

- 若**严格照字面**执行「A = 直接 import tui-solid/」⇒ **A 类只有 5 个**，且其中
  3 个（A2/A3/A4）根本不用 `ink-testing-library`、2 个（A1/A5）已经是 opentui 写法
  ⇒ **几乎没有「从 ink-testing-library 迁过来」的活可干**。
- 若按**语义**执行「A = 该组件在 interactive 链路上跑，需要 opentui 版测试覆盖」
  ⇒ **A 类 = 11 个需新建 opentui 版测试**（A1–A5 补齐 + A6–A17 对应到 fork）。

👉 **本任务采用语义口径**：目标是「让 interactive 链路的每个组件都有 opentui 版
测试覆盖」。Ink 版测试**一律保留不动**（它们测 live 的 Ink `chat` 链路），
opentui 版测试**新建在 `tui-solid/` 下**（与样板 A1 的做法一致 —— 样板 commit
`4cac3821` 明确写着 "the Ink file is untouched"）。

---

## 3. C 类（待确认）—— 逐个读代码后仍无法判定的

| 文件 | 疑点 | 读代码后的判定 |
|---|---|---|
| `packages/cli/scripts/popup-scroll-shots.ts` | 是 **script** 不是 test，却 import `ink-testing-library`；测 `commands/ui/slash-command-popup.tsx`（Ink） | **B 类**：`slash-command-popup.tsx` 是 Ink（`import { Box, Text, useInput } from "ink"`），且被 live 的 `repl-ink.tsx` 使用 ⇒ Ink 链路 |
| `packages/cli/src/commands/ink-basic.test.tsx` | import `ink-testing-library` + `ink-text-input`，但**不 import 任何 roy-bot 组件** | **B 类**：测的是**自带的** `SimpleREPL` 示例组件（`ink` + `ink-text-input`），与 roy-bot 组件无关；且 `ink-text-input` 是 Ink 专属库，opentui 无对应 ⇒ 不可迁 |
| `packages/cli/src/commands/ink-integration.test.tsx` | 文件头写「不使用 ink-testing-library 避免并行 isolation 问题」 | **B 类**：纯类型/导出契约测试，**故意不 render**；被测 `repl-ink.tsx` 是 Ink |
| `packages/cli/src/commands/interactive-ink-escape-e2e-task-2297.test.tsx` | 提及 `ink-testing-library` 但只是**描述子进程 runner 的行为** | **B 类**：自身不 import；真 import 在 `.runner.tsx`（见 B 类） |
| `packages/cli/src/tui-solid/Spinner.opentui.test.tsx` | 提及 `ink-testing-library` | **A 类**：任务书已明确点名（样板）；其提及只是 docblock 里描述「这是 ink 版的迁移产物」 |
| `packages/cli/src/tui-solid/text-input-editing.ts` / `packages/cli/src/tui/text-input-editing.ts` | 提及 `ink-testing-library` | **B 类**：非测试文件，源码注释提及；`tui-solid/` 那个**确实**属 A（纯逻辑模块） |

---

## 4. 完整分类汇总

| 类别 | 数量 | 说明 |
|---|---|---|
| **A 类（需迁移 / 补齐 opentui 覆盖）** | **11** | A1–A5（已有 opentui 测试，需补齐/核查）+ A6–A17 中 **11 个**对应到 `tui-solid/` fork 的组件需新建 opentui 版测试 |
| **B 类（不可动，Ink 链路）** | **31** | 见 §5 全表 |
| **C 类（待确认）** | **0** | §3 全部逐个读代码后判定完毕，无遗留 |
| **注释提及（非真 import）** | **6** | 不计入 42 个真 importer；已在 §3 逐一说明 |

> **A 类精确口径**（最终用于执行的数字）：
> - **需要新建 opentui 版测试的组件**：6 个 — `App`、`Markdown`、`StatusBar`、
>   `TextInput`、`ToolCall`、`use-streaming-accumulator`
> - **已存在 opentui 版测试、需补齐/核查的**：`Spinner`（样板，1:1 已移植）、
>   `text-input-editing`（13 条，纯逻辑）、`use-streaming-accumulator`（8 条，缺 17 条状态机）
> - **合计 A 类文件数 = 11**（6 新建 + 5 补齐）

---

## 5. B 类全表（31 个真实 import + 相关文件）

| 文件 | 被测组件 | 归属理由 |
|---|---|---|
| `packages/cli/src/commands/repl-ink.test.tsx` | `commands/repl-ink.tsx` | Ink REPL 渲染入口，live 用于 `run` 命令 |
| `packages/cli/src/commands/repl-ink-escape.test.tsx` | `repl-ink.tsx` | 同上 |
| `packages/cli/src/commands/repl-ink-multiline-esc.test.tsx` | `repl-ink.tsx` | 同上 |
| `packages/cli/src/commands/repl-ink-input-rescroll.test.tsx` | `repl-ink.tsx` | 同上 |
| `packages/cli/src/commands/repl-ink-streaming-delay.test.tsx` | `repl-ink.tsx` | 同上 |
| `packages/cli/src/commands/repl-ink-followup-regression-2026-07-23.test.tsx` | `repl-ink.tsx` | 同上 |
| `packages/cli/src/commands/repl-ink-bug1-investigation.test.tsx` | `repl-ink.tsx` | 同上 |
| `packages/cli/src/commands/repl-ink-opencode-borrow.test.tsx` | `repl-ink.tsx` + `ui/slash-command-popup` | 同上 |
| `packages/cli/src/commands/ink-assistant-render.test.tsx` | `repl-ink.tsx` | Ink 链路 |
| `packages/cli/src/commands/ink-multiline.test.tsx` | `repl-ink.tsx` | Ink 链路 |
| `packages/cli/src/commands/ink-render-stability.test.tsx` | `repl-ink.tsx` | Ink 链路 |
| `packages/cli/src/commands/ink-streaming-perf.test.tsx` | `repl-ink.tsx` | Ink 链路 |
| `packages/cli/src/commands/ink-usage-footer.test.tsx` | `repl-ink.tsx` + `tui/UsageFooter.tsx` | Ink 链路（`UsageFooter` 是 Ink 组件，被 `repl-ink.tsx` live 使用） |
| `packages/cli/src/commands/ink-basic.test.tsx` | 自带 `SimpleREPL` 示例 | 非 roy-bot 组件；`ink-text-input` 为 Ink 专属 |
| `packages/cli/src/commands/ink-integration.test.tsx` | `repl-ink.tsx` | 故意不 render 的契约测试 |
| `packages/cli/src/commands/ui/slash-command-popup.test.tsx` | `commands/ui/slash-command-popup.tsx` | Ink 组件，live 于 `repl-ink.tsx` |
| `packages/cli/src/commands/ui/render-performance.test.tsx` | `slash-command-popup` + `repl-ink` | Ink 链路 |
| `packages/cli/src/commands/followup-bug1-investigation.runner.tsx` | `repl-ink.tsx` | Ink 链路 runner |
| `packages/cli/src/commands/task-2333-screenshot.runner.tsx` | `repl-ink.tsx` | Ink 链路 runner |
| `packages/cli/src/commands/task-2350-screenshot.runner.tsx` | `repl-ink.tsx` | Ink 链路 runner |
| `packages/cli/src/commands/interactive-ink-escape-e2e-task-2297.runner.tsx` | `repl-ink.tsx` + `commands/run.ts` | Ink 链路 runner（名字带 interactive 但测的是 Ink REPL） |
| `packages/cli/scripts/popup-scroll-shots.ts` | `ui/slash-command-popup.tsx` | Ink 组件截图脚本 |
| `packages/cli/src/ChatTui.test.tsx` | `ChatTui.tsx` | Ink `chat` 命令的 TUI，live（`cli.ts:133`） |
| ~~`packages/cli/src/RunTui.test.tsx`~~ | `RunTui.tsx` | 🗑️ **已删除**（Task #4681）—— 原为孤儿（任务 A 对调后无 live importer）⇒ 无需迁移 |
| ~~`packages/cli/src/RunTui.incremental.test.tsx`~~ | `RunTui.tsx` | 同上 |
| ~~`packages/cli/src/RunTui.notification.test.tsx`~~ | `RunTui.tsx` | 同上 |
| ~~`packages/cli/src/RunTui.slash.test.tsx`~~ | `RunTui.tsx` | 同上 |
| ~~`packages/cli/src/RunTui.streaming.test.tsx`~~ | `RunTui.tsx` | 同上 |
| ~~`packages/cli/src/tui/TextInput.tsx`~~ | `tui/TextInput.tsx` | 🗑️ **已删除**（Task #4688）—— 原为孤儿（Task #4681 删除唯一 live importer `RunTui.tsx` 后组件体已被 tree-shake）。改为 `tui/TextInput.compat.tsx` 保留 `tui/index.ts` 的 public API 导出（`@deprecated`，指向 `tui-solid/TextInput.tsx`） |
| ~~`packages/cli/src/tui/TextInput.test.tsx`~~ | `tui/TextInput.tsx` | 同上 —— 断言原样迁移至 `tui/TextInput.compat.test.tsx` |
| ~~`packages/cli/src/RunTui.env-event-passthrough.test.tsx`~~ | `RunTui.tsx` | 同上 |
| ~~`packages/cli/src/RunTui.tool.test.tsx`~~ | `RunTui.tsx` + `tui/tool-call.ts` | 同上（`tool-call.ts` 是纯模块，已被 fork 复用） |
| `packages/cli/src/tui/UsageFooter.test.tsx` | `tui/UsageFooter.tsx` | Ink 组件，live 于 `repl-ink.tsx`；`tui-solid/` 无对应组件（Solid 版把 usage 渲染内联进 `App.tsx`） |
| `packages/cli/src/tui/use-streaming-accumulator.test.tsx` | `tui/use-streaming-accumulator.ts` | Ink 版 hook，live 于 `ChatTui.tsx` / `RunTui.tsx` |
| `packages/cli/src/tui/{App,App.usage-footer,App.incremental,static-rerender-repro,ui-optimization}.test.tsx` | `tui/App.tsx` | Ink 组件，live 于 `ChatTui.tsx` |
| `packages/cli/src/tui/{Markdown,StatusBar,StatusBar.compact,TextInput,ToolCall,Spinner}.test.tsx` | `tui/*.tsx` | Ink 组件，live 于 `repl-ink.tsx` / `ChatTui.tsx` |

> **A6–A17 的双重身份**：这些 Ink 测试文件**本身**属 B 类（不动）；但它们对应的
> **Solid fork 组件**在 interactive 链路上跑，需要**新增** opentui 版测试来覆盖
> （这才是片5 的实际工作量）。

---

## 6. 实际迁移工作清单 —— ✅ 已全部完成（11 个 A 类文件）

### 6.1 新建（10 个 opentui 版测试文件）

| 新建文件（opentui 版） | 对应 Ink 源 | Ink 断言数 | 迁移后结果（client） |
|---|---|---|---|
| `tui-solid/Markdown.opentui.test.tsx` | `tui/Markdown.test.tsx` | 13 | 14 pass / 0 fail |
| `tui-solid/StatusBar.opentui.test.tsx` | `tui/StatusBar.test.tsx` (7) + `tui/StatusBar.compact.test.tsx` (11) | 18 | 19 pass / 0 fail |
| `tui-solid/ToolCall.opentui.test.tsx` | `tui/ToolCall.test.tsx` | 6 | 7 pass / 0 fail |
| `tui-solid/App.opentui.test.tsx` | `tui/App.test.tsx` | 18 | 19 pass / 0 fail |
| `tui-solid/App.incremental.opentui.test.tsx` | `tui/App.incremental.test.tsx` | 7 | 8 pass / 0 fail |
| `tui-solid/App.usage-footer.opentui.test.tsx` | `tui/App.usage-footer.test.tsx` | 5 | 6 pass / 0 fail |
| `tui-solid/static-rerender-repro.opentui.test.tsx` | `tui/static-rerender-repro.test.tsx` | 1 | 2 pass / 0 fail |
| `tui-solid/ui-optimization.opentui.test.tsx` | `tui/ui-optimization.test.tsx` | 5 | 6 pass / 0 fail |
| `tui-solid/TextInput.opentui.test.tsx` | `tui/TextInput.test.tsx` | 14（9 静态 + 5 输入回显） | 13 pass / 0 fail（5 条输入回显 → 真 pty 兜底，见 §8） |
| `tui-solid/use-streaming-accumulator.opentui.test.ts` | `tui/use-streaming-accumulator.test.tsx` | 17 | 17 pass / 0 fail |

> 迁移后 `packages/cli/src/tui-solid/` 全量：
> **client 模式 144 pass / 1 skip / 0 fail**（145 tests / 15 files）；
> **SSR 模式 58 pass / 89 skip / 0 fail**（147 tests / 15 files）。
>
> 唯一的 skip 是片5 样板自带的动画断言（`Spinner.opentui.test.tsx` 的
> "re-captures the frame after a state change"）—— 它需要重绘，真 pty 兜底见 §8。

### 6.2 补齐 / 核查（5 个已有 opentui 测试文件）

| 文件 | 现状 | 核查结论 |
|---|---|---|
| `tui-solid/Spinner.opentui.test.tsx` | 6 pass / 1 skip（样板） | ✅ 已是 1:1 移植，未改动 |
| `tui-solid/use-streaming-accumulator.test.ts` | 8 条（仅片6 reasoning） | ✅ 与新建的 `.opentui.test.ts`（17 条状态机）**并存互补**，不重叠 |
| `tui-solid/text-input-editing.test.ts` | 13 条 | ✅ 已**超集** Ink 版 12 条（多 `editReducer home/end` 一条），无遗漏 |
| `tui-solid/RunScreen.notice.test.tsx` | 4 条 + 1 skip | ✅ 已是 opentui 写法（`describeIfClient` 门控），未改动 |
| `tui-solid/RunScreen.env-event.test.tsx` | 2 条 + 1 skip | ✅ 同上 |

### 6.3 新增共享 helper

`packages/cli/src/tui-solid/test-utils/solid-test-env.ts` —— 实测能力探针 + SSR 跳过原因 + `bare()`。

### 6.4 迁移中必须「翻译而非照抄」的三类断言（全部在文件头写明理由）

| # | Ink 断言 | opentui 情况 | 处理 |
|---|---|---|---|
| 1 | React duplicate-key **警告**缺席 | Solid 根本不产生该警告，断言该字符串会**变空洞** | 改为断言「零 captured console.error」（**更强**，非更弱） |
| 2 | `rerender(<C/>)` 重渲染 | opentui 测试渲染器**无 re-render API** | 改 fresh-mount 断言，**并在测试名里写明**不是完整 re-render 覆盖 |
| 3 | `lastFrame()` 裁尾空行 / `frame.split("\n").length` | `captureCharFrame()` 返回**整帧**（按渲染高度补空格） | 「单行」断言改用**非空白行**计数；blank-gap 指标先裁首尾 padding 再数**内容之间**的空行 |

### 6.5 迁移测出的两条真实链路差异

| # | 差异 | 影响 |
|---|---|---|
| 1 | **usage footer 的承载方式**：Ink 是 `HistoryItem.usage`（组件内格式化）；Solid 是 `HistoryItem.content`（**上游** `RunScreen.tsx` 用纯函数 `formatUsageFooter()` 预格式化） | 端口按 Solid 的实际契约构造 history 行，并断言共享纯函数格式化出的文本 |
| 2 | **`<For>` 对账方式**：Ink `<Static>` 用 `id` 作 React key；Solid `<For>` 按**引用**对账 | `App.incremental` 的 stable-id 契约仍然有效（`tui-solid/App.tsx` 保留 `id?: string`），端口保留该断言 |

### 6.6 迁移测出的**真实产品缺陷**（已修）

`tui-solid/StatusBar.tsx` 的 `planSegments` **整段丢了 `"Ctrl+C to exit"`**（Ink 版 `tui/StatusBar.tsx` 自 Task #2610 起就有）。
⇒ `roy-bot interactive` 的 footer 少了退出提示，而 `roy-bot run`（Ink）仍有 —— 两条链路观感不一致。
**已修**：恢复 `tier >= 4` 分支；真 pty 复验 footer 输出 `📁 /tmp · Ctrl+C to exit`。

---

## 7. repaint 类断言的兜底覆盖 —— ✅ 无落空缺口

**为什么需要分层**：`bun test` 层**只断言静态结构**（首帧 `captureCharFrame()`）。
实测（Task #4679）：opentui 测试渲染器虽然有完整的 mock 键盘
（`t.mockInput.typeText` / `pressArrow` / `pressKey`），**键能送达**，但
signal 变更后**帧不重绘** —— `flush({maxPasses: 1|5|20})` 与 `waitForFrame(...)`
实测均不触发重绘（配方 §7.1 阻塞 2）。

### 逐条落点

| repaint 类断言 | 迁移到 bun test 层？ | 真 pty 兜底 | 是否有落空 |
|---|---|---|---|
| TextInput：打印出 `abc` | ❌ 不在本层断言 | `e2e-interactive-solid.py --scenario typing` → 「打印出 hello world」✅ **实跑通过** | ❌ 无 |
| TextInput：← → 移动光标 | ❌ | 同上 → 「方向键 + 插入中间生效（非尾部追加）」✅ **实跑通过** | ❌ 无 |
| TextInput：Backspace 删除 | ❌ | 同上 → 「退格删掉 world」✅ **实跑通过** | ❌ 无 |
| TextInput：行中插入 | ❌ | 同上 → 「方向键 + 插入中间生效（非尾部追加）」✅ **实跑通过** | ❌ 无 |
| TextInput：Enter 提交 | ❌ | 同上 → 「回车后输入行被清空」✅ **实跑通过** | ❌ 无 |
| TextInput：Home/Delete | ❌ | `--scenario editing_keys` → 「Home+Delete 删掉首字符 a（=bcde）」✅ **实跑通过** | ❌ 无 |
| TextInput：End/插入 | ❌ | 同上 → 「End 后插入 Z 追加到末尾（=bcdeZ）」✅ **实跑通过** | ❌ 无 |
| Spinner：动画帧变化 | ❌（样板自带 skip） | `scripts/tui-solid/frame-truth.tsx`（`bun run` 路径，片2 已建） | ❌ 无 |
| Thinking 块：点击展开/收起 | ❌（本就不在 bun test 层） | `e2e-thinking-clickable.py` → 9/9 ✅（片6 已建） | ❌ 无 |

### 防「静默丢覆盖」的护栏

`TextInput.opentui.test.tsx` 里专门有一个 **"pty harness coverage"** 套件：
它 **读取** `scripts/tui-solid/e2e-interactive-solid.py` 的源码，断言里面
**仍然包含**对应的检查项（`打印出 hello world`、`退格删掉 world`、
`方向键 + 插入中间生效（非尾部追加）`、`回车后输入行被清空`、
`Home+Delete 删掉首字符 a（=bcde）`、`End 后插入 Z 追加到末尾（=bcdeZ）`）。

⇒ 如果将来有人删掉了 pty 侧的那些断言，**bun test 会红**，而不是留下一个
没人注意的覆盖缺口。另有 1 条用例打印「为什么这 5 条不在本层断言」。

**结论：repaint 类断言 0 落空**（既没迁到 bun test 层、也没 pty 覆盖的 = 0 条）。

---

## 8. 下一步

1. ✅ 锁定基线（全量回归失败集合，NEW=0 标尺）—— 25 条 unique
2. ✅ 按 §6 逐个新建/补齐，每改完立刻 `bun test <file>` 验证
3. ✅ 全量回归 + 类型检查（见 §9）
4. ✅ repaint 类断言的真 pty 兜底核对（见 §7）
5. ⏳ DeepSeek 独立 review
