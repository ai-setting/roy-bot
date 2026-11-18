# Task #4278 — 主干功能保留验证报告（合并 main → worktree）

> **worktree**: `.worktrees/feat-tui-opentui` · **branch**: `feat/tui-opentui-migration`
> **main**: `ef9262fb` · **merge commit**: `eb8f87c1`
> **后续 commit**: `dbdd91fb`（usage-format 纯化）· `861a9002`（MINOR 注释）
> **日期**: 2026-10-30 · **作者**: `developer <dev@example.com>`
> **未 merge 回 main / 未 push / 未 tag**

---

## 结论（一句话）

**「main 的 8 项新功能在 worktree 上是否完好」→ 是。**
但**不是合并自动带来的**：合并前存在 **1 个真实缺陷**（V1），表现为"编译过、类型过、测试大部分绿，
但真机功能坏"。该缺陷已定位并修复，修复后 V1~V6 逐条通过。

---

## 0. 关键发现：V1 真实缺陷（本次验收的核心价值）

### 现象

main 原生护栏测试 `packages/cli/src/commands/shared/interactive-notify-chain.test.ts`
在合并后 **13 pass / 2 fail**（main 上应全绿）：

```
(fail) 组2 — envEvent 有值 → mergedContext.envEvent 必须是原样透传
       Expected: "evt_ORIGINAL"
       Received: "evt_1793326687539_43975271-..."     ← 被新 trigger 覆盖
(fail) 组9 — 通知轮（envEvent 有值）→ event_store 新增 0 行
       Expected: 0
       Received: 1                                    ← 每轮通知白写一条 trigger
```

### 根因（单点）

片6（thinking 可点击）为了支持 reasoning 回调，把 `onReasoning?: ReasoningDeltaCallback`
**插在 `onUsage` 之前**：

```ts
// packages/cli/src/commands/run.ts:598（修复前）
(message, onChunk, onTool?, onReasoning?, onUsage?, envEvent?)   // ❌ 插位
```

而 main 的 positional 契约是：

```ts
(message, onChunk, onTool?, onUsage?, envEvent?)                 // ✅ main 契约
```

⇒ main 的 5 位位置调用 `stream(msg, cb, undefined, undefined, notifyEvent)`
把 `notifyEvent` 塞进 **`onUsage` 位**，`envEvent` 实收 `undefined`
⇒ `emitUserTurnTrigger()` 判成"用户轮" ⇒ 又 emit 一条 trigger ⇒ **覆盖 envEvent + 多落 1 行**。

### 为什么这是最危险的类型

| 维度 | 结果 |
|---|---|
| 冲突 | ❌ 无（两侧都改了同一段但 git 自动合并） |
| 编译 | ✅ 通过 |
| `tsc` 类型检查 | ✅ 通过（worktree 内部自洽） |
| 测试 | 🟡 大部分绿，只有 main 的护栏能暴露 |
| 真机 | 🔴 **通知静默丢弃，无任何报错** |

⇒ 正是用户担心的「合并不冲突但功能坏」。

### 扩散面（3 处受损，不止 1 处）

1. `interactive-notify-chain.test.ts` — 13 pass / **2 fail**
2. `run-usage-forward.test.ts`（**main 原生**）— 2 pass / **1 fail**
   （`invokes onUsage when llm.completed carries usage` 期望 usages 长度 1，实得 **0**
   ⇒ main 的缓存/token 脚注功能**整体失效**）
3. `tui-solid/RunScreen.tsx` — opentui 侧**根本没有 envEvent 通道**：
   `streamHandleQuery(message, onChunk, onTool, onReasoning)` 只传 4 个参数，
   `handleNotification(message, _envEvent)` 收下就丢
   ⇒ 即便修好签名，opentui 下通知轮仍 envEvent=undefined → 落库 → 套娃

### 修复

| 文件 | 改动 |
|---|---|
| `packages/cli/src/commands/run.ts` | `onReasoning` 移到**末尾**（第 6 位），恢复 main 契约；注释写明「绝不插入既有参数中间」 |
| `packages/cli/src/tui-solid/RunScreen.tsx` | 补 envEvent 通道：`executeQuery(message, envEvent?)` → `handleNotification` 转发 → `streamHandleQuery(..., onUsage, envEvent, onReasoning)` 位置对齐；补上 main 的 usage footer |
| `packages/cli/src/commands/run.test.ts` | worktree 自有测试改用新位置契约 |
| `packages/cli/src/tui-solid/App.tsx` | usage footer 渲染为 `role:"usage"`（对齐 main 的无标题暗色脚注行），用**早返回**实现 ⇒ 净增类型错误 0 |
| `packages/cli/src/tui/usage-format.ts`（新） | 抽出纯模块（UsageLike / formatTokens / formatUsageFooter） |
| `packages/cli/src/tui/UsageFooter.tsx` | 改 import+re-export 纯模块，公开面不变 |

**修复后**：`bun test interactive-notify-chain + run-usage-forward + run.test.ts` = **55 pass / 0 fail**。

---

## 1. V1 — `emitUserTurnTrigger` 必须接到 stream 路径

**判定：✅ 通过**（修复后）

| 验收项 | 证据 |
|---|---|
| `createStreamHandleQuery` 内有 `emitUserTurnTrigger` | `run.ts:713-719`（流式路径）；one-shot 在 `run.ts:467-474` |
| 防套娃判据是「envEvent 是否存在」 | `run.ts:314` → `if (opts.envEvent) return undefined;` |
| `triggerEventDbPath` 透传到**两处** | `run.ts:474`（one-shot）+ `run.ts:719`（流式） |
| 通知轮 envEvent 原样透传 | `run.ts:494` + `run.ts:734` → `...(envEvent ? { envEvent } : triggerInjection ? triggerInjection : {})` |
| positional 签名 | `run.ts:594-627` → `(message, onChunk, onTool, onUsage, envEvent, onReasoning)` |
| **测试** | `interactive-notify-chain.test.ts` **15/15 全绿**（4 组断言专锁此链路） |

> DS 独立复核确认：「签名、helper 定义、两个调用点、反套娃判据、dbPath 双向转发、通知轮不被覆盖 —— 全部 YES」。

---

## 2. V2 — #4588 通知分派三策略

**判定：✅ 通过**

`dispatchInteractiveNotice`（`run.ts:176-190`）三策略齐全：

1. `sink !== "stdout"` → `sendLark`（真飞书），**绝不**进本地 TUI
2. `sink === "stdout"` → `onNotice`；`onNotice?.(text) === true` 才算接管
3. `onNotice` 未就绪 → `writeFallback` 兜底，**绝不静默丢弃**

生产接线：`buildInteractiveEventHandlerOptions()`（`run.ts:231-243`）返回值带
`telemetrySender`；`run.ts:543` 生产端真正调用它。

| 测试 | 结果 |
|---|---|
| `interactive-notify-chain.test.ts`（含组5/6 分派断言 + 组8 生产接线断言） | **15/15** |
| `chat-event-handler.test.ts`（main 新增） | **18 pass / 0 fail** |

> ⚠️ **opentui 补充说明（V3 第 3 点）**：`writeFallback` 走 `console.log`。
> 已核实 opentui 的 `externalOutputMode: "capture-stdout"` + `screenMode: "split-footer"`
> 会把 stdout 写**拦截并渲染进 scrollback**（`interceptStdoutWrite` → `enqueueSplitCommits`），
> 因此兜底通道在 opentui 下**可见**，不是死路。

---

## 3. V3 — `onNotice` 真正接到 opentui 的 RunScreen

**判定：✅ 通过**（本次 worktree 专属难点，main 无此要求）

| 验收项 | 证据 |
|---|---|
| `RunScreen.tsx` 的 `onRegisterHandlers` 暴露 `onNotice` | `tui-solid/RunScreen.tsx:60-69` |
| `handleNotice` 返回 `true`（「已接管」契约） | `tui-solid/RunScreen.tsx:275-300`（`return true`） |
| `run.ts` 把 `onNotice` 接进 `runState` | `run.ts:960` → `runState.onNotice = handlers.onNotice;` |
| 延迟到调用时再读（RunScreen mount 后才就绪） | `run.ts:879` → `onNotice: (text) => runState.onNotice?.(text) === true` |
| opentui 下 stdout 兜底可见 | `externalOutputMode: "capture-stdout"` 拦截 stdout → scrollback |

| 测试 | 结果 |
|---|---|
| `tui-solid/RunScreen.notice.test.tsx`（`bun --conditions=browser`） | **4 pass / 0 fail** |
| `tui-solid/RunScreen.env-event.test.tsx`（**本次新增回归测试**） | **2 pass / 0 fail** |
| `tui-solid/` 全套 | **33 pass / 1 skip / 0 fail** |

**新增回归测试** `RunScreen.env-event.test.tsx` 锁住「opentui 侧 envEvent 原样到达
`streamHandleQuery`」+「positional 顺序 (onTool, onUsage, envEvent, onReasoning)」，
防止将来再次静默失效。

---

## 4. V4 — #4634 `--model` / `--fallback-model` 真正生效

**判定：✅ 通过**

| 验收项 | 证据 |
|---|---|
| `model-flags.ts` 已进入 worktree | `packages/cli/src/commands/model-flags.ts`（main 新增文件） |
| `RunOptions.fallbackModel` | `run.ts:98` |
| import `buildModelAgentContext` / `MODEL_DESCRIBE` / `FALLBACK_MODEL_DESCRIBE` | `run.ts:59` + describe 常量已使用 |
| **进了 agent context（不是只进 props）** | `run.ts:490`（handleQuery）+ `run.ts:730`（createStreamHandleQuery）—— 同一个 `mergedContext` 传给 `queryExecutor.execute(...)`，即 `env.handle_query` 的 context |

**main 自己的测试就是这条的证明**（`model-flags-cmds.test.ts:130-159`）：
捕获 `execute()` 的**第 5 个参数（agentContext）**并断言 `context.model` /
`context.fallbackModel` —— 直接断言落到 agent context，非 UI props。

| 测试 | 结果 |
|---|---|
| `model-flags.test.ts` + `model-flags-cmds.test.ts` + `interactive-model-flags.test.ts` | **21 pass / 0 fail** |

---

## 5. V5 — main 其余改动文件功能完好

**判定：✅ 通过 —— 零新增失败（严格集合比对，非目测）**

**方法**：同机、同命令 `bun run test:packages:fast`（`--parallel 4`）跑三份代码。

| 代码 | pass | fail | tests | 唯一失败数 |
|---|---|---|---|---|
| **main** (`ef9262fb`，独立 worktree) | 8954 | 27 | 9417 | **26** |
| 合并前基线 (`426ea0ca`) | 6305 | 243 | 6644 | 84 |
| **worktree 合并后 + 全部修复** | 8987 | 24 | 9453 | **22** |

**集合差**：
- `comm -13 main worktree` = **0** ⇒ ✅ **本次合并零新增失败**
- `comm -23 main worktree` = **4** ⇒ 合并反而**修好了** main 的 4 个既存失败
  （`cli build — bin executable bit` ×3、`detectGitBranch`）

### 逐个核实（不靠推断）

main 新增测试文件在 worktree 中的通过情况（全部自动随 merge 进入）：

| main 新增测试文件 | 归属 | 结果 |
|---|---|---|
| `commands/shared/interactive-notify-chain.test.ts` | #4588 | ✅ 15/15 |
| `commands/shared/chat-event-handler.test.ts` | #4576 | ✅ 18/18 |
| `commands/shared/chat-extra-busy.test.ts` | #4576 | ✅ pass |
| `commands/model-flags.test.ts` | #4634 | ✅ pass |
| `commands/model-flags-cmds.test.ts` | #4634 | ✅ pass |
| `commands/interactive-model-flags.test.ts` | #4634 | ✅ pass |
| `commands/chat-model-flags.test.ts` | #4634 | ✅ pass |
| `core/src/env/llm/model-fallback.test.ts` | #4623 | ✅ pass |
| `core/src/env/llm/retry-after-bound.test.ts` | #4625 | ✅ pass |
| `core/src/env/llm/redact.ts`（+ 配套） | #4623 | ✅ pass |
| `core/src/env/agent/agent-component.model-fallback.test.ts` | #4623 | ✅ pass |
| `core/src/env/task/delegate/delegate-tool-model-inheritance.test.ts` | #4623 | ✅ pass |
| `core/src/env/task/exports-flat-subpaths.test.ts` | #4624 | ✅ pass |
| `core/src/env/task/exports-map.test.ts` | #4624 | ✅ pass |
| `core/src/env/task/mcp/protocol-version-compat.test.ts` | #4624 | ✅ pass |
| `core/src/env/task/mcp/stdio-clean.test.ts` | #4624 | ✅ pass |
| `core/src/env/task/mcp/task-mcp-server.test.ts` | #4624 | ✅ pass |
| `core/src/env/task/storage/sqlite-compat.test.ts` | #4624 | ✅ pass |
| `core/src/env/task/storage/sqlite-driver.test.ts` | #4624 | ✅ pass |
| `core/src/env/task/tools/legacy-arg-aliases.test.ts` | #4624 | ✅ pass |
| `core/src/env/task/tools/task-get-operations-default.test.ts` | #4624 | ✅ pass |
| `core/src/env/task/task-component-shape-compat.test.ts` | #4624 | ✅ pass |
| `core/src/env/task/plugins/public-api.test.ts` | #4624 | ✅ pass |
| `core/src/env/workflow/tools/run-workflow-timeout-derivation.test.ts` | #4604 | ✅ pass |
| `core/src/env/workflow/utils/session-recovery-concurrent-pairing.test.ts` | #4604 | ✅ pass |
| `core/src/env/workflow/utils/session-recovery-output-value.test.ts` | #4604 | ✅ pass |
| `core/src/env/log-trace/logger-stdio.test.ts` | — | ✅ pass |

### 22 个既存失败的归类（**全部在 main 上同样红**）

| 文件 | 失败数 | 归类 |
|---|---|---|
| `external-env.integration.test.ts` | 2 | 断言 `"interactive"`，但命令名在 `1dfe4ac5`（**早于合并基点** `3d2de549`）已改为 `"run"` ⇒ main 上同样红（已实跑确认） |
| `interactive-subagent-ask-user-cascade.test.ts` | 3 | main 上实跑确认同样 3 fail |
| `repl-ink-flicker-overflow.test.tsx` | 5 | 串行 `bun test` 下 **worktree 5 pass / 0 fail**；仅 `--parallel 4` 下失败，而 **main 上同命令同样 5 fail** ⇒ 并行模式 flake |
| 其余 12 项 | 12 | main 与 worktree 集合完全一致 |

> 两轮跑出 21 vs 22 的差异来自 `Chat-Keyed Session trace 验证` —— 实测**机器负载相关 flake**
> （本机同时有另一 worktree 在跑 `bun test packages/core --parallel 4`），且 **main 上同样红**。

---

## 6. V6 — worktree 专有逻辑未被回退

**判定：✅ 通过**

### 结构性核对

`git diff --name-only 3d2de549 ef9262fb`（main 的 40 个 commit 改的 79 个文件）**完全没有碰**
`scripts/` 或 `build-cli*` ⇒ `solid-client-resolve-plugin.ts` / `solid-jsx-plugin.ts`
的接线**不可能**被 main 冲掉。**但仍实构建证明**：

| 项 | 结果 |
|---|---|
| `bun run build:cli:dev:single` | **EXIT=0** |
| 产物 | `packages/cli/dist/bin/roy-bot.js` |
| R8 复核：bundle 内 `dist/server`（SSR）标记 | **0** ⇒ 无 SSR |
| R8 复核：`solid-js/dist/solid.js` | **命中** ⇒ client 运行时正确 |

### 真 pty e2e（全部**复用**已有脚本，未重写）

| 脚本 | 结果 |
|---|---|
| `e2e-thinking-clickable.py`（片6 初衷） | **9/9 ✅** — thinking 行出现、点击展开、再点收起、键盘 t fallback；鼠标 1000/1002/1003/1006 全开；**不进 alt screen** |
| `verify-scrollback.py`（片4） | **6/6 ✅** — 历史行 write-once 指纹 count=1 |
| `e2e-interactive-solid.py --scenario boot` | ✅ 4/4 |
| `e2e-interactive-solid.py --scenario help` | ✅ 3/3 |
| `e2e-interactive-solid.py --scenario editing_keys`（片3） | ✅ 3/3 — Home+Delete=`bcde`、End+Z=`bcdeZ` |
| `e2e-interactive-solid.py --scenario typing` | ✅ 4/4 |
| `e2e-interactive-solid.py --scenario ctrlc` | ✅ 1/1 |
| `capture-interactive-solid.py`（片1 地基） | ✅ banner + 输入行 + 鼠标追踪 |
| `interactive-ink-escape-e2e-task-2297.test.tsx`（**run 链路**） | ✅ **1 pass / 0 fail**（证明 usage-format 抽取没破坏 Ink 链路） |

### 硬编码路径核查

e2e 脚本里的 `.worktrees/feat-tui-opentui` **只出现在 docstring 的用法示例**里；
实际代码用 `HERE.parent.parent` 解析 ⇒ 合并后仍有效（4 个脚本实跑通过即为证）。

### run 链路零改动约束

`git diff main -- packages/cli/src/commands/interactive.ts packages/cli/src/ChatTui.tsx packages/cli/src/tui/`
⇒ 仅 `tui/UsageFooter.tsx`（纯模块抽取）+ `tui/usage-format.ts`（新）有差异，
`interactive.ts` / `ChatTui.tsx` / `tui/` 其余文件**零差异**。

---

## 7. 类型检查

| 文件 | main | worktree | 净增 |
|---|---|---|---|
| `tui-solid/App.tsx` | 0（main 无此文件） | 11（**全 TS2769**，Solid JSX 对根 tsconfig React typings 的**既存类别**） | — |
| `tui-solid/ToolCall.tsx` | 0 | 3（同上） | — |
| `tui-solid/App.tsx` 相对**合并前基线** `426ea0ca` | — | 11 → **11** | **0** ✅ |

在**合并前基线 commit** `426ea0ca` 上用独立 worktree 实测确认这 11+3 个错误**本来就存在**
（不是合并引入）。我的 `role:"usage"` 改动一度把它抬到 13，
用**早返回**替代多加一层 `<Show>` 后**回到 11（净增 0）**。

---

## 8. 独立交叉验证

```
timeout -s KILL 900 roy-bot act "{review content}" \
  --model opencodego/deepseek-v4.1-flash --agent roy
```

**第 1 轮**：EXIT=137（被 KILL，工具调用空转）。被 kill 前**已独立复核并确认**：
签名正确 ✅、V1 15/15 ✅、V4 进 agent context ✅、**"Zero new failures"** ✅。
同时提出 **2 条有价值的质疑**（均已修）：

1. **usage footer role 分歧** — main 用 `role:"usage"`（无标题暗色脚注行），
   我初版用 `role:"tool"` ⇒ 会多出「🔧 Tool」标题。**已修**（`App.tsx` 加 `"usage"` 角色 +
   `ROLE_PREFIX.usage = ""`，对齐 main）。
2. **opentui 路径引入 Ink 的风险** — `tui/UsageFooter.tsx` 顶层 `import { Text } from "ink"`
   ⇒ 从 tui-solid 引用它会把 **React + Ink** 拖进 opentui bundle，违反 fork 自己写在
   `tui-solid/index.ts` 的策略（"Shared *pure* modules (no JSX / no React) are re-used in place"）。
   其余被 tui-solid 引用的 `tui/` 模块（tool-call / theme / scrollback）**imports=0**（纯），
   只有 UsageFooter 是例外。**已修**：抽出纯模块 `tui/usage-format.ts`
   ⇒ **纯模块不变量恢复**（tui-solid 引用的 tui/* 全部 imports=0）。

**第 2 轮**（收紧 scope，限 8 次工具调用 / 8 分钟）：**EXIT=0**

> **判定：✅ PASS** · BLOCKER: 无 · MAJOR: 无 · MINOR: 1（pre-existing，不可达）
> **Q1/Q2/Q3 全部 YES**，每项均给 file:line
> **Merge recommendation：YES**

第 2 轮的 1 条 MINOR（one-shot fallback `props.handleQuery(message)` 不带 envEvent，
若该分支可达则通知轮会被误判成用户轮）—— 已加注释记录该约束
（该分支**不可达**：`run.ts:924` 总是构造 `streamHandleQuery`）。

---

## 9. Commits

| commit | 内容 |
|---|---|
| `eb8f87c1` | merge main (`ef9262fb`) + **修复 V1 positional 契约** + opentui 补 envEvent 通道 |
| `dbdd91fb` | 抽出纯模块 `tui/usage-format.ts`（opentui 路径不引入 Ink）+ usage role 对齐 main |
| `861a9002` | 记录 one-shot fallback 的 envEvent 约束（DS MINOR） |

作者全部 `developer <dev@example.com>`。
**未 merge 回 main / 未 push / 未 tag。**
