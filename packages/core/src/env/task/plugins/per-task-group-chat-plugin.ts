/**
 * @fileoverview PerTaskGroupChatPlugin - 每任务一个独立飞书群聊
 *
 * Task #3945 实现：
 * - task:after.create → 创建群聊（lark-cli im +chat-create）+ 存 chat_id 到 task.context
 * - task:after.update → 发到 task 群聊（task.context.larkPerTaskChatId）
 * - task:operation:after.create → 节流后发到 task 群聊
 * - task:after.complete → 在 task 群聊发"任务完成"摘要
 *
 * 关键修复（Task #3945 claude-minimax 评估 P0）：
 * - P0-1: onAfterUpdate 时 replyChannel fallback 到 task.context.larkPerTaskChatProfile
 * - P0-2: botAppIds 自动从 replyChannel.appId 推导（用户配置可覆盖）
 * - P0-3: 文档明确"方式 A：从 --plugins 移除 LarkCliTaskNotifyPlugin"避免双发
 *
 * 后续修复（Task #XXXX 调试日志 + 新 config 选项）：
 * - requireReplyChannel=false：replyChannel 缺失时降级用 fallbackProfile 创建群聊
 * - disableSubTaskSkip=true：sub-task 也建群聊
 * - hasTaskUpdater()：诊断方法，检查 taskUpdater 是否注入
 * - 完整诊断日志：每个 skip 分支都输出原因 + 修复建议（ROY_TASK_NOTIFY_DEBUG=1 可见）
 *
 * Task #3987（用户方案 A+B 合并）新增字段：
 * - defaultInviteUserIds：始终邀请的用户列表（不会自动推导 sender）
 * - inviteUserIds：动态列表，可用 "sender" 占位符从 replyChannel 自动推导
 * - 两个字段 union 后去重，得到最终邀请列表
 *
 * ★ 关键约束：setTaskUpdater() 必须由 EventSource handler 注入（DI 模式）。
 *   event-source-handlers.ts:registerPluginHooks 检测到 plugin.setTaskUpdater 存在时
 *   会自动注入 taskComponent.updateTask 包装函数。
 *   未注入时 chat_id 只更新 in-memory，DB 没持久化 → 下次 AFTER_UPDATE silently skip。
 *
 * @example
 * ```typescript
 * // 在 EventSource 中注册（自动注入 setTaskUpdater）
 * import { createPerTaskGroupChatPlugin } from "./per-task-group-chat-plugin";
 *
 * const hook = createPerTaskGroupChatPlugin({
 *   pluginName: "PerTaskGroupChatPlugin",
 *   sourceId: "es-lark-1",
 *   botAppIds: ["cli_xxx"],  // 可选，留空则从 replyChannel.appId 自动推导
 *   requireReplyChannel: false,  // 默认 true；CLI/测试场景可设 false
 *   fallbackProfile: "default", // requireReplyChannel=false 时降级用此 profile
 *   defaultInviteUserIds: ["ou_admin_xxx"],  // ★ 始终邀请（如 admin / 共享账号）
 *   inviteUserIds: ["sender"],              // ★ 动态占位（自动推导当前 sender）
 * });
 * ```
 *
 * @调试日志
 * - 启用 `ROY_TASK_NOTIFY_DEBUG=1` 环境变量可看到所有 debug 日志
 * - 每个 skip 分支都标注了原因和修复建议
 * - attachChatIdToTask 失败时会有 ⚠️ warn 标记
 */

import { spawn } from "child_process";
import type { Hook, HookContext } from "../../hook/types";
import { TracedAs } from "../../log-trace/decorator";
import { createLogger } from "../../log-trace/logger";
import {
  getEnvContextOrEmpty,
} from "../../context";
import { getSharedEventStore } from "../../event-source/event-store";
import { deriveIdempotencyKey } from "../../event-source/idempotency-key";
import {
  humanizeValue,
  LarkCardPatchNotifier,
  getSharedLarkCardNotifier,
  type Milestone,
  type ProcessStep,
  type TaskMeta,
} from "./lark-card-patch-notifier";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type {
  TaskCreateResultContext,
  TaskUpdateResultContext,
  TaskCompleteResultContext,
  TaskOperationCreateResultContext,
} from "../hooks/contexts";
import type { Task, TaskOperation } from "../types";
import type { SessionComponent } from "../../session/session-component";

const logger = createLogger("lark-cli:per-task-group");

function isPluginDebugEnabled(): boolean {
  return process.env.ROY_TASK_NOTIFY_DEBUG === "1" || process.env.ROY_TRACE_DEBUG === "1";
}

// ========================================================================
// 类型定义
// ========================================================================

/**
 * PerTaskGroupChatPlugin 配置
 */
export interface PerTaskGroupConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 优先级（默认 100，确保在 LarkCliTaskNotifyPlugin (50) 之后） */
  priority?: number;
  /** 插件名称（用于 pluginEnabled 检查） */
  pluginName?: string;
  /** 事件源 ID（用于 pluginEnabled 检查） */
  sourceId?: string;

  /** 群聊命名模板（默认 "Task #{id}: {title}"） */
  nameTemplate?: string;
  /** 群聊描述模板 */
  descriptionTemplate?: string;

  /**
   * bot app_id 列表（默认从 replyChannel.appId 自动推导）
   *
   * ★ P0-2 修复：如果未提供，则从 replyChannel.appId 取值。
   * 如果 replyChannel.appId 也未提供，则 fallback 到空数组并在创建群聊时跳过 --bots 参数。
   */
  botAppIds?: string[];

  /**
   * ★ P0 修复：邀请 user 进群聊的 open_id 列表
   *
   * 关键：lark-cli 创建群聊默认是 private chat，不邀请 user 则 user 看不到群聊。
   *
   * 特殊值：
   * - "sender"：自动邀请 event sender（replyChannel.userId）进群
   *
   * 默认值：["sender"]（自动邀请发起 task 的用户）
   *
   * 设为空数组 [] 则不邀请任何 user（user 看不到群聊，仅适用于 admin 手动加人的场景）。
   *
   * ★ Task #3987：本字段与 `defaultInviteUserIds` 是**互补关系**——
   *   本字段可包含 "sender" 占位符做动态推导，defaultInviteUserIds 是静态列表。
   *   最终邀请列表 = defaultInviteUserIds ∪ inviteUserIds (去重)。
   *   注意：本字段不接受 "sender" 之外的占位符，所有非 sender 值都会被视为 open_id 字面量。
   */
  inviteUserIds?: string[];

  /**
   * ★ Task #3987：始终邀请进群聊的 user open_id 列表
   *
   * 与 `inviteUserIds` 的区别：
   * - defaultInviteUserIds: 静态列表，**不接受 "sender" 占位符**，
   *   每次建群都强制邀请这些 user（适合 admin / 共享账号 / 必看人员）
   * - inviteUserIds: 动态列表，可含 "sender" 占位符，从 replyChannel 推导
   *
   * 使用场景：
   * - 团队有一个"任务监督者"账号（如 SRE on-call bot），希望所有 task 群聊都拉它入群
   *   → 把它放进 defaultInviteUserIds，不用每个 event-source 都重复配置
   * - 多 event-source 共享同一组"必邀请"用户时，集中配置避免遗漏
   *
   * 默认值：[]（不邀请任何额外 user）
   *
   * ★ 注意：与 inviteUserIds 类似，defaultInviteUserIds 里的 open_id 也必须属于
   *   当前 lark-cli profile 对应的 app（飞书 user open_id 是 per-app 隔离的），
   *   否则 lark-cli 会报 99992361 "open_id cross app"。
   */
  defaultInviteUserIds?: string[];

  /** 创建失败时是否降级（默认 true：主聊天框仍然由 LarkCliTaskNotifyPlugin 处理） */
  fallbackToMain?: boolean;

  /**
   * 操作记录节流（同 LarkCliTaskNotifyPlugin）
   *
   * 默认 5000ms，设为 0 表示不节流。
   */
  operationThrottleMs?: number;

  /**
   * 是否对 sub-task 跳过群聊创建（默认 true）
   *
   * 父 task 已建群聊，sub-task 不重复建群（避免群聊爆炸）。
   * 设为 false 时，每个 task（包括 sub-task）都会建独立群聊。
   */
  disableSubTaskSkip?: boolean;

  /**
   * onAfterCreate 是否要求 replyChannel.chatId 必须存在（默认 true）
   *
   * 默认行为：没有 replyChannel（env 上下文里 chatId 为空）就 silently skip。
   * 设为 false 时：
   * - profile 降级到 config.profile 或 undefined（让 lark-cli 用 active profile）
   * - "群聊已创建"通知到主聊天框这一步会跳过（没有 chatId 可发）
   * 适用场景：CLI/测试/无 IM 上下文中创建 task 时仍想建群聊。
   */
  requireReplyChannel?: boolean;

  /**
   * 自定义 lark-cli profile（仅 requireReplyChannel=false 时生效）
   *
   * replyChannel 缺失时，createGroupChat 用这个 profile 调用 lark-cli。
   * 不设置时让 lark-cli 用 active profile。
   */
  fallbackProfile?: string;

  /**
   * 创建群聊后是否立即发送"任务创建"欢迎消息（默认 true）
   *
   * ★ 推荐开启：新群聊如果没有首条消息，飞书侧可能不会立刻在侧边栏/会话列表中
   *   显示该群聊（要等其他成员发言或主动搜索才能找到）。
   *   发一条欢迎消息会让群聊立刻可见，并标明用途（"此群用于追踪 task #N"）。
   *
   * 设为 false 时：群聊创建后保持沉默，仅在 task 更新/完成时才有消息。
   * 适用场景：极简通知风格 / 噪音敏感场景。
   */
  sendWelcomeMessage?: boolean;

  /**
   * #4108 P1-b（opt-in）：无 per-task 群时是否用 EventStore 反查原始 trigger 群兜底。
   *
   * 默认 false —— 因为 LarkCliTaskNotifyPlugin 与 PerTaskGroupChatPlugin 常同时启用，
   * 若 PerTaskGroupChatPlugin 也兜底到 trigger 群，会和 LarkCliTaskNotifyPlugin 的
   * 直发**重复**（同一群两条消息）。
   *
   * 适用场景：只启用 PerTaskGroupChatPlugin（未启用 LarkCliTaskNotifyPlugin）时，
   * 设为 true 可让"自身无群"的任务更新/操作/完成通知回落到 trigger 群，而不是
   * silently skip（消除 #4039 C 提到的"更新通知被 skip"的不对称）。
   */
  resolveToTriggerChatFallback?: boolean;

  /**
   * Task #4192：建群后是否立刻发一张交互式卡片（notifier.startTask）
   *
   * 默认 true（推荐）：
   * - 建群后立刻发卡片，飞书用户能看到一张"任务已创建"卡片，后续 update 都 patch 同一卡片
   * - 不发普通文字消息（避免"群聊已创建 + 任务已创建"两条噪音）
   *
   * 设为 false 时：
   * - 走旧的 sendWelcomeMessage 路径（默认文本欢迎消息）
   * - 适用于保留旧行为的场景
   */
  cardInitialMessage?: boolean;

  /**
   * Task #4331：是否在 task 创建时**自动**建专属群（默认 false）
   *
   * 历史行为（autoCreateGroup=true 显式开启）：
   * - onAfterCreate 触发 → 调 createGroupChat 建专属群 → 写 task.context.larkPerTaskChatId
   * - 适用：每个 task 想要独立工作群的场景
   *
   * 默认行为（autoCreateGroup 未传或 false）：
   * - onAfterCreate → silently skip（**不**建群）
   * - 任务卡片只发到触发群（replyChannel.chatId）
   * - 用户在卡片顶部点"为这个任务建群"按钮 → 走 ensureGroupChat 按需建群
   * - 适用：减少群聊爆炸 / 集中讨论 / 减少噪音
   *
   * ★ Task #4394：`LarkCliTaskNotifyPlugin.cardRoutingPorts.ensureTaskGroupChat`
   *   及其 `new-group` / `fallback-to-trigger` 两条 source 已删除 —— 卡片路由
   *   **不再自动建群**，`ensureGroupChat` 现在只剩一个调用方：用户点卡片上
   *   「为这个任务建群」按钮（见 lark-card-action-handler.ts）。
   */
  autoCreateGroup?: boolean;
  /**
   * Task #4192：共享 LarkCardPatchNotifier 实例
   *
   * - 不传 → plugin 自己 new 一个（适用于仅启用本 plugin 的场景）
   * - 传同一实例（与 LarkCliTaskNotifyHook 共享）→ 跨 plugin messageId 协调，
   *   保证 LarkCliTaskNotifyHook 的 updateTask 能 patch 本 plugin startTask 发的卡片
   */
  cardNotifier?: import("./lark-card-patch-notifier").LarkCardPatchNotifier;
}

// ========================================================================
// task.context JSON 字段常量
// ========================================================================

/** task.context JSON 中存 task 群聊 ID 的字段名 */
const CTX_FIELD_CHAT_ID = "larkPerTaskChatId";
/** task.context JSON 中存 task 群聊 profile 的字段名（★ P0-1 fallback 用） */
const CTX_FIELD_CHAT_PROFILE = "larkPerTaskChatProfile";
/** task.context JSON 中存 task 群聊创建时间的字段名 */
const CTX_FIELD_CHAT_CREATED_AT = "larkPerTaskChatCreatedAt";
/** task.context JSON 中存 task 群聊创建人（task id）的字段名 */
const CTX_FIELD_CHAT_TASK_ID = "larkPerTaskChatTaskId";

// ========================================================================
// PerTaskGroupChatPlugin
// ========================================================================

/**
 * PerTaskGroupChatPlugin - 每 task 一个独立飞书群聊
 *
 * 与 LarkCliTaskNotifyPlugin 的关系（★ P0-3 双发问题）：
 * - LarkCliTaskNotifyPlugin: 发到主聊天框（replyChannel.chatId）
 * - PerTaskGroupChatPlugin: 发到 task 群聊（task.context.larkPerTaskChatId）
 *
 * 两种 plugin 监听相同的 hook 点（task:after.update），都会触发。
 * 文档明确推荐"方式 A"——用户配置 event-source 时只启用 PerTaskGroupChatPlugin：
 *
 * ```bash
 * roy-bot eventsource update <lark-cli-source-id> \
 *   --plugins "PerTaskGroupChatPlugin"
 * # 不要包含 LarkCliTaskNotifyPlugin，否则主聊天框也会收到 AFTER_UPDATE 通知
 * ```
 *
 * 如果保留 LarkCliTaskNotifyPlugin，则 PerTaskGroupChatPlugin 应配置为 disabled，
 * 或用户接受"主聊天框 + task 群聊"双通道通知（用于调试/迁移期）。
 */
export class PerTaskGroupChatPlugin implements Hook {
  readonly name: string;
  readonly priority: number;
  readonly pluginName?: string;
  readonly sourceId?: string;

  private readonly config: Required<PerTaskGroupConfig>;

  /**
   * 操作记录节流状态
   * key: `${taskId}`, value: 上次发送时间戳
   */
  private lastNotifyTimestamps: Map<number, number> = new Map();

  /**
   * Task update 任务（DI 注入，由 EventSource 提供）
   * 用于 attachChatIdToTask 把 chat_id 写回 task.context
   */
  private taskUpdater?: (taskId: number, context: string) => Promise<void>;

  /**
   * Task 查询器（DI 注入，由 EventSource 提供）
   *
   * Task #4039 C 项（统一群解析）：sub-task 自身没有独立群时，需要沿
   * `parent_task_id` 上溯到最近拥有群的祖先，才能与 CLI notify 路径
   * （resolveNotifyChatIds）解析出**同一个群**。未注入时退化为只读自身 context。
   */
  private taskGetter?: (
    id: number
  ) => Promise<{ context?: string; parent_task_id?: number | null } | undefined>;

  /**
   * Session component（DI 注入，由 EventSource 提供）
   *
   * Task #4023：用于把 chat_id ↔ task_id 反向绑定写到 session.metadata.larkChat，
   * 让群聊消息事件 handler 能从 session 反向查到当前群绑定的 task。
   *
   * 未注入时：跳过反向绑定（task.context 的 larkPerTaskChatId 仍正常工作），
   *            但群消息 handler 拿不到 parentTaskId 注入。
   */
  private sessionComponent?: SessionComponent;

  /**
   * ★ Task #4230：卡片 notifier 实例（默认 plugin 自己 new，可被外部共享）
   *
   * 用于建群后立即发一张交互式卡片（notifier.startTask），
   * 后续 update / operation / complete 都 patch **同一张卡片**（不刷屏）。
   */
  private cardNotifier: LarkCardPatchNotifier;

  /**
   * ★ Task #4230：卡片 messageId 跟踪（key: taskId）
   *
   * 单卡片语义：同一 task 的 create → update → operation → complete
   * 必须复用同一 messageId。旧实现在 update/complete 走纯文本消息，
   * 卡片只发不发更新 —— 已删除。
   */
  private cardMessageIds: Map<number, string> = new Map();

  /** 卡片启动失败哨兵（避免 update 重试风暴） */
  private static readonly CARD_START_FAILED_SENTINEL = "__card_start_failed__";

  /**
   * ★ Task #4237 修复：同一 task 的建群请求 in-flight 去重
   *
   * 根因：`ensureGroupChat`（notify hook 按需建群）与 `onAfterCreate`（本插件）
   * 是两条独立路径，都可能给同一 task 建群；若两者几乎同时进入，
   * "读 context → 建群" 之间没有互斥 → 建出两个同名群。
   *
   * key = taskId；value = 正在进行的建群 promise（后来者直接复用）
   */
  private groupChatInflight: Map<number, Promise<{ chatId: string; profile?: string; name?: string } | undefined>> = new Map();

  constructor(config: PerTaskGroupConfig = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      priority: config.priority ?? 100,
      pluginName: config.pluginName ?? "PerTaskGroupChatPlugin",
      sourceId: config.sourceId ?? "",
      nameTemplate: config.nameTemplate ?? "Task #{id} - #{title}",
      descriptionTemplate: config.descriptionTemplate ?? "roy-bot task #{id} - #{project_path}",
      // ★ P0-2 修复：botAppIds 默认空数组，使用时通过 resolveBotAppIds 推导
      botAppIds: config.botAppIds ?? [],
      // ★ P0 修复：默认邀请 sender（事件发起人）进群聊
      inviteUserIds: config.inviteUserIds ?? ["sender"],
      // ★ Task #3987：新增默认邀请列表（不接受 "sender" 占位符）
      defaultInviteUserIds: config.defaultInviteUserIds ?? [],
      fallbackToMain: config.fallbackToMain ?? true,
      operationThrottleMs: config.operationThrottleMs ?? 5000,
      disableSubTaskSkip: config.disableSubTaskSkip ?? false,
      requireReplyChannel: config.requireReplyChannel ?? true,
      fallbackProfile: config.fallbackProfile ?? "",
      sendWelcomeMessage: config.sendWelcomeMessage ?? true,
      resolveToTriggerChatFallback: config.resolveToTriggerChatFallback ?? false,
      // ★ Task #4192：建群后默认发初始卡片
      // Task #4196: 默认值改为 !== false（默认启用），干掉旧 sendWelcomeMessage 路径
      cardInitialMessage: config.cardInitialMessage !== false,
      // ★ Task #4331：默认**不**自动建群（用户新要求）
      //   - 历史行为需要显式 autoCreateGroup=true 才会启用
      //   - 默认 onAfterCreate silently skip
      autoCreateGroup: config.autoCreateGroup === true,
      // ★ Task #4230：卡片 notifier 放进 config（默认自建，可被外部共享）
      //
      // ★ CV R3 M2 修复：默认改为**进程单例**。
      //
      // 原实现 `new LarkCardPatchNotifier()`：本插件常与 LarkCliTaskNotifyPlugin 同时
      // 启用，而 `event-source-handlers.ts` 的取值链是
      // `LarkCliTaskNotifyPlugin ?? PerTaskGroupChatPlugin ?? 单例` —— 一旦前者没
      // 加载，取到的就是这个**外来实例**，它的 `sessionStates` 是空的 ⇒
      // `buildSessionCardWithActivity` 查不到 → 刷新走 fallback 重建，
      // title/里程碑/updateCount 全丢（reviewer M2，属实）。
      cardNotifier: config.cardNotifier ?? getSharedLarkCardNotifier(),
    };
    this.cardNotifier = this.config.cardNotifier;
    this.name = this.config.pluginName;
    this.priority = this.config.priority;
    this.pluginName = this.config.pluginName;
    this.sourceId = this.config.sourceId;
  }

  /**
   * Task #4230 follow-up：按需为 task 建/取专属群（供卡片路由使用）
   *
   * 场景：任务是在**别的 task 的专属群**里被触发的（例如在 #3999 的跟进群里
   * 让 agent 建了 #4226），此时代码不能把 #4226 的卡片塞进 #3999 的群，也不该
   * 因为"sub-task 跳过建群"就让 #4226 无家可归 → 这里按需建一个专属群。
   *
   * 与 onAfterCreate 的差别（有意为之）：
   * - 不做 sub-task skip（这是"按需补建"路径）
   * - 不发初始卡片（卡片由调用方 LarkCliTaskNotifyHook 基于同一 chatId 发送，
   *   避免重复卡片）
   *
   * 会顺手写 chat↔task 绑定 + 把 chatId 持久化进 task.context，因此后续
   * 解析（lineage 上溯）能直接命中。
   *
   * @returns { chatId, profile } 建群成功；undefined = 建群失败（caller 自行降级）
   */
  @TracedAs("per-task-group-chat.ensureGroupChat", {
    recordParams: true,
    recordResult: true,
    flattenParamFilter: true,
    paramFilter: (args) => ({ taskId: args[0]?.id }),
    resultFilter: (r: { chatId?: string } | undefined) => ({ chatId: r?.chatId }),
  })
  async ensureGroupChat(
    task: Task,
    /**
     * replyChannel 覆盖（hook 调用方从 `ctx.metadata.envContext` 拿到的那份）
     *
     * 为什么需要：hook 被直接调用（测试 / eventsource 直调 plugin.execute）时，
     * ALS 里没有 EnvContext，但 `ctx.metadata.envContext.replyChannel` 有值。
     * 旧 onAfterCreate 走 getReplyChannelFromCtx 能拿到，所以这里必须支持传入，
     * 否则会误判「没有 replyChannel → 不建群」。
     */
    replyChannelOverride?: {
      chatId?: string;
      messageId?: string;
      userId?: string;
      appId?: string;
      profile?: string;
    }
  ): Promise<{ chatId: string; profile?: string; name?: string } | undefined> {
    const renderedName = this.renderTemplate(this.config.nameTemplate, task);

    // ★ Task #4237 ①：task 已记录专属群 → 直接复用（谁先建群都只建一个）
    const existingChatId = this.getTaskChatId(task);
    if (existingChatId) {
      logger.debug(
        `ensureGroupChat[${this.pluginName}]: task #${task.id} 已有专属群 ${existingChatId} → 复用（不重复建群）`
      );
      return {
        chatId: existingChatId,
        profile: this.parseProfileFromContext((task as { context?: string }).context),
        name: renderedName,
      };
    }

    // ★ Task #4237 ②：同一 task 的建群请求 in-flight 去重（并发/重入只建一个）
    const inflight = this.groupChatInflight.get(task.id);
    if (inflight) {
      logger.debug(
        `ensureGroupChat[${this.pluginName}]: task #${task.id} 建群已在进行中 → 复用同一 promise`
      );
      return inflight;
    }

    const pending = this.doEnsureGroupChat(task, renderedName, replyChannelOverride);
    this.groupChatInflight.set(task.id, pending);
    try {
      return await pending;
    } finally {
      this.groupChatInflight.delete(task.id);
    }
  }

  /** ensureGroupChat 的实际建群逻辑（调用方已做幂等/in-flight 去重） */
  private async doEnsureGroupChat(
    task: Task,
    name: string,
    replyChannelOverride?: {
      chatId?: string;
      messageId?: string;
      userId?: string;
      appId?: string;
      profile?: string;
    }
  ): Promise<{ chatId: string; profile?: string; name?: string } | undefined> {
    const replyChannel =
      replyChannelOverride ??
      (getEnvContextOrEmpty().replyChannel as
        | { chatId?: string; messageId?: string; userId?: string; appId?: string; profile?: string }
        | undefined);

    if (!replyChannel?.chatId && this.config.requireReplyChannel) {
      logger.warn(
        `ensureGroupChat[${this.pluginName}]: no replyChannel.chatId for task #${task.id} ` +
          `(requireReplyChannel=true) → 无法建群`
      );
      return undefined;
    }

    const description = this.renderTemplate(this.config.descriptionTemplate, task);
    const profile =
      replyChannel?.profile || (this.config.fallbackProfile || undefined);
    const botAppIds = this.resolveBotAppIds(replyChannel ?? {});
    const userIds = this.resolveUserIds(replyChannel);

    try {
      const chatId = await this.createGroupChat({
        name,
        description,
        profile,
        botAppIds,
        userIds,
      });
      await this.writeChatBinding(task, chatId, profile, "creating");
      await this.attachChatIdToTask(task, chatId, profile);
      await this.writeChatBinding(task, chatId, profile, "ready");
      logger.info(
        `ensureGroupChat[${this.pluginName}]: created group ${chatId} for task #${task.id}`
      );
      return { chatId, profile, name };
    } catch (error) {
      logger.error(
        `ensureGroupChat[${this.pluginName}]: failed for task #${task.id}: ${error}`
      );
      return undefined;
    }
  }

  /**
   * 注入 Task 更新函数（用于 attachChatIdToTask 把 chat_id 写回 DB）
   *
   * 由 EventSource handler 在 plugin 实例化时注入（event-source-handlers.ts:registerPluginHooks）。
   * 未注入时：chat_id 只更新 in-memory task.context，DB 里没持久化 → 下次 AFTER_UPDATE
   *           从 DB 加载 task 时 getTaskChatId() 返回 undefined，所有后续更新通知 silently 丢失。
   *
   * 通过 hasTaskUpdater() 可检查是否已注入。
   */
  setTaskUpdater(updater: (taskId: number, context: string) => Promise<void>): void {
    this.taskUpdater = updater;
    logger.debug(`TaskUpdater injected for plugin ${this.name} (sourceId=${this.sourceId})`);
  }

  /**
   * 检查 taskUpdater 是否已注入（用于诊断和测试）
   */
  hasTaskUpdater(): boolean {
    return this.taskUpdater !== undefined;
  }

  /**
   * 注入 Task 查询器（用于 sub-task 上溯祖先群，Task #4039 C 项）。
   */
  setTaskGetter(
    getter: (id: number) => Promise<{ context?: string; parent_task_id?: number | null } | undefined>
  ): void {
    this.taskGetter = getter;
    logger.debug(`TaskGetter injected for plugin ${this.name} (sourceId=${this.sourceId})`);
  }

  /**
   * 检查 taskGetter 是否已注入（用于诊断和测试）
   */
  hasTaskGetter(): boolean {
    return this.taskGetter !== undefined;
  }

  /**
   * 注入 Session component（用于 chat_id ↔ task_id 反向绑定）
   *
   * Task #4023: 在 onAfterCreate 建群成功后，调 SessionComponent.upsertChatTaskBinding
   * 把 chatId 写到 session.metadata.larkChat.taskId。让群消息 handler 反向查到 task。
   *
   * 未注入时：跳过反向绑定（task.context.larkPerTaskChatId 仍正常工作）。
   */
  setSessionComponent(sessionComponent: SessionComponent): void {
    this.sessionComponent = sessionComponent;
    logger.debug(
      `SessionComponent injected for plugin ${this.name} (sourceId=${this.sourceId})`
    );
  }

  /**
   * 检查 SessionComponent 是否已注入（用于诊断和测试）
   */
  hasSessionComponent(): boolean {
    return this.sessionComponent !== undefined;
  }

  @TracedAs("per-task-group-chat.execute")
  async execute(ctx: HookContext<unknown>): Promise<void> {
    // ★ Task #4207 DEBUG: 追踪 plugin execute 实际是否被调用
    if (process.env.ROY_HOOK_DEBUG === "1") {
      console.error(`[DEBUG per-task-group-chat.execute] ENTER hookPoint=${ctx.hookPoint} pluginName=${this.pluginName} sourceId=${this.sourceId}`);
    }
    if (!this.config.enabled) {
      if (process.env.ROY_HOOK_DEBUG === "1") {
        console.error(`[DEBUG per-task-group-chat.execute] → SKIP (config.enabled=false)`);
      }
      logger.debug(`execute: plugin disabled (pluginName=${this.pluginName})`);
      return;
    }

    // pluginEnabled 检查（与 LarkCliTaskNotifyPlugin 一致）
    // 注意：env.pluginEnabled 未设置（env 没创建或插件未注册到 eventsource）时
    // 走原 plugin 的"宽容模式"（继续执行），由 hook-manager 在外层做严格检查。
    // 这保证测试 / 单插件直接调用 plugin.execute(ctx) 的场景不会被 skip。
    if (this.pluginName && this.sourceId) {
      const env = getEnvContextOrEmpty();
      const key = `${this.sourceId}:${this.pluginName}`;
      // ★ Task #4207 DEBUG
      if (process.env.ROY_HOOK_DEBUG === "1") {
        console.error(`[DEBUG per-task-group-chat.execute] check pluginEnabled key=${key} env.pluginEnabled=${JSON.stringify(env.pluginEnabled)}`);
      }
      // 严格检查：env.pluginEnabled[key] 必须 === true 才视为启用
      // 兼容：env.pluginEnabled undefined / 空对象 → 不 skip（保留旧行为）
      if (env.pluginEnabled && env.pluginEnabled[key] !== true) {
        if (process.env.ROY_HOOK_DEBUG === "1") {
          console.error(`[DEBUG per-task-group-chat.execute] → SKIP (plugin NOT enabled for ${key})`);
        }
        logger.debug(
          `execute[${this.pluginName}]: plugin NOT enabled (key=${key}, ` +
          `env.pluginEnabled=${JSON.stringify(env.pluginEnabled)}, ` +
          `hookPoint=${ctx.hookPoint}). ` +
          `→ skip. 修复：roy-bot eventsource update <id> 必须包含 PerTaskGroupChatPlugin`
        );
        return;
      }
      const enabledState = env.pluginEnabled
        ? (env.pluginEnabled[key] === true ? "✅ enabled" : "❌ NOT enabled")
        : "⚠️  env.pluginEnabled 未设置 (env 没创建 / 插件未注册到 eventsource)";
      logger.debug(
        `execute[${this.pluginName}]: ${enabledState} (key=${key}, ` +
        `hookPoint=${ctx.hookPoint}, taskUpdaterInjected=${this.hasTaskUpdater()})`
      );
    } else {
      logger.debug(
        `execute[${this.pluginName}]: missing pluginName/sourceId metadata ` +
        `(pluginName=${this.pluginName}, sourceId=${this.sourceId}), ` +
        `skipping pluginEnabled check. hookPoint=${ctx.hookPoint}`
      );
    }
    if (process.env.ROY_HOOK_DEBUG === "1") {
      console.error(`[DEBUG per-task-group-chat.execute] → PASSED pluginEnabled check, will dispatch hookPoint=${ctx.hookPoint}`);
    }

    switch (ctx.hookPoint) {
      case TaskHookPoints.AFTER_CREATE:
        await this.onAfterCreate(ctx as HookContext<TaskCreateResultContext>);
        break;
      case TaskHookPoints.AFTER_UPDATE:
        await this.onAfterUpdate(ctx as HookContext<TaskUpdateResultContext>);
        break;
      case TaskHookPoints.OPERATION_AFTER_CREATE:
        await this.onAfterOperationCreate(
          ctx as HookContext<TaskOperationCreateResultContext>
        );
        break;
      case TaskHookPoints.AFTER_COMPLETE:
        await this.onAfterComplete(ctx as HookContext<TaskCompleteResultContext>);
        break;
      default:
        logger.debug(`execute: unhandled hookPoint=${ctx.hookPoint}, skip`);
    }
  }

  // ========================================================================
  // Hook Handlers
  // ========================================================================

  /**
   * onAfterCreate: 创建 task 群聊 + 存 chat_id 到 task.context
   *
   * 决策日志（ROY_TASK_NOTIFY_DEBUG=1 时可见）：
   - replyChannel.chatId 缺失 + requireReplyChannel=true → skip
   - sub-task + disableSubTaskSkip=false → skip
   - 群聊创建失败 → fallback（fallbackToMain=false 时抛出）
   */
  @TracedAs("per-task-group-chat.onAfterCreate", { recordParams: false })
  private async onAfterCreate(ctx: HookContext<TaskCreateResultContext>): Promise<void> {
    const data = ctx.data as TaskCreateResultContext;
    if (!data?.task) {
      logger.debug("onAfterCreate: task is missing, skip");
      return;
    }

    const { task } = data;
    // ★ Task #4207 DEBUG
    if (process.env.ROY_HOOK_DEBUG === "1") {
      const env = getEnvContextOrEmpty();
      console.error(`[DEBUG per-task-group-chat.onAfterCreate] task=#${task.id} title="${task.title}" parent_task_id=${(task as { parent_task_id?: number }).parent_task_id ?? "none"}`);
      console.error(`[DEBUG per-task-group-chat.onAfterCreate] env.replyChannel=${JSON.stringify(env.replyChannel)}`);
      console.error(`[DEBUG per-task-group-chat.onAfterCreate] env.messageId=${env.messageId}`);
      console.error(`[DEBUG per-task-group-chat.onAfterCreate] env.sourceId=${env.sourceId}`);
    }
    logger.debug(
      `onAfterCreate[${this.pluginName}]: enter task=${task.id} "${task.title}" ` +
      `parent_task_id=${(task as { parent_task_id?: number }).parent_task_id ?? "none"} ` +
      `requireReplyChannel=${this.config.requireReplyChannel} ` +
      `disableSubTaskSkip=${this.config.disableSubTaskSkip} ` +
      `sendWelcomeMessage=${this.config.sendWelcomeMessage} ` +
      `autoCreateGroup=${this.config.autoCreateGroup}`
    );

    // ★ Task #4331：默认**不**自动建群（autoCreateGroup=false 默认）
    //   - 用户主动点卡片顶部"为这个任务建群"按钮才会触发 ensureGroupChat
    //   - 这里 silently skip，不写 task.context
    if (!this.config.autoCreateGroup) {
      logger.debug(
        `onAfterCreate[${this.pluginName}]: task #${task.id} autoCreateGroup=false ` +
          `→ skip group chat creation（按需建群：用户在卡片顶部按钮触发）`
      );
      return;
    }

    const replyChannel = this.getReplyChannelFromCtx(ctx);
    if (!replyChannel?.chatId && this.config.requireReplyChannel) {
      logger.debug(
        `onAfterCreate[${this.pluginName}]: no replyChannel.chatId for task #${task.id}, skip. ` +
        `修复：eventsource 收到 im.message.receive_v1 事件时 replyChannel 应有值；` +
        `或在 plugin config 设 requireReplyChannel=false 强制创建群聊（profile 降级到 fallbackProfile/无）`
      );
      return;
    }
    if (!replyChannel?.chatId && !this.config.requireReplyChannel) {
      logger.debug(
        `onAfterCreate[${this.pluginName}]: no replyChannel but requireReplyChannel=false, ` +
        `proceeding with profile fallback (fallbackProfile="${this.config.fallbackProfile}")`
      );
    }

    // sub-task 检查：父 task 已建群聊，sub-task 不重复建（可由 config 关闭）
    if (this.isSubTask(task) && !this.config.disableSubTaskSkip) {
      logger.debug(
        `onAfterCreate[${this.pluginName}]: task #${task.id} is sub-task, ` +
        `skip group chat creation. 关闭方式：config.disableSubTaskSkip=true`
      );
      return;
    }
    if (this.isSubTask(task) && this.config.disableSubTaskSkip) {
      logger.debug(
        `onAfterCreate[${this.pluginName}]: task #${task.id} is sub-task but ` +
        `disableSubTaskSkip=true, proceeding to create group chat`
      );
    }

    // ★ Task #4237 修复：统一走幂等的 ensureGroupChat（与 LarkCliTaskNotifyHook 的
    //   按需建群共用同一份去重逻辑），避免「两条路径各建一个同名群」；
    //   并且**不再自己发初始卡片**（首张卡片唯一 owner = LarkCliTaskNotifyHook，
    //   否则同一 task 会出现多张卡片 + 双 notifier 各自 patch）。
    try {
      const created = await this.ensureGroupChat(task, replyChannel);
      if (!created?.chatId) {
        logger.error(
          `onAfterCreate[${this.pluginName}]: ensureGroupChat 未返回 chatId for task #${task.id}`
        );
        if (!this.config.fallbackToMain) {
          throw new Error(`per-task group chat unavailable for task #${task.id}`);
        }
        return;
      }
      logger.info(
        `onAfterCreate[${this.pluginName}]: task #${task.id} → group ${created.chatId} ` +
          `(initial card owned by LarkCliTaskNotifyHook)`
      );
    } catch (error) {
      logger.error(
        `onAfterCreate[${this.pluginName}]: group chat failed for task #${task.id}: ${error}`
      );
      if (!this.config.fallbackToMain) throw error;
      // Fallback: 主聊天框正常通知（LarkCliTaskNotifyPlugin 仍然在）
    }
  }

  /**
   * 写 chat_id ↔ task_id 反向绑定（Task #4023）。
   *
   * 状态机：creating → ready（成功）/ failed（post-create 失败）。
   * 失败不阻断主流程（task.context.larkPerTaskChatId 仍正常工作），仅 warn。
   * 未注入 sessionComponent 时静默跳过（debug 可见）。
   *
   * Span 属性（flattenParamFilter=true）：taskId / chatId / status，
   * 便于 `debug trace` 验证写侧状态迁移（creating→ready/failed）。
   */
  @TracedAs("per-task-group-chat.writeChatBinding", {
    recordParams: true,
    recordResult: false,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      taskId: args[0]?.id,
      chatId: args[1],
      status: args[3],
    }),
  })
  private async writeChatBinding(
    task: Task,
    chatId: string,
    profile: string | undefined,
    status: "creating" | "ready" | "failed",
    errorMessage?: string
  ): Promise<void> {
    if (!this.sessionComponent) {
      if (isPluginDebugEnabled()) {
        logger.debug(
          `writeChatBinding[${this.pluginName}]: no sessionComponent injected, ` +
            `skip chat-task binding for chat ${chatId} (status=${status})`
        );
      }
      return;
    }
    try {
      await this.sessionComponent.upsertChatTaskBinding({
        chatId,
        taskId: task.id,
        profile,
        status,
        errorMessage: errorMessage ?? null,
      });
    } catch (bindErr) {
      logger.warn(
        `writeChatBinding[${this.pluginName}]: failed to write chat-task binding for ` +
          `chat ${chatId} / task #${task.id} (status=${status}): ${bindErr}. ` +
          `群消息 handler 将无法自动注入 parentTaskId。`
      );
    }
  }

  /**
   * onAfterUpdate: 发到 task 群聊
   *
   * ★ P0-1 修复：replyChannel 在 onAfterUpdate 可能为空（TaskComponent 内部触发），
   * 此时 fallback 到 task.context.larkPerTaskChatProfile。
   *
   * 重要诊断：如果 task.context 没有 larkPerTaskChatId，说明：
   * 1. task 创建时 plugin 没被 enabled（eventsource handleRule.plugins 缺失）
   * 2. task 创建时 plugin 已 enabled 但 chat_id 没持久化到 DB（taskUpdater 未注入）
   * 3. task 是通过其它途径创建的（旧 task 迁移场景）
   * → 这 3 种情况都让 onAfterUpdate silently skip，需要查 eventsource 配置 + DB 状态
   */
  @TracedAs("per-task-group-chat.onAfterUpdate", { recordParams: false })
  private async onAfterUpdate(ctx: HookContext<TaskUpdateResultContext>): Promise<void> {
    const data = ctx.data as TaskUpdateResultContext;
    if (!data?.task) {
      logger.debug("onAfterUpdate: task is missing, skip");
      return;
    }
    // ★ Task #4237 契约变更：卡片的**全部生命周期**（首发/patch/终态/unpin）由
    //   LarkCliTaskNotifyHook 独占；本插件只负责建群 + 绑定 + chatId 持久化。
    //   旧实现自己 startTask + 各自 patch（双 notifier → 同一 task 两张卡在各自
    //   群里进度分裂）——已删除。
    logger.debug(
      `onAfterUpdate[${this.pluginName}]: task #${data.task.id} 卡片由 ` +
        `LarkCliTaskNotifyHook 负责（本插件不再 patch），skip`
    );
  }

  /**
   * onAfterOperationCreate: 节流后发到 task 群聊
   */
  @TracedAs("per-task-group-chat.onAfterOperationCreate", { recordParams: false })
  private async onAfterOperationCreate(
    ctx: HookContext<TaskOperationCreateResultContext>
  ): Promise<void> {
    const data = ctx.data as TaskOperationCreateResultContext;
    if (!data?.operation) {
      logger.debug("onAfterOperationCreate: operation is missing, skip");
      return;
    }
    // ★ Task #4237：卡片 patch 归 LarkCliTaskNotifyHook（含 operation → 时间线），
    //   本插件不再参与，避免"同一 task 两张卡各自 patch"。
    logger.debug(
      `onAfterOperationCreate[${this.pluginName}]: operation #${(data.operation as any).id} ` +
        `卡片由 LarkCliTaskNotifyHook 负责，skip`
    );
  }

  /**
   * onAfterComplete: task 进入 terminal 状态，在 task 群聊发"任务完成"摘要
   *
   * 设计：AFTER_COMPLETE 与 AFTER_UPDATE 都触发，但 AFTER_COMPLETE 发的消息
   * 更突出"完成/失败/cancelled/timeout"语义。
   *
   * ★ Task #3957：AFTER_COMPLETE hook 点在 LarkCliInstance.getPluginHookPoints() 注册。
   *   之前 fallback 列表只返回 3 个 hook 点（缺 AFTER_COMPLETE），导致本方法永远不被触发。
   */
  @TracedAs("per-task-group-chat.onAfterComplete", { recordParams: false })
  private async onAfterComplete(ctx: HookContext<TaskCompleteResultContext>): Promise<void> {
    const data = ctx.data as TaskCompleteResultContext;
    if (!data?.task) {
      logger.debug("onAfterComplete: task is missing, skip");
      return;
    }
    // ★ Task #4237：终态 patch + unpin 归 LarkCliTaskNotifyHook（它持有 messageId）。
    logger.debug(
      `onAfterComplete[${this.pluginName}]: task #${data.task.id} 终态卡片由 ` +
        `LarkCliTaskNotifyHook 负责，skip`
    );
  }

  // ========================================================================
  // lark-cli 调用
  // ========================================================================

  /**
   * 调用 lark-cli 创建群聊
   *
   * Span 输出参数（flattenParamFilter=true）：
   * - profile: 使用的 lark-cli profile
   * - botAppIds.length: 邀请的额外 bot 数
   * - userIds.length: 邀请的 user 数（★ P0 关键：user 看不到群聊的 root cause）
   * - name / description: 群聊名/描述
   * Span 输出结果（flattenParamFilter=true）：
   * - chatId: 创建成功的 chat_id（用于后续 sendToChat / 写入 task.context）
   */
  @TracedAs("per-task-group-chat.createGroupChat", {
    recordParams: true,
    recordResult: true,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      profile: args[0]?.profile,
      botAppIdsCount: args[0]?.botAppIds?.length,
      userIdsCount: args[0]?.userIds?.length ?? 0,
      userIds: args[0]?.userIds,
      name: args[0]?.name,
      description: args[0]?.description,
    }),
    resultFilter: (r: string | undefined) => ({
      chatId: r,
      ok: !!r,
    }),
  })
  private createGroupChat(opts: {
    name: string;
    description: string;
    profile?: string;
    botAppIds: string[];
    userIds?: string[];
  }): Promise<string> {
    const args = this.buildCreateGroupChatArgs(opts);

    if (isPluginDebugEnabled()) {
      logger.debug(`Creating group chat: lark-cli ${args.join(" ")}`);
    }

    return new Promise((resolve, reject) => {
      const proc = spawn("lark-cli", args, {
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`lark-cli +chat-create exited with code ${code}: ${stderr}`));
          return;
        }

        // 解析 stdout JSON → chat_id
        const chatId = this.parseChatId(stdout);
        if (!chatId) {
          reject(new Error(`lark-cli +chat-create did not return chat_id: ${stdout}`));
          return;
        }
        resolve(chatId);
      });

      proc.on("error", (error) => {
        reject(error);
      });
    });
  }

  /**
   * 构造 `+chat-create` 命令的 args（提取出来便于单测）
   *
   * ★ 关键设计：
   * - profile 有值时 → 必须加 `--as bot`，否则 lark-cli 用 user 身份建群，
   *   profile 对应的 bot 不是群成员，后续 bot 发消息会失败
   * - botAppIds 是邀请额外的 bots（除 --as bot 的当前 bot 之外），可选
   * - userIds 是邀请原 user 进群（**P0 关键**：不邀请则 user 看不到群聊）
   * - `--set-bot-manager` 需要 `--as bot` 才生效
   *
   * Span 参数：
   * - hasProfile: 是否有 profile（决定是否加 --as bot）
   * - botAppIdsCount: 额外 bot 数
   * - hasUsers: 是否邀请用户（--users）
   * - argsSummary: args 的可读摘要（lark-cli im +chat-create ...）
   */
  @TracedAs("per-task-group-chat.buildCreateGroupChatArgs", {
    recordParams: false,
    recordResult: true,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      hasProfile: !!args[0]?.profile,
      botAppIdsCount: args[0]?.botAppIds?.length,
      hasUsers: !!args[0]?.userIds?.length,
    }),
    resultFilter: (r: string[]) => ({
      argsSummary: r.join(" "),
      hasAsBot: r.includes("--as") && r[r.indexOf("--as") + 1] === "bot",
      hasBots: r.includes("--bots"),
      hasUsers: r.includes("--users"),
    }),
  })
  private buildCreateGroupChatArgs(opts: {
    name: string;
    description: string;
    profile?: string;
    botAppIds: string[];
    userIds?: string[];
  }): string[] {
    // ★ P0 修复：lark-cli +chat-create --name 最大 60, --description 最大 100 字符
    //   Task #3974 案例：path 太长 → description 105 chars → lark-cli exit code 2 → chat 未创建
    //   在 buildCreateGroupChatArgs 里统一截断，保证所有调用方都安全。
    const nameTrimmed = this.truncate(opts.name, 60);
    const descriptionTrimmed = this.truncate(opts.description, 100);

    const args: string[] = [
      "im",
      "+chat-create",
      "--name",
      nameTrimmed,
      "--description",
      descriptionTrimmed,
    ];

    // ★ P1 修复：只要 profile 有值，就应该用 --as bot（让 profile 对应的 bot 成为群成员）
    // 之前只在 botAppIds.length > 0 时才加 --as bot，导致 appId 缺失场景下
    // lark-cli 用 user 身份建群，bot 不是群成员，后续消息发送失败。
    if (opts.profile) {
      args.push("--as", "bot");
    }

    // ★ P0-2 修复：botAppIds 是邀请额外的 bots（除了 --as bot 的当前 bot 之外）
    if (opts.botAppIds.length > 0) {
      args.push("--bots", opts.botAppIds.join(","));
      args.push("--set-bot-manager");
    }

    // ★ P0 修复：userIds 必须邀请，否则 user 看不到群聊（chat 私有 + 没有 user）
    if (opts.userIds && opts.userIds.length > 0) {
      args.push("--users", opts.userIds.join(","));
    }

    if (opts.profile) {
      args.unshift("--profile", opts.profile);
    }

    return args;
  }

  /**
   * 把 chat_id 写回 task.context JSON
   *
   * 持久化路径：
   * 1. taskUpdater 已注入 → 调 updater(task.id, newContext) 写 DB
   * 2. taskUpdater 未注入 → 只更新 in-memory task.context（DB 没持久化）
   *    ⚠️ 这种情况是 bug：下次 AFTER_UPDATE 从 DB 加载 task 时 getTaskChatId() 返回 undefined，
   *    所有后续 update/complete/operation 通知都会 silently skip。
   *    修复：event-source-handlers.ts:registerPluginHooks 必须检测 plugin.setTaskUpdater 并注入。
   */
  @TracedAs("per-task-group-chat.attachChatIdToTask", {
    recordParams: false,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      taskId: args[0]?.id,
      chatId: args[1],
      profile: args[2],
      taskUpdaterInjected: !!args[0] && !!args[0].context,
    }),
  })
  private async attachChatIdToTask(
    task: Task,
    chatId: string,
    profile?: string
  ): Promise<void> {
    const contextStr = (task as { context?: string }).context ?? "{}";
    let parsed: Record<string, unknown> = {};
    try {
      const obj = JSON.parse(contextStr);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        parsed = obj as Record<string, unknown>;
      }
    } catch {
      parsed = {};
    }

    parsed[CTX_FIELD_CHAT_ID] = chatId;
    parsed[CTX_FIELD_CHAT_PROFILE] = profile;
    parsed[CTX_FIELD_CHAT_CREATED_AT] = new Date().toISOString();
    parsed[CTX_FIELD_CHAT_TASK_ID] = task.id;

    const newContext = JSON.stringify(parsed);

    if (!this.taskUpdater) {
      logger.warn(
        `attachChatIdToTask[${this.pluginName}]: ⚠️  no taskUpdater injected, ` +
        `chat_id ${chatId} NOT persisted to db for task #${task.id}. ` +
        `后果：下次 AFTER_UPDATE 从 DB 加载 task 时 getTaskChatId() 返回 undefined，` +
        `所有 update/complete/operation 通知 silently 丢失。` +
        `修复：event-source-handlers.ts:registerPluginHooks 应自动注入 setTaskUpdater。`
      );
      // 仍然更新 task 对象的 context 字段（in-memory），让本次 session 内的后续 hook 能看到
      (task as { context?: string }).context = newContext;
      return;
    }

    try {
      await this.taskUpdater(task.id, newContext);
      // 同步更新 in-memory task 对象
      (task as { context?: string }).context = newContext;
      logger.debug(
        `attachChatIdToTask[${this.pluginName}]: ✅ persisted chat_id ${chatId} ` +
        `to task #${task.id} context`
      );
    } catch (error) {
      logger.error(`Failed to persist chat_id to task #${task.id}: ${error}`);
      // 仍更新 in-memory（让本次 session 内可用）
      (task as { context?: string }).context = newContext;
    }
  }

  // ========================================================================
  // 辅助方法
  // ========================================================================

  /**
   * 从 HookContext 获取 replyChannel
   *
   * 优先级：
   * 1. ctx.metadata.envContext.replyChannel（EventSource 触发）
   * 2. 直接 ctx.metadata.replyChannel
   *
   * ★ P0-1 关键：如果都没有，返回 undefined（调用方应 fallback 到 task.context）
   */
  private getReplyChannelFromCtx(
    ctx: HookContext<unknown>
  ): { messageId?: string; chatId?: string; userId?: string; appId?: string; profile?: string } | undefined {
    const metadata = ctx.metadata as Record<string, unknown> | undefined;

    // ★ P1 修复：先从 AsyncLocalStorage 读 EnvContext（task component 通过 runWithEnvContext 设置）
    // 之前只读 ctx.metadata.envContext.replyChannel，但 task component.executeHook
    // 不传 metadata.envContext，导致 replyChannel 永远是 undefined → plugin silently skip。
    // 与 LarkCliTaskNotifyPlugin (lark-cli-task-notify-plugin.ts:371) 保持一致。
    const alsEnv = getEnvContextOrEmpty();
    if (alsEnv.replyChannel?.chatId) {
      return alsEnv.replyChannel as { messageId?: string; chatId?: string; userId?: string; appId?: string; profile?: string };
    }

    if (!metadata) return undefined;

    // Try ctx.metadata.envContext.replyChannel（eventsource 直接调用 plugin.execute 场景）
    const envCtx = metadata.envContext as
      | { replyChannel?: { messageId?: string; chatId?: string; userId?: string; appId?: string; profile?: string } }
      | undefined;
    if (envCtx?.replyChannel?.chatId) {
      return envCtx.replyChannel;
    }

    // Try direct ctx.metadata.replyChannel
    const direct = metadata.replyChannel as
      | { messageId?: string; chatId?: string; userId?: string; appId?: string; profile?: string }
      | undefined;
    if (direct?.chatId) {
      return direct;
    }

    return undefined;
  }

  /** 从 context JSON 字符串读 larkPerTaskChatId */
  private parseChatIdFromContext(ctxStr?: string): string | undefined {
    if (!ctxStr) return undefined;
    try {
      const obj = JSON.parse(ctxStr);
      const id = (obj as Record<string, unknown>)[CTX_FIELD_CHAT_ID];
      return typeof id === "string" ? id : undefined;
    } catch {
      return undefined;
    }
  }

  /** 从 context JSON 字符串读 larkPerTaskChatProfile（★ P0-1 fallback） */
  private parseProfileFromContext(ctxStr?: string): string | undefined {
    if (!ctxStr) return undefined;
    try {
      const obj = JSON.parse(ctxStr);
      const profile = (obj as Record<string, unknown>)[CTX_FIELD_CHAT_PROFILE];
      return typeof profile === "string" ? profile : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 从 task 读 larkPerTaskChatId（任务**自身**的群）
   */
  private getTaskChatId(task: Task): string | undefined {
    return this.parseChatIdFromContext((task as { context?: string }).context);
  }

  /**
   * 从 task 读 larkPerTaskChatProfile（任务**自身**的群）
   */
  private getTaskChatProfile(task: Task): string | undefined {
    return this.parseProfileFromContext((task as { context?: string }).context);
  }

  /**
   * 解析 task 的"生效群"（Task #4039 C 项：与 CLI notify 路径统一）。
   *
   * 规则：先取任务自身的 `larkPerTaskChatId`；没有则沿 `parent_task_id` 上溯最近的
   * 祖先群（有界 8 层）。与 CLI 的 `resolveNotifyChatIds` 语义一致，保证
   * "更新 / 完成 / 操作"通知与 "notify 镜像"落到**同一个群**（消除 sub-task 更新被
   * silently skip 的不对称）。
   *
   * 未注入 taskGetter 时退化为只读自身 context（保持向后兼容）。
   */
  private async resolveEffectiveChat(
    task: Task
  ): Promise<{ chatId?: string; profile?: string }> {
    const ownChatId = this.getTaskChatId(task);
    if (ownChatId) {
      return { chatId: ownChatId, profile: this.getTaskChatProfile(task) };
    }
    if (!this.taskGetter) return {};

    const seen = new Set<number>();
    let id = (task as { parent_task_id?: number | null }).parent_task_id;
    while (typeof id === "number" && id > 0 && !seen.has(id) && seen.size < 8) {
      seen.add(id);
      let parent: { context?: string; parent_task_id?: number | null } | undefined;
      try {
        parent = await this.taskGetter(id);
      } catch {
        return {};
      }
      if (!parent) return {};
      const chatId = this.parseChatIdFromContext(parent.context);
      if (chatId) {
        return { chatId, profile: this.parseProfileFromContext(parent.context) };
      }
      id = parent.parent_task_id ?? undefined;
    }

    // ★ #4108 P1-b（opt-in）：上溯无果时用 EventStore 反查原始 trigger 群兜底。
    //   仅当 config.resolveToTriggerChatFallback=true 时启用（避免与
    //   LarkCliTaskNotifyPlugin 直发重复——见 config 注释）。
    if (this.config.resolveToTriggerChatFallback) {
      const store = getSharedEventStore();
      const triggerEventId = (
        getEnvContextOrEmpty()?.envEvent as
          | { metadata?: { triggerEventId?: unknown } }
          | undefined
      )?.metadata?.triggerEventId;
      if (store && typeof triggerEventId === "string" && triggerEventId.length > 0) {
        try {
          const triggerEvent = await store.getEventById(triggerEventId);
          const fallbackChatId =
            (triggerEvent?.metadata as { chatId?: string } | undefined)?.chatId ??
            (triggerEvent?.metadata as { replyChannel?: { chatId?: string } } | undefined)
              ?.replyChannel?.chatId;
          if (fallbackChatId) {
            return {
              chatId: fallbackChatId,
              profile:
                (triggerEvent?.metadata as { profile?: string } | undefined)?.profile ??
                (
                  triggerEvent?.metadata as
                    | { replyChannel?: { profile?: string } }
                    | undefined
                )?.replyChannel?.profile,
            };
          }
        } catch {
          // 反查失败不阻断，沿用 skip 语义
        }
      }
    }
    return {};
  }

  /**
   * ★ P0-2 修复：botAppIds 推导
   *
   * 优先级：
   * 1. 用户在 config 显式提供
   * 2. 从 replyChannel.appId 推导（lark-cli 群聊需要 bot 才能"加入"，必须至少有 1 个 botAppId）
   * 3. 空数组（让 lark-cli 自行报错或跳过 --bots 参数）
   */
  private resolveBotAppIds(
    replyChannel: { appId?: string; profile?: string } | undefined
  ): string[] {
    if (this.config.botAppIds.length > 0) {
      logger.debug(
        `resolveBotAppIds[${this.pluginName}]: using config.botAppIds=${JSON.stringify(this.config.botAppIds)}`
      );
      return this.config.botAppIds;
    }

    // Fallback 1: replyChannel.appId（如果 ReplyChannel 类型支持）
    const appId = replyChannel ? (replyChannel as { appId?: string }).appId : undefined;
    if (appId) {
      logger.debug(
        `resolveBotAppIds[${this.pluginName}]: using replyChannel.appId=${appId} (auto-detected from event header.app_id)`
      );
      return [appId];
    }

    // Fallback 2: 没有任何 botAppId 信息，返回空数组
    // createGroupChat 会跳过 --bots 参数，让 lark-cli 用 user 身份建群
    // （用户后续可手动邀请 bot，或 admin 在飞书后台添加 bot）
    logger.warn(
      `resolveBotAppIds[${this.pluginName}]: ⚠️ no botAppIds found, creating group WITHOUT --bots. ` +
      `Bot will NOT be invited automatically. ` +
      `可能原因：(1) eventsource 没有收到 im.message.receive_v1 事件（replyChannel.appId 缺失）；` +
      `(2) 配置了 requireReplyChannel=false 模式；` +
      `(3) buildReplyChannel 没透传 appId（应在 v1.10+ 修复）。` +
      `修复：手动设置 config.botAppIds: ["cli_xxx"] 或确认 eventsource 处理了 lark event。`
    );
    return [];
  }

  /**
   * ★ P0 修复 + Task #3987 扩展：resolveUserIds - 推导要邀请进群聊的 user open_id
   *
   * 不邀请 user → user 看不到群聊（chat 是私有的，只有 bot 在里面）
   *
   * 来源（最终 union 去重）：
   * 1. config.defaultInviteUserIds：始终邀请的静态列表（不含 "sender" 占位符）
   * 2. config.inviteUserIds 中除 "sender" 之外的所有 open_id（静态）
   * 3. config.inviteUserIds 含 "sender" → 自动从 replyChannel/params/ALS 推导 sender
   *    优先级：replyChannel.userId > replyChannel.params?.userId > ALS userId
   * 4. ALS getEnvContextOrEmpty().userId（仅当上面都没拿到时 fallback）
   */
  private resolveUserIds(
    replyChannel: { userId?: string; params?: { userId?: string } } | undefined
  ): string[] {
    const ids = new Set<string>();

    // 1. defaultInviteUserIds（★ Task #3987）：始终邀请，不接受 "sender" 占位符
    if (this.config.defaultInviteUserIds && this.config.defaultInviteUserIds.length > 0) {
      for (const id of this.config.defaultInviteUserIds) {
        if (id && id !== "sender" && id.startsWith("ou_")) {
          ids.add(id);
        } else if (id && id !== "sender") {
          // 非 "sender" 但格式不对（不是 ou_ 开头），记录 warning 便于调试
          logger.debug(
            `resolveUserIds[${this.pluginName}]: skip non-open_id in defaultInviteUserIds: "${id}"`
          );
        }
      }
    }

    // 2. config.inviteUserIds 显式配置（排除 "sender" 占位符）
    if (this.config.inviteUserIds && this.config.inviteUserIds.length > 0) {
      for (const id of this.config.inviteUserIds) {
        if (id !== "sender" && id) ids.add(id);
      }
    }

    // 3. 推导 sender（多 source 优先级：replyChannel.userId > params.userId > ALS userId）
    if (this.config.inviteUserIds?.includes("sender")) {
      const senderId =
        replyChannel?.userId ||
        replyChannel?.params?.userId ||
        getEnvContextOrEmpty().userId;
      if (senderId && senderId.startsWith("ou_")) {
        ids.add(senderId);
      }
    }

    // 4. ALS fallback（如果上面都没拿到 userId，且默认行为是邀请 sender）
    // 注：仅当 inviteUserIds 含 "sender" 才走 fallback（语义保持一致）
    if (ids.size === 0 && this.config.inviteUserIds?.includes("sender")) {
      const alsUserId = getEnvContextOrEmpty().userId;
      if (alsUserId && alsUserId.startsWith("ou_")) {
        ids.add(alsUserId);
      }
    }

    if (isPluginDebugEnabled()) {
      logger.debug(
        `resolveUserIds[${this.pluginName}]: ` +
        `defaultInviteUserIds=${JSON.stringify(this.config.defaultInviteUserIds)} ` +
        `inviteUserIds=${JSON.stringify(this.config.inviteUserIds)} ` +
        `replyChannel.userId=${replyChannel?.userId ?? "(none)"} ` +
        `→ final userIds=${JSON.stringify(Array.from(ids))}`
      );
    }

    return Array.from(ids);
  }

  /**
   * 检查 task 是否是 sub-task
   *
   * 父 task 已建群聊，sub-task 不重复建群（避免群聊爆炸）
   */
  private isSubTask(task: Task): boolean {
    const parentId = (task as Task & { parent_task_id?: number }).parent_task_id;
    return typeof parentId === "number" && parentId > 0;
  }

  /**
   * 检查 update 是否有"有意义"的变更（status / progress / priority）
   *
   * 避免每次 task.update 都发通知（ctx.after.update 在多次 sub-update 时会反复触发）
   */
  private hasMeaningfulChange(changes: Record<string, unknown> | undefined): boolean {
    if (!changes || Object.keys(changes).length === 0) return false;
    const keys = Object.keys(changes);
    // ★ 修复：包含 current_status / tags / goals_and_expected_deliverables
    //   这些是 agent 实际经常更新的字段（如"调研中：检索 GitHub..."），
    //   之前漏掉导致 update 通知 silently skip，user 看不到进度变化。
    return keys.some((k) =>
      [
        "status",
        "progress",
        "priority",
        "title",
        "description",
        "current_status",
        "tags",
        "goals_and_expected_deliverables",
      ].includes(k)
    );
  }

  /**
   * 操作记录节流
   */
  private shouldThrottleOperation(operation: TaskOperation): boolean {
    if (this.config.operationThrottleMs <= 0) return false;

    const taskId = (operation as TaskOperation & { taskId?: number }).taskId ??
                    (operation as unknown as { task_id?: number }).task_id ??
                    0;
    if (taskId === 0) return false;

    const now = Date.now();
    const last = this.lastNotifyTimestamps.get(taskId) ?? 0;
    if (now - last < this.config.operationThrottleMs) {
      return true;
    }
    this.lastNotifyTimestamps.set(taskId, now);
    return false;
  }

  /**
   * 渲染模板字符串
   *
   * ★ P1 修复：同时支持 `#{var}` 和 `{var}` 两种格式
   *
   * 默认模板用 `{var}`（不带 hash），但 renderTemplate 只替换 `#{var}`，
   * 导致群聊标题/描述里残留字面 `{title}` / `{project_path}` 占位符。
   *
   * 现在两种格式都替换：
   * - `#{id}` / `{id}`
   * - `#{title}` / `{title}`
   * - `#{project_path}` / `{project_path}`
   *
   * 同时支持任意其它 `#{xxx}` / `{xxx}` 占位符（不渲染则原样输出，便于 debug）。
   */
  private renderTemplate(template: string, task: Task): string {
    const id = String(task.id);
    const title = this.truncate(task.title ?? "", 60);
    const projectPath = (task as { project_path?: string }).project_path ?? "";

    return template
      // 同时替换 #{var} 和 {var}（优先 #{var}，再 {var}）
      .replace(/#\{id\}/g, id)
      .replace(/(^|[^{]){id\}/g, `$1${id}`)
      .replace(/#\{title\}/g, title)
      .replace(/(^|[^{]){title\}/g, `$1${title}`)
      .replace(/#\{project_path\}/g, projectPath)
      .replace(/(^|[^{]){project_path\}/g, `$1${projectPath}`);
  }

  /**
   * 截断字符串
   */
  private truncate(text: string, maxLen: number): string {
    if (!text) return "";
    if (text.length <= maxLen) return text;
    // ★ maxLen 是包含 "..." 的总长度限制（lark-cli --name 60 / --description 100）
    return text.substring(0, Math.max(0, maxLen - 3)) + "...";
  }

  /**
   * 解析 lark-cli +chat-create 输出 → chat_id
   *
   * lark-cli 输出格式示例：
   * ```json
   * {"ok": true, "data": {"chat_id": "oc_xxx"}}
   * ```
   */
  private parseChatId(stdout: string): string | undefined {
    if (!stdout) return undefined;

    // Try JSON parse
    try {
      const obj = JSON.parse(stdout.trim());
      const data = (obj as { data?: { chat_id?: string; chatId?: string } }).data;
      if (data?.chat_id) return data.chat_id;
      if (data?.chatId) return data.chatId;
    } catch {
      // Not JSON, try regex
    }

    // Fallback regex: extract oc_xxx
    const match = stdout.match(/oc_[a-zA-Z0-9]+/);
    return match ? match[0] : undefined;
  }



}

// ========================================================================
// 工厂函数
// ========================================================================

/**
 * 创建 PerTaskGroupChatPlugin 实例（Hook 工厂）
 */
export function createPerTaskGroupChatPlugin(
  config: PerTaskGroupConfig = {}
): PerTaskGroupChatPlugin {
  return new PerTaskGroupChatPlugin(config);
}