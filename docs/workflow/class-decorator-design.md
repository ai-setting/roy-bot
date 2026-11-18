# Workflow Class Decorator Design

> **版本**: v1.0  
> **状态**: 设计中  
> **最后更新**: 2026-04-12

---

## 1. 概述

### 1.1 目标

设计一套装饰器（Decorator）机制，允许开发者使用 TypeScript 类来声明式地定义 Workflow DAG。

### 1.2 核心价值

| 价值点 | 描述 |
|--------|------|
| **代码即配置** | 直接在代码中声明 workflow 结构，无需额外的 YAML/JSON |
| **类型安全** | 利用 TypeScript 装饰器和类型系统，提供编译时检查 |
| **直观易用** | 通过装饰器直接在方法上标注，结构清晰 |
| **可复用** | 类实例方法可以在不同 workflow 中复用 |

### 1.3 与现有机制的关系

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         Workflow 定义方式                                    │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│   方式一：YAML/JSON 定义 (已有)                                              │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  name: my-workflow                                                   │   │
│   │  nodes:                                                             │   │
│   │    - id: step1                                                       │   │
│   │      type: tool                                                      │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   方式二：装饰器定义 (新增)                                                  │
│   ┌─────────────────────────────────────────────────────────────────────┐   │
│   │  @Workflow({ name: 'my-workflow' })                                 │   │
│   │  class MyWorkflow {                                                  │   │
│   │    @NodeAs({ nodeId: 'step1' })                                    │   │
│   │    async step1() { ... }                                             │   │
│   └─────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
│   两种方式最终都会被转换为统一的 WorkflowDefinition                           │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 装饰器设计

### 2.1 核心装饰器

#### 2.1.1 `@Workflow` - Workflow 元数据

```typescript
/**
 * 声明一个类为 Workflow 类
 */
function Workflow(options: WorkflowOptions): ClassDecorator

interface WorkflowOptions {
  /** Workflow 名称 */
  name: string;
  /** 版本号 */
  version?: string;
  /** 描述 */
  description?: string;
  /** 入口节点 ID（入口方法），可以是单个或多个 */
  entry?: string | string[];
  /** 全局配置 */
  config?: {
    parallel_limit?: number | null;
    timeout?: number | null;
    retry?: RetryConfig;
    debug?: boolean;
  };
  /** 标签 */
  tags?: string[];
  /** 作者 */
  author?: string;
}
```

#### 2.1.2 `@NodeAs` - Node 装饰器

```typescript
/**
 * 将方法声明为 Workflow 的 Node
 */
function NodeAs(options: NodeAsOptions): MethodDecorator

interface NodeAsOptions {
  /** 节点 ID，默认使用方法名 */
  nodeId?: string;
  /** 节点类型 */
  nodeType?: 'tool' | 'skill' | 'agent' | 'workflow';
  /** 显示名称 */
  name?: string;
  /** 依赖的节点 ID 列表 */
  dependsOn?: string | string[];
  /** 执行条件（条件表达式） */
  condition?: string;
  /** 重试配置 */
  retry?: RetryConfig;
  /** 超时时间（毫秒） */
  timeout?: number;
  /** 节点配置（传递给执行器的参数） */
  config?: Record<string, unknown>;
}
```

#### 2.1.3 `@Edge` - 边装饰器

用于显式声明节点之间的边关系，提供了另一种定义依赖的方式：

```typescript
/**
 * 声明节点之间的边关系
 * 可以用于补充或覆盖 @NodeAs 中的 dependsOn
 */
function Edge(from: string, to: string): MethodDecorator

/**
 * 类级别的边声明
 */
function WorkflowEdges(edges: Array<{ from: string; to: string }>): ClassDecorator
```

---

### 2.2 使用示例

#### 2.2.1 基础用法

```typescript
import { Workflow, NodeAs, Edge } from '@roy-bot/workflow-decorators';

@Workflow({
  name: 'data-analysis-pipeline',
  version: '1.0',
  description: '数据分析流水线',
  entry: 'fetchData',
  config: {
    parallel_limit: 3,
    timeout: 300000,
  }
})
class DataAnalysisPipeline {
  
  @NodeAs({ 
    nodeId: 'fetchData',
    nodeType: 'tool',
    name: '获取数据',
    config: {
      tool: 'web_search',
    }
  })
  async fetchData(input: { query: string }) {
    // 获取数据
    const searchResult = await webSearch(input.query);
    return { data: searchResult };
  }

  @NodeAs({ 
    nodeId: 'analyzeTrend',
    dependsOn: 'fetchData',
    name: '分析趋势',
  })
  async analyzeTrend(input: { data: any }) {
    // 分析数据趋势
    return { trend: analyze(input.data) };
  }

  @NodeAs({ 
    nodeId: 'generateChart',
    dependsOn: 'fetchData',
    name: '生成图表',
  })
  async generateChart(input: { data: any }) {
    // 生成图表
    return { chartUrl: generate(input.data) };
  }

  @NodeAs({ 
    nodeId: 'generateReport',
    dependsOn: ['analyzeTrend', 'generateChart'],
    name: '生成报告',
  })
  async generateReport(input: { trend: any; chartUrl: string }) {
    // 汇总结果
    return { report: createReport(input) };
  }
}
```

#### 2.2.2 带参数的方法

```typescript
@Workflow({
  name: 'agent-workflow',
  entry: 'startAgent',
})
class AgentWorkflow {
  
  @NodeAs({
    nodeId: 'startAgent',
    nodeType: 'agent',
    config: {
      agent_type: 'analyzer',
    }
  })
  async startAgent(input: { query: string }) {
    const result = await this.agentRunner.run({
      type: 'analyzer',
      prompt: `分析: ${input.query}`,
    });
    return { result };
  }
}
```

#### 2.2.3 条件执行

```typescript
@Workflow({
  name: 'conditional-workflow',
  entry: 'check',
})
class ConditionalWorkflow {
  
  @NodeAs({
    nodeId: 'check',
    nodeType: 'tool',
  })
  async check(input: { value: number }) {
    return { 
      passes: input.value > 0,
      value: input.value 
    };
  }

  @NodeAs({
    nodeId: 'process',
    dependsOn: 'check',
    condition: '{{nodes.check.output.passes}} == true',  // 条件执行
  })
  async process(input: { value: number }) {
    return { processed: input.value * 2 };
  }

  @NodeAs({
    nodeId: 'fallback',
    dependsOn: 'check',
  })
  async fallback(input: { value: number }) {
    return { fallback: input.value * -1 };
  }
}
```

#### 2.2.4 带重试和超时

```typescript
@Workflow({
  name: 'reliable-workflow',
  entry: 'callAPI',
})
class ReliableWorkflow {
  
  @NodeAs({
    nodeId: 'callAPI',
    retry: {
      max_attempts: 3,
      backoff: 'exponential',
      initial_delay: 1000,
    },
    timeout: 30000,
  })
  async callAPI(input: { endpoint: string }) {
    return fetch(input.endpoint);
  }
}
```

---

## 3. 实现设计

### 3.1 模块结构

```
packages/workflow-decorators/
├── src/
│   ├── index.ts                      # 入口文件
│   ├── decorators/
│   │   ├── workflow.ts               # @Workflow 装饰器
│   │   ├── traced-as.ts              # @NodeAs 装饰器
│   │   └── edge.ts                   # @Edge 装饰器
│   ├── metadata/
│   │   ├── workflow-metadata.ts      # Workflow 元数据
│   │   ├── node-metadata.ts          # Node 元数据
│   │   └── metadata-keys.ts          # 元数据键定义
│   ├── extractor/
│   │   ├── class-extractor.ts        # 从类中提取元数据
│   │   └── workflow-converter.ts    # 转换为 WorkflowDefinition
│   ├── types/
│   │   └── index.ts                  # 类型定义
│   └── utils/
│       └── validation.ts             # 验证工具
└── package.json
```

### 3.2 元数据存储

使用 TypeScript 的 `Reflect.metadata` API 存储装饰器元数据：

```typescript
// metadata-keys.ts
export const WORKFLOW_METADATA_KEY = Symbol('workflow:metadata');
export const NODE_METADATA_KEY = Symbol('workflow:node');
export const EDGE_METADATA_KEY = Symbol('workflow:edges');
```

### 3.3 元数据结构

```typescript
// workflow-metadata.ts

export interface WorkflowMetadata {
  name: string;
  version: string;
  description?: string;
  entry?: string | string[];
  config?: WorkflowConfig;
  tags?: string[];
  author?: string;
  // 额外的类实例引用
  instance?: any;
}

// node-metadata.ts

export interface NodeMetadata {
  nodeId: string;
  nodeType?: 'tool' | 'skill' | 'agent' | 'workflow';
  name?: string;
  dependsOn?: string[];
  condition?: string;
  retry?: RetryConfig;
  timeout?: number;
  config?: Record<string, unknown>;
  methodName: string;
  method: Function;
}

// edge-metadata.ts

export interface EdgeMetadata {
  from: string;
  to: string;
}
```

### 3.4 WorkflowConverter

将带装饰器的类转换为 `WorkflowDefinition`：

```typescript
import { WorkflowDefinition, NodeDefinition } from '@roy-bot/workflow';

export class WorkflowConverter {
  
  /**
   * 从装饰器类转换为 WorkflowDefinition
   */
  static fromClass(
    targetClass: new (...args: any[]) => any,
    instance?: any
  ): WorkflowDefinition {
    // 1. 获取 Workflow 元数据
    const workflowMeta = this.extractWorkflowMetadata(targetClass);
    
    // 2. 获取所有 Node 元数据
    const nodeMetas = this.extractNodeMetadatas(targetClass);
    
    // 3. 转换为 NodeDefinition[]
    const nodes: NodeDefinition[] = nodeMetas.map(meta => ({
      id: meta.nodeId,
      type: meta.nodeType || 'tool',  // 默认 tool 类型
      name: meta.name,
      depends_on: meta.dependsOn || [],
      condition: meta.condition,
      retry: meta.retry,
      timeout: meta.timeout,
      config: {
        ...meta.config,
        // 存储方法信息用于执行
        _methodName: meta.methodName,
        _instance: instance,
      },
    }));
    
    // 4. 构建 WorkflowDefinition
    return {
      name: workflowMeta.name,
      version: workflowMeta.version || '1.0',
      description: workflowMeta.description,
      config: workflowMeta.config || {},
      nodes,
      entry: workflowMeta.entry || nodes[0]?.id,
      outputs: [],
      metadata: {
        tags: workflowMeta.tags || [],
        author: workflowMeta.author,
      },
    };
  }
  
  /**
   * 执行装饰器方法
   */
  static async executeNode(
    nodeDef: NodeDefinition,
    context: NodeExecutionContext
  ): Promise<NodeExecutionResult> {
    const instance = nodeDef.config?._instance;
    const methodName = nodeDef.config?._methodName;
    
    if (!instance || !methodName) {
      throw new Error('Missing method information');
    }
    
    const method = instance[methodName];
    if (typeof method !== 'function') {
      throw new Error(`Method ${methodName} is not a function`);
    }
    
    // 准备输入参数
    const input = this.prepareNodeInput(nodeDef, context);
    
    try {
      const result = await method.call(instance, input);
      return {
        output: result,
        durationMs: 0,  // 可由调用方设置
      };
    } catch (error) {
      return {
        output: undefined,
        error: error instanceof Error ? error : new Error(String(error)),
        durationMs: 0,
      };
    }
  }
  
  /**
   * 准备节点输入
   */
  private static prepareNodeInput(
    nodeDef: NodeDefinition,
    context: NodeExecutionContext
  ): any {
    const deps = nodeDef.depends_on || [];
    
    if (deps.length === 0) {
      return context.input;
    }
    
    // 收集依赖节点输出
    const input: Record<string, any> = {};
    for (const depId of deps) {
      input[depId] = context.previousOutputs.get(depId);
    }
    
    return input;
  }
}
```

---

## 4. 扩展 Node 类型支持

### 4.1 自定义执行器注册

由于装饰器类的方法执行需要特殊处理，我们需要一个 `DecoratorNodeExecutor`:

```typescript
/**
 * 装饰器类方法执行器
 */
export class DecoratorNodeExecutor {
  
  /**
   * 注册到 NodeRegistry
   */
  static register(registry: NodeRegistry): void {
    registry.register('decorator', (definition, context) => {
      return new DecoratorNode(definition, context);
    });
  }
}

/**
 * 装饰器节点
 */
class DecoratorNode implements Node {
  readonly type = 'decorator';
  
  constructor(
    private definition: NodeDefinition,
    private context: NodeContext
  ) {}
  
  async execute(context: NodeExecutionContext): Promise<NodeExecutionResult> {
    return WorkflowConverter.executeNode(this.definition, context);
  }
}
```

### 4.2 自动检测节点类型

```typescript
// 在 WorkflowConverter 中

private static inferNodeType(meta: NodeMetadata): string {
  // 1. 如果显式指定，使用指定的类型
  if (meta.nodeType) {
    return meta.nodeType;
  }
  
  // 2. 如果有 config 配置，尝试推断
  if (meta.config?.tool) return 'tool';
  if (meta.config?.skill) return 'skill';
  if (meta.config?.agent_type) return 'agent';
  if (meta.config?.workflow) return 'workflow';
  
  // 3. 默认 tool 类型
  return 'tool';
}
```

---

## 5. 执行流程

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         装饰器 Workflow 执行流程                              │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  1. 定义阶段                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  @Workflow({ name: 'my-workflow' })                                   │   │
│  │  class MyWorkflow {                                                  │   │
│  │    @NodeAs({ nodeId: 'step1' })                                    │   │
│  │    async step1() { ... }                                             │   │
│  │  }                                                                    │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                    │                                          │
│                                    ▼                                          │
│  2. 元数据提取                                                                │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  WorkflowConverter.fromClass(MyWorkflow, instance)                    │   │
│  │  → WorkflowDefinition                                                │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                    │                                          │
│                                    ▼                                          │
│  3. 执行阶段                                                                 │
│  ┌──────────────────────────────────────────────────────────────────────┐   │
│  │  engine.runWorkflow(workflowDef, options)                            │   │
│  │                                                                       │   │
│  │  NodeRegistry 创建节点时：                                            │   │
│  │  - 检测到 config._methodName 存在                                     │   │
│  │  - 创建 DecoratorNode                                                │   │
│  │                                                                       │   │
│  │  DecoratorNode.execute() 调用:                                       │   │
│  │  - instance[methodName](input)                                        │   │
│  └──────────────────────────────────────────────────────────────────────┘   │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. CLI 集成

### 6.1 新增命令

```bash
# 运行装饰器类定义的 workflow
roy workflow run-class <ClassName> --instance <instance-path>

# 示例
roy workflow run-class DataAnalysisPipeline --instance "./examples/my-pipeline.ts"

# 或者通过 import
roy workflow run-class --import "./dist/my-workflow.js:DataAnalysisPipeline"
```

### 6.2 实现方案

```typescript
// cli/commands/run-class.ts

export async function runClassWorkflow(
  classPath: string,
  options: RunOptions
): Promise<RunResult> {
  // 1. 动态导入类
  const module = await import(classPath);
  const TargetClass = module.default || Object.values(module)[0];
  
  // 2. 创建实例（如果需要）
  const instance = new TargetClass(...constructorArgs);
  
  // 3. 转换为 WorkflowDefinition
  const definition = WorkflowConverter.fromClass(TargetClass, instance);
  
  // 4. 执行
  const engine = await WorkflowEngine.create(options);
  return engine.runWorkflow(definition, options);
}
```

---

## 7. API 设计

### 7.1 公共 API

```typescript
// index.ts

// 装饰器
export { Workflow, WorkflowOptions } from './decorators/workflow';
export { NodeAs, NodeAsOptions } from './decorators/traced-as';
export { Edge, WorkflowEdges } from './decorators/edge';

// 转换器
export { WorkflowConverter } from './extractor/workflow-converter';

// 类型
export { 
  WorkflowMetadata,
  NodeMetadata,
  EdgeMetadata 
} from './metadata';
```

### 7.2 使用方式

```typescript
// 方式一：直接使用装饰器定义
import { Workflow, NodeAs, WorkflowConverter } from '@roy-bot/workflow-decorators';

@Workflow({ name: 'my-workflow' })
class MyWorkflow {
  @NodeAs({ nodeId: 'step1' })
  async step1() { /* ... */ }
}

// 转换为 WorkflowDefinition
const definition = WorkflowConverter.fromClass(MyWorkflow, new MyWorkflow());

// 使用 WorkflowEngine 执行
const engine = await WorkflowEngine.create(options);
const result = await engine.runWorkflow(definition);


// 方式二：使用便捷函数
import { createWorkflowFromClass } from '@roy-bot/workflow-decorators';

const workflow = createWorkflowFromClass(MyWorkflow, new MyWorkflow(), {
  name: 'my-workflow',
});
const engine = await WorkflowEngine.create(options);
const result = await engine.runWorkflow(workflow);
```

---

## 8. 验证与错误处理

### 8.1 编译时检查

通过 TypeScript 装饰器类型定义，提供编译时检查：

```typescript
// traced-as.ts

interface NodeAsOptions {
  nodeId?: string;
  nodeType?: 'tool' | 'skill' | 'agent' | 'workflow';
  // ... 其他选项
}

// TypeScript 会检查 nodeType 是否是有效值
```

### 8.2 运行时验证

```typescript
// validation.ts

export function validateWorkflowClass(targetClass: new (...args: any[]) => any): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // 1. 检查 @Workflow 装饰器
  const workflowMeta = Reflect.getMetadata(WORKFLOW_METADATA_KEY, targetClass);
  if (!workflowMeta) {
    errors.push('Class must be decorated with @Workflow');
    return { valid: false, errors };
  }
  
  // 2. 检查至少有一个 @NodeAs 节点
  const nodeMetas = extractNodeMetadatas(targetClass);
  if (nodeMetas.length === 0) {
    errors.push('At least one method must be decorated with @NodeAs');
  }
  
  // 3. 检查入口节点存在
  const entry = workflowMeta.entry;
  if (entry) {
    const entries = Array.isArray(entry) ? entry : [entry];
    for (const e of entries) {
      if (!nodeMetas.find(n => n.nodeId === e)) {
        errors.push(`Entry node '${e}' not found`);
      }
    }
  }
  
  // 4. 检查依赖节点存在
  for (const node of nodeMetas) {
    for (const dep of node.dependsOn || []) {
      if (!nodeMetas.find(n => n.nodeId === dep)) {
        errors.push(`Node '${node.nodeId}' depends on non-existent node '${dep}'`);
      }
    }
  }
  
  // 5. 检查循环依赖
  if (hasCycle(nodeMetas)) {
    errors.push('Workflow contains a cycle');
  }
  
  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
```

---

## 9. 与现有机制的集成

### 9.1 类型兼容性

```typescript
// 确保装饰器生成的 WorkflowDefinition 与现有 Schema 兼容
import { WorkflowDefinitionSchema } from '@roy-bot/workflow';

const definition = WorkflowConverter.fromClass(MyClass, instance);
const validated = WorkflowDefinitionSchema.parse(definition);
```

### 9.2 NodeRegistry 集成

```typescript
// 在 WorkflowComponent 初始化时注册 decorator 类型
import { DecoratorNodeExecutor } from '@roy-bot/workflow-decorators';

class WorkflowComponent {
  async initialize(config: WorkflowComponentConfig) {
    // ... 其他初始化
    
    // 注册装饰器节点执行器
    const nodeRegistry = this.getNodeRegistry();
    DecoratorNodeExecutor.register(nodeRegistry);
  }
}
```

### 9.3 Tool 集成

```typescript
// run-workflow.ts 支持装饰器类
class RunWorkflowTool {
  async invoke(params: RunWorkflowParams): Promise<ToolResult> {
    let definition: WorkflowDefinition;
    
    if (params.workflow instanceof Function) {
      // 装饰器类
      definition = WorkflowConverter.fromClass(params.workflow, params.instance);
    } else if (typeof params.workflow === 'string') {
      // 字符串名称或 YAML/JSON
      definition = await this.resolveWorkflow(params.workflow);
    }
    
    return this.engine.runWorkflow(definition, params.options);
  }
}
```

---

## 10. 实现计划

### Phase 1: 核心装饰器
- [ ] 定义元数据类型
- [ ] 实现 `@Workflow` 装饰器
- [ ] 实现 `@NodeAs` 装饰器
- [ ] 实现 `@Edge` 装饰器
- [ ] 单元测试

### Phase 2: 转换器
- [ ] 实现 `WorkflowConverter`
- [ ] 实现 `validateWorkflowClass`
- [ ] 单元测试

### Phase 3: 执行器
- [ ] 实现 `DecoratorNode`
- [ ] 注册到 NodeRegistry
- [ ] 集成测试

### Phase 4: CLI
- [ ] 新增 `run-class` 命令
- [ ] 集成测试

### Phase 5: 文档与示例
- [ ] API 文档
- [ ] 使用示例
- [ ] 最佳实践

---

## 11. 附录

### 11.1 完整类型定义

```typescript
// types/index.ts

export interface WorkflowOptions {
  name: string;
  version?: string;
  description?: string;
  entry?: string | string[];
  config?: WorkflowConfig;
  tags?: string[];
  author?: string;
}

export interface NodeAsOptions {
  nodeId?: string;
  nodeType?: 'tool' | 'skill' | 'agent' | 'workflow';
  name?: string;
  dependsOn?: string | string[];
  condition?: string;
  retry?: RetryConfig;
  timeout?: number;
  config?: Record<string, unknown>;
}

export interface EdgeOptions {
  from: string;
  to: string;
}

export interface RetryConfig {
  max_attempts: number;
  backoff: 'fixed' | 'exponential';
  initial_delay: number;
}

export interface WorkflowConfig {
  parallel_limit?: number | null;
  timeout?: number | null;
  retry?: RetryConfig;
  debug?: boolean;
}
```

### 11.2 FAQ

**Q: 为什么使用装饰器而不是直接定义？**

A: 装饰器提供了一种更直观的方式来定义 workflow 结构，代码即配置，特别适合：
- 单一职责的 workflow，逻辑都在一个类中
- 需要利用 TypeScript 类型系统的场景
- 想要在同一个文件中同时看到 workflow 结构和实现逻辑

**Q: 装饰器方式和 YAML 方式如何选择？**

A: 
- 使用装饰器：workflow 结构简单，逻辑都在一个类中
- 使用 YAML：workflow 复杂，需要外部编辑，或需要动态生成

**Q: 如何处理类的依赖注入？**

A: 在创建 workflow 实例时，可以手动注入依赖：

```typescript
class MyWorkflow {
  constructor(private db: Database, private api: ExternalAPI) {}
  
  @NodeAs({ nodeId: 'query' })
  async query() {
    return this.db.query('SELECT * FROM users');
  }
}

const instance = new MyWorkflow(myDb, myApi);
const definition = WorkflowConverter.fromClass(MyWorkflow, instance);
```

---

## Edge 边的连接方式

根据目前 workflow 的设计，边主要体现的是**节点间的执行顺序/数据依赖关系**。

### 方式一：`dependsOn` 依赖声明（最直接）

在 `@NodeAs` 中声明当前节点的依赖：

```typescript
@NodeAs({ 
  nodeId: 'generateReport',
  dependsOn: ['analyzeTrend', 'generateChart']  // 等待这两个节点完成
})
async generateReport(input: { trend: any; chartUrl: string }) {
  return { report: createReport(input) };
}
```

### 方式二：显式 `@WorkflowEdges` 装饰器

当需要更精细的边控制时（如条件边、数据路由）：

```typescript
@Workflow({ name: 'data-analysis-pipeline' })
@WorkflowEdges([
  { from: 'fetchData', to: 'analyzeTrend' },
  { from: 'fetchData', to: 'generateChart' },
  { from: ['analyzeTrend', 'generateChart'], to: 'generateReport' }
])
class DataAnalysisPipeline {
  
  @NodeAs({ nodeId: 'fetchData' })
  async fetchData() { }

  @NodeAs({ nodeId: 'analyzeTrend' })
  async analyzeTrend() { }

  @NodeAs({ nodeId: 'generateChart' })
  async generateChart() { }

  @NodeAs({ nodeId: 'generateReport' })
  async generateReport() { }
}
```

### 方式三：方法级 `@Edge` 装饰器

也可以在静态属性上声明边：

```typescript
@Workflow({ name: 'my-workflow' })
class MyWorkflow {
  @NodeAs({ nodeId: 'start' })
  async start() { }

  @NodeAs({ nodeId: 'end' })
  async end() { }

  // 使用静态属性声明边
  @Edge('start', 'end')
  static __edge_start_end__ = null;
}
```

### 完整示例：数据处理 Pipeline

```typescript
import { Workflow, NodeAs, WorkflowEdges, createWorkflowFromClass } from '@ai-setting/roy-bot-core';

@Workflow({ 
  name: 'data-analysis-pipeline',
  version: '1.0',
  entry: 'fetch',
  config: { parallel_limit: 3 }
})
@WorkflowEdges([
  { from: 'fetch', to: 'clean' },
  { from: 'clean', to: 'analyze' },
  { from: 'clean', to: 'detectAnomaly' },
  { from: 'clean', to: 'generateChart' },
  { from: ['analyze', 'detectAnomaly', 'generateChart'], to: 'report' }
])
class DataAnalysisPipeline {
  
  @NodeAs({ nodeId: 'fetch', nodeType: 'tool' })
  async fetch(input: { query: string }): Promise<{ data: any[] }> {
    return { data: await search(input.query) };
  }

  @NodeAs({ nodeId: 'clean', dependsOn: 'fetch' })
  async clean(input: { fetch: any }): Promise<{ cleanData: any[] }> {
    return { cleanData: transform(input.fetch.data) };
  }

  @NodeAs({ nodeId: 'analyze', dependsOn: 'clean' })
  async analyze(input: { clean: any }): Promise<{ trend: any }> {
    return { trend: analyzeTrend(input.clean.cleanData) };
  }

  @NodeAs({ nodeId: 'detectAnomaly', dependsOn: 'clean' })
  async detectAnomaly(input: { clean: any }): Promise<{ anomalies: any[] }> {
    return { anomalies: findAnomalies(input.clean.cleanData) };
  }

  @NodeAs({ nodeId: 'generateChart', dependsOn: 'clean' })
  async generateChart(input: { clean: any }): Promise<{ chartUrl: string }> {
    return { chartUrl: createChart(input.clean.cleanData) };
  }

  @NodeAs({ nodeId: 'report', dependsOn: ['analyze', 'detectAnomaly', 'generateChart'] })
  async report(input: { 
    analyze: any; 
    detectAnomaly: any; 
    generateChart: any 
  }): Promise<{ report: any }> {
    return { report: createReport(input) };
  }
}

// 创建 WorkflowDefinition
const workflow = createWorkflowFromClass(DataAnalysisPipeline);

// 执行
const engine = await WorkflowEngine.create(options);
const result = await engine.runWorkflow(workflow);
```

**生成的 DAG 结构**：

```
fetch
  │
  ▼
clean
  │
  ├──▶ analyze ──┐
  │              │
  ├──▶ detectAnomaly ─┼──▶ report
  │              │
  └──▶ generateChart ──┘
```
