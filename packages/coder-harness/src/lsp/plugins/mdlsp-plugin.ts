/**
 * @fileoverview Markdown LSP 插件实现
 *
 * 行为：
 *  - **主诊断来源**：通过 LSPManager 与 markdown server（封装为 MarkdownLSPClient）
 *    通信，由 server 产出 markdown 语法 / 链接 / 引用类的 diagnostic（push 模型）。
 *  - **可选增强**：当 `entityReferences=true` 时，在 LSP 诊断之外**额外**附加
 *    wikilink 实体引用检查（`[[Namespace/Name]]` 风格）。该项**默认关闭**，
 *    主要用于 KMS / 知识库等约定场景。
 *  - **无降级**：若 markdown LSP 启动 / 调用失败，本插件**仅记录错误**并跳过
 *    LSP 诊断；不会自动回退到 wikilink-only 模式，避免行为漂移误导调用方。
 *
 * 改造说明：
 *  - 继承 BasePlugin，使用统一的 init(env: PluginEnv) 生命周期
 *  - 通过 env.registerHook() 注册 hooks
 */

import fs from "fs/promises";
import type { Diagnostic } from "vscode-languageserver-types";
import { createLogger } from "@ai-setting/roy-bot-core";
import { BasePlugin } from "@ai-setting/roy-bot-core";
import type { PluginEnv, HookHandler } from "@ai-setting/roy-bot-core";
import { createGlobalLSPManager } from "../manager";
import type { LSPManager } from "../manager";
import { WikilinkResolver, type WikilinkEntity } from "./mdlsp/wikilink-resolver";
import { CrossLangResolver } from "./mdlsp/cross-lang-resolver";
import { EntityReferenceChecker } from "./mdlsp/entity-reference-checker";
import { TracedAs } from "@ai-setting/roy-bot-core";

// ========================================================================
// Types
// ========================================================================

/**
 * MDLSP 插件配置
 */
export interface MDLSPPluginConfig {
  /** 是否启用 */
  enabled?: boolean;
  /** 预加载模式 */
  preloadMode?: "startup" | "lazy" | "disabled";
  /** 空闲超时（毫秒） */
  idleTimeout?: number;
  /** 优先级 */
  priority?: number;
  /**
   * 启用 wikilink 实体引用检查（`[[Namespace/Name]]`）。
   *
   * **默认 false**：大多数 markdown 文件不使用 wikilink，开启会产生
   * 大量 hint 噪音。仅当用户明确知道自己的知识库约定时再打开。
   */
  entityReferences?: boolean;
  /** 启用跨语言联动（查询 TS/Py 符号）；仅在 `entityReferences=true` 时生效 */
  crossLanguage?: boolean;
}

// ========================================================================
// MDLSPPlugin
// ========================================================================

/**
 * Markdown LSP 插件
 *
 * 主诊断来自 vscode-markdown-language-server；可选追加 wikilink 实体引用检查。
 */
export class MDLSPPlugin extends BasePlugin {
  readonly name = "MDLSPPlugin";
  readonly version = "2.0.0";
  readonly description =
    "Markdown LSP plugin (vscode-markdown-language-server based, optional wikilink entity references)";
  readonly priority: number;

  private config: MDLSPPluginConfig;
  private logger: ReturnType<typeof createLogger>;
  private lspManager!: LSPManager;
  private lspReady = false;

  // 实体引用检查配置（**默认关闭**）
  private _entityReferences: boolean;
  private _crossLanguage: boolean;

  // wikilink 相关解析器（仅在 entityReferences 开启时使用）
  private wikilinkResolver: WikilinkResolver;
  private crossLangResolver: CrossLangResolver;
  private referenceChecker: EntityReferenceChecker;

  /**
   * 检查文件是否受此插件支持
   */
  static isSupported(filePath: string): boolean {
    const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
    return ([".md", ".markdown"] as const).includes(ext as any);
  }

  constructor(config: MDLSPPluginConfig = {}) {
    super();
    this.config = {
      preloadMode: "startup",
      ...config,
    };
    this.priority = config.priority ?? 80;
    this._entityReferences = config.entityReferences ?? false;
    this._crossLanguage = config.crossLanguage ?? true;
    this.wikilinkResolver = new WikilinkResolver();
    this.crossLangResolver = new CrossLangResolver();
    this.referenceChecker = new EntityReferenceChecker();
    this.logger = createLogger("MDLSPPlugin");
  }

  /**
   * 初始化
   */
  init(env: PluginEnv): void | Promise<void> {
    // 创建（或复用）全局 LSPManager
    this.lspManager = createGlobalLSPManager({
      idleTimeout: this.config.idleTimeout ?? 60000,
      maxConnections: 5,
      autoDownload: false,
    });

    // 注册 hook
    env.registerHook({
      point: "tool:after.execute",
      priority: this.priority,
      handler: this.onAfterTool.bind(this) as HookHandler,
    });

    this.logger.info(
      `[MDLSPPlugin] Registered tool:after.execute hook (entityReferences=${this._entityReferences})`
    );

    // startup 模式下预热 markdown server
    if (this.config.preloadMode === "startup") {
      this.prewarm(["markdown"]);
    }
  }

  /**
   * 预热 markdown LSP server
   */
  async prewarm(languages?: string[]): Promise<void> {
    if (this.lspReady) return;
    const langs = languages ?? ["markdown"];
    try {
      await this.lspManager.prewarm(langs);
      this.lspReady = true;
    } catch (error) {
      // 无降级：仅记录，下次仍会尝试
      this.logger.error(`[MDLSPPlugin] prewarm failed: ${error}`);
    }
  }

  /**
   * tool:after.execute hook handler
   */
  @TracedAs("mdlsp-plugin.onAfterTool", { recordParams: true })
  async onAfterTool(ctx: any): Promise<void> {
    const data = ctx.data ?? ctx;
    const tool = data.tool;
    const args = data.args || {};
    const result = data.result;

    let toolName: string = "";
    if (typeof tool === "string") {
      toolName = tool;
    } else if (tool && typeof tool === "object") {
      toolName = (tool as { name?: string }).name || "";
    }

    if (toolName !== "write_file" && toolName !== "edit_file") {
      return;
    }

    const filePath = this.getTargetFilePath(toolName, args);
    if (!filePath || !MDLSPPlugin.isSupported(filePath)) {
      return;
    }

    try {
      const diagnostics = await this.getDiagnostics(filePath);
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
  private getTargetFilePath(
    toolName: string,
    args: Record<string, unknown>
  ): string | null {
    if (typeof args.path === "string") {
      return args.path;
    }
    if (toolName === "edit_file" && typeof args.filePath === "string") {
      return args.filePath;
    }
    return null;
  }

  /**
   * 获取诊断信息
   *
   * 顺序：
   *  1. 通过 LSPManager 取 markdown LSP 诊断（主来源）。失败时仅记录、返回空。
   *  2. 若 `entityReferences=true`，在末尾**追加** wikilink 实体引用诊断。
   *
   * 注意：不存在“LSP 失败则降级为 wikilink”的逻辑，避免诊断来源对调用方不可预测。
   */
  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    const out: Diagnostic[] = [];

    // === 主诊断：markdown LSP ===
    try {
      const lspDiagnostics = await this.lspManager.getDiagnostics(filePath);
      out.push(...lspDiagnostics);
    } catch (error) {
      this.logger.error(
        `[MDLSPPlugin] LSP getDiagnostics failed for ${filePath}: ${error}`
      );
      // 不降级
    }

    // === 可选增强：wikilink 实体引用 ===
    if (this._entityReferences) {
      try {
        out.push(...(await this.getWikilinkDiagnostics(filePath)));
      } catch (error) {
        this.logger.warn(
          `[MDLSPPlugin] wikilink getDiagnostics failed for ${filePath}: ${error}`
        );
      }
    }

    return out;
  }

  /**
   * 提取 wikilink 并产出诊断（仅 entityReferences=true 时调用）
   */
  private async getWikilinkDiagnostics(filePath: string): Promise<Diagnostic[]> {
    const content = await fs.readFile(filePath, "utf-8");
    const entities = this.wikilinkResolver.extractWikilinks(content);

    const diagnostics: Diagnostic[] = [];
    for (const entity of entities) {
      if (entity.namespace) {
        const languageId = this.namespaceToLanguageId(entity.namespace);
        const isDefined = this.referenceChecker.isDefined(
          entity.entityName,
          languageId,
          entity.namespace
        );
        diagnostics.push(
          this.createEntityDiagnostic(entity, filePath, languageId, isDefined)
        );
      } else {
        diagnostics.push(this.createWikilinkDiagnostic(entity, filePath));
      }
    }
    return diagnostics;
  }

  /**
   * wikilink 命名空间 → 语言 ID
   */
  private namespaceToLanguageId(namespace: string): string {
    const ns = namespace.toLowerCase();
    if (ns === "ts" || ns === "typescript" || ns === "js" || ns === "javascript") {
      return "typescript";
    }
    if (ns === "py" || ns === "python") {
      return "python";
    }
    return namespace;
  }

  private createEntityDiagnostic(
    entity: WikilinkEntity,
    filePath: string,
    languageId: string,
    isDefined: boolean
  ): Diagnostic {
    const entityDesc = entity.namespace
      ? `${entity.namespace}/${entity.entityName}`
      : entity.entityName;

    const severity = isDefined ? 4 : 2; // Hint = 4, Warning = 2
    const statusText = isDefined ? "defined" : "not found";
    const message = `[[${entityDesc}]] - Entity ${statusText} in ${languageId}`;

    return {
      severity,
      range: entity.range,
      message,
      source: "MDLSP",
      code: isDefined ? "entity-defined" : "entity-undefined",
      data: {
        entityName: entity.entityName,
        namespace: entity.namespace,
        language: languageId,
        filePath,
        raw: entity.raw,
        isDefined,
      },
    };
  }

  private createWikilinkDiagnostic(
    entity: WikilinkEntity,
    filePath: string
  ): Diagnostic {
    const entityDesc = entity.namespace
      ? `${entity.namespace}/${entity.entityName}`
      : entity.entityName;

    return {
      severity: 4,
      range: entity.range,
      message: `[[${entityDesc}]] - Link to entity`,
      source: "MDLSP",
      code: "wikilink-hint",
      data: {
        entityName: entity.entityName,
        namespace: entity.namespace,
        filePath,
        raw: entity.raw,
      },
    };
  }

  private attachToResult(
    result: {
      output?: string | Record<string, unknown>;
      metadata?: Record<string, unknown>;
    },
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

  private formatDiagnostics(diagnostics: Diagnostic[]): string {
    if (diagnostics.length === 0) return "";

    const lines: string[] = [];
    lines.push("## Markdown LSP Diagnostics");
    lines.push(`Found ${diagnostics.length} diagnostic(s):\n`);

    for (const d of diagnostics) {
      const severity = this.getSeverityText(d.severity);
      const { start } = d.range;
      const pos = `Line ${start.line + 1}, Col ${start.character + 1}`;
      lines.push(`- **[${severity}]** ${d.message}`);
      lines.push(`  - Location: ${pos}`);
      if (d.source) lines.push(`  - Source: ${d.source}`);
    }

    return lines.join("\n");
  }

  private getSeverityText(severity: number | undefined): string {
    switch (severity) {
      case 1:
        return "Error";
      case 2:
        return "Warning";
      case 3:
        return "Information";
      case 4:
        return "Hint";
      default:
        return `Unknown(${severity ?? "undefined"})`;
    }
  }

  /**
   * 获取插件状态
   */
  getStatus(): Record<string, unknown> {
    return {
      name: this.name,
      version: this.version,
      description: this.description,
      enabled: this.config.enabled,
      preloadMode: this.config.preloadMode,
      lspReady: this.lspReady,
      entityReferences: this._entityReferences,
      crossLanguage: this._crossLanguage,
    };
  }

  /**
   * 销毁：释放 LSPManager + 重置内部状态
   */
  async dispose(): Promise<void> {
    try {
      await this.lspManager?.dispose();
    } catch (error) {
      this.logger.warn(`[MDLSPPlugin] dispose lspManager failed: ${error}`);
    }
    this.lspReady = false;
    this.crossLangResolver = new CrossLangResolver();
  }
}

/**
 * 创建 MDLSPPlugin 实例的工厂函数
 */
export function createMDLSPPlugin(config?: MDLSPPluginConfig): MDLSPPlugin {
  return new MDLSPPlugin(config);
}
