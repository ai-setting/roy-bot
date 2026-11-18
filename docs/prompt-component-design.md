# PromptComponent 设计文档

> 版本: 4.0.0 | 日期: 2026-03-27 | 状态: ✅ 已实现

---

## 1. 概述

### 1.1 设计目标

PromptComponent 是 roy-bot 的提示词管理组件，负责：

- **内置 Prompt**：管理仓库内置的默认 prompt md 文件
- **外部扩展**：支持从外部路径加载额外的 prompt
- **变量替换**：支持模板变量渲染
- **Hook 扩展**：`before.render` / `after.render` 拦截 prompt 修改
- **配置驱动**：通过 ConfigComponent 管理外部路径配置

### 1.2 实现状态

| 功能 | 状态 | 说明 |
|------|------|------|
| 内置 Prompts | ✅ | default, coding, review |
| 外部扩展加载 | ✅ | 文件/目录加载 |
| 变量替换 | ✅ | `{{variable}}` 语法 |
| Hook 机制 | ✅ | before.render, after.render |
| ConfigComponent 集成 | ✅ | 支持 |
| 单元测试 | ✅ | 39 tests, all passing |

---

## 2. 架构设计

### 2.1 目录结构

```
packages/core/src/env/prompt/
├── index.ts                    # 导出入口
├── prompt-component.ts         # PromptComponent 实现
├── renderer.ts                 # 模板渲染器
├── types.ts                   # 类型定义
├── prompts/                   # 内置 Prompts
│   ├── default.md            # 默认助手
│   ├── coding.md              # 编码助手
│   └── review.md             # 代码审查
```

### 2.2 核心数据结构

```typescript
interface PromptComponent {
  name: "prompt";
  version: "1.0.0";
  
  // 核心存储
  private prompts: Map<string, PromptEntry>;
  
  // 渲染器
  private renderer: PromptRenderer;
  
  // Hooks
  readonly hooks: HookMap;
}

// PromptEntry
interface PromptEntry {
  name: string;
  content: string;
  source: "built-in" | "file" | "directory" | "inline";
  filePath?: string;
  overridable: boolean;
  loadedAt: number;
}
```

---

## 3. 配置结构

### 3.1 PromptConfig

```typescript
interface PromptConfig {
  promptPaths: PromptPath[];     // 外部路径配置
  defaultName: string;          // 默认 prompt 名称
  variablePrefix: string;       // 变量前缀，默认 "{{"
  variableSuffix: string;       // 变量后缀，默认 "}}"
  strictMode: boolean;          // 严格模式
}

interface PromptPath {
  type: "file" | "directory";
  path: string;
  name?: string;
  recursive?: boolean;
  extension?: string;
}
```

### 3.2 配置文件格式

```jsonc
// prompt-config.jsonc
{
  "defaultName": "default",
  "promptPaths": [
    { "type": "directory", "path": "./my-prompts", "recursive": true },
    { "type": "file", "path": "./custom/coding.md" }
  ],
  "variablePrefix": "{{",
  "variableSuffix": "}}",
  "strictMode": false
}
```

---

## 4. 核心 API

### 4.1 初始化

```typescript
const promptComp = new PromptComponent();

// 方式1: 直接传入配置
await promptComp.init({
  options: {
    config: {
      defaultName: "default",
      promptPaths: [{ type: "directory", path: "./prompts" }],
    },
  },
});

// 方式2: 通过 ConfigComponent
await promptComp.init({
  configComponent,
  configPath: "config/prompt-config.jsonc",
});
```

### 4.2 基本操作

```typescript
// 添加 prompt
promptComp.add("name", "Content");

// 获取原始内容
const content = promptComp.get("name");

// 检查存在
promptComp.has("name");

// 删除
promptComp.delete("name");

// 列表
promptComp.list();
promptComp.size();
```

### 4.3 获取并渲染

```typescript
// 获取并渲染 prompt
const rendered = await promptComp.getPrompt("coding", {
  style_guide: "ESLint",
  task_description: "Fix the bug",
});

// 单独渲染
const result = promptComp.render("Hello {{name}}!", { name: "Alice" });
// result: "Hello Alice!"
```

### 4.4 Hooks

```typescript
// 使用统一的 Hook 接口注册 hook
promptComp.registerHook("prompt.before-render", {
  name: "logger",
  priority: 10,
  execute: async (ctx) => {
    if (ctx.phase === "before") {
      console.log(`Rendering: ${ctx.data.name}`);
    } else {
      console.log(`Rendered ${ctx.data.renderedContent.length} chars`);
    }
  },
});

// 也可以使用便捷方法注册特定阶段
promptComp.registerBeforeRenderHook("my-before-hook", async (ctx) => {
  console.log(`Before rendering: ${ctx.name}`);
});

promptComp.registerAfterRenderHook("my-after-hook", async (ctx) => {
  console.log(`After rendering: ${ctx.name}`);
});

// Hook 上下文（通过 ctx.data 访问）
interface PromptHookContext {
  name: string;
  originalContent: string;
  renderedContent: string;  // after hook 可修改
  variables: Record<string, string>;
}

// 统一 Hook 上下文结构
interface HookContext<T = unknown> {
  component: { name: string; version: string };
  data: T;  // 包含 PromptHookContext
  metadata: Record<string, unknown>;
  phase: "before" | "after" | "error";
  hookPoint: string;
}
```

### 4.5 文件加载

```typescript
// 从文件加载
await promptComp.loadFromFile("/path/to/prompt.md", "custom-name");

// 从目录加载
await promptComp.loadFromDirectory("/path/to/prompts", ".md", true);
```

---

## 5. 内置 Prompts

### 5.1 default.md

```markdown
You are a helpful, respectful, and honest assistant.

Guidelines:
- Provide accurate and helpful information
- Be clear and concise in your responses
- Ask clarifying questions when needed
- Admit when you don't know something
```

### 5.2 coding.md

```markdown
You are an expert software developer.

Guidelines:
- Write clean, maintainable, and well-documented code
- Follow {{style_guide}}
- Consider edge cases and error handling
- Explain your reasoning when helpful

Current task: {{task_description}}

{{additional_context}}
```

### 5.3 review.md

```markdown
You are a code reviewer.

Guidelines:
- Be thorough but constructive
- Focus on logic, security, and maintainability
- Suggest improvements with examples
- Approve when code meets standards

Files to review:
{{files_to_review}}

Review type: {{review_type}}
```

---

## 6. 与 AgentComponent 集成

```typescript
// AgentComponent.buildMessages()
private async buildMessages(ctx: HookContext, query: string): Promise<ModelMessage[]> {
  const messages: ModelMessage[] = [];

  if (!ctx.systemPrompt && this.promptComponent) {
    const promptName = ctx.agent.config.behaviorSpecId || "default";
    ctx.systemPrompt = await this.promptComponent.getPrompt(promptName);
  }

  messages.push({ role: "system", content: ctx.systemPrompt });
  // ...
}
```

---

## 7. 测试覆盖

| 测试组 | 测试数 | 状态 |
|--------|--------|------|
| Component basics | 3 | ✅ |
| init | 3 | ✅ |
| add | 3 | ✅ |
| get | 2 | ✅ |
| has/delete | 5 | ✅ |
| list/size | 2 | ✅ |
| getPrompt | 5 | ✅ |
| render | 3 | ✅ |
| loadFromFile | 4 | ✅ |
| loadFromDirectory | 4 | ✅ |
| Hooks | 3 | ✅ |
| extractVariables | 3 | ✅ |
| **总计** | **39** | **✅** |

---

## 8. 实现细节

### 8.1 加载流程

```
init()
  │
  ├── loadBuiltInPrompts()
  │     └── 遍历 prompts/ 目录，加载 .md 文件
  │
  └── loadExternalPrompts()
        └── 遍历 config.promptPaths，加载外部 prompts
```

### 8.2 内置 Prompt 不可覆盖

```typescript
// 内置 prompt 设置 overridable: false
this.prompts.set(name, {
  name,
  content,
  source: "built-in",
  overridable: false,  // 不可被外部覆盖
  loadedAt: Date.now(),
});
```

### 8.3 日志复用

```typescript
import { createLogger } from "../log-trace/logger";
const logger = createLogger("prompt");
```

---

## 9. 扩展计划

| 功能 | 优先级 | 状态 |
|------|--------|------|
| 内置 Prompts | P1 | ✅ |
| 外部加载 | P1 | ✅ |
| 变量替换 | P1 | ✅ |
| Hooks | P2 | ✅ |
| CLI 命令 | P2 | - |
| 热重载内置 prompts | P3 | - |
