/**
 * @fileoverview EventBusNotificationChannel
 *
 * 默认 NotificationChannel 实现 —— 把通知转成 roy-bot 自身
 * `env.pushEnvEvent` 事件。
 *
 * ## 事件命名空间
 *
 * - event.type = `plugin.notification.<NotificationOptions.type>`
 * - event.metadata.source = `plugin:<extras.pluginName>`
 * - event.metadata 合并用户传入的 options.metadata（不覆盖 source）
 * - event.payload = `{ title, content }`
 *
 * ## 失败处理
 *
 * - 缺失 envInstance / pushEnvEvent → silent skip（log debug）
 * - pushEnvEvent 抛错 → swallow（log warn）
 *
 * 通知失败不应当污染 Plugin 主流程 —— Plugin 永远拿不到通知失败信号。
 */

import { createLogger } from "../log-trace/logger";
import type {
  EnvContextLike,
  NotificationChannel,
  NotificationOptions,
  NotificationSendExtras,
} from "./notification-channel";

const logger = createLogger("plugin:notification:event-bus");

/**
 * EventBus Notification Channel
 *
 * 默认通道。可用于任何 plugin 通知场景（不依赖 replyChannel）。
 *
 * @example
 * ```ts
 * import { EventBusNotificationChannel } from "./event-bus-notification-channel";
 *
 * component.setNotificationChannels([
 *   new EventBusNotificationChannel(),
 *   // 或其他自定义通道
 * ]);
 * ```
 */
export class EventBusNotificationChannel implements NotificationChannel {
  readonly name = "event-bus";

  /**
   * event-bus 通道 always routable（无外部依赖）
   *
   * 注：missing envInstance / pushEnvEvent 在 send 时检测，不在这里拒绝，
   * 保持 canRoute 语义简单（"我能路由这种通知吗"），让 send 决定是否真的能投递。
   */
  canRoute(
    _options: NotificationOptions,
    _extras: NotificationSendExtras,
    _envContext: EnvContextLike
  ): boolean {
    return true;
  }

  /**
   * 通过 env.pushEnvEvent 推送 plugin.notification.<type> 事件
   */
  async send(
    options: NotificationOptions,
    extras: NotificationSendExtras,
    _envContext: EnvContextLike
  ): Promise<void> {
    const envInstance = extras.envInstance;
    if (!envInstance) {
      logger.debug(
        `[event-bus] No envInstance for plugin '${extras.pluginName}', skip notification '${options.type}'`
      );
      return;
    }

    const pushFn = (envInstance as { pushEnvEvent?: unknown }).pushEnvEvent;
    if (typeof pushFn !== "function") {
      logger.debug(
        `[event-bus] envInstance.pushEnvEvent is not a function for plugin '${extras.pluginName}', skip notification '${options.type}'`
      );
      return;
    }

    const eventType = `plugin.notification.${options.type}`;
    const event = {
      id: generateEventId(),
      type: eventType,
      timestamp: Date.now(),
      metadata: {
        source: `plugin:${extras.pluginName}`,
        ...(options.metadata || {}),
      },
      payload: {
        title: options.title,
        content: options.content,
      },
    };

    try {
      (pushFn as (event: unknown) => void).call(envInstance, event);
    } catch (err) {
      logger.warn(
        `[event-bus] pushEnvEvent threw for plugin '${extras.pluginName}' notification '${options.type}': ${err}`
      );
      // swallow - notification failure must not break plugin main flow
    }
  }
}

// ========================================================================
// Helpers
// ========================================================================

/**
 * 生成唯一事件 ID
 *
 * 格式：`<timestamp>-<random>` —— 类似 crypto.randomUUID 的短形式。
 * 不依赖 node:crypto（避免增加 import）。
 */
function generateEventId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${ts}-${rand}`;
}
