# WorkflowComponent 设计目标文档

> **版本**: v1.0  
> **状态**: 设计中  
> **最后更新**: 2026-01-XX

---

## 1. 概述

### 1.1 目标

设计并实现 **WorkflowComponent**，为 roy-bot 提供一套完整的 DAG 流程编排能力。通过定义执行流程图（Workflow DAG），将多个执行步骤组织为可描述、可复用、可调试的工作流。

### 1.2 核心价值

| 价值点 | 描述 |
|--------|------|
| **流程编排** | 将 Tool、Skill、Agent 等执行单元编排为 DAG |
| **事件驱动** | 所有节点通过 Event 订阅/发布机制驱动执行 |
| **动态可扩展** | 支持运行时动态新增/移除节点 |
| **并行优化** | 自动识别无依赖节点，实现最大化并行执行 |
| **可调试性** | Debug 模式输出完整执行轨迹 |
| **无限嵌套** | Workflow 可作为 Node 嵌入更大的 Workflow |

### 1.3 与其他组件的关系

```
┌─────────────────────────────────────────────────────────────────┐
│                         Roy Agent                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐          │
│  │ToolComponent│   │SkillComponent│  │AgentComponent│          │
│  └──────┬──────┘   └──────┬──────┘   └──────┬──────┘          │
│         │                 │                 │                   │
│         │    ┌────────────┼────────────┐    │                   │
│         │    │            │            │    │                   │
│         ▼    ▼            ▼            ▼    ▼                   │
│  ┌─────────────────────────────────────────────────────┐        │
│  │                  WorkflowComponent                   │        │
│  │  ┌─────────────────────────────────────────────┐    │        │
│  │  │           WorkflowEngine (Event-Driven)      │    │        │
│  │  │                                             │    │        │
│  │  │   ToolNode ──▶ SkillNode ──▶ AgentNode     │    │        │
│  │  │        │           │           │           │    │        │
│  │  │        └───────────┴───────────┘           │    │        │
│  │  │                   │                         │    │        │
│  │  │            WorkflowNode (嵌套)              │    │        │
│  │  └─────────────────────────────────────────────┘    │        │
│  └─────────────────────────────────────────────────────┘        │
│                            │                                     │
│                            ▼                                     │
│                   ┌─────────────────┐                           │
│                   │  TaskComponent   │  (解耦，可互相调用)        │
│                   │  - 进程管理能力   │                           │
│                   └─────────────────┘                           │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 1.4 组件关系说明

| 关系 | 描述 |
|------|------|
| **ToolComponent** | Workflow 的执行单元之一，通过 ToolNode 封装 |
| **SkillComponent** | Workflow 的执行单元之一，通过 SkillNode 封装 |
| **AgentComponent** | Workflow 的执行单元之一，通过 AgentNode 封装 |
| **TaskComponent** | 解耦关系 - Task 提供进程管理，Workflow 提供编排能力，两者可互相调用 |
| **EventComponent** | WorkflowEngine 的核心驱动机制，节点间通过 Event 通信 |

---

## 2. 设计原则

### 2.1 核心原则

| # | 原则 | 说明 |
|---|------|------|
| P1 | **事件驱动一切** | 静态定义的 Workflow 也通过 Event 订阅/发布机制驱动 |
| P2 | **DAG 优先** | 所有 Workflow 必须是有向无环图，支持并行优化 |
| P3 | **可观测性** | 每个节点的输入、输出、状态变更都可通过 Event 追踪 |
| P4 | **幂等性** | 节点执行应尽可能幂等，便于重试和恢复 |
| P5 | **解耦设计** | Node、Engine、Storage 完全解耦，通过接口通信 |
| P6 | **可扩展性** | 新增 Node 类型不应修改 Engine 核心逻辑 |

### 2.2 架构原则

```
┌─────────────────────────────────────────────────────────────────────┐
│                        架构分层                                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                    Presentation Layer                        │   │
│   │   CLI Commands  │  Tool Interface  │  API Interface         │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                 │                                    │
│                                 ▼                                    │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                    Service Layer                            │   │
│   │   WorkflowService  │  WorkflowEngine  │  NodeRegistry        │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                 │                                    │
│                                 ▼                                    │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                    Core Layer                                │   │
│   │   DAG Manager  │  Event Bus  │  Executor  │  Scheduler      │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                 │                                    │
│                                 ▼                                    │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                  Persistence Layer                          │   │
│   │   SQLite Storage  │  Workflow Repository  │  Run Repository   │   │
│   └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Workflow DAG 定义

### 3.1 完整 Schema

```yaml
# Workflow Definition Schema
name: string                    # Workflow 名称（唯一）
version: string                 # 版本号，默认 "1.0"
description: string             # 描述

# 全局配置
config:
  parallel_limit: number | null  # 并行限制，默认 null 表示无限制
  timeout: number | null         # 全局超时（毫秒）
  retry:                         # 全局重试配置
    max_attempts: number
    backoff: "fixed" | "exponential"
    initial_delay: number
  debug: boolean                 # 默认 debug 模式

# 节点定义
nodes:
  - id: string                   # 节点 ID（唯一）
    type: string                 # 节点类型
    name: string                 # 显示名称（可选）
    config: object               # 节点配置（类型相关）
    depends_on:                  # 依赖的节点 ID 列表
      - string
    condition: string            # 执行条件表达式（可选）
    retry:                       # 节点级重试配置（覆盖全局）
    timeout: number              # 节点级超时（覆盖全局）

# 入口配置
entry: string | array           # 入口节点 ID 或 ID 列表

# 输出定义
outputs:
  - name: string                 # 输出名称
    source: string               # 来源节点 ID
    path: string                 # 数据路径（JSONPath）

# Metadata
metadata:
  author: string
  tags: array
  created_at: string
  updated_at: string
```

### 3.2 示例：完整 Workflow 定义

```yaml
name: data-analysis-pipeline
version: "1.0"
description: 数据分析流水线

config:
  parallel_limit: 3              # 最多 3 个节点并行
  timeout: 300000                # 5 分钟超时
  debug: false

nodes:
  # 数据获取节点（入口）
  - id: fetch-data
    type: tool
    name: 获取数据
    config:
      tool: web_search
      params:
        query: "{{input.query}}"
    
  # 并行处理分支
  - id: analyze-trend
    type: skill
    name: 分析趋势
    config:
      skill: data-analysis
      params:
        data: "{{nodes.fetch-data.result}}"
    depends_on: [fetch-data]
    
  - id: generate-chart
    type: tool
    name: 生成图表
    config:
      tool: python-exec
      params:
        code: "import matplotlib; ..."
    depends_on: [fetch-data]
    
  - id: sentiment-analysis
    type: agent
    name: 情感分析
    config:
      agent: analyzer
      params:
        text: "{{nodes.fetch-data.result}}"
    depends_on: [fetch-data]
    
  # 汇总节点（等待所有并行节点完成）
  - id: generate-report
    type: workflow
    name: 生成报告
    config:
      workflow: report-template
      params:
        trend: "{{nodes.analyze-trend.result}}"
        chart: "{{nodes.generate-chart.result}}"
        sentiment: "{{nodes.sentiment-analysis.result}}"
    depends_on: [analyze-trend, generate-chart, sentiment-analysis]

entry: [fetch-data]

outputs:
  - name: report
    source: generate-report
    path: result
```

### 3.3 节点类型配置

#### 3.3.1 ToolNode

```yaml
- id: my-tool-node
  type: tool
  config:
    tool: tool-name              # 注册在 ToolComponent 中的工具名
    params:                     # 工具参数
      arg1: value1
      arg2: "{{context.value}}"  # 支持模板语法
    # 可选
    mapping:                     # 结果映射
      output_field: "{{result.field}}"
```

#### 3.3.2 SkillNode

```yaml
- id: my-skill-node
  type: skill
  config:
    skill: skill-name           # 注册在 SkillComponent 中的技能名
    params:
      input: "{{input.value}}"
    # 可选
    timeout: 60000              # 技能执行超时
```

#### 3.3.3 AgentNode

```yaml
- id: my-agent-node
  type: agent
  config:
    agent: agent-name            # 注册在 AgentComponent 中的 Agent
    prompt: "{{input.prompt}}"
    params:                     # Agent 执行参数
      model: gpt-4
      temperature: 0.7
```

#### 3.3.4 WorkflowNode (嵌套)

```yaml
- id: sub-workflow-node
  type: workflow
  config:
    workflow: sub-workflow-name  # 嵌套的 Workflow 名称
    params:                     # 传递给子 Workflow 的参数
      data: "{{parent.data}}"
```

### 3.4 内联 Workflow 定义

支持在节点中直接定义匿名 Workflow：

```yaml
- id: inline-workflow-node
  type: workflow
  config:
    inline:
      name: anonymous-sub-workflow
      nodes:
        - id: step1
          type: tool
          config:
            tool: some-tool
      entry: step1
```

---

## 4. WorkflowEngine 架构

### 4.1 核心组件

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         WorkflowEngine                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────┐                                                    │
│  │   DAG Manager   │  管理 DAG 图结构、拓扑排序、依赖解析                  │
│  └────────┬────────┘                                                    │
│           │                                                              │
│           ▼                                                              │
│  ┌─────────────────┐      ┌─────────────────┐                          │
│  │   Event Bus     │◀────▶│   Scheduler     │                          │
│  │   (Internal)    │      │                 │                          │
│  └────────┬────────┘      └────────┬────────┘                          │
│           │                          │                                    │
│           │    ┌─────────────────┐   │                                    │
│           └───▶│  Node Registry  │◀──┘                                    │
│                │                 │                                        │
│                └────────┬────────┘                                        │
│                         │                                                  │
│                         ▼                                                  │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                        Node Pool                                 │    │
│  │  ┌────────┐  ┌────────┐  ┌────────┐  ┌────────┐                │    │
│  │  │ToolNode│  │SkillNode│ │AgentNode│ │WorkflowNode│ ...          │    │
│  │  └────────┘  └────────┘  └────────┘  └────────┘                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                        Executor                                  │    │
│  │  并行执行引擎，管理节点执行线程/协程，处理超时和取消                │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.2 Event-Driven 执行模型

#### 4.2.1 核心事件类型

```typescript
// Workflow 生命周期事件
type WorkflowEvent =
  | { type: "workflow.started"; runId: string; workflowName: string; timestamp: number }
  | { type: "workflow.paused"; runId: string; timestamp: number }
  | { type: "workflow.resumed"; runId: string; timestamp: number }
  | { type: "workflow.stopped"; runId: string; reason: string; timestamp: number }
  | { type: "workflow.completed"; runId: string; result: any; duration: number }
  | { type: "workflow.failed"; runId: string; error: Error; failedAt: string }
  | { type: "workflow.output"; runId: string; output: Record<string, any> }

// 节点生命周期事件
  | { type: "node.scheduled"; runId: string; nodeId: string; timestamp: number }
  | { type: "node.started"; runId: string; nodeId: string; input: any; timestamp: number }
  | { type: "node.progress"; runId: string; nodeId: string; progress: number; message?: string }
  | { type: "node.completed"; runId: string; nodeId: string; output: any; duration: number }
  | { type: "node.failed"; runId: string; nodeId: string; error: Error; timestamp: number }
  | { type: "node.skipped"; runId: string; nodeId: string; reason: string }

// 节点间数据流事件
  | { type: "node.data"; runId: string; fromNode: string; toNode: string; data: any }

// 动态节点事件
  | { type: "node.added"; runId: string; nodeId: string; node: NodeDefinition }
  | { type: "node.removed"; runId: string; nodeId: string }

// 控制事件
  | { type: "control.pause"; runId: string }
  | { type: "control.resume"; runId: string }
  | { type: "control.stop"; runId: string }
```

#### 4.2.2 Event 消息格式

```json
{
  "event_type": "node.completed",
  "run_id": "run_xxx",
  "workflow_name": "my-workflow",
  "source": "node_id",
  "target": ["downstream_node_id"],
  "payload": {
    "output": { "result": "..." }
  },
  "metadata": {
    "timestamp": 1704067200000,
    "duration_ms": 1234,
    "debug_mode": true
  }
}
```

#### 4.2.3 执行流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Event-Driven 执行流程                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. 启动 Workflow                                                            │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  发布: workflow.started                                               │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                    │                                          │
│                                    ▼                                          │
│  2. 入口节点调度                                                              │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  发布: node.scheduled (entry-node)                                    │   │
│  │  EventBus 通知 Scheduler                                               │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                    │                                          │
│                                    ▼                                          │
│  3. 节点执行                                                                  │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  发布: node.started                                                   │   │
│  │  Node 执行逻辑...                                                      │   │
│  │  发布: node.completed / node.failed                                   │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                    │                                          │
│                    ┌───────────────┴───────────────┐                       │
│                    ▼                               ▼                       │
│  4a. 单节点完成                        4b. 多节点并行完成                       │
│  ┌────────────────────────┐           ┌─────────────────────────────────┐   │
│  │ node.data 发布到下游    │           │ Barrier 等待所有依赖节点完成     │   │
│  │ 下游节点收到 data 后    │           │ 全部完成后发布聚合结果            │   │
│  │ 发布 node.scheduled    │           │ 下游节点收到数据后继续            │   │
│  └────────────────────────┘           └─────────────────────────────────┘   │
│                                    │                                          │
│                                    ▼                                          │
│  5. 完成/失败                                                                       │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  workflow.completed / workflow.failed                                 │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 生命周期管理

```
                    ┌──────────┐
                    │  IDLE    │  (已创建，未启动)
                    └────┬─────┘
                         │ start()
                         ▼
                    ┌──────────┐
         ┌─────────▶│ RUNNING  │◀────────┐
         │          └────┬─────┘         │
         │               │               │
         │    pause()    │    resume()   │
         │               │               │
         │               ▼               │
         │          ┌──────────┐         │
         │          │ PAUSED   │─────────┘
         │          └────┬─────┘  resume()
         │               │
         │               │ stop() / 完成 / 失败
         │               ▼
         │          ┌──────────┐
         │          │ STOPPED  │
         │          └────┬─────┘
         │               │
         │               │ reset()
         │               │
         └───────────────┘
```

| 状态 | 说明 | 支持的操作 |
|------|------|-----------|
| IDLE | 已创建，未启动 | start() |
| RUNNING | 执行中 | pause(), stop() |
| PAUSED | 已暂停 | resume(), stop() |
| STOPPED | 已停止（正常/异常/手动） | reset() |

### 4.4 并行执行策略

```typescript
interface ParallelStrategy {
  // 模式
  mode: "auto" | "manual";
  
  // 自动模式配置
  auto: {
    maxConcurrency: number | null;  // null 表示无限制
    prioritizeCritical: boolean;     // 优先执行关键路径
  };
  
  // 手动模式配置
  manual: {
    parallelGroups: string[][];  // 手动指定可并行的节点组
  };
}
```

**并行执行示例：**

```yaml
# DAG 结构
A → B → D
A → C → D

# 执行顺序
# Step 1: A (入口)
# Step 2: B, C (并行，无依赖)
# Step 3: D (等待 B, C 完成)
```

---

## 5. 动态 DAG 支持

### 5.1 动态节点类型

#### 5.1.1 EventSourceNode

```yaml
- id: event-source
  type: event-source
  name: 事件源
  config:
    source: "external-events"       # 外部事件通道
    filter: "type == 'data.input'" # 事件过滤
    # 当收到事件时，自动触发下游节点
```

#### 5.1.2 动态添加节点

```typescript
// 运行时动态添加节点
await workflowEngine.addNode(runId, {
  id: "new-node",
  type: "tool",
  config: { tool: "some-tool" },
  depends_on: ["existing-node"]
});

// 发布节点添加事件
eventBus.publish({
  type: "node.added",
  runId,
  nodeId: "new-node",
  node: { ... }
});
```

#### 5.1.3 动态移除节点

```typescript
// 运行时动态移除节点
await workflowEngine.removeNode(runId, "node-to-remove");

// 发布节点移除事件
eventBus.publish({
  type: "node.removed",
  runId,
  nodeId: "node-to-remove"
});
```

### 5.2 动态订阅机制

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         动态节点订阅机制                                      │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Event Bus                                                                  │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │                                                                      │   │
│  │   事件通道                                                           │   │
│  │   ┌─────────────────────────────────────────────────────────────┐   │   │
│  │   │ workflow.run_xxx.node.completed                              │   │   │
│  │   └─────────────────────────────────────────────────────────────┘   │   │
│  │                          │                                            │   │
│  │           ┌──────────────┼──────────────┐                           │   │
│  │           ▼              ▼              ▼                            │   │
│  │   ┌────────────┐  ┌────────────┐  ┌────────────┐                     │   │
│  │   │ Node A     │  │ Node B     │  │ 动态节点   │                     │   │
│  │   │ (静态)     │  │ (静态)     │  │ (动态)     │                     │   │
│  │   └────────────┘  └────────────┘  └────────────┘                     │   │
│  │                                                                      │   │
│  └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│  动态节点可在运行时订阅任意事件通道                                            │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. 内置 Node 类型

### 6.1 ToolNode

**封装目标**: ToolComponent 中注册的 Tool

```typescript
class ToolNode implements Node {
  readonly type = "tool";
  
  constructor(
    private toolRegistry: ToolRegistry,
    private toolName: string,
    private params: Record<string, any>
  ) {}
  
  async execute(context: NodeContext): Promise<NodeResult> {
    const tool = this.toolRegistry.get(this.toolName);
    const result = await tool.invoke(this.resolveParams(context));
    return { output: result };
  }
  
  // 参数解析：支持模板语法
  private resolveParams(context: NodeContext): Record<string, any> {
    return resolveTemplate(this.params, context);
  }
}
```

### 6.2 SkillNode

**封装目标**: SkillComponent 中注册的 Skill

```typescript
class SkillNode implements Node {
  readonly type = "skill";
  
  constructor(
    private skillRegistry: SkillRegistry,
    private skillName: string,
    private params: Record<string, any>
  ) {}
  
  async execute(context: NodeContext): Promise<NodeResult> {
    const skill = this.skillRegistry.get(this.skillName);
    const result = await skill.execute(this.resolveParams(context));
    return { output: result };
  }
}
```

### 6.3 AgentNode

**封装目标**: AgentComponent 中的 Agent

```typescript
class AgentNode implements Node {
  readonly type = "agent";
  
  constructor(
    private agentRunner: AgentRunner,
    private agentName: string,
    private prompt: string,
    private params: AgentParams
  ) {}
  
  async execute(context: NodeContext): Promise<NodeResult> {
    const result = await this.agentRunner.run({
      agent: this.agentName,
      prompt: this.resolveTemplate(this.prompt, context),
      ...this.params
    });
    return { output: result };
  }
}
```

### 6.4 WorkflowNode

**封装目标**: 其他 Workflow（支持嵌套）

```typescript
class WorkflowNode implements Node {
  readonly type = "workflow";
  
  constructor(
    private workflowEngine: WorkflowEngine,
    private subWorkflowName: string,
    private params: Record<string, any>
  ) {}
  
  async execute(context: NodeContext): Promise<NodeResult> {
    // 创建子 Workflow Run
    const runId = await this.workflowEngine.createRun({
      workflow: this.subWorkflowName,
      input: this.resolveParams(context),
      parentRunId: context.runId  // 记录父 Run
    });
    
    // 执行子 Workflow（同步等待完成）
    const result = await this.workflowEngine.run(runId);
    
    return { output: result };
  }
}
```

---

## 7. CLI 命令设计

### 7.1 命令结构

```
roy workflow <subcommand> [options]
```

### 7.2 子命令

| 命令 | 说明 | 示例 |
|------|------|------|
| `roy workflow add` | 添加新 Workflow | `roy workflow add my-flow --file workflow.yaml` |
| `roy workflow get` | 获取 Workflow 信息 | `roy workflow get my-flow` / `roy workflow get --run-id run_xxx` |
| `roy workflow update` | 更新 Workflow | `roy workflow update my-flow --file workflow.yaml` |
| `roy workflow remove` | 删除 Workflow | `roy workflow remove my-flow` |
| `roy workflow list` | 列出所有 Workflow | `roy workflow list` |
| `roy workflow run` | 运行 Workflow | `roy workflow run my-flow` |

### 7.3 详细命令说明

#### 7.3.1 workflow add

```bash
roy workflow add <name> --file <path> [options]

Options:
  --file, -f <path>       Workflow 定义文件 (YAML/JSON) [必需]
  --description, -d <str> Workflow 描述
  --tags <tags>           标签，逗号分隔
  --force                 覆盖已存在的 Workflow
```

#### 7.3.2 workflow get

```bash
roy workflow get <name|run-id> [options]

Options:
  --run-id                通过 Run ID 查询
  --include-nodes        包含节点详情
  --include-runs          包含运行历史
  --output, -o <format>   输出格式: table|json|yaml
```

#### 7.3.3 workflow update

```bash
roy workflow update <name> [options]

Options:
  --file, -f <path>       新的 Workflow 定义文件
  --description, -d <str> 更新描述
  --tags <tags>           更新标签
```

#### 7.3.4 workflow remove

```bash
roy workflow remove <name> [options]

Options:
  --force                 强制删除（含运行记录）
  --include-runs          同时删除所有运行记录
```

#### 7.3.5 workflow list

```bash
roy workflow list [options]

Options:
  --tag <tag>             按标签筛选
  --limit <n>             返回数量限制
  --offset <n>            分页偏移
  --output, -o <format>   输出格式: table|json|yaml
```

#### 7.3.6 workflow run

```bash
roy workflow run <name|file> [options]

Options:
  --debug                 开启 Debug 模式，输出详细日志
  --input, -i <json>      输入参数 (JSON 格式)
  --parallel-limit <n>   覆盖 Workflow 中的并行限制
  --timeout <ms>          覆盖超时时间
  --watch                 实时显示执行进度
```

#### 7.3.7 workflow 控制命令

```bash
# 暂停运行中的 Workflow
roy workflow pause <run-id>

# 恢复暂停的 Workflow
roy workflow resume <run-id>

# 停止运行中的 Workflow
roy workflow stop <run-id>

# 查看运行状态
roy workflow status <run-id>
```

---

## 8. 持久化设计

### 8.1 数据库 Schema

```sql
-- Workflow 定义表
CREATE TABLE workflows (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL DEFAULT '1.0',
  description TEXT,
  definition TEXT NOT NULL,  -- JSON 存储完整 DAG 定义
  config TEXT,               -- JSON 存储配置
  metadata TEXT,             -- JSON 存储元信息
  tags TEXT,                 -- JSON 数组存储标签
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_workflows_name ON workflows(name);
CREATE INDEX idx_workflows_tags ON workflows(tags);

-- Workflow 运行记录表
CREATE TABLE workflow_runs (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  status TEXT NOT NULL,  -- idle|running|paused|stopped|completed|failed
  input TEXT,            -- JSON
  output TEXT,           -- JSON
  error TEXT,
  started_at TEXT,
  paused_at TEXT,
  resumed_at TEXT,
  stopped_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  debug_mode INTEGER DEFAULT 0,
  parent_run_id TEXT,    -- 嵌套 Workflow 时记录父 Run
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);

CREATE INDEX idx_runs_workflow_id ON workflow_runs(workflow_id);
CREATE INDEX idx_runs_status ON workflow_runs(status);
CREATE INDEX idx_runs_parent ON workflow_runs(parent_run_id);

-- 节点执行记录表
CREATE TABLE node_runs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  node_type TEXT NOT NULL,
  status TEXT NOT NULL,  -- scheduled|started|completed|failed|skipped
  input TEXT,
  output TEXT,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  duration_ms INTEGER,
  FOREIGN KEY (run_id) REFERENCES workflow_runs(id)
);

CREATE INDEX idx_node_runs_run_id ON node_runs(run_id);
CREATE INDEX idx_node_runs_node ON node_runs(run_id, node_id);
```

### 8.2 数据模型

```typescript
interface Workflow {
  id: string;
  name: string;
  version: string;
  description?: string;
  definition: WorkflowDefinition;
  config: WorkflowConfig;
  metadata: WorkflowMetadata;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
}

interface WorkflowRun {
  id: string;
  workflowId: string;
  workflowName: string;
  status: RunStatus;
  input?: Record<string, any>;
  output?: Record<string, any>;
  error?: string;
  startedAt?: Date;
  pausedAt?: Date;
  resumedAt?: Date;
  stoppedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
  debugMode: boolean;
  parentRunId?: string;
}

interface NodeRun {
  id: string;
  runId: string;
  nodeId: string;
  nodeType: string;
  status: NodeStatus;
  input?: any;
  output?: any;
  error?: string;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
}
```

---

## 9. Tool 注册

### 9.1 run-workflow Tool

WorkflowComponent 仅注册一个 Tool 到 ToolComponent：

```typescript
const runWorkflowTool: Tool = {
  name: "run_workflow",
  description: "执行一个 Workflow DAG，支持同步/异步模式",
  
  parameters: {
    type: "object",
    properties: {
      workflow: {
        type: "string",
        description: "Workflow 名称或 YAML/JSON 定义"
      },
      input: {
        type: "object",
        description: "传递给 Workflow 的输入参数"
      },
      debug: {
        type: "boolean", 
        description: "开启 Debug 模式，输出中间状态"
      },
      parallel_limit: {
        type: "integer",
        description: "并行执行限制"
      }
    },
    required: ["workflow"]
  },
  
  async invoke(params: RunWorkflowParams): Promise<ToolResult> {
    const engine = this.getEngine();
    
    if (params.debug) {
      // Debug 模式：订阅所有事件并输出
      engine.on("workflow:*", (event) => {
        this.eventBus.publish({
          type: `workflow:${event.type}`,
          data: event
        });
      });
    }
    
    // 执行 Workflow（默认同步等待完成 — Task #2086 已移除 sync: false fire-and-forget 模式）
    const runId = await engine.run(params.workflow, {
      input: params.input,
      debug: params.debug ?? false
    });
    
    // 等待结果
    const result = await engine.waitForCompletion(runId);
    
    return { output: result };
  }
};
```

### 9.2 Tool 使用示例

```json
{
  "tool": "run_workflow",
  "params": {
    "workflow": "data-analysis-pipeline",
    "input": {
      "query": "AI 发展趋势 2024"
    },
    "debug": false
  }
}
```

---

## 10. Debug 模式

### 10.1 Event 输出

Debug 模式下，所有 Workflow Event 都会以带 `workflow:` 前缀的形式发布：

```typescript
// Debug 模式的事件发布
eventBus.publish({
  type: `workflow:${originalEvent.type}`,
  data: {
    runId: context.runId,
    nodeId: context.nodeId,
    payload: originalEvent,
    timestamp: Date.now()
  }
});
```

### 10.2 事件追踪

```json
{
  "type": "workflow:node.completed",
  "data": {
    "runId": "run_abc123",
    "nodeId": "fetch-data",
    "payload": {
      "output": { "result": "..." },
      "duration_ms": 1234
    },
    "timestamp": 1704067200000
  }
}
```

### 10.3 CLI Debug 输出

```bash
$ roy workflow run my-flow --debug

🔄 Workflow started: my-flow (run_abc123)
   ⏳ Node: fetch-data [starting]
   ⏳ Node: fetch-data [running...]
   ✅ Node: fetch-data completed (1.2s)
   ┌─ Parallel execution: 3 nodes
   │  ⏳ Node: analyze-trend [running...] (pid: 1234)
   │  ⏳ Node: generate-chart [running...] (pid: 1235)
   │  ⏳ Node: sentiment-analysis [running...] (pid: 1236)
   │
   │  ✅ Node: generate-chart completed (0.8s)
   │  ✅ Node: analyze-trend completed (2.1s)
   │  ✅ Node: sentiment-analysis completed (3.5s)
   │
   │  ⏳ Node: generate-report [starting]
   │  ...
   
✅ Workflow completed (run_abc123) - 7.8s
```

---

## 11. Task 与 Workflow 互操作

### 11.1 Task 调用 Workflow

```typescript
// TaskComponent 中集成 WorkflowEngine
class TaskExecutor {
  async executeWithWorkflow(taskId: string, workflowName: string) {
    const workflowEngine = this.workflowService.getEngine();
    
    // 创建 Workflow Run
    const runId = await workflowEngine.createRun({
      workflow: workflowName,
      input: { taskId }
    });
    
    // 监听进度，更新 Task 状态
    workflowEngine.on("node.completed", async (event) => {
      await this.updateTaskProgress(taskId, {
        currentNode: event.nodeId,
        progress: this.calculateProgress(event.runId, event.nodeId)
      });
    });
    
    // 执行
    return await workflowEngine.run(runId);
  }
}
```

### 11.2 Workflow 调用 Task

```yaml
# Workflow 中嵌入 Task 节点
nodes:
  - id: long-running-task
    type: task
    name: 执行长任务
    config:
      task_id: "{{input.task_id}}"
      wait_for_completion: true
    depends_on: [previous-step]
```

```typescript
// TaskNode 实现
class TaskNode implements Node {
  async execute(context: NodeContext): Promise<NodeResult> {
    const taskId = this.resolveParam("task_id", context);
    const task = await this.taskService.getTask(taskId);
    
    // 推进 Task 执行
    await this.taskService.advance(taskId);
    
    if (this.config.wait_for_completion) {
      // 等待 Task 完成
      await this.taskService.waitForCompletion(taskId);
    }
    
    return { output: await task.getResult() };
  }
}
```

---

## 12. 后续扩展计划

### 12.1 第二批 Node 类型

| Node | 说明 | 优先级 |
|------|------|--------|
| ConditionNode | 条件分支 | P1 |
| LoopNode | 循环执行 | P2 |
| TransformNode | 数据转换 | P3 |
| ParallelNode | 并行执行容器 | P4 |

### 12.2 ConditionNode 设计

```yaml
- id: decide-path
  type: condition
  name: 条件判断
  config:
    expression: "{{nodes.analyze.output.confidence}} > 0.8"
    branches:
      true: [high-confidence-path]
      false: [low-confidence-path]
```

### 12.3 LoopNode 设计

```yaml
- id: retry-loop
  type: loop
  name: 重试循环
  config:
    max_iterations: 3
    condition: "{{nodes.check.output.success}} == false"
    nodes:
      - id: attempt
        type: tool
        config:
          tool: some-tool
```

---

## 13. 文件结构

```
roy-bot/
├── src/
│   └── components/
│       └── workflow/
│           ├── index.ts                    # 组件入口
│           ├── types/                      # 类型定义
│           │   ├── workflow.ts
│           │   ├── node.ts
│           │   ├── event.ts
│           │   └── run.ts
│           ├── engine/                      # WorkflowEngine
│           │   ├── engine.ts               # 核心引擎
│           │   ├── dag-manager.ts         # DAG 管理
│           │   ├── event-bus.ts           # 事件总线
│           │   ├── scheduler.ts          # 调度器
│           │   └── executor.ts            # 执行器
│           ├── nodes/                      # 内置节点
│           │   ├── base.ts                 # 基础节点类
│           │   ├── tool-node.ts
│           │   ├── skill-node.ts
│           │   ├── agent-node.ts
│           │   └── workflow-node.ts
│           ├── registry/                   # 注册表
│           │   ├── node-registry.ts
│           │   ├── workflow-registry.ts
│           │   └── run-registry.ts
│           ├── storage/                     # 持久化
│           │   ├── sqlite.ts
│           │   ├── workflow-repo.ts
│           │   └── run-repo.ts
│           ├── service/                    # 服务层
│           │   ├── workflow-service.ts
│           │   └── engine-service.ts
│           ├── cli/                         # CLI 命令
│           │   ├── workflow-command.ts
│           │   ├── commands/
│           │   │   ├── add.ts
│           │   │   ├── get.ts
│           │   │   ├── update.ts
│           │   │   ├── remove.ts
│           │   │   ├── list.ts
│           │   │   └── run.ts
│           │   └── renderers/
│           │       ├── table.ts
│           │       └── tree.ts
│           └── tool/                        # Tool 注册
│               └── run-workflow.ts
├── docs/
│   └── workflow/
│       ├── design-goals.md                  # 本文档
│       ├── implementation.md                 # 实现文档
│       └── examples/                         # 示例
│           ├── basic.yaml
│           ├── parallel.yaml
│           └── nested.yaml
└── tests/
    └── workflow/
        ├── engine.test.ts
        ├── dag-manager.test.ts
        ├── nodes/
        │   ├── tool-node.test.ts
        │   ├── skill-node.test.ts
        │   └── agent-node.test.ts
        └── cli.test.ts
```

---

## 14. 附录

### 14.1 术语表

| 术语 | 说明 |
|------|------|
| DAG | Directed Acyclic Graph，有向无环图 |
| Workflow | 工作流定义，包含节点和边 |
| Workflow Run | 工作流的一次执行实例 |
| Node | 工作流中的执行单元 |
| Edge | 节点间的依赖关系 |
| Event Bus | 事件总线，负责事件发布订阅 |
| Scheduler | 调度器，决定节点执行顺序 |
| Executor | 执行器，负责实际执行节点逻辑 |

### 14.2 参考资料

- [x] Roy Agent 架构设计文档
- [x] ToolComponent 实现参考
- [x] TaskComponent 实现参考
- [x] SkillComponent 实现参考
