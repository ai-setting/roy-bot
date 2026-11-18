/**
 * @fileoverview Operation List Tool (Task #2211: milestone_* + action_* 兼容)
 */

import type { Tool, ToolContext, ToolResult } from "../../../tool/types";
import { ListOperationsToolSchema, type ListOperationsToolParams } from "./operation-types";
import type { TaskComponent } from "../../task-component";

export function listOperationsTool(taskComponent: TaskComponent): Tool {
  return {
    name: "task_operation_list",
    description:
      "List operation records for a task with optional filters. " +
      "Use milestone_type (canonical) or action_type (deprecated, auto-mapped).",
    parameters: ListOperationsToolSchema,
    execute: async (args: unknown, ctx: ToolContext): Promise<ToolResult> => {
      const parsed = ListOperationsToolSchema.parse(args) as unknown as ListOperationsToolParams;

      try {
        const operations = await taskComponent.listOperations({
          taskId: parsed.task_id,
          milestoneType: parsed.milestone_type as any,
          limit: parsed.limit,
          offset: parsed.offset,
        });

        let output = JSON.stringify({ operations, count: operations.length });
        if (parsed._deprecated_fields_used.length > 0) {
          output =
            `⚠️  DEPRECATION NOTICE: 你使用了旧的 action_type 字段，已自动映射到 milestone_type。\n\n` +
            output;
        }

        return {
          success: true,
          output,
          metadata: {
            execution_time_ms: 0,
            deprecated_fields_used: parsed._deprecated_fields_used,
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
