/**
 * @fileoverview LarkCliTaskNotifyHook - LarkCli 任务通知 Hook（Task #4230 重写）
 *
 * 在任务生命周期事件上，把「任务进展」渲染成**一张可更新 + 置顶的飞书卡片**：
 *
 * - `task:after.create`          → notifier.startTask（发卡片 + pin）
 * - `task:after.update`          → notifier.updateTask（patch 同一卡片）
 * - `task:after.complete`        → notifier.finishTask（终态 patch + unpin）
 * - `task:operation:after.create` → notifier.updateTask（把 operation 追加进时间线）
 *
 * ★ Task #4230：**旧逻辑（普通 text/post 消息通知）已全部删除**。
 *   本 Hook 只做卡片，不再有任何 `sendLarkMessage` / `sendNotify` 路径，
 *   也不再有 `buildReplyArgs` / 文本模板（`formatTaskCreated` /
 *   `formatTaskUpdate` / `formatOperationCreated` 等）等死代码。
 *
 * 卡片的样式 / lark-cli 参数契约 / 状态自持（时间线累积 + spinner 轮换）
 * 全部由 `LarkCardPatchNotifier` 负责，见 lark-card-patch-notifier.ts。
 *
 * @example
 * ```typescript
 * import { createLarkCliTaskNotifyHook } from "./lark-cli-task-notify-plugin";
 * globalHookManager.register("task:after.create", createLarkCliTaskNotifyHook({...}));
 * ```
 */

import type { Hook, HookContext } from "../../hook/types";
import { TracedAs } from "../../log-trace/decorator";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type {
  TaskCreateResultContext,
  TaskUpdateResultContext,
  TaskOperationCreateResultContext,
  // ★ Task #4540：删除（取消）结果上下文 { id, deleted }
  TaskDeleteResultContext,
} from "../hooks/contexts";
import type { TaskOperation, Task } from "../types";
import { createLogger } from "../../log-trace/logger";
import {
  getEnvContextOrEmpty,
  getEventFromEnvContext,
  isLarkEvent,
  getLarkMessageId as getLarkMessageIdFromEvent,
} from "../../context";
import { lifecycleOfTaskStatus } from "./lark-card-action-handler";
import {
  humanizeValue,
  LarkCardPatchNotifier,
  getSharedLarkCardNotifier,
  type Milestone,
  type ProcessStep,
  type SessionCardTaskPayload,
  type TaskMeta,
} from "./lark-card-patch-notifier";
import {
  createLarkCardStateStore,
  type LarkCardState,
  type LarkCardStateStore,
} from "./lark-card-state-store";
import {
  decideCardChatTarget,
  extractPerTaskChatId,
  extractPerTaskChatProfile,
  extractRecordedChatNames,
  type CardChatDecision,
} from "./card-chat-routing";

const logger = createLogger("lark-cli:task-notify");

// ====================================================================
// task.context 字段解析（与 PerTaskGroupChatPlugin 同步）
// ====================================================================

/** task.context JSON 字段：task 群聊 ID（PerTaskGroupChatPlugin 持久化） */
const CTX_FIELD_CHAT_ID = "larkPerTaskChatId";
/** task.context JSON 字段：task 群聊 profile（多 appId 场景） */
const CTX_FIELD_CHAT_PROFILE = "larkPerTaskChatProfile";

/**
 * 从 task.context JSON 字符串解析 larkPerTaskChatId
 *
 * 用于让卡片优先落在 user 触发的群里；replyChannel 缺失时回落到 per-task 群。
 */
function parseLarkPerTaskChatId(ctxStr?: string): string | undefined {
  if (!ctxStr) return undefined;
  try {
    const obj = JSON.parse(ctxStr);
    const id = (obj as Record<string, unknown>)[CTX_FIELD_CHAT_ID];
    return typeof id === "string" ? id : undefined;
  } catch {
    return undefined;
  }
}

/** 从 task.context JSON 字符串解析 larkPerTaskChatProfile（多 appId 场景） */
function parseLarkPerTaskChatProfile(ctxStr?: string): string | undefined {
  if (!ctxStr) return undefined;
  try {
    const obj = JSON.parse(ctxStr);
    const profile = (obj as Record<string, unknown>)[CTX_FIELD_CHAT_PROFILE];
    return typeof profile === "string" ? profile : undefined;
  } catch {
    return undefined;
  }
}

// ========================================================================
// Source-specific helper
// ========================================================================

/**
 * 从 EnvContext 提取 lark 专属字段
 *
 * - 优先从 EventEnvelope (event 字段) 提取
 * - Fallback 到 replyChannel
 * - 非 lark source 事件 (github/jira/...) 返回 isLark=false，plugin 跳过
 */
export function extractLarkFields(env: ReturnType<typeof getEnvContextOrEmpty>): {
  messageId?: string;
  chatId?: string;
  userId?: string;
  source?: string;
  isLark: boolean;
} {
  const event = getEventFromEnvContext(env);

  if (!isLarkEvent(event)) {
    return { isLark: false };
  }

  return {
    isLark: true,
    source: event.source,
    messageId:
      getLarkMessageIdFromEvent(event) ??
      (env as { replyChannel?: { messageId?: string } }).replyChannel?.messageId,
    chatId: (env as { replyChannel?: { chatId?: string } }).replyChannel?.chatId,
    userId: (env as { replyChannel?: { userId?: string } }).replyChannel?.userId,
  };
}

// ========================================================================
// 类型定义
// ========================================================================

/**
 * 任务状态是否属于「已收尾」（不该再有新的进展卡片更新）
 *
 * ★ 与全局 `TASK_COMPLETE_TERMINAL_STATUSES` 的关系（**故意不同**）：
 * - 这里 = 全局终态集合 + `archived`（归档任务不该被刷卡片）
 * - `paused` **不在**这里：paused 在 `cardStatusOf()` 就被分流到
 *   `sendCardFinish()` 了，根本走不到本函数的两个调用点（无卡片建卡 guard /
 *   closed 记录判定），写进来只会成为不可达的死代码。
 * - `paused` 也**不**写进全局终态集合：它是可 resume 的，塞进去会让
 *   `task:after.complete` 误 fire（见 onAfterUpdate 里的说明）。
 *
 * ⚠️ 该函数只影响**本插件**的卡片行为，不参与任何全局 hook 决策。
 */
function isTerminalTaskStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "cancelled" ||
    status === "failed" ||
    status === "timeout" ||
    status === "archived"
  );
}

/** 从 notifier 侧引入卡片状态类型（Task #4536：新增 cancelled） */
type CardStatus = import("./lark-card-patch-notifier").CardStatus;

/**
 * task.status → 卡片终态（Task #4536）
 *
 * ★ 旧实现把 `cancelled` 也映射成 `failed` → 卡片显示「🚨 任务失败」，
 *   语义错误（用户主动取消 ≠ 失败）。这里拆开：
 *
 * | task.status | 卡片状态 | 说明 |
 * |-------------|----------|------|
 * | completed   | completed | 正常完成 |
 * | cancelled   | cancelled | 用户取消（灰底「已取消」） |
 * | paused      | stopped   | 暂停 / stop（灰底「已暂停」，可 resume） |
 * | archived    | stopped   | 归档（灰底；归档任务不再有进展） |
 * | failed      | failed    | 执行失败 |
 * | timeout     | failed    | 超时（视为失败） |
 * | 其它        | completed | 兜底（AFTER_COMPLETE 终态收尾只处理真终态；to_validate 由 AFTER_UPDATE 走 running patch） |
 */
function mapTaskStatusToCardStatus(taskStatus: string): Exclude<CardStatus, "running"> {
  switch (taskStatus) {
    case "cancelled":
      return "cancelled";
    case "paused":
    case "archived":
      // archived 走"已停止"（灰底）—— 归档不是完成也不是失败
      return "stopped";
    case "failed":
    case "timeout":
      return "failed";
    default:
      return "completed";
  }
}

/** 通知类型（保留给配置/测试；实际只有卡片一种渲染形态） */
export enum NotifyType {
  TASK_CREATED = "task_created",
  TASK_COMPLETED = "task_completed",
  TASK_UPDATED = "task_updated",
  TASK_FAILED = "task_failed",
  /** 操作记录新增（task:operation:after.create 触发） */
  OPERATION_CREATED = "operation_created",
}

export interface TaskNotifyConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 优先级 */
  priority?: number;
  /** 通知类型（用户可覆盖；空数组 = 全开） */
  notifyTypes?: NotifyType[];
  /** 插件名称（用于 pluginEnabled 检查） */
  pluginName?: string;
  /** 事件源 ID（用于 pluginEnabled 检查） */
  sourceId?: string;
  /**
   * 操作记录通知节流间隔（毫秒）
   *
   * operation 事件在 agent 执行过程中高频触发，不加节流会频繁 patch 卡片。
   * 默认 5000ms；设为 0 表示不节流。
   */
  operationThrottleMs?: number;
  /**
   * 是否启用卡片模式（Task #4192 / #4196 默认 true）
   *
   * ★ Task #4230：卡片是本 Hook 的**唯一**渲染形态。
   *   `cardMode: false` 只是"静默 skip"的 legacy opt-out（旧 sendNotify 已删除），
   *   不会再退化成普通文本消息。
   */
  cardMode?: boolean;
  /**
   * LarkCardPatchNotifier 实例
   *
   * 不传 → plugin 自己 new 一个（messageId 由 plugin 的 Map 跟踪）。
   */
  cardNotifier?: LarkCardPatchNotifier;
  /**
   * 卡片消息持久化 store（Task #4536）
   *
   * 不传 → 自动创建 SQLite 实现（`~/.local/share/roy-bot/lark-cards.db`）；
   * 测试可注入 `MemoryLarkCardStateStore` 或任何符合接口的实现。
   *
   * ★ 为什么需要：原来 messageId 只存内存 Map，进程重启即丢 →
   *   老卡片再也无法 patch（永远停在"进行中"）+ pin 一直挂着。
   */
  cardStateStore?: LarkCardStateStore;
  /**
   * ★ Task #5580：是否在 session 卡之外**再发一张任务卡片**（默认 true）。
   *
   * ## 背景（用户 2026-11-13 定稿）
   *
   * 「之前的任务卡片功能必须保留：lark-cli ES 插件中根据 task hook 触发的
   *   任务卡片消息也要发出来并 pin 住。不能只有 session 卡片——两者并存：
   *   任务卡片（用户关心任务级别）+ session 卡片（调试用，功能以后削弱）」
   *
   * 这**反转**了 #5364 的「单卡语义」（当时定稿：一个 session 只发一张卡，
   * task 信息作为卡上区块）。现在两者并存：
   * - session 卡：会话视角（任务列表 / 执行动态 / 活性）—— 调试用，后续削弱
   * - task 卡：任务视角（进度 / 里程碑 / 建群）—— 用户主关注
   *
   * 设 `false` 可退回 #5364 的单卡语义（软回滚开关）。
   */
  emitTaskCard?: boolean;
  /**
   * ★ Task #5580：config.jsonc 开关读取端口（生产装配注入）。
   * 不传 ⇒ 退回 `emitTaskCard` 代码级默认 / true。
   */
  cardNotifyConfigReader?: () => LarkCardNotifyFlags;
}

/**
 * ★ Task #5580（2026-11-15 补充）：config.jsonc 可配的卡片开关。
 *
 * ## 配置键（config.jsonc）
 *
 * ```jsonc
 * {
 *   "task": {
 *     "plugins": {
 *       "larkCard": {
 *         // task hook 触发的任务卡片（用户主关注，pin）
 *         "emitTaskCard": true,
 *         // sub-session 生命周期触发的 session 卡片（调试用）
 *         "emitSessionCard": true
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * ## 生效方式（热更新）
 *
 * config.jsonc 是 task 组件的 file source（watch 开启）⇒
 * **改文件即生效，无需重启 ES**。开关在每次 hook 执行 / 每次
 * session 生命周期事件时**现读**（不是构造时缓存）。
 *
 * ## 优先级
 *
 * 显式传给 hook 的 `config.emitTaskCard`（代码级）优先于
 * config.jsonc（文件级）—— 便于单测与特殊部署覆盖。
 */
export interface LarkCardNotifyFlags {
  emitTaskCard: boolean;
  emitSessionCard: boolean;
}

/**
 * 卡片路由端口（Task #4230 follow-up）
 *
 * 由 EventSource handler 注入（那里才有 task store / session component /
 * lark-cli）—— 让"卡片该发哪个群"的判定与 IO 解耦，纯逻辑可单测。
 */
export interface CardRoutingPorts {
  /**
   * task 查询（lineage 上溯：无触发群时找本 task / 祖先的专属群兜底）
   *
   * ★ Task #4394：`lookupChatOwnership` / `ensureTaskGroupChat` 两个端口已删除
   *   —— 卡片不再做"触发群是不是别 task 专属群"的判定，也不再自动建群。
   *   建群改由用户在卡片上点「为这个任务建群」按钮触发（见 lark-card-action-handler.ts）。
   */
  getTask?: (
    id: number
  ) => Promise<{ context?: string; parent_task_id?: number | null } | undefined>;
}

// ========================================================================
// LarkCliTaskNotifyHook
// ========================================================================

export class LarkCliTaskNotifyHook implements Hook {
  readonly name: string;
  readonly priority: number;
  readonly description?: string;
  readonly pluginName?: string;
  readonly sourceId?: string;

  private readonly config: TaskNotifyConfig;

  /**
   * ★ Task #5580：config.jsonc 开关的读取端口（可选注入）。
   *
   * 生产装配点（task-component）注入 `taskComponent.getCardNotifyConfig`；
   * 不注入（单测 / 未接线）⇒ 退回 `config.emitTaskCard` 代码级默认。
   * 每次 hook 执行时现读 ⇒ config.jsonc 热更新即时生效。
   */
  cardNotifyConfigReader?: () => LarkCardNotifyFlags;

  /** 卡片模式 notifier 实例 */
  private cardNotifier?: LarkCardPatchNotifier;

  /**
   * 卡片 messageId 跟踪（key: taskId）
   *
   * 同一 task 的 create → update → complete 必须复用同一 messageId
   * （单卡片语义：不刷屏）。不同 task 的卡片互不干扰。
   *
   * ★ Task #4536：这是**进程内缓存**（读穿透 L2 持久化 store 后回填），
   *   权威数据在 `cardStateStore`（SQLite）。重启后从 store 恢复。
   */
  private cardMessageIds: Map<number, string> = new Map();

  /**
   * 卡片记录持久化 store（Task #4536，L2 权威层）
   *
   * 记录 `{taskId → messageId, chatId, profile, pinned, status}`，
   * 让 roy-bot 重启后仍能 patch 同一张卡片、并正确 unpin。
   */
  private cardStateStore?: LarkCardStateStore;

  /**
   * 已经做过「内存 ← 持久层」回填的 taskId 集合
   *
   * `restoreCardState()` 是异步的，而 hook 每来一次事件都会调用它；
   * 用这个集合做一次性短路，避免每次事件都打一次 SQL 查询。
   */
  private restoredTaskIds = new Set<number>();

  /**
   * 操作记录节流状态
   * key: `op:${taskId}`，value: 上次 patch 时间戳
   */
  private lastNotifyTimestamps: Map<string, number> = new Map();

  /**
   * ★ Task #5020 —— 尾沿补发定时器（key: taskId）。
   *
   * 被节流的 operation 只登记一个待补发标记；窗口结束时补发**一次**
   * patch，渲染累积后的完整时间线。见 {@link scheduleTrailingPatch}。
   */
  private trailingPatchTimers: Map<number, ReturnType<typeof setTimeout>> =
    new Map();

  /** 卡片路由端口（由 EventSource handler 注入） */
  private cardRoutingPorts?: CardRoutingPorts;

  /**
   * 卡片启动失败的哨兵值
   *
   * startTask 失败（如 chatId/profile 解析不到、lark-cli 报错）时写入，
   * 让后续 update 直接 skip，避免"失败 → 重试 → 再失败"的风暴。
   */
  private static readonly CARD_START_FAILED_SENTINEL = "__card_start_failed__";

  /**
   * ★ Task #4237 修复：首卡「进行中」哨兵
   *
   * 根因：`sendCardStart` 里 `ensureTaskGroupChat` 会写 task.context → 同步触发
   * `task:after.update` → 本 hook 重入 `sendCardUpdate`；此时首卡 messageId 还没写进
   * `cardMessageIds` → 触发 fallback 补一张重复卡（同一 task 多张卡）。
   * （Task #4394 已删除"再发一张改投卡片"那条路径，哨兵仍用于防重复补卡。）
   *
   * 修法：进入 `sendCardStart` 前先占位；重入的 update 看到哨兵直接跳过。
   */
  private static readonly CARD_START_INFLIGHT_SENTINEL = "__card_start_inflight__";

  constructor(config: TaskNotifyConfig = {}) {
    this.name = config.pluginName || "LarkCliTaskNotifyHook";
    this.priority = config.priority ?? 5;
    this.description = "LarkCli 任务通知 Hook（卡片模式）";
    this.pluginName = config.pluginName;
    this.sourceId = config.sourceId;
    // ★ Task #5580：config.jsonc 开关读取端口（构造时注入）
    if (config.cardNotifyConfigReader) {
      this.cardNotifyConfigReader = config.cardNotifyConfigReader;
    }
    this.config = {
      enabled: true,
      priority: 5,
      notifyTypes: [
        NotifyType.TASK_CREATED,
        NotifyType.TASK_UPDATED,
        NotifyType.TASK_COMPLETED,
        NotifyType.OPERATION_CREATED,
      ],
      ...config,
    };
    // Task #4196: 默认卡片模式（显式 cardMode=false 才禁用）
    if (this.config.cardMode !== false) {
      // ★ Task #5364 返工（BLOCKER-4/5/6）：默认用**进程共享单例**，不再 new。
      //
      // ## 为什么（真机事故，55 条测试全绿但生产发 3 张卡）
      //
      // `sessionCardIds` / `sessionStates` 是 notifier **实例**字段。上一版
      // 本 hook 自己 `new` 一个、事件线程的 `sessionCardSender` 又靠
      // `env.getPluginInstance()` 去"借"（生产 env 没这个属性 ⇒ 又 new 一个）
      // ⇒ 两者不是同一实例 ⇒ session 卡 patch 永远找不到已有卡 ⇒ 每事件发新卡；
      // 且 task 卡（本 hook 的 notifier）与 session 卡分属两实例 ⇒ 并列两张、
      // 状态永不同步。
      //
      // 走单例后：**task 更新 / session 生命周期 / 用户点刷新** 全部命中同一个
      // notifier ⇒ 一个 session 只有一张卡，且 task 区块与 session 焊在同一张上。
      //
      // 显式传 `cardNotifier`（单测 / 多租户）行为不变 —— 测试隔离性不破坏。
      // ★ CV R3 m1：**测试环境**下不传 cardNotifier 时用**独立实例**。
      //
      // 生产必须共享单例（一个 session 一张卡）；但大量既有单测
      // `new LarkCliTaskNotifyHook()` 不传 notifier，共享单例会让
      // `sessionCardIds` 跨用例残留（"找到上一用例的卡" → 本该 send 却 patch），
      // 变成难查的 flake。
      //
      // 判据只用 NODE_ENV/BUN_TEST_WORKER_ID（生产两者都没有），显式传
      // cardNotifier 的调用方不受影响。
      const isTestEnv =
        process.env.NODE_ENV === "test" ||
        "BUN_TEST_WORKER_ID" in process.env;
      this.cardNotifier =
        config.cardNotifier ??
        (isTestEnv ? new LarkCardPatchNotifier() : getSharedLarkCardNotifier());
      // Task #4536: 持久化层（不传则自动创建 SQLite；创建失败自动降级内存）
      this.cardStateStore =
        config.cardStateStore ?? createLarkCardStateStore();
    }
  }

  /**
   * 注入卡片路由端口（Task #4230 follow-up）
   *
   * 未注入时退化为旧行为（触发群优先，不做"别 task 专属群"判定）。
   */
  setCardRoutingPorts(ports: CardRoutingPorts): void {
    this.cardRoutingPorts = ports;
    logger.debug(
      `CardRoutingPorts injected: getTask=${typeof ports.getTask}`
    );
  }

  /** 诊断：端口是否注入 */
  hasCardRoutingPorts(): boolean {
    return this.cardRoutingPorts !== undefined;
  }

  /**
   * ★ Task #5580：emitTaskCard 的**现读**语义。
   *
   * 优先级：显式 config.emitTaskCard（代码级）> config.jsonc
   * （文件级，经 cardNotifyConfigReader）> 默认 true。
   *
   * 为什么不用构造时缓存：config.jsonc 是 file source（watch 开），
   * 用户改文件应即时生效 —— 每次执行现读。
   */
  private currentEmitTaskCard(): boolean {
    // 代码级显式配置（含单测注入）优先
    if (this.config.emitTaskCard !== undefined) {
      return this.config.emitTaskCard !== false;
    }
    try {
      const flags = this.cardNotifyConfigReader?.();
      if (flags) return flags.emitTaskCard !== false;
    } catch {
      /* 配置读取失败 → 安全侧默认 true */
    }
    return true;
  }

  @TracedAs("lark-cli-task-notify.execute")
  async execute(ctx: HookContext<unknown>): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    // 检查插件是否启用（通过 pluginEnabled）
    const env = getEnvContextOrEmpty();
    if (this.pluginName && this.sourceId) {
      const key = `${this.sourceId}:${this.pluginName}`;
      if (env.pluginEnabled && env.pluginEnabled[key] !== true) {
        logger.debug(`Plugin not enabled for source: ${key}`);
        return;
      }
    }

    switch (ctx.hookPoint) {
      case TaskHookPoints.AFTER_CREATE:
        await this.onAfterCreate(ctx as HookContext<TaskCreateResultContext>);
        break;
      case TaskHookPoints.AFTER_UPDATE:
        await this.onAfterUpdate(ctx as HookContext<TaskUpdateResultContext>);
        break;
      case TaskHookPoints.AFTER_COMPLETE:
        await this.onAfterComplete(ctx as HookContext<unknown>);
        break;
      case TaskHookPoints.OPERATION_AFTER_CREATE:
        await this.onAfterOperationCreate(
          ctx as HookContext<TaskOperationCreateResultContext>
        );
        break;
      // ★ Task #4540：任务被「取消」（硬删除）→ 卡片收尾 + unpin
      case TaskHookPoints.AFTER_DELETE:
        await this.onAfterDelete(ctx as HookContext<TaskDeleteResultContext>);
        break;
    }
  }

  // ========================================================================
  // Hook handlers
  // ========================================================================

  /** 任务创建：发初始卡片（+ pin） */
  private async onAfterCreate(
    ctx: HookContext<TaskCreateResultContext>
  ): Promise<void> {
    const { task, sessionId: ctxSessionId } = ctx.data as TaskCreateResultContext;
    if (!task || !this.shouldNotify(NotifyType.TASK_CREATED)) return;
    if (!this.isCardModeEnabled()) return;

    // ★ Task #5364 返工（BLOCKER-5）：有 sub-session 时**只发一张 session 卡**，
    //   task 信息作为卡上的区块渲染；不再另发 task 卡（用户 08:13 定稿）。
    //
    // ★ Task #5390（追加需求）：**优先用 hook context 里的 sessionId**。
    //
    //   用户 14:05：「if subsession 有任务，任务的这些信息也要自动同步到 sub
    //   session 卡片中」—— 实测群里发的却是纯 task 卡（缺会话详情 / 任务信息 /
    //   子会话活性），根因就在这一行：
    //
    //   `createTask()` 手里的 `sessionId` 是**准的**（来自 tool ctx），并已塞进
    //   `TaskCreateResultContext.sessionId`（hooks/contexts.ts:70）。但这里原来
    //   只解构 `task`，转而调 `resolveSessionIdForTask(task.id)` 反查 —— 而该
    //   反查的三级来源在「task 创建的第一刻」**必然全空**：
    //     1. `cardNotifier.getSessionIdByTask()`  —— 内存索引，首卡还没发过
    //     2. `cardStateStore.get(taskId).sessionId` —— 持久层，还没写过
    //     3. `EnvContext.sessionId`               —— hook 执行期 env，非 tool ctx
    //   ⇒ 拿到 undefined ⇒ 跳过 session 卡 ⇒ 回落发纯 task 卡。
    //
    //   反查只作**兜底**（ctxSessionId 缺失时），不影响 #5364 的单卡语义。
    const sessionId =
      typeof ctxSessionId === "string" && ctxSessionId.trim()
        ? ctxSessionId.trim()
        : this.resolveSessionIdForTask(task.id);

    // ★ Task #5580（用户 2026-11-13 定稿）：**任务卡片与 session 卡片并存**。
    //
    //  التاريخ：#5364 定的是「单卡语义」—— 有 sub-session 就只发 session 卡，
    // task 信息当卡上区块。用户现在明确要**两卡并存**：
    //   - 任务卡片（task hook 触发，pin 住）← 用户关心任务级别
    //   - session 卡片（会话视角，调试用，后续削弱）
    //
    // 所以先 patch session 卡（需求一的那张），再**照常**发 task 卡（不 return）。
    // `emitTaskCard: false` 可退回单卡语义（软回滚）。
    const emitTaskCard = this.currentEmitTaskCard();
    if (sessionId) {
      const merged = await this.patchSessionCardForTask(task, {
        sessionId,
        lifecycle: "running",
        milestones: [
          {
            title: "Task 创建",
            timestamp: new Date().toISOString(),
            description: task.current_status || undefined,
          },
        ],
      });
      if (merged) {
        logger.debug(
          `onAfterCreate: task #${task.id} 已渲染进 session 卡 ${sessionId}` +
            `（${emitTaskCard ? "并存：继续发任务卡片" : "单卡语义：不再发任务卡片"}）`,
        );
        if (!emitTaskCard) return;
      }
    }

    await this.sendCardStart(task);
  }

  /** 任务更新：patch 卡片（进度/当前步骤/状态） */
  private async onAfterUpdate(
    ctx: HookContext<TaskUpdateResultContext>
  ): Promise<void> {
    const data = ctx.data as TaskUpdateResultContext;
    if (!data?.task) return;
    const { task, changes } = data;

    // ★ Task #4536：终态 / 暂停判定统一走 cardStatusOf()
    //
    //   - completed / cancelled / paused / failed / timeout → 走 sendCardFinish
    //     （patch 终态文案 + unpin）
    //   - 其余（active / 进度变化）→ 走 sendCardUpdate（普通 patch，不动 pin）
    //
    // ★ 为什么 paused 走这里而不是扩 TASK_COMPLETE_TERMINAL_STATUSES（并经 xval 复核更正）：
    //
    //   1. **语义**：paused **不是**终结 —— 任务可以 resume，把它并入
    //      "terminal status" 会让所有 `task:after.complete` 订阅者收到一个
    //      "结束了"的信号，这在语义上是错的。
    //   2. **影响面**：该常量目前唯一的消费点是 `task-component.updateTask`
    //      → 是否 fire AFTER_COMPLETE。订阅方有 `registry-hook-installer`
    //      （收到后会 `safeUpdate` 把 registry 里该 task 刷新一遍）和
    //      `PerTaskGroupChatPlugin.onAfterComplete`（Task #4237 之后已是
    //      no-op，不会发群消息）。所以扩集合**不会**像早先注释写的那样
    //      "误发任务完成摘要到群"，但它会造成多余的 registry 刷新 + 语义污染。
    //   3. 结论仍成立：只在本插件内部把 paused 当"收尾事件"处理，影响面最小。
    //      （早先的注释夸大了影响，xval round2 NIT-2 指出后已更正。）
    const terminalCardStatus = this.cardStatusOf(task, changes);

    if (terminalCardStatus) {
      const notifyType =
        terminalCardStatus === "completed" || terminalCardStatus === "cancelled"
          ? NotifyType.TASK_COMPLETED
          : NotifyType.TASK_UPDATED;
      if (!this.shouldNotify(notifyType)) return;
      if (!this.isCardModeEnabled()) return;

      // ★ Task #5364 返工（BLOCKER-6，08:15「飞书自动同步」）：
      //   任务状态更新**自动 patch 同一张 session 卡**。
      //
      // ★ Task #5580（两卡并存）：session 卡 patch 成功后**不再 return** ——
      //   任务卡片也有自己的生命周期（终态文案 + unpin），漏掉这一步会让
      //   任务卡片永远停在「进行中」且 pin 一直挂着（用户明确要 pin 住的是
      //   进行中的任务卡，完成时应当收尾）。
      //   `emitTaskCard: false`（单卡回滚）保持原来的 return 语义。
      const emitTaskCardTerminal = this.currentEmitTaskCard();
      const sessionIdTerminal = this.resolveSessionIdForTask(task.id);
      if (sessionIdTerminal) {
        const mergedTerminal = await this.patchSessionCardForTask(task, {
          sessionId: sessionIdTerminal,
          lifecycle: (lifecycleOfTaskStatus(String(task.status)) ?? "running"),
          milestones: [
            {
              title: terminalCardStatus === "completed" ? "任务已完成" : "任务状态更新",
              timestamp: new Date().toISOString(),
              description: task.current_status || undefined,
            },
          ],
        });
        if (mergedTerminal && !emitTaskCardTerminal) return;
      }

      await this.sendCardFinish(task);
      return;
    }

    let notifyType: NotifyType;
    if (changes?.status) {
      notifyType = NotifyType.TASK_UPDATED;
    } else if (changes && Object.keys(changes).length > 0) {
      notifyType = NotifyType.TASK_UPDATED;
    } else {
      return; // 无变更，不通知
    }

    if (!this.shouldNotify(notifyType)) return;
    if (!this.isCardModeEnabled()) return;

    // ★ Task #5364 返工（BLOCKER-5/6）：进度/状态更新也写进同一张 session 卡。
    //
    // ★ Task #5580（两卡并存）：session 卡 patch 成功后**不再 return** ——
    //   任务卡片的进度/里程碑也要同步（否则任务卡永远停在创建时刻的 0%）。
    //   `emitTaskCard: false`（单卡回滚）保持原来的 return 语义。
    const emitTaskCardUpdate = this.currentEmitTaskCard();
    const sessionIdUpdate = this.resolveSessionIdForTask(task.id);
    if (sessionIdUpdate) {
      const mergedUpdate = await this.patchSessionCardForTask(task, {
        sessionId: sessionIdUpdate,
        lifecycle: (lifecycleOfTaskStatus(String(task.status)) ?? "running"),
      });
      if (mergedUpdate && !emitTaskCardUpdate) return;
    }

    await this.sendCardUpdate(task, changes);
  }

  /**
   * 判定本次 update 是否属于「收尾」事件（Task #4536）
   *
   * 返回卡片终态；`undefined` 表示这是普通进展更新（继续 patch，不动 pin）。
   *
   * 依据 `changes.status`（本次变更）**优先**，其次看 `task.status`（当前值）——
   * 因为 AFTER_UPDATE 里 `changes` 只包含本次更新的字段，resume 时 status 变回
   * active（`changes.status === "active"`）必须能正确翻回 open。
   */
  private cardStatusOf(
    task: Task,
    changes: Partial<{ status?: string; progress?: number }> | undefined
  ): Exclude<CardStatus, "running"> | undefined {
    const changedStatus = changes?.status;
    const effective = String(changedStatus ?? task.status ?? "");

    switch (effective) {
      case "completed":
        return "completed";
      case "cancelled":
        return "cancelled";
      case "paused":
        return "stopped";
      case "archived":
        // ★ xval MINOR 8：归档任务不再有进展，卡片必须收尾 + unpin，
        //   否则会永远显示"进行中"且一直置顶（旧行为如此，本次顺手修掉）。
        return "stopped";
      case "failed":
      case "timeout":
        return "failed";
      default:
        break;
    }

    // ★ xval MAJOR 1（回归修复）：**不再**把 `progress === 100` 当完成。
    //
    //   旧实现（Task #4536 之前就有的兼容分支）会在 `task.status` 仍是 active
    //   时把卡片 close + unpin，造成两个真实问题：
    //   1. 卡片被提前判死，但任务其实还在跑（用户看到"已完成"却还在更新）；
    //   2. 下一次 update 命中 reopen 分支 → **再发一张新卡并 pin** →
    //      同一个任务两张卡（违反"绝不能重复发卡"的验收点）。
    //   `progress=100` 只是进度字段，判定终态必须看 `status`。
    return undefined;
  }

  /** 任务终态：patch 终态 + unpin */
  private async onAfterComplete(ctx: HookContext<unknown>): Promise<void> {
    const data = ctx.data as
      | { task?: Task; terminalStatus?: string }
      | Task;
    const task = (data as { task?: Task })?.task ?? (data as Task);
    if (!task || !this.shouldNotify(NotifyType.TASK_COMPLETED)) return;
    if (!this.isCardModeEnabled()) return;

    // ★ Task #5073（DS review MAJOR-1）—— to_validate 不是「验收完成」。
    //
    //   两阶段验收：preCompleteTask 会显式 fire AFTER_COMPLETE
    //   （terminalStatus="to_validate"）作为 sub-agent 的 goal 自查关。
    //   此时任务只是「待验证」—— 卡片若走 sendCardFinish 会显示
    //   「已完成」并 unpin，与「验收还没发生」直接矛盾。
    //
    //   卡片更新由 AFTER_UPDATE → cardStatusOf 负责：to_validate
    //   落 default 分支返回 undefined ⇒ 普通 running patch，不收尾。
    //   这里只放行真验收完成（terminalStatus="completed"）。
    const terminalStatus = (data as { terminalStatus?: string }).terminalStatus;
    if (terminalStatus === "to_validate" || task.status === "to_validate") {
      return;
    }

    await this.sendCardFinish(task);
  }

  /**
   * 任务被**删除**（用户口中的「取消」）→ 卡片收尾 + unpin（Task #4540）
   *
   * ## 为什么需要这个 handler
   *
   * 用户真机反馈：「我测试创建了一个任务，然后又取消了他。但是这个卡片消息没有
   * 变化，然后这个 pin 也没有取消。」
   *
   * 实测发现「取消」有两种完全不同的语义，走两条完全不同的代码路径：
   *
   * | 用户/工具意图            | 实际调用                       | 触发 hook            |
   * |--------------------------|--------------------------------|----------------------|
   * | `tasks update --status cancelled` | `updateTask(status="cancelled")` | `task:after.update` → `cardStatusOf` → `sendCardFinish` ✅ 早已支持 |
   * | 直接「取消/删除」任务     | **`deleteTask()`（硬删除）**    | `task:after.delete` → **本 handler** |
   *
   * 旧代码只处理了前者 → 后者卡片永远停在"进行中"、pin 永远挂着。
   *
   * ## 为什么必须依赖持久层（#4536 的价值）
   *
   * `TaskDeleteResultContext` 只有 `{ id, deleted }` —— **拿不到 Task 对象**
   * （数据已经从 store 删了）。能用的只有：
   * 1. `cardStateStore`（#4536 持久化的 `lark-cards.db`）→ messageId / chatId / profile
   * 2. `cardNotifier` 内存态（同进程内刚发过卡时）→ 里程碑 / 过程步骤 / 进度
   *
   * 两者都没有 → 说明这个任务从来没发过卡（或库被清）→ 静默 skip，**绝不发新卡**。
   *
   * ## 幂等 / 降级
   *
   * - `deleted === false` → 删除失败，任务还在 → 什么都不做
   * - 记录缺失 / messageId 为空 → skip（debug log）
   * - patch 失败 → warn，**仍继续 unpin**（卡片文案改不了但 pin 必须取消）
   * - unpin 失败 → warn，不抛
   */
  private async onAfterDelete(
    ctx: HookContext<TaskDeleteResultContext>
  ): Promise<void> {
    const data = ctx.data as TaskDeleteResultContext;
    const taskId = data?.id;
    // 删除失败 = 任务还在 → 卡片应保持原状
    if (data?.deleted !== true || typeof taskId !== "number") return;
    if (!this.shouldNotify(NotifyType.TASK_COMPLETED)) return;
    if (!this.isCardModeEnabled()) return;
    if (!this.cardNotifier) return;

    // 1. 定位卡片：持久层优先（跨重启），内存 Map 兜底（同进程）
    let record: LarkCardState | undefined;
    try {
      record = this.cardStateStore?.get(taskId);
    } catch (err) {
      logger.warn(
        `onAfterDelete: 读取卡片记录失败 task #${taskId}: ${(err as Error).message}`
      );
    }

    const messageId = record?.messageId || this.cardMessageIds.get(taskId);
    if (!messageId) {
      // 从来没发过卡（或记录被清）→ 幂等 skip，不补卡
      logger.debug(
        `onAfterDelete: task #${taskId} 无卡片记录，skip（不发新卡）`
      );
      return;
    }

    // 2. 恢复卡片内容（里程碑 / 过程步骤 / 进度），否则终态卡片会丢历史
    this.restoreCardState(taskId);

    const profile = record?.profile;
    const chatId = record?.chatId;

    // 3. patch 终态文案 + unpin
    //    ⚠️ 这里刻意**不**复用 `sendCardFinish(task)`：它需要 Task 对象
    //    （buildTaskMeta(task) 等），而 delete 后 Task 已不存在。
    //    卡片 meta / 里程碑 / 过程步骤全部来自持久层 + notifier 内存态。
    //
    //    `finishTask` 内部 = patch + unpin（`unpinOnFinish` 默认 true），但：
    //    1. patch 抛错时，异常会穿出 mutex 块 → **内部 unpin 整段被跳过**；
    //    2. unpin 自己失败时，它内部 try/catch(→warn) 会把错误吞掉 → 外层无感知。
    //    两种情况下 pin 都可能残留在用户界面上（正是用户报的现象）——
    //    所以第 4 步必须**无条件**再显式试一次 unpin（xval MINOR-1）。
    try {
      await this.cardNotifier.finishTask({
        messageId,
        profile,
        chatId,
        status: "deleted",
        finalStep: "任务已取消（删除）",
      });
    } catch (err) {
      // patch 失败不能阻断 unpin（用户最在意的是 pin 别再挂着）
      logger.warn(
        `onAfterDelete: patch 卡片失败 task #${taskId} message=${messageId}: ${(err as Error).message}`
      );
    }

    // 4. 无条件补一次显式 unpin（xval MINOR-1）
    //
    //    为什么不能"只在 patch 失败时补"：
    //    `finishTask` **内部**的 unpin 自带 try/catch(→warn)，失败会被它自己吞掉，
    //    外层永远观察不到那个失败 —— 恰恰是「unpin 失败」这种最该重试的情况
    //    不会重试，pin 依旧挂着（正是用户报的现象）。
    //
    //    `im pins delete` 对未置顶消息是幂等的（只返回 not found），
    //    所以成功路径上多跑一次是安全的，换来"pin 一定会被再尝试一次"的保证。
    try {
      await this.cardNotifier.unpinMessage(messageId, profile);
    } catch (err) {
      logger.warn(
        `onAfterDelete: unpin 失败 task #${taskId} message=${messageId}: ${(err as Error).message}`
      );
    }

    // 5. 持久化：closed（保留记录便于追溯，不删行）
    // ★ Task #5020 —— 删除也要取消待补发，避免对已删除卡再 patch
    this.cancelTrailingPatch(taskId);

    this.persistClosed(taskId);
    this.persistPinned(taskId, false);
    this.cardMessageIds.delete(taskId);

    logger.debug(
      `onAfterDelete: task #${taskId} 卡片已收尾 status=deleted message=${messageId}`
    );
  }

  /**
   * 操作记录创建：把 operation 追加进卡片时间线
   *
   * ★ Task #4230：只在卡片已存在时 patch。
   *   旧实现会 fallback `startTask`（凭空多发一张卡）——已删除。
   */
  private async onAfterOperationCreate(
    ctx: HookContext<TaskOperationCreateResultContext>
  ): Promise<void> {
    const { operation } = ctx.data as TaskOperationCreateResultContext;
    if (!operation) return;
    if (!this.shouldNotify(NotifyType.OPERATION_CREATED)) return;
    if (!this.isCardModeEnabled()) return;

    // ★ xval round2 MINOR 4：先从持久层回填 —— 否则重启后 operation 事件
    //   找不到内存里的 messageId，整个时间线追加路径失效（0 次 lark-cli 调用），
    //   "重启后仍能 patch 同一张卡" 就只覆盖了 update/complete 两条路径。
    const persisted = this.restoreCardState(operation.taskId);
    const messageId = this.cardMessageIds.get(operation.taskId);
    if (
      !messageId ||
      messageId === LarkCliTaskNotifyHook.CARD_START_FAILED_SENTINEL ||
      messageId === LarkCliTaskNotifyHook.CARD_START_INFLIGHT_SENTINEL
    ) {
      logger.debug(
        `onAfterOperationCreate: no usable card for task #${operation.taskId}, skip`
      );
      return;
    }
    // 终态/暂停的卡片不再追加时间线（避免把已收尾的卡又刷成"进行中"）
    if (persisted && persisted.status !== "open") {
      logger.debug(
        `onAfterOperationCreate: task #${operation.taskId} card status=${persisted.status}, skip`
      );
      return;
    }

    // 每条 operation 各自贡献一条里程碑 + 一条过程步骤。
    const { milestones, processSteps } = this.deriveTimelineFromOperation(operation);
    if (milestones.length === 0 && processSteps.length === 0) return;

    const env = getEnvContextOrEmpty();
    const profile = env.replyChannel?.profile;

    // ★ Task #5020 —— 节流**只该限制 patch 频率，绝不该丢掉里程碑**。
    //
    // 旧实现：`shouldThrottleOperation()` 返回 true 就直接 `return`，
    // 那条 operation 的里程碑**从此消失** —— 既没进卡片，也没进 ledger。
    // agent 在 5s 内连记两条里程碑是常态（阶段很短），于是用户看到
    // 「agent 明明记了 N 条，卡片上一条都没有」。
    //
    // 新语义（两级，**卡片可见性有保证**）：
    //   1. **总是**先把里程碑并进 notifier 的内存态（`mergeTimelineState`）
    //      —— 不发 lark-cli，但内存态与 ledger 快照立刻包含它；
    //   2. 被节流 → `updateTask({ milestones: [] })` **仍 patch 一次**，
    //      让 `updateTask` 用**累积后的内存时间线**重渲染整张卡。
    //      这样「被节流的里程碑」当场就出现在卡片上（不依赖后续事件），
    //      代价只是**没有额外多一次** patch 内容 —— 实际仍是每次 operation
    //      一次 patch。若想真正省 patch，用 `operationThrottleMs: 0` 关闭节流
    //      会得到同样的行为，因此节流的价值退化为「连续 N 条只渲染一次」。
    //
    // ★ 关键不变式：**任何一条 operation 的里程碑，本次事件结束前一定已经
    //   出现在（a）notifier 内存态、（b）共享 ledger、（c）飞书卡片**。
    //   三者缺一，用户的可见时间线就会有洞。
    // 1) ★ 数据先行：无论节流与否，先把里程碑并进内存态。
    //    —— 这一步不碰飞书，只是让「内存态是完整的」成为不变式。
    this.cardNotifier!.mergeTimelineState?.(messageId, milestones, processSteps);

    // 2) ★ 落库先行（且**与 patch 解耦**）。
    //
    //    为什么必须在 patch 之前、且不受 patch 成败影响：
    //    - 别的进程（daemon）只能从共享 ledger 回填，而终态卡片就是
    //      daemon 用 ledger 内容重建的（Task #5020 的根因）；
    //    - 如果 patch 抛错就跳过落库，这条 operation 的时间线在跨进程
    //      视角下仍然丢了 —— review round-2 MINOR 指出的正是这点。
    //    `refreshTimeline` 内部自带 try/catch，失败只 warn。
    this.refreshTimeline(operation.taskId);

    // 3) patch 走节流窗口（尾沿节流 / trailing-edge）。
    //
    //    ★ 语义（Task #5020，review round-2 MAJOR 后定稿）：
    //    - **窗口外的第一条** → 立即 patch（用户看到实时性）；
    //    - **窗口内的后续** → 不 patch，只登记「有待补发」，并起一个
    //      定时器在窗口结束时补发**一次**，用当时累积的完整时间线渲染。
    //
    //    这样两个目标同时成立：
    //      a. 任何一条 operation 的里程碑，最终一定出现在卡片上
    //         （最迟 = 窗口结束，而不是「等下一个不知何时到来的事件」）；
    //      b. patch 频率仍然被 operationThrottleMs 约束
    //         （N 条挤在一个窗口里只发 1 次 trailing patch）。
    const throttled = this.shouldThrottleOperation(operation);

    if (throttled) {
      this.scheduleTrailingPatch(operation.taskId, messageId, profile);
      logger.debug(
        `[throttle] OPERATION_CREATED for task #${operation.taskId} ` +
          `merged into state + ledger; card patch deferred to window end`
      );
      return;
    }

    await this.patchOperationTimeline(operation.taskId, messageId, profile, milestones, processSteps);
  }

  /**
   * ★ Task #5020 —— 立即 patch 一次 operation 时间线。
   *
   * 失败只记日志：**不能**因为飞书侧失败就丢掉已经落进 ledger 的数据
   * （ledger 落库在调用方、且早于本方法）。
   */
  private async patchOperationTimeline(
    taskId: number,
    messageId: string,
    profile: string | undefined,
    milestones: Milestone[],
    processSteps: ProcessStep[]
  ): Promise<void> {
    try {
      // meta 不传 → 沿用 state 里缓存的栏位信息（operation 事件拿不到完整 task）
      await this.cardNotifier!.updateTask({
        messageId,
        profile,
        status: "running",
        milestones,
        processSteps,
      });
    } catch (err) {
      logger.error(
        `sendCardOperation failed for task #${taskId}: ${(err as Error).message}`
      );
    }
  }

  /**
   * ★ Task #5020 —— 尾沿补发：窗口结束时把累积的时间线 patch 一次。
   *
   * ## 为什么需要（review round-2 MAJOR）
   *
   * 若「被节流就不 patch」，那条里程碑可能永远不上卡（等不到下一个事件）；
   * 若「被节流也立刻 patch」，节流就完全没有减少 patch 次数，形同虚设。
   *
   * 尾沿补发是两者的正解：窗口内的 N 条只排队、**不发**；窗口一结束补发
   * **一次**，渲染当时**累积后的完整时间线**（`updateTask` 传空数组即用
   * state 里的全部里程碑）。于是「可见性」与「限频」同时满足。
   *
   * - 同一 task 同时只挂一个定时器（重入只刷新，不叠加）
   * - 定时器 `unref()`，不阻止进程退出
   * - 补发失败只 warn（数据已在 ledger，跨进程回填仍有保障）
   */
  private scheduleTrailingPatch(
    taskId: number,
    messageId: string,
    profile?: string
  ): void {
    const existing = this.trailingPatchTimers.get(taskId);
    if (existing) {
      // 已在排队 → 复用那个定时器（窗口不延长，语义是「窗口结束补发」）
      return;
    }
    const throttleMs = this.config.operationThrottleMs ?? 5000;
    const delay = throttleMs > 0 ? throttleMs : 0;
    const timer = setTimeout(() => {
      this.trailingPatchTimers.delete(taskId);

      // ★ Task #5020（review round-3 MAJOR）—— 补发前**必须**重新校验卡片还活着。
      //
      // 竞态：operation 在窗口内登记了 timer，紧接着任务完成 →
      // `finishTask` patch 终态卡并**清掉 notifier 的内存 state**
      // （`states.delete(messageId)`）。如果此时 timer 照常触发，
      // `updateTask` 会因为找不到 state 而用**空的默认 state** 重建卡片，
      // 把「已完成」刷回「进行中」，并且里程碑序列变成空 —— 比原来的 bug 更糟。
      //
      // 所以补发前过两道闸：
      //   1. 内存里已经没有该 task 的 messageId（终态清理过）→ 放弃补发；
      //   2. 持久层记录已不是 open（closed / paused）→ 放弃补发。
      const liveMessageId = this.cardMessageIds.get(taskId);
      if (liveMessageId !== messageId) {
        logger.debug(
          `[throttle] trailing patch skipped for task #${taskId}: ` +
            `card no longer tracked (finished/closed)`
        );
        return;
      }
      const rec = this.cardStateStore?.get(taskId);
      if (rec && rec.status !== "open") {
        logger.debug(
          `[throttle] trailing patch skipped for task #${taskId}: ` +
            `card status=${rec.status}`
        );
        return;
      }

      // 传空数组 → updateTask 用 state 里已累积的完整时间线重渲染
      void this.patchOperationTimeline(taskId, messageId, profile, [], []);
    }, delay);
    if (typeof timer.unref === "function") timer.unref();
    this.trailingPatchTimers.set(taskId, timer);
  }

  /**
   * ★ Task #5020 —— 取消该 task 待补发的尾沿 patch（终态 / 暂停时调用）。
   *
   * 与 {@link scheduleTrailingPatch} 里的二次校验互为双保险：
   * 这里主动取消，避免即使校验通过也多发一次无意义的 patch。
   */
  private cancelTrailingPatch(taskId: number): void {
    const timer = this.trailingPatchTimers.get(taskId);
    if (!timer) return;
    clearTimeout(timer);
    this.trailingPatchTimers.delete(taskId);
  }

  // ========================================================================
  // ★ Task #4536 — 卡片记录持久化 helpers（全部失败降级，绝不抛出）
  // ========================================================================

  /**
   * 从持久层回填内存 messageId（一次性/幂等）
   *
   * 进程重启后内存 Map 是空的；第一次收到该 task 的事件时从这里恢复
   * 原卡片的 messageId / chatId / profile / pin 状态，从而 patch 到**同一张卡**
   * 而不是重新发一张新的（用户诉求 A 的核心验收点）。
   *
   * ★ 已 `closed` 的记录不再回填 messageId：终态卡片已经 unpin 且不应再被 patch；
   *   如果该 task 后来被重新打开（新 create），会走全新建卡流程。
   * ★ 已 `paused` 的记录**要**回填：pause → resume 后必须复用同一张卡。
   */
  @TracedAs("lark-card.restoreState", {
    recordParams: true,
    paramFilter: (args) => ({ taskId: args[0] }),
  })
  private restoreCardState(taskId: number): LarkCardState | undefined {
    if (!this.cardStateStore) return undefined;
    try {
      const rec = this.cardStateStore.get(taskId);
      if (!rec) return undefined;

      // ★ Task #5364 返工（BLOCKER-6 重启分支）：恢复 task→session 绑定。
      //
      // 重启后 notifier 的 `taskToSessionId` 是空的 ⇒ `resolveSessionIdForTask`
      // 只能从持久层读（本方法下面那行就够），但**必须**先把绑定写回 notifier，
      // 否则 `patchSessionCardForTask` 找不到 session 卡（sessionCardIds 也是空的，
      // 因此它会走 startSessionCard 再发一张 = 又变两张卡）。
      if (rec.sessionId) {
        this.cardNotifier?.bindTaskToSession?.(taskId, rec.sessionId);
        if (rec.messageId) {
          // 认领这张卡：把持久层权威 messageId 补回内存索引。
          // 否则重启后 getSessionCardMessageId() 恒 undefined ⇒ 再发一张卡。
          //
          // ★ Task #5597（两卡并存，#5580）：**只在单卡模式下 adopt**。
          //
          //   `lark_card` 表 task 记录的 messageId 在两卡并存时是
          //   **task 卡**的 id（`buildCardState` 落库带 sessionId）。
          //   若把它灌进 `sessionCardIds`（session 卡索引），后续
          //   session patch（refresh_activity / lifecycle）会命中
          //   task 卡 ⇒ task 卡被改写成 session 卡（用户实测：
          //   「📋 任务卡」过一会儿变成「💬 会话卡」）。
          //
          //   两卡模式下 session 卡索引由 notifier 构造回灌负责
          //   （restoreSessionCardsFromStore ← `lark_session_card` 表，
          //   #5591）；这里 adopt 的是 #5364 单卡语义的遗留行为
          //   （当时 task 卡 == session 卡，adopt 无害），保留给
          //   `emitTaskCard: false` 的软回滚开关。
          if (!this.currentEmitTaskCard()) {
            this.cardNotifier?.adoptSessionCard?.(rec.sessionId, rec.messageId);
          }
        }
      }

      if (!this.restoredTaskIds.has(taskId)) {
        this.restoredTaskIds.add(taskId);
        if (rec.status !== "closed" && rec.messageId) {
          this.cardMessageIds.set(taskId, rec.messageId);
          // ★ xval MAJOR 3：连卡片**内容**（里程碑/过程步骤/更新计数）一起恢复，
          //   否则重启后第一次 patch 会退回"第 1 次更新 + 暂无里程碑"。
          this.hydrateNotifierState(rec);
          logger.debug(
            `restoreCardState: task #${taskId} ← 持久层 message ${rec.messageId} ` +
              `(status=${rec.status}, pinned=${rec.pinned}, timeline=${rec.timeline ? "yes" : "no"})`
          );
        }
      }
      return rec;
    } catch (err) {
      logger.warn(
        `restoreCardState failed for task #${taskId}: ${(err as Error).message}`
      );
      return undefined;
    }
  }

  /**
   * 从持久层恢复卡片内容到 notifier（Task #4536 / xval MAJOR 3）
   *
   * `timeline` 是 `CardStateSnapshot` 的 JSON；解析失败只 warn（不阻断）。
   */
  private hydrateNotifierState(rec: LarkCardState): void {
    if (!this.cardNotifier || !rec.timeline) return;
    try {
      const snapshot = JSON.parse(rec.timeline);
      // hydrateState 内部对"已有 state"是幂等的（不覆盖更新鲜的内存态）
      (this.cardNotifier as any).hydrateState?.(rec.messageId, snapshot);
    } catch (err) {
      logger.warn(
        `hydrateNotifierState failed for task #${rec.taskId}: ${(err as Error).message}`
      );
    }
  }

  /**
   * 把 notifier 的卡片内容快照序列化进记录（Task #4536 / xval MAJOR 3）
   *
   * 每次 patch / pause 之后调用，让"重启后恢复内容"始终有最新数据。
   */
  private snapshotTimeline(state: LarkCardState): LarkCardState {
    if (!this.cardNotifier || !state.messageId) return state;
    try {
      const snap = (this.cardNotifier as any).exportState?.(state.messageId);
      if (!snap) return state;
      return { ...state, timeline: JSON.stringify(snap) };
    } catch (err) {
      logger.warn(
        `snapshotTimeline failed for task #${state.taskId}: ${(err as Error).message}`
      );
      return state;
    }
  }

  /** 落库：发卡成功 / patch 成功后同步记录（失败仅 warn） */
  private persistCardState(state: LarkCardState, includeTimeline = false): void {
    if (!this.cardStateStore) return;
    try {
      const payload = includeTimeline ? this.snapshotTimeline(state) : state;
      this.cardStateStore.upsert(payload);
    } catch (err) {
      // 诉求 C：持久化失败绝不能中断卡片流程
      logger.warn(
        `persistCardState failed for task #${state.taskId}: ${(err as Error).message}`
      );
    }
  }

  /** 落库：pin 状态变化（失败仅 warn） */
  private persistPinned(taskId: number, pinned: boolean): void {
    if (!this.cardStateStore) return;
    try {
      this.cardStateStore.markPinned(taskId, pinned);
    } catch (err) {
      logger.warn(
        `persistPinned failed for task #${taskId}: ${(err as Error).message}`
      );
    }
  }

  /**
   * 落库：暂停（stop）
   *
   * ★ paused **不是**终结 —— 保留 `open` 语义的 messageId，只翻 status。
   *   任务 resume 后要能继续 patch 同一张卡（诉求 B 的 pause→resume→pause）。
   */
  private persistPaused(taskId: number): void {
    if (!this.cardStateStore) return;
    try {
      this.cardStateStore.markPaused(taskId);
    } catch (err) {
      logger.warn(
        `persistPaused failed for task #${taskId}: ${(err as Error).message}`
      );
    }
  }

  /**
   * 丢弃持久层里的旧 messageId（Task #4536 / xval MAJOR 4）
   *
   * 用于 reopen 场景：旧卡片已 closed + unpin，不能再被 patch。
   * 只把 `messageId` 清空、状态保持原样（closed），这样：
   * - 若新卡创建成功 → `persistCardState` 会写一条完整新记录（覆盖）；
   * - 若新卡创建失败 → 记录仍是 closed 且**无可用 messageId**，
   *   重启后 `restoreCardState` 不会把它当活卡片复活。
   */
  private dropStaleMessageId(taskId: number): void {
    if (!this.cardStateStore) return;
    try {
      const existing = this.cardStateStore.get(taskId);
      if (!existing) return;
      this.cardStateStore.upsert({
        ...existing,
        messageId: "",
        pinned: false,
        updatedAt: Date.now(),
      });
    } catch (err) {
      logger.warn(
        `dropStaleMessageId failed for task #${taskId}: ${(err as Error).message}`
      );
    }
  }

  /** 落库：resume / 重新打开（paused|closed → open） */
  private persistReopened(taskId: number): void {
    if (!this.cardStateStore) return;
    try {
      this.cardStateStore.markReopened(taskId);
    } catch (err) {
      logger.warn(
        `persistReopened failed for task #${taskId}: ${(err as Error).message}`
      );
    }
  }

  /** 落库：终结（completed / failed / cancelled）—— 保留记录供追溯 */
  private persistClosed(taskId: number): void {
    if (!this.cardStateStore) return;
    try {
      this.cardStateStore.markClosed(taskId);
    } catch (err) {
      logger.warn(
        `persistClosed failed for task #${taskId}: ${(err as Error).message}`
      );
    }
  }

  /**
   * 重新快照当前卡片的累积内容并落库（Task #4536 / xval MAJOR 3）
   *
   * 幂等 + 失败降级：拿不到记录 / notifier 无状态时静默跳过。
   */
  private refreshTimeline(taskId: number): void {
    if (!this.cardStateStore || !this.cardNotifier) return;
    try {
      const rec = this.cardStateStore.get(taskId);
      if (!rec || !rec.messageId) return;
      this.cardStateStore.upsert(this.snapshotTimeline(rec));
    } catch (err) {
      logger.warn(
        `refreshTimeline failed for task #${taskId}: ${(err as Error).message}`
      );
    }
  }

  /**
   * resume 后重新 pin 卡片（Task #4536）
   *
   * ★ 为什么需要：`stop`（paused）时我们已经 unpin 了；任务被 resume 后如果
   *   不 re-pin，用户就再也看不到置顶的进展卡片 —— pin 状态必须跟任务状态一致。
   *
   * ★ 失败降级（诉求 C）：pin 失败**不阻断**后续 patch，只 warn 并保持
   *   持久层 `pinned=false`（如实反映真实状态，不谎报）。
   */
  private async repinAfterResume(
    task: Task,
    persisted: LarkCardState
  ): Promise<void> {
    if (!this.cardNotifier || typeof this.cardNotifier.pinMessage !== "function") {
      return;
    }
    // ★ xval round2 MINOR 2：空 messageId 绝不能传给 lark-cli
    //   （`dropStaleMessageId` 会把它清成 ""，若此时恰逢 resume 分支就会发出
    //    `im pins create --data '{"message_id":""}'` 这种无效调用）
    if (!persisted.messageId) return;
    // 已经置顶就不用重复 pin（幂等）
    if (persisted.pinned) return;

    const ctx = getEnvContextOrEmpty();
    const profile = this.resolveProfile(task, ctx);

    try {
      await this.cardNotifier.pinMessage(persisted.messageId, profile);
      this.persistPinned(task.id, true);
      logger.debug(
        `repinAfterResume: task #${task.id} 卡片 ${persisted.messageId} 已重新置顶`
      );
    } catch (err) {
      logger.warn(
        `repinAfterResume failed (non-fatal) for task #${task.id}: ${(err as Error).message}`
      );
    }
  }

  /**
   * ★ Task #5182 — reopen 复用原卡（用户明令 2026-11-08 15:56）
   *
   * 场景：lark-cards.db 里该 task 的记录是 `closed`，但任务被重新激活
   * （status → active 等活跃态）。旧实现发一张新卡（同 task 两张卡、
   * 历史时间线留在旧卡上）；新实现：
   *
   *   1. patch 原 messageId：内容 = 当前任务态 + 「🔄 任务重新打开」里程碑
   *   2. 新增一条 reopen 操作记录进卡片时间线（用户可见的 reopen 痕迹）
   *   3. 重新 pin（终态时被 unpin 过；pin 状态必须跟任务状态一致）
   *   4. 持久层 markReopened（closed → open，messageId 不变）
   *
   * @returns true = 原卡复用成功（caller 直接返回，不再走建卡路径）；
   *          false = 原卡 patch 失败（caller 降级走发新卡路径）
   */
  private async reopenReuseCard(
    task: Task,
    persisted: LarkCardState,
    changes: any
  ): Promise<boolean> {
    if (!this.cardNotifier) return false;
    const messageId = persisted.messageId;
    if (!messageId) {
      logger.debug(
        `reopenReuseCard: task #${task.id} 记录无 messageId → 走建卡路径`
      );
      return false;
    }

    const ctx = getEnvContextOrEmpty();
    const profile = this.resolveProfile(task, ctx);

    // ★ Task #5182 follow-up（真网取证 2026-11-08 18:00）：
    //   先解除终态守卫 —— finishTask 已把 messageId 打进
    //   finalisedCards，若不解封，下面的 updateTask 会被守卫
    //   **静默吞掉**（patch 从未发出，卡片停在「已完成」），
    //   而本方法却照常打「已复用原卡」日志 + pin 成功。
    //   reopen 本来就是要"复活"这张卡，守卫对它是错杀。
    this.cardNotifier.unfinaliseCard?.(messageId);

    // 1) 时间线：先并内存态（merge 不发 lark-cli），保证 ledger 完整。
    // ★ 内存态可能不存在（mock notifier / 进程重启后未 hydrate）——
    //   merge 失败时把 reopen 里程碑直接随 patch 增量传给 updateTask，
    //   保证「重新打开」痕迹在任何实现下都上卡。
    const reopenMilestone: Milestone = {
      title: "🔄 任务重新打开",
      timestamp: new Date().toISOString(),
      description: task.current_status || undefined,
    };
    const changeKeys = Object.keys(changes ?? {});
    const reopenSteps: ProcessStep[] =
      changeKeys.length > 0
        ? [
            {
              title: "任务重新打开",
              timestamp: new Date().toISOString(),
              description: changeKeys
                .map((k) => `${k}=${humanizeValue(changes[k], 80)}`)
                .join(" · "),
            },
          ]
        : [];

    // ★ Task #5296 — reopen 前先从持久层恢复卡片内容。
    //
    //   取证（traceId=01a1c77fa3b14b7619c0782d99c00f89，task #5286）：
    //   complete → finishTask patch 成功后 notifier **states.delete**
    //   （内存态清空）；此时 reopen：
    //   - restoreCardState 的 restoredTaskIds 短路（同进程首次
    //     bootstrap 已 add）→ 不会再 hydrate；
    //   - 即使 hydrate，closed 记录也被 `status !== "closed"` 守卫挡住；
    //   - mergeTimelineState 因内存态不存在返回 false
    //     → updateTask 用空默认 state（milestones: []）重建卡片
    //     → **历史时间线全丢**（用户反馈「重新打开把内容干掉了」）。
    //
    //   修复：内存态缺失时，若持久层 rec.timeline 有快照则强制
    //   hydrateNotifierState —— 内存态恢复后 merge 返回 true，
    //   patch 走全量时间线，历史里程碑保留。
    //   （内存态已存在时 hydrateState 幂等不覆盖，无副作用。）
    const hasState =
      (this.cardNotifier as any).exportState?.(messageId) !== undefined;
    if (!hasState) {
      const persistedRec = this.cardStateStore?.get(task.id);
      if (persistedRec?.timeline) {
        this.hydrateNotifierState(persistedRec);
        logger.debug(
          `reopenReuseCard: task #${task.id} 内存态缺失 → ` +
            `从持久层快照恢复卡片内容（历史时间线保留）`
        );
      }
    }

    const merged =
      this.cardNotifier.mergeTimelineState?.(
        messageId,
        [reopenMilestone],
        reopenSteps
      ) ?? false;

    try {
      // 2) patch 原卡（running 态 + 最新任务元信息）
      // ★ merged=false（内存态缺失）→ 增量直接带 reopen 里程碑/步骤
      await this.cardNotifier.updateTask({
        messageId,
        profile,
        status: "running",
        meta: this.buildTaskMeta(task),
        progress:
          typeof task.progress === "number" && task.progress > 0
            ? task.progress
            : undefined,
        milestones: merged ? [] : [reopenMilestone],
        processSteps: merged ? [] : reopenSteps,
      });
    } catch (err) {
      // 原卡 patch 失败（卡片可能被用户手删）→ caller 降级发新卡。
      // 此时内存态已被 merge 过的 reopen 里程碑会随旧卡一起作废，无副作用。
      logger.warn(
        `reopenReuseCard: task #${task.id} 原卡 patch 失败: ` +
          `${(err as Error).message}`
      );
      return false;
    }

    // 3) 持久层翻回 open（messageId 不变）+ 快照时间线
    // ★ DS review MAJOR 2：pin 失败**不得**让异常冒泡 —— 此时持久层
    //   已翻 open（patch 已成功，卡片内容是新的），pin 失败只影响置顶
    //   展示。吞掉异常记 warn，保持「open + 原 messageId」的一致状态。
    this.persistReopened(task.id);
    this.refreshTimeline(task.id);

    // 4) 重新 pin（终态时被 unpin 过；已置顶则幂等跳过）
    try {
      await this.repinAfterResume(task, {
        ...persisted,
        status: "open",
      });
    } catch (pinErr) {
      logger.warn(
        `reopenReuseCard: task #${task.id} 重新 pin 失败（非致命，卡片内容已更新）: ` +
          `${(pinErr as Error).message}`
      );
    }

    logger.info(
      `reopenReuseCard: task #${task.id} 已复用原卡 ${messageId} ` +
        `(patch + reopen 里程碑 + 重新 pin)`
    );
    return true;
  }

  /** 合并「写记录」所需的公共字段（读旧记录失败也不抛，降级为 now） */
  private buildCardState(
    task: Task,
    messageId: string,
    chatId: string,
    profile: string | undefined,
    pinned: boolean
  ): LarkCardState {
    let existing: LarkCardState | undefined;
    try {
      existing = this.cardStateStore?.get(task.id);
    } catch (err) {
      // 诉求 C：读持久层失败不能阻断发卡 —— 用 now 兜底，createdAt 稍后会被覆盖
      logger.warn(
        `buildCardState: read existing failed for task #${task.id}: ${(err as Error).message}`
      );
    }
    const now = Date.now();
    // ★ Task #5364 返工：把 session 归属一起落库 —— 进程重启后
    //   `task:after.update` 仍能知道该 patch 哪张 session 卡（否则退回双卡）。
    const sessionId = this.resolveSessionIdForTask(task.id);
    return {
      taskId: task.id,
      messageId,
      chatId,
      profile,
      pinned,
      status: "open",
      ...(sessionId ? { sessionId } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
  }

  /** 对外只读：某 task 的持久化卡片记录（debug / 排查用） */
  getCardState(taskId: number): LarkCardState | undefined {
    if (!this.cardStateStore) return undefined;
    try {
      return this.cardStateStore.get(taskId);
    } catch {
      return undefined;
    }
  }

  /** 对外只读：全部持久化卡片记录（debug / 排查用） */
  listCardStates(): LarkCardState[] {
    if (!this.cardStateStore) return [];
    try {
      return this.cardStateStore.list();
    } catch {
      return [];
    }
  }

  // ========================================================================
  // ★ 卡片模式 helpers
  // ========================================================================

  private isCardModeEnabled(): boolean {
    if (this.config.cardMode === false || !this.cardNotifier) {
      logger.debug(
        "cardMode=false (legacy opt-out), skip task notification (no text fallback)"
      );
      return false;
    }
    return true;
  }

  /**
   * 解析「卡片该发到哪个群」（Task #4230 follow-up）
   *
   * 规则见 card-chat-routing.ts（Task #4394 简化版）：
   * - **有触发群 → 就用触发群**（无条件，不改投）
   * - 没有触发群 → 用本 task（或祖先）已有的专属群兜底
   * - 都没有 → none（caller skip）
   *
   * 已经不再"自动建群"——建群由用户在卡片上点按钮触发。
   *
   * @returns decision（chatId / profile / source / reason）
   */
  @TracedAs("lark-cli-task-notify.resolveCardTarget", {
    recordParams: true,
    recordResult: true,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      taskId: args[0]?.id,
      triggerChatId: undefined, // 只在结果里输出
    }),
    resultFilter: (r: CardChatDecision | undefined) => ({
      source: r?.source,
      chatId: r?.chatId,
      chatName: r?.chatName,
      reason: r?.reason?.slice(0, 200),
    }),
  })
  private async resolveCardTarget(task: Task): Promise<CardChatDecision> {
    const env = getEnvContextOrEmpty();
    const triggerChatId = env.replyChannel?.chatId;
    const triggerProfile = env.replyChannel?.profile;

    // 1. lineage（自己 + 祖先）：找专属群（仅用于"无触发群"时的兜底）
    const lineage = await this.collectLineage(task);
    const lineageIds = lineage.map((t) => t.id);
    const selfChatId = extractPerTaskChatId(task.context);
    let lineageChat: { chatId: string; profile?: string; isSelf: boolean } | undefined;
    for (const node of lineage) {
      const chatId = extractPerTaskChatId(node.context);
      if (chatId) {
        lineageChat = {
          chatId,
          profile: extractPerTaskChatProfile(node.context),
          isSelf: node.id === task.id,
        };
        break;
      }
    }
    // 自身 context 没有但 task.context 有（collectLineage 已含自身，兜底）
    if (!lineageChat && selfChatId) {
      lineageChat = {
        chatId: selfChatId,
        profile: extractPerTaskChatProfile(task.context),
        isSelf: true,
      };
    }

    // 2. 决策（★ Task #4394：不再做"触发群是不是别人的专属群"判定，也不再自动建群）
    return decideCardChatTarget({
      taskId: task.id,
      lineageIds,
      lineageChat,
      triggerChatId,
      triggerProfile,
    });
  }

  /**
   * 收集 task 的 lineage（自己 → 父 → 祖父…，最多 10 层）
   *
   * 用于：无触发群时找最近的专属群兜底（Task #4394：不再用于"是否别人的群"判定）。
   */
  private async collectLineage(
    task: Task
  ): Promise<Array<{ id: number; context?: string }>> {
    const out: Array<{ id: number; context?: string }> = [
      { id: task.id, context: task.context },
    ];
    let parentId: number | undefined =
      typeof task.parent_task_id === "number" && task.parent_task_id > 0
        ? task.parent_task_id
        : undefined;
    let depth = 0;
    while (parentId && depth < 10 && this.cardRoutingPorts?.getTask) {
      try {
        const parent = await this.cardRoutingPorts.getTask(parentId);
        if (!parent) break;
        out.push({ id: parentId, context: parent.context });
        parentId =
          typeof parent.parent_task_id === "number" && parent.parent_task_id > 0
            ? parent.parent_task_id
            : undefined;
      } catch {
        break;
      }
      depth++;
    }
    return out;
  }

  /** 发初始卡片（+ pin）并缓存 + 持久化 messageId */
  @TracedAs("lark-card.sendStart", {
    recordParams: false,
    paramFilter: (args) => ({ taskId: args[0]?.id, sessionId: args[0]?.sessionId }),
  })
  private async sendCardStart(task: Task): Promise<void> {
    if (!this.cardNotifier) return;

    // ★ Task #4536：先从持久层回填（重启后内存是空的，但卡片已经存在）
    const persisted = this.restoreCardState(task.id);
    // 已终结的卡片不再复用（新 create 语义 = 新卡）
    if (persisted?.status === "closed") {
      this.cardMessageIds.delete(task.id);
    } else if (persisted?.status === "paused") {
      // paused 记录被重新 create/打开 → 标记回 open，复用同一张卡
      this.persistReopened(task.id);
    }

    // ★ Task #4237 修复：首卡幂等 —— 同一 task 只发一次（含"进行中"状态）
    const claim = this.cardMessageIds.get(task.id);
    if (claim) {
      logger.debug(
        `sendCardStart: task #${task.id} 已有首卡（${claim}）→ 跳过重复发卡`
      );
      return;
    }
    // 先占位（in-flight），让同一链路上的重入 update 直接跳过而不是 fallback 补卡
    this.cardMessageIds.set(
      task.id,
      LarkCliTaskNotifyHook.CARD_START_INFLIGHT_SENTINEL
    );

    let target;
    try {
      target = await this.resolveCardTarget(task);
    } catch (err) {
      this.cardMessageIds.delete(task.id);
      throw err;
    }
    const chatId = target.chatId;
    const profile = target.profile;
    if (!chatId) {
      this.cardMessageIds.delete(task.id);
      logger.debug(`sendCardStart: no chatId for task #${task.id}, skip`);
      return;
    }

    try {
      const { messageId, pinned } = await this.cardNotifier.startTask({
        chatId,
        profile,
        meta: this.buildTaskMeta(task),
        milestones: [
          {
            title: "Task 创建",
            timestamp: new Date().toISOString(),
            description: task.current_status || undefined,
          },
        ],
      });
      this.cardMessageIds.set(task.id, messageId);
      // ★ Task #4536：持久化（重启后仍能 patch 同一张卡 + 正确 unpin）
      this.persistCardState(
        this.buildCardState(task, messageId, chatId, profile, pinned),
        true
      );
      logger.debug(
        `sendCardStart: task #${task.id} → message ${messageId} (pinned=${pinned}) ` +
          `chat=${chatId} source=${target.source} reason=${target.reason}`
      );
    } catch (err) {
      this.cardMessageIds.set(
        task.id,
        LarkCliTaskNotifyHook.CARD_START_FAILED_SENTINEL
      );
      logger.error(
        `sendCardStart failed for task #${task.id}: ${(err as Error).message}`
      );
    }
  }

  /**
   * patch 卡片（进度 / 当前步骤 / 状态）
   *
   * 若该 task 还没有卡片（AFTER_CREATE 未成功，例如 replyChannel 缺失），
   * 降级补发一次 startTask —— 只发生一次，失败则打 sentinel 不再重试。
   */
  private async sendCardUpdate(task: Task, changes: any): Promise<void> {
    if (!this.cardNotifier) return;

    // ★ Task #4536：先从持久层回填（重启恢复 / 同进程首次事件）
    const persisted = this.restoreCardState(task.id);
    // 终态记录不再复用（避免复活已 unpin 的卡片）
    //
    // ★ Task #5182 reopen 例外（用户明令 2026-11-08 15:56）：
    //   任务被重新激活（closed 记录 + 当前 status 是活跃态）时，
    //   **复用原卡**（patch 原 messageId + 「🔄 重新打开」里程碑 + 重新 pin），
    //   **不再**发新卡 —— 同一 task 全生命周期只有一张卡。
    //   原卡 patch 失败（如卡片被用户手删）→ 降级走旧路径发新卡（R3）。
    if (persisted?.status === "closed") {
      const stillTerminal = isTerminalTaskStatus(String(task.status));
      if (stillTerminal) {
        logger.debug(
          `sendCardUpdate: task #${task.id} 卡片已终结（closed）且任务仍终态 → skip patch`
        );
        return;
      }
      const reused = await this.reopenReuseCard(task, persisted, changes);
      if (reused) {
        // ★ reopen 复用原卡成功 → 把 messageId 回填内存 Map，
        //   后续 update 直接走普通 patch 路径（restoreCardState 的
        //   一次性短路不会再回填，因为 restoredTaskIds 已含本 task）。
        this.cardMessageIds.set(task.id, persisted.messageId);
        return; // 原卡已 patch + pin + 落库，本次更新完成
      }
      logger.info(
        `sendCardUpdate: task #${task.id} 已 reopen 但原卡 patch 失败 → 降级发新卡`
      );
      // ★ 降级路径沿用 xval MAJOR 4 的不变量：这里**只**清内存里的旧卡，
      //   让下面的 `!messageId` 分支重新建一张卡；
      //   **绝不**在这一步就把持久层翻成 `open` —— 否则新卡一旦创建失败，
      //   记录就变成"open + 旧的 closed messageId"，重启后 restoreCardState
      //   会把已 close/unpin 的旧卡片当活卡片继续 patch。
      //   持久层的翻转交给 startTask 成功后的 persistCardState（写完整新记录）。
      this.cardMessageIds.delete(task.id);
      // 丢弃旧 messageId：让持久层也认为"这张卡不能再用"（保留 status=closed）
      this.dropStaleMessageId(task.id);
    }

    // ★ Task #4536：pause → resume —— 记录翻回 open（保留同一 messageId）
    //   并且重新 pin（stop 时 unpin 过；pin 状态要跟任务状态一致）
    if (persisted?.status === "paused" && String(task.status) !== "paused") {
      this.persistReopened(task.id);
      logger.debug(
        `sendCardUpdate: task #${task.id} resume（paused → open），复用卡片 ${persisted.messageId}`
      );
      await this.repinAfterResume(task, persisted);
    }

    let messageId = this.cardMessageIds.get(task.id);

    // ★ Task #4536：任务已终结/归档且**没有卡片**时不要凭空建卡
    //   （否则 archived / 已 completed 的老任务会因为一条迟到 update
    //     突然冒出一张"进行中"卡片）。
    if (!messageId && isTerminalTaskStatus(String(task.status))) {
      logger.debug(
        `sendCardUpdate: task #${task.id} 状态=${task.status}（终结/归档）且无卡片 → skip`
      );
      return;
    }

    // ★ Task #4536：并发幂等 —— 无卡片时**在任何 await 之前同步占坑**。
    //   否则两个并发 update 都会经过下面 await resolveCardTarget 的异步间隙，
    //   各自看到"没有 messageId"→ 各自发一张卡（同 task 两张卡）。
    if (!messageId) {
      this.cardMessageIds.set(
        task.id,
        LarkCliTaskNotifyHook.CARD_START_INFLIGHT_SENTINEL
      );
    }
    // ★ Task #4230 follow-up：只有需要补发卡片时才做（有成本的）路由解析
    const target = messageId ? undefined : await this.resolveCardTarget(task);
    const chatId =
      target?.chatId ?? this.resolveChatId(task, getEnvContextOrEmpty());
    const profile =
      target?.profile ?? this.resolveProfile(task, getEnvContextOrEmpty());
    if (!chatId) {
      if (!messageId) this.cardMessageIds.delete(task.id);
      logger.debug(`sendCardUpdate: no chatId for task #${task.id}, skip`);
      return;
    }

    // sentinel 命中 → startTask 已失败，不重试
    if (messageId === LarkCliTaskNotifyHook.CARD_START_FAILED_SENTINEL) {
      logger.debug(
        `sendCardUpdate: startTask failed previously for task #${task.id}, skip`
      );
      return;
    }

    // ★ Task #4237 修复：首卡正在发（in-flight）→ 这是建群写 context 引发的重入，
    //   直接跳过：既不 fallback 补卡，也不发改投卡片（改投只属于"首次建卡"语义）
    if (messageId === LarkCliTaskNotifyHook.CARD_START_INFLIGHT_SENTINEL) {
      logger.debug(
        `sendCardUpdate: task #${task.id} 首卡正在发送中（in-flight）→ 跳过本次 update`
      );
      return;
    }

    if (!messageId) {
      // 占位已在函数入口同步完成（见上面的 CARD_START_INFLIGHT_SENTINEL）
      try {
        const res = await this.cardNotifier.startTask({
          chatId,
          profile,
          meta: this.buildTaskMeta(task),
        });
        messageId = res.messageId;
        this.cardMessageIds.set(task.id, messageId);
        // ★ Task #4536：补发成功也落库
        this.persistCardState(
          this.buildCardState(task, messageId, chatId, profile, res.pinned),
          true
        );

        // ★ Task #4237 修复：这里**不再**补发改投链接卡片。
        //   改投是"首次建卡"的语义，只允许 sendCardStart 发一次；
        //   旧实现会在这里再发一张（同 task 两张文案不同的改投卡片）。
      } catch (err) {
        this.cardMessageIds.set(
          task.id,
          LarkCliTaskNotifyHook.CARD_START_FAILED_SENTINEL
        );
        logger.error(
          `sendCardUpdate fallback start failed: ${(err as Error).message}`
        );
        return;
      }
    }

    // 变更项渲染成过程信息的一条（人类可读，绝不输出 JSON 原文）
    const changeKeys = Object.keys(changes ?? {});
    const processSteps: ProcessStep[] =
      changeKeys.length > 0
        ? [
            {
              title: "状态更新",
              timestamp: new Date().toISOString(),
              description: changeKeys
                .map((k) => `${k}=${humanizeValue(changes[k], 80)}`)
                .join(" · "),
            },
          ]
        : [];

    try {
      await this.cardNotifier.updateTask({
        messageId,
        chatId,
        profile,
        // ★ Task #5164 需求 2b：header 第二行状态文案随任务状态实时同步。
        //   to_validate（待验证）是活跃等待态：走普通 patch 但把状态
        //   透传给卡片渲染（header 第二行显示专属短语），其余仍 running。
        status: String(task.status) === "to_validate" ? "to_validate" : "running",
        meta: this.buildTaskMeta(task),
        // ★ 只传真实进度；未知时不传（卡片渲染"进行中"，不编造百分比）
        progress:
          typeof task.progress === "number" && task.progress > 0
            ? task.progress
            : undefined,
        milestones: [],
        processSteps,
      });
      // ★ Task #4536：patch 成功 → 刷新 updatedAt + 重新快照卡片内容（xval MAJOR 3）。
      //   pin 状态取**当前**持久层值：不能直接用函数开头读到的 `persisted.pinned`，
      //   因为 repinAfterResume 可能刚刚把它翻成 true（否则会把 re-pin 结果冲掉）。
      const current = this.getCardState(task.id);
      this.persistPinned(task.id, current?.pinned ?? persisted?.pinned ?? true);
      this.refreshTimeline(task.id);
    } catch (err) {
      logger.error(`sendCardUpdate failed: ${(err as Error).message}`);
    }
  }

  /**
   * 终态：patch final status + unpin，并同步持久化
   *
   * 覆盖三种「收尾」语义（Task #4536）：
   * - `completed`                     → 卡片「🎉 全部完成！」+ unpin + 记录 closed
   * - `cancelled`                     → 卡片「🚫 已取消」  + unpin + 记录 closed
   * - `failed` / `timeout`            → 卡片「🚨 任务失败」+ unpin + 记录 closed
   * - `paused`（用户 stop **或** 循环任务已暂停）→ 卡片「⏹️ 已暂停」+ unpin，
   *   但记录只标 `paused`（**不是** closed）—— 任务 resume 后要复用同一张卡
   */
  private async sendCardFinish(task: Task): Promise<void> {
    if (!this.cardNotifier) return;

    // ★ Task #4536：先从持久层回填（重启后 / 首次事件）
    this.restoreCardState(task.id);

    const messageId = this.cardMessageIds.get(task.id);
    const ctx = getEnvContextOrEmpty();
    const profile = this.resolveProfile(task, ctx);

    if (
      !messageId ||
      messageId === LarkCliTaskNotifyHook.CARD_START_FAILED_SENTINEL
    ) {
      logger.debug(
        `sendCardFinish: no card messageId for task #${task.id}, skip ` +
          `(记录缺失 → 不发新卡，保持幂等)`
      );
      return;
    }

    const rawStatus = String(task.status);
    // ★ Task #4536：cancelled 单独成一个卡片状态（旧实现误标成 "failed"）
    const status = mapTaskStatusToCardStatus(rawStatus);
    // ★ paused / archived 都属于"未终结"（卡片还活着，只是停止更新 + unpin）
    const isPaused = rawStatus === "paused" || rawStatus === "archived";

    try {
      // ★ Task #5020（review round-3 MAJOR）—— 终态/暂停前取消待补发的尾沿 patch。
      // 否则 timer 会在 finishTask 清掉内存 state 之后触发，把已完成的卡片
      // 用空 state 重建成「进行中」并把里程碑序列清空。
      this.cancelTrailingPatch(task.id);

      // ★ xval MAJOR 2 修复：paused / archived 走 `pauseTask`（保留卡片时间线），
      //   只有真终态（completed / cancelled / failed）才走 `finishTask`（清内存态）。
      const finish = isPaused
        ? this.cardNotifier.pauseTask.bind(this.cardNotifier)
        : this.cardNotifier.finishTask.bind(this.cardNotifier);

      await finish({
        messageId,
        profile,
        status,
        meta: this.buildTaskMeta(task),
        finalStep: task.current_status || undefined,
        // ★ xval MINOR-2：archived 是终态（归档后不再有进展）→ 展开时间线；
        //   paused 可 resume → 保持折叠（避免刷屏）。
        expandTimeline: rawStatus === "archived" ? true : undefined,
        // ★ xval round2 NIT 3：归档不是"暂停"，里程碑文案要区分
        ...(rawStatus === "archived"
          ? { pausedMilestoneTitle: "Task 已归档" }
          : {}),
      });

      if (isPaused) {
        // paused 不是终结：保留 messageId（resume 后复用同一张卡），只翻状态
        this.persistPaused(task.id);
        this.persistPinned(task.id, false);
        // ★ xval MAJOR 3：把暂停态的卡片内容也快照下来，resume/重启后不丢历史
        this.refreshTimeline(task.id);
      } else {
        // 真终态：记录标 closed（**不删除**，便于事后追溯），并清内存缓存
        this.persistClosed(task.id);
        this.persistPinned(task.id, false);
        this.cardMessageIds.delete(task.id);
      }

      logger.debug(
        `sendCardFinish: task #${task.id} → status=${status} ` +
          `(raw=${rawStatus}) message=${messageId}`
      );
    } catch (err) {
      logger.error(`sendCardFinish failed: ${(err as Error).message}`);
    }
  }

  // ========================================================================
  // 解析 helpers
  // ========================================================================

  /**
   * 解析 chatId（优先级：replyChannel > task.context）
   *
   * Task #4220: user 触发的群优先 → 用户在**原群**里就能看到卡片与进展；
   * per-task 群只作为 fallback（replyChannel 缺失时）。
   */
  private resolveChatId(task: Task, env: any): string | undefined {
    const envChat = env.replyChannel?.chatId;
    if (envChat) return envChat;
    const ctxStr = task.context;
    if (typeof ctxStr === "string") {
      const ctxChat = parseLarkPerTaskChatId(ctxStr);
      if (ctxChat) return ctxChat;
    }
    return undefined;
  }

  /** 解析 profile（优先级：replyChannel > task.context） */
  private resolveProfile(task: Task, env: any): string | undefined {
    const envProfile = env.replyChannel?.profile;
    if (envProfile) return envProfile;
    const ctxStr = task.context;
    if (typeof ctxStr === "string") {
      const ctxProfile = parseLarkPerTaskChatProfile(ctxStr);
      if (ctxProfile) return ctxProfile;
    }
    return undefined;
  }

  /**
   * task → 卡片"任务栏位"元信息（id/标题/描述/目标/父任务/优先级/context…）
   *
   * context 原样透传（JSON 字符串）；渲染成可读 bullet 的活由
   * LarkCardPatchNotifier.renderContextAsLines 负责（卡片里绝不出现 JSON）。
   */
  private buildTaskMeta(task: Task): TaskMeta {
    // ★ Task #4331 + opencode-cli review M1：群名匹配应是 task id 而非 chat id
    //   群名格式："Task #4331 - 标题"，跟 task.id 关联，不是 chat_id
    //   review Minor 2：用 (?<!\d) / (?!\d) 数字边界更精确，防止 "t#4331 z"
    //   误匹配到 taskId=4331 但实际应匹配 43310
    const sessionId = this.resolveSessionIdForTask(task.id);
    const recordedNames = extractRecordedChatNames(task.context);
    const matchedName = recordedNames.find((n) =>
      new RegExp(
        `(?:Task\\s*#?\\s*|#)(?<![\\d])(?<!\\d)${task.id}(?!\\d)(?![\\d])`,
        "i"
      ).test(n)
    );
    return {
      id: task.id,
      title: task.title,
      description: task.description,
      goals: task.goals_and_expected_deliverables,
      parentTaskId:
        typeof task.parent_task_id === "number" && task.parent_task_id > 0
          ? task.parent_task_id
          : undefined,
      priority: task.priority,
      type: task.type,
      projectPath: task.project_path,
      context: task.context,
      currentStatus: task.current_status,
      perTaskChatId: extractPerTaskChatId(task.context),
      perTaskChatName: matchedName,
      // ★ Task #5364 返工（BLOCKER-3）：把 sessionId 也写进 meta。
      //
      // 上一版这里**没有** sessionId ⇒ 发出去的 task 卡「🔄 刷新活性」按钮
      // value 只有 taskId ⇒ 点击报 `No card subject: sessionId is required`
      // （真机实测 om_x100b60647b77d0a4b09d1641140c272 的按钮就是这个形状）。
      //
      // 来源优先级：notifier 反向索引（本 session 卡已发过）> 持久层记录。
      ...(sessionId ? { sessionId } : {}),
    };
  }

  /**
   * ★ Task #5364 返工：解析该 task 所属的 sub-session id。
   *
   * 顺序（都不猜）：
   * 1. notifier 反向索引（本进程发过卡 / 事件里绑定过）
   * 2. 持久层 `lark_card.session_id`（重启后仍有效）
   * 3. EnvContext 的 replyChannel / envEvent（sub-agent 运行时带）
   */
  private resolveSessionIdForTask(taskId: number): string | undefined {
    const fromIndex = this.cardNotifier?.getSessionIdByTask?.(taskId);
    if (fromIndex) return fromIndex;
    try {
      const rec = this.cardStateStore?.get(taskId);
      if (rec?.sessionId) return rec.sessionId;
    } catch {
      /* 持久层不可用 → 继续 */
    }
    const ctx = getEnvContextOrEmpty() as unknown as {
      sessionId?: string;
      replyChannel?: { sessionId?: string };
    };
    const fromCtx = ctx?.sessionId ?? ctx?.replyChannel?.sessionId;
    return typeof fromCtx === "string" && fromCtx ? fromCtx : undefined;
  }

  /**
   * ★ Task #5364 返工（BLOCKER-5/6）：把 task 事件渲染进**已有的 session 卡**。
   *
   * ## 用户定稿（2026-11-12 08:13 / 08:15）
   *
   * - 「一个 session 只有一张卡」
   * - 「有 task → task 信息渲染在这张 session 卡上」（合并，不是并列）
   * - 飞书：**任务状态更新自动同步**（自动 patch 同一张卡）
   *
   * ## 实现
   *
   * 已有该 session 的卡 → `updateSessionCard`（patch 同一 messageId，带 task 区块）
   * ；没有 → 返回 false，调用方退回落旧的 task 卡路径（首次由 session 生命周期
   * 事件发卡；task 先到就先由这里发「session 卡 + task 区块」）。
   */
  @TracedAs("lark-card.patchForTask", {
    recordParams: true,
    flattenParamFilter: true,
    paramFilter: (args) => ({
      taskId: args[0]?.id,
      sessionId: args[0]?.sessionId,
      lifecycle: args[1]?.lifecycle,
      statusPhrase: args[1]?.statusPhrase,
    }),
  })
  private async patchSessionCardForTask(
    task: Task,
    opts: {
      lifecycle: "running" | "completed" | "timeout" | "failed" | "stopped";
      milestones?: Milestone[];
      sessionId: string;
      statusPhrase?: string;
    },
  ): Promise<boolean> {
    if (!this.cardNotifier) return false;
    const meta = this.buildTaskMeta(task);
    const sessionId = opts.sessionId;

    const chatId = meta.perTaskChatId ?? this.resolveChatId(task, getEnvContextOrEmpty());
    if (!chatId) return false;
    const profile = this.resolveProfile(task, getEnvContextOrEmpty());
    const agentType = this.resolveAgentType();

    // ★ CV R3 M1 修复：**统一走 `upsertSessionCard`**（内部有 per-session 锁）。
    //
    // 原实现自己「查无卡 → startSessionCard / 有卡 → updateSessionCard」，
    // 与 wiring 的 `upsertSessionCard` 共享同一个「查无卡→发卡」临界区，
    // 但只有后者上了锁 ⇒ task 事件与 session 生命周期事件并发时**各发一张卡**
    // （reviewer M1，属实；正是本轮 headline 需求的反例）。
    //
    // upsertSessionCard 的语义就是「有则 patch、无则 start」，且冷启动判断在锁内，
    // 所以这里既修了竞态，也顺手删掉了重复的分支逻辑。
    const res = await this.cardNotifier.upsertSessionCard({
      chatId,
      ...(profile ? { profile } : {}),
      sessionId,
      ...(task.title ? { title: task.title } : {}),
      ...(opts.statusPhrase ? { statusPhrase: opts.statusPhrase } : {}),
      ...(agentType ? { agentType } : {}),
      startedAt: task.createdAt ? String(task.createdAt) : new Date().toISOString(),
      ...(opts.milestones ? { milestones: opts.milestones } : {}),
      lifecycle: opts.lifecycle,
      task: this.buildSessionCardTask(task, meta),
      ...(meta.perTaskChatId ? { perTaskChatId: meta.perTaskChatId } : {}),
      ...(meta.perTaskChatName ? { perTaskChatName: meta.perTaskChatName } : {}),
    });
    this.recordSessionCardForTask(
      task,
      sessionId,
      chatId,
      profile,
      res.messageId,
    );

    // ★ Task #5417：**双写** —— task 进展同步到关联群 session 的卡。
    //   方案 A：新群有自己的卡（sessionId=chatId）。原 session 卡
    //   patch 成功后，把同一条进展再 upsert 到群卡（无群 ⇒ no-op）。
    //   best-effort：syncGroupCardFromOrigin 内部吞错。
    if (this.syncGroupCardFromOriginFn) {
      await this.cardNotifier.syncGroupCardFromOrigin(
        sessionId,
        {
          lifecycle: opts.lifecycle,
          ...(task.title ? { title: task.title } : {}),
          ...(opts.milestones ? { milestones: opts.milestones } : {}),
        },
        this.syncGroupCardFromOriginFn,
      );
    }
    return true;
  }

  /**
   * ★ Task #5417：群 session 反查端口（由 ES 装配点注入）。
   * 未注入 ⇒ task 侧双写退化为 no-op（不影响原卡链路）。
   */
  syncGroupCardFromOriginFn?: (
    sid: string,
  ) => Promise<{ chatId: string; aliasSessionId?: string } | undefined>;

  /**
   * ★ Task #5364 返工（BLOCKER-4 重启分支）：把「task 的卡 = 那张 session 卡」
   * 写进持久层。
   *
   * 重启后 `restoreCardState` 读到 `{messageId: <session 卡>, sessionId}` ⇒
   * `adoptSessionCard` 恢复内存索引 ⇒ 后续 patch 命中同一张卡（不再多发）。
   */
  private recordSessionCardForTask(
    task: Task,
    sessionId: string,
    chatId?: string,
    profile?: string,
    /** ★ CV R3 M1：由调用方（upsert 的返回值）传入，避免再查一次产生竞态窗口 */
    messageIdIn?: string,
  ): void {
    // ★ Task #5390（CV MINOR-1）：**内存索引必须先绑**，不能放在
    //   `cardStateStore` / `messageId` 的 early-return 之后。
    //
    //   否则持久层不可用（或 messageId 一时取不到）时，`bindTaskToSession`
    //   被静默跳过 ⇒ 本进程后续的 update / complete 事件走
    //   `resolveSessionIdForTask` 反查必然落空 ⇒ 又漂回纯 task 卡
    //   （正是用户抱怨「任务信息没同步到 session 卡」的复发路径）。
    //   内存索引与持久层是两件事：前者服务当前进程，后者服务重启恢复。
    this.cardNotifier?.bindTaskToSession?.(task.id, sessionId);

    // ★ Task #5580（两卡并存）：`cardMessageIds` 是**任务卡片**的 messageId 索引。
    //
    // 单卡语义（#5364）下 session 卡的 id 也写进这里（因为没有别处的卡）。
    // 但现在两卡并存 —— 若继续用 session 卡 id 覆盖，`sendCardStart` 会看到
    // "已有卡" 而**跳过发任务卡片**（需求二直接失效），且后续 task 终态的
    // patch/unpin 会打在 session 卡上（把会话卡改成任务终态）。
    //
    // 所以两卡模式只做内存绑定（bindTaskToSession 上面已做），
    // 任务卡片的索引/持久化交给 startTask 路径自己维护。
    if (this.currentEmitTaskCard()) return;

    if (!this.cardStateStore) return;
    const messageId =
      messageIdIn ?? this.cardNotifier?.getSessionCardMessageId?.(sessionId);
    if (!messageId) return;
    this.cardMessageIds.set(task.id, messageId);
    try {
      const existing = this.cardStateStore.get(task.id);
      const now = Date.now();
      this.cardStateStore.upsert({
        taskId: task.id,
        messageId,
        chatId: chatId ?? existing?.chatId ?? "",
        ...(profile ?? existing?.profile ? { profile: profile ?? existing?.profile } : {}),
        pinned: existing?.pinned ?? true,
        status: existing?.status ?? "open",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        sessionId,
        ...(existing?.timeline ? { timeline: existing.timeline } : {}),
      });
    } catch (err) {
      logger.warn(
        `recordSessionCardForTask failed for task #${task.id}: ${(err as Error).message}`,
      );
    }
  }

  /** sub-agent 类型（有则显示「执行 Agent」行） */
  private resolveAgentType(): string | undefined {
    const ctx = getEnvContextOrEmpty() as unknown as { subagentType?: string };
    return typeof ctx?.subagentType === "string" && ctx.subagentType
      ? ctx.subagentType
      : undefined;
  }

  /** TaskMeta → buildSessionCard 的 task 区块载荷 */
  private buildSessionCardTask(task: Task, meta: TaskMeta): SessionCardTaskPayload {
    return {
      id: task.id,
      ...(task.title ? { title: task.title } : {}),
      ...(task.status ? { status: String(task.status) } : {}),
      ...(typeof task.progress === "number" ? { progress: task.progress } : {}),
      ...(task.current_status ? { currentStatus: task.current_status } : {}),
      ...(meta.priority ? { priority: meta.priority } : {}),
      ...(typeof meta.parentTaskId === "number"
        ? { parentTaskId: meta.parentTaskId }
        : {}),
      ...(meta.goals ? { goals: meta.goals } : {}),
      ...(task.createdAt ? { createdAt: String(task.createdAt) } : {}),
      ...(task.updatedAt ? { updatedAt: String(task.updatedAt) } : {}),
    };
  }

  /**
   * operation → 卡片时间线条目（里程碑 + 过程步骤 + 当前步骤）
   *
   * 兼容旧字段名（actionTitle/actionDescription）以及只带 description/type 的
   * 历史 payload —— 不要因为字段名差异就静默丢掉事件。
   */
  private deriveTimelineFromOperation(operation: TaskOperation): {
    milestones: Milestone[];
    processSteps: ProcessStep[];
    currentStep?: string;
  } {
    const raw = operation as TaskOperation & {
      description?: string;
      type?: string;
      action_title?: string;
      action_description?: string;
    };

    const title =
      operation.milestoneTitle ??
      operation.actionTitle ??
      raw.action_title ??
      raw.description ??
      raw.type ??
      undefined;
    const detail =
      operation.milestoneDescription ??
      operation.actionDescription ??
      raw.action_description ??
      undefined;
    const timestamp = operation.timestamp ?? new Date().toISOString();

    const milestones: Milestone[] = [];
    const processSteps: ProcessStep[] = [];

    if (operation.milestoneTitle || operation.milestoneType || title) {
      milestones.push({
        title: title ?? String(operation.milestoneType ?? "里程碑"),
        timestamp,
        description: detail,
      });
    }

    if (operation.processDescription || detail) {
      processSteps.push({
        title: title ?? "过程",
        timestamp,
        description: operation.processDescription ?? detail,
      });
    }

    const currentStep =
      operation.processDescription ?? detail ?? title ?? undefined;

    return { milestones, processSteps, currentStep };
  }

  // ========================================================================
  // 节流 / 开关
  // ========================================================================

  /**
   * 操作记录 patch 节流
   *
   * 同一 Task 在 operationThrottleMs（默认 5s）窗口内只 patch 一次，
   * 避免 agent 每次 tool call 都刷屏 patch 卡片。
   *
   * ★ Task #5020 —— 返回 true **不代表丢弃**：被节流的 operation 仍会
   *   并进 notifier 的内存态（`mergeTimelineState`）并落进共享 ledger，
   *   只是**不立刻 patch 飞书**。节流只限制**频率**，不丢**数据**。
   */
  private shouldThrottleOperation(operation: TaskOperation): boolean {
    const throttleMs = this.config.operationThrottleMs ?? 5000;
    if (throttleMs <= 0) return false;

    const key = `op:${operation.taskId}`;
    const now = Date.now();
    const lastTime = this.lastNotifyTimestamps.get(key);
    if (lastTime && now - lastTime < throttleMs) {
      logger.debug(
        `[throttle] skip OPERATION_CREATED patch for task #${operation.taskId} (${now - lastTime}ms ago)`
      );
      return true;
    }
    this.lastNotifyTimestamps.set(key, now);
    return false;
  }

  /** 检查是否应该发送通知 */
  private shouldNotify(type: NotifyType): boolean {
    const { notifyTypes } = this.config;
    // 空数组表示通知所有类型
    if (notifyTypes && notifyTypes.length === 0) return true;
    if (notifyTypes) return notifyTypes.includes(type);
    return type === NotifyType.TASK_COMPLETED;
  }
}

// ========================================================================
// 工厂函数（兼容旧 API）
// ========================================================================

export function createLarkCliTaskNotifyHook(
  config: TaskNotifyConfig = {}
): LarkCliTaskNotifyHook {
  return new LarkCliTaskNotifyHook(config);
}
