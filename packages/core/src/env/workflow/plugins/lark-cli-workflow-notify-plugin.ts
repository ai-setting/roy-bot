/**
 * @fileoverview LarkCliWorkflowNotifyHook - 把 workflow run 进展同步到飞书群
 *
 * Part 2：在 workflow 生命周期 Hook 上，把「run 进展」渲染成**一张可更新 + 置顶的
 * 飞书卡片** —— 完全复用 task 通知的卡片引擎 `LarkCardPatchNotifier`（同一套
 * 卡片骨架 / lark-cli 参数契约 / pin-unpin 逻辑），不新写 lark-cli 封装。
 *
 * 生命周期映射：
 *   - `workflow:before.run`  → notifier.startWorkflow（发卡 + pin）
 *   - `workflow:before.node` → notifier.updateWorkflow（patch 同一卡片；节流）
 *   - `workflow:after.node`  → notifier.updateWorkflow（patch 同一卡片；节点里程碑/进度）
 *   - `workflow:after.run`   → notifier.finishWorkflow（终态 patch + unpin + 清理跟踪）
 *
 * ── 触发群 / 身份（与 task 插件一致）──────────────────────────────────
 * workflow Hook 由 engine 触发，其 ALS 上下文继承自触发它的 agent query
 * （`workflow_run` 工具）—— 因此 `getEnvContextOrEmpty().replyChannel`
 * （chatId / profile / messageId）应该可达。若取不到 chatId → **安全跳过**
 * （不抛错、不发到错误的群）。
 *
 * ── 单卡片语义 ────────────────────────────────────────────────────────
 * 同一 runId 全程只建一张卡（`cardMessageIds` 按 runId 跟踪 messageId），
 * 节点事件只 patch 这张卡（不刷屏）；终态后清理跟踪项。
 *
 * ⚠️ 关键契约：`globalHookManager.execute(point, data, metadata)` 会把 data 包进
 *   `HookContext` —— hook 收到的第 1 个参数是 **ctx**，载荷在 **ctx.data**。
 */

import type { Hook, HookContext } from "../../hook/types";
import { TracedAs } from "../../log-trace/decorator";
import { createLogger } from "../../log-trace/logger";
import { getEnvContextOrEmpty } from "../../context";
import {
  WorkflowHookPoints,
  type WorkflowRunHookData,
  type WorkflowNodeHookData,
} from "../hooks/workflow-hook-points";
import {
  formatDurationMs,
  LarkCardPatchNotifier,
  type Milestone,
  type ProcessStep,
  type StartTaskResult,
  type WorkflowCardStatus,
  type WorkflowMeta,
} from "../../task/plugins/lark-card-patch-notifier";

const logger = createLogger("lark-cli:workflow-notify");

// ========================================================================
// Config
// ========================================================================

export interface WorkflowNotifyConfig {
  /** 是否启用（默认 true） */
  enabled?: boolean;
  /** 优先级（默认 5） */
  priority?: number;
  /** 插件名称（用于 pluginEnabled 检查） */
  pluginName?: string;
  /** 事件源 ID（用于 pluginEnabled 检查） */
  sourceId?: string;
  /**
   * 节点「开始」事件的节流间隔（毫秒）
   *
   * `workflow:before.node` 在大 DAG 上高频触发，不加节流会频繁 patch 卡片。
   * 默认 3000ms；设为 0 表示不节流。
   *
   * ★ 只节流 `before.node`（"开始"），`after.node` / `after.run` 永远 patch ——
   *   节点完成/终态是进度分子与终态卡片的来源，丢了会让卡片停在旧状态。
   */
  nodeThrottleMs?: number;
  /**
   * LarkCardPatchNotifier 实例
   *
   * 不传 → plugin 自己 new 一个（messageId 由 plugin 的 Map 跟踪）。
   */
  cardNotifier?: LarkCardPatchNotifier;
}

// ========================================================================
// LarkCliWorkflowNotifyHook
// ========================================================================

export class LarkCliWorkflowNotifyHook implements Hook {
  readonly name: string;
  readonly priority: number;
  readonly description?: string;
  readonly pluginName?: string;
  readonly sourceId?: string;

  /**
   * 本插件监听的 hook 点（显式声明）
   *
   * ★ `event-source-handlers.getPluginHookPoints()` 会优先读这个字段 —— 让
   *   "flat execute" 插件能声明自己的 hook 点，而不是被硬编码成 task 的 4 个点。
   */
  readonly hookPoints: string[] = [
    WorkflowHookPoints.BEFORE_RUN,
    WorkflowHookPoints.AFTER_RUN,
    WorkflowHookPoints.BEFORE_NODE,
    WorkflowHookPoints.AFTER_NODE,
  ];

  private readonly config: WorkflowNotifyConfig;

  /** 卡片引擎（复用 task 卡片实现） */
  private cardNotifier?: LarkCardPatchNotifier;

  /** 卡片 messageId 跟踪（key: runId）—— 同一 run 全程复用同一张卡 */
  private cardMessageIds: Map<string, string> = new Map();

  /** 节点「开始」节流状态（key: `node:${runId}` → 上次 patch 时间戳） */
  private lastNodeNotifyTimestamps: Map<string, number> = new Map();

  /** 建卡失败哨兵：后续 update 直接 skip，避免"失败→重试→再失败"风暴 */
  private static readonly CARD_START_FAILED_SENTINEL = "__wf_card_start_failed__";

  /** 建卡进行中哨兵：挡住同链路上的重入 update（避免重复建卡） */
  private static readonly CARD_START_INFLIGHT_SENTINEL = "__wf_card_start_inflight__";

  constructor(config: WorkflowNotifyConfig = {}) {
    this.name = config.pluginName || "LarkCliWorkflowNotifyPlugin";
    this.priority = config.priority ?? 5;
    this.description = "LarkCli workflow 进展通知 Hook（卡片模式）";
    this.pluginName = config.pluginName;
    this.sourceId = config.sourceId;
    this.config = {
      enabled: true,
      priority: 5,
      ...config,
    };
    // 与 task 插件一致：默认启用卡片模式（无 legacy 文本路径）
    this.cardNotifier = config.cardNotifier ?? new LarkCardPatchNotifier();
  }

  @TracedAs("lark-cli-workflow-notify.execute")
  async execute(ctx: HookContext<unknown>): Promise<void> {
    if (!this.config.enabled) return;

    // pluginEnabled 门控（与 task 插件一致）
    const env = getEnvContextOrEmpty();
    if (this.pluginName && this.sourceId) {
      const key = `${this.sourceId}:${this.pluginName}`;
      if (env.pluginEnabled && env.pluginEnabled[key] !== true) {
        logger.debug(`Plugin not enabled for source: ${key}`);
        return;
      }
    }

    switch (ctx.hookPoint) {
      case WorkflowHookPoints.BEFORE_RUN:
        await this.onBeforeRun(ctx as HookContext<WorkflowRunHookData>);
        break;
      case WorkflowHookPoints.AFTER_RUN:
        await this.onAfterRun(ctx as HookContext<WorkflowRunHookData>);
        break;
      case WorkflowHookPoints.BEFORE_NODE:
        await this.onBeforeNode(ctx as HookContext<WorkflowNodeHookData>);
        break;
      case WorkflowHookPoints.AFTER_NODE:
        await this.onAfterNode(ctx as HookContext<WorkflowNodeHookData>);
        break;
      default:
        logger.debug(`ignored hook point: ${ctx.hookPoint}`);
    }
  }

  // ========================================================================
  // Hook handlers
  // ========================================================================

  /** run 开始：建卡（标题含 workflow 名）+ pin */
  private async onBeforeRun(ctx: HookContext<WorkflowRunHookData>): Promise<void> {
    const data = ctx.data;
    if (!data?.runId) return;
    await this.sendCardStart(data);
  }

  /** 节点即将执行：patch 同一卡片（节流） */
  private async onBeforeNode(ctx: HookContext<WorkflowNodeHookData>): Promise<void> {
    const data = ctx.data;
    if (!data?.runId) return;
    if (this.shouldThrottleNodeStart(data.runId)) return;

    const timestamp = new Date().toISOString();
    await this.patchCard(data, {
      currentNode: data.nodeId,
      currentNodeType: data.nodeType,
      processSteps: [
        {
          title: `${data.nodeId} 开始`,
          timestamp,
          category: data.nodeType,
        },
      ],
    });
  }

  /** 节点结束：patch 同一卡片（进度 + 过程记录；失败时加里程碑） */
  private async onAfterNode(ctx: HookContext<WorkflowNodeHookData>): Promise<void> {
    const data = ctx.data;
    if (!data?.runId) return;

    const timestamp = new Date().toISOString();
    const nodeStatus = String(data.status);
    const succeeded = nodeStatus === "completed" || nodeStatus === "skipped";
    const statusText = succeeded ? "完成" : "失败";
    const durationText = formatDurationMs(data.durationMs);
    const description =
      data.error ??
      (durationText
        ? `耗时 ${durationText}`
        : succeeded
          ? undefined
          : `节点状态：${nodeStatus}`);

    const processSteps: ProcessStep[] = [
      {
        title: `${data.nodeId} ${statusText}`,
        timestamp,
        endTimestamp: timestamp,
        description,
        category: data.nodeType,
      },
    ];
    const milestones: Milestone[] =
      succeeded || !data.error
        ? []
        : [
            {
              title: `节点失败：${data.nodeId}`,
              timestamp,
              description: data.error,
            },
          ];

    await this.patchCard(data, {
      currentNode: data.nodeId,
      currentNodeType: data.nodeType,
      milestones,
      processSteps,
    });
  }

  /** run 终态：patch 终态（completed 绿 / failed 红 / stopped 灰）+ unpin + 清理 */
  private async onAfterRun(ctx: HookContext<WorkflowRunHookData>): Promise<void> {
    const data = ctx.data;
    if (!data?.runId) return;

    const messageId = this.cardMessageIds.get(data.runId);
    if (
      !messageId ||
      messageId === LarkCliWorkflowNotifyHook.CARD_START_FAILED_SENTINEL ||
      messageId === LarkCliWorkflowNotifyHook.CARD_START_INFLIGHT_SENTINEL
    ) {
      logger.debug(`onAfterRun: no card for run ${data.runId}, skip`);
      return;
    }

    const status = this.mapRunStatus(data.status);
    const target = this.resolveTarget();
    const profile = target.profile;

    try {
      await this.cardNotifier!.finishWorkflow({
        messageId,
        chatId: target.chatId,
        profile,
        status,
        meta: this.buildWorkflowMeta(data),
        completedNodes: data.completedNodes,
        totalNodes: data.totalNodes,
        durationMs: data.durationMs,
        error: data.error ?? data.stopReason,
        finalStep: data.status === "completed" ? undefined : data.stopReason,
      });
      this.cardMessageIds.delete(data.runId);
      // ★ 2026-10-16 独立 review P2-2：throttle Map 的 key 是 `node:<runId>`，
      //   原实现只删 cardMessageIds，导致该 Map **永不清理** —— 长驻 ES 进程下
      //   每个 run 都会留下一条，属无界增长（内存泄漏）。终态时一并删除。
      this.lastNodeNotifyTimestamps.delete(`node:${data.runId}`);
    } catch (err) {
      logger.error(
        `sendCardFinish failed for workflow run ${data.runId}: ${(err as Error).message}`
      );
    }
  }

  // ========================================================================
  // 卡片操作
  // ========================================================================

  /** 建卡（+ pin）并缓存 messageId */
  private async sendCardStart(data: WorkflowRunHookData): Promise<void> {
    if (!this.cardNotifier) return;

    // 同一 run 只建一次卡（含 in-flight 重入保护）
    const claim = this.cardMessageIds.get(data.runId);
    if (claim) {
      logger.debug(
        `sendCardStart: run ${data.runId} 已有首卡（${claim}）→ 跳过重复建卡`
      );
      return;
    }
    this.cardMessageIds.set(
      data.runId,
      LarkCliWorkflowNotifyHook.CARD_START_INFLIGHT_SENTINEL
    );

    const target = this.resolveTarget();
    if (!target.chatId) {
      this.cardMessageIds.delete(data.runId);
      logger.debug(`sendCardStart: no chatId for run ${data.runId}, skip`);
      return;
    }

    try {
      const res: StartTaskResult = await this.cardNotifier.startWorkflow({
        chatId: target.chatId,
        profile: target.profile,
        meta: this.buildWorkflowMeta(data),
        totalNodes: data.totalNodes,
        completedNodes: data.completedNodes ?? 0,
        milestones: [
          {
            title: "Workflow 启动",
            timestamp: new Date().toISOString(),
            description: data.workflowName,
          },
        ],
      });
      this.cardMessageIds.set(data.runId, res.messageId);
      logger.debug(
        `sendCardStart: run ${data.runId} → message ${res.messageId} ` +
          `(pinned=${res.pinned}) chat=${target.chatId}`
      );
    } catch (err) {
      this.cardMessageIds.set(
        data.runId,
        LarkCliWorkflowNotifyHook.CARD_START_FAILED_SENTINEL
      );
      logger.error(
        `sendCardStart failed for run ${data.runId}: ${(err as Error).message}`
      );
    }
  }

  /** patch 同一张卡（无卡片 / 建卡失败 / 无 chatId 时安全跳过） */
  private async patchCard(
    data: WorkflowRunHookData | WorkflowNodeHookData,
    extra: {
      currentNode?: string;
      currentNodeType?: string;
      milestones?: Milestone[];
      processSteps?: ProcessStep[];
    }
  ): Promise<void> {
    if (!this.cardNotifier) return;

    const messageId = this.cardMessageIds.get(data.runId);
    if (!messageId) {
      logger.debug(`patchCard: no card for run ${data.runId}, skip`);
      return;
    }
    if (
      messageId === LarkCliWorkflowNotifyHook.CARD_START_FAILED_SENTINEL ||
      messageId === LarkCliWorkflowNotifyHook.CARD_START_INFLIGHT_SENTINEL
    ) {
      logger.debug(
        `patchCard: card not ready for run ${data.runId} (${messageId}), skip`
      );
      return;
    }

    const target = this.resolveTarget();
    if (!target.chatId) {
      logger.debug(`patchCard: no chatId for run ${data.runId}, skip`);
      return;
    }

    try {
      await this.cardNotifier.updateWorkflow({
        messageId,
        chatId: target.chatId,
        profile: target.profile,
        status: "running",
        meta: this.buildWorkflowMeta(data),
        completedNodes: data.completedNodes,
        totalNodes: data.totalNodes,
        currentNode: extra.currentNode,
        currentNodeType: extra.currentNodeType,
        milestones: extra.milestones,
        processSteps: extra.processSteps,
      });
    } catch (err) {
      logger.error(
        `patchCard failed for run ${data.runId}: ${(err as Error).message}`
      );
    }
  }

  // ========================================================================
  // 解析 helpers
  // ========================================================================

  /**
   * 解析卡片目标（chatId / profile）—— 与 task 插件一致，优先 ALS replyChannel
   *
   * workflow 的 hook 由 engine 触发，ALS 上下文继承自触发它的 agent query
   * （`workflow_run` 工具），因此 replyChannel 通常可达。取不到 → 调用方安全跳过。
   */
  private resolveTarget(): { chatId?: string; profile?: string } {
    const env = getEnvContextOrEmpty();
    const rc = env.replyChannel as
      | { chatId?: string; profile?: string }
      | undefined;
    return {
      chatId: rc?.chatId,
      profile: rc?.profile,
    };
  }

  /** hook 载荷 → 卡片"运行栏位"元信息 */
  private buildWorkflowMeta(
    data: WorkflowRunHookData | WorkflowNodeHookData
  ): WorkflowMeta {
    const run = data as WorkflowRunHookData;
    return {
      runId: data.runId,
      workflowName: data.workflowName,
      workflowId: run.workflowId,
      input: run.input,
    };
  }

  /** RunStatus → 卡片终态 */
  private mapRunStatus(status: string): Extract<
    WorkflowCardStatus,
    "completed" | "failed" | "stopped"
  > {
    switch (String(status)) {
      case "completed":
        return "completed";
      case "stopped":
        return "stopped";
      default:
        return "failed";
    }
  }

  /** 节点「开始」节流（只节流 before.node） */
  private shouldThrottleNodeStart(runId: string): boolean {
    const throttleMs = this.config.nodeThrottleMs ?? 3000;
    if (throttleMs <= 0) return false;

    const key = `node:${runId}`;
    const now = Date.now();
    const last = this.lastNodeNotifyTimestamps.get(key);
    if (last && now - last < throttleMs) {
      logger.debug(
        `[throttle] skip before.node patch for run ${runId} (${now - last}ms ago)`
      );
      return true;
    }
    this.lastNodeNotifyTimestamps.set(key, now);
    return false;
  }
}

// ========================================================================
// 工厂函数
// ========================================================================

export function createLarkCliWorkflowNotifyHook(
  config: WorkflowNotifyConfig = {}
): LarkCliWorkflowNotifyHook {
  return new LarkCliWorkflowNotifyHook(config);
}
