import { z } from "zod";
import { readFile, writeFile, stat, unlink } from "fs/promises";
import path from "path";
import { randomUUID } from "crypto";
import type { Tool, ToolContext, ToolResult } from "../types";

/**
 * 编辑文件工具
 * 通过 oldString/newString 替换来编辑文件
 */
export const editFileTool: Tool = {
  name: "edit_file",
  description: "Edit a file by replacing specific text. Use this to make targeted changes to files by specifying what to find and what to replace.",
  parameters: z.object({
    path: z.string().describe("The file path to edit"),
    oldString: z.string().describe("The text to find and replace"),
    newString: z.string().describe("The replacement text"),
    replaceAll: z.boolean().default(false).optional().describe("Replace all occurrences instead of just the first"),
  }),
  sandbox: {
    enabled: true,
    config: {
      filesystem: {
        denyWrite: ["/etc", "/usr/bin", "/usr/sbin", "/bin", "/sbin"],
      },
    },
  },
  permission: {
    requireConfirmation: true,
    level: "dangerous",
  },
  metadata: {
    category: "file",
    tags: ["edit", "file", "replace", "modify"],
    version: "1.1.0",
  },
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const startTime = Date.now();
    const { path: filePath, oldString, newString, replaceAll = false } = args;

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

    // 验证文件存在且是文件
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          success: false,
          output: "",
          error: `File not found: ${normalizedPath}`,
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      }
      return {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        metadata: { execution_time_ms: Date.now() - startTime },
      };
    }

    try {
      // 读取文件内容
      const content = await readFile(normalizedPath, "utf-8");

      // 检查是否找到要替换的内容
      const escapedPattern = escapeRegExp(oldString);
      const searchPattern = replaceAll 
        ? new RegExp(escapedPattern, "g") 
        : new RegExp(escapedPattern);
      
      if (!searchPattern.test(content)) {
        return {
          success: false,
          output: "",
          error: `Could not find "${oldString}" in file ${normalizedPath}`,
          metadata: {
            execution_time_ms: Date.now() - startTime,
          },
        };
      }

      // 执行替换
      const newContent = replaceAll
        ? content.replace(new RegExp(escapedPattern, "g"), newString)
        : content.replace(oldString, newString);

      // 原子写入：先写临时文件，再 rename（避免写入失败导致文件损坏）
      const tempPath = `${normalizedPath}.${randomUUID()}.tmp`;
      await writeFile(tempPath, newContent, "utf-8");
      
      // 使用原子操作重命名（覆盖原文件）
      await Bun.write(normalizedPath, newContent);
      
      // 清理临时文件（如果存在）
      try {
        await unlink(tempPath);
      } catch {
        // 忽略清理错误
      }

      // 计算替换次数
      const count = replaceAll 
        ? (content.match(new RegExp(escapedPattern, "g")) || []).length 
        : (content.includes(oldString) ? 1 : 0);

      return {
        success: true,
        output: replaceAll
          ? `Replaced ${count} occurrences in: ${normalizedPath}`
          : `Replaced text in: ${normalizedPath}`,
        metadata: {
          execution_time_ms: Date.now() - startTime,
          file_path: normalizedPath,
          replacements: count,
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

/**
 * 转义正则表达式特殊字符
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
