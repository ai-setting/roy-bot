# 飞书多 session 消息并发处理（Task #4486 / 修复 Task #4515）

> 状态：✅ 已合并（2026-10-22，`main` @ `f616b51c`）；阻塞项已由 **Task #4515** 修复
> （H1 trace 隔离 / H2 lane↔session 1:1 / H2b 引用计数 / H3 重复渲染 / M1 / M2 / M4 / M6）
>
> ⚠️ **本文档已按 #4514 独立复审 + #4515 修复后的真实实现校正**。校正的 6 处：
> §2.1 伪代码执行顺序（原文写反了）、§2.2「未注入即完全向后兼容」（夸大）、
> §2.4 trace 隔离描述（原文误导，漏了 tracer 实例级那层）、§3/§4 软回滚开关
> （原文声称可配、实际零调用方）、follow-up 里把 M2 缺陷写成"未来优化"、
> 已知 caveat「headless 不受影响」（错，headless 同样受影响）。
> 分支：`feat/4486-per-session-concurrency`（6 commits，`00a1128e` 头部）
> 基线：`main` @ `7cddf000`
>
> **合并验证结果**
> - 交叉验证：`codex-exec`（`codex exec -s danger-full-access`），判定 **⚠️ 可合并（1 个非阻塞 caveat）**；
>   无单一 Verdict 行（日志在最后一项调查中被截断），结论为综合汇总。`claude-minimax` 首选但在本机
>   `--model MiniMax-M3.1-Flash` 长时间 0 输出，本轮不可用；`codex-minimax-exec` 因 bwrap 沙箱受限不可用。
> - 新增测试：6 个文件 **59 pass / 0 fail**。
> - `packages/cli/src/commands/shared/`：**315 pass / 0 fail**（合并前后一致）。
> - `packages/core/src/env/log-trace/`：**228 pass / 1 skip / 6 fail**；同命令在干净 `main` 基线上
>   `222 pass / 1 skip / 6 fail` —— 差值仅为本分支新增 6 个测试，**6 个失败项逐条相同 = 既存失败，零新增回归**。
> - Phase 4 的 ALS 修复经反向验证有效：把 `event-handler-envcontext-isolation.test.ts` 拷到 `main`
>   上跑 **3/3 fail**（说明测试非恒真）。
>
> **已知问题（既存，非本分支引入）**
> `OTelTracerImpl Context Management` 的 6 个失败（`currentContext` 生命周期 3 个、嵌套 parentSpanId /
> span tree 2 个、async context 1 个），在 `main` 基线同样失败。
>
> **~~后续 follow-up（非阻塞）~~ → 已在 Task #4515 修复**
>
> 原先这里记的是两件事，都被 #4514 复审推翻，**已修复**，不再属 follow-up：
>
> 1. **重复渲染**（原记为"可能"，实测是**真实存在**）。原描述把它写成非阻塞 follow-up，
>    并给了两条错误的前提：
>    - ❌ 原写「触发条件 = 同进程内人工打字 + 飞书事件并发」→ **错**。
>      `__default__` lane（无 chatId 无 trigger 的后台通知）经"优 3"会落到 **REPL 自己的
>      active session**，此时 `isEventDrivenTurn === false` → **走主 executor**，所以
>      **纯 headless 事件流同样会触发**。
>    - ❌ 原写「纯 headless 不受影响」→ **错**（同上，且 ink 路径实测单次 `llm.text`
>      被渲染 2 次）。
>
>    **修法**（已落地）：把 session 过滤绑定下沉到 `QueryExecutor.execute()`，用本次执行的
>    权威 `sessionId` 每轮刷新 `setSessionFilter`/`setRunId`。这样任何调用方都不可能
>    忘记绑（结构性保证，不靠 `interactive.ts` 的接线约定）。
>
> 2. **过滤语义**（原写成"未来优化"）→ 那描述的是**当时的缺陷**（filter 把"没有
>    sessionId 的事件"也丢掉），**已修**：现在只有"带了 sessionId 且不匹配"才丢弃，
>    无 sessionId 的事件照常处理。

## 1. 问题

从 `lark-cli` event source 进来的消息，无论来自哪个飞书会话（chatId），都在
`EventHandler` 里走**单队列 + 单 worker**，并且用全局 `isIdle()` 做门禁。

结果：**一个会话的 agent 还在跑，其他所有会话的消息都排队等待**（head-of-line blocking）。

根因链条：

| 层 | 位置 | 症状 |
|---|---|---|
| 事件格式化 | `event-source-handlers.ts:1607` | `dispatchLines` 是 fire-and-forget，**这一层不阻塞** |
| 事件排队 | `event-handler.ts` 单 `queue` + 单 `isProcessing` | 所有会话共享一条队列 |
| 空闲门禁 | `event-handler.ts` `waitForIdle()` → `repl.isIdle()` | `isIdle()` 是全局的，任何会话在跑就全挡 |
| 执行态 | `interactive.ts` `isExecuting: boolean` | 单布尔，无法表达"哪个会话在跑" |
| agentContext | `interactive.ts` `currentAgentContext` 单槽 | 并发时后一个事件覆盖前一个 |
| 流式输出 | `query-executor.ts` 单 `streamService` | 多会话 chunk 混进同一 ticker |
| abort | `stream-output.service.ts` 全局 `streamAbortSignal` | 一个 run 结束会清掉别人的 abort |
| trace | `tracer-provider.ts` `setGlobalContext` 进程级单槽 | 并发 run 串 traceId |
| ALS | `event-source-handlers.ts:1895` `runWithEnvContext` | 单 worker 的异步链继承第一条事件的 ALS |

## 2. 改造后的行为

### 2.1 调度（EventHandler）

```
enqueue(event)
  → 快照 EnvContext 到 item.envContext
  → laneKey = chatId | `trigger:<triggerSessionId>` | "__default__"   // 仅初始分组
  → lanes[laneKey].push(item)
  → scheduleLane(laneKey)               // 该 lane 无 runner 才起
       runLane(laneKey):
         while lane 非空:
           sessionId = resolveSessionForItem()      // 在 item 自己的 ALS 下解析
           if sessionId ≠ laneKey:
             merge lane → lanes[sessionId]; return  // ★ lane 归并成 1:1
           waitForIdle(sessionId)                   // ① per-session 门禁（先等）
           releaseClaim = claimSession(sessionId)   // ② 原子声明独占（防 TOCTOU）
           acquireSlot()                            // ③ maxConcurrentSessions
           item = lane.shift()
           processItem(item, sessionId)             // runWithEnvContextAsync 重入
           releaseClaim(); releaseSlot()
```

**执行顺序是 `waitForIdle` → `claimSession` → `acquireSlot`**（门禁全部在抢槽之前）。
反过来会让"正在等同 session"的 lane 白占并发槽位 —— 4 个这样的 lane 就能把槽位
卡死，让本来空闲的第 5 个 session 永远排不上（变相 head-of-line blocking）。

- **lane ↔ session 结构性 1:1**：`laneKey` 只用于**初始分组**。一旦解析出
  `sessionId`，整条 lane 就归并到以 `sessionId` 命名的 canonical lane。因此
  不同 transport key（`oc_A` 与 `trigger:oc_A`）落到同一 session 时，会排进
  **同一条 lane** 严格串行。
- **同一个 lane 严格 FIFO**：`runningLanes` 保证同 lane 不重入
- **不同 session 并行**：受 `maxConcurrentSessions`（默认 4）限流
- **兜底 `claimSession`**：即使 lane 结构被改坏，按 sessionId 的原子声明仍能
  保证「同一 session 同一时刻只有一轮在跑」（不依赖 check-then-act 的窗口）
- **`__default__`**：无 chatId 且无 trigger 的事件共享全局 `activeEventSessionId`；
  它们在归并后同样落到解析出的 sessionId 上，不会互相争抢。

### 2.2 门禁（per-session）

`EventHandlerOptions.isSessionIdle?: (sessionId: string) => boolean`

- 注入时：按 session 判空闲（`REPL.isSessionIdle`）
- 未注入时：回落全局 `isIdle`

⚠️ **未注入 ≠ 完全等价旧行为。** 这一项要说清楚，别被"向后兼容"误导：

| 维度 | 老调用方（只传 `isIdle`）实际表现 |
|---|---|
| 门禁判定 | ✅ 仍然只看全局 `isIdle`，语义不变 |
| **执行模型** | ❌ **变了**：从「1 个全局 worker」变成「N 条 lane 并行」。老调用方凭空获得并发（默认上限 4），跨 lane 事件不再互相阻塞 |
| 跨会话顺序 | ❌ **变了**：不再有全局到达顺序（同会话内仍严格 FIFO） |

也就是说：**只有把 `maxConcurrentSessions` 设为 1，才真正等价旧的全局串行语义**。
这与 §4 的回滚说明一致（那里说"软回滚才等价旧串行"）；本文档不再声称"未注入
即完全向后兼容"。

### 2.3 执行态（REPL）

`REPL` 的 `isExecuting: boolean` → `executingSessions: Map<string, number>`（**引用计数**）：

- `markSessionExecuting(sid, true)` → 计数 **+1**；`markSessionExecuting(sid, false)` → 计数 **-1**，**归零才 `delete`**
- `isSessionIdle(sid)` = 该 session 计数为 0（或不存在）；`getExecutingSessionIds()` 只列计数 > 0 的
- `isExecuting` 保留为**派生 getter**（`anySessionBusy()`，即任一 session 计数 > 0），供状态栏 / 输入提示 / ESC 判定
- ⚠️ 为什么必须是引用计数而不是 `Set`（**H2b**，Task #4514 复审阻塞项）：`Set` 无法表达"同一 session 被 mark 两次"。
  同 session 双跑时 run1 结束就 `delete`，run2 仍在跑却已被判空闲 → **提前释放门禁**，
  第三个事件会插进来并发写同一个 session。引用计数保证「两次 mark 之后要等两次 unmark 才空闲」。
  - 兼容 setter：`= true` 加 legacy 占位 key，`= false` 清空（既有测试大量这样用）
- `executeInternal(message, { showPrompt, sessionId, agentContext })` 显式传参
  - 删掉了 `currentAgentContext` 单槽
  - `finally` 只释放**自己**的 session；只有全局空闲才把状态栏切回 `ready`
- ESC / `/abort` 保持 **abortAll** 语义 → `abortAllExecutingSessions()`

### 2.4 共享资源隔离

| 资源 | 改法 |
|---|---|
| abort | `resetStreamAbort(scope?)` / `abortStream(scope?)` / `isStreamAborted(scope)`；无 scope 保持全局语义（ESC = abortAll） |
| 流式输出 | `StreamOutputService.setSessionFilter(sid)` + `setRunId(sid)`；绑了 runId 就只判自己的 abort |
| QueryExecutor | `setSessionScope(sid)` 透传 filter + runId；interactive handler 按 session 缓存 executor（上限 16，LRU 淘汰 + dispose） |
| trace | 见下方「trace 隔离的两层」——`withGlobalContext(ctx, fn)` 同时覆盖**两层**上下文 |
| tool 事件 | `agent-component.pushEnvEvent({ ..., sessionId })`；`tool.call/result/error` 补 `metadata.sessionId`（`llm.*` 本来就有） |

#### trace 隔离的两层（Task #4515 补齐）

trace 上下文有**两层**，两层都必须在 ALS 作用域内，否则并发 run 仍会串：

| 层 | 存储 | 作用 |
|---|---|---|
| `provider.globalContext` | 进程级单槽 + ALS 覆盖 | "本次 run 的父 trace"（跨 tracer 实例） |
| `tracer.currentContext` | **实例级**（每个 `OTelTracerImpl` 一份） | "当前 span 是谁"（用于 `span.end()` 后恢复父上下文、同步嵌套继承） |

关键点：`startSpan()` 的父上下文优先级是
`显式 options.parent` → **`tracer.currentContext`** → `provider.globalContext`。
`currentContext` 优先级更高，而生产所有调用点都用 `getTracer("roy-tracer")`
= **同一个 tracer 实例** —— 所以只修 `globalContext` 那层是无效的
（H1 复审实测：run B 会继承 run A 的 traceId）。

现在 `withGlobalContext()` 会**同时**开两个 ALS 作用域：

```
withGlobalContext(ctx, fn)
  → globalContextScope.run({ value: ctx })        // 第一层
  → tracerContextScope.run({ contexts: snapshot }) // 第二层（每个 run 一张独立 map）
```

- 作用域内 `tracer.currentContext` 读写的都是**本 run 那张 map**
- 每次 `startSpan()` / `span.end()` 只改自己的槽 → 并发 run 的 traceId /
  parentSpanId 互不可见
- 作用域外仍读写进程级表 → 既有"同步链式嵌套"语义完全不变（向后兼容）
- 作用域建立时从进程级表**播种快照**，保证"作用域之前已设的父上下文"仍能继承

另外 `executeInternal` 的**根 span 创建已挪进作用域内**（原来在作用域外，
那时读写的是进程级表，两个并发 run 的根 span 会串味并留下残留）。

### 2.5 事件驱动 turn 的渲染

事件驱动的会话（`sessionId !== REPL 默认 session`）用**专属 silent executor**：
流式 chunk 不写 stdout，turn 完成后整段提交一次。这样多会话并发时 stdout 不会
互相穿插，也不用改 Ink 渲染模型。（Phase 2 的多路 live stream 留作后续。）

### 2.6 ALS EnvContext 修复

`enqueue` 时 `getEnvContext()` 快照到 `QueueItem.envContext`，`processItem` 时
`runWithEnvContextAsync(item.envContext, ...)` 重入。修复了单 worker 异步链
继承第一条事件 ALS 导致的 `agentContext` / `messageId` 串味。

## 3. 风险

| 风险 | 说明 | 缓解 |
|---|---|---|
| **同 workdir 并发写** | 多个会话同时在同一个 cwd 跑 bash / 改文件会互相影响（`git checkout/stash/commit` 互相破坏比文件冲突更危险） | 用 `ROY_AGENT_MAX_CONCURRENT_SESSIONS` 调低，**设为 1 即等价旧全局串行**（真实可用，见 §3.1） |
| **provider 限流 / 成本** | 并发 N 路 LLM 调用，配额和成本上升（瞬时峰值 = N 倍） | 同上；建议观察 provider 429 再调 |
| **SQLite 并发写争用** | session/message/task 写入并发升高 | 现有 WAL + 单连接池；如需更保守就降并发上限 |
| **事件乱序** | 跨会话不再有全局到达顺序 | 业务上跨会话本就独立；同会话仍严格 FIFO |
| **trace 语义变化** | `executeInternal` 不再清进程级 globalContext；根 span 在建在 ALS 作用域内 | ES 路径的 rootSpan 仍由 ES 自己 end；并发 run 各持独立 tracer 上下文表 |

### 3.1 怎么真的调 `maxConcurrentSessions`

> ⚠️ 历史问题（Task #4515 已修）：本文档早先写"调低到 1 即可软回滚"，但当时
> 这个参数**除 EventHandler 自身外零调用方** —— 既没有 CLI flag 也没有
> config/env 通路，软回滚物理上不可执行。现已补 env 通路。

**唯一可用的设置方式：环境变量**

```bash
# 等价旧的全局串行（软回滚）
ROY_AGENT_MAX_CONCURRENT_SESSIONS=1 roy-bot run --es lark-cli

# 推荐生产值（既拿到并行收益，又控制同 workdir 冲突面）
ROY_AGENT_MAX_CONCURRENT_SESSIONS=2 roy-bot run --es lark-cli

# 默认（不设 = 4）
roy-bot run --es lark-cli
```

| 取值 | 语义 |
|---|---|
| 未设置 / 空串 / 非数字 / `< 1` | 回落默认 **4** |
| `1` | 退化为旧串行语义（同 session 串行 + 跨 session 也串行） |
| 正整数（小数向下取整） | 同时并行处理的 session 上限 |

优先级：**代码显式传参 > `ROY_AGENT_MAX_CONCURRENT_SESSIONS` > 默认 4**。
解析函数：`readMaxConcurrentSessionsFromEnv()`（`event-handler-wiring.ts`），
在 `createEventHandlerForInteractive()` 里统一应用 —— `interactive.ts` 与
`run.ts` 两条生产路径自动生效。

**推荐值**：默认 4 是合理上界；不建议 > 4（同 workdir 语义冲突是硬约束，
不是配置问题）。多群并发但 agent 频繁改同一仓库时建议 2。

## 4. 如何回滚

改动集中在 4 个文件 + 3 个新测试文件，全部在同一个 commit 里：

```bash
git revert <commit>          # 单 commit 回滚

# 或运行时软回滚（不改代码，真实可用）：
ROY_AGENT_MAX_CONCURRENT_SESSIONS=1 roy-bot run --es lark-cli
#   → 退化为旧的全局串行语义
#   → 仍保留 per-session lane 结构、EnvContext 快照修复、trace 隔离修复
```

⚠️ 注意：**"未注入 `isSessionIdle`" 不等于回滚**。门禁会回落全局 `isIdle`，
但执行模型仍是 N 条 lane 并行（见 §2.2）。只有 `maxConcurrentSessions=1`
（通过上面的 env）才真正等价旧串行 —— 这是分阶段上线的正确安全网。

## 5. 测试

| 文件 | 覆盖 |
|---|---|
| `event-handler-per-session.test.ts` (14) | 同 session 串行（chat/trigger/default 三种 lane）、跨 session 并行、慢不阻塞快、`isSessionIdle` 门禁 + 回落、`maxConcurrentSessions`、队列聚合、`stop()`、EnvContext 隔离 |
| `interactive-per-session-execution.test.ts` (12) | 多 session 同时 executing、各自释放不误清、`executeInternal` 显式传参、并发 agentContext 不覆盖、异常 finally、引用计数需等次 unmark 才释放 |
| `stream-output-per-run-isolation.test.ts` (13) | `resetStreamAbort(scope)` / `abortStream(scope)` / `isStreamAborted`、session 过滤、per-run abort 联动 |
| `query-executor-session-scope.test.ts` (4) | `setSessionScope` pending 缓存 + 立即生效 + per-run abort |
| `tracer-provider-run-isolation.test.ts` (6) | `withGlobalContext` 异步链内覆盖、并行不串、嵌套恢复、`undefined` 屏蔽 |

### Task #4515 新增（修 #4514 复审项）

| 文件 | 条数 | 覆盖 |
|---|---|---|
| `tracer-provider-startspan-isolation.test.ts` | 9 | **H1**：并发 run 用**同一 tracer 实例**时 `startSpan()` 实际产出的 traceId/parentSpanId 互相独立；显式 parent/context 优先级；无 ALS 时同步嵌套不变 |
| `event-handler-lane-session.test.ts` | 11 | **H2**：两 lane 解析到同一 session 必须串行（含 canonical lane 判别）、不同 session 仍并行、`claimSession` 原子性/幂等/清理、**M1** 收尾窗口不滞留、**L1** stop 清缓存 |
| `interactive-executing-refcount.test.ts` | 12 | **H2b** 引用计数（重复 mark 需等次 unmark）、**M6** mark 后立即抛错不永久占用 |
| `interactive-trace-isolation.test.ts` | 5 | **H1-b**：`executeInternal` 并发两轮 traceId 不同、结束后不留进程级残留 |
| `query-executor-dup-render.test.ts` | 11 | **H3**：主/per-session executor 不重复渲染；**结构性**（不调 `setSessionScope` 也不泄漏）、连续服务两 session 不残留 scope |
| `services/stream-output-filter-no-session.test.ts` | 9 | **M2**：无 sessionId 的事件仍被处理、不匹配仍丢弃 |
| `event-handler-max-concurrent.test.ts` | 11 | **M4**：`ROY_AGENT_MAX_CONCURRENT_SESSIONS` 通路（含软回滚行为验证、非法值回落、代码>env 优先级） |

回归（Task #4515 结束时）：`packages/cli/src/commands/shared/` **348 pass / 0 fail**；
`packages/cli/src/services/` **159 pass / 0 fail**；`packages/core/src/env/log-trace/`
**237 pass / 1 skip / 6 fail**（与 `main @ befbae39` 基线 **228 pass / 1 skip / 6 fail** 的 6 个失败项逐条相同，零新增）。
