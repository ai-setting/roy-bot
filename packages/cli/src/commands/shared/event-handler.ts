/**
 * @fileoverview Event Handler
 * 
 * 管理环境事件的订阅、队列和处理。
 * 
 * 支持 Event Source Shared Session：
 * - 多个事件源（bounty-im, lark-cli）的事件处理共享同一个 session
 * - 处理队列时创建 session，队列清空后清除
 * - 下一批事件到达时创建新 session
 */

import type { BaseEnvironment, EnvEvent, SessionComponent } from "@ai-setting/roy-bot-core";
import {
  type EnvContext,
  getEnvContext,
  runWithEnvContextAsync,
} from "@ai-setting/roy-bot-core/env";
import {
  EventMessageFormatter,
  type FormattedEvent,
} from "./event-message-formatter";
import { TracedAs } from "@ai-setting/roy-bot-core";
import type {
  EventStore,
  EventSourceHandler,
  NotifyChannelInfo,
  PersistedEvent,
  RuleNoticeInfo,
} from "@ai-setting/roy-bot-core";
// Task #4418: React 中断必须反馈到飞书（规则表 + 去重，见 core/env/error-reply.ts）
import { notifyReactFailure } from "@ai-setting/roy-bot-core/env/error-reply";
// ★ Task #4568：识别 `cli:<sid>` 合成 chatId（不是真实飞书会话）
import { parseCliSessionChatId } from "@ai-setting/roy-bot-core/env/event-source/cli-command-handler";
// ★ Task #4552 (A1): 后台任务 telemetry 事件降级为纯 IM 直发（不进 lane / 不跑 agent）
// ★ 终态规则回执（completed / timeout）：同一套发送器，发完**继续**跑 agent
import {
  buildTelemetryNoticeText,
  buildTerminalNoticeText,
  deriveNoticeIdempotencyKey,
  deriveRuleNoticeIdempotencyKey,
  deriveTelemetryIdempotencyKey,
  isRuleNoticeEvent,
  isSessionLifecycleEvent,
  isTelemetryEvent,
  shouldDeliverNoticeText,
  DEFAULT_NOTICE_TEXT_DELIVERY,
  sendLarkChatMarkdown,
  targetFromEventMetadata,
  targetFromTriggerEvent,
  type NoticeTextDelivery,
  type TelemetryNoticeTarget,
} from "./telemetry-notice";
// ★ Task #4552 (A1 BLOCKING): 自我保护 —— 忽略「我方 bot 自己发出」的回声事件
import {
  isSelfEchoEvent,
  readSelfEchoFilterEnabled,
} from "./self-echo-filter";

/**
 * 从 task.context JSON 解析 PerTaskGroupChatPlugin 写入的群 id（Task #3945）。
 *
 * 这是 notify 精确投递的权威来源（Bug #4035/#4038/#4039）：不依赖群名模糊搜索。
 * 解析失败 / 字段缺失 → undefined。
 */
function parseLarkPerTaskChatId(contextJson?: string): string | undefined {
  if (!contextJson) return undefined;
  try {
    const obj = JSON.parse(contextJson) as Record<string, unknown>;
    const id = obj?.larkPerTaskChatId;
    return typeof id === "string" && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * ESPlugin v2 notify 路径的事件白名单（Bug A / #4105 修复）。
 *
 * 只有"终态结果"事件才走 v2 notify prompt
 * （buildNotifyHandlePrompt 会引导主 agent 回复 trigger 群）。
 *
 * 明确排除：
 *   - `task.background.started` / `task.background.progress`：中间态 telemetry。
 *     若走 v2，会被 buildNotifyHandlePrompt 渲染成 "Sub-agent 完成了…"
 *     （历史 bug：该模板对一切 task.background.* 硬编码"完成"），
 *     导致主 agent 误判任务已完成、提前回复用户。二者回落老 formatter，
 *     分别渲染为"已启动"/"还在进行中"。
 *   - `task.background.ask_user`：需要渲染 query + rule-based hints（老 formatter
 *     formatTaskAskUser），v2 prompt 只透传 result/error 会丢失问题正文。
 */
const NOTIFY_V2_TERMINAL_TYPES: ReadonlySet<string> = new Set([
  "task.background.completed",
  "task.background.failed",
  "task.background.timeout",
  "task.background.stopped",
]);

// ============================================================================
// ★ Task #5062：积压秒级 ack（rule-based 直发，不走 agent 主循环）
// ============================================================================

/**
 * 飞书 lark-cli 事件源的 EnvEvent.type。
 *
 * 注意：**真实**事件类型（`im.message.receive_v1` / `card.action.trigger` …）
 * 不在这个字段上，而在 `metadata.sourceMessageType`。
 */
const LARK_CLI_EVENT_TYPE = "event-source.event.lark-cli";

/**
 * 飞书用户消息事件类型（`metadata.sourceMessageType` 的值）。
 */
const LARK_USER_MESSAGE_TYPE = "im.message.receive_v1";

/**
 * 卡片点击事件类型 —— **不是**用户消息，不发 ack。
 */
const LARK_CARD_ACTION_TYPE = "card.action.trigger";

/**
 * ★ Task #5062：判断该事件是否是一条「真实用户消息」（= 可以 ack 的事件）。
 *
 * 判定链：
 *   1. `event.type === "event-source.event.lark-cli"`（飞书 lark-cli 事件源）
 *   2. `metadata.sourceMessageType === "im.message.receive_v1"`（消息接收事件）
 *
 * 排除项（一个都不能 ack）：
 *   - telemetry（`task.background.started` / `progress`）—— handleEvent 已 return，
 *     这里再挡一层做防御（万一将来有人改 handleEvent 的短路顺序）
 *   - 终态回执（`task.background.completed` / `timeout`）—— 它们本来就会直发一条
 *     终态回执，再发 ack 会造成「用户收到两条消息」的噪音
 *   - `task.background.failed` / `stopped` / `ask_user`
 *   - 卡片点击（`card.action.trigger`）—— 是按钮交互，不是用户发消息
 *
 * ⚠️ 为什么用 `sourceMessageType` 而不是 `event.type`：
 *   飞书 ES 层把**所有** lark 事件统一包成 `type: "event-source.event.lark-cli"`，
 *   真实事件类型放在 `metadata.sourceMessageType`
 *   （见 `event-source-handlers.ts` 的 `sourceMessageType: eventType`）。
 */
export function isPendingAckEligibleEvent(event: EnvEvent | undefined): boolean {
  if (!event) return false;

  // 防御层 1：内部事件（telemetry / 终态 / ask_user）一律不发 ack
  if (isTelemetryEvent(event.type)) return false;
  if (isRuleNoticeEvent(event.type)) return false;
  if (event.type.startsWith("task.background.")) return false;

  // 防御层 2：必须是飞书 lark-cli 事件源
  if (event.type !== LARK_CLI_EVENT_TYPE) return false;

  const metadata = event.metadata as Record<string, unknown> | undefined;
  const sourceMessageType = metadata?.sourceMessageType;

  // 防御层 3：卡片点击不是用户消息
  if (sourceMessageType === LARK_CARD_ACTION_TYPE) return false;

  return sourceMessageType === LARK_USER_MESSAGE_TYPE;
}

/**
 * ★ Task #5062：ack 正文。
 *
 * 简短即可 —— 目的是让用户知道「消息收到了、正在排队」，不是内容回显。
 * 完整属性（msgId / timestamp / sender / content）写进 console 日志。
 */
export function buildPendingAckText(): string {
  // ★ Task #5062（DS review MAJOR-1）：ack 正文**只含固定规则文案**。
  //
  // 为什么**不带**用户消息摘要：
  //   生产上 `payload.message` 是整个**信封 JSON**
  //   （`{ rawData, recommendedAction, triggerEventId }`，见
  //   event-source-handlers.ts L1904），不是用户正文。
  //   早先的实现试图从中提取摘要，但只查顶层 text/content/body/message
  //   → 一个都不命中 → 原样返回整个 JSON → 被截断 50 字符
  //   → 用户每条 ack 都看到半截 `{"rawData":{"sender_type":"user"...`。
  //
  //   治本方案（DS 建议）：ack 正文不带摘要 —— 它的职责就是告诉用户
  //   「收到了、正在排队」，不是内容回显。被 ack 消息的完整属性
  //   （msgId / timestamp / sender / content）由 `logPendingAckAttributes`
  //   记入日志，需要追溯时查日志。
  return "✅ 消息已收到，正在处理中，请耐心等候";
}

/**
 * ★ Task #5037-B：把同一 lane 的 N 条未处理消息拼成**一个** query。
 *
 * 用户拍板：
 * > 「所谓合并是将未被处理的同一个飞书 session 的消息都合并处理」
 *
 * ## 格式
 *
 * ```
 * 【用户连续发送了 3 条消息，合并处理】
 *
 * [1] 第一条内容
 * [2] 第二条内容
 * [3] 第三条内容
 * ```
 *
 * ## 为什么按这个格式
 *
 * - **标注条数**：让 agent 知道这是 N 条合并来的，避免误以为是 1 条长消息
 * - **时间正序**：后一条常常是对前一条的补充（"再加个 X" 依赖前文）
 * - **逐条编号**：agent 引用时能精确指到第几条
 *
 * ## 长度上限
 *
 * 单条超长会让 prompt 爆炸（飞书消息可以很长），所以：
 * - 每条最多 {@link MAX_MERGED_ITEM_CHARS} 字
 * - 整体最多 {@link MAX_MERGED_TOTAL_CHARS} 字
 * 超出部分用 `…（已截断）` 标注 —— **不静默丢弃**（agent 要知道被截了）。
 */
const MAX_MERGED_ITEM_CHARS = 500;
const MAX_MERGED_TOTAL_CHARS = 4000;

export function buildMergedMessage(batch: ReadonlyArray<{ message?: string }>): string {
  if (batch.length === 0) return "";
  if (batch.length === 1) {
    // 单条也走截断 —— 否则一条超长消息会原样进 prompt（爆 prompt），
    // 而多条的同一条消息却会被截断 → 行为不一致。
    const only = batch[0]?.message ?? "";
    if (only.length <= MAX_MERGED_ITEM_CHARS) return only;
    return `${only.slice(0, MAX_MERGED_ITEM_CHARS)}…（已截断）`;
  }

  const lines: string[] = [`【用户连续发送了 ${batch.length} 条消息，合并处理】`, ""];

  let used = 0;
  let keptCount = 0;
  let itemTruncated = false;

  for (let i = 0; i < batch.length; i++) {
    const raw = batch[i]?.message ?? "";
    let text = raw;

    if (text.length > MAX_MERGED_ITEM_CHARS) {
      text = `${text.slice(0, MAX_MERGED_ITEM_CHARS)}…（已截断）`;
      itemTruncated = true;
    }

    const line = `[${i + 1}] ${text}`;

    // 整体上限：剩下的条目不再展开，但**标注**出来（不静默丢）
    if (used + line.length > MAX_MERGED_TOTAL_CHARS) {
      break;
    }

    lines.push(line);
    used += line.length;
    keptCount++;
  }

  // ★ DS review MINOR-2：标注要带上**具体条数**，让 agent 能向用户确认。
  //   被丢的可能是「算了别做了」这类**改变意图**的短句 —— 静默丢弃很危险。
  const droppedCount = batch.length - keptCount;
  if (droppedCount > 0) {
    lines.push(
      "",
      `（合并内容过长，已省略第 ${keptCount + 1}~${batch.length} 条，共 ${batch.length} 条）`,
    );
  } else if (itemTruncated) {
    lines.push("", "（部分单条内容过长，已截断）");
  }

  return lines.join("\n");
}

/**
 * ★ Task #5062：队列消息项
 */
interface QueueItem {
  /** 用户可读的消息 */
  message: string;
  /** 原始 EnvEvent */
  envEvent: EnvEvent;
  /** 事件处理共享 session ID（由 EventHandler 在处理前注入） */
  eventSessionId?: string;
  /**
   * 父 session ID（从 envEvent.metadata.trigger_session_id 提取）
   * - 存在时: ensureActiveSession 会优先尝试复用该父 session
   * - 不存在或父 session 找不到: fallback 创建新 session
   * 用途: 让 delegate_task 通知处理继承父 session 对话上下文
   */
  triggerSessionId?: string;
  /**
   * ★ Task #4815：trigger session 不存在时按该 ID 创建（而不是 fallback 主会话）
   *
   * 来自 envEvent.metadata.createSessionIfMissing。
   * 用途：让 timer schedule 事件（每日总结）跑在**独立 session**。
   */
  createTriggerSessionIfMissing?: boolean;
  /**
   * 飞书 chat_id（从 envEvent.metadata.replyChannel.chatId 提取）
   * - 存在时: ensureActiveSession 会按 chat_id 找/建 chat-keyed session,
   *   实现"不同飞书会话 → 不同 session"的对话隔离
   * 用途: 跟飞书 app robot 私聊会触发任务创建, 每个任务会建独立飞书群聊,
   * 在对应群聊里聊天时 EventHandler 会找到/创建该群聊对应的 session,
   * 让推进任务对话和 bot 私聊互不干扰。
   */
  chatId?: string;

  /**
   * ★ Task #4486: 入队时快照的 EnvContext（ALS 隔离用）。
   *
   * 背景：EventHandler 之前是单 worker，异步链继承"第一条事件"的 ALS，
   * 后面处理的 item 仍处于前一条事件的 EnvContext 下 → agentContext /
   * messageId 串味（agent-component.ts EnvContext 构建 parent 优先）。
   *
   * 修复：enqueue 时用 getEnvContext() 快照，processItem 时用
   * runWithEnvContextAsync(item.envContext, ...) 重入，让每个 item 都在
   * 自己的 EnvContext 下执行。并发化后更必需。
   */
  envContext?: EnvContext;

  /**
   * ★ Task #4515 (H2 根治): session 解析结果缓存。
   *
   * 根治方案会把 lane 归并到 `sessionId` 命名的 canonical lane，接管它的新
   * runner 会再走一次 `runLane()`。若不缓存，同一个 item 会被解析两次
   * （`list` / `create` / `get` 翻倍，且 chat 路径 create 失败会重复触发）。
   * `sessionResolved` 用于区分"解析过但结果为 null"与"没解析过"。
   */
  sessionResolved?: boolean;
  resolvedSessionId?: string | null;
}

/**
 * EventHandler 配置选项
 */
export interface EventHandlerOptions {
  /** 环境实例 */
  env: BaseEnvironment;
  /** 监听的事件类型（支持通配符，如 'task.*'） */
  eventTypes: string[];
  /** 事件消息触发回调（接收格式化消息） */
  onEvent: (message: string) => Promise<void>;
  /** 事件消息触发回调（接收完整事件信息，可选） */
  onEventWithEnv?: (formattedEvent: FormattedEvent) => Promise<void>;
  /** 消息格式化器 */
  formatter?: EventMessageFormatter;
  /** 检查 agent 是否空闲 */
  isIdle?: () => boolean;
  /**
   * ★ Task #4486: 检查某 session lane 对应的 agent 是否空闲（per-session 门禁）。
   *
   * 参数是 lane 的 session id（chatId / trigger:<id> 解析出的 sessionId /
   * "__default__"）。不提供时回落全局 `isIdle`（向后兼容老行为）。
   *
   * 用途：消费端（interactive.ts）用 executingSessions: Set 做按 session 的
   * 占用判定，避免一个会话跑着就挡住所有会话。
   */
  isSessionIdle?: (sessionId: string) => boolean;
  /**
   * ★ Task #4486: 同时并行处理的 session lane 上限（默认 4）。
   *
   * 为 0 / 负数 / undefined → 用默认值 4。设为 1 等价于旧的全局串行行为。
   *
   * 限制理由：同一 workdir 并发执行 bash / 文件修改会互相影响；provider
   * 限流与成本；SQLite 并发写争用。
   */
  maxConcurrentSessions?: number;
  /** 空闲检查间隔（毫秒） */
  idleCheckInterval?: number;
  /** SessionComponent，用于创建事件共享 session（可选，不提供则 session 功能不启用） */
  sessionComponent?: SessionComponent;
  /**
   * Task #4042 ESPlugin v2 (Phase 4)：EventStore 引用。
   *
   * 当收到 task.background.* notify event 且 metadata.triggerEventId 存在时，
   * EventHandler 会用此 EventStore 反查原始 trigger event（拿到 chatId / messageId），
   * 然后调对应 ES handler.buildNotifyHandlePrompt 构造主 agent prompt。
   *
   * 不传时：纯老 formatter 行为（向后兼容）。
   */
  eventStore?: EventStore;
  /**
   * Task #4042 ESPlugin v2 (Phase 4)：按 ES type 查 handler。
   *
   * 通常实现：`const comp = env.getComponent("event-source"); return comp?.getHandler(type);`
   *
   * 不传时：即使 triggerEventId 存在也无法调 buildNotifyHandlePrompt，走老路径。
   */
  getHandlerForEsType?: (esType: string) => EventSourceHandler | undefined;
  /**
   * ★ Task #4552 (A1)：规则化直发器（可选）。
   *
   * 两个调用方（同一套语义，只是后续动作不同）：
   *   - telemetry（started / progress）：发完 **return**，不跑 agent
   *   - 终态回执（completed / timeout）：发完**继续** enqueue，照常跑 agent
   *
   * 不提供时用默认实现 `sendLarkChatMarkdown`（spawn lark-cli，带硬超时）。
   * 测试用它注入 spy，避免真的 spawn 子进程。
   *
   * ⚠️ 语义约束：**失败必须 reject**（由 EventHandler swallow），
   *    实现方不必自己吞异常。
   */
  telemetrySender?: (notice: {
    chatId: string;
    profile?: string;
    text: string;
    /** ★ 幂等键（≤ 50 字符）：飞书侧据此对重复投递去重 */
    idempotencyKey?: string;
    /**
     * ★ Task #4568：投递方式（来自 `traceChannel.params.sink`）。
     * 缺省 → 走 `sendLarkChatMarkdown`（**向后兼容**）。
     */
    sink?: "lark" | "stdout";
  }) => Promise<void>;
  /**
   * ★ Task #5036：解析「任务卡片」的飞书 applink（可选）。
   *
   * 用户诉求：`✅ Task #N「…」已完成（耗时 X）` 这类回执看不出对应哪张卡，
   * 得翻 pin 列表。这里注入解析器后，回执正文会附 `[📌 查看任务卡片](url)`。
   *
   * 缺省（不注入）⇒ **行为与改动前逐字一致**（既有调用方零改动）。
   *
   * ⚠️ 语义约束：**可以 reject** —— EventHandler 会 swallow 并降级为"不附链接"，
   *    绝不允许因为链接解析失败把回执本身搞丢。返回 `undefined` 同样降级。
   */
  resolveCardUrl?: (taskId: number) => Promise<string | undefined>;
  /**
   * ★ Task #5360：文本投递模式（卡片化改造）。
   *
   * ## 用户需求
   *
   * > 「去掉通知类文本消息（「⏱️ 后台任务运行中 20m」「✅ 已完成 36m」这类
   * >   rule-based 直发的状态推送文本），改为**全部用卡片消息承载**」
   *
   * ## 语义
   *
   * - `"card"`（默认）—— 不再直发文本；卡片（`task:after.*` 链路）已承载
   *   全部状态。**唯一例外**：`sink === "stdout"`（CLI 本地没有卡片可看）
   *   仍发文本，否则本地用户会完全失去进展可见性。
   * - `"text"` —— 逐字保留改造前行为（一行配置回滚）。
   *
   * ⚠️ 无论哪个模式，**都不影响** #4552 的核心不变量：
   * - telemetry（started/progress）**仍不进 lane、不跑 agent**
   * - rule notice（completed/timeout）**仍继续 enqueue**（agent 要读结果）
   *
   * 判定实现见 `telemetry-notice.ts:shouldDeliverNoticeText`（纯函数，可单测）。
   */
  noticeTextDelivery?: NoticeTextDelivery;
  /**
   * ★ Task #5360 补充需求：`"auto"` 模式下的 per-event 开关解析器。
   *
   * 入参是 EnvEvent，返回「这次该不该发状态通知文本」（`statusNotifications`
   * 的最终语义）。装配点在 `event-handler-wiring.ts`，实现见
   * `status-notifications.ts:resolveStatusNotificationsFromEvent`。
   *
   * 不注入 ⇒ `"auto"` 模式一律解析为 `false`（走卡片）——
   * 与 ES 配置缺省值一致，是最安全的降级方向。
   */
  resolveStatusNotifications?: (event: EnvEvent) => boolean;
  /**
   * ★ CV BLOCKER-2：无 task 的 sub-session 生命周期 → 卡片投递端口。
   *
   * 不注入 ⇒ 丢弃（不回 agent lane，避免生命周期事件烧 token）。
   */
  sessionCardSender?: (event: EnvEvent) => Promise<void>;
  /**
   * ★ Task #4552 (A1 BLOCKING)：自我回声过滤配置（防御纵深，可选）。
   *
   * 主修是 telemetry 直发补 `--as bot`（见 `buildLarkSendArgs`）。这层是
   * **兜底**：即使将来别的出站路径又忘 `--as bot`、或同群其它 bot 与
   * 我们互相回灌，也不能把「自己发出的消息」当用户消息跑 agent。
   *
   * 不提供时：
   *   - `enabled` 从 `ROY_AGENT_SELF_ECHO_FILTER` 环境变量读（默认开启）
   *   - `selfBotIds` 为空（只按 `sender_type ∈ {bot,app}` 判定）
   *
   * 判定逻辑全在 `self-echo-filter.ts`（纯函数，好测）。
   *
   * ⚠️ 语义约束：**只拦 bot/app 发送者，绝不按文案前缀过滤** ——
   *    用户完全可能手打一条「🔔 这是什么意思」。
   */
  selfEchoFilter?: {
    /** 总开关（不设时读 env，默认 true） */
    enabled?: boolean;
    /** 我方 bot 身份 id（app_id 和/或 bot open_id），用于口径漂移兜底 */
    selfBotIds?: readonly string[];
    /**
     * ★ Task #5459：**同步**取我方 bot 身份 ids（按事件的 profile）。
     *
     * 为什么不只靠静态 `selfBotIds`：一个 roy-bot 进程可能同时消费多个
     * lark profile（tongzhuli / gonglin / default ...），每个 profile 对应
     * **不同**的 bot 身份。静态数组表达不了「这个事件的 profile 是谁」。
     *
     * ## 为什么是**同步**（而不是 `Promise`）
     *
     * 门禁在 `handleEvent` 最前面、每条事件都跑。第一版用 `await` 起
     * `lark-cli api GET /open-apis/bot/v3/info`（~1s）→ 把事件处理整体拖慢，
     * 实测打挂了 7 个既有时序测试（`await sleep(120)` 后断言），生产同样
     * 会让每条消息延迟 1s。所以契约改成**纯内存/本地读**，网络解析走预热。
     *
     * 返回空数组 ⇒ 该 profile 身份未知 ⇒ 只按 `senderType` 判定（降级）。
     * 必须自己吞掉异常，绝不能让事件处理抛错。
     */
    resolveSelfBotIds?: (profile: string | undefined) => readonly string[];
    /**
     * ★ Task #5459：预热某 profile 的身份（fire-and-forget）。
     *
     * EventHandler 在**首次**遇到某个 profile、且同步取不到完整身份时调用一次。
     * 内部应起后台任务（如 `warmSelfBotIdentities`），**不要**返回需要
     * await 的耗时 promise —— 调用方不会 await 它。
     */
    warmSelfBotIds?: (profile: string | undefined) => void;
  };
}

/**
 * ★ Task #5036：终态回执里「解析卡片链接」的硬预算（毫秒）。
 *
 * 为什么会存在：`lark-cli im +messages-mget` 实测 ~1.1s（含 CLI 启动）。
 * 回执是**主信息**（用户要立刻知道任务结束了），链接是**附加信息**，
 * 超预算就本次不附链接照发回执。
 *
 * ★ DS review N5：初版给 1.5s —— 对 ~1.1s 的实测值余量太小，再叠上 SQLite
 *   首次冷启动，冷启动的第一次回执有大概率丢链接（功能可用但 flaky）。
 *   现放宽到 2.5s（≈2.2x 实测值），仍远小于「3.5s lookup + 5s sender」的
 *   最坏叠加。正常路径几乎总能拿到；解析结果还会写进
 *   `card-message-link` 的进程内缓存，**同一任务的后续回执是 0 成本**。
 */
const RULE_NOTICE_CARD_LINK_BUDGET_MS = 2_500;

/**
 * 事件处理器
 * 
 * 订阅环境事件，格式化后通过队列管理，agent 空闲时触发处理
 */
export class EventHandler {
  /**
   * ★ Task #4486: 无 chatId 且无 triggerSessionId 的事件的默认 lane key。
   *
   * 这类事件共享全局 activeEventSessionId，必须串行（否则会竞争该字段）。
   */
  static readonly DEFAULT_LANE_KEY = "__default__";
  /** ★ Task #4486: 默认并行 lane 上限（防同 workdir 并发写 / provider 限流） */
  static readonly DEFAULT_MAX_CONCURRENT_SESSIONS = 4;

  private env: BaseEnvironment;
  private eventTypes: string[];
  private onEvent: (message: string) => Promise<void>;
  private onEventWithEnv?: (formattedEvent: FormattedEvent) => Promise<void>;
  private formatter: EventMessageFormatter;
  private isIdle: () => boolean;
  private idleCheckInterval: number;

  /**
   * ★ Task #4486: per-session 门禁（不提供时回落全局 isIdle）
   */
  private isSessionIdleFn: ((sessionId: string) => boolean) | null = null;
  /** ★ Task #4486: 并行 lane 上限 */
  private maxConcurrentSessions: number;

  /**
   * ★ Task #4486: per-session 队列（替代单 queue）。
   *
   * key 规则（见 laneKeyFor）：
   *   - `chatId`（飞书事件）
   *   - `trigger:<triggerSessionId>`（delegate_task 通知）
   *   - `"__default__"`（两者都没有 —— 保持旧的单一队列语义，
   *     避免 activeEventSessionId 竞争）
   *
   * 同 key 严格 FIFO 串行；不同 key 并行（受 maxConcurrentSessions 限制）。
   */
  private lanes: Map<string, QueueItem[]> = new Map();
  /** 正在运行的 lane key 集合（用于并发上限 + isSessionIdle 判定） */
  private runningLanes: Set<string> = new Set();
  /**
   * lane key → 该 lane 的 promise 链尾（保证同 lane FIFO 且不重入）。
   * 用 Map 而不是 await 循环，便于并发多个 lane。
   */
  private laneTails: Map<string, Promise<void>> = new Map();
  /**
   * ★ 兼容字段：旧测试/调用方会读 `(handler as any).isProcessing`。
   * 语义改为"是否有任何 lane 正在处理"（any-lane 派生值）。
   */
  private get isProcessing(): boolean {
    return this.runningLanes.size > 0;
  }

  /** ★ Task #4486: chatId → sessionId 缓存（lane 内复用，避免重复 list/create） */
  private chatSessionCache: Map<string, string> = new Map();
  /** ★ Task #4486: 已出队但还在处理中的 item 数（getQueueLength 聚合用） */
  private inFlightCount = 0;

  /**
   * ★ Task #4486: 兼容入口 —— 旧代码/测试直接 `(handler as any).queue.push(item)`
   * 再调 `processQueue()`。这些 item 没有 lane 归属，processQueue() 会把它们
   * 导入对应 lane 后统一 drain。
   *
   * @deprecated 新代码请用 `enqueue()`。
   *
   * ★ Task #4515 (L5): 语义已变，勿依赖。
   *   旧实现里 `get queue()` 就是真实待办队列；per-session lane 化之后
   *   **真实待办在 `lanes` 里**，`legacyQueue` 只剩"兼容入口"作用
   *   （`processQueue()` 会把它搬进 lanes）。因此：
   *   - `(handler as any).queue` 不再反映待办（读它是错的，请用 getQueueLength）
   *   - `ensureActiveSession()` 里 `this.queue.map(...triggerSessionId)` 那条
   *     fallback 实际上是**死代码**（现代调用都会显式传 triggerSessionIdOverride）
   *   保留是为了不破坏既有测试/旧调用方，但新代码不要新增依赖。
   */
  private legacyQueue: QueueItem[] = [];
  private get queue(): QueueItem[] {
    return this.legacyQueue;
  }

  private isStopped = false;
  private unsubscribe: (() => void) | null = null;

  /** ★ Task #4486: 并发槽位（maxConcurrentSessions 限制） */
  private activeSlots = 0;
  private slotWaiters: Array<() => void> = [];

  /**
   * ★ Task #4515 (H2 兜底): per-session 互斥链（`sessionKey → 尾部 promise`）。
   *
   * 为什么需要：lane key 用 transport id（chatId / `trigger:<sid>`），session 用
   * storage id，两个 key 空间不 1:1。两个不同 lane 可能解析到**同一个 session**，
   * 而 `waitForIdle()` 是 check-then-act —— 两边都在"空闲"窗口里看到 true，
   * 于是同一 session 被两轮并发写（上下文错乱）。
   *
   * `claimSession()` 是**原子**的：同步读尾部 + 同步写新尾部，再 await 前一个，
   * 所以同 key 的 claim 严格排队。它把「同 session 串行」从"依赖 lane key 恰好
   * 1:1"变成"由 session 身份保证"，无论有几个 lane 撞到同一 session。
   */
  private sessionChains: Map<string, Promise<void>> = new Map();

  // ==========================================================================
  // Event Source Shared Session
  // ==========================================================================
  /** SessionComponent 引用（可选，不提供则 session 功能不启用） */
  private sessionComponent: SessionComponent | null = null;
  /** 当前活跃的事件处理 session ID — 只用于非 lark 事件跨批次复用 */
  private activeEventSessionId: string | null = null;
  /**
   * ★ Bug fix (#4038/#4035 跨 chat 污染): triggerSessionId → 已解析 session ID 映射。
   *
   * 为什么需要它（而不是单个 activeEventSessionId）：
   *   - 非飞书 notify event 各自携带 trigger_session_id（父 session）。若只用一个全局
   *     activeEventSessionId，任一 trigger 的解析结果会劫持后续所有 trigger（串会话）。
   *   - 用 trigger 维度缓存后：同 trigger 的多个 batch 复用同一 session；不同 trigger
   *     各解析各的；解析结果（含 create 出的新 session）被记住，避免父 session 缺失时
   *     反复 create。
   */
  private resolvedSessionByTrigger: Map<string, string> = new Map();

  // ========================================================================
  // Task #4042 ESPlugin v2 (Phase 4)
  // ========================================================================
  /** EventStore（可选，不传时走老 formatter 路径） */
  private eventStore: EventStore | null = null;
  /** 按 ES type 取 handler（可选） */
  private getHandlerForEsType:
    | ((esType: string) => EventSourceHandler | undefined)
    | null = null;
  /**
   * ★ Task #4552 (A1)：telemetry 进展提示直发器。
   *
   * 默认 `sendLarkChatMarkdown`（spawn lark-cli + 硬超时）；测试注入 spy。
   */
  private telemetrySender: (notice: {
    chatId: string;
    profile?: string;
    text: string;
    idempotencyKey?: string;
    sink?: "lark" | "stdout";
  }) => Promise<void> = (notice) => sendLarkChatMarkdown(notice);

  /**
   * ★ Task #5036：任务卡片 applink 解析器（`null` = 未注入 ⇒ 不附链接）。
   *
   * 默认 `null` 而非自带实现：EventHandler 是通用层，不该知道
   * `lark-cards.db` / lark-cli 的存在。装配点（interactive / chat-event-handler）
   * 才决定要不要接。
   */
  private resolveCardUrl: ((taskId: number) => Promise<string | undefined>) | null = null;

  /**
   * ★ Task #5360：文本投递模式（默认 `"card"` = 卡片承载，不再直发文本）。
   *
   * 缺省值刻意是 `"card"` 而不是 `"text"` —— 用户明令"去掉通知类文本消息"，
   * 默认不生效等于需求没做。回滚靠显式传 `"text"`。
   */
  private noticeTextDelivery: NoticeTextDelivery = DEFAULT_NOTICE_TEXT_DELIVERY;

  /**
   * ★ Task #5360 补充需求：`"auto"` 模式下的事件级开关解析器（`null` = 未注入）。
   *
   * 未注入时 `"auto"` 解析为 `false`（不发文本 ⇒ 卡片承载），与 ES 配置
   * 缺省值一致 —— 安全侧降级。
   */
  private resolveStatusNotifications: ((event: EnvEvent) => boolean) | null = null;

  /**
   * ★ CV BLOCKER-2：session 生命周期卡片投递端口（`null` = 未注入）。
   *
   * 由装配点（`event-handler-wiring.ts`）接到卡片层。
   */
  private sessionCardSender: ((event: EnvEvent) => Promise<void>) | null = null;

  /**
   * ★ Task #4552 (A1 BLOCKING)：自我回声过滤配置（在 constructor 里 resolve）。
   *
   * `enabled` 优先取构造参数，缺省读 `ROY_AGENT_SELF_ECHO_FILTER` env
   * （默认开启）；`selfBotIds` 只来自构造参数。
   */
  private selfEchoFilter: {
    enabled: boolean;
    selfBotIds: readonly string[];
    /** ★ Task #5459：按 profile 同步取自身 bot 身份（可选注入） */
    resolveSelfBotIds?: (profile: string | undefined) => readonly string[];
    /** ★ Task #5459：按 profile 预热身份（fire-and-forget，可选注入） */
    warmSelfBotIds?: (profile: string | undefined) => void;
  } = {
    enabled: true,
    selfBotIds: [],
  };

  /** ★ Task #5459：已触发过预热的 profile（避免每条事件都重复调用预热） */
  private warmedProfiles = new Set<string>();

  /** ★ Task #4552 (A1 BLOCKING)：被自我回声过滤丢弃的事件数（读口见 getSelfEchoDroppedCount） */
  private selfEchoDroppedCount = 0;

  /**
   * ★ Task #5459：被**放行**的群聊 bot 消息数（读口见 getSelfEchoAllowedGroupBotCount）。
   *
   * 为什么要暴露这个计数：群聊放行是「A/B 智能体互 @ 协作」的前提，但它同时
   * 意味着「两个 bot 若都无条件回复对方，就会来回刷」。这条计数是运维发现
   * 那种「异常高频协作」的唯一低成本信号 —— 短时间暴涨即说明两个 agent 在
   * 互相回灌，而不是在真正协作。
   *
   * 刻意**不打日志**：正常协作下每条消息都会触发，打日志会把事件循环刷满。
   */
  private selfEchoAllowedGroupBotCount = 0;

  /**
   * ★ Task #4552 (A1 BLOCKING)：已被自我回声过滤丢弃的事件数。
   *
   * 暴露给运维/诊断（运维要能一眼看出这层过滤到底出手了多少次，
   * 而不是只能翻 console 日志）。只统计**真正被丢弃**的事件，
   * 真实用户消息 / 软回滚关闭时都不会增长。
   */
  getSelfEchoDroppedCount(): number {
    return this.selfEchoDroppedCount;
  }

  /**
   * ★ Task #5459：被放行的群聊 bot 消息数（协作入站）。
   *
   * 运维判读：该值随正常协作线性增长是预期的；**短时间内暴涨**意味着
   * 两个智能体在互相无条件回复（ping-pong），需要人工介入或调整提示。
   */
  getSelfEchoAllowedGroupBotCount(): number {
    return this.selfEchoAllowedGroupBotCount;
  }

  constructor(options: EventHandlerOptions) {
    this.env = options.env;
    this.eventTypes = options.eventTypes;
    this.onEvent = options.onEvent;
    this.onEventWithEnv = options.onEventWithEnv;
    this.formatter = options.formatter ?? new EventMessageFormatter();
    this.isIdle = options.isIdle ?? (() => true);  // 默认认为总是空闲
    this.isSessionIdleFn = options.isSessionIdle ?? null;
    const maxSessions = options.maxConcurrentSessions;
    this.maxConcurrentSessions =
      typeof maxSessions === "number" && Number.isFinite(maxSessions) && maxSessions >= 1
        ? Math.floor(maxSessions)
        : EventHandler.DEFAULT_MAX_CONCURRENT_SESSIONS;
    this.idleCheckInterval = options.idleCheckInterval ?? 100;
    this.sessionComponent = options.sessionComponent ?? null;
    // ★ Task #4042 ESPlugin v2 Phase 4
    this.eventStore = options.eventStore ?? null;
    this.getHandlerForEsType = options.getHandlerForEsType ?? null;
    // ★ Task #4552 (A1)
    // ★ Task #4568：默认发送器按 `sink` 分派。
    //
    //   - `sink === 'stdout'` → 直接 console.log（CLI 触发路径；用户拍板 ①）
    //   - 其它（含缺省）      → `sendLarkChatMarkdown`（原行为，零改动）
    //
    // 为什么 stdout 分支不 spawn lark-cli：CLI 的 chatId 是 `cli:<sid>` 这种
    // 合成值，飞书侧必然拒绝（invalid chat_id）；以前被 swallow 成"静默丢弃"，
    // 这正是用户报障"通知发不出来"的直接原因。
    this.telemetrySender =
      options.telemetrySender ??
      ((notice) => {
        if (notice.sink === "stdout") {
          console.log(`\n${notice.text}\n`);
          return Promise.resolve();
        }
        return sendLarkChatMarkdown(notice);
      });
    // ★ Task #5036：卡片链接解析器（不注入 ⇒ null ⇒ 零行为变化）
    this.resolveCardUrl = options.resolveCardUrl ?? null;
    // ★ Task #5360：文本投递模式（缺省 auto = 按 ES 配置 statusNotifications）
    this.noticeTextDelivery =
      options.noticeTextDelivery ?? DEFAULT_NOTICE_TEXT_DELIVERY;
    this.resolveStatusNotifications = options.resolveStatusNotifications ?? null;
    this.sessionCardSender = options.sessionCardSender ?? null;
    // ★ Task #4552 (A1 BLOCKING)：自我回声过滤（enabled 缺省读 env，默认开启）
    this.selfEchoFilter = {
      enabled: options.selfEchoFilter?.enabled ?? readSelfEchoFilterEnabled(),
      selfBotIds: options.selfEchoFilter?.selfBotIds ?? [],
      ...(options.selfEchoFilter?.resolveSelfBotIds
        ? { resolveSelfBotIds: options.selfEchoFilter.resolveSelfBotIds }
        : {}),
      ...(options.selfEchoFilter?.warmSelfBotIds
        ? { warmSelfBotIds: options.selfEchoFilter.warmSelfBotIds }
        : {}),
    };
  }

  /**
   * 启动事件处理
   * @returns 取消订阅函数
   */
  start(): () => void {
    this.isStopped = false;
    
    // 使用 subscribeAll 接收所有事件，然后在 handler 中过滤类型
    // 因为 subscribeTo 不支持通配符模式
    this.unsubscribe = this.env.subscribeAll((event: EnvEvent) => {
      // 检查事件类型是否匹配
      if (this.matchesEventType(event.type)) {
        this.handleEvent(event);
      }
    });

    return () => this.stop();
  }

  /**
   * 检查事件类型是否匹配
   */
  private matchesEventType(eventType: string): boolean {
    for (const pattern of this.eventTypes) {
      if (this.matchPattern(eventType, pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 通配符模式匹配
   * 支持:
   * - "task.*" 匹配 "task.started", "task.completed" 等
   * - "task.started" 精确匹配
   */
  private matchPattern(eventType: string, pattern: string): boolean {
    if (pattern === "*") return true;
    
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      return eventType === prefix || eventType.startsWith(prefix + ".");
    }
    
    return eventType === pattern;
  }

  /**
   * 停止事件处理
   */
  stop(): void {
    this.isStopped = true;

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    // 清空所有 lane 队列 + legacy 队列
    this.lanes.clear();
    this.legacyQueue = [];
    this.laneTails.clear();

    // 唤醒所有等待槽位的 runner，让它们感知 isStopped 后退出
    const waiters = this.slotWaiters.splice(0, this.slotWaiters.length);
    for (const w of waiters) w();
    this.activeSlots = 0;

    // 清除 active session
    this.clearActiveSession();
  }

  /**
   * ★ Task #5459：取「我方 bot 自身身份」id 列表（**同步、廉价**）。
   *
   * ## 解析顺序
   *
   * 1. 注入了 `resolveSelfBotIds` → 按事件 `metadata.profile` 同步取
   *    （实现方只做内存 + 本地小文件读取，微秒级）
   * 2. 否则用构造参数的静态 `selfBotIds`
   * 3. 两者合并去重
   *
   * ## 为什么必须同步
   *
   * 这门禁在每条事件最前面跑。第一版 `await` 了 lark-cli（~1s）→ 实测打挂
   * 7 个时序敏感测试，生产同样会把每条消息拖慢 1 秒。所以：
   * **热路径只读缓存**，网络解析交给 `warmSelfBotIds` 后台预热。
   *
   * ## 数据不全时的行为
   *
   * 首次遇到某 profile 时 `open_id` 可能还没预热到缓存里 → 本次只有 `app_id`。
   * 这不影响正确性（群聊 bot 消息本来就放行；`app_id` 足够拦「自己发的」
   * 这种 `sender_id=cli_xxx` 形态的回声），下一次事件就能拿到完整身份。
   */
  private resolveSelfBotIdsForEvent(event: EnvEvent): readonly string[] {
    const staticIds = this.selfEchoFilter.selfBotIds;
    const resolver = this.selfEchoFilter.resolveSelfBotIds;
    if (!resolver) return staticIds;

    const meta = event.metadata as Record<string, unknown> | undefined;
    const payloadMeta = (event.payload as Record<string, unknown> | undefined)?.metadata as
      | Record<string, unknown>
      | undefined;
    const profileRaw = meta?.profile ?? payloadMeta?.profile;
    const profile = typeof profileRaw === "string" ? profileRaw : undefined;

    // 预热（每个 profile 只触发一次；fire-and-forget，绝不 await）
    const warm = this.selfEchoFilter.warmSelfBotIds;
    if (warm) {
      const key = profile ?? "";
      if (!this.warmedProfiles.has(key)) {
        this.warmedProfiles.add(key);
        try {
          warm(profile);
        } catch (err) {
          console.error(`[EventHandler] warmSelfBotIds failed (profile=${key || "-"}):`, err);
        }
      }
    }

    let resolved: readonly string[];
    try {
      resolved = resolver(profile);
    } catch (err) {
      console.error(`[EventHandler] resolveSelfBotIds failed (profile=${profile ?? "-"}):`, err);
      return staticIds;
    }

    if (resolved.length === 0) return staticIds;
    if (staticIds.length === 0) return resolved;
    const merged: string[] = [...resolved];
    for (const id of staticIds) if (!merged.includes(id)) merged.push(id);
    return merged;
  }

  /**
   * 处理收到的事件
   */
  @TracedAs("event_handler.handle_event", { recordParams: true })
  private async handleEvent(event: EnvEvent): Promise<void> {
    // 如果已停止，忽略事件
    if (this.isStopped) {
      return;
    }

    // ★ Task #4552 (A1 BLOCKING)：自我回声过滤（防御纵深，**必须在最前**）。
    //
    // 背景：A1 的 telemetry 提示曾以 user 身份发出 → 被自己的 lark-cli
    // consumer 当作用户消息回灌 → 又跑一次完整 agent run（188 spans）。
    // 主修是直发补 `--as bot`；这里是兜底防线，覆盖主修防不住的场景：
    //   1. 将来有人新增出站路径又忘 `--as bot`
    //   2. 同群里别的 bot 的消息（对我们是 `sender_type=app`）
    //   3. 飞书把 bot 消息的 `sender_type` 报成 `user`（字段口径漂移），
    //      但 senderId 仍是我们 bot 的 open_id / app_id
    //
    // 为什么放最前：这里是唯一入口（start() 订阅 → handleEvent）。在
    // formatEvent / enqueue / claimSession 之前拦掉，后续一行都不执行。
    //
    // ⚠️ 绝不按文案前缀（🔔/🔄）过滤 —— 用户完全可能手打一条
    //    「🔔 这是什么意思」。只按 sender 身份判定。
    //    回归护栏：self-echo-filter.test.ts 第 3 组 +
    //    event-handler-telemetry-notice.test.ts RED-3b。
    if (this.selfEchoFilter.enabled) {
      // ★ Task #5459：按事件的 profile 动态解析自身 bot 身份（app_id + open_id）。
      //
      // 为什么必须动态：门禁「第 0 步 = senderId ∈ selfBotIds → 丢弃」是群聊
      // 放行后的**自循环闸门**。静态 selfBotIds 在生产从未注入（恒空）⇒ 群聊
      // 放行会让各 bot 把自己的出站当协作入站，形成无限回灌。而一个进程可能
      // 同时消费多个 lark profile，每个 profile 的 bot 身份不同 ⇒ 静态数组
      // 表达不了，必须按事件 profile 解析。解析结果按 profile 缓存。
      const selfBotIds = this.resolveSelfBotIdsForEvent(event);
      const verdict = isSelfEchoEvent(event, { selfBotIds });
      if (verdict.skip) {
        this.selfEchoDroppedCount += 1;
        console.error(
          `[EventHandler] self-echo event dropped (reason=${verdict.reason}` +
            `, senderType=${verdict.senderType ?? "-"}` +
            `, senderId=${verdict.senderId ?? "-"}` +
            `, chatKind=${verdict.chatKind ?? "-"}` +
            `, type=${event.type})`,
        );
        return;
      }
      // ★ Task #5459：放行的群聊 bot 消息（= 协作入站）。只计数、不打日志。
      if (verdict.reason === "group-bot-message") {
        this.selfEchoAllowedGroupBotCount += 1;
      }
    }

    // ★ Task #4552 (A1)：telemetry（started / progress）**完全不进 lane**。
    //
    // 为什么在这里而不是在 enqueue/runLane 里过滤：
    //   - 这里是唯一入口（start() 订阅 → handleEvent），在最早一步拦掉，
    //     后续 formatEvent / enqueue / resolveSessionForItem / claimSession
    //     一行都不会执行，从**源头**保证不可能触发 agent run。
    //   - 放在 runLane 里过滤仍会走 lane 调度与 session 解析（白烧 IO 与
    //     SQLite 争用），且给未来加代码留下"又跑起来"的口子。
    //
    // 为什么 fire-and-forget（不 await）：
    //   lark-cli 直发最长 5s（硬超时）。若在这里 await，一条心跳就能把
    //   事件订阅回调卡住 5s —— 正是要消灭的东西。sendTelemetryNotice 内部
    //   已对所有异常兜底（best-effort），不会产生 unhandled rejection。
    // ★ CV BLOCKER-2 修复：`task.background.session_started` = **无 task 的
    //   sub-session 生命周期事件**（开始时发 running，结束时发终态）。
    //
    // 这类事件必须交给卡片层（发/更新 session 卡），但**不能进 agent lane**
    // （它没有 task 可读、没有结果可总结，进 lane 只会白烧 token —— 与
    // #4552 对 telemetry 的处理同一道理）。所以：
    //   - 有 sessionCardSender 端口 → fire-and-forget 交给它
    //   - 没有 → 静默丢弃（不回落 agent）
    if (isSessionLifecycleEvent(event.type)) {
      void this.sendSessionLifecycleCard(event);
      return;
    }

    if (isTelemetryEvent(event.type)) {
      void this.sendTelemetryNotice(event);
      return;
    }

    // ★ 终态规则回执（completed / timeout）：先直发一条**保底**消息，然后
    //   **继续往下走**，不 return —— agent 仍要读子任务结果、组织总结、
    //   必要时续接 sub-session。
    //
    // 为什么在 enqueue 之前发：
    //   同一 lane 严格 FIFO，而 agent run 可能被前面的长任务挡住几分钟。
    //   先发回执 = 用户 3 秒内就知道「任务已经结束了」，不依赖 lane 空闲。
    //
    // 为什么这里 await：
    //   - handleEvent 已在订阅回调之外（dispatchLines fire-and-forget），
    //     不会卡住事件流。
    //   - 只有终态事件付这个成本（sender 自带 5s 硬超时）。
    //   - 换来的是 prompt 里能写**真实**送达状态（见 RuleNoticeInfo），
    //     而不是让 agent 猜「系统到底发没发」。
    const ruleNotice = isRuleNoticeEvent(event.type)
      ? await this.sendRuleNotice(event)
      : undefined;

    // 格式化事件（可能替换为 ESPlugin v2 prompt）
    const formatted = await this.formatEvent(event, { ruleNotice });

    // 加入队列
    this.enqueue(formatted);
  }

  /**
   * 解析直发目标（telemetry / 终态回执共用）。
   *
   * 顺序：
   *   1. `metadata.replyChannel` 快照（delegate 时刻写入，零 IO，最准）
   *   2. `metadata.chatId`（部分 ES 生产端直接写顶层）
   *   3. `triggerEventId` 反查 EventStore（老 delegate 路径 / 跨进程重启）
   *
   * 解析不到 → undefined（调用方各自决定「丢弃」还是「照常跑 agent」）。
   */
  private async resolveNoticeTarget(
    event: EnvEvent,
  ): Promise<TelemetryNoticeTarget | undefined> {
    const metadata = event.metadata as Record<string, unknown> | undefined;

    const target: TelemetryNoticeTarget | undefined =
      targetFromEventMetadata(metadata);
    if (target) return target;

    const triggerEventId =
      typeof metadata?.triggerEventId === "string"
        ? (metadata.triggerEventId as string)
        : undefined;
    return targetFromTriggerEvent(this.eventStore, triggerEventId);
  }

  /**
   * ★ CV BLOCKER-2：把无 task 的 sub-session 生命周期交给卡片层。
   *
   * 为什么单独一个端口而不是复用 `telemetrySender`：telemetrySender 发的是
   * **文本**（正在被本次改造下线）；session 生命周期要的是**卡片**（发卡 /
   * 同卡 patch）。两者投递形态不同，混用一个端口会逼实现方在内部再分支。
   *
   * 未注入 ⇒ 静默丢弃：session 卡是「可选的可见性增强」，缺了它不该回落到
   * agent lane（那会让一条生命周期事件触发一次完整 LLM 回合）。
   *
   * ⚠️ 永不抛（fire-and-forget 调用方不接 promise）。
   */
  private async sendSessionLifecycleCard(event: EnvEvent): Promise<void> {
    if (!this.sessionCardSender) return;
    try {
      await this.sessionCardSender(event);
    } catch (err) {
      console.error(
        `[EventHandler] session lifecycle card failed (swallowed) type=${event.type}`,
        err,
      );
    }
  }

  /**
   * ★ Task #5360 补充需求：解析「这次事件该不该发状态通知文本」。
   *
   * 只服务于 `"auto"` 模式（其它模式下 `shouldDeliverNoticeText` 会忽略本值）。
   *
   * ## 为什么包一层而不是直接调注入的解析器
   *
   * 1. **永不抛**：解析器要读 `metadata` / ES 配置列表，形状可能异常
   *    （第三方事件源 / 手改配置）。抛出去会污染事件消费循环。
   * 2. **未注入 ⇒ false**：与 ES 配置缺省值一致（不发文本 ⇒ 卡片承载），
   *    安全侧降级 —— CLI 本地（stdout）另有最高优先级例外兜住。
   * 3. 未来解析器要变成 async（活取 ES 配置可能需要 IO）时，调用点不用改。
   */
  private async resolveStatusNotificationsFor(event: EnvEvent): Promise<boolean> {
    if (!this.resolveStatusNotifications) return false;
    try {
      return (await this.resolveStatusNotifications(event)) === true;
    } catch {
      // 与 status-notifications.ts 的 catch 同一语义：解析失败 ⇒ 走卡片
      return false;
    }
  }

  /**
   * ★ Task #5036：解析终态回执要附带的卡片链接。
   *
   * 返回 `undefined` 表示「这次不附链接」—— 以下任一情况都属于**正常降级**：
   *   - 未注入 `resolveCardUrl`（既有调用方 / CLI 本地路径）
   *   - payload 里没有 `associatedTaskId`（非任务型后台任务）
   *   - 解析器返回 `undefined`（该 Task 从未发过卡片 / 卡片记录已清）
   *   - 解析器抛异常（sqlite 打不开 / lark-cli 超时 / 等等）
   *
   * ⚠️ **永不抛**：回执是"保底告知用户任务已结束"的链路，任何附加信息
   *    都不允许拖累它。
   */
  private async resolveRuleNoticeCardUrlWithBudget(
    event: EnvEvent,
  ): Promise<string | undefined> {
    if (!this.resolveCardUrl) return undefined;

    // 与「硬预算」赛跑：超时 ⇒ undefined（不附链接），但**不**取消后台 lookup
    // （它跑完会写缓存，后续回执直接命中）。
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.resolveRuleNoticeCardUrl(event),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), RULE_NOTICE_CARD_LINK_BUDGET_MS);
          (timer as { unref?: () => void }).unref?.();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async resolveRuleNoticeCardUrl(
    event: EnvEvent,
  ): Promise<string | undefined> {
    if (!this.resolveCardUrl) return undefined;

    const payload = event.payload as Record<string, unknown> | undefined;
    const rawTaskId = payload?.associatedTaskId;
    const taskId =
      typeof rawTaskId === "number"
        ? rawTaskId
        : typeof rawTaskId === "string" && rawTaskId.trim()
          ? Number(rawTaskId)
          : undefined;
    if (taskId === undefined || !Number.isFinite(taskId) || taskId <= 0) {
      return undefined;
    }

    try {
      return await this.resolveCardUrl(taskId);
    } catch {
      // ★ DS review m4：这里**刻意不** console.error。
      //   `interactive` / `run` 的 Ink/REPL 都独占 stdout/stderr 做帧重绘
      //   （见 interactive.ts 里 stderr guard 的注释），best-effort 链路
      //   每次失败往 stderr 写一行会撕坏渲染帧。降级本身就是预期行为，
      //   不需要向用户报错。
      return undefined;
    }
  }

  /**
   * ★ 终态规则回执：把 completed / timeout 直发到触发群。
   *
   * 与 `sendTelemetryNotice` 的差异只有两处：
   *   1. 文案用 `buildTerminalNoticeText`（终态事实，不含 result 正文）
   *   2. **永不 return 调用方链路** —— 调用方发完继续 enqueue（agent 参与）
   *
   * 其余（目标解析 / `--as bot` / 幂等键 / 5s 硬超时 / best-effort）完全复用。
   *
   * ⚠️ 本方法**永不抛**：失败如实写进返回值，由 prompt 告知 agent「回执没发出去」。
   */
  @TracedAs("event_handler.rule_notice", { recordParams: true, recordResult: false })
  private async sendRuleNotice(event: EnvEvent): Promise<RuleNoticeInfo> {
    try {
      const target = await this.resolveNoticeTarget(event);
      if (!target) {
        return { attempted: true, delivered: false, error: "no-target" };
      }

      // ★ Task #5036：解析任务卡片链接（best-effort —— 失败只是"没链接"）
      //
      // ★ DS review M2：这里**必须**有硬预算。`resolveCardUrl` 内部会 spawn
      //   `lark-cli im +messages-mget`（实测 ~1.1s），而本方法在发回执**之前**
      //   await 它 —— 若不加界，用户看到「任务已结束」的最大延迟会从
      //   ~0ms 涨到 3.5s+5s(sender 超时)，与「先发回执，用户 3 秒内就知道」
      //   的设计目标冲突。
      //
      //   策略：与回执送达**赛跑**，超时即放弃链接照发回执（链接是附加信息，
      //   回执是主信息）。后台那次 lookup 继续跑完并写进缓存，后续同任务的
      //   回执就能秒命中。
      const cardUrl = await this.resolveRuleNoticeCardUrlWithBudget(event);

      const text = buildTerminalNoticeText(
        event.type,
        event.payload as Record<string, unknown> | undefined,
        ...(cardUrl ? [{ cardUrl }] : []),
      );

      // ★ Task #5360：卡片化改造 —— card 模式下不再直发文本（除非 CLI 本地）。
      //
      // ⚠️ `attempted: false`（而不是 `delivered: false` + error）是**刻意**的：
      //    `renderRuleNoticeSection` 只在 `attempted === true` 时才往 prompt 里
      //    写「回执未送达 / 回执已送达」，`attempted: false` 等于"本次不适用规则
      //    回执" → prompt **完全静默**，agent 不会以为自己漏发了什么。
      //    这也正是 card 模式的语义：终态由卡片承载，不存在"回执"这个概念。
      if (
        !shouldDeliverNoticeText(
          this.noticeTextDelivery,
          target.sink as "lark" | "stdout" | undefined,
          await this.resolveStatusNotificationsFor(event),
        )
      ) {
        return { attempted: false, delivered: false, chatId: target.chatId };
      }

      await this.telemetrySender({
        chatId: target.chatId,
        ...(target.profile ? { profile: target.profile } : {}),
        // ★ Task #4568：透传 sink（缺省时省略，保持对象形状与老测试一致）
        ...(target.sink ? { sink: target.sink } : {}),
        text,
        // 与 telemetry 用不同 namespace：两种链路互斥，但留出隔离
        idempotencyKey: deriveRuleNoticeIdempotencyKey(event.id, target.chatId),
      });

      return {
        attempted: true,
        delivered: true,
        chatId: target.chatId,
        text,
        sentAt: Date.now(),
      };
    } catch (err) {
      // best-effort：回执失败绝不允许影响 agent 处理
      console.error(
        `[EventHandler] rule notice failed (swallowed) type=${event.type}`,
        err,
      );
      return {
        attempted: true,
        delivered: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * ★ Task #4552 (A1)：把 telemetry 事件降级成一条纯 IM 进展提示。
   *
   * 行为约定（见 event-handler-telemetry-notice.test.ts）：
   * - **不** claimSession / **不**建 session / **不**调 onEventWithEnv
   *   → 不产生任何 agent run（token 的主因）
   * - 目标解析顺序：`metadata.replyChannel` 快照 → `metadata.chatId`
   *   → `triggerEventId` 反查 EventStore
   * - 反查不到 chatId → **静默丢弃**（不回落 agent）
   *
   * 为什么"反查不到就丢弃"而不是回落老路径：
   *   老路径 = 进 lane + 完整 agent run。若在这里回落，`__default__` lane
   *   （本地 REPL / 非飞书事件共用）会重新变成饥饿源 —— 正是要根治的东西。
   *   telemetry 是**非必需**信息，丢弃远优于让一条心跳挡住用户消息。
   *
   * ⚠️ 本方法**永不抛**（fire-and-forget 调用方不接 promise）。
   */
  @TracedAs("event_handler.telemetry_notice", { recordParams: true, recordResult: false })
  private async sendTelemetryNotice(event: EnvEvent): Promise<void> {
    try {
      // 目标解析（与终态回执共用）：replyChannel 快照 → metadata.chatId → 反查
      const target = await this.resolveNoticeTarget(event);

      if (!target) {
        // 明确选择「丢弃」：既不直发（没目标），也不回落 agent（会饿死用户消息）
        return;
      }

      // ★ Task #5360：卡片化改造 —— card 模式下**完全静默**（连文案都不生成）。
      //
      // 为什么连 buildTelemetryNoticeText 都不调：这条链路每 20 分钟一次心跳，
      // 生成文案纯属浪费；且 card 模式下文案没人消费（无文本可发）。
      //
      // ⚠️ 静默 ≠ 回落 agent：本方法在 card 模式下依然 **return**，
      //    绝不让心跳进 lane（#4552 的核心不变量）。
      if (
        !shouldDeliverNoticeText(
          this.noticeTextDelivery,
          target.sink as "lark" | "stdout" | undefined,
          await this.resolveStatusNotificationsFor(event),
        )
      ) {
        return;
      }

      const text = buildTelemetryNoticeText(
        event.type,
        event.payload as Record<string, unknown> | undefined,
      );

      await this.telemetrySender({
        chatId: target.chatId,
        ...(target.profile ? { profile: target.profile } : {}),
        // ★ Task #4568：透传 sink（同上）
        ...(target.sink ? { sink: target.sink } : {}),
        text,
        // ★ 幂等键：同一条事件被重复投递（lark-cli event consume 重投 /
        //   roy-bot 进程重启后重放）时，飞书侧去重，用户不会收到重复提示。
        //   按 event.id 派生（不是文案 hash —— 心跳文案在整点会完全相同，
        //   按文案会把不同心跳压成一条，丢掉后续进展）。
        idempotencyKey: deriveTelemetryIdempotencyKey(event.id, target.chatId),
      });
    } catch (err) {
      // best-effort：直发失败绝不允许污染事件消费循环
      // （sender 抛 → 后续终态事件仍要能正常处理）
      console.error(
        `[EventHandler] telemetry notice failed (swallowed) type=${event.type}`,
        err,
      );
    }
  }

  /**
   * Task #4042 ESPlugin v2 (Phase 4) — 事件格式化（formatter + 可选 ESPlugin v2 path）
   *
   * 老路径：直接用 EventMessageFormatter.formatWithEvent。
   * 新路径（满足 4 个条件才走）：
   *   1. event.type ∈ NOTIFY_V2_TERMINAL_TYPES（仅终态结果；Bug A / #4105 收窄）
   *   2. event.metadata.triggerEventId 存在
   *   3. eventStore 注入
   *   4. getHandlerForEsType 注入 + 找到 trigger event 的 esType 对应 handler
   *
   * 新路径：
   *   1. EventStore.getEventById(triggerEventId) 拿原始 trigger event
   *   2. 找 ES handler（按 trigger event 的 esType）
   *   3. 调 handler.buildNotifyHandlePrompt({ notifyEvent, triggerEvent, subAgentResult })
   *   4. 用返回的 promptText 作为 FormattedEvent.message（含 trigger chatId / messageId）
   *      chatId 来自 triggerEvent.metadata.chatId（不走 lastReplyChannel）
   */
  @TracedAs("cli.event-handler.formatEvent", { recordParams: true, recordResult: false })
  async formatEvent(
    event: EnvEvent,
    opts: { ruleNotice?: RuleNoticeInfo } = {},
  ): Promise<FormattedEvent> {
    // 走 ESPlugin v2 路径的条件检查
    // ★ Bug A 修复（#4105 假通知）：只有终态事件才走 v2 notify 路径。
    //   started/progress 等中间态若走 v2，会被 buildNotifyHandlePrompt
    //   误渲染成"Sub-agent 完成了" → 主 agent 提前回复用户。
    //   见 NOTIFY_V2_TERMINAL_TYPES。
    if (
      NOTIFY_V2_TERMINAL_TYPES.has(event.type) &&
      event.metadata?.triggerEventId &&
      this.eventStore &&
      this.getHandlerForEsType
    ) {
      try {
        const v2Formatted = await this.formatEventViaESPluginV2(
          event,
          opts.ruleNotice,
        );
        if (v2Formatted) {
          return v2Formatted;
        }
      } catch (err) {
        // 任何异常都 fallback 到老路径（不阻塞主流程）
        console.error(
          `[EventHandler] ESPlugin v2 path failed, falling back to formatter`,
          err,
        );
      }
    }

    // 老路径
    return this.formatter.formatWithEvent(event);
  }

  /**
   * 从 trigger event + handler 归一化出「触发渠道」信息（渠道无关）。
   *
   * 目的：让 notify prompt 能按**真实渠道**渲染，而不是所有渠道都套 lark 模板。
   *
   * 解析顺序（越靠前越权威）：
   *   1. `handler.extractReplyContext()` —— handler 自己知道自家字段怎么映射
   *   2. trigger event metadata 平铺字段（lark-cli 落库时写了 chatId/messageId/chatType/profile）
   *   3. 全空 → `replyKind: "none"`（prompt 必须明说「无可用回复通道」）
   */
  private buildNotifyChannelInfo(
    triggerEvent: PersistedEvent,
    handler: EventSourceHandler,
    profile?: string,
  ): NotifyChannelInfo {
    const meta = (triggerEvent.metadata ?? {}) as Record<string, unknown>;
    const ctx = handler.extractReplyContext?.(triggerEvent, profile);

    const chatId = ctx?.chatId || (meta.chatId as string | undefined) || undefined;
    const messageId =
      ctx?.messageId || (meta.messageId as string | undefined) || undefined;
    const senderId =
      ctx?.senderOpenId || (meta.senderId as string | undefined) || undefined;
    const resolvedProfile =
      ctx?.profile ?? profile ?? (meta.profile as string | undefined);

    const rawChatType = meta.chatType;
    const chatType: NotifyChannelInfo["chatType"] =
      rawChatType === "group" || rawChatType === "p2p" ? rawChatType : "unknown";

    return {
      esType: triggerEvent.esType ?? handler.type,
      ...(chatId ? { chatId } : {}),
      chatType,
      ...(messageId ? { messageId } : {}),
      ...(senderId ? { senderId } : {}),
      ...(resolvedProfile ? { profile: resolvedProfile } : {}),
      replyKind: chatId ? (messageId ? "reply" : "send") : "none",
    };
  }

  /**
   * ESPlugin v2 path 实际实现。返回 null 时调用方走老路径。
   */
  @TracedAs("event_handler.process_notify", { recordParams: true, recordResult: false })
  private async formatEventViaESPluginV2(
    event: EnvEvent,
    ruleNotice?: RuleNoticeInfo,
  ): Promise<FormattedEvent | null> {
    const triggerEventId = event.metadata!.triggerEventId!;
    const triggerEvent = await this.eventStore!.getEventById(triggerEventId);
    if (!triggerEvent) {
      return null;
    }
    const handler = this.getHandlerForEsType!(triggerEvent.esType);
    if (!handler || !handler.buildNotifyHandlePrompt) {
      return null;
    }

    // 构造 sub-agent result 摘要
    const payload = event.payload as Record<string, unknown> | undefined;
    const subAgentResult = {
      summary:
        typeof payload?.result === "string"
          ? (payload.result as string)
          : typeof payload?.error === "string"
          ? (payload.error as string)
          : "(无结果)",
    };

    // ★ P1 fix: profile 来自 trigger event metadata（ES 生产端落库时写入），
    // 透传给 buildNotifyHandlePrompt → extractReplyContext，让 notify prompt
    // 带上正确的 lark-cli --profile（多 appId 场景否则 99992361）。
    const profile =
      (triggerEvent.metadata?.profile as string | undefined) ?? undefined;

    // ★ 触发渠道归一化：prompt 必须能回答「回复到哪个渠道的哪个会话」
    //   （lark-cli 的 chatId / bounty-im 的邮箱 / timer 的无通道）。
    const channel = this.buildNotifyChannelInfo(triggerEvent, handler, profile);

    const prompt = handler.buildNotifyHandlePrompt({
      notifyEvent: {
        type: event.type,
        taskId: typeof payload?.associatedTaskId === "number" ? (payload.associatedTaskId as number) : undefined,
        description: typeof payload?.description === "string" ? (payload.description as string) : undefined,
        result: typeof payload?.result === "string" ? (payload.result as string) : undefined,
        error: typeof payload?.error === "string" ? (payload.error as string) : undefined,
        subSessionId: typeof payload?.subSessionId === "string" ? (payload.subSessionId as string) : undefined,
        // ★ Task #4568：taskId 缺失时的可读标签来源（CLI handler 用）
        backgroundTaskId:
          typeof payload?.backgroundTaskId === "string"
            ? (payload.backgroundTaskId as string)
            : undefined,
      },
      triggerEvent,
      subAgentResult,
      profile,
      channel,
      ...(ruleNotice ? { ruleNotice } : {}),
    });

    // ★ Task #4042 ESPlugin v2 Phase 7 — postProcessNotifyEvent 后处理钩子
    //
    // notify event 走完 buildNotifyHandlePrompt 后，让 ES 自己决定要不要再额外处理
    // （典型场景：lark-cli handler 把同一条消息同步到所有 per-task 群）。
    //
    // 铁律：
    //   - fire-and-forget（永不抛；实现方必须 swallow 所有异常）
    //   - 不阻塞主 agent（异步调用，不 await 进 formatted 流程）
    //   - 不实现时（handler.postProcessNotifyEvent undefined）自动 skip
    if (handler.postProcessNotifyEvent) {
      const notifyEventForHook = {
        type: event.type,
        taskId: typeof payload?.associatedTaskId === "number" ? (payload.associatedTaskId as number) : undefined,
        description: typeof payload?.description === "string" ? (payload.description as string) : undefined,
        result: typeof payload?.result === "string" ? (payload.result as string) : undefined,
        error: typeof payload?.error === "string" ? (payload.error as string) : undefined,
      };
      // ★ Bug #4035/#4038/#4039 修复：从权威 task↔chat 绑定解析精确投递目标
      // （task.context.larkPerTaskChatId），替代旧的模糊群名搜索。解析不到就传
      // 空数组 → handler 不镜像（宁可漏发，不可串群）。
      //
      // ★ Review P1 修复：解析 + 投递**整体**放进 setTimeout，保持
      // fire-and-forget 语义 —— 不能在 formatEvent 主流程里 await 解析（否则
      // 1~8 次 getTask DB 查询会阻塞订阅回调 / 事件消费循环）。
      // setTimeout(0) 让 hook 完全脱离 caller 的 await 栈：
      //   - 不阻塞主 agent 处理 notify event
      //   - 任何 reject 都不会触发 unhandledRejection
      //   - 测试里 handler.handleNotifyEventForTest 返回前 hook 还未执行
      setTimeout(() => {
        void (async () => {
          const resolvedChatIds = await this.resolveNotifyChatIds(
            notifyEventForHook.taskId,
          );
          await handler.postProcessNotifyEvent!({
            notifyEvent: notifyEventForHook,
            triggerEvent,
            subAgentResult,
            formattedPrompt: prompt.promptText,
            profile,
            resolvedChatIds,
          });
        })().catch((err) => {
          console.error(
            `[EventHandler] postProcessNotifyEvent hook failed (swallowed)`,
            err,
          );
        });
      }, 0);
    }

    // ★ 关键修复 #4035/#4038/#4039：chatId/messageId 来自 trigger event，
    // 不是 metadata.replyChannel 或 lastReplyChannel。
    const triggerChatId = (triggerEvent.metadata?.chatId as string) ?? undefined;
    const triggerMessageId =
      (triggerEvent.metadata?.messageId as string) ?? undefined;

    // 保留 trigger_session_id 解析（与老 formatter 一致）
    const triggerSessionId = event?.metadata?.trigger_session_id;

    return {
      message: prompt.promptText,
      envEvent: event,
      triggerSessionId,
      // ★ chatId 来自 trigger event 而不是 fallback 到 replyChannel
      chatId: triggerChatId,
      // 把 systemHint 附到 FormattedEvent（如果未来 hook 想用）
      ...(triggerMessageId ? { triggerMessageId } : {}),
    } as FormattedEvent & { triggerMessageId?: string };
  }

  /**
   * ★ Bug #4035/#4038/#4039 修复：解析 notify 的精确投递目标 chat_id。
   *
   * 权威来源 = `task.context.larkPerTaskChatId`（PerTaskGroupChatPlugin 建群时
   * 写入），而不是 `chat-search "Task <id>"` 模糊群名匹配。子任务自身没有群，
   * 沿 `parent_task_id` 向上找最近的、拥有群的任务（有界 8 层）。
   *
   * 解析失败 / 无绑定 → 返回 []（调用方据此不镜像，绝不模糊投递）。
   */
  private async resolveNotifyChatIds(taskId?: number): Promise<string[]> {
    if (!taskId) return [];
    const taskComp = this.env.getComponent("task") as
      | {
          getTask?: (id: number) => Promise<
            { context?: string; parent_task_id?: number | null } | undefined
          >;
        }
      | undefined;
    if (!taskComp?.getTask) return [];

    const seen = new Set<number>();
    let id: number | undefined = taskId;
    while (id !== undefined && id !== null && !seen.has(id) && seen.size < 8) {
      seen.add(id);
      let task: { context?: string; parent_task_id?: number | null } | undefined;
      try {
        task = await taskComp.getTask(id);
      } catch (err) {
        console.error(
          `[EventHandler] resolveNotifyChatIds: getTask(${id}) failed`,
          err,
        );
        return [];
      }
      if (!task) return [];
      const chatId = parseLarkPerTaskChatId(task.context);
      if (chatId) return [chatId];
      // parent_task_id 归一化：只有正整数才算父任务（0 / 负数 / 非数字视为 root，
      // 避免 `0 ?? undefined` 不兜底导致空转到深度上限才返回 []）。
      const parent = task.parent_task_id;
      id = typeof parent === "number" && parent > 0 ? parent : undefined;
    }
    return [];
  }

  /**
   * 测试用入口：直接给一个 event，跳过 subscribeAll
   *
   * 模拟收到一个 notify event 后完整跑一遍 formatEvent → enqueue → processQueue → onEventWithEnv 链路。
   * 不启动 start() / 不起订阅循环，pure 函数式测试友好。
   */
  async handleNotifyEventForTest(event: EnvEvent): Promise<void> {
    if (this.isStopped) return;
    const formatted = await this.formatEvent(event);
    // 不走 enqueue（enqueue 触发异步 processQueue + session 解析，复杂）。
    // 直接调 onEventWithEnv / onEvent 让测试稳定。
    if (this.onEventWithEnv) {
      await this.onEventWithEnv(formatted);
    } else {
      await this.onEvent(formatted.message);
    }
  }

  /**
   * ★ Task #4486: 计算事件所属的 lane key。
   *
   * 规则（与方案 decision 一致）：
   *   - 有 chatId（飞书事件）        → `chatId`
   *   - 有 triggerSessionId（通知）  → `trigger:<triggerSessionId>`
   *   - 都没有                      → `__default__`
   *
   * `__default__` 保持旧的"单一队列"语义：这类事件共享全局 activeEventSessionId，
   * 若让它们并行会互相竞争该字段（串会话），所以聚成一条 lane 串行。
   */
  private laneKeyFor(item: FormattedEvent): string {
    if (item.chatId) return item.chatId;
    if (item.triggerSessionId) return `trigger:${item.triggerSessionId}`;
    return EventHandler.DEFAULT_LANE_KEY;
  }

  /**
   * 将格式化事件加入队列（per-session lane）
   */
  enqueue(formattedEvent: FormattedEvent): void {
    // 如果已停止，忽略
    if (this.isStopped) {
      return;
    }

    const item: QueueItem = { ...(formattedEvent as QueueItem) };

    // ★ Task #4486: 入队时快照 EnvContext，避免单 worker 异步链 ALS 串味
    //   （后处理的事件会继承第一条事件的 agentContext / messageId）。
    if (!item.envContext) {
      item.envContext = getEnvContext();
    }

    const laneKey = this.laneKeyFor(item);
    const lane = this.lanes.get(laneKey);

    // ★ Task #5062：积压秒级 ack —— 在**入队前**判定「这条消息前面还有没有未处理的」。
    //
    // 判定条件（用户拍板）：
    //   - lane 数组非空（前面还有排队消息）**或**
    //   - 该 lane 正在跑（in-flight）
    //
    // ⚠️ 为什么在入队**前**判：`lane.push(item)` 之后 lane 长度必然 ≥ 1，
    //    那样就分不清「自己是第 1 条」还是「后面还有第 2 条」。
    //
    // ⚠️ 为什么只判本 lane：不同 chat 是不同的对话场景，A 群的忙碌
    //    不该让 B 群的用户收到「正在处理中」（B 群其实没人处理它）。
    const hasPendingBefore = (lane?.length ?? 0) > 0 || this.runningLanes.has(laneKey);

    if (lane) {
      lane.push(item);
    } else {
      this.lanes.set(laneKey, [item]);
    }

    // ★ Task #5062：发 ack（fire-and-forget）。
    //
    // ⚠️ **绝对不要 await**：`telemetrySender` 默认 spawn lark-cli，最长 5s 硬超时。
    //    await 会把事件订阅回调卡住 5s —— 正是 Task #4552 telemetry 踩过的坑。
    //    这里用 `void` + 内部 try/catch 兜底，ack 失败绝不影响 lane 调度。
    if (hasPendingBefore && isPendingAckEligibleEvent(item.envEvent)) {
      void this.sendPendingAck(item, laneKey);
    }

    this.scheduleLane(laneKey);
  }

  /**
   * ★ Task #5062：直发一条「消息已收到，正在处理中」ack。
   *
   * - **rule-based**：不走 agent 主循环（不调 processItem / onEventWithEnv）
   * - **不占执行槽**：不经过 acquireSlot
   * - **fire-and-forget**：调用方用 `void` 触发，不 await
   * - **best-effort**：任何失败都 swallow，绝不影响 lane 调度
   *
   * 复用 `telemetrySender`（现成的 rule-based 直发通道，默认 spawn lark-cli，
   * 测试注入 spy）+ `resolveNoticeTarget`（拿 chatId + profile）。
   */
  private async sendPendingAck(item: QueueItem, laneKey: string): Promise<void> {
    try {
      const target = await this.resolveNoticeTarget(item.envEvent);
      if (!target) {
        // 拿不到目标 → 静默放弃（best-effort）
        return;
      }

      const text = buildPendingAckText();

      // ★ 用户要求：被 ack 消息的完整属性（msgId / timestamp / sender / content）
      //   写进 console 日志（ack 正文只放简短摘要，避免刷屏）。
      this.logPendingAckAttributes(item, target);

      await this.telemetrySender({
        chatId: target.chatId,
        ...(target.profile ? { profile: target.profile } : {}),
        // ★ Task #4568：透传 sink（同 telemetry / 终态回执）
        ...(target.sink ? { sink: target.sink } : {}),
        text,
        // ★ 幂等键：按 (namespace="ack", eventId, chatId) 派生。
        //   与 telemetry（"telemetry"）/ 终态回执（"rule"）**隔离**，
        //   避免三条不同用途的消息共用一个 key 被飞书去重压掉。
        //   `deriveNoticeIdempotencyKey` 已保证 ≤ 50 字符。
        idempotencyKey: deriveNoticeIdempotencyKey(
          "ack",
          item.envEvent.id,
          target.chatId,
        ),
      });
    } catch (err) {
      // best-effort：ack 失败绝不影响 lane 调度 / agent 主流程
      console.error(
        `[EventHandler] pending ack failed (swallowed) lane=${laneKey}`,
        err,
      );
    }
  }

  /**
   * ★ Task #5062：把被 ack 消息的属性写进日志。
   *
   * 用户要求「记录 msgId / timestamp / sender / content」——
   * ack **正文**不带这些（正文只有固定文案，见 `buildPendingAckText`），
   * 完整属性落在这里，便于事后追溯。
   *
   * ⚠️ **不打印用户原文**（DS review MINOR-5）：
   *   `interactive` / `run` 下 stdout 被 opentui 接管（见
   *   interactive-stderr-guard.ts 头注：「opentui 已经接管 stdout … 把输出写进
   *   scrollback」），往 stdout 打用户原文会：① 污染 TUI scrollback
   *   ② 在磁盘日志里留**明文用户原文**。
   *   故这里只打**长度**，不打内容。
   *
   * ⚠️ 用 `console.log`（stdout）而不是 `console.error`：`interactive` / `run`
   *   的 Ink/REPL 独占 stderr 做帧重绘，往 stderr 写会撕坏渲染帧。
   */
  private logPendingAckAttributes(
    item: QueueItem,
    target: TelemetryNoticeTarget,
  ): void {
    const event = item.envEvent;
    const metadata = event?.metadata as Record<string, unknown> | undefined;
    const payload = event?.payload as Record<string, unknown> | undefined;

    const messageId =
      (typeof metadata?.messageId === "string" ? metadata.messageId : undefined) ??
      (typeof payload?.messageId === "string" ? payload.messageId : undefined) ??
      (typeof metadata?.replyChannel === "object" &&
      metadata?.replyChannel !== null &&
      typeof (metadata.replyChannel as { messageId?: unknown }).messageId === "string"
        ? (metadata.replyChannel as { messageId: string }).messageId
        : undefined);

    const senderId = metadata?.senderId;
    const senderType = metadata?.senderType;

    // ★ 只记长度，不记原文（MINOR-5：stdout 被 opentui 接管 + 磁盘留明文）
    //
    // ⚠️ 口径说明（DS review MINOR-1）：`item.message` 是**格式化后的完整 prompt**
    //   （含 system hint + 信封 JSON），**不是**用户输入原文的长度。
    //   这里只作为「这条消息有多大」的量级参考，不等于用户字数。
    const promptLength =
      typeof item.message === "string" ? item.message.length : 0;

    console.log(
      `[EventHandler] pending ack sent` +
        ` chatId=${target.chatId}` +
        ` messageId=${messageId ?? "-"}` +
        ` eventId=${event?.id ?? "-"}` +
        ` timestamp=${event?.timestamp ?? "-"}` +
        ` sender=${senderId ?? "-"}/${senderType ?? "-"}` +
        ` promptLength=${promptLength}`,
    );
  }

  /**
   * ★ Task #4486: 队列中未被处理完的事件数（含 in-flight）。
   *
   * 与旧语义对齐：旧实现一次只 shift 一条，`getQueueLength()` 反映"还没处理完"。
   * 现在多 lane 并行，"处理中"的 item 已离开 lane 数组，所以要额外把
   * in-flight 计数加回来，否则调用方会看到"队列已空但其实还在跑"。
   */
  getQueueLength(): number {
    let total = this.legacyQueue.length + this.inFlightCount;
    for (const lane of this.lanes.values()) {
      total += lane.length;
    }
    return total;
  }

  /**
   * 检查队列是否为空（跨所有 lane 聚合，含 in-flight）
   */
  isQueueEmpty(): boolean {
    return this.getQueueLength() === 0;
  }

  /**
   * ★ Task #4486: 检查某 session lane 是否空闲（没有事件正在处理）。
   *
   * @param laneKey chatId / `trigger:<sessionId>` / `"__default__"`
   */
  isSessionIdle(laneKey: string): boolean {
    return !this.runningLanes.has(laneKey);
  }

  /**
   * ★ Task #4486: 当前正在处理的 lane key 列表（诊断 / 测试用）。
   */
  getRunningLaneKeys(): string[] {
    return Array.from(this.runningLanes);
  }

  /**
   * ★ Task #4486: 调度某 lane。
   *
   * - lane 已有 runner（runningLanes 命中）→ 直接返回，runner 的 while 循环
   *   会自然拾取新入队的 item（同 lane 严格 FIFO）
   * - lane 空闲 → 启动 runner
   */
  private scheduleLane(laneKey: string): void {
    if (this.isStopped) return;
    if (this.runningLanes.has(laneKey)) return;

    this.runningLanes.add(laneKey);
    // 记录 promise 链尾，供 processQueue() / 测试 await
    //
    // ★ Task #4486: runLane 是 fire-and-forget —— 它内部已对 processItem 兜底，
    //   但 resolveSessionForItem / acquireSlot / waitForIdle 仍可能抛（DB 故障等）。
    //   没有 catch 会变成 unhandled rejection（Node 默认打印 + 可能崩进程）。
    const tail = this.runLane(laneKey)
      .catch((err) => {
        console.error(`[EventHandler] lane ${laneKey} 处理异常:`, err);
      })
      .finally(() => {
        // ★ Task #4515 (M1 修复): 先清 runner 标记，再**重查残留**并重新调度。
        //
        //   旧实现的静默窗口：`runLane()` 末尾 `lanes.delete(key)` 早于这里的
        //   `runningLanes.delete(key)`。落在这个窗口里的 `enqueue()` 会因
        //   `scheduleLane` 的 `runningLanes.has()` 早退而**无人调度** —— item
        //   一直躺在 lanes 里，直到下一条同 lane 事件"顺带"把它带走（自愈 =
        //   无时限挂起）。
        //
        //   修复：收尾时若 lane 还有残留，主动重新调度。`isStopped` 由
        //   `scheduleLane()` 内部挡住，所以 stop() 语义不受影响。
        this.runningLanes.delete(laneKey);
        this.laneTails.delete(laneKey);

        const rest = this.lanes.get(laneKey);
        if (rest && rest.length > 0) {
          this.scheduleLane(laneKey);
        }
      });
    this.laneTails.set(laneKey, tail);
  }

  /**
   * ★ Task #4486: 单条 lane 的处理循环。
   *
   * 同 lane 严格 FIFO + 不重入；跨 lane 由 maxConcurrentSessions 槽位限流。
   */
  private async runLane(laneKey: string): Promise<void> {
    while (!this.isStopped) {
      const lane = this.lanes.get(laneKey);
      if (!lane || lane.length === 0) {
        break;
      }

      // 1) 解析该 item 的 sessionId（门禁与路由都需要）
      //
      // ★ Task #4515 (L2): 解析也要跑在**本 item 的 EnvContext** 下。
      //   原来这一步在 ALS 重入（processItem 里的 runWithEnvContextAsync）之前，
      //   于是它继承的是"启动该 lane 的第一条事件"的 EnvContext —— 这两步里产生
      //   的 trace / sessionId 归属会张冠李戴（不影响 agent 执行，但污染可观测性，
      //   且 session 解析失败回飞书时拿到的 messageId 可能是别人的）。
      const head = lane[0];
      const sessionId = await runWithEnvContextAsync(head.envContext, () =>
        this.resolveSessionForItem(laneKey, head),
      );

      // Guard: stop() during async resolution
      if (this.isStopped) break;

      // 1.5) ★ Task #4515 (H2 根治): 把 lane 归并到 **sessionId 命名的 lane**。
      //
      //   问题：lane key 原本是 transport id（`chatId` / `trigger:<sid>`），而
      //   session 是 storage id —— 两个 key 空间不 1:1。最典型的生产可达路径：
      //   `task.background.*` 通知**无 replyChannel** → chatId=undefined →
      //   lane `trigger:oc_A`，但经"优 2/优 3"解析到的 session 就是 `oc_A`，
      //   与 chat lane `oc_A` 撞车 → 两条 lane 并发写同一 session。
      //
      //   修复：一旦解析出 sessionId，就把整条 lane 迁到 `sessionId` 这个
      //   **canonical key** 上。此后所有解析到同一 session 的事件（无论来自哪个
      //   transport key）都排进**同一条 lane**，lane ↔ session 结构性 1:1。
      //
      //   归并方式：把本 lane 的残留 item（含队首）整体搬到 canonical lane 的
      //   **队尾**（canonical lane 里已有的 item 更早入队，顺序正确），删掉本
      //   lane 条目，再交给 canonical lane 的 runner 接管，本 runner 退出。
      //   `runningLanes` / `laneTails` 的清理由本 runner 的 finally 按自己的
      //   key 完成，不需要任何 re-key 簿记。
      const canonicalKey = sessionId ?? laneKey;
      if (canonicalKey !== laneKey) {
        const mine = this.lanes.get(laneKey) ?? [];
        if (mine.length > 0) {
          const target = this.lanes.get(canonicalKey);
          if (target) {
            target.push(...mine);
          } else {
            this.lanes.set(canonicalKey, mine);
          }
          this.lanes.delete(laneKey);
          // 唤醒 canonical lane 的 runner（已有 runner 时是幂等 no-op）
          this.scheduleLane(canonicalKey);
        }
        return;
      }

      // 2) per-session 空闲门禁
      //
      // ★ Task #4486: 先等门禁、**再**抢槽位。反过来的话，一个"自己 session 正忙"
      //   的 lane 会白白占着并发槽位等门禁 —— 4 个这样的 lane 就能把所有槽位卡死，
      //   让第 5 个本来空闲的 session 永远排不上（变相的 head-of-line blocking）。
      await this.waitForIdle(sessionId ?? laneKey);
      if (this.isStopped) break;

      // 3) ★ Task #4515 (H2 兜底): 原子声明该 session 的独占权。
      //
      //   `waitForIdle()` 是 check-then-act：检查通过到真正开始之间有窗口，
      //   两个 lane 解析到**同一 session** 时会双双通过（H2 实测）。claimSession
      //   按 sessionKey 串成链，保证"同一 session 同一时刻只有一轮在跑"。
      //   注意 claim 的 key 用 sessionId（不是 laneKey）—— 这才是 1:1 的身份。
      //
      //   ★ 顺序：claim **在** acquireSlot **之前**。反过来的话，一个在等同
      //   session 的 lane 会白占一个并发槽位（同 waitForIdle 先于 acquireSlot 的
      //   理由）—— 4 个 lane 撞同一 session 就能卡死所有槽位。
      const claimKey = sessionId ?? laneKey;
      const releaseClaim = await this.claimSession(claimKey);
      if (this.isStopped) {
        releaseClaim();
        break;
      }

      // 3.5) 抢占并发槽位（限制同 workdir 并发写 / provider 限流）
      await this.acquireSlot();
      if (this.isStopped) {
        releaseClaim();
        this.releaseSlot();
        break;
      }

      try {

        // 4) 出队（此刻才 shift，保证 stop() 时 item 不丢在半路）
        //
        // ★ Task #5037-B：出队时**合并同 lane 剩余的未处理消息**。
        //
        //   用户拍板：「将未被处理的同一个飞书 session 的消息都合并处理」
        //   +「trigger event 可以记录最近的一个」。
        //
        //   为什么在**出队这一刻**合并（而不是入队时 debounce）：
        //     - 入队时还不知道这些消息会积压多久；agent 一空闲就立刻处理
        //       剩余的全部 → 用户体感延迟最低
        //     - 设固定时间窗会引入「窗口外的消息怎么办」的边界 bug
        //       （窗口内合并了、窗口外又来一条 → 又一次 ReAct）
        //
        //   合并后的 item：
        //     - `message`   = N 条按**时间正序**拼接（后一条可能是对前一条的补充）
        //     - `envEvent`  = **最后一条**的 envEvent（trigger event 锚点 = 最新那条）
        //     - `envContext`= **最后一条**的 envContext（ALS 不串味）
        const item = this.takeNextBatch(lane);
        if (!item) break;

        this.inFlightCount++;
        try {
          await this.processItem(item, sessionId);
        } finally {
          this.inFlightCount--;
        }
      } finally {
        releaseClaim();
        this.releaseSlot();
      }
    }

    // lane 空了 → 清理 map 条目（避免 lane 无限增长）
    const rest = this.lanes.get(laneKey);
    if (!rest || rest.length === 0) {
      this.lanes.delete(laneKey);
    }
  }

  /**
   * ★ Task #5037-B：从 lane 取出下一批消息并合并成**一个** item。
   *
   * - lane 空 → 返回 undefined（调用方 break）
   * - lane 只有 1 条 → **原样返回**该 item（合并 1 条 ≡ 不合并，行为与旧版等价）
   * - lane 有 N 条 → 一次性 shift 全部，合并成 1 个 item
   *
   * 合并结果：
   *   - `message`    = N 条按**入队顺序**（= 时间正序）拼接
   *   - `envEvent`   = **最后一条**的 envEvent（trigger event 锚点 = 最新那条）
   *   - `envContext` = **最后一条**的 envContext（ALS 隔离不串味）
   *   - 其余字段（chatId / triggerSessionId / sessionResolved / resolvedSessionId）
   *     沿用**最后一条** —— session 解析在 runLane 步骤 1 已完成队首的解析，
   *     合并后不需要重新解析。
   */
  private takeNextBatch(lane: QueueItem[]): QueueItem | undefined {
    const first = lane.shift();
    if (!first) return undefined;

    // 只有 1 条 → 原样返回（不改变既有行为）
    if (lane.length === 0) return first;

    // ★★ 只合并**真实用户消息**（同一飞书 session 的连续发言）。
    //
    //   内部事件（task.background.* 通知等）**绝不能**被合并：
    //   - Task #4515 (H2) 的核心不变量是「lane ↔ session 结构性 1:1」，
    //     不同的 transport key（chat lane / trigger lane）归并到同一 session
    //     lane 后仍要**逐条串行**处理（每条一次 agent run）。
    //     合并它们会破坏该不变量 → event-handler-lane-session.test.ts 变红。
    //   - 通知类事件每条都携带独立结果（result / error），合并会丢信息。
    //
    //   所以：队首是内部事件 → 只取它自己；队首是用户消息 → 只合并连续的
    //   用户消息，遇到内部事件就停（不跨越）。
    if (!isPendingAckEligibleEvent(first.envEvent)) {
      return first;
    }

    const batch: QueueItem[] = [first];
    while (lane.length > 0) {
      const next = lane[0];
      if (!isPendingAckEligibleEvent(next.envEvent)) break;
      batch.push(lane.shift() as QueueItem);
    }

    // ★ trigger event 取最后一条（用户拍板）
    const last = batch[batch.length - 1];
    const merged: QueueItem = {
      ...last,
      message: buildMergedMessage(batch),
      // ★ DS review MINOR-3：session 解析缓存**继承队首**（first）。
      //
      //   实际执行路径不受影响 —— runLane 在步骤 1 用**队首**解析出 sessionId
      //   并显式传给 processItem(item, sessionId)，merged 不会被重新解析。
      //   但 `{...last}` 会把 sessionResolved / resolvedSessionId 覆盖成 last 的
      //   undefined（last 没被解析过）→ 将来若有代码读 item.resolvedSessionId
      //   做回复路由 / 去重，会拿到 undefined。显式继承队首的缓存，固化契约。
      sessionResolved: first.sessionResolved,
      resolvedSessionId: first.resolvedSessionId,
    };

    return merged;
  }

  /**
   * ★ Task #4486: 按 item 解析 sessionId（保持旧的跨 chat 隔离语义）。
   *
   * - chatId 存在（飞书事件）→ chat-keyed session（lane 内缓存，一次 list/create）
   * - 否则 → ensureActiveSession(triggerSessionId)
   */
  private async resolveSessionForItem(laneKey: string, item: QueueItem): Promise<string | null> {
    // ★ Task #4515: 已解析过（lane 归并后新 runner 接管同一 item）→ 直接复用
    if (item.sessionResolved) {
      return item.resolvedSessionId ?? null;
    }
    const resolved = await this.resolveSessionForItemUncached(laneKey, item);
    item.sessionResolved = true;
    item.resolvedSessionId = resolved;
    return resolved;
  }

  /** @see resolveSessionForItem —— 真正做解析的部分（不含结果缓存） */
  private async resolveSessionForItemUncached(
    laneKey: string,
    item: QueueItem,
  ): Promise<string | null> {
    // ★ Task #4568：`cli:<sessionId>` **不是真 chat**，绝不能走 ensureChatSession()。
    //
    //   设计取舍（设计文档 §5.2 决策③）：
    //   - 保留 `cli:` 前缀 ⇒ lane 按 CLI session 隔离（不与真实 oc_xxx 群撞车）
    //   - **但 session 必须复用原 sid**，否则通知会跑在一个「新建的空 session」里
    //     （上下文割裂：agent 看不到用户之前说过什么，用户也看不到通知挂在哪个会话）。
    //
    //   若走 ensureChatSession('cli:xxx')：
    //     sessionComponent.list(metadata:{chatId:'cli:xxx', type:'lark-chat'}) → 空
    //     → create({ id: 'cli:xxx' })  ← 造出一个假 session（本测试 ☓ 会抓到）
    if (item.chatId && this.sessionComponent) {
      const cliSid = parseCliSessionChatId(item.chatId);
      if (cliSid) {
        try {
          const existing = await this.sessionComponent.get(cliSid);
          if (existing) return existing.id;
        } catch {
          // get 失败（DB 抖动）→ 落到下面的 ensureActiveSession 兜底
        }
        // 原 session 找不到：宁可复用父 session，也不新建 `cli:xxx` 假 session
        return this.ensureActiveSession(
          item.triggerSessionId,
          item.createTriggerSessionIfMissing,
        );
      }
    }

    // chat lane：laneKey 就是 chatId，可安全缓存
    if (item.chatId && this.sessionComponent) {
      const cached = this.chatSessionCache.get(item.chatId);
      if (cached) return cached;

      let resolved = await this.ensureChatSession(item.chatId);
      if (!resolved) {
        // chat session 解析失败 → fallback 到非 lark 路径
        console.warn(
          `[EventHandler] Failed to ensure chat-keyed session (chatId=${item.chatId}), ` +
          `falling back to trigger_session_id path`,
        );
        resolved = await this.ensureActiveSession(
          item.triggerSessionId,
          item.createTriggerSessionIfMissing,
        );
      } else {
        this.chatSessionCache.set(item.chatId, resolved);
      }
      return resolved;
    }

    return this.ensureActiveSession(
      item.triggerSessionId,
      item.createTriggerSessionIfMissing,
    );
  }

  /**
   * ★ Task #4486: 处理单个 item（已出队）。
   *
   * 关键：用 item 快照的 EnvContext 重入 ALS，避免多事件共享同一段
   * ALS 继承链导致 agentContext / messageId 串味。
   */
  private async processItem(item: QueueItem, sessionId: string | null): Promise<void> {
    // 注入 eventSessionId 到 formatted event
    if (sessionId) {
      item.eventSessionId = sessionId;
    }

    try {
      await runWithEnvContextAsync(item.envContext, async () => {
        // 优先使用 onEventWithEnv（包含完整事件信息）
        if (this.onEventWithEnv) {
          await this.onEventWithEnv(item);
          return;
        }
        // 降级使用 onEvent（仅消息）
        await this.onEvent(item.message);
      });
    } catch (error) {
      console.error(`[EventHandler] 处理事件失败:`, error);

      // ★ Task #4418：不允许静默。
      //
      // QueryExecutor 已经是主兜底，但「还没走到 QueryExecutor 就失败」的
      // 路径（session 解析 / 事件分发 / formatter）同样要让飞书侧知道，
      // 否则用户只会在那边一直等。同一 messageId 会被去重层吸收，
      // 已在 QueryExecutor 回复过的不会重复发送。
      try {
        await notifyReactFailure({
          error,
          envEvent: item.envEvent,
          sessionId: sessionId ?? undefined,
        });
      } catch (notifyErr) {
        // notifyReactFailure 自身承诺不抛；这里再兜一层，绝不影响队列循环
        console.error(`[EventHandler] 失败说明回飞书异常:`, notifyErr);
      }
    }
  }

  /**
   * 处理队列中的消息
   *
   * Session 管理 (Task #1766 修复 + Task #4486 per-session 化):
   * - session 在 lane 内解析并缓存，不同 chat/trigger 各解析各的，杜绝跨 chat 污染
   * - active session 跨批次复用（不清除），只有 stop() 才清除
   *
   * ★ Task #4486: 本方法现在负责：
   *   1. 把历史 `queue`（legacyQueue）里的 item 迁移进各自 lane（向后兼容）
   *   2. 触发所有 lane 调度
   *   3. 返回一个「所有 lane 都 drain 完」的 promise（方便测试 await）
   */
  private async processQueue(): Promise<void> {
    if (this.isStopped) return;

    // 1) 迁移 legacy queue（旧测试/调用方直接 push 进来的）
    if (this.legacyQueue.length > 0) {
      const pending = this.legacyQueue.splice(0, this.legacyQueue.length);
      for (const item of pending) {
        if (!item.envContext) {
          item.envContext = getEnvContext();
        }
        const laneKey = this.laneKeyFor(item);
        const lane = this.lanes.get(laneKey);
        if (lane) lane.push(item);
        else this.lanes.set(laneKey, [item]);
      }
    }

    // 2) 给所有有积压的 lane 起 runner
    for (const [laneKey, lane] of Array.from(this.lanes.entries())) {
      if (lane.length > 0) this.scheduleLane(laneKey);
    }

    // 3) 等待当前所有 lane drain 完
    const tails = Array.from(this.laneTails.values());
    if (tails.length > 0) {
      await Promise.all(tails.map((t) => t.catch(() => undefined)));
    }
  }

  /**
   * ★ Task #4486: 抢占并发槽位（maxConcurrentSessions 限流）
   */
  private async acquireSlot(): Promise<void> {
    if (this.activeSlots < this.maxConcurrentSessions) {
      this.activeSlots++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.slotWaiters.push(resolve);
    });
    this.activeSlots++;
  }

  /**
   * ★ Task #4486: 释放并发槽位并唤醒等待者
   */
  private releaseSlot(): void {
    if (this.activeSlots > 0) this.activeSlots--;
    const next = this.slotWaiters.shift();
    if (next) next();
  }

  // ==========================================================================
  // Event Source Shared Session 管理
  // ==========================================================================

  /**
   * 确保有活跃的事件处理 session —— 仅非飞书事件路径
   *
   * ⚠️ 飞书事件 (有 chatId) 不再走这里: processQueue 会按 item 自身的 chatId
   *    直接调 ensureChatSession, 保证 "不同飞书会话 → 不同 session" 的结构性隔离。
   *    这里只处理非飞书事件 (task 通知 / bounty 等, 无 chatId)。
   *
   * 优先级:
   * - 优 0b (★ 跨-chat 隔离): 本 item 自带的 triggerSessionId 优先于全局缓存
   *   命中同一 session 时直接复用，不同则强制按 triggerSessionId 解析
   * - 优 1 (跨批次复用): activeEventSessionId 已存在 → 复用（仅当 item 无 triggerSessionId）
   * - 优 2: triggerSessionId → get(parent) + setActiveSession
   * - 优 3: sessionComponent.getActiveSessionId() → REPL global active
   * - 优 4 (fallback): create() 新 session + setActiveSession
   *
   * 注意:
   * - get() 失败 / 父 session 找不到 / 抛错 都 fallback 到下一档
   * - 保持向后兼容：所有 fallback 路径都走原 create 逻辑
   * - 跨批次复用 (优 1)：调用方 processQueue 不再 clearActiveSession()
   *
   * @param triggerSessionIdOverride 当前 item 的 triggerSessionId（processQueue
   *        按 item 传入，避免从 queue 扫描到别的事件的 trigger）。省略时回退到
   *        扫描 queue（向后兼容旧调用）。
   * @returns session ID 或 null
   */
  @TracedAs("cli.event-handler.ensureActiveSession", { recordParams: true, recordResult: true })
  private async ensureActiveSession(
    triggerSessionIdOverride?: string,
    createTriggerSessionIfMissing?: boolean,
  ): Promise<string | null> {
    if (!this.sessionComponent) return null;

    // ★ Bug fix (#4038/#4035 跨 chat 污染):
    //   之前的实现是"activeEventSessionId 存在就无条件返回"，而 activeEventSessionId
    //   是整个 EventHandler 的进程级字段（跨批次、跨群共享）。只要某个群的通知先把
    //   它设成 session A（例如用户在 #3993 触发的 sub-agent 通知），后续所有
    //   task.background.* 通知——哪怕自身 triggerSessionId 是另一个群 B（#3996）——
    //   都会被路由到 A，出现"#3996 的任务通知跑进 #3993 会话"的串会话。
    //
    //   修复：本 item 明确携带 triggerSessionId 时，用 **triggerSessionId 维度**的
    //   缓存（resolvedSessionByTrigger）复用——同 trigger 的多个 batch 复用同一
    //   session，不同 trigger 各解析各的，互不劫持；且解析结果（含 create 出的新
    //   session）会被缓存，避免"父 session 找不到 → 每次都 create 新 session"的
    //   重复创建。无 triggerSessionId 时才回落到跨批次复用（优 1）。
    if (triggerSessionIdOverride) {
      const cached = this.resolvedSessionByTrigger.get(triggerSessionIdOverride);
      if (cached) {
        return cached;
      }
      // 未命中缓存 → 继续按 triggerSessionId 解析（优 2/3/4），解析后写入缓存
    } else if (this.activeEventSessionId) {
      return this.activeEventSessionId;
    }

    // 优 2: triggerSessionId 复用父 session (commit 29c9ac25)
    const triggerSessionId = triggerSessionIdOverride
      ?? this.queue
        .map(item => item.triggerSessionId)
        .find((id): id is string => !!id);

    if (triggerSessionId) {
      try {
        const existing = await this.sessionComponent.get(triggerSessionId);
        if (existing) {
          // Guard: if stop() was called during session lookup, discard
          if (this.isStopped) {
            return null;
          }
          // ★ Task #4815：独立 session 模式（createSessionIfMissing）
          //   **不写** activeEventSessionId —— 该字段是进程级的"事件共享 session"，
          //   会被无 trigger 的事件（lark-cli / bounty 等）在优 1 路径命中，
          //   导致那些事件被劫持进 timer 的独立 session（用户主会话再也收不到）。
          //   独立 session 只走 trigger 维度缓存（resolvedSessionByTrigger）。
          if (!createTriggerSessionIfMissing) {
            this.activeEventSessionId = existing.id;
            this.cacheResolvedSession(triggerSessionIdOverride, existing.id);
            // ⚠️ Task #1766 增强：让 REPL 也能看到父 session
            // 这样处理完通知后，REPL 用户输入也能继承父 session 的对话上下文
            await this.sessionComponent.setActiveSession(existing.id);
          } else {
            this.cacheResolvedSession(triggerSessionIdOverride, existing.id);
          }
          return existing.id;
        }

        // ★ Task #4815：触发方显式要求「session 不存在就按该 ID 创建」。
        //
        //   场景：timer schedule 模式（每日总结）需要跑在**独立 session**，
        //   而不是 fallback 到 REPL 主会话。事件 metadata 带
        //   `createSessionIfMissing: true` + `trigger_session_id: <id>`，
        //   这里按该 ID 创建 → 后续同 trigger 的事件都复用（trigger 维度缓存）。
        //
        //   未声明该标记时保持既有 fallback 行为（优 3 主会话 / 优 4 随机新建）。
        if (createTriggerSessionIfMissing) {
          const createdForTrigger = await this.createTriggerSession(triggerSessionId);
          if (!createdForTrigger) {
            console.error(
              `[EventHandler] Failed to create independent session ${triggerSessionId}; ` +
                `event will fall back to the active session.`,
            );
          }
          if (createdForTrigger) {
            // ⚠️ 不写 activeEventSessionId / 不调用 setActiveSession ——
            //   独立 session 不应污染 REPL 主会话，也不应劫持其它事件源的事件。
            this.cacheResolvedSession(triggerSessionIdOverride, createdForTrigger);
            return createdForTrigger;
          }
        }

        // Fallback: 父 session 找不到, log warning 然后走优 3
        if (createTriggerSessionIfMissing) {
          // ★ M-10：独立 session 模式下降级 —— 与"父 session 不存在"区分开，
          //   便于排障时识别「独立 session 创建失败，事件退回主会话」。
          console.warn(
            `[EventHandler] Independent session ${triggerSessionId} could not be created, ` +
              `falling back to global active session (independent-session mode degraded)`,
          );
        } else {
          console.warn(
            `[EventHandler] Parent session ${triggerSessionId} not found, trying global active session`,
          );
        }
      } catch (error) {
        // Fallback: get() 抛错也走优 3，不阻断事件处理
        console.error(
          `[EventHandler] Failed to lookup parent session ${triggerSessionId}:`,
          error,
        );
      }
    }

    // 优 3 (Task #1766 新增): 复用 sessionComponent 的 global active session
    // REPL 启动时 sessionManager.init() 已经 setActiveSession 到 REPL session，
    // 这里飞书/bounty 事件可以复用同一个 session，共享对话上下文。
    try {
      const activeId = this.sessionComponent.getActiveSessionId();
      if (activeId) {
        const existing = await this.sessionComponent.get(activeId);
        if (existing) {
          // Guard: if stop() was called during session lookup, discard
          if (this.isStopped) {
            return null;
          }
          this.activeEventSessionId = existing.id;
          this.cacheResolvedSession(triggerSessionIdOverride, existing.id);
          return existing.id;
        }
      }
    } catch (error) {
      console.error(`[EventHandler] Failed to lookup global active session:`, error);
    }

    // 优 4 fallback: 原 create 逻辑（保持向后兼容）
    const created = await this.createNewEventSession();
    // ★ 缓存 create 出来的新 session：否则父 session 缺失时，
    //   同一 triggerSessionId 的下一个 batch 会再次 create（session 爆炸 / 丢上下文）。
    this.cacheResolvedSession(triggerSessionIdOverride, created);
    return created;
  }

  /**
   * ★ Task #4815：按指定 ID 创建 session（trigger session 不存在时）
   *
   * 用于让事件路由到**独立 session**（如"每日总结"专属 session）：
   * 事件 metadata 带 `createSessionIfMissing: true` + `trigger_session_id: <id>`，
   * 若该 session 不存在 → 按该 ID 创建；后续同 trigger 的事件复用（trigger 维度缓存）。
   *
   * 不调用 setActiveSession —— 独立 session 不应污染 REPL 主会话的 active 指针。
   *
   * @param sessionId 目标 session ID
   * @returns 创建出的 session ID；失败返回 null
   */
  @TracedAs("cli.event-handler.createTriggerSession", { recordParams: true })
  private async createTriggerSession(sessionId: string): Promise<string | null> {
    if (!this.sessionComponent) return null;
    try {
      const session = await this.sessionComponent.create({
        id: sessionId,
        title: `Event Session ${sessionId}`,
        metadata: {
          type: "event-source",
          triggerSessionId: sessionId,
        },
      });
      if (this.isStopped) {
        return null;
      }
      return session.id;
    } catch (error) {
      // create 失败（如 ID 冲突）→ 尝试再 get 一次（可能已被并发创建）
      console.error(
        `[EventHandler] Failed to create trigger session ${sessionId}:`,
        error,
      );
      try {
        const existing = await this.sessionComponent.get(sessionId);
        if (existing) return existing.id;
      } catch {
        // ignore
      }
      return null;
    }
  }

  /**
   * 找/建 chat-keyed session（飞书事件专用）
   *
   * 实现原理：
   * 1. 用 list({ filter: { metadata: { chatId, type: 'lark-chat' } } }) 查已有 session
   *    - metadata filter 避免误中其他用途的 session
   * 2. 找到 → 返回该 session.id
   * 3. 找不到 → create({ id: chatId, metadata: { chatId, type: 'lark-chat' } })
   *    - 用 chatId 直接作为 session id，方便后续 get(chatId) 直接定位
   * 4. create 失败（id 冲突等）→ 用 get(chatId) 作为 fallback
   *
   * 调用者：ensureActiveSession 优 2
   *
   * 不调用 setActiveSession（避免污染 REPL global active session）
   *
   * @param chatId 飞书会话/群组 ID (e.g., "oc_xxx")
   * @returns session ID 或 null
   */
  @TracedAs("cli.event-handler.ensureChatSession", { recordParams: true })
  private async ensureChatSession(chatId: string): Promise<string | null> {
    if (!this.sessionComponent) return null;

    // 1) 查找已有的 chat-keyed session
    try {
      const existing = await this.sessionComponent.list({
        filter: { metadata: { chatId, type: "lark-chat" } },
        limit: 1,
      });
      if (existing.length > 0) {
        return existing[0].id;
      }
    } catch (error) {
      console.error(`[EventHandler] Failed to list chat-keyed sessions (chatId=${chatId}):`, error);
      // 不直接 return null — 继续尝试 create，可能数据库临时故障
    }

    // 2) 找不到 → create 新 session，用 chatId 作为 session id
    try {
      const created = await this.sessionComponent.create({
        id: chatId,
        title: `Lark Chat ${chatId}`,
        metadata: {
          chatId,
          type: "lark-chat",
        },
      });
      // Guard: if stop() was called during session creation, discard
      if (this.isStopped) {
        return null;
      }
      return created.id;
    } catch (createErr) {
      // 3) create 失败（id 冲突等）→ 用 get(chatId) 作为 fallback
      console.warn(
        `[EventHandler] Failed to create chat-keyed session (chatId=${chatId}), ` +
        `trying get(): ${String(createErr)}`,
      );
      try {
        const fallback = await this.sessionComponent.get(chatId);
        if (fallback) return fallback.id;
      } catch (getErr) {
        console.error(`[EventHandler] get() fallback also failed (chatId=${chatId}):`, getErr);
      }
      return null;
    }
  }

  /**
   * 创建新事件处理 session
   *
   * 这是一个 fallback 路径：
   * - 没有 sessionComponent 时不调用
   * - 没有 triggerSessionId 时调用
   * - 有 triggerSessionId 但 get() 失败/父 session 找不到时调用
   * - sessionComponent.getActiveSessionId() 为空时调用
   *
   * Task #1766: 创建后调 setActiveSession 让 REPL 也能看到这个 session。
   */
  private async createNewEventSession(): Promise<string | null> {
    try {
      const session = await this.sessionComponent!.create({
        title: `Event Session - ${new Date().toLocaleString()}`,
      });
      // Guard: if stop() was called during session creation, discard the session
      if (this.isStopped) {
        this.activeEventSessionId = null;
        return null;
      }
      this.activeEventSessionId = session.id;
      // ⚠️ Task #1766: fallback 创建的也设为 global active
      // 让 REPL 用户后续输入也能继续用这个 session
      await this.sessionComponent!.setActiveSession(session.id);
      return session.id;
    } catch (error) {
      console.error(`[EventHandler] 创建事件 session 失败:`, error);
      return null;
    }
  }

  /**
   * 清除活跃的事件处理 session
   */
  private clearActiveSession(): void {
    this.activeEventSessionId = null;
    this.resolvedSessionByTrigger.clear();
    // ★ Task #4515 (L1): chatId → sessionId 缓存也必须清。
    //   原来只清 trigger 维度缓存，chatSessionCache 会跨 stop()/start() 存活：
    //   若期间该 chat 的 session 被删除或换了，后续事件会被路由到**已失效的
    //   sessionId**（写进不存在的会话 / 上下文丢失）。
    this.chatSessionCache.clear();
  }

  /**
   * ★ Bug fix：把「某 triggerSessionId 解析出的 session」写入 trigger 维度缓存。
   * 仅当本 item 带 triggerSessionId 时写入（无 trigger 的路径走 activeEventSessionId）。
   */
  private cacheResolvedSession(
    triggerSessionIdOverride: string | undefined,
    sessionId: string | null,
  ): void {
    if (triggerSessionIdOverride && sessionId) {
      this.resolvedSessionByTrigger.set(triggerSessionIdOverride, sessionId);
    }
  }

  /**
   * 获取当前活跃的事件处理 session ID
   * @returns session ID 或 null
   */
  getActiveEventSessionId(): string | null {
    return this.activeEventSessionId;
  }

  /**
   * 等待 agent 空闲
   */
  private async waitForIdle(sessionId?: string): Promise<void> {
    while (!this.isStopped && !this.isLaneIdle(sessionId)) {
      await this.sleep(this.idleCheckInterval);
    }
  }

  /**
   * ★ Task #4486: per-session 空闲判定。
   *
   * 优先用注入的 `isSessionIdle`（消费端按 session 判 executingSessions）；
   * 未注入时回落全局 `isIdle`（完全向后兼容老行为）。
   *
   * @param sessionId lane 解析出的 sessionId（可能为 null → 用 laneKey）
   */
  private isLaneIdle(sessionId?: string): boolean {
    if (this.isSessionIdleFn && sessionId) {
      return this.isSessionIdleFn(sessionId);
    }
    return this.isIdle();
  }

  /**
   * ★ Task #4515 (H2 兜底): 原子声明某 session 的独占权。
   *
   * 返回 `release`，调用方必须在自己这段工作**结束后**调用它（try/finally）。
   *
   * 实现：把「同步读尾部 + 同步写新尾部」放在同一个同步块里（中间没有 await），
   * 所以并发 claim 一定按调用顺序串成一条链；`await prev` 之后才真正进入临界区。
   * 这与 `waitForIdle()` 的轮询式 check-then-act 不同 —— 后者在"检查通过"和
   * "真正开始"之间有窗口，两个 lane 会同时通过。
   *
   * @param sessionKey 解析出的 sessionId（null 时调用方用 laneKey，保证至少串行）
   */
  private claimSession(sessionKey: string): Promise<() => void> {
    const prev = this.sessionChains.get(sessionKey) ?? Promise.resolve();

    let releaseFn!: () => void;
    const current = new Promise<void>((resolve) => {
      releaseFn = resolve;
    });

    // 同步占位：后来者一定能看到我这条尾部
    const tail = prev.then(() => current);
    this.sessionChains.set(sessionKey, tail);

    return prev.then(() => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        releaseFn();
        // 清理：如果我是最后一条（尾部还是我的 tail），删掉避免 Map 无限增长
        if (this.sessionChains.get(sessionKey) === tail) {
          this.sessionChains.delete(sessionKey);
        }
      };
    });
  }

  /**
   * 睡眠工具函数
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
