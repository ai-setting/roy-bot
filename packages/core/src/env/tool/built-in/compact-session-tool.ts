/**
 * @fileoverview compact_session — Default Agent sub-session 压缩工具
 *
 * Task #4982 — 用户需求：
 *   「给 Default agent 添加一个压缩 session 的工具，遇到 sub-agent
 *   返回上下文超了的问题，可以用这个工具来压缩 sub-session，
 *   继续复用 session」
 *
 * 背景（真实踩坑）：
 *   Default agent 通过 delegate_task 委托子代理，sub-session 积累大量
 *   上下文。当 sub-agent 返回 Context threshold exceeded（如
 *   125575/120000 = 104.6%）时，default agent 只能用
 *   delegate_task(sub_session_id=...) 续跑 —— 但被污染/过长的
 *   sub-session 续跑会再次超限。本工具让 default agent 先压缩
 *   sub-session（生成 checkpoint、归档旧消息），再继续复用。
 *
 * 可见性：
 *   - metadata.allowedAgentTypes: ["default"] — 只对 default 接待员可见
 *   - 其他 agent（roy / strict-task-agent / explore 等）看不到
 *
 * 安全设计（四层）：
 *   1. deps 未注入 → success=false, error="not initialized"
 *   2. 压缩当前会话 → success=false（default agent 自毁上下文防线）
 *   3. session 不存在 / 非自己的 sub-session → status='not_found'
 *      （不暴露存在性，与 query_background_process 同一哲学）
 *   4. 后台任务 running/pending → success=false（sub-session 每轮
 *      ReAct 增量落盘（Task #4720 Fix A），与归档竞态会撕裂任务状态）
 *
 * 复用闭环：
 *   compact_session 压缩后，用
 *   delegate_task(subagentType=..., sub_session_id=<同 id>, prompt=...) 续跑。
 *
 * 注入方式（2026-11-05，与 query_background_process 同模式）：
 *   - createCompactSessionTool(manager, sessionComponent) 工厂闭包注入
 *   - TaskComponent.start() 注册 manager-bound 实例；stop() 注销为 null 版本
 *   - getAllBuiltInTools() 中的默认版本为 null-deps（执行即 not initialized）
 *
 * 输出（JSON 字符串）：
 * {
 *   status: 'compacted' | 'not_found',
 *   sessionId: string,
 *   checkpointId?: string,
 *   checkpointTitle?: string,
 *   contentLength?: number,
 *   originalMessages?: number,   // 压缩前可压缩消息数
 *   deletedMessages?: number,    // 归档条数
 *   remainingMessages?: number,  // 归档后剩余活跃消息数
 *   hintUsed?: boolean,          // phase1 hint 是否注入
 * }
 *
 * 失败行为：
 *   - manager / sessionComponent 未注入 → success=false
 *   - zod 参数校验失败 → throw（ToolComponent 捕获）
 *   - previewCompact / compact 抛错 → success=false, error=原始 message
 *   - generateCompactHint 抛错 → 容错（hint 为空串，不阻塞压缩）
 */

import { z } from "zod";
import { createLogger } from "../../log-trace/logger";
import type { Tool, ToolContext, ToolResult } from "../types";
import type { BackgroundTaskManager, BackgroundTask } from "../../task/delegate/delegate-tool";
import type { SessionComponent } from "../../session/session-component";

const logger = createLogger("compact-session-tool");

// ============================================================================
// Schema
// ============================================================================

/**
 * 入参 schema
 */
const CompactSessionParameters = z.object({
  session_id: z
    .string()
    .min(1, "session_id must not be empty")
    .describe(
      "The sub-session ID to compact (format: session_xxx or oc_xxx). " +
      "Must be a sub-session previously created via delegate_task " +
      "(the bgProcess notification reports its subSessionId).",
    ),
});

type CompactSessionParams = z.infer<typeof CompactSessionParameters>;

/**
 * 成功压缩的输出
 */
export interface CompactSessionOutput {
  status: "compacted" | "not_found";
  sessionId: string;
  checkpointId?: string;
  checkpointTitle?: string;
  contentLength?: number;
  originalMessages?: number;
  deletedMessages?: number;
  remainingMessages?: number;
  hintUsed?: boolean;
}

/**
 * not_found 输出（不暴露存在性）
 */
export function compactSessionNotFoundOutput(
  sessionId: string,
): CompactSessionOutput {
  return {
    status: "not_found",
    sessionId,
  };
}

// ============================================================================
// Pure helpers — ownership / running 判定（可单测）
// ============================================================================

/**
 * 在 manager 的任务表里查找 sub-session 归属的任务。
 *
 * - 优先按 subSessionId 反查（工具入参就是 sub-session id）
 * - 再回退 getTask（兼容直接传 bgProcessId 的误用场景）
 *
 * 返回 undefined 表示没有任何任务关联该 session。
 */
export function findTaskBySubSessionId(
  manager: Pick<BackgroundTaskManager, "getTask" | "listTasks">,
  sessionId: string,
): BackgroundTask | undefined {
  const tasks = manager.listTasks() ?? [];
  const bySubSession = tasks.find((t) => t.subSessionId === sessionId);
  if (bySubSession) return bySubSession;
  return manager.getTask(sessionId);
}

/**
 * ownership 校验：
 * 该 session 是否是「当前会话自己 delegate 出去的 sub-session」。
 *
 * 规则：task 存在 且 task.parentSessionId === ctx.session_id。
 * （delegate_tool 创建 sub-session 时把 parentSessionId 写成
 *  ctx.session_id —— 见 createTask。）
 */
export function isOwnSubSession(
  task: BackgroundTask | undefined,
  currentSessionId: string | undefined,
): boolean {
  if (!task || !currentSessionId) return false;
  return task.parentSessionId === currentSessionId;
}

/**
 * 该 session 是否属于一个仍在运行中的后台任务。
 * running/pending 的 sub-session 正在被 sub-agent 每轮增量落盘，
 * 此时归档旧消息会产生竞态（归档读到的窗口与 sub-agent 正在写的窗口冲突）。
 */
export function isTaskActive(
  task: BackgroundTask | undefined,
): boolean {
  return task?.status === "running" || task?.status === "pending";
}

// ============================================================================
// Tool definition
// ============================================================================

/**
 * 工厂函数 — 创建 deps-bound 工具实例。
 *
 * @param backgroundTaskManager BackgroundTaskManager 实例（查任务归属 / 判运行中）；
 *                             传 null 表示未注入
 * @param sessionComponent SessionComponent 实例（执行压缩）；传 null 表示未注入
 */
export function createCompactSessionTool(
  backgroundTaskManager: BackgroundTaskManager | null = null,
  sessionComponent: SessionComponent | null = null,
): Tool {
  return {
    name: "compact_session",
    description:
      "Compact (compress) a sub-agent session by summarizing its history " +
      "into a checkpoint and archiving the old messages, so the session " +
      "can be REUSED with delegate_task(sub_session_id=...) without " +
      "exceeding the context threshold.\n\n" +
      "Use this tool when:\n" +
      "  - A delegated sub-agent returned 'Context threshold exceeded' " +
      "(e.g. 125575/120000 tokens) and you want to continue the SAME " +
      "sub-session instead of losing all its progress.\n" +
      "  - A sub-session is very long and the next resume would likely " +
      "hit the context limit again.\n\n" +
      "Behavior:\n" +
      "  1. Generates a checkpoint (natural-language summary of the " +
      "conversation so far)\n" +
      "  2. Archives the old messages (they remain queryable but leave " +
      "the active context)\n" +
      "  3. Returns a JSON summary of the compaction\n\n" +
      "After compaction succeeds, resume the sub-session with:\n" +
      "  delegate_task(subagent_type=\"...\", sub_session_id=\"<same id>\", " +
      "prompt=\"continue from the checkpoint\")\n\n" +
      "Guards:\n" +
      "  - You CANNOT compact your own current session (self-destruction).\n" +
      "  - You can only compact sub-sessions YOU delegated (ownership check).\n" +
      "  - A session whose background task is still running/pending cannot " +
      "be compacted (stop_task it first to avoid corrupting live state).\n\n" +
      "Only the default receptionist agent has this tool.",
    parameters: CompactSessionParameters,
    permission: {
      level: "safe",
      requireConfirmation: false,
    },
    metadata: {
      category: "task",
      tags: ["compact", "session", "delegate", "checkpoint", "context"],
      version: "1.0.0",
      /**
       * 只对 default 接待员 agent 可见。
       * - undefined/空数组 视为对所有 agent 可见
       * - 这里明确 ["default"]，让其他 agent（roy/strict-task-agent/...）看不到
       */
      allowedAgentTypes: ["default"],
    },
    execute: async (
      args: unknown,
      ctx: ToolContext,
    ): Promise<ToolResult> => {
      const startTime = Date.now();

      // 1. 参数校验（zod 抛错 → ToolComponent 捕获为工具执行错误）
      const params = CompactSessionParameters.parse(
        args,
      ) as CompactSessionParams;
      const sessionId = params.session_id;

      // 2. deps 可用性检查
      if (!backgroundTaskManager || !sessionComponent) {
        return {
          success: false,
          output: "",
          error:
            "compact_session is not initialized: no BackgroundTaskManager " +
            "or SessionComponent has been bound. TaskComponent should call " +
            "createCompactSessionTool(manager, sessionComponent) and " +
            "register the tool during startup.",
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      }

      const currentSessionId = ctx.session_id;

      // 3. 自压缩守护：禁止压缩当前会话
      //    default agent 压缩自己 = 自毁上下文，必须直接拒绝。
      //    这条检查放在 ownership 之前 —— 即使任务表里意外存在
      //    parentSessionId === ctx.session_id 的记录也不放行。
      if (currentSessionId && sessionId === currentSessionId) {
        return {
          success: false,
          output: "",
          error:
            `Refusing to compact session '${sessionId}': it is your OWN ` +
            `current session. Compacting it would destroy your own active ` +
            `context. Only sub-sessions you delegated can be compacted.`,
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      }

      // 4. ctx.session_id 缺失 → 无法验证 ownership，拒绝
      if (!currentSessionId) {
        return {
          success: false,
          output: "",
          error:
            "compact_session requires a current session context " +
            "(ctx.session_id) to verify ownership, but none was provided.",
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      }

      // 5. ownership 校验
      //    - 任务表中查不到该 session → not_found
      //    - 查到了但 parentSessionId 不是当前会话 → not_found
      //    （不暴露存在性，与 query_background_process 同一哲学）
      const task = findTaskBySubSessionId(backgroundTaskManager, sessionId);
      if (!task || !isOwnSubSession(task, currentSessionId)) {
        logger.warn(
          "[compact_session] not_found (unknown or foreign sub-session)",
          { sessionId, currentSessionId },
        );
        return {
          success: true,
          output: JSON.stringify(
            compactSessionNotFoundOutput(sessionId),
            null,
            2,
          ),
          metadata: {
            execution_time_ms: Date.now() - startTime,
            sessionId,
            status: "not_found",
          },
        };
      }

      // 6. 运行中守护：running/pending 的 sub-session 不压缩
      //    sub-session 每轮 ReAct 增量落盘（Task #4720 Fix A），
      //    归档旧消息与增量写入竞态会撕裂任务状态。
      //    明确拒绝并指引先 stop_task。
      if (isTaskActive(task)) {
        return {
          success: false,
          output: "",
          error:
            `Cannot compact session '${sessionId}': its background task ` +
            `'${task.id}' is still ${task.status}. The sub-agent writes ` +
            `to this session every ReAct iteration; archiving messages ` +
            `now would corrupt live state. Run ` +
            `stop_task(task_id="${task.id}") first, then compact the ` +
            `session.`,
          metadata: {
            execution_time_ms: Date.now() - startTime,
            sessionId,
            bgProcessId: task.id,
            taskStatus: task.status,
          },
        };
      }

      // 7. 预检：可压缩消息数（compact() 自身要求 ≥3）
      let preview: {
        messageCountToCompact: number;
        estimatedCheckpointTokens: number;
        wouldTrigger: boolean;
      };
      try {
        preview = await sessionComponent.previewCompact(sessionId);
      } catch (err) {
        return {
          success: false,
          output: "",
          error: `failed to preview compaction for session '${sessionId}': ` +
            `${(err as Error).message}`,
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      }
      if (!preview || preview.messageCountToCompact < 3) {
        return {
          success: false,
          output: "",
          error:
            `Cannot compact session '${sessionId}': minimum 3 compactable ` +
            `messages required (found ` +
            `${preview?.messageCountToCompact ?? 0}).`,
          metadata: {
            execution_time_ms: Date.now() - startTime,
            sessionId,
            messageCountToCompact: preview?.messageCountToCompact ?? 0,
          },
        };
      }

      // 8. Phase1 hint：容错 —— 失败不阻塞（compact() 支持 scenarioHint 为空）
      let scenarioHint = "";
      try {
        scenarioHint = await sessionComponent.generateCompactHint(sessionId);
      } catch (err) {
        logger.warn(
          "[compact_session] hint generation failed, continuing with empty hint",
          { sessionId, error: (err as Error).message },
        );
        scenarioHint = "";
      }

      // 9. 执行压缩（SessionComponent.compact 抛错 → 返回 success=false）
      let compactResult: Awaited<
        ReturnType<SessionComponent["compact"]>
      >;
      try {
        compactResult = await sessionComponent.compact(sessionId, {
          scenarioHint,
        });
      } catch (err) {
        const message = (err as Error).message;
        logger.error(`[compact_session] compact failed: ${message}`, {
          sessionId,
        });
        return {
          success: false,
          output: "",
          error: `compaction failed for session '${sessionId}': ${message}`,
          metadata: {
            execution_time_ms: Date.now() - startTime,
            sessionId,
          },
        };
      }

      // 10. 发布压缩完成事件（与 CLI ContextHandlerService 同语义，
      //     让 EventHandler / UI 能感知 sub-session 已被压缩）
      try {
        // BackgroundTaskManager 持有 env 引用（constructor 注入），
        // 借它发布 context.compacted 事件 —— 工具 execute 里没有 this。
        const env = (backgroundTaskManager as any).env;
        env?.pushEnvEvent?.({
          type: "context.compacted",
          metadata: { sessionId },
          payload: {
            checkpointId: compactResult.checkpoint.id,
            messagesCompacted: compactResult.deletedMessageCount,
            scenarioHintUsed: scenarioHint.length > 0,
            source: "compact_session_tool",
          },
        });
      } catch (err) {
        // 事件发布失败不影响压缩结果
        logger.warn(
          "[compact_session] failed to push context.compacted event",
          { sessionId, error: (err as Error).message },
        );
      }

      // 11. 构造输出摘要
      const output: CompactSessionOutput = {
        status: "compacted",
        sessionId,
        checkpointId: compactResult.checkpoint.id,
        checkpointTitle: compactResult.checkpoint.title,
        contentLength: compactResult.checkpoint.content?.length ?? 0,
        originalMessages: preview.messageCountToCompact,
        deletedMessages: compactResult.deletedMessageCount,
        remainingMessages: compactResult.remainingMessageCount,
        hintUsed: scenarioHint.length > 0,
      };

      logger.info("[compact_session] session compacted", {
        sessionId,
        checkpointId: output.checkpointId,
        deletedMessages: output.deletedMessages,
        remainingMessages: output.remainingMessages,
      });

      return {
        success: true,
        output: JSON.stringify(output, null, 2),
        metadata: {
          execution_time_ms: Date.now() - startTime,
          sessionId,
          status: "compacted",
          checkpointId: output.checkpointId,
        },
      };
    },
  };
}

/**
 * compact_session 工具的"无 deps"实例。
 *
 * 历史：与 queryBackgroundProcessTool 同模式 ——
 * - 实际注入的 deps 通过 createCompactSessionTool(manager, sessionComponent)
 *   工厂绑定；TaskComponent.start() 会用它重新注册真正的实例到
 *   ToolComponent，覆盖此 no-deps 版本。
 * - 此 named export 保留用于 getAllBuiltInTools() 注册与向后兼容；
 *   它绑定 null deps → 执行时返回 "not initialized" 错误。
 */
export const compactSessionTool: Tool = createCompactSessionTool(
  null,
  null,
);
