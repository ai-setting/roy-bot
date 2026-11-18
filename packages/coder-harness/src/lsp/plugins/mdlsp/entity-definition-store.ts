/**
 * @fileoverview EntityDefinitionStore - 实体定义存储
 * 
 * 存储和管理跨语言的实体定义信息
 */

import type { Range } from "vscode-languageserver-types";

/**
 * 实体定义
 */
export interface EntityDefinition {
  /** 实体名称 */
  name: string;
  /** 实体类型（function, class, variable 等）*/
  kind: string;
  /** 所属语言 */
  language: string;
  /** 定义文件路径 */
  filePath: string;
  /** 定义位置 */
  range: Range;
}

/**
 * 实体定义存储
 * 
 * 用于存储和管理跨语言的实体定义信息，
 * 支持按名称和语言快速查询
 */
export class EntityDefinitionStore {
  /** 实体定义存储，结构：Map<language, Map<name, EntityDefinition[]>> */
  private definitions: Map<string, Map<string, EntityDefinition[]>>;

  constructor() {
    this.definitions = new Map();
  }

  /**
   * 添加实体定义
   */
  addDefinition(definition: EntityDefinition): void {
    const { name, language } = definition;

    if (!this.definitions.has(language)) {
      this.definitions.set(language, new Map());
    }

    const langMap = this.definitions.get(language)!;
    if (!langMap.has(name)) {
      langMap.set(name, []);
    }

    langMap.get(name)!.push(definition);
  }

  /**
   * 检查实体是否存在
   */
  has(name: string, language: string): boolean {
    const langMap = this.definitions.get(language);
    if (!langMap) return false;
    return langMap.has(name);
  }

  /**
   * 获取实体定义（返回第一个）
   */
  get(name: string, language: string): EntityDefinition | undefined {
    const langMap = this.definitions.get(language);
    if (!langMap) return undefined;

    const definitions = langMap.get(name);
    if (!definitions || definitions.length === 0) return undefined;

    return definitions[0];
  }

  /**
   * 获取实体的所有定义
   */
  getAll(name: string, language: string): EntityDefinition[] {
    const langMap = this.definitions.get(language);
    if (!langMap) return [];

    return langMap.get(name) ?? [];
  }

  /**
   * 移除实体定义
   */
  removeDefinition(name: string, language: string): void {
    const langMap = this.definitions.get(language);
    if (!langMap) return;

    langMap.delete(name);

    // 如果语言分类为空，移除整个语言分类
    if (langMap.size === 0) {
      this.definitions.delete(language);
    }
  }

  /**
   * 清空所有定义
   */
  clear(): void {
    this.definitions.clear();
  }

  /**
   * 获取所有已注册的语言
   */
  getLanguages(): string[] {
    return Array.from(this.definitions.keys());
  }

  /**
   * 获取实体总数
   */
  size(): number {
    let count = 0;
    for (const langMap of this.definitions.values()) {
      count += langMap.size;
    }
    return count;
  }
}
