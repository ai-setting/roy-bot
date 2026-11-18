/**
 * @fileoverview WecomTaskNotifyHook — 企微任务进展通知 Hook（Task #5193）
 *
 * 在任务生命周期事件上，把「任务进展」渲染成 **markdown 消息**
 * 发到企微（对齐 LarkCliTaskNotifyHook 的 hook 结构）：
 *
 * - `task:after.create`          → 发初始卡片
 * - `task:after.update`          → 发更新卡片（进度/状态/变更摘要）
 * - `task:after.complete`        → 发终态卡片（仅真验收完成）
 * - `task:after.delete`          → 发取消收尾
 * - `task:operation:after.create` → 时间线追加（节流）
 *
 * ## 与 lark-cli 插件的关键差异
 *
 * | 维度 | lark-cli | wecom-cli |
 * |------|----------|-----------|
 * | 卡片形态 | interactive card（可 patch 同一张） | **markdown 消息（每次新发）** |
 * | 更新方式 | PATCH 原卡片 | 每次更新发一条新 markdown |
 * | pin/unpin | 支持 | **无**（恒 false） |
 * | messageId 跟踪 | 必须（patch 键） | 不需要 |
 *
 * ⇒ 企微侧防刷屏靠**节流**（operationThrottleMs 默认 5s）；
 *   时间线**必须持久化**（wecom-cards.db）—— 每条新消息都要
 *   渲染完整历史，重启后也不能丢。
 *
 * ## chat_id 语义（实测硬约束，Task #5174）
 *
 * - replyChannel.chatId：单聊 = 对方 userid，群聊 = chatid
 * - CLI 需要真实 userid（`wotnB7Wg...` 形态）→ 出站统一走
 *   `sendWecomReply`（内部 `resolveWecomCliChatId` 解析 + 缓存）
 *
 * @example
 * ```typescript
 * import { createWecomTaskNotifyHook } from "./wecom-task-notify-plugin";
 * globalHookManager.register("task:after.create", createWecomTaskNotifyHook({...}));
 * ```
 */

import type { Hook, HookContext } from "../../hook/types";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type {
  TaskCreateResultContext,
  TaskUpdateResultContext,
  TaskOperationCreateResultContext,
  TaskDeleteResultContext,
} from "../hooks/contexts";
import type { TaskOperation, Task } from "../types";
import { createLogger } from "../../log-trace/logger";
import { getEnvContextOrEmpty } from "../../context/env-context";
import {
  sendWecomReply,
  sendWecomTemplateCard,
  type WecomSendResult,
} from "../../event-source/wecom-respond-registry";
import {
  buildWecomTextNoticeCard,
  buildWecomButtonInteractionCard,
  WecomCardActionKey,
} from "../../event-source/wecom-card-builder";
import {
  createWecomCardStateStore,
  MemoryWecomCardStateStore,
  getDefaultWecomCardDbPath,
  type WecomCardState,
  type WecomCardStateStore,
} from "./wecom-card-state-store";

const logger = createLogger("wecom:task-notify");

// ========================================================================
// 类型定义
// ========================================================================

/** 通知类型（对齐 NotifyType） */
export const WecomNotifyType = {
  TASK_CREATED: "task_created",
  TASK_UPDATED: "task_updated",
  TASK_COMPLETED: "task_completed",
  OPERATION_CREATED: "operation_created",
} as const;

export type WecomNotifyType =
  (typeof WecomNotifyType)[keyof typeof WecomNotifyType];

/** 时间线里程碑（渲染用，与 LarkCardPatchNotifier.Milestone 形态对齐） */
export interface WecomMilestone {
  title: string;
  timestamp: string;
  description?: string;
}

/** 插件配置 */
export interface WecomTaskNotifyConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 优先级 */
  priority?: number;
  /** 插件名称（用于 pluginEnabled 检查） */
  pluginName?: string;
  /** 事件源 ID（用于 pluginEnabled 检查） */
  sourceId?: string;
  /**
   * 操作记录通知节流间隔（毫秒）
   *
   * 企微每次更新都是**新消息**，不加节流会刷屏。默认 5000ms；
   * 设为 0 表示不节流。
   */
  operationThrottleMs?: number;
  /**
   * 时间线最多保留的里程碑条数（防消息无限膨胀）
   *
   * 企微 markdown 消息有长度上限，时间线太长会被截断。
   * 默认 20 条，超出时丢最旧的（最新进展最重要）。
   */
  maxTimelineEntries?: number;
  /** 通知类型过滤（空数组 = 全开） */
  notifyTypes?: WecomNotifyType[];
  /**
   * ★ Task #5360（补充需求）：ES 配置的 `statusNotifications` 透传。
   *
   * - `false` / 缺省（默认）：只发卡片（#5255 单卡语义）
   * - `true`：发卡成功后**额外**再发一条 markdown 状态文本
   *
   * 为什么由工厂注入而不是插件自己读 `event-sources.json`：
   * 插件不持有 ES 配置句柄，且同一进程可能有多个 wecom 源 ——
   * 由 `es-plugins` 工厂把**该源自己的**配置值传进来，语义最准确。
   */
  statusNotifications?: boolean;
  /**
   * 出站 sender（测试注入；不传用 sendWecomReply）
   */
  sender?: {
    send(input: { chatId: string; content: string }): Promise<WecomSendResult>;
  };
  /**
   * 卡片记录持久化 store
   *
   * 不传 → 自动创建（`~/.local/share/roy-bot/wecom-cards.db`）；
   * 测试可注入 MemoryWecomCardStateStore。
   */
  cardStateStore?: WecomCardStateStore;
}

// ========================================================================
// 事件源判定
// ========================================================================

/** 企微事件类型常量（与 wecom-respond-registry 同源） */
const WECOM_EVENT_TYPE = "event-source.event.wecom-cli";
/** 企微 replyChannel type */
const WECOM_CHANNEL_TYPE = "wecom-cli";

/**
 * 从 EnvContext 判定是否企微事件，并提取 chatId。
 *
 * 判定优先级：
 * 1. `envEvent.type === "event-source.event.wecom-cli"`（生产主路径）
 * 2. `replyChannel.type === "wecom-cli"`（兜底：事件类型缺失但通道明确）
 *
 * 两者都不满足（lark / cli-command / timer…）→ isWecom=false，插件跳过。
 */
export function extractWecomFields(
  env: {
    envEvent?: unknown;
    replyChannel?: { type?: string; chatId?: string };
  },
  fallbackSourceId?: string,
): { isWecom: boolean; chatId?: string; sourceId?: string } {
  const evt = env.envEvent as
    | { type?: string; metadata?: Record<string, unknown> }
    | undefined;
  const rcType = env.replyChannel?.type;

  const isWecom =
    evt?.type === WECOM_EVENT_TYPE || rcType === WECOM_CHANNEL_TYPE;
  if (!isWecom) return { isWecom: false };

  const chatId =
    env.replyChannel?.chatId ||
    (typeof evt?.metadata?.chatId === "string"
      ? (evt.metadata.chatId as string)
      : undefined);

  // ★ Task #5260：事件 metadata 无 sourceId（后台任务链路常见）→
  //   回落插件自身配置的 sourceId（= 注册 WS 实例的同一 key）。
  const sourceId =
    (typeof evt?.metadata?.sourceId === "string"
      ? (evt.metadata.sourceId as string)
      : undefined) ?? fallbackSourceId ?? undefined;

  return { isWecom: true, chatId, sourceId };
}

// ========================================================================
// 状态映射
// ========================================================================

/** task.status → 状态标签（含 emoji） */
function statusLabelOf(task: Task, terminalStatus?: string): string {
  const s = String(terminalStatus ?? task.status ?? "");
  switch (s) {
    case "todo":
      return "📝 待办";
    case "active":
      return "🔄 进行中";
    case "to_validate":
      return "🔍 待验证";
    case "completed":
      return "🎉 已完成";
    case "paused":
      return "⏸️ 已暂停";
    case "cancelled":
      return "🚫 已取消";
    case "archived":
      return "📦 已归档";
    case "failed":
    case "timeout":
      return "🚨 已失败";
    default:
      return "🔄 进行中";
  }
}

/**
 * 本次 update 是否属于「收尾」事件
 *
 * 与 LarkCliTaskNotifyHook.cardStatusOf 同语义：
 * - completed / cancelled / failed / timeout / archived / paused → 收尾
 * - to_validate **不是**终态（两阶段验收的自查关，Task #5073）
 * - progress=100 不当完成（判定只看 status）
 */
function isTerminalUpdate(
  task: Task,
  changes?: { status?: string }
): boolean {
  const effective = String(changes?.status ?? task.status ?? "");
  return (
    effective === "completed" ||
    effective === "cancelled" ||
    effective === "failed" ||
    effective === "timeout" ||
    effective === "archived" ||
    effective === "paused"
  );
}

/** 是否真终态（paused 可 resume，不算） */
function isHardTerminal(status: string): boolean {
  return (
    status === "completed" ||
    status === "cancelled" ||
    status === "failed" ||
    status === "timeout" ||
    status === "archived"
  );
}

// ========================================================================
// 卡片渲染（markdown）
// ========================================================================

/** 截断长文本（防消息超限） */
function clip(text: string | undefined, max = 200): string {
  if (!text) return "";
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 渲染企微进展卡片（markdown）
 *
 * 结构（对齐 lark 卡片的信息密度，压缩成 markdown）：
 * ```
 * ### 📋 Task #42 · 时空增强任务
 * **状态**：🔄 进行中（80%）
 * > 任务描述第一行…
 *
 * **时间线**
 * - 🕐 2026-06-01 00:00 — Task 创建
 * - 🕐 2026-06-01 02:00 — 完成需求分析：已完成核心功能的需求拆解
 * ```
 */
export function buildWecomTaskCard(input: {
  task: Task;
  statusLabel: string;
  milestones: WecomMilestone[];
  /** 变更摘要（update 时） */
  changeSummary?: string;
  /** 是否终态（终态加收尾分隔线） */
  terminal?: boolean;
}): string {
  const { task, statusLabel, milestones } = input;
  const lines: string[] = [];

  // 标题行
  lines.push(`### 📋 Task #${task.id} · ${task.title}`);
  lines.push("");

  // 状态行（含进度）
  const progress =
    typeof task.progress === "number" && task.progress > 0
      ? `（${task.progress}%）`
      : "";
  lines.push(`**状态**：${statusLabel}${progress}`);
  if (input.terminal) {
    lines.push(`---`);
  }
  lines.push("");

  // 描述（首行）
  const desc = clip(task.description, 120);
  if (desc) {
    lines.push(`> ${desc}`);
    lines.push("");
  }

  // 变更摘要
  if (input.changeSummary) {
    lines.push(`**本次更新**：${clip(input.changeSummary, 120)}`);
    lines.push("");
  }

  // 时间线
  if (milestones.length > 0) {
    lines.push(`**时间线**`);
    for (const m of milestones) {
      const ts = formatTs(m.timestamp);
      const d = m.description ? `：${clip(m.description, 100)}` : "";
      lines.push(`- 🕐 ${ts} — ${m.title}${d}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

/** ISO 时间 → 本地可读（YYYY-MM-DD HH:mm） */
function formatTs(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch {
    return iso;
  }
}

/** 从 operation 提取里程碑（对齐 deriveTimelineFromOperation） */
function milestoneFromOperation(op: TaskOperation): WecomMilestone {
  const raw = op as TaskOperation & {
    action_title?: string;
    action_description?: string;
  };
  const title =
    op.milestoneTitle ?? raw.action_title ?? String(op.milestoneType ?? "里程碑");
  const detail =
    op.milestoneDescription ?? raw.action_description ?? undefined;
  return {
    title,
    timestamp: op.timestamp ?? new Date().toISOString(),
    description: detail ?? op.processDescription ?? undefined,
  };
}

// ========================================================================
// Hook 实现
// ========================================================================

export class WecomTaskNotifyHook implements Hook {
  readonly name: string;
  readonly priority: number;
  readonly description?: string;
  readonly pluginName?: string;
  readonly sourceId?: string;

  private readonly config: WecomTaskNotifyConfig;

  /** 出站 sender（默认 sendWecomReply，测试可注入） */
  private readonly sender: NonNullable<WecomTaskNotifyConfig["sender"]>;

  /** 持久化 store（taskId → chatId/status/timeline） */
  private readonly cardStateStore: WecomCardStateStore;

  /**
   * ★ Task #5360（补充需求）：状态通知文本开关（严格 `=== true`）。
   *
   * 构造时快照一次（配置热更新靠重建插件实例，与 `enabled` / `priority` 一致），
   * 避免每次 deliver 都读 config 对象。
   */
  private readonly esStatusNotifications: boolean;

  /** 操作记录节流状态：key `op:${taskId}` → 上次发送时间戳 */
  private lastNotifyTimestamps: Map<string, number> = new Map();

  constructor(config: WecomTaskNotifyConfig = {}) {
    this.name = config.pluginName || "WecomTaskNotifyHook";
    this.priority = config.priority ?? 5;
    this.description = "Wecom 任务进展通知 Hook（markdown 卡片）";
    this.pluginName = config.pluginName;
    this.sourceId = config.sourceId;
    this.config = {
      enabled: true,
      priority: 5,
      notifyTypes: [
        WecomNotifyType.TASK_CREATED,
        WecomNotifyType.TASK_UPDATED,
        WecomNotifyType.TASK_COMPLETED,
        WecomNotifyType.OPERATION_CREATED,
      ],
      ...config,
    };
    // ★ Task #5360：严格 === true（"true"/1/null 一律 false，防手改 JSON 类型漂移）
    this.esStatusNotifications = config.statusNotifications === true;
    this.sender = config.sender ?? {
      send: (input) => this.defaultSend(input),
    };
    this.cardStateStore =
      config.cardStateStore ?? createWecomCardStateStore();
  }

  /**
   * 默认出站：sendWecomReply（CLI 主路径 → WS fallback）
   *
   * sourceId 从事件 metadata 取（sendWecomReply 只在 WS fallback 时用）。
   */
  private async defaultSend(input: {
    chatId: string;
    content: string;
  }): Promise<WecomSendResult> {
    const env = getEnvContextOrEmpty();
    // ★ Task #5260：回落插件配置 sourceId（后台任务链路 envEvent 可能缺 sourceId）
    const { sourceId } = extractWecomFields(env as any, this.sourceId);
    return sendWecomReply({
      sourceId: sourceId ?? "unknown",
      rawChatId: input.chatId,
      content: input.content,
    });
  }

  @TracedExecute
  async execute(ctx: HookContext<unknown>): Promise<void> {
    if (!this.config.enabled) return;

    // pluginEnabled 守卫（与 lark 插件同款：key = sourceId:pluginName）
    const env = getEnvContextOrEmpty();
    if (this.pluginName && this.sourceId) {
      const key = `${this.sourceId}:${this.pluginName}`;
      if (env.pluginEnabled && env.pluginEnabled[key] !== true) {
        logger.debug(`Plugin not enabled for source: ${key}`);
        return;
      }
    }

    // 事件源判定：非企微事件一律跳过
    // ★ Task #5260：带插件配置 sourceId 兜底（后台链路 envEvent 可能缺）
    const fields = extractWecomFields(env as any, this.sourceId);
    if (!fields.isWecom) {
      logger.debug("not a wecom event, skip");
      return;
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
      case TaskHookPoints.AFTER_DELETE:
        await this.onAfterDelete(ctx as HookContext<TaskDeleteResultContext>);
        break;
    }
  }

  // ========================================================================
  // Hook handlers
  // ========================================================================

  /** 任务创建：发初始卡片 */
  private async onAfterCreate(
    ctx: HookContext<TaskCreateResultContext>
  ): Promise<void> {
    const { task } = ctx.data as TaskCreateResultContext;
    if (!task || !this.shouldNotify(WecomNotifyType.TASK_CREATED)) return;

    await this.sendCardStart(task);
  }

  /** 任务更新：发更新卡片 */
  private async onAfterUpdate(
    ctx: HookContext<TaskUpdateResultContext>
  ): Promise<void> {
    const data = ctx.data as TaskUpdateResultContext;
    if (!data?.task) return;
    const { task, changes } = data;

    const changeKeys = Object.keys(changes ?? {});
    // 无变更不通知（与 lark 插件一致）
    if (changeKeys.length === 0) return;

    if (isTerminalUpdate(task, changes)) {
      if (!this.shouldNotify(WecomNotifyType.TASK_COMPLETED)) return;
      await this.sendCardFinish(task, String(changes?.status ?? task.status));
      return;
    }

    if (!this.shouldNotify(WecomNotifyType.TASK_UPDATED)) return;
    await this.sendCardUpdate(task, changes);
  }

  /** 任务终态（task_complete）：仅真验收完成（to_validate 是自查关） */
  private async onAfterComplete(ctx: HookContext<unknown>): Promise<void> {
    const data = ctx.data as
      | { task?: Task; terminalStatus?: string }
      | Task;
    const task = (data as { task?: Task })?.task ?? (data as Task);
    if (!task || !this.shouldNotify(WecomNotifyType.TASK_COMPLETED)) return;

    // ★ Task #5073 对齐：to_validate 不是「验收完成」
    const terminalStatus = (data as { terminalStatus?: string }).terminalStatus;
    if (terminalStatus === "to_validate" || task.status === "to_validate") {
      return;
    }

    await this.sendCardFinish(task, String(task.status));
  }

  /** 任务删除（硬删除）：收尾 */
  private async onAfterDelete(
    ctx: HookContext<TaskDeleteResultContext>
  ): Promise<void> {
    const data = ctx.data as TaskDeleteResultContext;
    const taskId = data?.id;
    if (data?.deleted !== true || typeof taskId !== "number") return;
    if (!this.shouldNotify(WecomNotifyType.TASK_COMPLETED)) return;

    const rec = this.getRecord(taskId);
    if (!rec) {
      // 从来没发过卡 → 幂等 skip，绝不发新卡
      logger.debug(`onAfterDelete: task #${taskId} 无卡片记录，skip`);
      return;
    }

    const milestones = this.parseTimeline(rec.timeline);
    milestones.push({
      title: "任务已取消（删除）",
      timestamp: new Date().toISOString(),
    });

    await this.deliver({
      chatId: rec.chatId,
      task: {
        id: taskId,
        title: `(已删除)`,
        description: "",
        status: "cancelled",
        progress: 0,
      } as Task,
      statusLabel: statusLabelOf({ status: "cancelled" } as Task),
      milestones,
      terminal: true,
    });

    this.cardStateStore.markClosed(taskId);
    logger.debug(`onAfterDelete: task #${taskId} 卡片已收尾`);
  }

  /** 操作记录创建：时间线追加（节流） */
  private async onAfterOperationCreate(
    ctx: HookContext<TaskOperationCreateResultContext>
  ): Promise<void> {
    const { operation } = ctx.data as TaskOperationCreateResultContext;
    if (!operation) return;
    if (!this.shouldNotify(WecomNotifyType.OPERATION_CREATED)) return;

    const rec = this.getRecord(operation.taskId);
    if (!rec) {
      logger.debug(
        `onAfterOperationCreate: task #${operation.taskId} 无卡片记录，skip`
      );
      return;
    }
    // 终态/暂停的不再追加（避免把已收尾的任务又刷成进行中）
    if (rec.status !== "open") {
      logger.debug(
        `onAfterOperationCreate: task #${operation.taskId} status=${rec.status}, skip`
      );
      return;
    }

    // 1) 数据先行：里程碑总是先落时间线（节流只限频率，不丢数据）
    const milestone = milestoneFromOperation(operation);
    const milestones = this.parseTimeline(rec.timeline);
    milestones.push(milestone);
    const trimmed = this.trimTimeline(milestones);

    // ★ Task #5255 单卡语义：operation **不发新卡**。
    //   数据先行落时间线（点「刷新详情」可见全部）；
    //   卡片只在首卡 + 终态两个节点发出。
    this.persistTimeline(operation.taskId, rec, trimmed, rec.updateCount);
    logger.debug(
      `[single-card] OPERATION_CREATED for task ` +
        `#${operation.taskId} merged into timeline`
    );
  }

  // ========================================================================
  // 发送 / 持久化 helpers
  // ========================================================================

  /** 发初始卡片 */
  private async sendCardStart(task: Task): Promise<void> {
    const env = getEnvContextOrEmpty();
    // ★ Task #5260：带插件配置 sourceId 兜底（后台链路 envEvent 可能缺）
    const fields = extractWecomFields(env as any, this.sourceId);
    const chatId = fields.chatId;
    if (!chatId) {
      logger.debug(`sendCardStart: no chatId for task #${task.id}, skip`);
      return;
    }

    // 已有 open 记录 → 复用（防重复发卡）
    const existing = this.getRecord(task.id);
    if (existing?.status === "open") {
      logger.debug(
        `sendCardStart: task #${task.id} 已有 open 记录 → 跳过重复发卡`
      );
      return;
    }

    const milestones: WecomMilestone[] = [
      {
        title: "Task 创建",
        timestamp: new Date().toISOString(),
        description: task.current_status || undefined,
      },
    ];

    const ok = await this.deliver({
      chatId,
      task,
      statusLabel: statusLabelOf(task),
      milestones,
    });

    if (ok) {
      this.cardStateStore.upsert({
        taskId: task.id,
        chatId,
        pinned: false,
        status: "open",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updateCount: 1,
        timeline: JSON.stringify(milestones),
      });
    } else {
      // 失败也落库（status=open 但 updateCount=0）→ 后续 update 会重试
      this.cardStateStore.upsert({
        taskId: task.id,
        chatId,
        pinned: false,
        status: "open",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        updateCount: 0,
        timeline: JSON.stringify(milestones),
      });
      logger.warn(`sendCardStart: task #${task.id} 首卡发送失败（已落库待重试）`);
    }
  }

  /** 发更新卡片 */
  private async sendCardUpdate(
    task: Task,
    changes: Partial<{ status?: string; progress?: number }> | undefined
  ): Promise<void> {
    const rec = this.getRecord(task.id);
    if (!rec) {
      // 无卡片且任务已终结 → 不凭空建卡
      if (isHardTerminal(String(task.status))) {
        logger.debug(
          `sendCardUpdate: task #${task.id} 终态且无卡片 → skip`
        );
        return;
      }
      // ★ Task #5255 单卡语义：无记录（首卡失败/未创建）→
      //   **不再降级补发新卡**（旧行为会补发，造成多卡刷屏）。
      //   进展数据不丢：落一条里程碑进时间线（下次发卡时带上），
      //   用户点「刷新详情」也能看到完整时间线。
      logger.debug(
        `sendCardUpdate: task #${task.id} 无卡片记录 → ` +
          `单卡语义不补发（进展落时间线）`
      );
      return;
    }
    if (rec.status === "closed" && isHardTerminal(String(task.status))) {
      // 已收尾的任务又来终态 → sendCardFinish 的 60s 合并去处理
      logger.debug(
        `sendCardUpdate: task #${task.id} closed + 终态 → skip`
      );
      return;
    }

    // ★ Task #5255 单卡语义：非终态 update **不发新卡**。
    //   企微协议无主动 patch（取证见 wecom-card-builder 头注释），
    //   每次状态变化发新卡 = 用户截图里的 4 张卡。
    //   进展数据不丢：落时间线（下次发卡 / 点「刷新详情」可见）。
    //   reopen 场景（closed → 非终态）：翻回 open 继续记录。
    //   ★ Task #5261：reopen 时追加「🔄 已重开」里程碑——
    //   历史时间线保留（不清空），重开动作本身也留痕。
    const reopened =
      rec.status === "closed" && !isHardTerminal(String(task.status));
    if (reopened) {
      this.cardStateStore.markReopened(task.id);
      logger.debug(`sendCardUpdate: task #${task.id} reopen（复用记录）`);
    }
    const fresh = reopened ? this.getRecord(task.id) : rec;
    const milestones = this.parseTimeline(fresh!.timeline);
    if (reopened) {
      // ★ Task #5261 DS review M2 防御：并发/重入双发时
      //   不重复追加（末尾已是「已重开」→ skip）；
      //   第二次真实 reopen 中间必有终态里程碑，不受影响。
      const last = milestones[milestones.length - 1];
      if (last?.title !== REOPEN_TITLE) {
        milestones.push({
          title: REOPEN_TITLE,
          timestamp: new Date().toISOString(),
          // ★ DS review N3：current_status 可能是长文案，截断防撑坏卡片
          description: task.current_status
            ? task.current_status.slice(0, 80)
            : undefined,
        });
      }
    }
    this.persistTimeline(task.id, fresh!, milestones, fresh!.updateCount);
    logger.debug(
      `sendCardUpdate: task #${task.id} 单卡语义（不发新卡，` +
        `进展走时间线；点「刷新详情」可见）`
    );
  }

  /** 发终态卡片 */
  private async sendCardFinish(task: Task, rawStatus: string): Promise<void> {
    const rec = this.getRecord(task.id);
    if (!rec) {
      logger.debug(
        `sendCardFinish: no card record for task #${task.id}, skip（不发新卡）`
      );
      return;
    }

    // ★ Task #5255 单卡语义：终态合并去重。
    //   task:after.update（status 迁入终态）与 task:after.complete
    //   （完成语义迁移）不互斥，一次完成操作会同时触发两个 hook
    //   ——旧行为各发一张终态卡（用户截图里的重复卡之一）。
    //   closed 后 60s 内的重复终态直接合并（时间线仍落库）。
    if (
      rec.status === "closed" &&
      rec.closedAt !== undefined &&
      Date.now() - rec.closedAt < 60_000
    ) {
      const milestones = this.parseTimeline(rec.timeline);
      milestones.push({
        title: FINISH_TITLE[rawStatus] ?? "任务收尾",
        timestamp: new Date().toISOString(),
        description: task.current_status || undefined,
      });
      this.persistTimeline(task.id, rec, milestones, rec.updateCount);
      logger.debug(
        `sendCardFinish: task #${task.id} 已收尾（60s 内重复终态）→ ` +
          `合并不发新卡`
      );
      return;
    }

    const milestones = this.parseTimeline(rec.timeline);
    milestones.push({
      title: FINISH_TITLE[rawStatus] ?? "任务收尾",
      timestamp: new Date().toISOString(),
      description: task.current_status || undefined,
    });

    await this.deliver({
      chatId: rec.chatId,
      task,
      statusLabel: statusLabelOf(task, rawStatus),
      milestones,
      terminal: true,
    });

    // ★ Task #5255 顺序修正：先快照时间线，再 markClosed。
    //   旧行为先 markClosed 再 persistTimeline（upsert 展开
    //   旧 rec，status="open"）→ 把 closed 又刷回 open，
    //   终态去重判定永远失效（每次终态都重发新卡）。
    // 时间线也快照进 store（重启后追溯）
    this.persistTimeline(task.id, rec, milestones, rec.updateCount + 1);
    if (rawStatus === "paused") {
      this.cardStateStore.markPaused(task.id);
    } else {
      this.cardStateStore.markClosed(task.id);
    }
    logger.debug(
      `sendCardFinish: task #${task.id} → status=${rawStatus}`
    );
  }

  /**
   * 投递（永不抛）
   *
   * ★ Task #5203：主路径 = WS 直发 template_card（text_notice 进展卡）；
   * 构造失败 / WS 不可用 → 回落 markdown（CLI 路径，#5193 行为）。
   *
   * @returns 是否成功（失败时调用方决定是否落库）
   */
  private async deliver(input: {
    chatId: string;
    task: Task;
    statusLabel: string;
    milestones: WecomMilestone[];
    changeSummary?: string;
    terminal?: boolean;
  }): Promise<boolean> {
    const content = buildWecomTaskCard({
      task: input.task,
      statusLabel: input.statusLabel,
      milestones: input.milestones,
      changeSummary: input.changeSummary,
      terminal: input.terminal,
    });

    // ── 主路径：WS 直发 template_card ────────────────
    const cardResult = await this.deliverTemplateCard(input);
    if (cardResult) {
      // ★ Task #5360（补充需求）：`statusNotifications: true` 时**额外**再发
      // 一条 markdown 状态文本（卡片照常发，两者正交）。
      //
      // ## 为什么 wecom 侧需要这个（与 lark 的差异）
      //
      // 企微在 #5193 之后**不存在**与 lark 对称的「rule-based 文本消息」链路
      // —— 状态已经并入 `text_notice` 卡片本身。为保持配置语义对称
      // （`statusNotifications: true` = "我要能看到状态文本"），这里把
      // true 映射为"发卡之外再加发一条 markdown"。
      //
      // ## 为什么失败不影响返回值
      //
      // 卡片已经送达 = 通知目标已达成。markdown 是**附加**可读性，
      // 失败只 log（best-effort），不能把成功改成失败让调用方重试发卡。
      if (this.statusNotificationsEnabled()) {
        await this.sendStatusMarkdown(input, content).catch((err: unknown) => {
          logger.warn(
            `sendStatusMarkdown failed for task #${input.task.id}: ` +
              `${(err as Error).message}（不影响卡片送达）`
          );
        });
      }
      return true;
    }

    // ── 回落：markdown（CLI 主路径 → WS fallback）────
    try {
      const r = await this.sender.send({
        chatId: input.chatId,
        content,
      });
      if (!r.ok) {
        logger.warn(
          `deliver failed for task #${input.task.id}: ${r.error ?? "unknown"}`
        );
        return false;
      }
      return true;
    } catch (err) {
      logger.error(
        `deliver threw for task #${input.task.id}: ${(err as Error).message}`
      );
      return false;
    }
  }

  /**
   * ★ Task #5360（补充需求）：读 ES 配置的 `statusNotifications`。
   *
   * ## 为什么读实时配置而不是快照
   *
   * lark 侧走 `EventHandler`（事件驱动，用 delegate 时刻的快照）；
   * 企微插件是**直接挂在 hook 上**（`task:after.create/update/complete`），
   * 拿不到"任务诞生时的快照"，所以只能读事件源当前配置。
   *
   * 语义差异可接受：企微侧开关变化对**下一次**任务状态变化生效（毫秒级），
   * 而 lark 侧对已派生任务保持口径一致。两边各自的取舍都有文档说明。
   *
   * 严格 `=== true`（手改 JSON 的 "true"/1/null 一律当 false）。
   */
  private statusNotificationsEnabled(): boolean {
    try {
      return this.esStatusNotifications === true;
    } catch {
      return false;
    }
  }

  /**
   * ★ Task #5360（补充需求）：`statusNotifications: true` 时额外发的 markdown 状态文本。
   *
   * 内容 = 现有 `buildWecomTaskCard` 的 markdown 形态（#5193 的文本可读性），
   * 与卡片正文同源，避免两套文案漂移。
   */
  private async sendStatusMarkdown(
    input: { chatId: string; task: Task },
    content: string,
  ): Promise<void> {
    const r = await this.sender.send({ chatId: input.chatId, content });
    if (!r.ok) {
      logger.warn(
        `sendStatusMarkdown failed for task #${input.task.id}: ` +
          `${r.error ?? "unknown"}（不影响卡片送达）`
      );
    }
  }

  /**
   * ★ Task #5203：经 WS 直发 template_card。
   *
   * - chatType：单聊 → chat_type=1；群聊 → 2
   *   （★ Task #5270：读 replyChannel.params.chatType——
   *   buildWecomReplyChannel 塞入，顶层无 chatType 字段；
   *   另当 chatId 与当前 env 的 chatId 不一致时（终态/删除
   *   链路用持久化记录的 rec.chatId，可能来自群会话）按群聊
   *   处理，避免群 chatid + chat_type=1 错配被企微丢弃）
   * - 失败返回 false（调用方回落 markdown），绝不抛
   */
  private async deliverTemplateCard(input: {
    chatId: string;
    task: Task;
    statusLabel: string;
    milestones: WecomMilestone[];
    changeSummary?: string;
    terminal?: boolean;
  }): Promise<boolean> {
    try {
      const env = getEnvContextOrEmpty();
      // ★ Task #5260：后台任务链路 envEvent.metadata 无 sourceId
      //   （生产实证 11:39-11:56 sourceId=unknown 三连失败）→
      //   回落插件自身配置的 sourceId（工厂注入的事件源 ID）。
      const fields = extractWecomFields(env as any, this.sourceId);
      const sourceId = fields.sourceId ?? "unknown";
      // ★ Task #5270：chatType 读 replyChannel.params.chatType
      //   （buildWecomReplyChannel 塞入，wecom-cli-handler.ts）。
      //   旧判定读顶层 replyChannel.chatType（不存在）恒 false
      //   → 群聊也发 chat_type=1 → 企微静默丢弃。
      const chatType =
        (env.replyChannel as
          | { params?: { chatType?: string } }
          | undefined)?.params?.chatType === "group" ||
        // ★ 终态/删除链路 chatId 取自持久化记录（rec.chatId），
        //   可能来自群会话——与当前 env chatId 不一致时按群聊发
        //   （chat_type=2），避免群 chatid + chat_type=1 错配。
        fields.chatId !== input.chatId
          ? "group"
          : "single";

      const notice = buildWecomTextNoticeCard({
        taskId: input.task.id,
        title: input.task.title,
        statusLabel: input.statusLabel,
        progress: Number(input.task.progress ?? 0),
        description: input.task.description,
        changeSummary: input.changeSummary,
        milestones: input.milestones,
        terminal: input.terminal,
      });

      // ★ Task #5250：升级为 button_interaction 卡（带「刷新详情」按钮）。
      //   用户可重复点击 → template_card_event 回调 → loadTimeline
      //   刷最新里程碑/操作记录。终态卡不带按钮（无可刷新内容）。
      const card = input.terminal
        ? notice
        : buildWecomButtonInteractionCard({
            taskId: input.task.id,
            title: input.task.title,
            statusLabel: input.statusLabel,
            progress: Number(input.task.progress ?? 0),
            description: input.task.description,
            changeSummary: input.changeSummary,
            milestones: input.milestones,
            // ★ Task #5360（CV BLOCKER 修复）：进展卡必须**同时**带两个按钮。
            //
            // ## 为什么这是 blocker
            //
            // 改造前进展卡只有「刷新详情」（VIEW）。`refresh_activity` 处理器
            // 虽然实现完整（wecom-card-action-handler 有分支、clients 有端口），
            // 但**没有任何卡片渲染出这个按钮** ⇒ 用户在真机上永远点不到
            // ⇒ 需求 3「企微卡片同步新增 subsession 消息数 + 最近 msg」在
            // 生产环境完全不可达（单测因为直接构造回调帧而假绿）。
            //
            // 协议上限 button_list ≤ 6，2 个按钮安全。
            buttons: [
              { text: "刷新详情", key: WecomCardActionKey.VIEW, style: 1 },
              {
                text: "刷新活性",
                key: WecomCardActionKey.REFRESH_ACTIVITY,
                style: 2,
              },
            ],
          });

      const r = await sendWecomTemplateCard({
        sourceId,
        chatId: input.chatId,
        chatType,
        card: card as unknown as Record<string, unknown>,
      });
      if (!r.ok) {
        logger.warn(
          `deliverTemplateCard failed for task #${input.task.id}: ` +
            `${r.error ?? "unknown"}（回落 markdown）`,
        );
        return false;
      }
      return true;
    } catch (err) {
      logger.warn(
        `deliverTemplateCard threw for task #${input.task.id}: ` +
          `${(err as Error).message}（回落 markdown）`,
      );
      return false;
    }
  }

  /** 读记录（store 异常降级为 undefined，绝不抛） */
  private getRecord(taskId: number): WecomCardState | undefined {
    try {
      return this.cardStateStore.get(taskId);
    } catch (err) {
      logger.warn(
        `getRecord failed for task #${taskId}: ${(err as Error).message}`
      );
      return undefined;
    }
  }

  /** 解析持久化的时间线 JSON（损坏时返回空数组） */
  private parseTimeline(timeline?: string): WecomMilestone[] {
    if (!timeline) return [];
    try {
      const arr = JSON.parse(timeline);
      return Array.isArray(arr) ? arr : [];
    } catch {
      return [];
    }
  }

  /** 时间线截断（保留最新 N 条） */
  private trimTimeline(milestones: WecomMilestone[]): WecomMilestone[] {
    const max = this.config.maxTimelineEntries ?? 20;
    if (milestones.length <= max) return milestones;
    return milestones.slice(milestones.length - max);
  }

  /** 持久化时间线（失败只 warn） */
  private persistTimeline(
    taskId: number,
    rec: WecomCardState,
    milestones: WecomMilestone[],
    updateCount: number
  ): void {
    try {
      this.cardStateStore.upsert({
        ...rec,
        updatedAt: Date.now(),
        updateCount,
        timeline: JSON.stringify(milestones),
      });
    } catch (err) {
      logger.warn(
        `persistTimeline failed for task #${taskId}: ${(err as Error).message}`
      );
    }
  }

  /** 从记录重建最小 Task（delete 后 Task 已不存在） */
  private hydrateTask(taskId: number, rec: WecomCardState): Task {
    return {
      id: taskId,
      title: `Task #${taskId}`,
      description: "",
      status: "active",
      priority: "medium",
      type: "normal",
      progress: 0,
      current_status: "",
      goals_and_expected_deliverables: "",
      createdAt: new Date(rec.createdAt).toISOString(),
      updatedAt: new Date(rec.updatedAt).toISOString(),
      project_path: "",
      context: "{}",
    };
  }

  /**
   * 操作记录发送节流
   *
   * 同一 Task 在 operationThrottleMs（默认 5s）窗口内只发一次，
   * 避免 agent 每次 tool call 都刷屏（企微每次都是新消息，比 lark 更敏感）。
   *
   * ★ 返回 true **不代表丢弃**：被节流的 operation 仍会先并进
   *   时间线并落库，只是不立刻发送。
   */
  private shouldThrottleOperation(operation: TaskOperation): boolean {
    const throttleMs = this.config.operationThrottleMs ?? 5000;
    if (throttleMs <= 0) return false;

    const key = `op:${operation.taskId}`;
    const now = Date.now();
    const lastTime = this.lastNotifyTimestamps.get(key);
    if (lastTime && now - lastTime < throttleMs) {
      logger.debug(
        `[throttle] skip OPERATION_CREATED send for task #${operation.taskId} ` +
          `(${now - lastTime}ms ago)`
      );
      return true;
    }
    this.lastNotifyTimestamps.set(key, now);
    return false;
  }

  /** 检查是否应该发送通知 */
  private shouldNotify(type: WecomNotifyType): boolean {
    const { notifyTypes } = this.config;
    // 空数组 = 全开；未配置（防御：构造器已兜底，理论不可达）= 全开
    if (!notifyTypes || notifyTypes.length === 0) return true;
    return notifyTypes.includes(type);
  }
}

/** 终态里程碑标题表 */
const FINISH_TITLE: Record<string, string> = {
  completed: "🎉 任务完成",
  cancelled: "🚫 任务取消",
  failed: "🚨 任务失败",
  timeout: "🚨 任务超时",
  archived: "📦 任务归档",
  paused: "⏸️ 任务暂停",
};

/** reopen 里程碑标题（Task #5261） */
const REOPEN_TITLE = "🔄 已重开";

// ========================================================================
// 工厂函数（兼容 API）
// ========================================================================

export function createWecomTaskNotifyHook(
  config: WecomTaskNotifyConfig = {}
): WecomTaskNotifyHook {
  return new WecomTaskNotifyHook(config);
}

// ========================================================================
// 装饰器（轻量：只包 try/catch + 日志，避免引入 log-trace 依赖环）
// ========================================================================

/**
 * 轻量执行装饰器：异常吞掉 + error 日志。
 *
 * 为什么不用 @TracedAs：hook 每次任务事件都会触发，
 * 企微插件失败绝不能影响任务主流程（best-effort 通知）。
 */
function TracedExecute(
  _target: unknown,
  _propertyKey: string,
  descriptor: PropertyDescriptor
): PropertyDescriptor {
  const original = descriptor.value;
  descriptor.value = async function (this: unknown, ...args: unknown[]) {
    try {
      return await original.apply(this, args);
    } catch (err) {
      logger.error(`wecom-task-notify execute threw: ${(err as Error).message}`);
    }
  };
  return descriptor;
}

// 供测试 / 诊断引用（避免 unused 警告）
export { MemoryWecomCardStateStore, getDefaultWecomCardDbPath };
