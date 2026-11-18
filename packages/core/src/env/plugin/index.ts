/**
 * @fileoverview Plugin System Module
 */

// Types
export {
  BasePlugin,
  type PluginEnv,
  type HookDefinition,
  type HookHandler,
  type AgentInstanceConfig,
  type ToolDefinition,
  type HookContext,
  type HookResult,
} from "./types";

// Component
export { PluginComponent, type PluginComponentOptions } from "./plugin-component";

// Notification Channels
export type {
  EnvContextLike,
  NotificationChannel,
  NotificationOptions,
  NotificationSendExtras,
} from "./notification-channel";
export { EventBusNotificationChannel } from "./event-bus-notification-channel";

/**
 * @deprecated 自 v2 起默认通道改为 EventBusNotificationChannel。
 *             LarkCliNotificationChannel 保留为 opt-in legacy 实现。
 *             新代码请用 EventBusNotificationChannel + env-level event subscriber。
 */
export { LarkCliNotificationChannel } from "./lark-cli-notification-channel";
