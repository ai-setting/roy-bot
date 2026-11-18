/**
 * @fileoverview Operation Create Tool (Task #2211: milestone_* 主字段 + action_* 兼容)
 *
 * 双维度：
 * - milestone_* 三字段描述达成的状态/里程碑
 * - process_description 描述达成过程（100-500 字符硬约束，Task #4764 放宽）
 *
 * 兼容：action_* 自动映射到 milestone_* 并通过返回 _deprecated_warning 提示。
 */

import { ZodError } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../../tool/types";
import { CreateOperationToolSchema, type CreateOperationToolParams } from "./operation-types";
import type { TaskComponent } from "../../task-component";

/**
 * 把 Zod 校验失败转换为对 Agent 友好的错误字符串（保留自定义 message）
 */
function formatZodError(err: ZodError): string {
  const parts = err.issues.map(
    (i) => `${i.path.join(".") || "<root>"}: ${i.message}`
  );
  return `Invalid parameters: ${parts.join("; ")}`;
}

/**
 * Validate that milestone_type and milestone_title are present after preprocess/transform.
 * (The transform doesn't enforce this — we keep it explicit for clearer error messages.)
 */
function ensureRequiredMilestoneFields(
  params: CreateOperationToolParams
): { ok: true; milestoneType: string; milestoneTitle: string } | { ok: false; error: string } {
  if (!params.milestone_type) {
    return {
      ok: false,
      error:
        "milestone_type is required (or action_type for backward compatibility). " +
        "Use one of: create, progress, milestone, problem, solution, decision, review, completed, workflow_extracted.",
    };
  }
  if (!params.milestone_title) {
    return {
      ok: false,
      error: "milestone_title is required (or action_title for backward compatibility).",
    };
  }
  return { ok: true, milestoneType: params.milestone_type, milestoneTitle: params.milestone_title };
}

export function createOperationTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_operation_create",
    description:
      "Create an operation record for a task. Tracks milestones (state/result) and process (strategy + tool steps). " +
      "Dual-dimension schema: milestone_type/title/description captures WHAT milestone was reached; " +
      "process_description (100-500 chars) captures HOW. " +
      "Legacy action_* fields are accepted as deprecated aliases.",
    parameters: CreateOperationToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      let params: CreateOperationToolParams;
      try {
        // Zod transform returns the transformed object directly; cast to our type.
        const parsed = CreateOperationToolSchema.parse(args);
        params = parsed as unknown as CreateOperationToolParams;
      } catch (e) {
        if (e instanceof ZodError) {
          return {
            success: false,
            output: "",
            error: formatZodError(e),
            metadata: { execution_time_ms: 0 },
          };
        }
        throw e;
      }

      const check = ensureRequiredMilestoneFields(params);
      if (!check.ok) {
        return {
          success: false,
          output: "",
          error: check.error,
          metadata: { execution_time_ms: 0 },
        };
      }

      const sessionId = ctx.session_id || "unknown";

      try {
        const operation = await taskComponent.createOperation({
          taskId: params.task_id,
          sessionId,
          milestoneType: check.milestoneType as any,
          milestoneTitle: check.milestoneTitle,
          milestoneDescription: params.milestone_description,
          processDescription: params.process_description,
          mdPath: params.md_path,
        });

        let output = `Operation created: #${operation.id} for task #${operation.taskId} ` +
          `[milestone=${operation.milestoneType}] ${operation.milestoneTitle}`;

        const deprecationWarnings: string[] = [];
        if (params._deprecated_fields_used.length > 0) {
          deprecationWarnings.push(
            `⚠️  DEPRECATION NOTICE: 你使用了旧的 action_* 字段 (${params._deprecated_fields_used.join(", ")})，已自动映射到 milestone_* 字段。` +
              "请尽快迁移到 milestone_type / milestone_title / milestone_description 主字段。"
          );
        }
        if (deprecationWarnings.length > 0) {
          output += "\n\n" + deprecationWarnings.join("\n");
        }

        return {
          success: true,
          output,
          metadata: {
            execution_time_ms: 0,
            operation_id: operation.id,
            task_id: operation.taskId,
            session_id: operation.sessionId,
            deprecated_fields_used: params._deprecated_fields_used,
          },
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
