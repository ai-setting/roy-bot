/**
 * EventSource 类型定义
 * 
 * 定义事件源组件的类型、接口和状态
 * 
 * 设计原则：
 * 1. EventSourceType 开放为 string，支持任意第三方类型
 * 2. 通过 Handler 注册机制扩展，而非硬编码类型
 * 3. 事件统一使用 EnvEvent<EventSourceEventPayload>
 */

import type { EnvEvent } from "../types";
import type { PersistedEvent, TriggerEventInput } from "./event-store";

export type {
  PersistedEvent,
  TriggerEventInput,
  TriggerEventMetadata,
} from "./event-store";

// ============================================================================
// 类型别名
// ============================================================================

/**
 * EventSource 状态
 */
export type EventSourceStatus = 
  | "created"    // 已创建
  | "starting"   // 启动中
  | "running"    // 运行中
  | "stopping"   // 停止中
  | "stopped"    // 已停止
  | "error";     // 错误状态

/**
 * EventSource 类型
 * 
 * 开放类型，任何字符串都可以作为类型
 * 内置类型：lark-cli, websocket, timer, http-webhook, file-watcher
 */
export type EventSourceType = string;

// ============================================================================
// 内置类型常量
// ============================================================================

/**
 * 内置事件源类型
 */
export const BUILT_IN_EVENT_SOURCE_TYPES = {
  LARK_CLI: "lark-cli",
  TIMER: "timer",
  BOUNTY_IM: "bounty-im",
  /**
   * ★ Task #4568：CLI 命令行入口也是事件源。
   *
   * 与其它三者不同，它**不消费外部流** —— "事件"就是用户在终端敲下的
   * 每一行 query，由 cli 包的 `emitCliTriggerEvent()` 主动落库。
   *
   * 存在的意义：让 `getHandlerForEsType('cli-command')` 能分派到
   * `cliCommandHandler.buildNotifyHandlePrompt()`，从而给 agent 一个
   * 「CLI 没有 IM 通道，输出到 stdout」的 prompt（而不是套用飞书模板）。
   */
  CLI_COMMAND: "cli-command",
  /**
   * ★ Task #5142：企业微信（WeCom）也是一个事件源。
   *
   * 走企微官方 CLI `wecom-cli`（npm: `@wecom/cli`）。
   *
   * ⚠️ **必须是新类型名 `wecom-cli`，不能抄 `lark-cli`**：
   * `getHandlerForEsType(esType)` 是 v2 notify prompt 的唯一分派 key，
   * 抄成 lark-cli 会让 agent 拿到「用 lark-cli 发到 oc_xxx」的 prompt，
   * 而企微根本没有 oc_xxx。
   */
  WECOM_CLI: "wecom-cli",
} as const;

/**
 * 内置事件源类型列表
 */
export const BUILT_IN_EVENT_SOURCE_TYPE_LIST = Object.values(BUILT_IN_EVENT_SOURCE_TYPES);

// ============================================================================
// 接口定义
// ============================================================================

/**
 * HandleRuleConfig
 * 
 * 事件处理规则配置
 */
export interface HandleRuleConfig {
  /** 处理事件的 agent 名称（可选，默认使用 default） */
  agent?: string;

  /** 启用的插件列表（可选） */
  plugins?: string[];

  /**
   * ★ Per-plugin 配置（key=pluginName，value=plugin config）
   *
   * 用途：让用户在 eventsource config 里为特定 plugin 提供配置，
   * 而不需要写代码 / 改默认行为。
   *
   * 典型用途：
   * - PerTaskGroupChatPlugin.inviteUserIds: 动态邀请列表，可含 "sender"
   *   占位符从 replyChannel 自动推导（Task #3945 方案 A）。
   *   默认 ["sender"]，适合 lark-cli 事件驱动场景。
   * - PerTaskGroupChatPlugin.defaultInviteUserIds: 静态邀请列表，
   *   始终邀请（如 admin / 共享账号），不接受占位符（Task #3987）。
   *   适合多 event-source 共享"必邀请"用户时集中配置。
   *
   * ★ 注意：飞书 user open_id 是 per-app 隔离的，列表里的 open_id 必须属于
   *   当前 lark-cli profile 对应的 app，否则 lark-cli 报 99992361
   *   "open_id cross app"。
   *
   * 示例：
   * ```json
   * {
   *   "handleRule": {
   *     "plugins": ["LarkCliTaskNotifyPlugin", "PerTaskGroupChatPlugin"],
   *     "pluginConfig": {
   *       "PerTaskGroupChatPlugin": {
   *         "defaultInviteUserIds": ["ou_admin_xxx"],
   *         "inviteUserIds": ["sender"]
   *       }
   *     }
   *   }
   * }
   * ```
   */
  pluginConfig?: Record<string, Record<string, unknown>>;
}

/**
 * EventSource 配置
 */
export interface EventSourceConfig {
  /** 事件源 ID */
  id: string;
  /** 事件源名称 */
  name: string;
  /** 事件源类型 */
  type: EventSourceType;
  /** 是否启用 */
  enabled: boolean;
  /** 事件类型过滤（支持通配符） */
  eventTypes?: string[];
  /**
   * ★ Task #4339：要消费的 lark-cli EventKey 列表（lark-cli 类型用）。
   *
   * 背景：lark-cli `event consume` **只接受恰好一个** EventKey —— 逗号多 key
   * （`k1,k2`）和通配符（`im.*`）都会 `unknown EventKey` 直接 exit 2。
   * 想"同时监听普通消息 + 卡片按钮"就必须配置多个 key：
   *
   * ```json
   * { "type": "lark-cli", "profile": "tongzhuli",
   *   "eventKeys": ["im.message.receive_v1", "card.action.trigger"] }
   * ```
   *
   * 实现上 = **一个 key 一个 consume 子进程**，共享同一个 lark-cli bus daemon。
   * 不配置时退化为默认单 key `["im.message.receive_v1"]`（向后兼容）。
   *
   * ⚠️ `card.action.trigger` 还必须在飞书开发者后台「事件与回调 → 回调配置」
   *    里手动开启，否则 consumer 能 ready 但永远收不到事件。
   */
  eventKeys?: string[];
  /**
   * ★ Task #5360（补充需求 2026-11-11 20:54）：是否推送「状态通知文本消息」。
   *
   * ## 背景
   *
   * 卡片化改造后，rule-based 直发的状态文本（`⏱️ 后台任务运行中 20m` /
   * `✅ 已完成 36m`）默认下线，改由任务卡片承载。本开关是**逃生舱**：
   * 保留旧的文本推送能力，用户想恢复时一行配置即可，不必 revert 代码。
   *
   * ## 取值
   *
   * - `false` / **缺省**（默认）：不发状态通知文本 —— 全部走卡片
   * - `true`：逐字恢复改造前的文本推送行为
   *
   * ## 边界（很重要，别扩大语义）
   *
   * - 只影响「状态通知文本」，**不影响卡片**（卡片是渠道独立插件，与本开关正交）
   * - 不影响 `sink === "stdout"` 的 CLI 本地输出（本地没有卡片可发，
   *   文本是唯一可见输出 —— 见 `shouldDeliverNoticeText` 的 stdout 例外）
   * - 不影响卡片失败兜底 markdown 与失败回执（那是**降级/异常告知**，不是状态通知）
   *
   * ## 类型严格性
   *
   * 判定处一律用 `=== true`，所以手改 JSON 写出 `"true"`（字符串）/ `1` /
   * `null` 都会被当成 `false` —— 防 YAML/手改造成的类型漂移。
   */
  statusNotifications?: boolean;
  /** 轮询间隔（毫秒，定时器用） */
  interval?: number;
  /** cron 表达式（定时器用） */
  cron?: string;
  /** 命令参数（lark-cli 用） */
  command?: string;
  /**
   * lark-cli profile 名称（lark-cli 类型用）
   *
   * 用于多 appId 场景：每个 event-source 可对应不同的 lark-cli profile，
   * 启动时用 `lark-cli --profile <name> event consume ...`，
   * 收到消息后用 `lark-cli --profile <name> im +messages-reply ...` 回复。
   *
   * 飞书 openId/chatId 是 per-app 隔离的，错误的 profile 会导致
   * `open_id cross app` 错误（错误码 99992361）。
   *
   * 不设置时使用 lark-cli 的 active profile（默认行为）。
   */
  profile?: string;
  /** WebSocket URL */
  url?: string;
  /** WebSocket headers */
  headers?: Record<string, string>;
  /** 自定义选项 */
  options?: Record<string, unknown>;
  /** 事件处理规则 */
  handleRule?: HandleRuleConfig;
  /**
   * 注入 agent 系统 prompt 的事件源专属 prompt（Phase B.11+）
   *
   * 用于告知 agent 该 event-source 的特定上下文，例如：
   * - bounty-im: "你是 agent X，地址 Y。请用 `bounty com send --endpoint Z -f Y -t ... -b ...` 回复"
   *
   * 当 interactive.ts 调度 env event 到 agent 时，会把 systemPrompt
   * 追加（append）到 agent 已有的 system prompt 之后（不覆盖原 prompt）。
   *
   * 内置 bounty-im handler 在 config.systemPrompt 未设置时使用默认 prompt；
   * 用户可显式覆盖。
   *
   * ★ ES-M1（Task #5144）：lark-cli 渠道在 lean 模式下，未配置本字段时
   * 也会注入渠道静态 prompt（buildLarkChannelSystemPrompt），规则文本
   * 前置到 system prompt；配置了则用户值在前 + 渠道 prompt 在后。
   */
  systemPrompt?: string;
  /**
   * 渠道 prompt 模式（ES-M1，Task #5144；默认 "lean"）
   *
   * - "lean"（默认）：渠道静态回复规则（关键 0/1/2/3、30KB 上限、禁分段、
   *   --as bot、mktemp+jq 模板，~1566 tok）前置注入 system prompt；
   *   per-event recommendedAction 压缩为动态小卡片（action 一句话 +
   *   replyTo 四元组）。
   * - "legacy"：per-source 回退开关 —— 行为与旧版完全一致
   *   （recommendedAction 4.4KB 长模板、无渠道 systemPrompt 注入）。
   *
   * 用途：灰度期如果 sub-agent / 第三方 consumer 依赖
   * `payload.message` 里 JSON 的长模板规则文本，可将该 source
   * 回退为 legacy。
   */
  channelPromptMode?: "legacy" | "lean";
  /**
   * ★ Task #5333 — 该事件源驱动的 agent 会话**额外注入**的工具名列表。
   *
   * 背景（用户 2026-11-11 16:54）：「ES config 支持 extend tools ——
   * 不同 ES 驱动的 agent 注入 tools 可不同。企微 ES 有特有工具
   * （wecom_respond），不该配到 default agent。」
   *
   * 语义：
   * - 只有 `tool.metadata.channelOnly === true` 的工具受本字段控制
   *   （未标记 channelOnly 的工具对所有 agent 本来就可见，无需声明）
   * - 未配置本字段 → 不放行任何 channelOnly 工具
   * - 配置后 → handler 把它写进 `evt.metadata.extendTools`，
   *   经 run.ts / run-headless-dispatch.ts 透传到
   *   `AgentContext.extendTools`，最终由 ToolRegistry / AgentComponent
   *   的可见性过滤放行
   *
   * 内置默认：`wecom-cli` handler 恒注入 `["wecom_respond"]`
   * （企微唯一出站工具，不配也必须可见），用户的 config.extendTools
   * 追加在后并去重。
   *
   * ```json
   * { "type": "wecom-cli", "extendTools": ["my_extra_tool"] }
   * ```
   */
  extendTools?: string[];
  /**
   * ★ Task #5659（方案 C，解决 #5654 跨组织泄漏）— 工具子进程注入的环境变量。
   *
   * 该事件源驱动的 agent 会话中，所有工具子进程（wecom-cli spawn、
   * bash tool）都会合并这些 env（用户显式传的优先级最高）。
   *
   * 典型场景：多企微 bot 隔离凭据目录 ——
   *
   * ```json
   * { "type": "wecom-cli", "options": { "credentialsPath": "..." },
   *   "toolEnv": { "WECOM_CLI_CONFIG_DIR": "~/.config/wecom/bot-2" } }
   * ```
   *
   * 链路：handleEvent 写 evt.metadata.toolEnv → createEnvContext /
   * buildRunEnvContext 写 EnvContext.toolEnv → spawn 处
   * resolveToolEnv 合并。只接受「字符串→字符串」非空对象
   * （normalizeToolEnv 过滤类型漂移）。
   */
  toolEnv?: Record<string, string>;
  /**
   * Agent IM 地址（bounty-im 类型用，格式：agent-id@host）
   *
   * 提升 bounty-im 为内置 handler 后，从 options.address 提到顶级字段（更清晰）。
   * 向后兼容：handler 会优先读顶级，fallback 到 options.address。
   */
  address?: string;
  /**
   * IM Server WebSocket URL（bounty-im 类型用）
   *
   * 提升 bounty-im 为内置 handler 后，从 options.imServerUrl 提到顶级字段（更清晰）。
   * 向后兼容：handler 会优先读顶级，fallback 到 options.imServerUrl。
   */
  imServerUrl?: string;
  /**
   * 是否跳过 TLS 证书校验（bounty-im 类型用，wss:// 自签名场景）
   *
   * 适用场景：k8s ingress 自签名证书 / 内部 CA 证书。
   * 生产环境**不**推荐开启。建议使用合法 CA 证书替代。
   *
   * 实现：handler 启动 WS 时传 `rejectUnauthorized: !tlsSkipVerify` 给 `ws` 库。
   * 当 `imServerUrl` 是 `ws://` 时，该字段被 Node.js 忽略，安全无副作用。
   *
   * 向后兼容：handler 会优先读顶级，fallback 到 options.tlsSkipVerify。
   */
  tlsSkipVerify?: boolean;
  /**
   * Agent IM 注册邮箱（bounty-im 类型用，v0.13 server 协议）
   *
   * v0.13.0 起，bounty server 把"agent identity"从 `<uuid>@<host>` 改为**注册邮箱**：
   * - WS 连接：`ws://host/ws?email=<email>` （v0.13 主路径）
   * - 兼容：fallback 到 `?address=<uuid>@<host>`
   * - com send 命令：`--from-email <email> --to-email <email>`
   *
   * 与 `address` 字段互斥但允许共存（用户配置阶段可同时存在，
   * handler 优先用 email，向后兼容 address）。
   *
   * 添加方式：
   * - `eventsource add ... bounty-im --email alice@bounty.example.com`
   * - `eventsource add ... bounty-im --profile dev-author` (自动从
   *   `~/.config/bounty/profiles/<name>.json` 读取)
   */
  email?: string;
  /** 特定类型的配置参数 */
  [key: string]: unknown;
}

/**
 * 事件元信息
 * 
 * 包含帮助 Agent 决策和回复的关键信息
 */
export interface EventMetadata {
  /** 事件类型，如 im.message.receive_v1 */
  eventType?: string;
  /** 应用 ID */
  appId?: string;
  /** 会话 ID */
  chatId?: string;
  /** 会话类型，如 p2p, group */
  chatType?: string;
  /** 消息 ID */
  messageId?: string;
  /** 消息类型，如 text, image */
  messageType?: string;
  /** 发送者 ID */
  senderId?: string;
  /**
   * 发送者注册邮箱（v0.14.1+ email-display fix）
   *
   * 由 IM WebSocket 入站事件携带的注册邮箱。Server 在 push 时把 canonical
   * `<uuid>@authenticated` 解析成 sender 的注册邮箱下发给 client。
   *
   * - 有此字段 → LLM 看到的是注册邮箱（`user@example.com`）
   * - 无此字段 → fallback 到 `senderId`（canonical 形式）
   *
   * 这一对字段并存是为了向后兼容：依赖 `senderId` 做 routing 的下游组件继续
   * 工作，依赖 `senderEmail` 做展示的 agent 拿到邮箱。
   */
  senderEmail?: string;
  /** 租户 key */
  tenantKey?: string;
  /**
   * ★ Task #5212：lark 引用消息上下文
   *
   * lark-cli `im.message.receive_v1` 事件的引用字段归一化：
   * - rootId:   根消息 id（root_id）
   * - parentId: 直接回复的父消息 id（reply_to / parent_id）
   * - threadId: thread id（thread_id），仅 thread 场景存在
   *
   * 无任何引用字段（普通消息）时为 undefined。
   * agent 据此知道当前消息是对哪条消息的回复。
   */
  replyContext?: {
    rootId?: string;
    parentId?: string;
    threadId?: string;
    /**
     * ★ Task #5251：企微引用内容（quote 内嵌原文归一文本）
     *
     * 企微长连接协议直接内嵌被引用内容（SDK BaseMessage.quote），
     * 无被引用消息 id —— 因此企微侧只有 quotedText，
     * 无 rootId/parentId/threadId（那些是 lark 侧字段）。
     */
    quotedText?: string;
  };
  /**
   * 事件源注入到 agent systemPrompt 的专属 prompt
   *
   * 来源：EventSourceConfig.systemPrompt（默认或用户配置）。
   * interactive.ts 在处理 env event 时会把它追加到 agent 的 system prompt。
   */
  systemPrompt?: string;
  /** 其他原始字段 */
  [key: string]: unknown;
}

/**
 * 推荐动作
 *
 * 告诉 Agent 应该如何处理这个事件
 */
export interface RecommendedAction {
  /** 动作描述 */
  action: string;
  /**
   * ★ ES-M1（Task #5144）：静态规则是否已前置到渠道 system prompt。
   *
   * lean 模式（默认）下 extractMetadata 会置 `true`：
   * 规则文本（关键 0/1/2/3、30KB 上限、禁分段、--as bot、mktemp+jq
   * 模板）不再出现在 `action` 里，而是注入了渠道 system prompt
   * （EventMetadata.systemPrompt）。旧 consumer / 灰度观察者可据此
   * 识别"卡片已瘦身"这一新形态。
   *
   * legacy 模式不设置该字段（保持旧版形态识别）。
   */
  staticRulesInSystemPrompt?: true;
  /**
   * ★ Task #5212（DS review MAJOR-2）：lark 引用消息上下文
   *
   * 当前消息「是对哪条消息的回复」的定位信息（rootId / parentId / threadId）。
   *
   * ⚠️ 为什么挂在 recommendedAction 而不是只挂 metadata：
   *   agent 实际收到的 user message = `payload.message` =
   *   `JSON.stringify({ rawData, recommendedAction, triggerEventId? })`
   *   —— **不含 metadata 键**。只写进 evt.metadata / evt.payload.metadata
   *   的话，agent 读不到任何 parentId 值，需求（「让 agent LLM 看到是对某
   *   消息 id 的回复」）无法闭环。
   *
   * 无引用字段（普通消息）时为 undefined（不产生空对象）。
   */
  replyContext?: {
    rootId?: string;
    parentId?: string;
    threadId?: string;
    /**
     * ★ Task #5251：企微引用内容（quote 内嵌原文归一文本）
     *
     * 企微长连接协议直接内嵌被引用内容（SDK BaseMessage.quote），
     * 无被引用消息 id —— 因此企微侧只有 quotedText，
     * 无 rootId/parentId/threadId（那些是 lark 侧字段）。
     */
    quotedText?: string;
  };
  /** 回复目标（如果有） */
  replyTo?: {
    appId?: string;
    /**
     * lark-cli profile（lark-cli 类型用）
     *
     * 让 LLM 拿到具体的 profile 值用于拼接 lark-cli --profile <name> 命令。
     * 飞书 openId 是 per-app 隔离的，必须用对应 app 的 profile 才能回复成功。
     */
    profile?: string;
    chatId?: string;
    messageId?: string;
  };
  /** 原始回复指令（用于调用事件源 API） */
  rawCommand?: string;
}

/**
 * 反馈通道
 *
 * 告诉 Agent 处理完事件后，如何将结果反馈到事件源
 */
export interface ReplyChannel {
  /** 渠道类型，如 lark-cli, websocket */
  type: string;
  /** 发送目标的 app ID */
  appId?: string;
  /**
   * lark-cli profile（lark-cli 类型用）
   *
   * 多 appId 场景：每个 event-source 对应一个 profile，回复时必须用对应 profile。
   * 错误使用 profile 会导致 `open_id cross app` 错误（错误码 99992361）。
   */
  profile?: string;
  /** 发送目标的会话 ID */
  chatId?: string;
  /** 原始消息 ID（用于回复） */
  messageId?: string;
  /** 原始回复指令 */
  rawCommand?: string;
  /** 其他自定义参数 */
  params?: Record<string, unknown>;
}

/**
 * EventSource 事件负载
 */
export interface EventSourceEventPayload {
  /** 事件源 ID */
  sourceId: string;
  /** 事件源类型 */
  sourceType: EventSourceType;
  /** 原始事件数据 */
  rawEvent: unknown;
  /** 处理后的消息内容 */
  message: string;
  /** 事件元信息（帮助 Agent 决策） */
  metadata: EventMetadata;
  /** 反馈通道：处理完成后如何将结果返回到事件源 */
  replyChannel?: ReplyChannel;
  /** 推荐动作 */
  recommendedAction?: RecommendedAction;
  /** 时间戳 */
  timestamp: number;
  /**
   * Task #4023 + #4025 OC track #2 改进：父 task ID
   *
   * 群消息处理时由 event-source-handlers.handleEvent 查询 chat↔task binding
   * 后填入。下游 consumer（task_create tool 等）可读此字段作为
   * `parent_task_id`，自动建立任务树而无需显式 root task 爆炸。
   *
   * - 数字 > 0：合法 task id
   * - undefined：消息无 chat↔task binding 或无 SessionComponent 注入
   *
   * 设计决策：保留 A 轨道的 0/负数 fail-fast（consumer 负责校验），与 B 轨道的
   * 透传哲学略有不同——我们优先 fail-fast 安全性。
   */
  parentTaskId?: number;
  /**
   * Task #4042 ESPlugin v2：EventStore trigger event ID。
   *
   * 生产端（LarkCliInstance.handleEvent）落库原始 event 后写入，
   * 供主 agent 透传给 delegate_task(triggerEventId=...)，最终由 notify event
   * 反查原始 chatId。
   */
  triggerEventId?: string;
  /**
   * Task #5199：已落盘媒体文件的本地路径（image/file/video/voice）。
   *
   * WecomCliInstance.handleWsFrame 异步下载解密后写入；
   * agent 用 understand_image(image_source=<path>) 读图。
   */
  mediaFiles?: string[];
}

/**
 * EventSource 事件
 * 
 * 统一使用 EnvEvent，payload 为 EventSourceEventPayload
 */
export type EventSourceEvent = EnvEvent<EventSourceEventPayload>;

/**
 * EventSource 事件处理器
 * 
 * handler 返回值用于：
 * - string: 作为回复内容发送给事件源（如 Lark 消息）
 * - undefined/void: 不回复
 */
export type EventSourceEventHandler = (event: EventSourceEvent) => string | undefined | void | Promise<void | string>;

/**
 * EventSource 状态变更事件
 */
export interface EventSourceStatusChangeEvent {
  /** 事件源 ID */
  sourceId: string;
  /** 事件源类型 */
  sourceType: EventSourceType;
  /** 旧状态 */
  oldStatus: EventSourceStatus;
  /** 新状态 */
  newStatus: EventSourceStatus;
  /** 错误信息（如果有） */
  error?: string;
}

/**
 * EventSource 持久化配置
 */
export interface EventSourcePersistenceConfig {
  /** 版本 */
  version: string;
  /** 事件源列表 */
  sources: EventSourceConfig[];
}

// ============================================================================
// EventSourceHandler 接口（核心扩展机制）
// ============================================================================

/**
 * EventSourceInstance
 * 
 * 事件源实例接口，由 Handler.createInstance() 创建
 * 每个实例对应一个运行中的事件源
 */
export interface EventSourceInstance {
  /**
   * 启动事件源
   */
  start(): Promise<void>;

  /**
   * 停止事件源
   */
  stop(): Promise<void>;

  /**
   * 获取当前状态
   */
  getStatus(): EventSourceStatus;

  /**
   * 注册事件处理器
   *
   * @param handler 事件处理函数
   */
  onEvent(handler: EventSourceEventHandler): void;

  /**
   * 取消注册事件处理器
   */
  offEvent(): void;

  /**
   * 注入 Environment 引用（可选，由 EventSourceComponent.startSource 调用）
   *
   * 实现本方法后，instance 可以在 plugin 注册时通过 env.getComponent('task')
   * 拿到 taskComponent，用于给支持 setTaskUpdater 的 plugin（如 PerTaskGroupChatPlugin）
   * 注入 DB 持久化回调。
   *
   * 不实现此方法的实例（第三方 handler）不会拿到 env，setTaskUpdater 也不会被注入，
   * 行为与之前完全一致（向后兼容）。
   *
   * @param env Environment 实例引用
   */
  setEnvironment?(env: unknown): void;
}

/**
 * EventSourceHandler
 * 
 * 事件源处理器接口，用于实现特定类型的事件源
 * 
 * 第三方可以通过实现此接口来添加新的事件源类型
 * 
 * @example
 * ```typescript
 * const myHandler: EventSourceHandler = {
 *   type: "my-source",
 *   validateConfig: (config) => {
 *     const errors: string[] = [];
 *     if (!config.url) errors.push("url is required");
 *     return errors;
 *   },
 *   createInstance: (config) => new MySourceInstance(config),
 * };
 * 
 * // 注册到 EventSourceComponent
 * component.registerHandler(myHandler);
 * ```
 */
export interface EventSourceHandler {
  /**
   * 事件源类型标识
   */
  readonly type: string;
  
  /**
   * 验证配置
   * 
   * @param config 事件源配置
   * @returns 错误列表，无错误时返回空数组
   */
  validateConfig(config: EventSourceConfig): string[];
  
  /**
   * 创建事件源实例
   * 
   * @param config 事件源配置
   * @returns 事件源实例
   */
  createInstance(config: EventSourceConfig): EventSourceInstance;
  
  /**
   * 获取该类型支持的选项列表（可选）
   * 
   * 用于 CLI 命令的选项提示
   */
  getOptions?(): {
    name: string;
    description: string;
    required: boolean;
    type: "string" | "number" | "boolean";
  }[];

  // ========================================================================
  // ESPlugin v2 (Task #4042 Phase 3) — 4 个新方法
  // ========================================================================

  /**
   * 持久化 trigger event 并返回 triggerEventId。
   *
   * 当 ES 收到原始 event（飞书消息 / bounty-im 消息 / cron tick）时调用，
   * handler 负责把它存到 EventStore 并返回 triggerEventId。
   * 该 ID 之后会通过 BackgroundTaskManager.triggerEventId 透传给 sub-agent，
   * sub-agent 完成后再透传给 CLI event-handler 用于反查 EventStore。
   *
   * 不实现时 ES plugin 仍可用，但不参与 trigger event 透传链路
   * （CLI event-handler 走 fallback 路径）。
   */
  emitTriggerEvent?(
    payload: TriggerEventInput,
    store: EventStore,
  ): Promise<string>;

  /**
   * 把消息回复到 ES 原始渠道。
   *
   * @example lark-cli 实现：spawn `lark-cli im +messages-reply --message-id <X> --chat-id <Y> --content ...`
   * @example bounty-im 实现：调 bounty server sendMessage API
   */
  replyMessage?(input: ReplyMessageInput): Promise<ReplyMessageResult>;

  /**
   * 从 PersistedEvent 提取回复所需的最小上下文。
   *
   * 不同 ES 字段名不同（lark-cli 用 chatId / messageId；bounty-im 用 endpoint / address），
   * handler 负责统一抽象成 ReplyContext。
   *
   * @param event   从 EventStore 反查到的原始 trigger event
   * @param profile 当前 EventSource 的 profile（lark-cli 多 appId 场景必需）。
   *                handler 实现应优先用它，fallback 到 event.metadata.profile。
   */
  extractReplyContext?(event: PersistedEvent, profile?: string): ReplyContext;

  /**
   * 构造主 agent 处理 notify event 的 prompt。
   *
   * 当 BackgroundTaskManager 发出 task.background.completed / failed 等 notify event 时，
   * 主 agent 会调 handler.buildNotifyHandlePrompt 拿到 promptText + systemHint，
   * 注入到主 agent query 里告诉它如何回复（用哪个 chatId / 用哪个工具）。
   *
   * ★ 关键：这是修复 #4035 / #4038 / #4039 "完成消息发错群" bug 的核心。
   *   buildNotifyHandlePrompt 必须从 triggerEvent 反查 ES info，
   *   而不是从 metadata.replyChannel / lastReplyChannel 拿。
   */
  buildNotifyHandlePrompt?(
    input: BuildNotifyHandlePromptInput,
  ): BuildNotifyHandlePromptResult;

  /**
   * notify event 走完 buildNotifyHandlePrompt 之后的后处理钩子。
   *
   * 用途：让 ES 决定要不要在主 agent 处理之外，再额外把消息同步到其它渠道
   * （如 lark-cli 把 formattedPrompt 同步到所有 per-task 群聊）。
   *
   * 调用契约（实现方必须遵守）：
   *   - 返回 Promise<void>，**永不抛**（fire-and-forget）
   *   - 同步内容用 formattedPrompt（已 buildNotifyHandlePrompt 生成）
   *   - 多候选都同步（不只第一个）
   *
   * 不实现时：主 agent 处理链路完全不变（向后兼容）。
   *
   * Task #4042 ESPlugin v2 Phase 7
   */
  postProcessNotifyEvent?(
    input: PostProcessNotifyEventInput,
  ): Promise<void>;

  /**
   * 注入运行时依赖（测试用）：lark-cliRunner / eventStore 等。
   *
   * 默认实现：什么都不做（handler 自己用真实依赖）。
   * 测试时：注入 mock runner / in-memory store。
   */
  setRunner?(runner: LarkCliRunner): void;
}

// ============================================================================
// ESPlugin v2 (Task #4042) — 数据结构
// ============================================================================

/**
 * EventStore 接口（event-store.ts 实现的接口再次导出，
 * 让 EventSourceHandler 引用时不形成循环依赖）。
 */
export interface EventStore {
  insertTriggerEvent(input: TriggerEventInput, esType: string): Promise<string>;
  getEventById(eventId: string): Promise<PersistedEvent | null>;
  getRecentEvents(
    esType: string,
    senderId: string,
    limit: number,
  ): Promise<PersistedEvent[]>;
}

/**
 * 回复消息输入
 */
export interface ReplyMessageInput {
  /** 原始消息 ID（用于 im +messages-reply 关联） */
  messageId: string;
  /** chat ID（lark-cli / lark / webhook 等） */
  chatId: string;
  /** 消息文本（已渲染好，可含 @mention 节点） */
  content: string;
  /** lark-cli profile（多 appId 场景） */
  profile?: string;
  /** 其他 ES-specific 参数（如 msg-type） */
  msgType?: "text" | "post" | "card";
}

/**
 * 回复消息结果
 */
export interface ReplyMessageResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * 回复上下文（从 PersistedEvent 提取的最小 ES info 集合）
 */
export interface ReplyContext {
  esType: string;
  chatId: string;
  messageId: string;
  senderOpenId: string;
  tenantKey?: string;
  /** lark-cli profile（用于 im +messages-reply --profile） */
  profile?: string;
}

/**
 * 触发渠道信息（渠道无关的最小集合）。
 *
 * 由 CLI EventHandler 从 trigger event + handler.extractReplyContext 解析后
 * 传给 buildNotifyHandlePrompt，让 prompt 能按**真实渠道**渲染：
 *   - 渠道类型（lark-cli / bounty-im / timer / ...）
 *   - 群 ID / 群聊还是私聊
 *   - 触发消息 ID、发送者、profile
 *
 * ★ 为什么不让每个 handler 自己从 triggerEvent 里抠字段：
 *   bounty-im 用 from/to 邮箱、lark 用 chatId/messageId，字段名完全不同；
 *   统一在这里归一化，handler 只负责渲染「怎么发」。
 */
export interface NotifyChannelInfo {
  /** EventSource 类型（lark-cli / bounty-im / timer / ...） */
  esType: string;
  /** 回复目标会话 ID（飞书为 oc_xxx） */
  chatId?: string;
  /** 群聊 / 私聊 / 未知（飞书 trigger event metadata.chatType） */
  chatType?: "group" | "p2p" | "unknown";
  /** 触发消息 ID（飞书为 om_xxx）；reply 这条可保持话题线索 */
  messageId?: string;
  /** 触发者 ID（飞书为 ou_xxx） */
  senderId?: string;
  /** 多 appId 场景的 lark-cli profile */
  profile?: string;
  /** 回复方式：reply=回复触发消息 / send=新消息 / none=无可用通道 */
  replyKind?: "reply" | "send" | "none";
}

/**
 * 规则化回执（rule-based direct notice）的投递结果。
 *
 * 终态事件（completed / timeout）在进 lane 之前，会先用 telemetry 同一套
 * 发送器直发一条**保底**消息到触发群；这里把「发没发出去」如实带给主 agent，
 * 避免 prompt 谎称「已发送」而 agent 又重复/遗漏关键信息。
 */
export interface RuleNoticeInfo {
  /** 是否尝试过直发（false = 该事件类型不在规则回执白名单） */
  attempted: boolean;
  /** 是否确实送到群里 */
  delivered: boolean;
  chatId?: string;
  /** 实际发出的文案（送达时带，便于 prompt 里告知「回执已经说了什么」） */
  text?: string;
  /** 送达时刻（epoch ms） */
  sentAt?: number;
  /** 失败原因（未送达时带） */
  error?: string;
}

/**
 * buildNotifyHandlePrompt 输入
 */
export interface BuildNotifyHandlePromptInput {
  /** 通知事件（来自 BackgroundTaskManager） */
  notifyEvent: {
    type: string;
    taskId?: number;
    description?: string;
    result?: string;
    error?: string;
    /**
     * 子 session ID —— 超时 / 失败后如需**续跑**，主 agent 可直接
     * `delegate_task(sub_session_id="<此值>", ...)` 让子代理继承历史继续推进，
     * 不必从零重来。
     */
    subSessionId?: string;
    /**
     * ★ Task #4568：后台进程 ID（形如 `process_1793101794979_dyvi6vhxx`）。
     *
     * 用途：`taskId` 是「sub-agent 自己 task_create 过才有」的业务任务号，
     * 很多后台任务没有它。此时 prompt 需要一个可辨识的标签，否则只能渲染
     * `Task #?`（真机验证发现的显示缺陷）。CLI handler 用它生成
     * `后台任务 dyvi6vhxx`。
     */
    backgroundTaskId?: string;
  };
  /** 触发整个 delegate_task 的原始 event（从 EventStore 反查） */
  triggerEvent: PersistedEvent;
  /** sub-agent 输出摘要 */
  subAgentResult: {
    summary: string;
    detail?: string;
  };
  /**
   * 当前 EventSource 的 lark-cli profile（多 appId 场景）。
   * 有值时 buildNotifyHandlePrompt 会把 profile 透传给 extractReplyContext，
   * 让主 agent 拿到的回复命令带上正确的 `--profile`。
   */
  profile?: string;
  /**
   * 触发渠道信息（渠道无关，由调用方归一化后传入）。
   *
   * 缺省时 handler 自行从 triggerEvent 反查（向后兼容）。
   */
  channel?: NotifyChannelInfo;
  /**
   * 规则化回执的投递结果。
   *
   * 缺省 = 本事件不直发回执（如 failed / stopped / ask_user），
   * prompt 需要引导 agent 把结果完整讲清楚。
   */
  ruleNotice?: RuleNoticeInfo;
}

/**
 * buildNotifyHandlePrompt 输出
 */
export interface BuildNotifyHandlePromptResult {
  /** 注入主 agent query 的文本 */
  promptText: string;
  /** 注入主 agent system hint 的简短提示 */
  systemHint: string;
}

/**
 * postProcessNotifyEvent 输入（ESPlugin v2 第 7 能力 — Task #4042 Phase 7）
 *
 * notify event 走完 buildNotifyHandlePrompt 之后，让 ES 决定要不要额外
 * "后处理"。典型场景：lark-cli handler 把同一条消息同步到多个 per-task 群。
 *
 * 设计要点：
 *   - fire-and-forget：失败不阻主 agent
 *   - 同步内容用 formattedPrompt（用户看到的 = 主 agent 看到的）
 *   - 多候选都同步（不只第一个）
 */
export interface PostProcessNotifyEventInput {
  /** 通知事件（来自 BackgroundTaskManager） */
  notifyEvent: {
    type: string;
    taskId?: number;
    description?: string;
    result?: string;
    error?: string;
  };
  /** 触发整个 delegate_task 的原始 event（从 EventStore 反查） */
  triggerEvent: PersistedEvent;
  /** sub-agent 输出摘要 */
  subAgentResult: {
    summary: string;
    detail?: string;
  };
  /** 已经 buildNotifyHandlePrompt 生成的格式化文本（同步内容用） */
  formattedPrompt: string;
  /** 当前 lark-cli profile（透传） */
  profile?: string;
  /**
   * ★ Bug #4035/#4038/#4039 修复：精确投递目标 chat_id 列表（唯一投递来源）。
   *
   * 由调用方（CLI EventHandler）从权威 task↔chat 绑定解析：
   * `task.context.larkPerTaskChatId`（PerTaskGroupChatPlugin 建群时写入）。
   *
   * 语义：
   *   - 有值（含空数组）→ 只投递到这些 chat（去重）。
   *   - 未传 / 空数组 → **不投递**（skip mirror）。
   *
   * 旧的 `chat-search "Task <id>"` 模糊群名匹配已移除：它会把标题里恰好含该
   * 数字的无关群也命中（例：#4039 验证群标题含 "#4035" → 收到 #4035 的完成
   * 通知），是跨群串扰的根因。精确绑定才能根治。
   */
  resolvedChatIds?: string[];
}

/**
 * lark-cli Runner 抽象（spawn lark-cli 子进程）
 *
 * 测试时可注入 mock runner；生产环境用真实 spawn。
 */
export interface LarkCliRunner {
  run(command: string): Promise<{
    stdout: string;
    stderr: string;
    code: number;
  }>;
}

/**
 * 默认 LarkCliRunner（spawn lark-cli 二进制）
 */
export const defaultLarkCliRunner: LarkCliRunner = {
  async run(command: string) {
    // dynamic import to avoid pulling bun:child_process into node test bundles
    const { spawn } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      const proc = spawn("sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d) => (stdout += d.toString()));
      proc.stderr.on("data", (d) => (stderr += d.toString()));
      proc.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
      proc.on("error", reject);
    });
  },
};

// ============================================================================
// EventSourceInitHook（扩展钩子）
// ============================================================================

/**
 * EventSource 初始化钩子
 * 
 * 类似于 prompt hooks，在 EventSourceComponent 初始化时调用
 * 用于第三方注册自定义的 Handler
 * 
 * @example
 * ```typescript
 * EventSourceInitHooks.register("my-handler", async (component) => {
 *   component.registerHandler(myHandler);
 * });
 * ```
 */
export interface EventSourceInitHook {
  /**
   * 钩子名称（可选，用于调试）
   */
  name?: string;
  
  /**
   * 钩子执行函数
   * 
   * @param component EventSourceComponent 实例
   */
  (component: EventSourceComponentInterface): Promise<void>;
}

/**
 * EventSourceInitHooks
 * 
 * 全局事件源初始化钩子注册表
 */
export class EventSourceInitHooks {
  private static hooks: Map<string, EventSourceInitHook> = new Map();
  
  /**
   * 注册初始化钩子
   * 
   * @param name 钩子名称（通常使用 handler 类型名）
   * @param hook 钩子函数
   */
  static register(name: string, hook: EventSourceInitHook): void {
    this.hooks.set(name, hook);
  }
  
  /**
   * 移除初始化钩子
   * 
   * @param name 钩子名称
   */
  static unregister(name: string): void {
    this.hooks.delete(name);
  }
  
  /**
   * 获取已注册的钩子
   * 
   * @returns 钩子列表
   */
  static list(): Map<string, EventSourceInitHook> {
    return new Map(this.hooks);
  }
  
  /**
   * 执行所有钩子
   * 
   * @param component EventSourceComponent 实例
   */
  static async execute(component: EventSourceComponentInterface): Promise<void> {
    for (const [name, hook] of this.hooks) {
      try {
        await hook(component);
      } catch (error) {
        // 使用 bun 的 console 确保在测试环境中也能输出
        process.stderr.write(`[EventSourceInitHooks] Failed to execute hook "${name}": ${error}\n`);
      }
    }
  }
  
  /**
   * 清空所有钩子（主要用于测试）
   */
  static clear(): void {
    this.hooks.clear();
  }
}

// ============================================================================
// EventSourceComponentInterface
// ============================================================================

/**
 * EventSourceComponent 接口
 * 
 * 定义事件源组件的公共方法
 */
export interface EventSourceComponentInterface {
  /** 组件名称 */
  readonly name: string;
  /** 组件版本 */
  readonly version: string;

  // 组件生命周期（Component 接口）
  init(config?: unknown): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  getStatus(): unknown;

  // 事件源管理
  register(config: EventSourceConfig): void;
  unregister(id: string): boolean;
  get(id: string): EventSourceConfig | undefined;
  list(): EventSourceConfig[];
  // 事件源状态（方法重载）
  getStatus(): unknown;
  getStatus(id: string): EventSourceStatus | undefined;
  getEventSourceStatus(id: string): EventSourceStatus | undefined;
  startSource(id: string): Promise<void>;
  stopSource(id: string): Promise<void>;
  update(id: string, partial: Partial<EventSourceConfig>): Promise<unknown>;
  onEvent(id: string, handler: EventSourceEventHandler): void;
  offEvent(id: string): void;
  
  // Handler 注册（扩展机制）
  registerHandler(handler: EventSourceHandler): void;
  unregisterHandler(type: string): boolean;
  getHandler(type: string): EventSourceHandler | undefined;
  listHandlers(): EventSourceHandler[];
}

// ============================================================================
// EventSourceAgentHandler 配置
// ============================================================================

/**
 * EventSourceAgentHandler 配置
 */
export interface EventSourceAgentHandlerConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 前缀（用于区分事件消息） */
  prefix?: string;
  /** 是否包含原始事件 */
  includeRawEvent?: boolean;
  /** 是否包含时间戳 */
  includeTimestamp?: boolean;
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 检查是否为有效的内置事件源类型
 */
export function isBuiltInEventSourceType(type: string): boolean {
  return BUILT_IN_EVENT_SOURCE_TYPE_LIST.includes(type as any);
}

/**
 * 检查是否为有效的事件源类型（兼容旧 API）
 * @deprecated 使用 isBuiltInEventSourceType 代替
 */
export function isValidEventSourceType(type: string): boolean {
  return isBuiltInEventSourceType(type);
}

/**
 * 获取事件源类型的默认配置
 */
export function getDefaultConfigForType(type: string): Partial<EventSourceConfig> {
  switch (type) {
    case BUILT_IN_EVENT_SOURCE_TYPES.LARK_CLI:
      return { command: "lark-cli event consume im.message.receive_v1 --as bot" };
    // ★ Task #5142：企微默认走官方 CLI 的长连接消费模式。
    //   ⚠️ Phase 1 骨架阶段该子命令可能尚未存在 —— 此时 handler 会**优雅降级**
    //   （状态 error + 明确报错），不会 crash。
    case BUILT_IN_EVENT_SOURCE_TYPES.WECOM_CLI:
      return { command: "wecom-cli event consume" };
    default:
      return {};
  }
}

/**
 * 验证事件源配置（通用验证 + Handler 特定验证）
 */
export function validateEventSourceConfig(
  config: EventSourceConfig,
  handler?: EventSourceHandler
): string[] {
  const errors: string[] = [];

  if (!config.id) {
    errors.push("EventSource ID is required");
  }

  if (!config.name) {
    errors.push("EventSource name is required");
  }

  if (!config.type) {
    errors.push("EventSource type is required");
  }

  // 如果提供了 Handler，使用 Handler 的验证逻辑
  if (handler) {
    const handlerErrors = handler.validateConfig(config);
    errors.push(...handlerErrors);
  }

  return errors;
}
