import { z } from "zod";
import { glob as globAsync } from "glob";
import { stat } from "fs/promises";
import path from "path";
import type { Tool, ToolContext, ToolResult } from "../types";

/**
 * Glob 工具
 * 文件模式匹配搜索
 */
export const globTool: Tool = {
  name: "glob",
  description: "Search for files matching a glob pattern. Use this to find files by name patterns like **/*.ts or **/*.md.",
  parameters: z.object({
    pattern: z.string().min(1).describe("Glob pattern to match (e.g., **/*.ts, **/*.md)"),
    cwd: z.string().optional().describe("Working directory to search in"),
    maxResults: z.number().int().positive().default(100).optional().describe("Maximum number of results to return"),
    ignore: z.array(z.string()).optional().describe("Patterns to ignore"),
  }),
  sandbox: {
    enabled: true,
  },
  metadata: {
    category: "file",
    tags: ["search", "file", "glob", "pattern"],
    version: "1.1.0",
  },
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const startTime = Date.now();
    const { pattern, cwd, maxResults = 100, ignore } = args;

    const searchDir = cwd || ctx.workdir || process.cwd();

    // 验证目录存在
    try {
      const dirStats = await stat(searchDir);
      if (!dirStats.isDirectory()) {
        return {
          success: false,
          output: "",
          error: `Path is not a directory: ${searchDir}`,
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      }
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        metadata: { execution_time_ms: Date.now() - startTime },
      };
    }

    try {
      // 使用绝对路径模式
      const absolutePattern = path.isAbsolute(pattern) 
        ? pattern 
        : pattern;

      const files = await globAsync(absolutePattern, {
        cwd: searchDir,
        ignore: ignore || ["**/node_modules/**", "**/.git/**"],
        maxDepth: 20,
        absolute: false,
        nodir: true,
      });

      // 按修改时间排序（最近的在前）- 参考 opencode 实现
      const filesWithMtime: Array<{ path: string; mtime: number }> = [];
      
      for (const file of files) {
        try {
          const fullPath = path.join(searchDir, file);
          const stats = await stat(fullPath);
          if (stats.isFile()) {
            filesWithMtime.push({
              path: file,
              mtime: stats.mtimeMs,
            });
          }
        } catch {
          // 跳过无法获取信息的文件
        }
      }

      // 按 mtime 降序排序（最新的在前）
      filesWithMtime.sort((a, b) => b.mtime - a.mtime);

      // 检查是否截断
      const truncated = filesWithMtime.length > maxResults;
      const limitedFiles = filesWithMtime.slice(0, maxResults);
      
      // 构建输出（参考 opencode 的格式）
      const outputLines: string[] = [];
      
      if (limitedFiles.length === 0) {
        outputLines.push("No files found");
      } else {
        outputLines.push(...limitedFiles.map(f => f.path));
        
        if (truncated) {
          outputLines.push("");
          outputLines.push(
            `(Results are truncated: showing first ${maxResults} results. Consider using a more specific path or pattern.)`
          );
        }
      }

      const output = outputLines.join("\n");

      return {
        success: true,
        output,
        metadata: {
          execution_time_ms: Date.now() - startTime,
          output_size: output.length,
          total_matches: filesWithMtime.length,
          returned_matches: limitedFiles.length,
          truncated,
        },
      };
    } catch (error) {
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          execution_time_ms: Date.now() - startTime,
        },
      };
    }
  },
};
