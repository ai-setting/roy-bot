# Event Source 用户手册

> roy-bot 内置事件源（event source）配置与使用指南。

## 1. 概述

事件源（event source）是 roy-bot 用来从外部系统（飞书 / 定时器 / Bounty IM / WebSocket 等）接收事件并触发 Agent 的组件。

每个事件源有唯一的 `id` 和 `type`，运行时由 `EventSourceComponent` 统一管理。

## 2. 内置事件源类型

| Type | 说明 |
|------|------|
| `lark-cli` | 通过 lark-cli 订阅飞书事件 |
| `timer` | 定时触发（self-reminder / 自定义 prompt） |
| `bounty-im` | **Bounty IM 即时通讯**（v0.14 strict email-only，Task #1645 提升为内置） |

## 3. 配置位置

事件源配置持久化在 `~/.roy-bot/event-sources.json`：

```json
{
  "version": "1.0.0",
  "sources": [
    {
      "id": "bounty-im-auto",
      "name": "Bounty IM (Auto)",
      "type": "bounty-im",
      "email": "alice@bounty.example.com",
      "imServerUrl": "ws://localhost:4005/ws"
    }
  ]
}
```

> **注意**: 单 source JSON 中**不应包含** `enabled` 字段 — `enabled` 是 EventSourceComponent 组件级开关（`event-source.enabled`），不是 source 级字段。详见 [§6 字段语义](#6-字段语义)。

## 4. CLI 命令

### 4.1 添加事件源

```bash
# Bounty IM (v0.14 strict email-only)
roy-bot eventsource add "My Bounty IM" bounty-im \
  --email "alice@bounty.example.com" \
  --im-server-url "ws://localhost:4005/ws"

# 或者用 --profile 自动从 bounty profile 读取 email + api_base
roy-bot eventsource add "My Bounty IM" bounty-im \
  --profile "testuser"

# 飞书 lark-cli
roy-bot eventsource add "Feishu Bot" lark-cli \
  --command "lark-cli event +subscribe" \
  --profile my-app

# 定时器
roy-bot eventsource add "Daily Reminder" timer \
  --interval 86400000 \
  --prompt "提醒我检查邮件"
```

> **v0.14 breaking change**: `--address` flag 已彻底移除（v0.12/v0.13 不再支持）。
> bounty IM identity 现在只接受 `--email`（注册邮箱）或 `--profile`。

### 4.2 列出所有事件源

```bash
roy-bot eventsource list
```

输出示例：

```
ID          NAME                  TYPE          STATUS      ENABLED
bounty-...  Bounty IM (Auto)      bounty-im     created     ✓
lark-...    Feishu Bot            lark-cli      stopped     ✓
✅ 共 2 个事件源
```

### 4.3 启动 / 停止 / 状态

```bash
roy-bot eventsource start bounty-im-auto    # 启动
roy-bot eventsource stop bounty-im-auto     # 停止
roy-bot eventsource status bounty-im-auto   # 查状态
```

### 4.4 移除

```bash
roy-bot eventsource remove bounty-im-auto
```

## 5. 在 Interactive 模式下使用

启动交互模式时可通过 `--es` 参数同时启动指定事件源：

```bash
roy-bot interactive --es bounty-im-auto --es lark-cli-1
```

## 6. 字段语义

| 字段 | 层级 | 必填 | 说明 |
|------|------|------|------|
| `id` | source | ✅ | 唯一标识 |
| `name` | source | ✅ | 显示名 |
| `type` | source | ✅ | 事件源类型（见 §2） |
| `enabled` | **component** | ❌ | **不要**写在 source JSON 中！它是组件级开关（`event-source.enabled`） |
| `command` | source | lark-cli 必填 | 执行的命令 |
| `profile` | source | lark-cli 可选 / bounty-im 可选 | 多 appId / bounty profile 场景用 |
| `url` | source | websocket 必填 | WebSocket URL |
| `interval` | source | timer 必填 | 定时器间隔（ms） |
| `cron` | source | timer 可选 | cron 表达式 |
| `email` | source | bounty-im 必填 | **v0.14 strict email-only**: Agent 注册邮箱 |
| `imServerUrl` | source | bounty-im 必填 | IM Server WebSocket URL |
| `eventTypes` | source | ❌ | 事件类型过滤（逗号分隔，支持通配符如 `im.message.*`） |
| `handleRule` | source | ❌ | 事件处理规则（`{ agent?: string, plugins?: string[] }`） |
| `options` | source | ❌ | 自定义选项（向后兼容字段） |

> **v0.14 breaking change**: `address` 字段已彻底移除。如果你的旧配置有
> `address` 字段（如 `"address": "uuid@bounty.example.com"`），
> 启动时会 hard error 提示迁移。迁移指引：
> 1. 把 `address` 字段重命名为 `email`（值改成你的注册邮箱）
> 2. 删除 `options.address`（如有）
> 3. 重启事件源

## 7. PerTaskGroupChatPlugin 配置（Task #3945）

`PerTaskGroupChatPlugin` 是一个内置插件，**为每个 task 自动创建一个独立的飞书群聊**，
并把 task 的更新（progress、completion）发到该独立群聊里，而不是主聊天框。
适合 "一个 task 一个讨论组" 的协作场景。

### 7.1 启用方式

在 `lark-cli` 类型的事件源 `handleRule.plugins` 中加入 `"PerTaskGroupChatPlugin"`：

```json
{
  "id": "lark-cli-task-group",
  "name": "Feishu (Per-Task Group Chat)",
  "type": "lark-cli",
  "command": "lark-cli event +subscribe",
  "profile": "default",
  "handleRule": {
    "plugins": ["PerTaskGroupChatPlugin"]
  }
}
```

> **重要**：必须放在 lark-cli 事件源下，因为 `lark-cli im +chat-create` / `im +messages-send`
> 是这个插件调用的命令。其他事件源（bounty-im / timer / bounty-cli）暂不支持。

### 7.2 行为说明

| 阶段 | 触发点 | 行为 |
|------|--------|------|
| Task 创建 | `task:after.create` | 调 `lark-cli im +chat-create` 建群，回写 `task.context.larkPerTaskChatId` |
| Task 更新 | `task:after.update` | 把更新摘要发到独立群（而非主聊天框） |
| 子 task 操作 | `task:operation:after.create` | 子任务创建时由独立群接管通知 |
| Task 完成 | `task:after.complete` | 在独立群里发完成总结 |

> **默认行为**：
> - **子 task 默认不开新群**（避免群爆炸）。通过 `disableSubTaskSkip: true` 可关闭此保护。
> - **必须存在 `replyChannel`**（task 必须从某个 IM 消息起源）。通过
>   `requireReplyChannel: false` 可放宽，但通常不建议。

### 7.3 插件配置项

所有配置都通过 `handleRule.pluginConfig.<pluginName>` 传入（per-plugin config 字典）。

示例：
```json
{
  "handleRule": {
    "plugins": ["LarkCliTaskNotifyPlugin", "PerTaskGroupChatPlugin"],
    "pluginConfig": {
      "PerTaskGroupChatPlugin": {
        "inviteUserIds": ["ou_xxxxxxxxxxxxxxxx"]
      }
    }
  }
}
```

| Option | 默认 | 说明 |
|---------|------|------|
| `PerTaskGroupChatPlugin.disableSubTaskSkip` | `false` | `true` 时即使子 task 也建群 |
| `PerTaskGroupChatPlugin.requireReplyChannel` | `true` | `false` 时允许 replyChannel 缺失时也建群（fallback 到默认 profile） |
| `PerTaskGroupChatPlugin.fallbackProfile` | `""` | replyChannel 缺失时使用的 lark profile（配合 `requireReplyChannel: false` 使用） |
| `PerTaskGroupChatPlugin.sendWelcomeMessage` | `true` | 建群后是否立即发"任务创建"欢迎消息（让群聊在飞书侧立刻可见，避免空群聊不显示） |
| `PerTaskGroupChatPlugin.inviteUserIds` | `["sender"]` | 建群时要邀请的 user open_id 列表。`"sender"` 是占位符，会从 replyChannel.userId / replyChannel.params.userId / ALS userId 自动推导。**interactive mode 下没有真实 lark 消息，sender 拿不到，必须显式配置成具体的 open_id 列表** |

### 7.3.1 ★ interactive mode 必须显式配置 inviteUserIds

`interactive` / `act` / `chat` 命令从终端触发，没有真实 lark IM 消息，
event 链路没有 sender open_id，默认 `["sender"]` 推导拿不到任何 user → chat
创建成功但 user 没被邀请 → user 在飞书消息列表里看不到新群聊。

修复：在 `~/.roy-bot/event-sources.json` 给 `handleRule.pluginConfig.PerTaskGroupChatPlugin.inviteUserIds`
显式列出自己的 open_id：

```jsonc
{
  "handleRule": {
    "plugins": ["PerTaskGroupChatPlugin"],
    "pluginConfig": {
      "PerTaskGroupChatPlugin": {
        "inviteUserIds": ["ou_xxxxxxxxxxxx"]
      }
    }
  }
}
```

可通过 `lark-cli --profile default contact +get-self` 查自己的 open_id。

### 7.4 ⚠️ 不要与 `LarkCliTaskNotifyPlugin` 一起用

`LarkCliTaskNotifyPlugin` 把 task 更新发到**主聊天框**，`PerTaskGroupChatPlugin` 把
task 更新发到**独立群**。两者同时启用会造成**双重发送**，请二选一：

```jsonc
// ✅ 推荐：用独立群
"handleRule": { "plugins": ["PerTaskGroupChatPlugin"] }

// ✅ 或：继续用主聊天框
"handleRule": { "plugins": ["LarkCliTaskNotifyPlugin"] }

// ❌ 不要这样
"handleRule": { "plugins": ["LarkCliTaskNotifyPlugin", "PerTaskGroupChatPlugin"] }
```

### 7.5 P0 修复：自动注入 `setTaskUpdater`

为了让 `task.context.larkPerTaskChatId` 能持久化到 DB（下次 task 更新时回读 chat_id），
plugin 依赖外部注入一个 `setTaskUpdater(taskId, context)` 函数。

**修复方案**（Task #3945 patch）：
1. `EventSourceInstance` 接口新增可选方法 `setEnvironment?(env)`。
2. `EventSourceComponent.startSource()` 在 `instance.start()` 之前自动调用
   `instance.setEnvironment(this.getEnv())`。
3. `LarkCliInstance.registerPluginHooks()` 在注册 hook 之前，检测 plugin 是否有
   `setTaskUpdater` 方法，如果有就从 env 拿 task component 并注入。

**影响范围**：所有实现了 `setTaskUpdater` 的 plugin（目前只有 `PerTaskGroupChatPlugin`）。
旧的 handler（BountyIMInstance / BountyCliInstance）也支持 `setEnvironment`，但
它们不主动调 plugin.setTaskUpdater（那些场景下插件不需要写入 DB context）。

### 7.6 调试日志

调试此插件时，启用以下 env var：

```bash
# 启用 Roy 通知调试日志（含 task 创建/完成时的 channel 路由决策）
export LOG_LEVEL_ROY_TASK_NOTIFY=debug

# 启用 PerTaskGroupChatPlugin 自身的 debug 日志
export LOG_LEVEL_LARK_CLI_PER_TASK_GROUP=debug
```

关键日志点：

| 日志 | 含义 |
|------|------|
| `[PerTaskGroupChatPlugin] skip sub-task` | 子 task 默认被跳过（可用 `disableSubTaskSkip` 关闭） |
| `[PerTaskGroupChatPlugin] skip missing replyChannel` | 缺 replyChannel 被跳过（可用 `requireReplyChannel: false` 关闭） |
| `[PerTaskGroupChatPlugin] createGroupChat(...)` | 实际调 `lark-cli im +chat-create` |
| `[LarkCliInstance] injectTaskUpdater: env not injected` | env 未注入（taskUpdater 走 in-memory fallback，不会持久化） |
| `[PerTaskGroupChatPlugin] attached chatId to task` | 群 ID 已写入 task.context |

### 7.7 验证步骤

1. 启动 lark-cli 事件源：`roy-bot eventsource start lark-cli-task-group`
2. 在主聊天框发一条消息触发 task 创建（如 "帮我做 xxx"）。
3. 观察日志：应出现 `[PerTaskGroupChatPlugin] createGroupChat(...)` 和 `attached chatId to task`。
4. 在飞书侧应看到一个新建的群聊，群名含 task 标题前缀。
5. 该 task 有后续 update 时，更新消息应发到新建的群里（而非主聊天框）。
6. 重启 agent 后，新建的群 ID 应从 `task.context` 回读，无需重新建群。

---

## 8. Bounty IM 详细示例

### 8.1 完整 JSON 配置

```json
{
  "id": "bounty-im-auto",
  "name": "Bounty IM (Auto)",
  "type": "bounty-im",
  "imServerUrl": "ws://localhost:4005/ws",
  "email": "alice@bounty.example.com",
  "handleRule": {
    "agent": "roy"
  }
}
```

### 8.2 字段说明

- **`email`**: 当前 agent 的注册邮箱（v0.14 strict email-only）。收到消息时校验 `msg.to === config.email`。
- **`imServerUrl`**: IM Server 的 WebSocket URL（如 `ws://localhost:4005/ws`）。handler 启动时会连接此 URL。
- **`handleRule.agent`**: 推荐使用的 agent 名称，会写入 event metadata（与 larkCli handler 对齐）。**注意**：当前架构下下游路由尚未实现，agent 字段暂时是 dead config（用于未来 routing feature）。

### 8.3 消息处理流程

1. `BountyIMInstance.start()` 连接 `imServerUrl`
2. 收到 WS 消息（JSON 格式 `{ event: "message", data: { ... } }`）
3. 跳过非 pending 状态消息（如 delivered）
4. 提取 `from` / `to` / `content` 等字段
5. 构造 `EventSourceEvent`，包含：
   - `metadata.senderId` / `metadata.chatId` / `metadata.agent`
   - `recommendedAction.action`（含回复命令提示）
   - `replyChannel.type === "bounty-im"`（含 from/to/imServerUrl 参数）
6. 通过 `eventHandler(event)` 推送给 EventSourceComponent
7. 发送 ACK 到 IM Server（如果消息有 id）

### 8.4 启动方式对比

```bash
# 方式 1：交互模式附带
roy-bot interactive --es bounty-im-auto

# 方式 2：CLI 单独管理
roy-bot eventsource start bounty-im-auto
```

两种方式等价 — 都通过 `EventSourceComponent.startSource(id)` 触发。

### 8.5 TLS 跳过校验（`tlsSkipVerify`）

#### 8.5.1 何时需要

当 `imServerUrl` 是 `wss://` 且服务端使用自签名证书或内部 CA 证书时（典型场景：
Kubernetes 集群内 / 内网测试环境），客户端默认严格校验会失败并报
`self-signed certificate in certificate chain`。设 `tlsSkipVerify: true` 可绕过。

```json
{
  "id": "bounty-im-auto",
  "type": "bounty-im",
  "imServerUrl": "wss://bounty.example.example.com/ws",
  "email": "alice@bounty.example.com",
  "tlsSkipVerify": true
}
```

#### 8.5.2 runtime 差异 — bun vs Node.js

| Runtime | per-WebSocket `rejectUnauthorized: false` | 行为 |
|---------|------------------------------------------|------|
| **Node.js** （生产目标） | ✅ 原生生效 | 不需要额外处理 |
| **bun** （dev/local） | ❌ 被 bun TLS 层忽略（bun quirk） | 自动 fallback 到 `NODE_TLS_REJECT_UNAUTHORIZED=0` 环境变量 |

**bun quirk 说明**：`ws@^8.16.0` 的 WebSocket 构造选项 `rejectUnauthorized: false` 在 bun
runtime 下不被 bun 的 TLS 层处理。bun 的 TLS 层只读 `NODE_TLS_REJECT_UNAUTHORIZED` 环境
变量。所以 handler 在检测到 bun runtime 且 `tlsSkipVerify=true` 时，会自动写
`process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"` 来让证书校验被跳过。

**为什么不用全局**：用户在 [Task #1645] 强烈约束"绝对不能影响同进程其他 TLS 连接 /
绝对不能在 Node.js 生产路径下设置 env var / 仅 dev 模式才写"。handler 的实现：
1. `typeof Bun !== "undefined"` 守卫 → 仅 bun dev 模式命中。
2. `tlsSkipVerify === true` 守卫 → 用户必须显式开启，不暗藏默认值。
3. URL scheme 守卫 → 仅 `wss://` 才写 env var（`ws://` 不走 TLS，写了也没用且浪费副作用）。

#### 8.5.3 ⚠️ bun-dev 副作用：当 `tlsSkipVerify=true` 时，整个进程 TLS 校验被禁用

由于 env var 是**进程级**而非 per-WebSocket 作用域，bun dev 模式下设置
`tlsSkipVerify=true` 会导致 **同一个 Node.js/bun 进程内的所有 TLS 连接**都跳过证书校验，
包括：

- 其他 plugin 的 HTTPS 调用
- MCP server 的 wss 连接
- Tool node 的对外 HTTPS 请求
- builtin model provider 的 HTTPS API 调用

**这是 bun runtime 唯一可用的 TLS skip 方案**，且仅在本地 dev/test 场景下生效。生产
目标是 Node.js，原生 per-WebSocket `rejectUnauthorized: false` 隔离生效，不需要 env
fallback，**因此也不会有这种副作用**。

#### 8.5.4 验证 env fallback 是否生效（debug 用）

```bash
# 探测脚本 + bun runtime（仿 Task #1645 Phase B.9 测试）
bun -e '
  import { BountyIMInstance } from "@ai-setting/roy-bot-core/env/event-source/bounty-im-handler";
  const inst = new BountyIMInstance({
    id: "probe", type: "bounty-im", enabled: true,
    email: "probe@example.com",
    imServerUrl: "wss://your-server/ws",
    tlsSkipVerify: true,
  });
  console.log("PRE  env:", process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "<unset>");
  await inst.start();
  console.log("POST env:", process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "<unset>");
'
```

bun runtime 输出应为 `POST env: "0"`（handler 写入了 fallback env var）。
Node.js runtime 输出应为 `POST env: "<unset>"`（不写入）。

## 9. 故障排查

### 9.1 "Handler not registered for type bounty-im"

**原因**: 使用了老版本的 `@ai-setting/roy-bot-core`，没有内置 `bountyIMHandler`。

**解决**: 升级 `@ai-setting/roy-bot-core` 到 `>= 1.5.93`（Task #1645 发布版本）。

### 9.2 "Bounty IM imServerUrl is required"

**原因**: JSON 配置中缺少 `imServerUrl` 字段（顶级或 `options.imServerUrl`）。

**解决**: 显式配置 `imServerUrl`，例如 `"imServerUrl": "ws://localhost:4005/ws"`。

> **注意**: 自 v1.5.93 起，bounty-im handler **不再 fallback 到环境变量**（如 `BOUNTY_WS_URL`），必须显式配置。

### 9.2b "v0.14 strict email-only: legacy 'address' field is no longer supported"

**原因**: 配置中仍有 v0.12/v0.13 的 `address` 字段（如 `"address": "uuid@bounty.example.com"`）。
v0.14 彻底移除 address 支持，启动时报错。

**解决**:
1. 把 `address` 字段重命名为 `email`（值改成你的注册邮箱，例如 `alice@bounty.example.com`）
2. 删除 `options.address`（如有）
3. 删除 `options.email` 不影响，handler 会优先读顶级字段
4. 重启事件源

### 9.3 "WebSocket connection failed"

**原因**: IM Server 未启动，或 URL 错误。

**解决**: 检查 `imServerUrl` 是否可访问，确保 IM Server 在该地址监听。

### 9.4 "self-signed certificate in certificate chain"（bun dev only）

**原因**: `imServerUrl` 是 `wss://` 且服务端用的是自签名/内部 CA 证书。Node.js runtime
下加 `tlsSkipVerify: true` 即可解决；bun runtime 下 handler 会自动 fallback 到
`NODE_TLS_REJECT_UNAUTHORIZED=0` env var（见 §8.5）。

**症状**: bun + `tlsSkipVerify: true` 仍报证书错误 → 说明 env fallback 没生效。

**排查**:
1. 确认 `tlsSkipVerify: true` 真在配置里（顶级或 `options.tlsSkipVerify`）：
   ```bash
   jq '.sources[] | select(.id=="bounty-im-auto") | .tlsSkipVerify' \
     ~/.roy-bot/event-sources.json
   ```
2. 确认 `imServerUrl` 是 `wss://`（不是 `ws://` — env 只在 wss 写）。
3. 用上面 §8.5.4 的探测脚本验证：`POST env` 应为 `"0"`。
4. 如果 `POST env` 仍为 `<unset>`：升级 `@ai-setting/roy-bot-core` 到支持 Phase B.9 的版本。

### 9.5 PerTaskGroupChatPlugin 群聊未创建

**症状**: task 创建了，但飞书侧没看到新群；`task.context.larkPerTaskChatId` 为空。

**原因** (按可能性从高到低):

1. **eventsource 没启用插件**：`handleRule.plugins` 数组中没有 `PerTaskGroupChatPlugin`。
   **解决**: 见 §7.1 配置示例。

2. **`setTaskUpdater` 没注入**：env 未注入或 `env.getComponent("task")` 不存在，
   plugin 走 in-memory fallback，chat_id 不持久化到 DB。
   **排查**:
   ```bash
   # 启动时日志里应该有这两条之一
   export LOG_LEVEL_LARK_CLI_PER_TASK_GROUP=debug
   ```
   - 看到 `[LarkCliInstance] injectTaskUpdater: env not injected` → env 注入链断了
   - 看到 `[LarkCliInstance] injectTaskUpdater: taskComponent not found` → task 组件没注册到 env

3. **replyChannel 缺失**：默认 `requireReplyChannel: true`，缺 replyChannel 时
   plugin 会 skip。**解决**: 通过 `PerTaskGroupChatPlugin.requireReplyChannel: false` 放宽。

4. **子 task 默认被跳过**：默认 `disableSubTaskSkip: false`，子 task 不会建群。
   **解决**: 通过 `PerTaskGroupChatPlugin.disableSubTaskSkip: true` 关闭。

5. **lark-cli 没装 / 鉴权失败**：`createGroupChat` 调 `lark-cli im +chat-create` 时失败。
   **排查**: 直接在 shell 跑 `lark-cli im +chat-create --name "test"`，看错误。

### 9.6 PerTaskGroupChatPlugin 双重发送

**症状**: 同一个 task 更新被发到了**两个地方**（主聊天框 + 新群）。

**原因**: 同时启用了 `LarkCliTaskNotifyPlugin` 和 `PerTaskGroupChatPlugin`。

**解决**: 二选一（见 §7.4）。

## 10. 开发者参考

- **类型定义**: `@ai-setting/roy-bot-core/dist/env/event-source/types.d.ts`
- **Handler 实现**: `@ai-setting/roy-bot-core/dist/env/event-source/bounty-im-handler.js`
- **CLI 命令**: `packages/cli/src/commands/eventsource/{add,list,start,stop,status,remove}.ts`
- **设计文档**: `.roy/memory/design/2026-bounty-im-builtin-design.md`

## 11. 相关 Task

- **Task #1644**: Bounty-IM → Roy-Agent 内置 Handler 提升方案（设计）
- **Task #1645**: Bounty-IM → Roy-Agent 内置 Handler 同步实施（实施）
- **Task #3945**: PerTaskGroupChatPlugin（每 task 建独立飞书群聊）
- **Task #3957**: 注册 task:after.complete for Hook-mode plugins（PerTaskGroupChatPlugin 触发链路修复）