/**
 * @fileoverview CrossLangResolver - 跨语言实体引用解析器
 * 
 * 在 Markdown 文件中引用其他语言（TS/Py）的实体时，
 * 提供跨语言实体定义查找功能
 */

import type { LanguageLSPPlugin } from "../base-plugin";
import type { DocumentSymbol } from "vscode-languageserver-types";

/**
 * 跨语言查询配置
 */
export interface CrossLangQuery {
  /** 实体名称 */
  entityName: string;
  /** 命名空间（可选）*/
  namespace?: string;
  /** 文件路径（用于定位工作区）*/
  filePath?: string;
}

/**
 * 跨语言查询结果
 */
export interface CrossLangResult {
  /** 是否找到 */
  found: boolean;
  /** 语言插件名称 */
  language: string;
  /** 实体名称 */
  entityName: string;
  /** 定义位置（如果找到）*/
  location?: {
    filePath: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
  };
  /** 实体类型（如 function, class, variable 等）*/
  kind?: string;
  /** 错误信息（如果未找到）*/
  error?: string;
}

/**
 * 跨语言实体引用解析器
 * 
 * 提供跨语言实体查找功能，支持：
 * - 在 TypeScript/JavaScript 中查找符号
 * - 在 Python 中查找符号
 * - 跨多语言搜索实体定义
 */
export class CrossLangResolver {
  /** 注册的语言插件 */
  private plugins: Map<string, LanguageLSPPlugin>;

  constructor() {
    this.plugins = new Map();
  }

  /**
   * 注册语言插件
   * @param languageId 语言标识符（如 "typescript", "python"）
   * @param plugin 语言插件实例
   */
  registerLanguage(languageId: string, plugin: LanguageLSPPlugin): void {
    this.plugins.set(languageId, plugin);
  }

  /**
   * 取消注册语言插件
   * @param languageId 语言标识符
   */
  unregisterLanguage(languageId: string): void {
    this.plugins.delete(languageId);
  }

  /**
   * 解析实体引用
   * @param entityName 实体名称
   * @param languageId 语言标识符
   * @param filePath 文件路径（可选）
   */
  async resolveEntity(
    entityName: string,
    languageId: string,
    filePath?: string
  ): Promise<CrossLangResult> {
    const plugin = this.plugins.get(languageId);
    if (!plugin) {
      throw new Error(`Language plugin not registered: ${languageId}`);
    }

    try {
      // 获取该语言的所有符号
      const symbols = await plugin.getSymbols?.(filePath ?? "");
      
      if (!symbols || symbols.length === 0) {
        return {
          found: false,
          language: languageId,
          entityName,
          error: "No symbols found in the workspace",
        };
      }

      // 查找匹配的实体
      const match = this.findSymbol(symbols, entityName);
      
      if (match) {
        return {
          found: true,
          language: languageId,
          entityName,
          location: {
            filePath: filePath ?? "",
            range: match.range ?? { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
          },
          kind: this.getSymbolKindName(match.kind),
        };
      }

      return {
        found: false,
        language: languageId,
        entityName,
        error: `Entity '${entityName}' not found in ${languageId}`,
      };
    } catch (error) {
      return {
        found: false,
        language: languageId,
        entityName,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * 在所有注册的语言中搜索实体
   * @param entityName 实体名称
   * @param filePath 文件路径（可选）
   */
  async resolveAllLanguages(
    entityName: string,
    filePath?: string
  ): Promise<CrossLangResult[]> {
    const results: CrossLangResult[] = [];

    for (const [languageId, plugin] of this.plugins) {
      const result = await this.resolveEntity(entityName, languageId, filePath);
      results.push(result);
    }

    return results;
  }

  /**
   * 检查实体是否在指定语言中定义
   * @param entityName 实体名称
   * @param languageId 语言标识符
   * @param filePath 文件路径（可选）
   */
  async isEntityDefined(
    entityName: string,
    languageId: string,
    filePath?: string
  ): Promise<boolean> {
    const result = await this.resolveEntity(entityName, languageId, filePath);
    return result.found;
  }

  /**
   * 在符号列表中查找匹配的符号
   */
  private findSymbol(
    symbols: DocumentSymbol[],
    entityName: string
  ): DocumentSymbol | undefined {
    // 直接匹配
    for (const symbol of symbols) {
      if (symbol.name === entityName) {
        return symbol;
      }

      // 递归搜索子符号
      if (symbol.children && symbol.children.length > 0) {
        const found = this.findSymbol(symbol.children, entityName);
        if (found) return found;
      }
    }

    return undefined;
  }

  /**
   * 获取符号类型名称
   */
  private getSymbolKindName(kind: number | undefined): string {
    if (kind === undefined) return "unknown";

    // SymbolKind 枚举值
    const kindMap: Record<number, string> = {
      1: "file",
      2: "module",
      3: "namespace",
      4: "package",
      5: "class",
      6: "method",
      7: "property",
      8: "field",
      9: "constructor",
      10: "enum",
      11: "interface",
      12: "function",
      13: "variable",
      14: "constant",
      15: "string",
      16: "number",
      17: "boolean",
      18: "array",
      19: "object",
      20: "key",
      21: "null",
      22: "enumMember",
      23: "event",
      24: "operator",
      25: "typeParameter",
    };

    return kindMap[kind] ?? `unknown(${kind})`;
  }

  /**
   * 获取所有已注册的语言
   */
  getRegisteredLanguages(): string[] {
    return Array.from(this.plugins.keys());
  }

  /**
   * 检查语言是否已注册
   */
  hasLanguage(languageId: string): boolean {
    return this.plugins.has(languageId);
  }
}
