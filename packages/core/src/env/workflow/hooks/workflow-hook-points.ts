/**
 * @fileoverview Workflow Hook Points — 工作流生命周期 Hook 点
 *
 * 定义 Workflow run engine 生命周期中可被插件观察的 Hook 点。
 *
 * 设计对齐 `TaskHookPoints`（`env/task/hooks/task-hook-points.ts`）：
 *   - `const` 对象 + 字面量联合类型
 *   - 通过 `globalHookManager.execute(point, data, metadata)` 触发
 *   - Hook 内抛错由 HookManager 隔离（`safeExecute`），不影响 workflow 运行
 *
 * 命名约定沿用 repo 既有风格：`<component>:<phase>.<action>`
 *   （例：`task:after.update` / `tool:before.execute`）
 *
 * ── 为什么需要（背景）──────────────────────────────────────────────
 * 在本次改动之前，workflow 包内**没有任何** lifecycle hook 点：
 *   - `globalHookManager` 在 workflow 包内只被 json-output 插件用于
 *     `agent:after.react`（那是 agent hook，不是 workflow 运行 hook）
 *   - `RunWorkflowLifecycleHooks`（tools/run-workflow.ts）是一组
 *     **依赖注入回调**（attach/detach/replaceWorkflowRun），服务于后台任务的
 *     停止传播，不是通用的插件 Hook
 *
 * 因此外部插件（例如「把 workflow 进展同步到飞书群」的 notify 插件）无法观察
 * workflow 的开始/结束与节点的开始/结束。本模块补上这四个 Hook 点，
 * 并在 run engine 的真实生命周期位置触发。
 *
 * ── 触发位置（与既有 EventBus 事件一一对应，保证语义一致）────────────
 *   | Hook 点                  | 触发位置                                             | 对应内部事件         |
 *   |--------------------------|------------------------------------------------------|----------------------|
 *   | `workflow:before.run`    | `engine.runWithResume()` 起点                        | `workflow.started`   |
 *   | `workflow:after.run`     | `engine.completeWorkflow()` / `failWorkflow()` / `stop()` | `workflow.completed` / `workflow.failed` / `workflow.stopped` |
 *   | `workflow:before.node`   | `engine.validateAndExecute()` 起点                   | `node.started`       |
 *   | `workflow:after.node`    | `engine.validateAndExecute()` 成功/失败分支          | `node.completed` / `node.failed` |
 *
 * ⚠️ node 级 hook 接在 **`engine.validateAndExecute()`** 而非 `executor.executeNode()`
 *   （独立 review P2-1 指出的文档与实现不符）。原因：validateAndExecute 是
 *   `startNode` 与 `resumeNode` 的**唯一汇聚点**，且此处持有 `sessionState`
 *   —— 才能拿到 `totalNodes` / `completedNodes` 填进 hook payload。
 *
 * 注意 `runWithResume` 同时服务于首次运行与 resume —— 每次进入 run loop 都会触发
 * `before.run`，这样 pause→resume 时插件也能感知到「又跑起来了」。
 */

import { globalHookManager } from "../../hook";
import type { RunStatus, NodeStatus } from "../types/run";

export const WorkflowHookPoints = {
  // ========================================================================
  // Run-level Hooks
  // ========================================================================

  /** 一次 run loop 开始（首次运行或 resume） */
  BEFORE_RUN: "workflow:before.run",

  /**
   * 一次 run 进入终态后触发。
   *
   * 与 `TaskHookPoints.AFTER_COMPLETE` 同理：比「每次状态变更」语义更精确，
   * 仅在 run 结束时触发一次。终态包括 completed / failed / stopped。
   * 具体终态看 `data.status`。
   */
  AFTER_RUN: "workflow:after.run",

  // ========================================================================
  // Node-level Hooks
  // ========================================================================

  /** 节点即将执行（已 publish node.started） */
  BEFORE_NODE: "workflow:before.node",

  /**
   * 节点执行结束（成功或失败都触发）。
   * 成功/失败看 `data.status`，失败详情看 `data.error`。
   */
  AFTER_NODE: "workflow:after.node",
} as const;

/**
 * Workflow Hook 点类型
 */
export type WorkflowHookPoint = typeof WorkflowHookPoints[keyof typeof WorkflowHookPoints];

/**
 * run 级 Hook 的载荷
 *
 * 全部字段都是可序列化的标量/对象，便于插件直接渲染成通知卡片，
 * 不需要再回查 engine 内部状态。
 */
export interface WorkflowRunHookData {
  /** run 标识（== sessionId，见 Task #1837） */
  runId: string;
  /** workflow session id */
  sessionId: string;
  /** workflow 定义 id */
  workflowId: string;
  /** workflow 名称（人可读，用于卡片标题） */
  workflowName: string;
  /** 当前 run 状态 */
  status: RunStatus;
  /** 触发输入（before.run 时提供） */
  input?: unknown;
  /** 最终输出（after.run 且成功时提供） */
  output?: unknown;
  /** 失败原因（after.run 且 failed 时提供） */
  error?: string;
  /** 停止原因（after.run 且 stopped 时提供） */
  stopReason?: string;
  /** run 耗时（after.run 时提供） */
  durationMs?: number;
  /** DAG 中的节点总数 —— 供插件算进度百分比的分母 */
  totalNodes?: number;
  /** 已产出结果的节点数 —— 进度分子 */
  completedNodes?: number;
  /**
   * pause 语义：`workflow:after.run` 不会因 pause 触发（pause 不是终态），
   * 需要感知 pause 请订阅内部事件或后续按需扩展 hook 点。
   */
}

/**
 * node 级 Hook 的载荷
 */
export interface WorkflowNodeHookData {
  /** run 标识 */
  runId: string;
  /** workflow session id */
  sessionId: string;
  /** workflow 名称 */
  workflowName: string;
  /** 节点 id（DAG 内唯一） */
  nodeId: string;
  /** 节点类型（agent / tool / condition / ...） */
  nodeType: string;
  /** 节点状态 */
  status: NodeStatus;
  /** 节点输入 */
  input?: unknown;
  /** 节点输出（after.node 且成功时提供） */
  output?: unknown;
  /** 失败原因（after.node 且 failed 时提供） */
  error?: string;
  /** 该节点耗时 */
  durationMs?: number;
  /** DAG 中的节点总数 */
  totalNodes?: number;
  /** 已产出结果的节点数 */
  completedNodes?: number;
  /**
   * 该节点绑定的 agent 子 session id（agent 类节点才有）。
   * 便于插件在卡片里给出「点进去看这个子会话」的线索。
   */
  agentSessionId?: string;
}

/**
 * 触发一个 workflow run 级 Hook。
 *
 * ⚠️ 传给 hook 的是什么（实测确认，别再踩）：
 *   `globalHookManager.execute(point, data, metadata)` 会把 `data` 包进 `HookContext`
 *   再交给 hook —— 即 **hook 收到的第 1 个参数是 `ctx`，载荷在 `ctx.data`**。
 *
 *   （`TaskComponent.executeHook` 注释里的「直接传 data 而非包一层 ctx」指的是
 *    不要把 data 再套一层自定义 ctx，而不是 hook 能直接收到 data。
 *    第一版单测就是因为 hook 里读了 `ctx.status` 而不是 `ctx.data.status` 而误判
 *    「after.run 没触发」，浪费了一轮排查。）
 *
 * 错误隔离：HookManager 内部 `safeExecute` 会吞掉 hook 抛出的异常并记日志，
 * 因此插件故障不会中断 workflow 运行。
 */
export async function emitWorkflowRunHook(
  hookPoint: WorkflowHookPoint,
  data: WorkflowRunHookData,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await globalHookManager.execute(hookPoint, data, {
    sourceId: "workflow",
    runId: data.runId,
    workflowName: data.workflowName,
    ...metadata,
  });
}

/**
 * 触发一个 workflow node 级 Hook。语义同 {@link emitWorkflowRunHook}。
 */
export async function emitWorkflowNodeHook(
  hookPoint: WorkflowHookPoint,
  data: WorkflowNodeHookData,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await globalHookManager.execute(hookPoint, data, {
    sourceId: "workflow",
    runId: data.runId,
    workflowName: data.workflowName,
    nodeId: data.nodeId,
    ...metadata,
  });
}

/**
 * HookManager 挂链自检：返回当前已注册的 workflow hook 点（含注册数量）。
 *
 * 供插件/诊断命令确认「我的 hook 到底挂上没有」—— 在 notify 插件静默失效时
 * 这是第一个要查的问题。
 */
export function getRegisteredWorkflowHookPoints(): Array<{ hookPoint: string; count: number }> {
  return Object.values(WorkflowHookPoints).map((hookPoint) => ({
    hookPoint,
    count: globalHookManager.count(hookPoint),
  }));
}
