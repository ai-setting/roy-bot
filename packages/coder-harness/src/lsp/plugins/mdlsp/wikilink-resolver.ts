/**
 * @fileoverview Wikilink 解析器
 * 
 * 提取和验证 Markdown 中的维基链接 [[EntityName]]
 */

import type { Range } from "vscode-languageserver-types";

/**
 * 维基链接实体
 */
export interface WikilinkEntity {
  /** 原始文本 */
  raw: string;
  /** 实体名称（不含命名空间）*/
  entityName: string;
  /** 命名空间（如 "module/"）*/
  namespace?: string;
  /** 在文档中的位置 */
  range: Range;
}

/**
 * 维基链接解析器
 */
export class WikilinkResolver {
  /** 维基链接匹配正则 */
  private static readonly WIKILINK_PATTERN = /\[\[([^\]]+)\]\]/g;

  /**
   * 从文本内容中提取所有维基链接
   */
  extractWikilinks(content: string): WikilinkEntity[] {
    const entities: WikilinkEntity[] = [];
    const pattern = new RegExp(WikilinkResolver.WIKILINK_PATTERN.source, "g");

    let match: RegExpExecArray | null;
    while ((match = pattern.exec(content)) !== null) {
      const fullMatch = match[0];
      const inner = match[1];

      // 解析命名空间
      const parts = inner.split("/");
      let namespace: string | undefined;
      let entityName: string;

      if (parts.length > 1) {
        namespace = parts[0];
        entityName = parts.slice(1).join("/");
      } else {
        entityName = inner;
      }

      // 计算位置
      const range = this.calculateRange(content, match.index, fullMatch);

      entities.push({
        raw: fullMatch,
        entityName,
        namespace,
        range,
      });
    }

    return entities;
  }

  /**
   * 计算维基链接在文档中的位置
   */
  private calculateRange(content: string, matchIndex: number, fullMatch: string): Range {
    // 找到匹配开始位置之前的换行符数量
    const textBeforeMatch = content.substring(0, matchIndex);
    const lines = textBeforeMatch.split("\n");
    const startLine = lines.length - 1;
    const startCharacter = lines[lines.length - 1].length;

    // 计算结束位置
    const endCharacter = startCharacter + fullMatch.length;

    return {
      start: { line: startLine, character: startCharacter },
      end: { line: startLine, character: endCharacter },
    };
  }

  /**
   * 验证实体名称是否有效
   */
  validateEntityName(name: string): boolean {
    if (!name || name.length === 0) {
      return false;
    }

    // 必须以字母或下划线开头
    if (!/^[a-zA-Z_]/.test(name)) {
      return false;
    }

    // 只能包含字母、数字、下划线、连字符
    if (!/^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(name)) {
      return false;
    }

    return true;
  }
}
