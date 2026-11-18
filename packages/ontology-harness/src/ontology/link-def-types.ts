/**
 * @fileoverview Link Definition 类型解析
 *
 * Typed Markdown 用 Link Definition 的 title 来标注 Term 类型：
 *   [星科科技]: ./entity/star-tech.md "entity"
 *   [预警]:     ./operator/warning.md "operator"
 *
 * title 支持 "..." / '...' / (...) 三种包裹形式（同 CommonMark）。
 *
 * 新架构（SPG + TPG）只支持 entity 和 operator 两类：
 * - entity（SPG）：描述系统的空间构成、分类、特征
 * - operator（TPG）：描述系统的时间行为、事件、状态变迁
 */

import type { TermDefinition, TermType } from "./types";

const TERM_TYPES: ReadonlySet<string> = new Set([
  "entity",
  "operator",
]);

// link definition 行：  [label]: target  "title"?
//  - label: [] 内非 ] 文本
//  - target: 第一段非空白
//  - title: 可选，"..."/'...'/(...)
const LINK_DEF_RE =
  /^\s{0,3}\[([^\]]+)\]:\s*(\S+)(?:\s+(?:"([^"]*)"|'([^']*)'|\(([^)]*)\)))?\s*$/;

/**
 * 解析文档中的所有 Link Definition，按 title 归类 Term 类型。
 *
 * - title 是 entity/operator 之一 → type 设为对应值
 * - title 存在但非法 → type=undefined，rawTitle 保留原值（供 TM003 诊断）
 * - 无 title → type=undefined，rawTitle=undefined（供 TM002 诊断）
 */
export function parseTermDefinitions(content: string): TermDefinition[] {
  const defs: TermDefinition[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = LINK_DEF_RE.exec(line);
    if (!m) continue;

    const label = m[1];
    const target = m[2];
    const rawTitle = m[3] ?? m[4] ?? m[5];
    const type: TermType | undefined =
      rawTitle !== undefined && TERM_TYPES.has(rawTitle)
        ? (rawTitle as TermType)
        : undefined;

    defs.push({
      label,
      target,
      type,
      rawTitle,
      range: {
        start: { line: i, character: 0 },
        end: { line: i, character: line.length },
      },
    });
  }

  return defs;
}
