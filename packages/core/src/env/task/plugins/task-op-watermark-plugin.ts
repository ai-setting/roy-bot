/**
 * @fileoverview TaskOpWatermarkPlugin — sub-agent 感知任务操作记录（Task #5081，M1）
 *
 * 设计文档：/tmp/task-op-awareness-design.md（Task #5079，已验收）
 *
 * ## 场景
 *
 * sub-agent（roy 等）被委托推进某个 task 期间，default agent（或其它
 * sub-agent / CLI 探针进程）往同一 task 写了新的 operation 记录。
 * sub-agent 的 ReAct 循环对「别人给我加了记录」**毫无感知** —— 本插件
 * 在 `agent:after.tool` 时点做水位比对，命中则通过共享 meta-protocol
 * （`toolResult.result.metadata.toAddFakeUserMessage`）注入一条
 * user role 提醒，sub-agent 下轮读到后自行调 `task_operation_list` 读取。
 *
 * ## 水位语义（关键设计决策）
 *
 * - 水位用 **operation id**（SQLite AUTOINCREMENT，严格单调）而非
 *   timestamp（Date.now() 毫秒，同毫秒多条会漏）。
 * - 水位存 plugin 实例的 `Map<sessionId, Watermark>` —— 生命周期与
 *   plugin 实例一致；进程重启后首轮全量扫（N 聚 1 + 限流兜底噪声）。
 * - **查询必须绕过 operationsCache**：`sqlite-task-store.ts` 的缓存只在
 *   本进程写入时失效，跨进程（CLI 探针 / 另一 daemon）写入的记录不会
 *   失效本进程缓存 → 必须走 `listOperationsFresh`（直打 DB）。
 * - 能力探测：store 未实现 `listOperationsFresh`（外部宿主的后端）时
 *   降级 `listOperations` + `invalidateOperationsCache`，功能等价。
 *
 * ## 自提醒过滤（防 doom loop，核心）
 *
 * `op.sessionId === 我的 sessionId` → 不算新记录。三个来源：
 * 1. sub-agent 自己 `task_operation_create` 记进度（create-tool.ts:87）
 * 2. sub-agent 自己 `task_pre_complete` 写的留痕（pre-complete-tool.ts:89，
 *    Task #5073 两阶段验收的提交口 —— 回归保护）
 * 3. `sessionId = "unknown"` 的 fallback 写入（create-tool.ts:87 的兜底）
 *
 * ## 防退化与边界（设计文档 §4）
 *
 * - 无 task 绑定 → 跳过；DB 读异常 → catch + warn，不影响工具执行
 * - N 条新记录聚合 **1 条**提醒（详情 ≤3 条，最新优先，其余折叠）
 * - 单 session 限流 `TASK_OP_WATERMARK_MAX_REMINDERS`（5）次，超限只推水位
 * - 消息总长 ≤ `TASK_OP_WATERMARK_MESSAGE_LIMIT`（1500 字符）
 * - 每 `TASK_OP_WATERMARK_AUDIT_INTERVAL`（15）次工具调用兜底全量对账
 * - kind 合并顺序：`delegate` → `task-ops` → `max-iter`（max-iter 最终
 *   指令永远在末尾，见 fake-user-message-helper KIND_PRIORITY）
 */

import { createLogger } from "../../log-trace/logger";
import type { Plugin, HookContext, HookResult } from "../../agent/types";
import type { ModelMessage } from "ai";
import { enqueueToAddFakeUserMessage } from "./fake-user-message-helper";
import type { TaskOperation } from "../types";

const logger = createLogger("TaskOpWatermarkPlugin");

// ============================================================================
// 可调参数（常量 —— 测试直接引用，避免魔法数字）
// ============================================================================

/** 单 session（plugin 实例生命周期内）最大提醒次数 */
export const TASK_OP_WATERMARK_MAX_REMINDERS = 5;

/** 注入消息的总长度上限（字符） */
export const TASK_OP_WATERMARK_MESSAGE_LIMIT = 1500;

/** 兜底全量对账的工具调用间隔 */
export const TASK_OP_WATERMARK_AUDIT_INTERVAL = 15;

/** 展示的最新记录条数上限（其余折叠） */
const MAX_DETAIL_ITEMS = 3;

/** 单条 milestoneDescription 的摘要长度上限 */
const MAX_DESC_LENGTH = 200;

/** "unknown" 写入者（create-tool.ts:87 fallback）视作自己 */
const UNKNOWN_SESSION = "unknown";

/** 整条消息超限时的截断后缀（DS r2 MINOR-A：预留长度，总长仍 ≤ 上限） */
const TRUNCATION_SUFFIX = "…（已截断）";

// ============================================================================
// 依赖接口（duck-typed —— 不与 TaskComponent 产生类型循环依赖）
// ============================================================================

/** 水位数据结构（per session） */
interface Watermark {
  /** 已消费到的最大 operation id（单调递增；水位语义的唯一真相源） */
  lastSeenOpId: number;
  /**
   * 已**真正注入提醒**的最大 operation id（只进不退）。
   *
   * 兜底对账轮用 `op.id > lastNotifiedOpId` 作下界 —— 既有
   * 「不看增量水位」的兜底能力（水位被错误推进仍能补报），
   * 又不会把历史记录反复上报烧光限流预算（DS review r1 MAJOR-1）。
   */
  lastNotifiedOpId: number;
  /** 绑定的 task id 集合（变化时重置水位） */
  taskIds: number[];
  /** 本 session 已触发提醒次数（限流） */
  reminderCount: number;
  /** 距上次兜底对账的工具调用次数 */
  toolsSinceAudit: number;
}

/**
 * TaskComponent 只读能力面 —— 与 decision-hint-plugin 的
 * `TaskComponentReadonly` 同款隔离模式（避免类型循环依赖）。
 */
export interface TaskOpWatermarkTaskComponentLike {
  /** 按 session 反查绑定的**全部** task（多 task 并集水位，不漏报） */
  getTaskIdsBySessionId?(sessionId: string): Promise<number[] | undefined>;
  /** 老接口：只返回第一个 task（getTaskIdsBySessionId 未实现时的 fallback） */
  getTaskIdBySessionId?(sessionId: string): Promise<number | undefined>;
  getTask(id: number): Promise<{ id: number; title: string } | undefined>;
  /** 绕过 operationsCache 的 fresh 查询（可选 —— 能力探测） */
  listOperationsFresh?(
    options: { taskId: number; limit?: number },
  ): Promise<TaskOperation[]>;
  /** 常规查询（fallback 路径用） */
  listOperations(options: {
    taskId: number;
    limit?: number;
  }): Promise<TaskOperation[]>;
  /** 缓存失效（fallback 路径用；可选 —— 能力探测） */
  invalidateOperationsCache?(taskId: number): void;
}

export interface TaskOpWatermarkPluginConfig {
  /**
   * 惰性解析 TaskComponent（推荐注入方式）。
   *
   * 为什么惰性：`registerAgent` 可能早于 TaskComponent 注册（时序风险），
   * 惰性闭包把解析推迟到首次 `execute()`（env 组件已就绪）——
   * 设计文档 §2.1 方案 (c)。
   */
  resolveTaskComponent?: () => TaskOpWatermarkTaskComponentLike | undefined;
}

// ============================================================================
// 文案
// ============================================================================

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…（已截断）`;
}

function buildReminderMessage(
  taskId: number,
  taskTitle: string | undefined,
  ops: TaskOperation[],
): string {
  const count = ops.length;
  const lines: string[] = [];

  lines.push(
    `[task-ops] Task #${taskId}${taskTitle ? `「${taskTitle}」` : ""} 有 ${count} 条由**其他 agent** 新增的操作记录，请读取并按需调整你的行为。`,
  );
  lines.push("");
  lines.push("最新记录：");

  const details = ops.slice(0, MAX_DETAIL_ITEMS);
  for (const op of details) {
    const desc = op.milestoneDescription
      ? truncate(op.milestoneDescription.split("\n")[0], MAX_DESC_LENGTH)
      : "";
    lines.push(
      `- [${op.milestoneType}] ${op.milestoneTitle}${desc ? `\n  ${desc}` : ""}`,
    );
  }
  if (count > MAX_DETAIL_ITEMS) {
    lines.push(
      `（其余 ${count - MAX_DETAIL_ITEMS} 条较旧记录省略，可用 task_operation_list 查看全部）`,
    );
  }

  lines.push("");
  lines.push(
    `请调用 task_operation_list(task_id=${taskId}) 读取全部新记录，判断是否需要修改你的计划、产出或下一步动作。`,
  );
  lines.push("若这些记录与你的当前工作无关，忽略即可，无需回复。");

  return lines.join("\n");
}

// ============================================================================
// Plugin
// ============================================================================

export class TaskOpWatermarkPlugin {
  readonly name = "TaskOpWatermarkPlugin";
  readonly version = "1.0.0";
  readonly description =
    "Task #5081 — agent:after.tool 水位比对：同一 task 出现他人（sessionId 过滤 + unknown 过滤）新增的 operation 时，经共享 meta-protocol 注入 user role 提醒（N 聚 1 / 限流 5 / 长度 1500 / 15 次兜底对账 / fresh 旁路绕 operationsCache）。";
  readonly priority = 40;

  /** session 级水位（plugin 实例生命周期） */
  private readonly watermarks = new Map<string, Watermark>();
  private readonly resolveTaskComponent:
    | (() => TaskOpWatermarkTaskComponentLike | undefined)
    | undefined;

  constructor(config?: TaskOpWatermarkPluginConfig) {
    this.resolveTaskComponent = config?.resolveTaskComponent;
  }

  async execute(ctx: HookContext): Promise<HookResult> {
    try {
      await this.check(ctx);
    } catch (err) {
      // 永不抛 —— plugin 异常不能影响工具执行（设计文档 §4.6）
      logger.warn(
        `[TaskOpWatermark] check failed (fail-open): ${(err as Error)?.message}`,
      );
    }
    return { continue: true };
  }

  private async check(ctx: HookContext): Promise<void> {
    const sessionId = ctx.context?.sessionId;
    if (!sessionId) return;

    const taskComponent = this.resolveTaskComponent?.();
    if (!taskComponent) return;

    // ---- 解析绑定的 task（多 task 并集）----
    const taskIds = await this.resolveTaskIds(taskComponent, sessionId);
    if (taskIds.length === 0) return; // 无绑定 → 跳过

    // ---- 水位（task 集变化 → 重置）----
    const taskKey = taskIds.join(",");
    let wm = this.watermarks.get(sessionId);
    if (!wm || wm.taskIds.join(",") !== taskKey) {
      wm = {
        lastSeenOpId: 0,
        lastNotifiedOpId: 0,
        taskIds: taskIds,
        reminderCount: 0,
        toolsSinceAudit: 0,
      };
      this.watermarks.set(sessionId, wm);
    }

    wm.toolsSinceAudit++;
    const isAuditTurn = wm.toolsSinceAudit >= TASK_OP_WATERMARK_AUDIT_INTERVAL;
    if (isAuditTurn) wm.toolsSinceAudit = 0;

    // ---- 拉取新记录（fresh 优先，绕 operationsCache）----
    //
    // 下界语义（DS review r1 MAJOR-1 修复）：
    // - 常规轮：`op.id > lastSeenOpId`（增量水位）。
    // - 兜底对账轮（每 15 次）或首轮：下界放宽为 `op.id > lastNotifiedOpId`
    //   —— 只进不退的「已真正注入」水位。既有兜底能力（水位被错误
    //   推进 / 进程重启后水位丢失时仍能补报），又不会把历史记录
    //   反复上报烧光限流预算。
    const lowerBound =
      isAuditTurn || wm.lastSeenOpId === 0
        ? wm.lastNotifiedOpId
        : wm.lastSeenOpId;
    let newOps: TaskOperation[] = [];
    let maxIdSeen = wm.lastSeenOpId;

    for (const taskId of taskIds) {
      const ops = await this.listOps(taskComponent, taskId);
      const othersNew = ops.filter(
        (op) => op.id > lowerBound && !this.isSelf(op, sessionId),
      );
      for (const op of othersNew) {
        newOps.push(op);
        // peer op 可见即推进：常规轮下轮不再重报（lastSeenOpId）；
        // audit 轮仍会尝试补报（lastNotifiedOpId 未推进时），
        // 限流已满则静默跳过（宁可静默推进水位，不可重复轰炸）
        if (op.id > maxIdSeen) maxIdSeen = op.id;
      }
      // 「自己的旧记录」也计入水位，避免每次全量对账重扫历史
      const selfMax = ops
        .filter((op) => this.isSelf(op, sessionId))
        .reduce((m, op) => Math.max(m, op.id), 0);
      maxIdSeen = Math.max(maxIdSeen, selfMax);
    }

    // 去重（跨 task 的 id 空间不重叠，保险起见按 id 去重）+ 按 id DESC
    const seen = new Set<number>();
    newOps = newOps
      .filter((op) => (seen.has(op.id) ? false : (seen.add(op.id), true)))
      .sort((a, b) => b.id - a.id);

    // 推进增量水位（注入前 —— 宁可多报一次，不可漏报；单调保护防 id 回退）。
    // ⚠️ lastNotifiedOpId 唯一写入点在下方注入分支（Math.max 单调、
    //    结构上不倒退）；常规轮防重报由 lastSeenOpId 兜底（DS r2）。
    wm.lastSeenOpId = Math.max(wm.lastSeenOpId, maxIdSeen);

    if (newOps.length === 0) return;

    // ---- 限流 ----
    if (wm.reminderCount >= TASK_OP_WATERMARK_MAX_REMINDERS) {
      logger.info(
        `[TaskOpWatermark] session=${sessionId.slice(0, 12)}... reminder limit reached (${wm.reminderCount}) — watermark advanced silently`,
      );
      return;
    }

    // ---- 注入（复用共享 meta-protocol，kind="task-ops"）----
    if (!ctx.toolResult) return;

    // 按 task 分组渲染（DS review r1 MINOR-1）：多 task 命中时
    // 每个 task 一段（标题 + task_operation_list 指引指向正确 id），
    // 汇成一条 user message（N 聚 1 语义不破坏）。
    const byTask = new Map<number, TaskOperation[]>();
    for (const op of newOps) {
      const arr = byTask.get(op.taskId) ?? [];
      arr.push(op);
      byTask.set(op.taskId, arr);
    }

    const sections: string[] = [];
    for (const [taskId, ops] of byTask) {
      const title = (await safeGetTask(taskComponent, taskId))?.title;
      sections.push(buildReminderMessage(taskId, title, ops));
    }
    const content = sections.join("\n\n");
    const finalContent =
      content.length > TASK_OP_WATERMARK_MESSAGE_LIMIT
        ? `${content.slice(0, TASK_OP_WATERMARK_MESSAGE_LIMIT - TRUNCATION_SUFFIX.length)}${TRUNCATION_SUFFIX}`
        : content;

    enqueueToAddFakeUserMessage(
      ctx.toolResult,
      { role: "user", content: finalContent } as ModelMessage,
      "task-ops",
    );

    wm.reminderCount++;
    // ★ 只有「真正注入」才推进 lastNotifiedOpId（只进不退）——
    //   兜底对账轮的下界依据（DS review r1 MAJOR-1）。
    //   限流路径不推进：那些记录下轮 audit 仍会被报出（不吞）。
    const maxNotified = newOps.reduce((m, op) => Math.max(m, op.id), 0);
    wm.lastNotifiedOpId = Math.max(wm.lastNotifiedOpId, maxNotified);

    logger.info(
      `[TaskOpWatermark] reminder injected: session=${sessionId.slice(0, 12)}..., tasks=${[...byTask.keys()].join(",")}, newOps=${newOps.length}, reminderCount=${wm.reminderCount}`,
    );
  }

  /** 自提醒过滤：自己写的 + unknown fallback 写入的都不算「别人的」 */
  private isSelf(op: TaskOperation, sessionId: string): boolean {
    return op.sessionId === sessionId || op.sessionId === UNKNOWN_SESSION;
  }

  private async resolveTaskIds(
    tc: TaskOpWatermarkTaskComponentLike,
    sessionId: string,
  ): Promise<number[]> {
    if (typeof tc.getTaskIdsBySessionId === "function") {
      const ids = await tc.getTaskIdsBySessionId(sessionId);
      return Array.isArray(ids) ? ids : [];
    }
    if (typeof tc.getTaskIdBySessionId === "function") {
      const id = await tc.getTaskIdBySessionId(sessionId);
      return typeof id === "number" ? [id] : [];
    }
    return [];
  }

  /**
   * 拉取记录 —— fresh 优先（绕 operationsCache；跨进程写入可见），
   * 能力探测失败降级 listOperations + invalidateOperationsCache。
   */
  private async listOps(
    tc: TaskOpWatermarkTaskComponentLike,
    taskId: number,
  ): Promise<TaskOperation[]> {
    if (typeof tc.listOperationsFresh === "function") {
      return await tc.listOperationsFresh({ taskId, limit: 50 });
    }
    // fallback：常规查询 + 主动失效缓存（防跨进程写入被陈旧缓存遮蔽）
    if (typeof tc.invalidateOperationsCache === "function") {
      tc.invalidateOperationsCache(taskId);
    }
    return await tc.listOperations({ taskId, limit: 50 });
  }
}

async function safeGetTask(
  tc: TaskOpWatermarkTaskComponentLike,
  taskId: number,
): Promise<{ id: number; title: string } | undefined> {
  try {
    return await tc.getTask(taskId);
  } catch {
    return undefined;
  }
}

/**
 * 创建 TaskOpWatermarkPlugin 实例（与 createMaxIterationReminderPlugin 同款形态）
 */
export function createTaskOpWatermarkPlugin(
  config?: TaskOpWatermarkPluginConfig,
): Plugin {
  const inst = new TaskOpWatermarkPlugin(config);
  return {
    name: inst.name,
    version: inst.version,
    description: inst.description,
    hooks: [{ point: "agent:after.tool", priority: inst.priority }],
    execute: async (ctx: HookContext): Promise<HookResult> => {
      return inst.execute(ctx);
    },
  };
}
