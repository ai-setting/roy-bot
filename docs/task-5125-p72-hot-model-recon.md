# Task #5125 — P7.2 /model 热切换摸底报告（方案先行）

> 用户要求：「可以持久化也写到内存层，每轮运行读内存配置层来直接生效。好好看下代码复用逻辑，不要重复造轮子或者违背之前的组件实现理念，尤其 config 组件的实现理念」。

## 1. config 组件的分层理念（摸底结论）

### 1.1 ConfigComponent = 内存层 + watcher + 持久化队列 的三合一

`packages/core/src/config/config-component.ts`：

| 机制 | 位置 | 说明 |
|---|---|---|
| **内存层（MemorySource）** | `:289` `private memorySource = new MemorySource()` | `get()` **先读内存层**（`:405-409`），命中即返回 |
| **set() = 内存立即生效** | `:442-469` | `memorySource.write(key, value)`（写入即生效）→ `notifyWatchers`（`:655-667` 触发精确/通配/全局 watcher）→ `persistQueue.add`（防抖 300ms 异步持久化） |
| **watch(pattern, cb)** | `:535` | 组件级 watcher 注册，事件含 `oldValue/newValue` |
| **持久化（persistToFile）** | `:672` | ⚠️ **stub**（`TODO: 实现完整文件持久化`）→ config.jsonc 的持久化**不在 ConfigComponent 层**，而是各命令自管（`fallback-model-command.ts` 的 jsonc modify 写回、P7.1 `setDefaultModel`） |

**结论 1**：ConfigComponent **本身就是内存层**。「写内存层」= `configComponent.set("llm.defaultModel", ...)`，一行即满足「立即生效 + 触发 watcher」，无需新增任何 override 层。persistToFile 是 stub 正说明「持久化走文件层、内存层走组件」的双层分工是既有理念。

### 1.2 LLMComponent 的热更新监听**已经存在**（不需要新造）

`packages/core/src/env/llm/llm.ts`：

| 链路 | 位置 | 说明 |
|---|---|---|
| 初始化时把 file/env 配置灌进内存层 | `:334-456` `registerConfig` | `await configComponent.set(key, value)` 逐 key 写入 |
| **watcher 注册** | `:545-560` `registerConfigWatcher` | `configComponent.watch("llm.*", ...)` → `onConfigChange` |
| **onConfigChange 已处理 defaultModel** | `:569-586` | `event.key === "llm.defaultModel"` → 记日志「LLM default model changed to: ...」——**注释明说**「getProvider/getLLMConfig 会实时从 configComponent 读取，所以不需要显式重新加载」 |
| **每轮请求实时读内存层** | `:619-632` `resolveRequest` | `defaultModel = this.getLLMConfig("llm.defaultModel", "gpt-4o")`；`getLLMConfig`（`:608-618`）**每次调用都实时 `configComponent.get(key)`** |
| 请求模型解析 | `:632-644` | `rawModel = request.model || defaultModel` → 有 `/` 拆 providerId/modelId，无 `/` 用 defaultProvider |

**结论 2**：`llm.defaultModel` 的消费链路天然「每轮实时读内存配置层」——这正是用户说的「之前做 config 组件时应该就有考虑的」。热切换的内存层动作 = `configComponent.set("llm.defaultModel"|"llm.defaultProvider", ...)`，**零 core 改动**。

## 2. interactive 会话的每轮模型取值链（CLI 层）

`packages/cli/src/commands/interactive.ts`：

| 链路 | 位置 | 说明 |
|---|---|---|
| 启动 | `:939` `loadHandleQuery(argv, ...)` → `:400` `new EnvironmentService()` → `create()` | configComponent 私有字段，但 `:566` `env.registerComponent(configComponent)` ⇒ **`env.getComponent("config")` 可取** |
| 每轮 mergedContext | `:483-556`（one-shot）/ `:780-800`（streaming） | 都有 `...buildModelAgentContext(options)` |
| flag → context | `packages/cli/src/commands/model-flags.ts:219-238` `buildModelAgentContext` | `options.model` → `{model}`；**未给 flag → 不产生 key** |
| agent 层合并 | `packages/core/src/env/agent/agent-component.ts:1532` | `model: (context?.model) ?? agent.config.model` —— **context.model 每轮注入即赢** |
| 无 context.model 时 | → agent config（`:1187` `config.model ?? this.config.defaultAgent.model`）→ undefined → `llm.defaultModel`（内存层） | |

**结论 3**：会话内每轮的模型 = `context.model`（若本轮 context 有）→ 否则内存层 `llm.defaultModel`。因此热切换需要补的**只有一处**：per-turn context 的来源里加一个「运行时 override」（用户弹窗选择晚于启动 flag，应赢过启动 `--model`）。

## 3. P7.1 既有资产（直接复用，不重写）

`packages/cli/src/tui-solid/app-config-io.ts`：

- `readModelsFromConfig(homeDir)`（`:187-218`）：罗列 config.jsonc 模型（弹窗数据源）
- `setDefaultModel(homeDir, provider, model)`（`:236-`）：jsonc modify 最小 diff 写回 config.jsonc + 回读校验（**持久化已就绪**）

`packages/cli/src/tui-solid/RunScreen.tsx`：

- `:472-487` `selectDefaultModel`：`setDefaultModel(os.homedir(), ...)` → 通知行 `✓ default model → ${model} (${provider}) in ~/.roy-bot/config.jsonc`（**目前只持久化，无内存层动作**——P7.2 要补的就是这一步）
- Dialog 键盘/渲染：`:344-` + `Dialog.tsx`（root-level 兄弟节点，a262fb4c 修复过）

## 4. opencode 参考（/tmp/opencode-src）

- `packages/tui/src/component/dialog-model.tsx`：弹窗选模型 → `onSelect(providerID, modelID)`
- `packages/tui/src/app.tsx:677`：`local.model.set({ providerID, modelID }, { recent: true })` → **立即生效于当前会话**
- `packages/tui/src/context/local.tsx:440-452` `model.set`：本地 store 更新 + `repository.addRecent` 持久化（内存层 + 持久化**双写**，同我们的方案）
- `packages/core/src/session/session.ts:107-118` `switchModel`：发布 `SessionEvent.ModelSelected`，下一轮 prompt 读 session.model —— opencode 的「热切换 = 会话内状态立即变更、下一轮生效」，无重启。

## 5. 实施方案（最小改动，复用为主）

### 5.1 数据流（选择后）

```
/model 弹窗 Enter（RunScreen.selectDefaultModel, RunScreen.tsx:472）
  ├─ ① 持久化：setDefaultModel() 写 config.jsonc（P7.1 既有，不动）
  ├─ ② 内存层：props.onModelHotSwap(provider, model)  → interactive.ts 闭包：
  │      runtimeModelOverride = `${provider}/${model}`            （per-turn context）
  │      env.getComponent("config").set("llm.defaultModel", model)   （内存层立即生效）
  │      env.getComponent("config").set("llm.defaultProvider", provider)
  ├─ ③ 通知行：「✓ default model → xxx（当前会话已生效）」
  └─ 下一轮 executeQuery → mergedContext.model = runtimeModelOverride（赢过启动 flag）
                              → agent-component:1532 → llm.resolveRequest 用新模型
```

### 5.2 per-turn override（唯一新增的 CLI 层逻辑）

- `interactive.ts`：`createStreamHandleQuery` / `handleQuery` 的 mergedContext 改为
  `...buildModelAgentContext({ ...options, model: runtimeModelOverride ?? options.model })`
  （闭包每轮读最新 override；notification 轮同样生效）。
- 优先级：**运行时 override > 启动 --model flag**（用户后续选择赢过启动参数，对齐 opencode）。
- `commands/run.ts` / `chat.ts` **不碰**（不破坏 run headless）。

### 5.3 core 层改动：**零**

内存层、watcher、每轮实时读取全部复用既有实现。

## 6. 测试与取证方案

1. **TDD 单测**（HOME=/tmp 隔离）：
   - `resolveTurnModelContext`（纯函数）：override 优先 / flag 兜底 / 双无 → {}
   - RunScreen 帧级测试：/model 选择 → `onModelHotSwap` spy 收到 `(provider, model)` + 通知行文案
   - wiring 测试：EnvironmentService 建立后 `env.getComponent("config").set("llm.defaultModel")` → `get()` 立即读到（内存层语义）
2. **真终端证据**（Xvfb+xterm，复用 capture-xterm-p71.py）：/model → 选择 → 通知行截图；**下一条消息实际用新模型**：isolated HOME + config.jsonc providers 指向本地 mock OpenAI server（记录请求里的 `model` 字段）→ 选择后发消息 → mock 日志显示新 model。
3. **回归**：tui-solid 串行全量 vs main 基线对账；config 相关测试；commands/run.ts diff 为零。

## 7. 风险

- `env.getComponent("config")` 类型是 unknown（registerComponent 泛型）→ interactive.ts 侧局部类型收窄，不 import core 内部路径。
- `configComponent.set` 是 async（persistQueue stub 不写文件，无副作用）→ fire-and-forget + catch。
- 启动 flag 用户预期：`--model` 之后 /model 选择覆盖，属「后续操作赢」直觉，注释写明。
