import { z } from "zod";
import { readFile, stat } from "fs/promises";
import { glob as globAsync } from "glob";
import path from "path";
import type { Tool, ToolContext, ToolResult } from "../types";

/**
 * 检查文件是否为二进制文件
 */
function isBinaryContent(content: Buffer): boolean {
  // 检查是否包含 null 字节（常见的二进制文件特征）
  for (let i = 0; i < Math.min(content.length, 8192); i++) {
    if (content[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Grep 工具
 * 在文件中搜索内容
 */
export const grepTool: Tool = {
  name: "grep",
  description: "Search for text patterns in files. Use this to find specific strings, code patterns, or content across multiple files.",
  parameters: z.object({
    pattern: z.string().min(1).describe("The pattern to search for"),
    path: z.string().optional().describe("File or directory path to search in"),
    include: z.string().optional().describe("Glob pattern for files to include (e.g., *.ts, *.js)"),
    caseSensitive: z.boolean().default(true).optional().describe("Whether the search should be case sensitive"),
    maxResults: z.number().int().positive().default(50).optional().describe("Maximum number of results"),
    showLineNumbers: z.boolean().default(true).optional().describe("Show line numbers in results"),
  }),
  sandbox: {
    enabled: true,
  },
  metadata: {
    category: "file",
    tags: ["search", "grep", "find", "pattern"],
    version: "1.1.0",
  },
  execute: async (args, ctx: ToolContext): Promise<ToolResult> => {
    const startTime = Date.now();
    const {
      pattern,
      path: searchPath,
      include,
      caseSensitive = true,
      maxResults = 50,
      showLineNumbers = true,
    } = args;

    const basePath = searchPath || ctx.workdir || process.cwd();

    // 验证路径存在
    try {
      const stats = await stat(basePath);
      if (!stats.isDirectory() && !stats.isFile()) {
        return {
          success: false,
          output: "",
          error: `Path is neither a file nor a directory: ${basePath}`,
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
      // 确定搜索范围：如果 basePath 是文件，直接搜索该文件；否则搜索目录
      const isFile = (await stat(basePath)).isFile();
      
      let files: string[] = [];
      
      if (isFile) {
        // 如果 basePath 是文件，直接使用它
        files = [basePath];
      } else {
        // 如果指定了 include，使用递归模式匹配文件
        const globPattern = include || "**/*";
        files = await globAsync(globPattern, {
          cwd: basePath,
          ignore: ["**/node_modules/**", "**/.git/**", "**/*.min.js", "**/*.map"],
          maxDepth: 10,
          nodir: true,
        });
        
        // 转换相对路径为绝对路径
        files = files.map(f => path.join(basePath, f));
      }

      const results: string[] = [];
      // 不使用全局标志，避免 lastIndex 问题
      const regexFlags = caseSensitive ? "" : "i";
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, regexFlags);
      } catch {
        return {
          success: false,
          output: "",
          error: `Invalid regex pattern: ${pattern}`,
          metadata: { execution_time_ms: Date.now() - startTime },
        };
      }

      for (const file of files) {
        if (results.length >= maxResults) break;

        try {
          // 检查文件是否为二进制
          const fileStats = await stat(file);
          if (fileStats.isDirectory()) continue;

          const content = await readFile(file);
          
          // 跳过二进制文件
          if (isBinaryContent(content)) continue;

          const textContent = content.toString("utf-8");
          const lines = textContent.split(/\r?\n/);

          for (let i = 0; i < lines.length; i++) {
            // 重置 lastIndex 以避免问题
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              const lineNum = showLineNumbers ? `${i + 1}:` : "";
              // 使用相对路径显示
              const relativePath = path.relative(basePath, file);
              results.push(`${relativePath}:${lineNum}${lines[i]}`);

              if (results.length >= maxResults) break;
            }
          }
        } catch {
          // 跳过无法读取的文件
        }
      }

      const output = results.join("\n") || "(no matches found)";

      return {
        success: true,
        output,
        metadata: {
          execution_time_ms: Date.now() - startTime,
          output_size: output.length,
          matches_count: results.length,
          files_searched: files.length,
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
