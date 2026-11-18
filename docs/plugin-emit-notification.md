# Plugin Notification 设计文档

> roy-bot 插件通知系统 —— Plugin 通过 `env.notify(options)` 发出通知，由
> `PluginComponent` 路由到 `NotificationChannel`，默认走 roy-bot 自身的
> `env.pushEnvEvent`，并以 `plugin.notification.<type>` 命名空间发布。

---

## 1. 背景与目标

### 1.1 问题

传统的 Plugin 通知需要：

1. Plugin 通过外部 SDK（飞书 `lark-cli`、邮件、Webhook 等）发消息
2. 每个 Plugin 各自实现 IM / 投递逻辑
3. 强耦合：Plugin 想换通道需要重写

### 1.2 解决方案

1. **抽象 `NotificationChannel` 接口** —— Plugin 不关心谁来投递
2. **默认实现 `EventBusNotificationChannel`** —— 走 roy-bot 自身的 event bus
3. **保留 `LarkCliNotificationChannel`** 作为 @deprecated legacy
4. **env-level event subscriber** —— 上层（CLI / IM 适配器）订阅 `plugin.notification.*` 事件做实际投递

### 1.3 优势

- **关注点分离**：Plugin 只关心"什么时候、通知什么"；投递由专门的 subscriber 负责
- **多通道扩展**：可注入多个 channel（如 Webhook + Lark），PluginComponent 自动路由
- **可测试**：channel 接口独立可 mock，Plugin 测试无需真实发飞书
- **错误隔离**：channel.send 内部 swallow 异常，不污染 Plugin 主流程

---

## 2. 架构

```
                    ┌────────────────────────────────────────┐
                    │ Plugin (e.g. roy-plugin-task-show)     │
                    │   await env.notify({...})              │
                    └───────────────┬────────────────────────┘
                                    │
                                    ▼
                    ┌────────────────────────────────────────┐
                    │ PluginEnv (implements PluginEnv)       │
                    │   notify(options) -> void               │
                    └───────────────┬────────────────────────┘
                                    │
                                    ▼
                    ┌────────────────────────────────────────┐
                    │ PluginComponent.routeNotification()    │
                    │   遍历 channels → 第一个 canRoute()    │
                    │   → 调用 channel.send()                 │
                    └───────────────┬────────────────────────┘
                                    │
                ┌───────────────────┴───────────────────┐
                │                                       │
                ▼                                       ▼
  ┌──────────────────────────┐         ┌──────────────────────────┐
  │ EventBusNotificationChannel (默认)│ │ LarkCliNotificationChannel (legacy) │
  │   → env.pushEnvEvent(    │         │   → lark-cli 子进程 (直接发飞书) │
  │       plugin.notification.│         │   ⚠️ @deprecated            │
  │       <type>)             │         │                           │
  └──────────────┬───────────┘         └──────────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────────┐
  │ EnvContext.pushEnvEvent (env instance)   │
  │   → 内部 event bus                       │
  └──────────────┬───────────────────────────┘
                 │
                 ▼
  ┌──────────────────────────────────────────┐
  │ Env-level Event Subscriber (CLI / IM)    │
  │   e.g. "lark-cli-event-source"           │
  │   → 收到 plugin.notification.*         │
  │   → 调 lark-cli 发消息                   │
  └──────────────────────────────────────────┘
```

---

## 3. API Reference

### 3.1 `NotificationChannel` 接口

```typescript
// packages/core/src/env/plugin/notification-channel.ts

export interface NotificationChannel {
  readonly name: string;

  /** 当前 channel 能否路由这条通知 */
  canRoute(
    options: NotificationOptions,
    extras: NotificationSendExtras,
    envContext: EnvContextLike
  ): boolean;

  /** 实际投递（内部 swallow 异常） */
  send(
    options: NotificationOptions,
    extras: NotificationSendExtras,
    envContext: EnvContextLike
  ): Promise<void>;
}
```

### 3.2 `NotificationOptions`

```typescript
export interface NotificationOptions {
  /** 通知类型（必填），EventBus 通道转成 plugin.notification.<type> 事件 */
  type: string;
  /** 通知标题 */
  title: string;
  /** 通知内容（人类可读，IM 渲染时支持 markdown） */
  content: string;
  /** 额外元数据，透传到 event.metadata */
  metadata?: Record<string, unknown>;
}
```

### 3.3 `NotificationSendExtras`（PluginComponent 注入）

```typescript
export interface NotificationSendExtras {
  /** Plugin 名称（用于 metadata.source = "plugin:<pluginName>"） */
  pluginName: string;
  /** Environment 实例（EventBus 通道用来调 pushEnvEvent） */
  envInstance?: { pushEnvEvent(event: unknown): void; [k: string]: unknown };
}
```

### 3.4 `PluginEnv.notify(options)`

```typescript
// packages/core/src/env/plugin/types.ts

export interface PluginEnv {
  /**
   * 发送通知
   *
   * - 不抛错（channel.send 异常被 swallow）
   * - 没有任何 channel 能路由则通知被丢弃（log warn）
   */
  notify(options: NotificationOptions): Promise<void>;
  // ... 其他方法
}
```

### 3.5 `EventBusNotificationChannel`

**默认实现**。把 notification 转成 `plugin.notification.<type>` 事件，通过 `extras.envInstance.pushEnvEvent()` 发布。

```typescript
// packages/core/src/env/plugin/event-bus-notification-channel.ts

export class EventBusNotificationChannel implements NotificationChannel {
  readonly name = "event-bus";
  canRoute(_o, _e, _c) { return true; }  // 始终可路由
  async send(options, extras, _ctx) {
    if (!extras.envInstance) return;  // silent skip
    extras.envInstance.pushEnvEvent({
      id: generateEventId(),
      type: `plugin.notification.${options.type}`,
      timestamp: Date.now(),
      metadata: {
        source: `plugin:${extras.pluginName}`,
        ...(options.metadata || {}),  // 用户 metadata 不会覆盖 source
      },
      payload: { title: options.title, content: options.content },
    });
  }
}
```

**事件 payload 形状**：

```typescript
{
  id: "lqp7x2-3kfm9abc",
  type: "plugin.notification.visualization_ready",
  timestamp: 1720648200000,
  metadata: {
    source: "plugin:task-show",
    taskId: 42,
    terminalStatus: "completed",
    // ... 用户传入的 metadata 字段
  },
  payload: {
    title: "Task #42 completed",
    content: "Task: Build a chart\nStatus: completed",
  },
}
```

### 3.6 `LarkCliNotificationChannel`（@deprecated）

```typescript
// ⚠️ @deprecated — 自 v2 起默认通道改为 EventBusNotificationChannel
// 保留为 opt-in legacy 实现。新代码请用 EventBusNotificationChannel + env-level event subscriber。
export class LarkCliNotificationChannel implements NotificationChannel {
  readonly name = "lark-cli";
  // canRoute: 仅在 replyChannel.type === "lark-cli" 时为 true
  // send: 直接调 lark-cli 子进程投递
}
```

---

## 4. 默认通道与 Legacy 通道

| Channel | canRoute 条件 | 投递方式 | 推荐度 |
|---------|---------------|----------|--------|
| `EventBusNotificationChannel` (默认) | 始终 true（无外部依赖） | `env.pushEnvEvent("plugin.notification.<type>")` | ✅ **推荐** |
| `LarkCliNotificationChannel` (legacy) | `replyChannel.type === "lark-cli"` | 直接调 `lark-cli im +messages-send` 子进程 | ⚠️ @deprecated |

切换默认通道通过 `PluginComponent.setNotificationChannels([...])`。

---

## 5. 自定义通道

实现 `NotificationChannel` 接口，可以做到任意投递方式（Webhook、邮件、Slack 等）。

```typescript
import type { NotificationChannel, NotificationOptions, NotificationSendExtras, EnvContextLike } from "@ai-setting/roy-bot-core/env/plugin";

class WebhookChannel implements NotificationChannel {
  readonly name = "webhook";

  canRoute(options: NotificationOptions, extras: NotificationSendExtras, ctx: EnvContextLike): boolean {
    return !!ctx.replyChannel?.params?.webhookUrl;
  }

  async send(options: NotificationOptions, extras: NotificationSendExtras, ctx: EnvContextLike): Promise<void> {
    const url = ctx.replyChannel!.params!.webhookUrl as string;
    try {
      await fetch(url, {
        method: "POST",
        body: JSON.stringify({
          plugin: extras.pluginName,
          type: options.type,
          title: options.title,
          content: options.content,
          metadata: options.metadata ?? {},
        }),
        headers: { "Content-Type": "application/json" },
      });
    } catch (err) {
      // swallow — 通知失败不污染 Plugin 主流程
    }
  }
}

// 注册到 PluginComponent
import { PluginComponent } from "@ai-setting/roy-bot-core/env/plugin";

const component = new PluginComponent({
  notificationChannels: [
    new WebhookChannel(),  // 用户指定走 webhook
    new EventBusNotificationChannel(),  // 兜底
  ],
});
```

**路由顺序**：PluginComponent 按 channels 数组顺序选第一个 `canRoute() === true` 的通道。如果所有通道都返回 false，通知被丢弃（log warn）。

---

## 6. 迁移指南：从直接调 lark-cli 到 env.notify

### 6.1 旧代码（Plugin 直接调 lark-cli）

```typescript
// ❌ 旧方案 — 不推荐
import { spawn } from "child_process";

class OldTaskShowPlugin extends BasePlugin {
  init(env: PluginEnv) {
    env.registerHook({
      point: TaskHookPoints.AFTER_COMPLETE,
      handler: async (ctx) => {
        // 直接调 lark-cli — 强耦合到飞书
        const lark = spawn("lark-cli", [
          "im", "+messages-send",
          "--user-id", ctx.data.sessionUserId,
          "--as", "bot",
          "--markdown", `Task #${ctx.data.taskId} completed!`,
        ]);
      },
    });
  }
}
```

**问题**：
- Plugin 强耦合到飞书
- 无法测试（必须真实发送）
- 通道切换（飞书 → 邮件）需要重写 Plugin

### 6.2 新代码（Plugin 走 env.notify）

```typescript
// ✅ 新方案 — 推荐
class NewTaskShowPlugin extends BasePlugin {
  init(env: PluginEnv) {
    env.registerHook({
      point: TaskHookPoints.AFTER_COMPLETE,
      handler: async (ctx) => {
        await env.notify({
          type: "visualization_ready",
          title: `Task #${ctx.data.taskId} completed`,
          content: "Click to view the visualization.",
          metadata: {
            taskId: ctx.data.taskId,
            terminalStatus: ctx.data.terminalStatus,
          },
        });
      },
    });
  }
}
```

**优势**：
- Plugin 不关心谁来投递
- 测试简单（mock env.notify）
- 通道由 PluginComponent 决定（默认 EventBus，可注入自定义）

### 6.3 上层 subscriber（CLI / IM 适配器）

实际投递由 env-level event subscriber 完成。例如 `lark-cli-event-source` 收到 `plugin.notification.*` 事件后调用 `lark-cli im +messages-send`：

```typescript
// packages/cli/src/event-source/lark-cli-event-source.ts (示意)

eventSource.on("plugin.notification.*", async (event) => {
  const { title, content } = event.payload;
  const meta = event.metadata;

  // 路由到对应 IM 频道
  const target = meta.imChatId ?? meta.userId;

  await spawnLarkCli("im", "+messages-send", [
    "--chat-id", target,
    "--as", "bot",
    "--title", title,
    "--markdown", content,
  ]);
});
```

**好处**：Plugin 不需要知道 imChatId 是哪里来的，subscriber 有 IM 通道上下文。

---

## 7. 真实 Plugin 示例：`roy-plugin-task-show`

`RoyPluginTaskShow` 不再随 roy-bot 仓发布 — 它的实现位于独立 plugin 仓 [`roy-plugin-task-show`](https://github.com/<org>/roy-plugin-task-show)（npm: `roy-plugin-task-show`），是 `env.notify` API 的 **production consumer**。

roy-bot 仓（host 端）只保留 host 框架能力：

- `NotificationChannel` 抽象 + `EventBusNotificationChannel` 默认实现
- `PluginEnv.notify()` API
- `PluginComponent.routeNotification()` / `setNotificationChannels()`
- **不提供**任何内建示例 plugin（避免误用为 production 依赖）

**Plugin 端实现要点**（参考 `roy-plugin-task-show/src/plugin.ts`）：

```typescript
// 来源：roy-plugin-task-show/src/plugin.ts (v0.4.0+)
import { BasePlugin, type PluginEnv } from "@ai-setting/roy-bot-core/env/plugin";

class TaskShowPlugin extends BasePlugin {
  readonly name = "roy-plugin-task-show";

  init(env: PluginEnv) {
    env.registerHook({
      point: "task:after.complete",
      handler: async (ctx) => {
        if (!isTerminalStatus(ctx.data.status)) return;
        try {
          await env.notify({
            type: "visualization_ready",
            title: `Task #${ctx.data.taskId} ${ctx.data.status}`,
            content: `Task: ${ctx.data.title}\nStatus: ${ctx.data.status}`,
            metadata: {
              taskId: ctx.data.taskId,
              terminalStatus: ctx.data.status,
              url: `http://<host>/task/${ctx.data.taskId}`,
              sessionId: ctx.data.sessionId,
            },
          });
        } catch (err) {
          // notify 失败不应影响 Plugin 主流程
          this.logger.warn(`notify failed: ${err}`);
        }
      },
    });
  }
}
```

**经 env.notify 后流转到 EventBus 的事件 payload**：

```typescript
{
  type: "plugin.notification.visualization_ready",
  metadata: {
    source: "plugin:roy-plugin-task-show",
    taskId: 42,
    terminalStatus: "completed",  // completed | failed | cancelled | timeout
    sessionId: "sess-xyz",
    taskTitle: "Build a chart",
    url: "http://<host>/task/42",
  },
  payload: {
    title: "Task #42 completed",
    content: "Task: Build a chart\nStatus: completed",
  },
}
```

**自行实现自定义 Plugin** 的最小骨架（与上述生产 plugin 同形）：

```typescript
import { BasePlugin, type PluginEnv } from "@ai-setting/roy-bot-core/env/plugin";

class MyPlugin extends BasePlugin {
  readonly name = "my-plugin";

  init(env: PluginEnv) {
    env.registerHook({
      point: "task:after.complete",
      handler: async (ctx) => {
        await env.notify({
          type: "my_notification",
          title: `Task #${ctx.data.taskId} done`,
          content: "...",
          metadata: { taskId: ctx.data.taskId },
        });
      },
    });
  }
}
```

---

## 8. 设计决策记录

### 8.1 为什么默认走 env.pushEnvEvent 而不是 lark-cli？

- **关注点分离**：Plugin 只发"通知事件"，不关心实际投递
- **可测试**：mock env.notify 即可测 Plugin 行为
- **多通道**：同一 Plugin 可在飞书 / Slack / Webhook 间切换不重写
- **env-level subscriber 模式**：投递逻辑集中在 IM 适配器层

### 8.2 为什么 channel.send 内部 swallow 异常？

- Plugin 主流程不应受通知失败影响
- 通知失败通过 log.warn 暴露，不通过异常上抛
- 用户可通过 env-level event subscriber 自行加 retry / fallback

### 8.3 为什么 event.metadata.source 强制覆盖为 plugin:<name>？

- 上层 subscriber 据此区分"是 Plugin 发的事件 vs 系统事件"
- 用户传入的 metadata 字段不会覆盖 source（避免误标记）

### 8.4 为什么保留 LarkCliNotificationChannel？

- 向后兼容（旧 Plugin / 历史代码）
- opt-in 选择：在确认只有飞书场景且想绕开 event bus 时可用
- 标记 @deprecated 提示新代码不要用

---

## 9. 测试

### 9.1 单元测试覆盖

| 模块 | 测试用例数 | 文件 |
|------|-----------|------|
| `EventBusNotificationChannel` | 14 | `event-bus-notification-channel.test.ts` |
| `LarkCliNotificationChannel` (legacy) | 18 | `lark-cli-notification-channel.test.ts` |
| `PluginComponent` (含 routeNotification / setNotificationChannels) | 多组 | `plugin-component.test.ts` |

> 注：`RoyPluginTaskShow` 的 16 个测试随 host 端示例一起删除（见 commit history 41f84b6a）；对应测试已迁至独立 plugin 仓 [`roy-plugin-task-show`](https://github.com/<org>/roy-plugin-task-show) 的 `test/plugin-notify.test.ts`（v0.4.0+）。

### 9.2 手动测试场景

```bash
# 1. 启动 dev CLI
bun packages/cli/dist/bin/roy-bot.js interactive

# 2. 在交互中触发 task 完成
# 3. 观察日志：是否出现 "[event-bus] pushEnvEvent called for plugin.notification.*"
```

---

## 10. 关联文件清单

| 类别 | 路径 |
|------|------|
| 接口定义 | `packages/core/src/env/plugin/notification-channel.ts` |
| 默认实现 | `packages/core/src/env/plugin/event-bus-notification-channel.ts` |
| Legacy 实现 | `packages/core/src/env/plugin/lark-cli-notification-channel.ts` |
| PluginEnv 类型 | `packages/core/src/env/plugin/types.ts` |
| PluginComponent 集成 | `packages/core/src/env/plugin/plugin-component.ts` |
| Plugin Barrel | `packages/core/src/env/plugin/index.ts` |
| Hook 上下文 | `packages/core/src/env/task/hooks/contexts.ts` (TaskCompleteResultContext) |
| Hook 点定义 | `packages/core/src/env/task/hooks/task-hook-points.ts` (AFTER_COMPLETE) |
| **Production Plugin 示例**（独立仓） | [`roy-plugin-task-show/src/plugin.ts`](https://github.com/<org>/roy-plugin-task-show) (npm: `roy-plugin-task-show` v0.4.0+) |
