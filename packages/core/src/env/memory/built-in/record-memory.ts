// packages/core/src/env/memory/built-in/record-memory.ts

/**
 * @fileoverview record_memory Tool
 * 
 * 统一的记忆记录工具
 */

import type { Tool, ToolContext, ToolResult } from "../../tool/types";
import { z } from "zod";
import type { MemoryPath, RecordMemoryResult } from "../types";

/**
 * record_memory 工具参数
 */
export const RecordMemorySchema = z.object({
  /** 作用域 (必填) */
  scope: z.enum(["project", "global"]).describe("作用域: project/global"),
  
  /** 操作模式 */
  mode: z.enum(["append", "prepend", "overwrite", "delete"])
    .describe("模式: append(追加)/prepend(插入)/overwrite(覆盖)/delete(删除)"),
  
  /** 记忆内容 (delete 模式不需要) */
  content: z.string().optional().describe("记忆内容"),
  
  /** 章节标题 (可选，用于生成 ## title 章节) */
  title: z.string().optional().describe("章节标题"),
});

export type RecordMemoryParams = z.infer<typeof RecordMemorySchema>;

export interface RecordMemoryOptions {
  scope: "project" | "global";
  mode: "append" | "prepend" | "overwrite" | "delete";
  content?: string;
  title?: string;
}

/**
 * 创建 record_memory 工具
 */
export function createRecordMemoryTool(
  recordMemory: (args: RecordMemoryOptions) => Promise<RecordMemoryResult | null>,
  getMemoryPaths: () => MemoryPath[],
  getMemoryFile: () => string
): Tool {
  return {
    name: "record_memory",
    description: buildDescription(getMemoryPaths, getMemoryFile),
    parameters: RecordMemorySchema,
    execute: async (args: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      const params = RecordMemorySchema.parse(args);
      const startTime = Date.now();

      try {
        const result = await recordMemory({
          scope: params.scope,
          mode: params.mode,
          content: params.content,
          title: params.title,
        });

        if (!result) {
          return {
            success: false,
            output: "",
            error: "未配置 memory 路径，无法记录记忆",
            metadata: { execution_time_ms: Date.now() - startTime },
          };
        }

        const actionMessages: Record<string, string> = {
          created: "已创建记忆文件",
          overwrite: "已覆盖记忆文件",
          append: "已追加内容到记忆文件",
          prepend: "已插入内容到记忆文件开头",
          delete: "已删除记忆文件",
        };

        return {
          success: true,
          output: `${actionMessages[result.action]}: ${result.path}`,
          metadata: {
            execution_time_ms: Date.now() - startTime,
            path: result.path,
            action: result.action,
          },
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
    `# Record Memory Tool`,
    "",
    `Record memory to file. Writes to the memory.md file in the specified scope.`,
    "",
    `## Modes`,
    "",
    "| Mode | Description |",
    "|------|-------------|",
    "| **append** | 追加内容到 ${memoryFile} 尾部 |",
    "| **prepend** | 插入内容到 ${memoryFile} 开头 |",
    "| **overwrite** | 覆盖 ${memoryFile} |",
    "| **delete** | 删除 ${memoryFile} |",
    "",
    `## Parameters`,
    "",
    "- **scope** (required): 作用域 - project 或 global",
    "- **mode** (required): 操作模式",
    "- **content** (optional): 记忆内容",
    "- **title** (optional): 章节标题",
    "",
    `## Memory Paths`,
    "",
  ];

  if (paths.length === 0) {
    lines.push("No memory paths configured.");
  } else {
    lines.push("Files will be written to:");
    for (const p of paths) {
      lines.push(`- **[${p.type}]** ${p.path}/${memoryFile}`);
    }
  }

  return lines.join("\n");
}

// Re-export for external use
export { RecordMemorySchema as UnifiedRecordMemorySchema };
export type { RecordMemoryParams as UnifiedRecordMemoryParams };
