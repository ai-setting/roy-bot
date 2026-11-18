/**
 * @fileoverview Header 层级 → part-of 关系推断
 *
 * 约定：更深层级的 header 是其最近上一级 header 的组成部分。
 *   # 财务报表
 *   ## 资产负债表      → 资产负债表 part-of 财务报表
 *
 * 通过维护一个 header 栈来确定每个 header 的父级。
 */

import type { PartOfRelation } from "./types";

const ATX_HEADER_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE_RE = /^\s{0,3}(`{3,}|~{3,})/;

interface HeaderNode {
  level: number;
  title: string;
}

/**
 * 解析 Header 层级，产出 part-of 关系（child part-of parent）。
 */
export function parsePartOf(content: string): PartOfRelation[] {
  const rels: PartOfRelation[] = [];
  const lines = content.split("\n");
  const stack: HeaderNode[] = [];

  let inFence = false;
  let fenceMarker = "";

  for (let line = 0; line < lines.length; line++) {
    const text = lines[line];

    // 跳过代码块内容
    const fence = FENCE_RE.exec(text);
    if (fence) {
      if (!inFence) {
        inFence = true;
        fenceMarker = fence[1][0];
      } else if (text.trimStart().startsWith(fenceMarker)) {
        inFence = false;
      }
      continue;
    }
    if (inFence) continue;

    const m = ATX_HEADER_RE.exec(text);
    if (!m) continue;

    const level = m[1].length;
    const title = m[2].trim();
    if (!title) continue;

    // 弹出 >= 当前层级的节点，栈顶即为父
    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    const parent = stack.length > 0 ? stack[stack.length - 1] : null;
    if (parent) {
      rels.push({
        child: title,
        parent: parent.title,
        range: {
          start: { line, character: 0 },
          end: { line, character: text.length },
        },
      });
    }

    stack.push({ level, title });
  }

  return rels;
}
