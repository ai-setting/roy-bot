# Workflow Examples

本目录包含 Workflow 的示例代码和配置文件。

## Greeting Workflow（问候 Workflow）

这是一个最简单的 Human-in-the-Loop (HIL) Workflow 示例。

### 功能描述

1. **只有一个 agentNode**：Workflow 包含一个 Agent 节点
2. **询问用户名字**：Agent 自动调用 `ask_user` 工具询问用户名字
3. **触发中断**：调用 `ask_user` 时抛出 `AskUserError`，Workflow 暂停
4. **用户回复后打招呼**：Resume 后，Agent 使用用户回复的名字进行问候，然后 Workflow 结束

### 文件说明

| 文件 | 说明 |
|------|------|
| `greeting-workflow.yaml` | Workflow 定义文件 |
| `greeting-workflow.test.ts` | E2E 测试代码 |

### 使用方法

```bash
# 1. 启动 Workflow
roy workflow run greeting-workflow.yaml

# 2. Workflow 会暂停并显示
# [Workflow] Node "greeting-agent" ask_user: What is your name?
# Workflow paused at node "greeting-agent" - ask_user pending

# 3. 获取 run ID（在输出中找到 session ID）

# 4. 恢复 Workflow 并提供用户名字
roy workflow resume <run-id> --input "Alice"

# 5. 看到问候输出
# Hello, Alice! Nice to meet you!
```

### 测试验证

```bash
# 运行 E2E 测试
bun test src/env/workflow/examples/greeting-workflow.test.ts
```

测试覆盖：
- ✅ Workflow 在 ask_user 时暂停
- ✅ Resume 后 Workflow 继续执行
- ✅ Resume 后 Workflow 正常完成
- ✅ 问候消息包含用户名字

### 技术实现

```
┌─────────────────────────────────────────────────────────────┐
│                    Greeting Workflow                         │
│                                                             │
│  ┌─────────────────────┐                                   │
│  │  greeting-agent      │                                   │
│  │  (Agent Node)        │                                   │
│  │                      │                                   │
│  │  1. 询问用户名字     │──────┐                            │
│  │  2. ask_user()      │      │                            │
│  │  3. AskUserError ⚡  │      │                            │
│  │                      │      │ AskUserError               │
│  │  4. 打招呼完成 ✓     │◀─────┘                            │
│  └─────────────────────┘      Resume (userResponse)         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 消息流程

```
User (CLI)
    │
    ▼ run workflow
Workflow [running]
    │
    ▼ execute greeting-agent
Agent [running]
    │
    ▼ ask_user("What is your name?")
AskUserError ⚡ (Workflow paused)
    │
    │ [CLI can exit here, user runs resume command later]
    │
    │ resume with userResponse="Alice"
    ▼
Agent [resumed]
    │
    ▼ greeting("Hello, Alice!")
Workflow [completed]
```
