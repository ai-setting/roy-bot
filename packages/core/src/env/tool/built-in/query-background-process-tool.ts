/**
 * @fileoverview query_background_process — Default Agent 后台进程查询工具
 *
 * 目的：
 * - 让 default 接待员 agent 可以查询由 `delegate_task` 启动的后台子进程当前状态
 * - 解决"通知丢失"或"怀疑卡住"时无法判断后台任务真实状态的问题
 *
 * 可见性：
 * - `metadata.allowedAgentTypes: ["default"]` — 只对 default agent 可见
 * - 其他 agent（roy / strict-task-agent / explore 等）看不到这个工具
 * - 不需要这个工具的原因是：subagent 自己不会被委托任务，所以也不会去查后台进程
 *
 * 注入方式（2026-07 重构）：
 * - 使用 `createQueryBackgroundProcessTool(manager)` 工厂函数闭包注入
 * - 每个 Environment/TaskComponent 持有一个独立的 BackgroundTaskManager 引用
 * - TaskComponent.start() 创建 manager-bound tool 并注册到 ToolComponent
 * - 多个 Environment 拥有独立的 manager，不会互相覆盖（修复多 Environment 互相 reset 问题）
 *
 * Session ownership（2026-07 新增）：
 * - 工具会校验 ctx.session_id 与 task.parentSessionId 一致
 * - 不匹配 → 返回 status='not_found'（不暴露存在性）
 * - 防止 session A 拿 bgProcessId 偷看 session B 的后台任务
 *
 * 输入：
 * - bgProcessId: string  — delegate_task 返回的 background process ID
 *
 * 输出（JSON 字符串）：
 * {
 *   alive: boolean,
 *   status: 'running' | 'pending' | 'completed' | 'failed' | 'stopped' | 'timeout' | 'not_found',
 *   createdAt: number,        // 启动时间戳
 *   lastUpdatedAt: number,    // 最后状态更新时间戳
 *   description?: string,     // 任务描述
 *   result?: any,             // 已完成时返回
 *   error?: string,           // 失败时返回
 * }
 *
 * 失败行为：
 * - manager 未注入 → success=false, error="not initialized"
 * - 参数校验失败 → throw (zod)
 * - 任务不存在 → success=true, status='not_found'（正常查询结果，不是错误）
 */

import { z } from "zod";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { BackgroundTaskManager, BackgroundTask } from "../../task/delegate/delegate-tool";

// ============================================================================
// Schema
// ============================================================================

/**
 * 入参 schema
 */
const QueryBackgroundProcessParameters = z.object({
  bgProcessId: z
    .string()
    .min(1, "bgProcessId must not be empty")
    .describe(
      "The background process ID returned by delegate_task " +
      "(format: process_<timestamp>_<random>).",
    ),
});

type QueryBackgroundProcessParams = z.infer<typeof QueryBackgroundProcessParameters>;

/**
 * 输出 schema（结构化返回，序列化为 JSON 字符串）
 */
export interface QueryBackgroundProcessOutput {
  /** 是否仍在运行（pending/running 视为 alive=true） */
  alive: boolean;
  /** 当前状态 */
  status: BackgroundTask["status"] | "not_found";
  /** 启动时间戳（毫秒） */
  createdAt: number;
  /** 最后状态更新时间戳（毫秒；not_found 时为查询时刻） */
  lastUpdatedAt: number;
  /** 任务描述（not_found 时为 undefined） */
  description?: string;
  /**
   * ★ Task #4720：sub-session 当前已落盘的消息条数。
   * 仅在任务仍 alive 且能读到 sub-session 时提供；用于判断「真的在产出」。
   */
  messageCount?: number;
  /**
   * ★ Task #4720：sub-session 的最后更新时间戳（毫秒）。
   * 每轮 ReAct 迭代都会推进（配合增量落盘），是比 20 分钟心跳更细的活跃度信号。
   */
  subSessionUpdatedAt?: number;
  /** 已完成 / 失败 / 停止时的结果 */
  result?: string;
  /** 失败时的错误信息 */
  error?: string;
}

// ============================================================================
// Pure function — convert BackgroundTask → QueryBackgroundProcessOutput
// ============================================================================

/**
 * 将 BackgroundTask 转成工具输出。
 *
 * - alive: status === 'pending' || 'running' → true；其余 → false
 * - lastUpdatedAt: task.lastUpdatedAt，兼容旧任务时 fallback 到 completedAt/startedAt/createdAt
 * - description: 总是透传（agent 需要知道是哪个任务）
 *
 * 提取为纯函数便于单元测试。
 */
export function backgroundTaskToOutput(
  task: BackgroundTask,
): QueryBackgroundProcessOutput {
  return {
    alive: task.status === "pending" || task.status === "running",
    status: task.status,
    createdAt: task.createdAt,
    lastUpdatedAt:
      task.lastUpdatedAt ?? task.completedAt ?? task.startedAt ?? task.createdAt,
    description: task.description,
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
  };
}

/**
 * not_found 状态的输出
 */
export function notFoundOutput(bgProcessId: string): QueryBackgroundProcessOutput {
  const now = Date.now();
  return {
    alive: false,
    status: "not_found",
    createdAt: now,
    lastUpdatedAt: now,
    description: `No background process found with id '${bgProcessId}'.`,
  };
}

// ============================================================================
// Tool definition
// ============================================================================

/**
 * query_background_process 工具的"无 manager"实例。
 *
 * 历史：这个 named export 原本是 module-global 单例，所有 agent 共享一个 manager 引用。
 * 重构后（2026-07）：
 * - 实际注入的 manager 通过 `createQueryBackgroundProcessTool(manager)` 工厂绑定
 * - 此 named export 仍存在以保持向后兼容（getAllBuiltInTools / 旧测试代码会引用），
 *   但它绑定的是 null manager → 执行时会返回 "not initialized" 错误
 * - TaskComponent.start() 会用 `createQueryBackgroundProcessTool(manager)` 重新注册
 *   真正的实例到 ToolComponent，覆盖此 no-manager 版本
 *
 * 用法示例（推荐）：
 * ```ts
 * const tool = createQueryBackgroundProcessTool(manager);
 * toolComponent.register(tool);
 * ```
 */
export const queryBackgroundProcessTool: Tool = {
  name: "query_background_process",
  description:
    "Query the status of a background process previously launched via delegate_task.\n\n" +
    "Use this tool when:\n" +
    "  - You delegated a long-running task but have NOT received any notification after a reasonable wait (5+ minutes), and want to confirm whether the process is still alive.\n" +
    "  - The user asks about the progress of a delegated task and you need a current snapshot.\n" +
    "  - You suspect a delegated task got stuck (no progress messages, no completion notification).\n\n" +
    "DO NOT poll this tool on every turn — it is meant for diagnostic checks at a reasonable cadence (e.g. every few minutes, or when you genuinely suspect the task is stuck).\n\n" +
    "Returns a JSON object with:\n" +
    "  - alive: boolean — true if status is 'pending' or 'running'\n" +
    "  - status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'timeout' | 'not_found'\n" +
    "  - createdAt, lastUpdatedAt: timestamps (ms)\n" +
    "  - description: the task description you passed to delegate_task\n" +
    "  - result: present when status is 'completed'\n" +
    "  - error: present when status is 'failed'\n\n" +
    "Only the default receptionist agent has this tool. Sub-agents (roy, strict-task-agent, etc.) cannot see it because they do not need to query background tasks they themselves launched.",
  parameters: QueryBackgroundProcessParameters,
  permission: {
    level: "safe",
    requireConfirmation: false,
  },
  metadata: {
    category: "task",
    tags: ["background", "delegate", "query", "status", "diagnostic"],
    version: "1.0.0",
    /**
     * 只对 default 接待员 agent 可见。
     * - undefined/空数组 视为对所有 agent 可见
     * - 这里明确指定 ["default"]，让其他 agent（roy/strict-task-agent/explore/...）看不到
     */
    allowedAgentTypes: ["default"],
  },
  // 注意：此 named export 默认绑定 null manager。
  // 真实使用由 `createQueryBackgroundProcessTool(manager)` 工厂生成 manager-bound 实例。
  // 此处 execute 永远会因 "not initialized" 失败。
  // （保留此 named export 是为了 getAllBuiltInTools / 老测试代码不报错。）
  execute: async (
    args: unknown,
    ctx: ToolContext,
  ): Promise<ToolResult> =>
    createQueryBackgroundProcessTool(null).execute(args, ctx),
};

/**
 * 工厂函数 — 创建 manager-bound 工具实例（2026-07 重构新增）
 *
 * 为什么需要工厂：
 * - 旧模式（setter 全局变量）导致多 Environment/TaskComponent 实例互相覆盖 manager
 * - 工厂函数将 manager 闭包到工具内部，每个 TaskComponent 创建独立的 tool 实例
 * - TaskComponent.start() 负责调用此工厂并把生成的 tool 注册到 ToolComponent
 *
 * 行为契约：
 * - manager 有效（getTask 函数存在）→ 正常查询
 * - manager 为 null/undefined → 返回 success=false, error="not initialized"
 * - 任务存在但 ctx.session_id 与 task.parentSessionId 不匹配 → 返回 not_found
 *   （防止跨 session 数据泄露；不暴露存在性）
 *
 * @param manager BackgroundTaskManager 实例；传入 null/undefined 表示未注入
 * @returns 新的 Tool 实例
 */
export function createQueryBackgroundProcessTool(
  manager: BackgroundTaskManager | null = null,
): Tool {
  return {
    name: "query_background_process",
    description:
      "Query the status of a background process previously launched via delegate_task.\n\n" +
      "Use this tool when:\n" +
      "  - You delegated a long-running task but have NOT received any notification after a reasonable wait (5+ minutes), and want to confirm whether the process is still alive.\n" +
      "  - The user asks about the progress of a delegated task and you need a current snapshot.\n" +
      "  - You suspect a delegated task got stuck (no progress messages, no completion notification).\n\n" +
      "DO NOT poll this tool on every turn — it is meant for diagnostic checks at a reasonable cadence (e.g. every few minutes, or when you genuinely suspect the task is stuck).\n\n" +
      "Returns a JSON object with:\n" +
      "  - alive: boolean — true if status is 'pending' or 'running'\n" +
      "  - status: 'pending' | 'running' | 'completed' | 'failed' | 'stopped' | 'timeout' | 'not_found'\n" +
      "  - createdAt, lastUpdatedAt: timestamps (ms)\n" +
      "  - description: the task description you passed to delegate_task\n" +
      "  - result: present when status is 'completed'\n" +
      "  - error: present when status is 'failed'\n\n" +
      "Only the default receptionist agent has this tool. Sub-agents (roy, strict-task-agent, etc.) cannot see it because they do not need to query background tasks they themselves launched.",
    parameters: QueryBackgroundProcessParameters,
    permission: {
      level: "safe",
      requireConfirmation: false,
    },
    metadata: {
      category: "task",
      tags: ["background", "delegate", "query", "status", "diagnostic"],
      version: "1.0.0",
      /**
       * 只对 default 接待员 agent 可见。
       * - undefined/空数组 视为对所有 agent 可见
       * - 这里明确指定 ["default"]，让其他 agent（roy/strict-task-agent/explore/...）看不到
       */
      allowedAgentTypes: ["default"],
    },
    execute: async (
      args: unknown,
      ctx: ToolContext,
    ): Promise<ToolResult> => {
      const startTime = Date.now();

      // 1. 参数校验（zod 抛错会让 ToolComponent 捕获为工具执行错误）
      const params = QueryBackgroundProcessParameters.parse(
        args,
      ) as QueryBackgroundProcessParams;
      const { bgProcessId } = params;

      // 2. manager 可用性检查
      if (!manager) {
        return {
          success: false,
          output: "",
          error:
            "query_background_process is not initialized: no BackgroundTaskManager " +
            "has been bound. TaskComponent should call " +
            "createQueryBackgroundProcessTool(manager) and register the tool " +
            "during startup.",
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      }

      // 3. 查询任务（BackgroundTaskManager.getTask 返回克隆，无副作用）
      let task: BackgroundTask | undefined;
      try {
        task = manager.getTask(bgProcessId);
      } catch (err) {
        return {
          success: false,
          output: "",
          error: `failed to query background task: ${(err as Error).message}`,
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      }

      // 4. Session ownership 校验（2026-07 新增，防止跨 session 数据泄露）
      //    如果 ctx.session_id 与 task.parentSessionId 不一致，返回 not_found
      //    （不暴露任务真实存在性）
      if (task) {
        const currentSessionId = ctx.session_id;
        if (!currentSessionId || task.parentSessionId !== currentSessionId) {
          return {
            success: true,
            output: JSON.stringify(notFoundOutput(bgProcessId), null, 2),
            metadata: {
              execution_time_ms: Date.now() - startTime,
              bgProcessId,
              status: "not_found",
              alive: false,
            },
          };
        }
      }

      // 5. 构造输出
      const output: QueryBackgroundProcessOutput = task
        ? backgroundTaskToOutput(task)
        : notFoundOutput(bgProcessId);

      // 6. ★ Task #4720 Fix B — alive 任务补充 sub-session 实时活跃度
      //    task.lastUpdatedAt 由 20 分钟一次的心跳刷新（Task #4888 回滚），
      //    无法区分「sub-agent 正在疯狂跑工具」和「sub-agent 卡死」。
      //    Fix A 已让 sub-session 每轮 ReAct 增量落盘，因此读
      //    messageCount / updatedAt 即可得到真实的 liveness 信号。
      //    任何失败（API 不存在 / session store 异常）都静默退化为旧行为。
      if (output.alive) {
        try {
          const activity = await manager.getSubSessionActivity?.(bgProcessId);
          if (activity) {
            output.lastUpdatedAt = Math.max(
              output.lastUpdatedAt,
              activity.updatedAt,
            );
            output.messageCount = activity.messageCount;
            output.subSessionUpdatedAt = activity.updatedAt;
          }
        } catch {
          // 拿不到活动信息 → 退化为旧行为（不报错，不阻塞查询）
        }
      }

      return {
        success: true,
        output: JSON.stringify(output, null, 2),
        metadata: {
          execution_time_ms: Date.now() - startTime,
          bgProcessId,
          status: output.status,
          alive: output.alive,
        },
      };
    },
  };
}