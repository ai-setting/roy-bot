/**
 * @fileoverview EntityReferenceChecker - 实体引用检查器
 * 
 * 检查 Markdown 中的实体引用是否在目标语言中定义
 */

import type { WikilinkEntity } from "./wikilink-resolver";
import { EntityDefinitionStore, type EntityDefinition } from "./entity-definition-store";

/**
 * 引用检查结果
 */
export interface ReferenceCheckResult {
  /** 实体名称 */
  entityName: string;
  /** 命名空间（如果有）*/
  namespace?: string;
  /** 是否已定义 */
  isDefined: boolean;
  /** 定义文件路径（如果已定义）*/
  filePath?: string;
  /** 提示信息 */
  message: string;
  /** 实体类型（如果已定义）*/
  kind?: string;
}

/**
 * 实体引用检查器
 * 
 * 用于检查 Markdown 中的 [[Entity]] 引用是否在
 * TypeScript 或 Python 等语言中定义
 */
export class EntityReferenceChecker {
  /** 实体定义存储 */
  private store: EntityDefinitionStore;

  constructor() {
    this.store = new EntityDefinitionStore();
  }

  /**
   * 注册实体定义
   */
  addEntity(name: string, language: string, filePath: string): void {
    const definition: EntityDefinition = {
      name,
      kind: "unknown",
      language,
      filePath,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
    };
    this.store.addDefinition(definition);
  }

  /**
   * 检查实体是否已定义
   */
  isDefined(name: string, language: string, namespace?: string): boolean {
    const effectiveName = namespace ? `${namespace}/${name}` : name;
    return this.store.has(effectiveName, language);
  }

  /**
   * 检查单个引用
   */
  checkReference(name: string, language: string, namespace?: string): ReferenceCheckResult {
    const effectiveName = namespace ? `${namespace}/${name}` : name;
    const definition = this.store.get(effectiveName, language);

    if (definition) {
      return {
        entityName: name,
        namespace,
        isDefined: true,
        filePath: definition.filePath,
        message: `[[${effectiveName}]] - Defined in ${language}`,
        kind: definition.kind,
      };
    }

    return {
      entityName: name,
      namespace,
      isDefined: false,
      message: `[[${effectiveName}]] - Entity not found in ${language}`,
    };
  }

  /**
   * 批量检查维基链接引用
   */
  checkWikilinkReferences(wikilinks: WikilinkEntity[], language: string): ReferenceCheckResult[] {
    return wikilinks.map((wikilink) =>
      this.checkReference(wikilink.entityName, language, wikilink.namespace)
    );
  }

  /**
   * 清空所有注册
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * 获取已注册的语言
   */
  getRegisteredLanguages(): string[] {
    return this.store.getLanguages();
  }
}
