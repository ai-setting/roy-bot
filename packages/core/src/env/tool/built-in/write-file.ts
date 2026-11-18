import { z } from "zod";
import { writeFile, mkdir, stat } from "fs/promises";
import path from "path";
import type { Tool, ToolContext, ToolResult } from "../types";

/**
 * 写入文件工具
 */
export const writeFileTool: Tool = {
  name: "write_file",
  description: "Write content to a file. Use this to create new files or overwrite existing ones.",
  parameters: z.object({
    path: z.string().describe("The file path to write to"),
    content: z.string().describe("The content to write"),
    createDirs: z.boolean().default(false).optional().describe("Create parent directories if they don't exist"),
    append: z.boolean().default(false).optional().describe("Append to file instead of overwrite"),
  }),
  sandbox: {
    enabled: true,
    config: {
      filesystem: {
        denyWrite: ["/etc", "/usr", "/bin", "/sbin", "/boot", "/sys"],
      },
    },
  },
  permission: {
    requireConfirmation: true,
    level: "dangerous",
  },
  metadata: {
    category: "file",
    tags: ["write", "file", "io", "create"],
    version: "1.1.0",
  },
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const startTime = Date.now();
    const { path: filePath, content, createDirs = false, append = false } = args;

    // 验证文件路径
    if (!filePath || typeof filePath !== "string") {
      return {
        success: false,
        output: "",
        error: "Invalid file path provided",
        metadata: { execution_time_ms: Date.now() - startTime },
      };
    }

    // 规范化路径（处理 Windows 反斜杠）
    const normalizedPath = path.normalize(filePath);

    // 验证目标不是目录
    try {
      const stats = await stat(normalizedPath);
      if (stats.isDirectory()) {
        return {
          success: false,
          output: "",
          error: `Path is a directory, not a file: ${normalizedPath}`,
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      }
    } catch (error) {
      // 文件不存在是可以的，继续写入
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          success: false,
          output: "",
          error: error instanceof Error ? error.message : String(error),
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      }
    }

    try {
      // 如果需要创建目录
      if (createDirs) {
        await mkdir(path.dirname(normalizedPath), { recursive: true });
      }

      const flags = append ? "a" : "w";
      await writeFile(normalizedPath, content, { flag: flags });

      return {
        success: true,
        output: append ? `Content appended to: ${normalizedPath}` : `File written: ${normalizedPath}`,
        metadata: {
          execution_time_ms: Date.now() - startTime,
          output_size: content.length,
          file_path: normalizedPath,
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
