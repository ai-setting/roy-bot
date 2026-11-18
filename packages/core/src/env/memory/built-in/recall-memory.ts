/**
 * @fileoverview recall_memory Tool
 * 
 * 统一的记忆读取工具
 */

import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { z } from "zod";
import type { MemoryPath } from "../types";

/**
 * recall_memory 工具参数
 */
export const RecallMemorySchema = z.object({
  /** 作用域 (可选，不传则读取所有 scope) */
  scope: z.enum(["project", "global"]).optional().describe("作用域（可选，不传则读取所有）"),
});

export type RecallMemoryParams = z.infer<typeof RecallMemorySchema>;

export interface RecallMemoryOptions {
  scope?: "project" | "global";
}

/**
 * 创建 recall_memory 工具
 */
export function createRecallMemoryTool(
  recallMemory: (scope?: "project" | "global") => Promise<string>,
  getMemoryPaths: () => MemoryPath[],
  getMemoryFile: () => string
): Tool {
  return {
    name: "recall_memory",
    description: buildDescription(getMemoryPaths, getMemoryFile),
    parameters: RecallMemorySchema,
    execute: async (args: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      const params = RecallMemorySchema.parse(args);
      const startTime = Date.now();

      try {
        const content = await recallMemory(params.scope);

        if (!content) {
          return {
            success: true,
            output: "(No memory files found)",
            metadata: { execution_time_ms: Date.now() - startTime },
          };
        }

        return {
          success: true,
          output: content,
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      } catch (error) {
        return {
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      }
    },
  };
}

function buildDescription(
  getMemoryPaths: () => MemoryPath[],
  getMemoryFile: () => string
): string {
  const paths = getMemoryPaths();
  const memoryFile = getMemoryFile();

  const lines = [
    `# Recall Memory Tool`,
    "",
    `Recall memory from memory files. Reads from the memory.md file in the specified scope.`,
    "",
    `## Parameters`,
    "",
    "- **scope** (optional): 作用域 - project 或 global（不传则读取所有）",
    "",
    `## Memory Files`,
    "",
  ];

  if (paths.length === 0) {
    lines.push("No memory paths configured.");
  } else {
    lines.push("Files will be read from:");
    for (const p of paths) {
      lines.push(`- **[${p.type}]** ${p.path}/${memoryFile}`);
    }
  }

  return lines.join("\n");
}

// Re-export for external use
export { RecallMemorySchema as UnifiedRecallMemorySchema };
export type { RecallMemoryParams as UnifiedRecallMemoryParams };
