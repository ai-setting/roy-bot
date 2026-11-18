/**
 * @fileoverview Operation Update Tool (Task #2211: milestone_* + action_* 兼容)
 */

import { ZodError } from "zod";
import type { Tool, ToolContext, ToolResult } from "../../../tool/types";
import { UpdateOperationToolSchema, type UpdateOperationToolParams } from "./operation-types";
import type { TaskComponent } from "../../task-component";

function formatZodError(err: ZodError): string {
  const parts = err.issues.map(
    (i) => `${i.path.join(".") || "<root>"}: ${i.message}`
  );
  return `Invalid parameters: ${parts.join("; ")}`;
}

export function updateOperationTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_operation_update",
    description:
      "Update an operation record. Use milestone_title / milestone_description (canonical) " +
      "or action_title / action_description (deprecated, auto-mapped). " +
      "process_description captures the process (100-500 chars).",
    parameters: UpdateOperationToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      let params: UpdateOperationToolParams;
      try {
        const parsed = UpdateOperationToolSchema.parse(args);
        params = parsed as unknown as UpdateOperationToolParams;
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

      try {
        const operation = await taskComponent.updateOperation(params.operation_id, {
          milestoneTitle: params.milestone_title,
          milestoneDescription: params.milestone_description,
          processDescription: params.process_description,
        });

        if (!operation) {
          return {
            success: false,
            output: "",
            error: `Operation not found: ${params.operation_id}`,
            metadata: { execution_time_ms: 0 },
          };
        }

        let output = `Operation updated: #${operation.id}`;
        if (params._deprecated_fields_used.length > 0) {
          output +=
            `\n\n⚠️  DEPRECATION NOTICE: 你使用了旧的 action_* 字段 (${params._deprecated_fields_used.join(", ")})，已自动映射到 milestone_* 字段。` +
            "请尽快迁移到 milestone_* 字段。";
        }

        return {
          success: true,
          output,
          metadata: {
            execution_time_ms: 0,
            operation,
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
