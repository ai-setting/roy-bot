/**
 * @fileoverview TypeScript LSP 插件实现
 * 
 * 支持 .ts, .tsx, .js, .jsx 等扩展名
 * 
 * 改造说明：
 * - 继承 BasePlugin，使用统一的 init(env: PluginEnv) 生命周期
 * - 通过 env.registerHook() 注册 hooks
 */

import type { Diagnostic } from "vscode-languageserver-types";
import { createLogger } from "@ai-setting/roy-bot-core";
import { BasePlugin } from "@ai-setting/roy-bot-core";
import type { PluginEnv, HookHandler } from "@ai-setting/roy-bot-core";
import { BaseLanguageLSPPlugin, type LanguageLSPPluginConfig } from "./base-plugin";
import { createGlobalLSPManager } from "../manager";
import type { LSPManager } from "../manager";
import { TracedAs } from "@ai-setting/roy-bot-core";

// ========================================================================
// Types
// ========================================================================

/**
 * TypeScript LSP 插件配置
 */
export interface TSLSPPluginConfig extends LanguageLSPPluginConfig {
  /** 优先级 */
  priority?: number;
  /** LSP 客户端初始化超时（毫秒），默认 2000 */
  initTimeout?: number;
}

// ========================================================================
// TSLSPPlugin
// ========================================================================

/**
 * TypeScript LSP 插件
 * 
 * 使用 TypeScript 语言服务器提供诊断和符号服务
 * 继承 BasePlugin，使用统一的 init(env: PluginEnv) 生命周期
 */
export class TSLSPPlugin extends BasePlugin {
  readonly name = "TSLSPPlugin";
  readonly version = "1.0.0";
  readonly description = "TypeScript Language Server Plugin";
  readonly priority: number;

  private lspManager!: LSPManager;
  private config: TSLSPPluginConfig;
  private logger: ReturnType<typeof createLogger>;
  private initialized: boolean = false;

  /**
   * 检查文件是否受此插件支持
   */
  static isSupported(filePath: string): boolean {
    const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
    return ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"] as const).includes(ext as any);
  }

  constructor(config: TSLSPPluginConfig = {}) {
    super();
    this.config = {
      // 默认启用：插件启动时自动预热 LSP 连接，避免首次 tool 调用延迟
      preloadMode: "startup",
      ...config,
    };
    this.priority = config.priority ?? 80;
    this.logger = createLogger("TSLSPPlugin");
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
      maxConnections: 5,
      autoDownload: false,
      initTimeout: this.config.initTimeout ?? 2000,
    });

    // 注册 hook
    env.registerHook({
      point: "tool:after.execute",
      priority: this.priority,
      handler: this.onAfterTool.bind(this) as HookHandler,
    });

    this.logger.info(`[TSLSPPlugin] Registered tool:after.execute hook`);

    // startup 模式下预热
    if (this.config.preloadMode === "startup") {
      this.prewarm(["typescript"]);
    }
  }

  /**
   * 预热 LSP 服务
   */
  async prewarm(languages?: string[]): Promise<void> {
    if (this.initialized) return;
    const langs = languages ?? ["typescript"];
    await this.lspManager.prewarm(langs);
    this.initialized = true;
  }

  /**
   * tool:after.execute hook handler
   */
  @TracedAs("tslsp-plugin.onAfterTool", { recordParams: true })
  async onAfterTool(ctx: any): Promise<void> {
    const data = ctx.data ?? ctx;
    const tool = data.tool;
    const args = data.args || {};
    const result = data.result;

    // 获取工具名称
    let toolName: string = "";
    if (typeof tool === "string") {
      toolName = tool;
    } else if (tool && typeof tool === "object") {
      toolName = (tool as { name?: string }).name || "";
    }

    // 只处理 write_file 和 edit_file（写操作）
    if (toolName !== "write_file" && toolName !== "edit_file") {
      return;
    }

    // 获取目标文件路径
    const filePath = this.getTargetFilePath(toolName, args);
    if (!filePath) return;

    // 检查文件是否受支持
    if (!TSLSPPlugin.isSupported(filePath)) {
      return;
    }

    // 获取诊断信息并附加到结果
    try {
      const diagnostics = await this.lspManager.getDiagnostics(filePath);
      if (diagnostics.length > 0 && result) {
        this.attachToResult(result, diagnostics);
      }
    } catch (error) {
      this.logger.warn(`onAfterTool failed for ${filePath}: ${error}`);
    }
  }

  /**
   * 从工具参数获取目标文件路径
   */
  private getTargetFilePath(toolName: string, args: Record<string, unknown>): string | null {
    if (typeof args.path === "string") {
      return args.path;
    }
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
    if (diagnostics.length === 0) return "";

    const lines: string[] = [];
    lines.push("## TypeScript LSP Diagnostics");
    lines.push(`Found ${diagnostics.length} diagnostic(s):\n`);

    for (const d of diagnostics) {
      const severity = this.getSeverityText(d.severity);
      const { start } = d.range;
      const pos = `Line ${start.line + 1}, Col ${start.character + 1}`;
      lines.push(`- **[${severity}]** ${d.message}`);
      lines.push(`  - Location: ${pos}`);
      if (d.source) {
        lines.push(`  - Source: ${d.source}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * 获取严重程度文本
   */
  private getSeverityText(severity: number | undefined): string {
    switch (severity) {
      case 1: return "Error";
      case 2: return "Warning";
      case 3: return "Information";
      case 4: return "Hint";
      default: return `Unknown(${severity ?? "undefined"})`;
    }
  }

  /**
   * 获取诊断信息（公开 API）
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
 * 创建 TSLSPPlugin 实例的工厂函数
 */
export function createTSLSPPlugin(config?: TSLSPPluginConfig): TSLSPPlugin {
  return new TSLSPPlugin(config);
}
