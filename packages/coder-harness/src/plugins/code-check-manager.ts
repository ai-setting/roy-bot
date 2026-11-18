/**
 * @fileoverview CodeCheckManager - 外部命令检查管理器
 * 
 * 管理多语言的外部命令检查（Linter + TypeCheck）
 */

import { spawn } from "child_process";
import path from "path";
import type { CodeCheckManagerConfig, CodeCheckResult, CodeCheckIssue } from "../types/linter";

/**
 * 内置命令映射表
 */
const DEFAULT_COMMANDS: Record<string, string> = {
  ".ts": "tsc --noEmit --pretty false {file}",
  ".tsx": "tsc --noEmit --pretty false {file}",
  ".mts": "tsc --noEmit --pretty false {file}",
  ".cts": "tsc --noEmit --pretty false {file}",
  ".js": "tsc --noEmit --pretty false {file}",
  ".jsx": "tsc --noEmit --pretty false {file}",
  ".mjs": "tsc --noEmit --pretty false {file}",
  ".cjs": "tsc --noEmit --pretty false {file}",
  ".py": "mypy --no-error-summary {file}",
  ".rs": "rustc --edition 2021 --emit=metadata {file} 2>&1",
  ".go": "go vet {file}",
  ".json": "cat {file} | jq . > /dev/null",
  ".yaml": "cat {file} | yq . > /dev/null",
  ".yml": "cat {file} | yq . > /dev/null",
};

/**
 * 命令解析器接口
 */
export interface CommandParser {
  /** 解析命令输出 */
  parse(output: string, filePath: string): CodeCheckIssue[];
}

/**
 * TypeScript 解析器
 */
const TSC_PARSER: CommandParser = {
  parse(output: string, filePath: string): CodeCheckIssue[] {
    const issues: CodeCheckIssue[] = [];
    const regex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning|info)\s+(TS\d+)?:\s*(.+)$/gm;
    let match;
    while ((match = regex.exec(output)) !== null) {
      issues.push({
        line: parseInt(match[2], 10) - 1,
        column: parseInt(match[3], 10) - 1,
        message: match[6],
        code: match[5],
        severity: match[4] as "error" | "warning" | "info",
        command: `tsc --noEmit`,
      });
    }
    return issues;
  },
};

/**
 * mypy 解析器
 */
const MYPY_PARSER: CommandParser = {
  parse(output: string, filePath: string): CodeCheckIssue[] {
    const issues: CodeCheckIssue[] = [];
    const regex = /^(.+?):(\d+):\s+(error|warning|note):\s*(.+)$/gm;
    let match;
    while ((match = regex.exec(output)) !== null) {
      issues.push({
        line: parseInt(match[2], 10) - 1,
        column: 0,
        message: match[4],
        severity: match[3] as "error" | "warning" | "info",
        command: `mypy`,
      });
    }
    return issues;
  },
};

/**
 * JSON/YAML 解析器
 */
const JSON_PARSER: CommandParser = {
  parse(output: string, filePath: string): CodeCheckIssue[] {
    const issues: CodeCheckIssue[] = [];
    if (output.includes("parse error") || output.includes("invalid")) {
      issues.push({
        line: 0,
        column: 0,
        message: output.split("\n")[0] || "Parse error",
        severity: "error",
        command: "jq/yq",
      });
    }
    return issues;
  },
};

/**
 * 命令解析器映射
 */
const PARSERS: Record<string, CommandParser> = {
  ".ts": TSC_PARSER,
  ".tsx": TSC_PARSER,
  ".mts": TSC_PARSER,
  ".cts": TSC_PARSER,
  ".js": TSC_PARSER,
  ".jsx": TSC_PARSER,
  ".mjs": TSC_PARSER,
  ".cjs": TSC_PARSER,
  ".py": MYPY_PARSER,
  ".json": JSON_PARSER,
  ".yaml": JSON_PARSER,
  ".yml": JSON_PARSER,
};

export class CodeCheckManager {
  private config: CodeCheckManagerConfig;
  private cache: Map<string, CodeCheckResult>;

  constructor(config: CodeCheckManagerConfig) {
    this.config = config;
    this.cache = new Map();
  }

  /**
   * 获取文件对应的检查命令
   */
  getCommand(filePath: string): string | null {
    const ext = path.extname(filePath).toLowerCase();
    
    // 优先使用自定义命令
    if (this.config.commands?.[ext]) {
      return this.config.commands[ext];
    }
    
    // 使用默认命令
    return DEFAULT_COMMANDS[ext] || null;
  }

  /**
   * 检查单个文件
   */
  async checkFile(filePath: string): Promise<CodeCheckResult> {
    const command = this.getCommand(filePath);
    
    if (!command) {
      const result: CodeCheckResult = {
        filePath,
        output: "",
        exitCode: 0,
        success: true,
        issues: [],
        timestamp: Date.now(),
      };
      this.cache.set(filePath, result);
      return result;
    }

    // 替换 {file} 占位符
    const cmdTemplate = command.replace("{file}", filePath);
    const [cmd, ...args] = cmdTemplate.split(" ");
    
    return new Promise((resolve) => {
      const proc = spawn(cmd!, args.filter(Boolean), {
        cwd: path.dirname(filePath),
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      });

      const timeoutId = setTimeout(() => {
        proc.kill();
        resolve({
          filePath,
          output: "Command timed out",
          exitCode: -1,
          success: false,
          issues: [{
            line: 0,
            column: 0,
            message: `Command timed out after ${this.config.timeout}ms`,
            severity: "error",
            command: cmdTemplate,
          }],
          timestamp: Date.now(),
        });
      }, this.config.timeout);

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("error", (err: Error) => {
        clearTimeout(timeoutId);
        resolve({
          filePath,
          output: err.message,
          exitCode: -1,
          success: false,
          issues: [{
            line: 0,
            column: 0,
            message: `Command not found: ${cmd}`,
            severity: "error",
            command: cmdTemplate,
          }],
          timestamp: Date.now(),
        });
      });

      proc.on("close", (code: number | null) => {
        clearTimeout(timeoutId);
        const output = stdout + (stderr ? "\n" + stderr : "");
        const ext = path.extname(filePath).toLowerCase();
        const parser = PARSERS[ext] || TSC_PARSER;
        const issues = parser.parse(output, filePath);
        
        const result: CodeCheckResult = {
          filePath,
          output,
          exitCode: code ?? 0,
          success: (code ?? 0) === 0,
          issues,
          timestamp: Date.now(),
        };
        
        this.cache.set(filePath, result);
        resolve(result);
      });
    });
  }

  /**
   * 获取缓存结果
   */
  getCached(filePath: string): CodeCheckResult | undefined {
    return this.cache.get(filePath);
  }

  /**
   * 清除缓存
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * 释放资源
   */
  dispose(): void {
    this.cache.clear();
  }
}

/**
 * 创建 CodeCheckManager 实例
 */
export function createCodeCheckManager(
  config?: Partial<CodeCheckManagerConfig>
): CodeCheckManager {
  return new CodeCheckManager({
    timeout: config?.timeout ?? 30000,
    ignorePatterns: config?.ignorePatterns ?? [],
    commands: config?.commands,
  });
}
