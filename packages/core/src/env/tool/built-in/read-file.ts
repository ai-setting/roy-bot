import { z } from "zod";
import { readFile, stat } from "fs/promises";
import path from "path";
import type { Tool, ToolContext, ToolResult } from "../types";

/**
 * 读取文件工具
 */
export const readFileTool: Tool = {
  name: "read_file",
  description: "Read the contents of a file. Use this to read source code, configuration files, or any text files.",
  parameters: z.object({
    path: z.string().describe("The file path to read"),
    offset: z.number().int().nonnegative().optional().describe("Line offset to start reading from"),
    limit: z.number().int().positive().optional().describe("Number of lines to read"),
    encoding: z.enum(["utf-8", "base64"]).default("utf-8").optional().describe("File encoding"),
  }),
  sandbox: {
    enabled: true,
    config: {
      filesystem: {
        denyRead: ["/etc/shadow", "/etc/sudoers", "/root/.ssh"],
      },
    },
  },
  permission: {
    level: "safe",
  },
  metadata: {
    category: "file",
    tags: ["read", "file", "io"],
    version: "1.1.0",
  },
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const startTime = Date.now();
    const { path: filePath, offset, limit, encoding = "utf-8" } = args;

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
      const contentBuffer = await readFile(normalizedPath);
      
      // 转换为字符串
      let contentStr: string;
      if (encoding === "base64") {
        contentStr = contentBuffer.toString("base64");
      } else {
        contentStr = contentBuffer.toString("utf-8");
      }

      // 如果指定了 offset/limit，需要按行处理
      let output: string;
      if (offset !== undefined || limit !== undefined) {
        // 按行分割（跨平台处理 Windows 和 Unix 换行符）
        const lines = contentStr.split(/\r?\n/);
        const startLine = offset || 0;
        const endLine = limit !== undefined ? Math.min(startLine + limit, lines.length) : lines.length;
        
        // 验证 offset 范围
        if (startLine >= lines.length) {
          return {
            success: false,
            output: "",
            error: `Offset ${offset} is beyond file length (${lines.length} lines)`,
            metadata: { execution_time_ms: Date.now() - startTime },
          };
        }
        
        output = lines.slice(startLine, endLine).join("\n");
      } else {
        output = contentStr;
      }

      return {
        success: true,
        output,
        metadata: {
          execution_time_ms: Date.now() - startTime,
          output_size: output.length,
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
