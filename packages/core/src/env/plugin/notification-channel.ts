/**
 * @fileoverview Notification Channel Abstraction
 *
 * Plugin 通知通道抽象。Plugin 通过 `PluginEnv.notify(options)` 发送通知，
 * PluginComponent 负责把通知路由到已注册的 NotificationChannel 实例。
 *
 * ## 默认实现
 *
 * `EventBusNotificationChannel` —— 默认通道，把通知转成 roy-bot 自身
 * `env.pushEnvEvent` 事件，事件命名空间 `plugin.notification.<type>`，
 * metadata.source 固定为 `plugin:<pluginName>`。
 *
 * ## Legacy 实现（@deprecated）
 *
 * `LarkCliNotificationChannel` —— 历史默认通道，直接通过 `lark-cli` 子进程
 * 发飞书消息。保留为可选/opt-in；标记为 @deprecated，新代码请用
 * `EventBusNotificationChannel`，配合 env-level event subscriber 自定义
 * 飞书投递逻辑。
 *
 * ## 自定义通道
 *
 * 实现 `NotificationChannel` 接口，并通过 `PluginComponent.setNotificationChannels()`
 * 注入。PluginComponent 按 channels 数组顺序选第一个 `canRoute() === true` 的通道。
 *
 * @example
 * ```ts
 * // 1. 自定义通道（IM-implementable）
 * class WebhookChannel implements NotificationChannel {
 *   readonly name = "webhook";
 *   canRoute(opts, extras, ctx) { return !!ctx.replyChannel?.params?.webhookUrl; }
 *   async send(opts, extras, ctx) { await fetch(...); }
 * }
 *
 * // 2. 注册到 PluginComponent
 * component.setNotificationChannels([
 *   new WebhookChannel(),
 *   EventBusNotificationChannel(),  // 兜底
 * ]);
 * ```
 */

// ========================================================================
// EnvContextLike - 通道可见的 EnvContext 形状
// ========================================================================

/**
 * EnvContext 简化视图（通道只用 replyChannel，传入最小必需字段即可）。
 *
 * 通过 `getEnvContextOrEmpty()` 获取当前 ALS 中的 EnvContext。
 */
export interface EnvContextLike {
  /** Reply channel（IM 通道路由信息） */
  replyChannel?: {
    /** 渠道类型，如 lark-cli, bounty-im */
    type?: string;
    /** app ID */
    appId?: string;
    /** chat ID */
    chatId?: string;
    /** message ID（用于 reply） */
    messageId?: string;
    /** raw command（IM 场景下的原始指令） */
    rawCommand?: string;
    /**
     * lark-cli profile（多 appId 场景下指定用哪个 lark-cli profile 发消息）
     *
     * 当 replyChannel.type 含 'lark' 时，LarkCliNotificationChannel 会读取此字段
     * 决定是否在 args 头部插入 `--profile <name>` flag。
     */
    profile?: string;
    /** 其他参数（由 EventSource 注入） */
    params?: Record<string, unknown>;
  };
}

// ========================================================================
// NotificationOptions - Plugin 发出的通知负载
// ========================================================================

/**
 * Plugin 调用 `env.notify(options)` 时传入的选项。
 *
 * 设计原则：
 * - `type` 是必填的"通知类型"，EventBus 通道会把它转换成
 *   `plugin.notification.<type>` 事件
 * - `title` / `content` 是人类可读的展示文本（IM 通知渲染用）
 * - `metadata` 是结构化扩展字段（透传到 event.metadata 中）
 */
export interface NotificationOptions {
  /**
   * 通知类型（必填）
   *
   * 推荐使用下划线分隔的 snake_case，例如：
   * - "visualization_ready"
   * - "task_completed"
   * - "report_uploaded"
   */
  type: string;

  /** 通知标题 */
  title: string;

  /** 通知内容（人类可读文本，可包含 markdown） */
  content: string;

  /** 额外元数据（透传到 event.metadata） */
  metadata?: Record<string, unknown>;
}

// ========================================================================
// NotificationSendExtras - PluginComponent 注入的上下文
// ========================================================================

/**
 * PluginComponent 调用 `channel.send(options, extras, envContext)` 时附带的额外信息。
 *
 * PluginChannel 不需要知道是哪个 Plugin 在调用 — extras 提供必要的绑定信息。
 */
export interface NotificationSendExtras {
  /** Plugin 名称（用于 metadata.source = `plugin:<pluginName>`） */
  pluginName: string;

  /**
   * Environment 实例（用于 EventBusNotificationChannel 调用 pushEnvEvent）
   *
   * 在单测场景或某些 PluginContext 下可能为 undefined；EventBusNotificationChannel
   * 应当 silent skip 而不是抛错。
   */
  envInstance?: {
    pushEnvEvent(event: unknown): void;
    [key: string]: unknown;
  };
}

// ========================================================================
// NotificationChannel - 通道接口
// ========================================================================

/**
 * Notification Channel - Plugin 通知通道抽象
 *
 * PluginComponent 按 channels 数组顺序选第一个 `canRoute() === true` 的通道。
 * 如果所有通道都返回 false，则通知被丢弃（log warn）。
 */
export interface NotificationChannel {
  /** 通道名称（log / debug 用） */
  readonly name: string;

  /**
   * 当前 channel 是否能处理这条通知
   *
   * @param options 通知选项
   * @param extras PluginComponent 注入的上下文
   * @param envContext 当前 ALS 中的 EnvContext（可能为空）
   */
  canRoute(
    options: NotificationOptions,
    extras: NotificationSendExtras,
    envContext: EnvContextLike
  ): boolean;

  /**
   * 发送通知
   *
   * - 实现方负责 swallow 内部异常，避免污染 Plugin 主流程
   * - 应当支持并发调用（不同 Plugin 异步触发）
   *
   * @param options 通知选项
   * @param extras PluginComponent 注入的上下文
   * @param envContext 当前 ALS 中的 EnvContext（可能为空）
   */
  send(
    options: NotificationOptions,
    extras: NotificationSendExtras,
    envContext: EnvContextLike
  ): Promise<void>;
}
