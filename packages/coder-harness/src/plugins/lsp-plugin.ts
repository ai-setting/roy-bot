/**
 * @fileoverview LSPPlugin - LSP 代码智能查询插件
 *
 * 提供代码智能能力：hover、completion、definition、references 等
 * 
 * 改造说明：
 * - 继承 BasePlugin，使用统一的 init(env: PluginEnv) 生命周期
 * - 通过 env.registerHook() 注册 hooks
 */

import type { Diagnostic } from "../types/linter";
import { createGlobalLSPManager } from "../lsp/manager";
import { createLogger } from "@ai-setting/roy-bot-core";
import type { LSPManager } from "../lsp/manager";
import { BasePlugin } from "@ai-setting/roy-bot-core";
import type { PluginEnv, HookHandler } from "@ai-setting/roy-bot-core";

// ========================================================================
// Types
// ========================================================================

/**
 * LSP 查询结果类型
 */
export interface LSPQueryResult {
  /** 查询类型 */
  type: "hover" | "completion" | "definition" | "references" | "diagnostics";
  /** 文件路径 */
  filePath: string;
  /** 结果数据 */
  data: unknown;
}

/**
 * LSPPlugin 配置
 */
export interface LSPPluginConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 空闲超时（毫秒） */
  idleTimeout?: number;
  /** 最大并发连接数 */
  maxConnections?: number;
  /** 是否自动下载 LSP 服务器 */
  autoDownload?: boolean;
  /** 预加载模式: startup | lazy | disabled */
  preloadMode?: "startup" | "lazy" | "disabled";
  /** 预加载的语言列表 */
  preloadLanguages?: string[];
}

// ========================================================================
// Hook Data Types
// ========================================================================

/**
 * tool:after.execute hook 数据类型
 */
export interface ToolAfterExecuteHookData {
  tool?: { name?: string };
  args?: Record<string, unknown>;
  result?: {
    success: boolean;
    output?: string | Record<string, unknown>;
    error?: string;
    metadata?: Record<string, unknown>;
  };
}

// ========================================================================
// LSPPlugin
// ========================================================================

/**
 * LSPPlugin
 *
 * 通过 tool:after.execute hook 提供代码智能查询能力
 *
 * @example
 * ```typescript
 * // 继承 BasePlugin 后，通过 init(env) 注册
 * init(env: PluginEnv): void {
 *   env.registerHook({
 *     point: "tool:after.execute",
 *     priority: 90,
 *     handler: this.onAfterTool.bind(this),
 *   });
 * }
 * ```
 */
export class LSPPlugin extends BasePlugin {
  readonly name = "LSPPlugin";
  readonly version = "1.0.0";
  readonly description = "LSP-based code intelligence (hover, completion, definition, etc.)";
  readonly priority = 90; // 在 CodeCheckPlugin 之前执行

  private lspManager!: LSPManager;
  private config: LSPPluginConfig;
  private logger: ReturnType<typeof createLogger>;
  private initialized: boolean = false;

  constructor(config: LSPPluginConfig = {}) {
    super();
    this.config = {
      preloadMode: "startup",
      ...config,
    };
    this.logger = createLogger("LSPPlugin");
  }

  /**
   * 初始化
   * 
   * 通过 env.registerHook() 注册 hooks
   */
  init(env: PluginEnv): void | Promise<void> {
    // 创建 LSPManager
    this.lspManager = createGlobalLSPManager({
      idleTimeout: this.config.idleTimeout ?? 60000,
      maxConnections: this.config.maxConnections ?? 5,
      autoDownload: this.config.autoDownload ?? false,
    });

    // 注册进程退出时的清理处理器
    this.lspManager.registerShutdownHandler();

    // 注册 hook
    env.registerHook({
      point: "tool:after.execute",
      priority: this.priority,
      handler: this.onAfterTool.bind(this) as HookHandler,
    });

    this.logger.info(`[LSPPlugin] Registered tool:after.execute hook`);

    // startup 模式下自动预热
    if (this.config.preloadMode === "startup") {
      const languages = this.config.preloadLanguages ?? [];
      this.prewarm(languages);
    }
  }

  /**
   * 预热 LSP 服务
   */
  async prewarm(languages?: string[]): Promise<void> {
    if (this.initialized) {
      return;
    }
    await this.lspManager.prewarm(languages);
    this.initialized = true;
  }

  /**
   * 获取 LSP 服务状态
   */
  getStatus(): { initialized: boolean; preloadMode: string } {
    return {
      initialized: this.initialized,
      preloadMode: this.config.preloadMode ?? "startup",
    };
  }

  /**
   * tool:after.execute hook handler
   */
  async onAfterTool(ctx: any): Promise<{ stopped: boolean; results: unknown[] }> {
    const data = ctx.data ?? ctx;
    const tool = data.tool;
    const args = data.args || {};
    const result = data.result;
    
    // 获取工具名称
    let toolName: string;
    if (typeof tool === "string") {
      toolName = tool;
    } else if (tool && typeof tool === "object") {
      toolName = (tool as { name?: string }).name || "";
    } else {
      toolName = "";
    }

    // 只处理 write_file 和 edit_file（写操作）
    if (toolName !== "write_file" && toolName !== "edit_file") {
      return { stopped: false, results: [] };
    }

    // 获取目标文件路径
    const filePath = this.getTargetFilePath(toolName, args);
    if (!filePath) {
      return { stopped: false, results: [] };
    }

    // 获取诊断信息
    try {
      const diagnostics = await this.lspManager.getDiagnostics(filePath);
      if (diagnostics.length > 0 && result) {
        this.attachToResult(result, diagnostics);
      }
    } catch (error) {
      this.logger.warn(`diagnostics failed for ${filePath}: ${error}`);
    }

    return { stopped: false, results: [] };
  }

  /**
   * 从工具参数获取目标文件路径
   */
  private getTargetFilePath(
    toolName: string,
    args: Record<string, unknown>
  ): string | null {
    // write_file 和 edit_file 使用 path 参数
    if (typeof args.path === "string") {
      return args.path;
    }

    // edit_file 旧格式可能使用 filePath 参数
    if (toolName === "edit_file" && typeof args.filePath === "string") {
      return args.filePath;
    }

    return null;
  }

  /**
   * 将诊断信息附加到结果
   */
  private attachToResult(
    result: { output?: string | Record<string, unknown>; metadata?: Record<string, unknown> },
    diagnostics: Diagnostic[]
  ): void {
    const diagnosticText = this.formatDiagnostics(diagnostics);
    
    if (result.output === undefined) {
      result.output = diagnosticText;
    } else if (typeof result.output === "string") {
      result.output = result.output + "\n\n" + diagnosticText;
    } else if (typeof result.output === "object") {
      result.output = {
        ...result.output,
        lspDiagnostics: diagnostics,
        lspDiagnosticText: diagnosticText,
      };
    }
  }

  /**
   * 格式化诊断信息
   */
  private formatDiagnostics(diagnostics: Diagnostic[]): string {
    if (diagnostics.length === 0) {
      return "";
    }

    const lines: string[] = [];
    lines.push("## LSP Diagnostics");
    lines.push(`Found ${diagnostics.length} diagnostic(s):\n`);

    for (const d of diagnostics) {
      const severity = this.getSeverityText(d.severity);
      const { start, end } = d.range;
      const pos = start.line === end.line 
        ? `Line ${start.line + 1}, Col ${start.character + 1}`
        : `Lines ${start.line + 1}-${end.line + 1}`;
      
      lines.push(`- **[${severity}]** ${d.message}`);
      lines.push(`  - Location: ${pos}`);
      if (d.source) {
        lines.push(`  - Source: ${d.source}`);
      }
      if (d.code) {
        lines.push(`  - Code: ${d.code}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * 获取严重程度文本
   */
  private getSeverityText(severity: number): string {
    switch (severity) {
      case 1: return "Error";
      case 2: return "Warning";
      case 3: return "Information";
      case 4: return "Hint";
      default: return `Unknown(${severity})`;
    }
  }

  /**
   * 查询文件诊断信息（公开 API）
   */
  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    return this.lspManager.getDiagnostics(filePath);
  }

  /**
   * 销毁
   */
  dispose(): void | Promise<void> {
    return this.lspManager.dispose();
  }
}

/**
 * 创建 LSPPlugin 实例的工厂函数
 */
export function createLSPPlugin(config?: LSPPluginConfig): LSPPlugin {
  return new LSPPlugin(config);
}
