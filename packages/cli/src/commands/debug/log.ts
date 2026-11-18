/**
 * @fileoverview Debug Log Command
 * 
 * Command: roy debug log --tail -n <lines>
 * 
 * 读取 log-trace component 日志配置对应的日志文件，显示尾部 n 行
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import type { CommandModule } from "yargs";

interface LogOptions {
  tail?: number;
  file?: string;
}

export const LogCommand: CommandModule<object, LogOptions> = {
  command: "log",
  describe: "查看日志文件（支持 --tail -n 显示尾部行）",

  builder: (yargs) =>
    yargs
      .option("tail", {
        alias: "n",
        type: "number",
        description: "显示尾部 n 行（默认 50）",
        default: 50,
      })
      .option("file", {
        alias: "f",
        type: "string",
        description: "日志文件路径（可选，默认使用配置路径）",
      }),

  async handler(args) {
    // 获取日志文件路径
    const logFile = args.file || getDefaultLogFile();
    
    if (!fs.existsSync(logFile)) {
      console.error(`Log file not found: ${logFile}`);
      process.exit(1);
    }

    try {
      const lines = await readTailLines(logFile, args.tail || 50);
      
      if (lines.length === 0) {
        console.log("(empty log file)");
        return;
      }

      // 逐行输出
      for (const line of lines) {
        console.log(line);
      }
    } catch (error) {
      console.error(`Failed to read log file: ${error}`);
      process.exit(1);
    }
  },
};

/**
 * 读取文件尾部 n 行
 */
export async function readTailLines(filePath: string, n: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const lines: string[] = [];
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });

    rl.on("line", (line) => {
      lines.push(line);
      // 只保留尾部 n 行
      if (lines.length > n) {
        lines.shift();
      }
    });

    rl.on("close", () => {
      resolve(lines);
    });

    rl.on("error", (err) => {
      reject(err);
    });
  });
}

/**
 * 获取默认日志文件路径
 * 
 * 使用 log-trace component 的配置：
 * - log-trace.logging.dir: 日志目录
 * - log-trace.logging.file: 日志文件名
 * 
 * 默认: ~/.local/share/roy-bot/logs/app.log
 */
export function getDefaultLogFile(): string {
  // 支持环境变量覆盖
  if (process.env.LOG_TRACE_LOGGING_DIR) {
    const dir = process.env.LOG_TRACE_LOGGING_DIR;
    const file = process.env.LOG_TRACE_LOGGING_FILE || "app.log";
    return path.join(dir, file);
  }
  
  // 支持直接指定文件路径
  if (process.env.LOG_TRACE_LOGGING_FILE?.includes("/") || process.env.LOG_TRACE_LOGGING_FILE?.includes("\\")) {
    return process.env.LOG_TRACE_LOGGING_FILE;
  }

  // 使用 XDG 标准路径
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const dataHome = process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
  const logDir = path.join(dataHome, "roy-bot", "logs");
  const logFile = process.env.LOG_TRACE_LOGGING_FILE || "app.log";
  
  return path.join(logDir, logFile);
}
