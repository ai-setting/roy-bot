# Component 配置重构指导文档

## 概述

本文档以 LLM Component 为例，指导如何重构其他 Component 实现统一的配置机制。

### 核心特性

1. **配置源优先级**: Object > Env > File（从高到低）
2. **环境变量转换**: 驼峰命名 ↔ 下划线分隔大写
3. **配置热更新**: 支持运行时配置变更监听
4. **可选配置路径**: 配置文件路径基于 XDG_DATA_HOME

---

## 一、配置源优先级机制

### 1.1 优先级定义

```
优先级从低到高:
1. File - 配置文件（通过 configPath 指定）
2. Env - 环境变量（通过 envPrefix 配置前缀）
3. Object - 直接传入的配置对象（最高优先级）
```

### 1.2 为什么这样设计？

| 优先级 | 适用场景 | 说明 |
|--------|----------|------|
| File (最低) | 基础配置默认值 | 通过配置文件提供默认配置 |
| Env | 环境特定配置 | 通过环境变量覆盖，适合容器化部署 |
| Object (最高) | 运行时动态配置 | 代码中直接传入，优先级最高 |

---

## 二、环境变量转换规则

### 2.1 转换函数

使用 `env-key.ts` 中的工具函数：

```typescript
import { toEnvKey, envKeyToConfigKey } from "../../config/env-key";
```

### 2.2 toEnvKey - 配置键名 → 环境变量名

```typescript
toEnvKey("llm.defaultModel", "LLM")
// → "LLM_LLM_DEFAULT_MODEL"

toEnvKey("llm.providers.openai.apiKey", "LLM")
// → "LLM_LLM_PROVIDERS_OPENAI_API_KEY"
```

**转换规则**:
1. 点号替换为下划线: `llm.defaultModel` → `llm_default_model`
2. 驼峰转下划线大写: `defaultModel` → `DEFAULT_MODEL`
3. 拼接前缀: `LLM_` + `LLM_DEFAULT_MODEL` → `LLM_LLM_DEFAULT_MODEL`

### 2.3 envKeyToConfigKey - 环境变量名 → 配置键名

```typescript
envKeyToConfigKey("LLM_LLM_DEFAULT_MODEL", "LLM", "llm")
// → "llm.default.model"

envKeyToConfigKey("LLM_DEFAULT_MODEL", "LLM", "llm")
// → "llm.default.model"
```

**支持两种格式**:
- `PREFIX_KEY`: `LLM_DEFAULT_MODEL` → `llm.default.model`
- `PREFIX_COMPONENT_KEY`: `LLM_LLM_DEFAULT_MODEL` → `llm.default.model`

---

## 三、重构步骤

### 3.1 Step 1: 定义 ComponentOptions 接口

```typescript
/**
 * XxxComponent 配置选项
 * 
 * 配置加载顺序（优先级从低到高）：
 * 1. File - 配置文件（通过 configPath 指定）
 * 2. Env - 环境变量（通过 envPrefix 配置前缀）
 * 3. Object - 直接传入的配置对象（最高优先级）
 */
export interface XxxComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: ConfigComponent;
  
  /** 配置文件相对路径（可选，基于 XDG_DATA_HOME） */
  configPath?: string;
  
  /** 环境变量前缀（可选，默认 "XXX"） */
  envPrefix?: string;
  
  /** 直接传入的配置对象（可选，优先级最高） */
  config?: Partial<XxxConfig>;
}
```

### 3.2 Step 2: 创建 registerConfig 方法

```typescript
private async registerConfig(options: XxxComponentOptions): Promise<void> {
  const configComponent = options.configComponent;
  if (!configComponent) return;

  const { configPath, envPrefix, config } = options;
  const prefix = envPrefix !== undefined ? envPrefix : "XXX"; // 默认前缀

  // 定义所有需要加载的配置 keys
  const xxxKeys = [
    "xxx.key1",
    "xxx.key2",
    "xxx.nested.key",
    // ...
  ];

  // 1. 注册并加载 FileSource（如果提供了 configPath）
  let fileSource: any = null;
  if (configPath) {
    configComponent.registerSource({
      type: "file",
      relativePath: configPath,
      optional: true,  // 文件不存在时不报错
      watch: false     // 静态配置，不需要监听
    });
    
    (configComponent as any).ensureSourcesCreated?.();
    
    const sources = configComponent.getSources?.() || [];
    fileSource = sources.find((s: any) => s.name === "file");
    
    if (fileSource) {
      for (const key of xxxKeys) {
        const value = fileSource.read?.(key);
        if (value !== undefined) {
          await configComponent.set(key, value);
        }
      }
    }
  }

  // 2. 注册并加载 EnvSource
  configComponent.registerSource({
    type: "env",
    envPrefix: prefix,
    priority: 20,  // 高于 FileSource
    watch: false
  });
  
  (configComponent as any).ensureSourcesCreated?.();
  
  const sourcesAfterEnv = configComponent.getSources?.() || [];
  const envSource = sourcesAfterEnv.find((s: any) => s.name === "env");
  
  if (envSource) {
    for (const key of xxxKeys) {
      const value = envSource.read?.(key);
      if (value !== undefined) {
        await configComponent.set(key, value);
      }
    }
  }
  
  // 3. 后备方案：直接读取环境变量
  for (const key of xxxKeys) {
    const envKey = toEnvKey(key, prefix);
    const value = process.env[envKey];
    if (value !== undefined) {
      await configComponent.set(key, value);
    }
  }
  
  // 4. 自动发现其他相关环境变量
  const loadedKeys = new Set(xxxKeys);
  for (const envKey of Object.keys(process.env)) {
    const configKey = envKeyToConfigKey(envKey, prefix, "xxx");
    if (!configKey) continue;
    if (loadedKeys.has(configKey)) continue;
    loadedKeys.add(configKey);
    const value = process.env[envKey];
    if (value !== undefined) {
      await configComponent.set(configKey, value);
    }
  }

  // 5. 直接配置对象（最高优先级）
  if (config) {
    const flatConfig = this.flattenConfig(config);
    for (const [key, value] of Object.entries(flatConfig)) {
      await configComponent.set(key, value);
    }
  }

  // 6. 注册配置热更新监听
  this.registerConfigWatcher(configComponent);
}
```

### 3.3 Step 3: 实现辅助方法

```typescript
/**
 * 将配置对象展平为点号路径
 * 
 * @example
 * flattenConfig({ nested: { key: "value" } })
 * -> { "xxx.nested.key": "value" }
 */
private flattenConfig(
  obj: Record<string, unknown>,
  prefix = "xxx"
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = `${prefix}.${key}`;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(
        result,
        this.flattenConfig(value as Record<string, unknown>, fullKey)
      );
    } else {
      result[fullKey] = value;
    }
  }
  return result;
}

/**
 * 注册配置热更新监听
 */
private registerConfigWatcher(configComponent: ConfigComponent): void {
  if (typeof configComponent.watch !== "function") {
    return;
  }
  
  this.configWatcher = configComponent.watch("xxx.*", (event) => {
    this.onConfigChange(event);
  });
}

/**
 * 处理配置变更
 */
protected onConfigChange(event: { key: string; oldValue?: unknown; newValue?: unknown }): void {
  // 根据变更的 key 类型进行处理
  logger.info(`Xxx config changed: ${event.key}`);
}
```

### 3.4 Step 4: 实现 getter 方法

```typescript
/**
 * 从配置源获取配置值
 * 优先从 ConfigComponent 获取（支持热更新），否则返回默认值
 */
private getXxxConfig<T>(key: string, defaultValue?: T): T {
  if (this.configComponent) {
    const value = this.configComponent.get(key);
    if (value !== undefined) {
      return value as T;
    }
  }
  return defaultValue!;
}
```

### 3.5 Step 5: 更新 init 方法

```typescript
async init(config: ComponentConfig): Promise<void> {
  await super.init(config);

  const options = config.options as XxxComponentOptions | undefined;
  if (!options?.configComponent) {
    throw new Error("ConfigComponent is required for XxxComponent initialization");
  }

  this.configComponent = options.configComponent;
  await this.registerConfig(options);

  this.setStatus("running");
}
```

### 3.6 Step 6: 清理 onStop

```typescript
async onStop(): Promise<void> {
  this.configWatcher?.();
  this.configWatcher = undefined;
  this.setStatus("stopped");
}
```

---

## 四、测试要点

### 4.1 基本功能测试

```typescript
describe("XxxComponent Config Loading", () => {
  let component: XxxComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let tempDir: string;

  beforeEach(() => {
    component = new XxxComponent();
    configComponent = new ConfigComponent();
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "xxx-config-test-"));
    configComponent.setXdgDataHome(tempDir);
    
    mockEnv = {
      getComponent: (name) => name === "config" ? configComponent : undefined,
      hasComponent: (name) => name === "config",
      logger: () => {},
      trace: () => {},
    } as unknown as Environment;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try { fsSync.rmSync(tempDir, { recursive: true }); } catch {}
  });

  // 测试各种 options 组合...
});
```

### 4.2 优先级测试

```typescript
describe("config priority: Object > Env > File", () => {
  test("should Object config override Env config", async () => {
    process.env.XXX_XXX_KEY = "env-value";
    fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
      xxx: { key: "file-value" }
    }), "utf-8");

    await component.init({
      // ...
      options: { 
        configComponent, 
        configPath: "config.jsonc",
        envPrefix: "XXX",
        config: { key: "object-value" }  // 最高优先级
      }
    });
    
    expect(configComponent.get("xxx.key")).toBe("object-value");
  });
});
```

---

## 五、env-key.ts 工具函数参考

### 5.1 函数列表

| 函数 | 参数 | 返回值 | 用途 |
|------|------|--------|------|
| `toEnvKey(key, prefix)` | 配置键名, 前缀 | 环境变量名 | 用于生成环境变量名 |
| `fromEnvKey(envKey, prefix)` | 环境变量名, 前缀 | 内部键名 | EnvSource.list() 使用 |
| `envKeyToConfigKey(envKey, prefix, componentName)` | 环境变量名, 前缀, 组件名 | 配置键名 | 自动发现环境变量 |

### 5.2 使用示例

```typescript
import { toEnvKey, envKeyToConfigKey } from "../../config/env-key";

// 生成环境变量名
const envVar = toEnvKey("xxx.settingName", "PREFIX");
// → "PREFIX_XXX_SETTING_NAME"

// 自动发现环境变量
const configKey = envKeyToConfigKey("PREFIX_XXX_SETTING_NAME", "PREFIX", "xxx");
// → "xxx.setting.name"
```

---

## 六、重构检查清单

重构前确认以下内容：

- [ ] 确定组件名（如 `llm`, `agent`, `logTrace`）
- [ ] 确定默认环境变量前缀（如 `LLM`, `AGENT`, `LOG`）
- [ ] 列出所有需要加载的配置 keys
- [ ] 确定配置文件路径（相对路径，基于 XDG_DATA_HOME）
- [ ] 编写测试用例覆盖优先级逻辑
- [ ] 验证配置热更新功能

---

## 七、示例组件参考

| 组件 | 配置文件 |
|------|----------|
| LLMComponent | `packages/core/src/env/llm/llm.ts` |
| LLMComponent 测试 | `packages/core/src/env/llm/llm-config.test.ts` |
| 工具函数 | `packages/core/src/config/env-key.ts` |

---

## 八、常见问题

### Q1: 为什么需要后备方案直接读取环境变量？

因为 EnvSource 需要通过 `ensureSourcesCreated()` 延迟创建，且需要注册到 ConfigComponent。在某些情况下，可能在 EnvSource 创建之前就需要读取环境变量。

### Q2: 如何处理嵌套配置？

使用 `flattenConfig()` 方法将嵌套对象展平为点号路径。

### Q3: 如何确保测试的幂等性？

在 `beforeEach` 中创建临时目录，在 `afterEach` 中清理。

### Q4: 环境变量名格式不匹配怎么办？

检查是否正确使用了 `toEnvKey` 函数进行转换，确保驼峰命名被正确转换为下划线分隔的大写形式。
