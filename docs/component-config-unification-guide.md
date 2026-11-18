# Component 配置统一化改造指南

> **创建时间**: 2026-04-08
> **适用版本**: roy-bot 1.x
> **目标**: 将所有 Component 的配置机制统一到 ConfigComponent.registerComponent()

## 1. 背景与目标

### 1.1 问题

各 Component 使用自定义的 `registerConfig()` 方法管理配置，导致：
- 默认值未注册到 ConfigComponent
- show-config 只能硬编码 fallback 值
- 配置加载逻辑冗余且不统一

### 1.2 目标

```
Component.init(options)
    ↓
configComponent.registerComponent(COMPONENT_CONFIG_REGISTRATION)
    ↓
ConfigComponent.memorySource 存储所有配置值（包括默认值）
    ↓
show-config 直接从 ConfigComponent 获取展示
    ↓
渲染器无需硬编码默认值
```

### 1.3 验收标准

- [x] `configComponent.get("component.key")` 返回默认值（无用户配置时）
- [x] show-config 无需硬编码 fallback
- [x] 现有配置来源（file/env/object）正常工作
- [x] 单元测试通过 ✅ (1337 tests pass)

**2026-04-08 修复说明**：
- 修复了 `mcp-component.test.ts` 和 `mcp-component.integration.test.ts` 中的 `vi.mock("../component")` mock 导致的问题
- 该 mock 影响了其他测试文件（如 skill-component.test.ts）的 BaseComponent 继承链
- 解决方案：移除 BaseComponent 的 mock，让测试使用真实的 BaseComponent

---

## 4. 改造进度

### 4.1 已完成改造

| Component | 状态 | 日期 | 说明 |
|-----------|------|------|------|
| session | ✅ 完成 | 2026-04-08 | 已有配置注册机制 |
| task | ✅ 完成 | 2026-04-08 | 新增 `task-config-registration.ts` |
| memory | ✅ 完成 | 2026-04-08 | 新增 `memory-config-registration.ts` |
| skill | ✅ 完成 | 2026-04-08 | 新增 `skill-config-registration.ts` |
| event-source | ✅ 完成 | 2026-04-08 | 新增 `event-source-config-registration.ts` |
| commands | ✅ 完成 | 2026-04-08 | 新增 `commands-config-registration.ts` |
| tool | ✅ 完成 | 2026-04-08 | 新增 `tool-config-registration.ts` |
| agent | ✅ 完成 | 2026-04-08 | 新增 `agent-config-registration.ts` |
| prompt | ✅ 完成 | 2026-04-08 | 新增 `prompt-config-registration.ts` |
| log-trace | ✅ 完成 | 2026-04-08 | 新增 `log-trace-config-registration.ts` |
| mcp | ✅ 完成 | 2026-04-08 | 新增 `mcp-config-registration.ts` |

**总体进度**: 11/11 (100%) ✅

---

## 2. 配置文件结构

### 2.1 目录结构

每个 Component 目录下应有：
```
src/env/{component}/
├── {component}-component.ts          # 组件主文件
├── {component}-component.test.ts     # 组件测试
├── {component}-config-registration.ts # ⭐ 新增：配置注册常量
└── {component}-config-registration.test.ts # ⭐ 新增：配置注册测试
```

### 2.2 配置注册常量模板

```typescript
/**
 * @fileoverview {Component} Component 配置注册
 * 
 * 使用 ConfigComponent.registerComponent() 机制统一管理配置
 */

import type { ComponentRegistration } from "../../config/config-component";

/**
 * {Component} Component 配置注册常量
 * 
 * 定义了所有 {Component} 相关的配置项和来源
 */
export const {COMPONENT}_CONFIG_REGISTRATION: ComponentRegistration = {
  name: "{component}",
  
  sources: [
    // ⭐ 注意：env source 在前，file source 在后，确保优先级正确
    { type: "env", envPrefix: "{PREFIX}", priority: 20, watch: false },
  ],
  
  // ⭐ 注意：keys 的 sources 顺序决定加载优先级
  // ["env", "file"] 表示：先查 env，再查 file
  keys: [
    { key: "{component}.key1", sources: ["env", "file"] },
    { key: "{component}.key2", sources: ["env", "file"] },
    // ... 其他配置键
  ],
};

/**
 * {Component} Component 默认配置值
 * 
 * 注意：键名使用完整格式（含 "{component}." 前缀）
 */
export const {COMPONENT}_DEFAULTS: Record<string, unknown> = {
  "{component}.key1": "defaultValue1",
  "{component}.key2": 100,
  // ... 其他默认值
};
```

### 2.3 动态默认值处理

如果默认值需要动态计算（如根据 HOME 目录），则在 `registerConfig()` 方法中设置：

```typescript
// 在 registerConfig 中
if (configComponent.get("{component}.dbPath") === undefined) {
  await configComponent.set("{component}.dbPath", this.getDefaultDbPath());
}
```

---

## 3. Component 改造步骤

### Step 1: 创建配置注册常量文件

**文件**: `src/env/{component}/{component}-config-registration.ts`

```typescript
import type { ComponentRegistration } from "../../config/config-component";

export const {COMPONENT}_CONFIG_REGISTRATION: ComponentRegistration = {
  name: "{component}",
  sources: [
    { type: "env", envPrefix: "{PREFIX}", priority: 20, watch: false },
  ],
  keys: [
    { key: "{component}.key1", sources: ["env", "file"] },
    // ...
  ],
};

export const {COMPONENT}_DEFAULTS: Record<string, unknown> = {
  "{component}.key1": "default",
  // ...
};
```

### Step 2: 创建配置注册测试文件

**文件**: `src/env/{component}/{component}-config-registration.test.ts`

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { Component } from "./{component}-component";
import { ConfigComponent } from "../../config/config-component";
import { {COMPONENT}_CONFIG_REGISTRATION, {COMPONENT}_DEFAULTS } from "./{component}-config-registration";

describe("{Component} Config Registration", () => {
  let configComponent: ConfigComponent;
  let component: Component;

  beforeEach(() => {
    configComponent = new ConfigComponent();
    component = new Component();
  });

  describe("默认值注册", () => {
    it("应该注册 key1 的默认值为 xxx", async () => {
      await component.init({ options: { configComponent } });
      expect(configComponent.get("{component}.key1")).toBe("xxx");
    });
    // ... 更多测试
  });

  describe("配置优先级", () => {
    it("应该允许 config 对象覆盖默认值", async () => {
      await component.init({
        options: { configComponent, config: { key1: "custom" } }
      });
      expect(configComponent.get("{component}.key1")).toBe("custom");
    });
  });

  describe("常量导出", () => {
    it("应该导出 CONFIG_REGISTRATION", () => {
      expect({COMPONENT}_CONFIG_REGISTRATION.name).toBe("{component}");
    });
    it("应该导出 DEFAULTS", () => {
      expect({COMPONENT}_DEFAULTS["{component}.key1"]).toBe("default");
    });
  });
});
```

### Step 3: 修改 Component 主文件

**修改点**:

1. 添加 import
```typescript
import { {COMPONENT}_CONFIG_REGISTRATION, {COMPONENT}_DEFAULTS } from "./{component}-config-registration";
```

2. 添加动态默认值方法（如果有）
```typescript
private getDefaultXxx(): string {
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  return join(home, ".local", "share", "roy-bot", "xxx.db");
}
```

3. 重构 registerConfig 方法
```typescript
private async registerConfig(options: {Component}ComponentOptions): Promise<void> {
  const configComponent = options.configComponent;
  if (!configComponent) return;

  const { configPath, envPrefix, config } = options;
  const prefix = envPrefix ?? "{PREFIX}";

  // 1. 注册配置结构
  configComponent.registerComponent({COMPONENT}_CONFIG_REGISTRATION);

  // 2. 注册 FileSource（如果有 configPath）
  if (configPath) {
    configComponent.registerSource({
      type: "file",
      relativePath: configPath,
      optional: true,
      watch: false
    });
  }

  // 3. 注册 EnvSource
  configComponent.registerSource({
    type: "env",
    envPrefix: prefix,
    priority: 20,
    watch: false
  });

  // 4. 从 sources 加载配置
  await configComponent.load("{component}");
  
  // 5. 后备方案：直接读取环境变量
  for (const envKey of Object.keys(process.env)) {
    const configKey = envKeyToConfigKey(envKey, prefix, "{component}");
    if (!configKey) continue;
    const value = process.env[envKey];
    if (value !== undefined) {
      await configComponent.set(configKey, value);
    }
  }

  // 6. 设置默认值（只有当配置不存在时）
  for (const [key, value] of Object.entries({COMPONENT}_DEFAULTS)) {
    if (configComponent.get(key) === undefined) {
      await configComponent.set(key, value);
    }
  }
  
  // 7. 动态默认值（如果有）
  // ...

  // 8. config 对象（最高优先级）
  if (config) {
    const flatConfig = this.flattenConfig(config);
    for (const [key, value] of Object.entries(flatConfig)) {
      await configComponent.set(key, value);
    }
  }

  // 9. 注册配置热更新监听
  this.registerConfigWatcher(configComponent);

  // 10. 解析最终配置
  this.config = this.buildConfig(configComponent);
}

private buildConfig(configComponent: ConfigComponent): {Component}Config {
  return {
    // 直接从 configComponent 获取，无 fallback
    key1: configComponent.get("{component}.key1") as Type1,
    // ...
  };
}
```

### Step 4: 简化 show-config 渲染器

**文件**: `packages/cli/src/commands/show-config/component-renderers/{component}.ts`

```typescript
export const render{Component}: ComponentRenderer = {
  name: "{component}",
  
  async render(env, configComponent) {
    // ⭐ 无需硬编码默认值，直接从 ConfigComponent 获取
    return {
      key1: configComponent.get("{component}.key1"),
      key2: configComponent.get("{component}.key2"),
      // ...
    };
  },
};
```

### Step 5: 运行测试

```bash
# 运行配置注册测试
bun test packages/core/src/env/{component}/{component}-config-registration.test.ts

# 运行组件完整测试
bun test packages/core/src/env/{component}/
```

### Step 6: 构建验证

```bash
npm run build
```

---

## 4. 优先级说明

### 4.1 配置加载顺序

| 优先级 | 来源 | 说明 |
|--------|------|------|
| 1 (最低) | defaults | 静态默认值 |
| 2 | file | 配置文件 |
| 3 | env | 环境变量 |
| 4 (最高) | config 对象 | 直接传入的配置 |

### 4.2 Sources 和 Keys 的关系

```typescript
keys: [
  // sources: ["env", "file"] 表示：
  // 1. 先从 env 加载
  // 2. 如果 env 没有值，从 file 加载
  { key: "session.maxMessages", sources: ["env", "file"] },
]
```

在 `load()` 方法中：
```typescript
for (const sourceType of sourceTypes) {  // ["env", "file"]
  const value = source.read(key);
  if (value !== undefined) {
    this.memorySource.write(key, value);
    break;  // 找到第一个值就停止
  }
}
```

---

## 5. 常见问题

### Q1: SESSION_CONFIG_REGISTRATION 中 keys 的 sources 顺序？

```typescript
sources: ["env", "file"]  // env 优先
```

因为 `load()` 按数组顺序遍历，先查 env，后查 file。

### Q2: 默认值为什么单独导出 SESSION_DEFAULTS？

因为：
1. `registerComponent()` 的 defaults 在注册时就写入 memory
2. 我们需要先 load() 再设置默认值
3. 所以将 defaults 单独导出，在 registerConfig 中手动设置

### Q3: 为什么 keys 的 sources 不包含 memory？

memory source 专用于运行时动态设置的值（如 config 对象），不需要在 keys 中声明。

### Q4: FileSource 加载不到配置？

检查：
1. FileSource 是否正确注册：`configComponent.registerSource({ type: "file", ... })`
2. 配置文件路径是否正确
3. 配置格式是否为嵌套对象：`{ "component": { "key": value } }`

---

## 6. Component 改造顺序建议

建议按以下顺序逐步改造各 Component：

| 优先级 | Component | 改造难度 | 原因 |
|--------|-----------|----------|------|
| 1 | Tool | ⭐⭐ | 已有 `registerConfig()`，改造工作量小 |
| 2 | Mcp | ⭐⭐ | 已有 `registerConfig()`，改造工作量小 |
| 3 | Commands | ⭐⭐ | 已有 `registerConfig()`，改造工作量小 |
| 4 | Task | ⭐⭐⭐ | 使用 ZodSchema，需额外处理类型转换 |
| 5 | Memory | ⭐⭐⭐ | 使用 DEFAULT_ 常量，需重构配置合并逻辑 |
| 6 | Skill | ⭐⭐⭐ | 使用 DEFAULT_ 常量，需重构配置合并逻辑 |
| 7 | EventSource | ⭐⭐⭐⭐ | 未使用配置机制，需从零实现 |

**说明**：
- 已有 `registerConfig()` 的 Component 改造最简单，只需重构现有方法
- 使用 `DEFAULT_` 常量的 Component 需要额外处理配置合并逻辑
- EventSource 需要从零实现配置机制

---

## 7. Component 改造进度

| Component | 状态 | 完成时间 |
|-----------|------|----------|
| Session | ✅ 完成 | 2026-04-08 |
| Tool | ⏳ 待改造 | - |
| Mcp | ⏳ 待改造 | - |
| Commands | ⏳ 待改造 | - |
| Task | ⏳ 待改造 | - |
| Memory | ⏳ 待改造 | - |
| Skill | ⏳ 待改造 | - |
| EventSource | ⏳ 待改造 | - |

---

## 7. 参考文件

- SessionComponent 改造示例:
  - `packages/core/src/env/session/session-config-registration.ts`
  - `packages/core/src/env/session/session-config-registration.test.ts`
  - `packages/core/src/env/session/session-component.ts` (registerConfig 方法)
  - `packages/cli/src/commands/show-config/component-renderers/session.ts`

- ConfigComponent:
  - `packages/core/src/config/config-component.ts`

- EnvSource/EnvKey:
  - `packages/core/src/config/env-source.ts`
  - `packages/core/src/config/env-key.ts`
