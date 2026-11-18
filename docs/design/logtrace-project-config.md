# Logtrace 项目级配置覆盖机制 — 设计决策

## 目标

让 `log-trace.logging.dir`（以及其他组件的配置）可以通过项目级配置文件
`${cwd}/.roy/config.jsonc` 覆盖全局配置 `~/.config/roy-bot/config.jsonc`，
不同项目可以有独立的日志目录。

## 范围

- **新增**：`ConfigComponent` 支持 `project` 类型的 source（指向 `${cwd}/.roy/config.jsonc`）。
- **新增**：`log-trace` 组件声明 `project` source，注册到 `LOG_TRACE_CONFIG_REGISTRATION.sources`。
- **修改**：log-trace 的 key registration 在 sources 列表中将 `project` 放在最前。
- **修改**：`FileSource` 支持 `priority` 选项（默认 10，向后兼容）。
- **不破坏**：现有 env > file 行为保留；现有 CLI 的 `.roy-bot/config.jsonc` 选择逻辑保留。

## 优先级策略

按 key 查找顺序（`load()` 中第一个命中的 source 胜出）：

```
project (.roy/config.jsonc) > env > file (XDG_DATA_HOME/.../config.jsonc) > memory/default
```

具体数值：
- `MemorySource`: 0
- `FileSource`（全局）: 10
- `EnvSource`: 20
- `FileSource`（项目级，`type=project`）: 25

数值排序仍按 `addSource` 的 sort，但 `load()` 按 key 注册时声明的 sources 数组顺序查询，
所以 `sources: ["project", "env", "file"]` 等价于 project > env > file > default。

## API 改动

### 新增 `SourceRegistration.cwd?: string`

```ts
export interface SourceRegistration {
  type: ConfigSourceType;
  relativePath?: string;
  envPrefix?: string;
  cwd?: string;  // NEW: 用于 project source
  priority?: number;
  optional?: boolean;
  watch?: boolean;
}
```

### 新增 `ConfigComponent.registerProjectSource()`

```ts
registerProjectSource(options?: { cwd?: string; priority?: number }): void
```

- `cwd` 默认 `process.cwd()`
- 注册 `type: "project"` 的 source，`optional: true`（文件不存在不报错）
- 在 `sourceKeys` 中用 `project:${absolutePath}` 做唯一标识，避免重复注册

### 新增 `ConfigSourceType = "project"`

扩展 `ConfigSourceType` 联合类型为 `"memory" | "file" | "env" | "remote" | "project"`。

注：`ConfigSourceType` 在 `registerSource` 和 `removeSource` 里用作 name 标识，
但 `removeSource` 是按 `name` 查找的，而 project source 的实例 `name` 仍是 `"file"`
（因为底层就是 FileSource）。这一点后续可以改进，但目前不影响功能。

### 修改 `FileSourceOptions`

```ts
export interface FileSourceOptions {
  filePath: string;
  debounceMs?: number;
  resolver?: ProtocolResolver;
  optional?: boolean;
  watch?: boolean;
  priority?: number;  // NEW
}
```

构造函数默认值 `priority = 10`，保持向后兼容。

### 修改 `LOG_TRACE_CONFIG_REGISTRATION`

```ts
sources: [
  { type: "project", priority: 25, optional: true, watch: false },  // NEW
  { type: "env", envPrefix: "LOG_TRACE", priority: 20, watch: false },
],

keys: [
  { key: "log-trace.logging.enabled",  sources: ["project", "env", "file"] },
  { key: "log-trace.logging.level",    sources: ["project", "env", "file"] },
  { key: "log-trace.logging.quiet",    sources: ["project", "env", "file"] },
  { key: "log-trace.logging.dir",      sources: ["project", "env", "file"] },
  { key: "log-trace.logging.file",     sources: ["project", "env", "file"] },
  { key: "log-trace.logging.maxOutput",sources: ["project", "env", "file"] },
  { key: "log-trace.tracing.enabled",  sources: ["project", "env", "file"] },
  { key: "log-trace.tracing.dbPath",   sources: ["project", "env", "file"] },
],
```

## 优雅降级

- `${cwd}/.roy/config.jsonc` 不存在 → `FileSource.optional: true` 静默初始化为空对象
- 解析错误 → catch 块捕获并 fallback 到空对象
- cwd 路径包含 `..`？ → 不做额外校验。FileSource 直接按字面路径读，恶意路径
  会让用户自己的代码读自己的文件，不会产生新攻击面。

## 路径解析

- `${cwd}` 默认 `process.cwd()`
- 测试可通过 `registerProjectSource({ cwd: tempDir })` 注入隔离目录

## 不破坏的现有行为

- `configComponent.set()` 仍走内存层（最高优先级）
- env > file > default 的现有优先级保留
- CLI 的 `.roy-bot/config.jsonc` 手选逻辑保留（独立于本机制）

## 测试计划

1. **`project-config-source.test.ts`**（核心）
   - `project` source type 能注册到 `ConfigComponent`
   - `${cwd}/.roy/config.jsonc` 内容被正确加载
   - 文件不存在时不报错（graceful skip）
   - project > env > file 优先级顺序生效
   - 不同 cwd 互不污染
2. **`log-trace-project-config.test.ts`**（集成）
   - log-trace 组件能读到 `${cwd}/.roy/config.jsonc` 中的 `log-trace.logging.dir`
   - 日志文件实际写入项目级目录（集成 logger）
3. **回归**：
   - 现有 `file-source.test.ts` 通过
   - 现有 `log-trace-component.test.ts` 通过
   - 现有 `decentralized-config.test.ts` 通过