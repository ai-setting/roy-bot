/**
 * @fileoverview Task Update Tool
 */

import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { UpdateTaskToolSchema, type UpdateTaskToolParams } from "./task-types";
import type { TaskComponent } from "../task-component";
import { setCurrentTaskId } from "../../context/env-context";
import { createLogger } from "../../log-trace/logger";

const logger = createLogger("tool:update-task");

/**
 * 检测设置 parent_task_id 是否会产生循环引用。
 * 从 newParentId 向上追溯父链，如果回到 taskId 则说明会产生循环。
 * 使用 visited Set 防止因数据损坏导致无限循环。
 */
async function detectCycle(
  taskComponent: TaskComponent,
  taskId: number,
  newParentId: number
): Promise<boolean> {
  const visited = new Set<number>();
  let currentId: number | null | undefined = newParentId;

  while (currentId !== null && currentId !== undefined) {
    if (currentId === taskId) return true; // 循环检测命中

    // 防数据损坏导致的无限循环
    if (visited.has(currentId)) break;
    visited.add(currentId);

    const currentTask = await taskComponent.getTask(currentId);
    if (!currentTask) break; // 父任务不存在，视为无循环
    currentId = currentTask.parent_task_id;
  }

  return false;
}

export function updateTaskTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_update",
    description: "Update an existing task's properties. Status and progress changes will create operation records.",
    parameters: UpdateTaskToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const params = UpdateTaskToolSchema.parse(args) as UpdateTaskToolParams;
      const sessionId = ctx.session_id || "unknown";

      try {
        // 循环引用检测：设置 parent_task_id 为非 null 值时，检查是否会产生循环
        if (params.parent_task_id !== undefined && params.parent_task_id !== null) {
          const hasCycle = await detectCycle(taskComponent, params.task_id, params.parent_task_id);
          if (hasCycle) {
            return {
              success: false,
              output: "",
              error: `Circular reference detected: setting parent_task_id to ${params.parent_task_id} for task #${params.task_id} would create a cycle`,
              metadata: { execution_time_ms: 0 },
            };
          }
        }

        // ★ Task #5007 — 验收权分离的强制关卡（不能只靠 prompt 约束）。
        //
        // 背景：task_complete 从 roy sub-agent 移交 default agent 后，
        // 若执行方仍能通过 task_update(status="completed") 把任务置终态，
        // 就等于绕过了验收 —— 裁判与运动员又变回同一人。
        // （Task #5073 设计调整②：updateTask 已不再 fire AFTER_COMPLETE，
        // goal 判定只在 preCompleteTask 自查关跑，这里只是权限关卡。）
        //
        // 判据（精确，不误伤）：
        //   调用方是 **sub 类型 agent**，**且** 它本身没有 task_complete 权限
        //   （即 deniedTools 里含 task_complete，或 allowedTools 白名单里没有它）
        //   ⇒ 拒绝 status="completed"。
        //
        // 为什么不只看 `agentType === "sub"`：
        //   `task-organizer` 也是 type="sub"，但它**被明确授权**做任务树整理
        //   （allowedTools 含 task_complete），一刀切会把它废掉。
        //   workflow 的 Verify agent（type="workflow"）同理需要 task_complete。
        //
        // 其他终态（cancelled / failed / timeout）不受限 —— 那些不是"验收通过"。
        // progress=100 也不受限 —— 那正是执行方正当的收尾方式。
        const callerAgentType =
          (ctx.metadata?.agentType as string | undefined) ?? undefined;
        const callerAgentName =
          (ctx.metadata?.agentName as string | undefined) ?? undefined;
        if (params.status === "completed" && callerAgentType === "sub") {
          const agentComponent = (taskComponent as any).env?.getComponent?.("agent");
          const callerAgent =
            callerAgentName && agentComponent?.getAgent
              ? agentComponent.getAgent(callerAgentName)
              : undefined;
          const cfg = callerAgent?.config;
          // ★ default-deny（review r3 MAJOR）：解析不到身份 ⇒ 一律视为「无验收权」。
          //   旧写法在 cfg === undefined 时第二项求值为 `true && true` ⇒ 放行，
          //   方向反了（「查不到身份」被当成「有权限」）。这里显式先判 cfg。
          const hasCompletePermission = cfg
            ? // 白名单模式：必须在白名单里
              (Array.isArray(cfg.allowedTools) &&
                cfg.allowedTools.includes("task_complete")) ||
              // 黑名单模式：不在黑名单里即有权
              (!Array.isArray(cfg.allowedTools) &&
                !(Array.isArray(cfg.deniedTools) &&
                  cfg.deniedTools.includes("task_complete")))
            : false;

          if (!hasCompletePermission) {
            return {
              success: false,
              output: "",
              error:
                `Cannot set status="completed" without acceptance permission (Task #5007 — 验收权分离). ` +
                `执行方只能推进进度：用 task_update(progress=100) 表示"我这边干完了"，` +
                `再 task_operation_create 记录结论，然后结束返回；` +
                `任务终态必须由验收方（default agent / 主智能体）调用 task_complete 落定。`,
              metadata: { execution_time_ms: 0 },
            };
          }
        }

        const task = await taskComponent.updateTask(params.task_id, {
          title: params.title,
          description: params.description,
          status: params.status,
          priority: params.priority,
          type: params.type,
          progress: params.progress,
          current_status: params.current_status,
          goals_and_expected_deliverables: params.goals_and_expected_deliverables,
          due_date: params.due_date,
          tags: params.tags,
          project_path: params.project_path,
          context: params.context,
          parent_task_id: params.parent_task_id,
          // Task #5440 — 负责人（省略 = 不改；null/"" = 清空）
          owner: params.owner,
        });

        if (!task) {
          return {
            success: false,
            output: "",
            error: `Task not found: ${params.task_id}`,
            metadata: { execution_time_ms: 0 },
          };
        }

        // Create operation record for status/progress changes
        if (params.status || params.progress !== undefined || params.current_status) {
          await taskComponent.createOperation({
            taskId: params.task_id,
            sessionId,
            actionType: "progress",
            actionTitle: params.current_status || `Updated: ${params.status || `${params.progress}%`}`,
            actionDescription: JSON.stringify({
              status: params.status,
              progress: params.progress,
              current_status: params.current_status,
            }),
          });
        }

        // Set currentTaskId in EnvContext for LLM awareness (same as create-tool)
        setCurrentTaskId(task.id);
        logger.info(`[updateTask] Trace: Task #${task.id} updated, currentTaskId=${task.id} set in EnvContext`);

        return {
          success: true,
          output: `Task updated: #${task.id} - ${task.title}`,
          metadata: { execution_time_ms: 0, task },
        };
      } catch (error) {
        return {
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
          metadata: { execution_time_ms: 0 },
        };
      }
    },
  };
}
