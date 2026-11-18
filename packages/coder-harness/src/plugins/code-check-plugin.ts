/**
 * @fileoverview CodeCheckPlugin - 外部命令检查插件
 * 
 * 在文件写入或编辑后执行外部命令进行强制检查
 * 
 * 改造说明：
 * - 继承 BasePlugin，使用统一的 init(env: PluginEnv) 生命周期
 * - 通过 env.registerHook() 注册 hooks
 */

import type { CodeCheckPluginConfig, CodeCheckResult } from "../types/linter";
import { createCodeCheckManager } from "./code-check-manager";
import { shouldIgnore } from "../util/glob";
import { createLogger } from "@ai-setting/roy-bot-core";
import { BasePlugin } from "@ai-setting/roy-bot-core";
import type { PluginEnv, HookHandler } from "@ai-setting/roy-bot-core";

// ========================================================================
// Types
// ========================================================================

/**
 * CodeCheckPlugin Hook 数据类型
 */
export interface CodeCheckHookData {
  toolName: string;
  args: Record<string, unknown>;
  result: {
    success: boolean;
    output?: string | Record<string, unknown>;
    error?: string;
    metadata?: Record<string, unknown>;
  };
}

// ========================================================================
// CodeCheckPlugin
// ========================================================================

/**
 * CodeCheckPlugin
 * 
 * 通过 tool:after.execute hook 在文件写入或编辑后执行外部命令检查
 */
export class CodeCheckPlugin extends BasePlugin {
  readonly name = "CodeCheckPlugin";
  readonly version = "1.0.0";
  readonly description = "External command code checking (linter + type check)";
  readonly priority = 80; // 在 LSPPlugin 之后执行

  private codeCheckManager!: ReturnType<typeof createCodeCheckManager>;
  private config: CodeCheckPluginConfig;
  private ignorePatterns: string[];
  private supportedExtensions: Set<string>;
  private logger: ReturnType<typeof createLogger>;

  constructor(config: CodeCheckPluginConfig = {}) {
    super();
    this.config = config;
    this.ignorePatterns = config.ignorePatterns ?? [];
    this.supportedExtensions = new Set(
      config.supportedExtensions ?? [
        ".ts", ".tsx", ".mts", ".cts",
        ".js", ".jsx", ".mjs", ".cjs",
        ".py", ".rs", ".go", ".json",
        ".yaml", ".yml",
      ]
    );
    this.logger = createLogger("CodeCheckPlugin");
  }

  /**
   * 初始化
   */
  init(env: PluginEnv): void {
    // 创建 CodeCheckManager
    this.codeCheckManager = createCodeCheckManager({
      timeout: this.config.timeout ?? 30000,
      ignorePatterns: this.ignorePatterns,
      commands: this.config.commands,
    });

    // 注册 hook
    env.registerHook({
      point: "tool:after.execute",
      priority: this.priority,
      handler: this.onAfterTool.bind(this) as HookHandler,
    });

    this.logger.info(`[CodeCheckPlugin] Registered tool:after.execute hook`);
  }

  /**
   * tool:after.execute hook handler
   */
  async onAfterTool(ctx: any): Promise<{ stopped: boolean; results: unknown[] }> {
    const data = ctx.data ?? ctx;
    const toolName = typeof data.tool === "string" ? data.tool : data.tool?.name || "";
    const args = data.args || {};
    const result = data.result;

    // 检查是否启用
    if (this.config.enabled === false) {
      return { stopped: false, results: [] };
    }

    // 只处理 write_file 和 edit_file
    if (toolName !== "write_file" && toolName !== "edit_file") {
      return { stopped: false, results: [] };
    }

    // 检查配置
    if (toolName === "write_file" && this.config.checkOnSave === false) {
      return { stopped: false, results: [] };
    }
    if (toolName === "edit_file" && this.config.checkOnEdit === false) {
      return { stopped: false, results: [] };
    }

    // 获取目标文件路径
    const filePath = this.getTargetFilePath(toolName, args);
    if (!filePath) {
      return { stopped: false, results: [] };
    }

    // 检查是否支持该文件类型
    if (!this.isSupported(filePath)) {
      return { stopped: false, results: [] };
    }

    // 检查忽略模式
    if (this.shouldIgnore(filePath)) {
      return { stopped: false, results: [] };
    }

    // 执行检查
    try {
      const checkResult = await this.codeCheckManager.checkFile(filePath);

      // 只在有错误或警告时附加结果
      const hasIssues = checkResult.issues.some(
        (i) => i.severity === "error" || i.severity === "warning"
      );

      if (hasIssues && result) {
        this.attachToResult(result, checkResult);
      }
    } catch (error) {
      this.logger.warn(`check failed for ${filePath}: ${error}`);
    }

    return { stopped: false, results: [] };
  }

  /**
   * 获取目标文件路径
   */
  getTargetFilePath(toolName: string, args: Record<string, unknown>): string | null {
    if (typeof args.path === "string") {
      return args.path;
    }
    if (typeof args.filePath === "string") {
      return args.filePath;
    }
    return null;
  }

  /**
   * 检查是否支持
   */
  isSupported(filePath: string): boolean {
    const ext = filePath.substring(filePath.lastIndexOf(".")).toLowerCase();
    return this.supportedExtensions.has(ext);
  }

  /**
   * 检查是否忽略
   */
  shouldIgnore(filePath: string): boolean {
    return shouldIgnore(filePath, this.ignorePatterns);
  }

  /**
   * 将结果附加到 tool result
   */
  private attachToResult(
    result: CodeCheckHookData["result"],
    checkResult: CodeCheckResult
  ): void {
    const formattedOutput = this.formatCodeCheckResult(checkResult);

    if (typeof result.output === "string") {
      result.output = result.output + "\n\n" + formattedOutput;
    } else if (typeof result.output === "object") {
      result.output = {
        ...result.output,
        codeCheck: {
          issues: checkResult.issues,
          output: checkResult.output,
        },
        codeCheckText: formattedOutput,
      };
    } else {
      result.output = formattedOutput;
    }
  }

  /**
   * 格式化检查结果
   */
  private formatCodeCheckResult(result: CodeCheckResult): string {
    if (result.issues.length === 0) {
      return "";
    }

    const lines: string[] = [];
    lines.push("## Code Check Results");
    lines.push(`Found ${result.issues.length} issue(s):\n`);

    for (const issue of result.issues) {
      const severity = issue.severity === "error" ? "Error" : issue.severity === "warning" ? "Warning" : "Info";
      lines.push(`- **[${severity}]** ${issue.message}`);
      lines.push(`  - Location: ${result.filePath}:${issue.line + 1}:${issue.column + 1}`);
      lines.push(`  - Command: ${issue.command}`);
    }

    return lines.join("\n");
  }

  /**
   * 销毁
   */
  dispose(): void | Promise<void> {
    return this.codeCheckManager?.dispose();
  }
}

/**
 * 创建 CodeCheckPlugin 实例
 */
export function createCodeCheckPlugin(config?: CodeCheckPluginConfig): CodeCheckPlugin {
  return new CodeCheckPlugin(config);
}
