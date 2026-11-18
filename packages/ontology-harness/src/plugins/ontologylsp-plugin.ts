/**
 * @fileoverview OntologyLSPPlugin — Typed Markdown Ontology 插件
 *
 * 组合式设计（不继承 MDLSPPlugin）：插件自持一个 LSPManager 提供 markdown
 * 基础诊断，并叠加 OntologyAnalyzer 的 TM 约束诊断。两者相互独立：
 *  - markdown LSP 失败不影响 Ontology 诊断（反之亦然）
 *  - 诊断附加管线（onAfterTool/attachToResult）与 MDLSPPlugin 同构，
 *    按既定取舍接受少量重复，以换取包与职责的解耦。
 *
 * 通过 `--plugin ontologylsp` 加载。
 *
 * v8.3 (Task #3196)：支持 instance_getter / access_mode / implement /
 * impltype 字段；新增 TM125–TM129 规则。
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Diagnostic } from "vscode-languageserver-types";
import {
  BasePlugin,
  createLogger,
  type PluginEnv,
  type HookHandler,
} from "@ai-setting/roy-bot-core";
import {
  createGlobalLSPManager,
  type LSPManager,
} from "@ai-setting/roy-bot-coder-harness";
import { analyzeOntology } from "../ontology/analyzer";
import { WorkspaceIndex } from "../workspace/index";
import { scanWorkspace, indexDocument } from "../workspace/scanner";
import { computeCrossFileDiagnostics } from "../workspace/cross-file";

export interface OntologyLSPPluginConfig {
  enabled?: boolean;
  preloadMode?: "startup" | "lazy" | "disabled";
  idleTimeout?: number;
  priority?: number;
  /**
   * 是否附带 markdown 基础诊断（坏链接 / 未用定义等）。默认 true。
   * 关掉则只产出 Ontology TM 诊断。
   */
  markdownBaseDiagnostics?: boolean;
  /**
   * 工作区根目录。设置后启用跨文件诊断（TM010 唯一性 / TM021 跨文件引用）。
   * 插件会在首次诊断时扫描该目录建立全局符号表。
   */
  workspaceRoot?: string;
  /**
   * 是否启用跨文件诊断。默认在 workspaceRoot 存在时为 true。
   */
  crossFileDiagnostics?: boolean;
}

export class OntologyLSPPlugin extends BasePlugin {
  readonly name = "OntologyLSPPlugin";
  readonly version = "0.2.0";
  readonly description =
    "Typed Markdown Ontology plugin (markdown base diagnostics + TM001-TM129 ontology constraints, v8.3 schema enhancements — instance_getter / access_mode / implement / impltype)";
  readonly priority: number;

  private config: OntologyLSPPluginConfig;
  private logger: ReturnType<typeof createLogger>;
  private lspManager!: LSPManager;
  private lspReady = false;
  private _markdownBase: boolean;
  private _crossFile: boolean;
  private _wsRoot?: string;
  private wsIndex?: WorkspaceIndex;
  private wsScanPromise?: Promise<void>;

  static isSupported(filePath: string): boolean {
    const ext = filePath.toLowerCase().slice(filePath.lastIndexOf("."));
    return ([".md", ".markdown"] as const).includes(ext as any);
  }

  constructor(config: OntologyLSPPluginConfig = {}) {
    super();
    this.config = config;
    this.priority = config.priority ?? 80;
    this._markdownBase = config.markdownBaseDiagnostics ?? true;
    this._wsRoot = config.workspaceRoot;
    this._crossFile = config.crossFileDiagnostics ?? Boolean(config.workspaceRoot);
    this.logger = createLogger("OntologyLSPPlugin");
  }

  init(env: PluginEnv): void | Promise<void> {
    this.lspManager = createGlobalLSPManager({
      idleTimeout: this.config.idleTimeout ?? 60000,
      maxConnections: 5,
      autoDownload: false,
    });

    env.registerHook({
      point: "tool:after.execute",
      priority: this.priority,
      handler: this.onAfterTool.bind(this) as HookHandler,
    });

    this.logger.info(
      `[OntologyLSPPlugin] Registered tool:after.execute hook (markdownBase=${this._markdownBase})`
    );

    if (this.config.preloadMode === "startup" && this._markdownBase) {
      this.prewarm(["markdown"]);
    }
  }

  async prewarm(languages?: string[]): Promise<void> {
    if (this.lspReady) return;
    try {
      await this.lspManager.prewarm(languages ?? ["markdown"]);
      this.lspReady = true;
    } catch (error) {
      this.logger.error(`[OntologyLSPPlugin] prewarm failed: ${error}`);
    }
  }

  async onAfterTool(ctx: any): Promise<void> {
    const data = ctx.data ?? ctx;
    const tool = data.tool;
    const args = data.args || {};
    const result = data.result;

    let toolName = "";
    if (typeof tool === "string") toolName = tool;
    else if (tool && typeof tool === "object") toolName = (tool as { name?: string }).name || "";

    if (toolName !== "write_file" && toolName !== "edit_file") return;

    const filePath = this.getTargetFilePath(toolName, args);
    if (!filePath || !OntologyLSPPlugin.isSupported(filePath)) return;

    try {
      const diagnostics = await this.getDiagnostics(filePath);
      if (diagnostics.length > 0 && result) {
        this.attachToResult(result, diagnostics);
      }
    } catch (error) {
      this.logger.warn(`onAfterTool failed for ${filePath}: ${error}`);
    }
  }

  private getTargetFilePath(
    toolName: string,
    args: Record<string, unknown>
  ): string | null {
    if (typeof args.path === "string") return args.path;
    if (toolName === "edit_file" && typeof args.filePath === "string") {
      return args.filePath;
    }
    return null;
  }

  /**
   * 合并 markdown LSP 诊断与 Ontology TM 诊断。两者独立，互不降级。
   */
  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    const out: Diagnostic[] = [];

    // markdown 基础诊断（可关闭）
    if (this._markdownBase) {
      try {
        out.push(...(await this.lspManager.getDiagnostics(filePath)));
      } catch (error) {
        this.logger.error(
          `[OntologyLSPPlugin] markdown LSP failed for ${filePath}: ${error}`
        );
      }
    }

    // Ontology TM 诊断（文件级）+ 跨文件诊断（workspace 级）
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const { document, diagnostics } = analyzeOntology(filePath, content);
      out.push(...diagnostics);

      if (this._crossFile) {
        const index = await this.ensureWorkspaceIndex();
        if (index) {
          const abs = path.resolve(filePath);
          // 让索引反映本文件的最新内容（写入后可能已变更）
          indexDocument(index, abs, content);
          out.push(...computeCrossFileDiagnostics(index, abs, document));
        }
      }
    } catch (error) {
      this.logger.warn(
        `[OntologyLSPPlugin] ontology analyze failed for ${filePath}: ${error}`
      );
    }

    return out;
  }

  /**
   * 惰性扫描工作区，建立全局符号表（仅扫描一次）。失败返回 undefined。
   */
  private async ensureWorkspaceIndex(): Promise<WorkspaceIndex | undefined> {
    if (!this._crossFile || !this._wsRoot) return undefined;
    if (this.wsIndex) return this.wsIndex;
    if (!this.wsScanPromise) {
      const root = this._wsRoot;
      this.wsScanPromise = (async () => {
        try {
          this.wsIndex = await scanWorkspace(root);
          this.logger.info(
            `[OntologyLSPPlugin] workspace indexed: ${this.wsIndex.fileCount} file(s) under ${root}`
          );
        } catch (error) {
          this.logger.error(
            `[OntologyLSPPlugin] workspace scan failed for ${root}: ${error}`
          );
        }
      })();
    }
    await this.wsScanPromise;
    return this.wsIndex;
  }

  private attachToResult(
    result: {
      output?: string | Record<string, unknown>;
      metadata?: Record<string, unknown>;
    },
    diagnostics: Diagnostic[]
  ): void {
    const text = this.formatDiagnostics(diagnostics);
    if (result.output === undefined) {
      result.output = text;
    } else if (typeof result.output === "string") {
      result.output = result.output + "\n\n" + text;
    } else if (typeof result.output === "object") {
      result.output = {
        ...result.output,
        ontologyDiagnostics: diagnostics,
        ontologyDiagnosticText: text,
      };
    }
  }

  private formatDiagnostics(diagnostics: Diagnostic[]): string {
    if (diagnostics.length === 0) return "";
    const lines: string[] = [];
    lines.push("## Ontology LSP Diagnostics");
    lines.push(`Found ${diagnostics.length} diagnostic(s):\n`);
    for (const d of diagnostics) {
      const sev = this.getSeverityText(d.severity);
      const { start } = d.range;
      const code = d.code ? ` ${d.code}` : "";
      lines.push(`- **[${sev}]${code}** ${d.message}`);
      lines.push(`  - Location: Line ${start.line + 1}, Col ${start.character + 1}`);
      if (d.source) lines.push(`  - Source: ${d.source}`);
    }
    return lines.join("\n");
  }

  private getSeverityText(severity: number | undefined): string {
    switch (severity) {
      case 1: return "Error";
      case 2: return "Warning";
      case 3: return "Information";
      case 4: return "Hint";
      default: return `Unknown(${severity ?? "undefined"})`;
    }
  }

  getStatus(): Record<string, unknown> {
    return {
      name: this.name,
      version: this.version,
      enabled: this.config.enabled,
      preloadMode: this.config.preloadMode,
      lspReady: this.lspReady,
      markdownBaseDiagnostics: this._markdownBase,
      crossFileDiagnostics: this._crossFile,
      workspaceRoot: this._wsRoot,
      workspaceIndexed: this.wsIndex?.fileCount ?? 0,
    };
  }

  async dispose(): Promise<void> {
    try {
      await this.lspManager?.dispose();
    } catch (error) {
      this.logger.warn(`[OntologyLSPPlugin] dispose failed: ${error}`);
    }
    this.lspReady = false;
  }
}

export function createOntologyLSPPlugin(
  config?: OntologyLSPPluginConfig
): OntologyLSPPlugin {
  return new OntologyLSPPlugin(config);
}
