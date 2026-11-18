# AutoTaskPlugin — Tool Call Hook 注入 Iteration 信息触发自动 Task 创建

- 起草日期：2026-06-18
- 工作分支：`feat/auto-task-toolcall-hook`
- Worktree：`~/work/codework/personal/roy_world/feat-auto-task-toolcall`
- 关联任务：Task #993

## 1. 现状与问题陈述

旧 AutoTaskPlugin 的实现（已废弃）通过 `agent:on.iteration` hook 在每轮 ReAct 迭代结束时
向 `hookCtx.messages` 注入 assistant 提醒消息（"你已迭代 N 轮，建议创建 task 跟踪"）。

但 vercel ai sdk 对消息序列有强约束：**每个 assistant 的 `tool_call` 必须紧跟一条对应
`toolCallId` 的 `tool` 消息**，否则会抛出 `AI_MissingToolResultsError`。

旧 hook 在 `on.iteration` 注入 assistant 消息的位置位于 `tool_result` 之后，破坏了
配对结构。即使移到其他点，只要在「上一轮 assistant tool_call 已 push、对应 tool_result
还没全部 push」之间注入任何 role="assistant" 的消息，都会触发同样错误。

结论：**不能再通过注入 assistant 消息的方式提醒迭代**。

## 2. 新方案概览

### 核心思路

放弃"注入 assistant 提醒消息"路线，改为：

1. **不修改消息历史**——保持原始 `tool_call → tool_result` 配对完全不变。
2. 在 `agent:after.tool` hook 中读取 `hookCtx.iteration`：
   - 这个 hook 在每个 tool call 执行完之后立刻触发，是离 tool call 最近的安全点。
   - 此时 tool result 还**没**被 push 进 messages（push 发生在 hook 返回后），
     因此 hook 内部对 messages 的任何只读访问都安全。
3. 当满足以下三个条件全部成立时，**直接调用 `taskComponent.createTask()`**
   创建一条跟踪 task：
   - 当前 agent 是 default agent（`hookCtx.agent.name === "default"`）。
   - 当前 iteration **精准等于** 配置的阈值（默认 `5`），不大于、不小于。
   - 在当前 session 中，本插件实例尚未为该 session 创建过 auto task。
4. task 创建失败/异常都被吞掉并 log，不影响主 ReAct 流程。

### 架构图

```
┌────────────────────────────────────────────────────────────────────┐
│  AgentComponent ReAct loop                                          │
│                                                                      │
│  iteration = N                                                       │
│   ├─ before.llm hook                                                 │
│   ├─ invokeLLM                                                       │
│   ├─ after.llm hook                                                  │
│   ├─ for each toolCall:                                              │
│   │    ├─ before.tool hook                                           │
│   │    ├─ executeTool                                                │
│   │    ├─ after.tool hook  ←─────── AutoTaskPlugin 监听点            │
│   │    │     │                                                       │
│   │    │     ▼                                                       │
│   │    │   读取 ctx.data.iteration / ctx.data.agent.name             │
│   │    │   if iteration === threshold && agent.name === "default"    │
│   │    │      && !alreadyCreatedFor(sessionId)                       │
│   │    │      → taskComponent.createTask(...)                        │
│   │    │      → memo sessionId 防重复                                │
│   │    │                                                             │
│   │    └─ push toolResult 到 messages                                │
│   └─ on.iteration hook                                               │
└────────────────────────────────────────────────────────────────────┘
```

### 关键事实（已通过代码确认）

- `executePluginHooks` 将 agent 的 `HookContext` 整体作为 `data` 传给
  `globalHookManager.execute(point, ctx, metadata)`，所以 plugin 的 handler
  里 `ctx.data` 就是 agent HookContext（含 `iteration` / `agent` / `context` / `messages`）。
- `agent:after.tool` 在每个 tool call 执行后立即触发；此时 tool result **尚未
  push 进 messages**（push 在 hook 之后），因此 hook 不会看到当前轮 tool result。
- default agent 的命名规范来自 `BaseEnvironment.handle_query`：`agentComponent.registerAgent("default", ...)`，
  agent 实例名固定为字符串 `"default"`。
- task 创建走 `taskComponent.createTask({ title, sessionId, project_path, context, ... })`。

## 3. 关键接口

### 3.1 Plugin 配置

```ts
export interface AutoTaskPluginConfig {
  /** 触发自动 task 创建的 iteration 阈值（精准匹配，默认 5） */
  threshold?: number;

  /** 仅在该 agent name 下触发（默认 "default"） */
  agentName?: string;

  /** 任务 project_path（默认 process.cwd()） */
  projectPath?: string;
}
```

### 3.2 主要函数

```ts
class AutoTaskPlugin extends BasePlugin {
  readonly name = "AutoTaskPlugin";

  init(env: PluginEnv): void {
    this.taskComponent = env.getComponent("task");
    env.registerHook({
      point: "agent:after.tool",
      priority: 50,
      handler: this.onAfterTool.bind(this),
    });
  }

  @TracedAs("plugin.auto-task.tool-call-hook", {
    recordParams: true, recordResult: true, log: true,
  })
  private async onAfterTool(ctx: HookContext): Promise<void> {
    // ctx.data 是 agent HookContext
    // 1. 读取 iteration / agentName / sessionId
    // 2. 阈值精准匹配 + agent name 检查 + 防重复 sessionId 集合
    // 3. taskComponent.createTask(...)
    // 4. 异常吞掉，log 即可
  }
}
```

### 3.3 创建出来的 Task

| 字段                                | 取值                                                 |
| ----------------------------------- | ---------------------------------------------------- |
| `title`                             | `"Auto-tracked: agent reached iteration {N}"`        |
| `description`                       | 包含触发时间、agent 名、iteration 数等               |
| `priority`                          | `medium`                                             |
| `type`                              | `normal`                                             |
| `tags`                              | `["auto-task", "agent-iteration"]`                   |
| `project_path`                      | 来自配置，默认 `process.cwd()`                       |
| `context`                           | JSON: `{ "type": "auto-task", "agent": "default", "threshold": 5, "iteration": 5 }` |
| `goals_and_expected_deliverables`   | `"自动跟踪：agent 在第 N 轮迭代时被识别为长任务，建议人工 review 当前会话"` |
| `sessionId`                         | `ctx.data.context.sessionId ?? "unknown"`            |

## 4. 测试矩阵

| #   | 场景                                                                  | 期望结果                            |
| --- | --------------------------------------------------------------------- | ----------------------------------- |
| 1   | default agent + iteration === 5                                       | createTask 被调用 1 次              |
| 2   | default agent + iteration === 4                                       | createTask 不被调用                 |
| 3   | default agent + iteration === 6（之前已经触发过）                     | createTask 不被重复调用             |
| 4   | default agent + iteration === 6（之前没触发过——比如初次见到）         | createTask 不被调用（仅精准匹配）   |
| 5   | 非 default agent (e.g. "roy") + iteration === 5                       | createTask 不被调用                 |
| 6   | taskComponent 不可用（getComponent("task") 返回 undefined）           | hook 静默不抛错                     |
| 7   | createTask 抛异常                                                     | hook 静默不抛错，agent 主流程不受影响 |
| 8   | sessionId 不同的两次会话，都达到 iteration === 5                      | 两个 session 各创建一次             |
| 9   | tool_call + tool_result 配对验证：hook 执行不会修改 messages          | messages 长度/内容与 hook 调用前一致 |
| 10  | 配置自定义 threshold = 3                                              | iteration === 3 时触发              |

每个场景对应一个 `it(...)` 单元测试。

## 5. 实施计划（TDD）

### Phase 1：RED

1. 创建 `packages/coder-harness/src/plugins/auto-task-plugin.ts`（空骨架）
2. 创建 `packages/coder-harness/src/plugins/auto-task-plugin.test.ts`（10 个失败用例）
3. 运行 `bun test` 确认全部 fail

### Phase 2：GREEN

实现 `auto-task-plugin.ts` 让所有用例通过。

### Phase 3：REFACTOR

- 抽取 createTask payload 构造逻辑
- 给主函数加 `@TracedAs`
- 在 `packages/coder-harness/src/index.ts` 导出
- 在 `packages/cli/src/services/environment.service.ts` 的 `loadPlugins()`
  switch 中加入 `case "auto-task":`

### Phase 4：5 步验证

按 task 描述中的 5 步执行。

## 6. 安全性 / 兼容性

- **不破坏 vercel ai sdk 配对约束**：hook 不修改 messages。
- **不影响主流程**：hook 内部 try/catch，所有错误吞掉只 log。
- **无副作用 default-off**：plugin 通过 `--plugin auto-task` 显式启用，不强制注册。
- **session 防重复**：内部 `Set<sessionId>` 在插件实例内，跨进程不持久化（够用，
  避免 db 写入复杂度）。

## 7. 验证证据规约

每一步必须粘贴实际命令输出，不可以"应该工作"代替。
