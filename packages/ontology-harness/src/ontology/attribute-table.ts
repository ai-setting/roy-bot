/**
 * @fileoverview 属性表格解析器
 *
 * 从 Entity 文件的 `## 属性` 标题下的 Markdown 表格中解析出 Attribute 数组。
 *
 * 语法示例：
 *
 * ```markdown
 * ## 属性
 *
 * | 属性名 | 类型 | 必填 | 描述 | 示例/枚举值 |
 * |--------|------|------|------|-------------|
 * | 号牌号码 | string | 是 | 车辆号牌 | 京A·88888 |
 * | 车辆类型 | enum | 是 | 机动车分类 | [小型汽车], [大型汽车] |
 * | 核定载人数 | integer | 否 | 最大允许载客数量 | 5 |
 * | 所有人 | ref:驾驶人 | 否 | 车辆所有人 | [驾驶人] |
 * ```
 *
 * 表头列名映射（不区分列顺序）：
 * - 属性名/名称/name → name
 * - 类型/type → type（含 enum 值解析和 ref:xxx 解析）
 * - 必填/required → required（是/true → true）
 * - 描述/description → description
 * - 示例/枚举值/示例/枚举值/example → example（string）或 values（enum）
 */

import type { Attribute, AttributeType } from "./types";

/** 表头列名映射 */
const HEADER_ALIASES: Record<string, string> = {
  "属性名": "name",
  "名称": "name",
  "name": "name",
  "类型": "type",
  "type": "type",
  "必填": "required",
  "required": "required",
  "描述": "description",
  "description": "description",
  "示例": "example",
  "枚举值": "values",
  "示例/枚举值": "values",
  "example": "example",
  "values": "values",
};

/**
 * 从给定行号开始，解析一个 Markdown 表格行。
 * 返回单元格数组（去除首尾空白），若该行不是表格行则返回 null。
 */
function parseTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) return null;
  // 移除首尾 | 后按 | 分割
  const inner = trimmed.slice(1, -1);
  return inner.split("|").map((cell) => cell.trim());
}

/**
 * 判断一行是否为表格分隔行（|---|---|）。
 */
function isTableSeparator(line: string): boolean {
  const cells = parseTableRow(line);
  if (!cells) return false;
  return cells.every((cell) => /^-+\s*$/.test(cell));
}

/**
 * 在内容中查找 `## 属性` 标题，解析其后的 Markdown 表格。
 *
 * @param content markdown 文档内容
 * @param startLine 从哪一行开始搜索
 * @returns 解析出的 Attribute 列表
 */
export function parseAttributeTable(content: string, startLine: number): Attribute[] {
  const lines = content.split("\n");
  const attributes: Attribute[] = [];

  // 从 startLine 开始在 content 中搜索 ## 属性
  let i = startLine;
  for (; i < lines.length; i++) {
    if (lines[i].trim() === "## 属性" || lines[i].trim() === "## 属性 ") {
      break;
    }
  }

  if (i >= lines.length) return attributes; // 没找到 ## 属性

  i++; // 跳过 ## 属性 行

  // 跳过空行
  while (i < lines.length && lines[i].trim() === "") i++;

  if (i >= lines.length) return attributes;

  // 读取表头行
  const headerCells = parseTableRow(lines[i]);
  if (!headerCells) return attributes;
  i++;

  if (i >= lines.length) return attributes;

  // 跳过分隔行（|---|）
  if (i < lines.length && isTableSeparator(lines[i])) {
    i++;
  }

  // 跳过数据行之前的空行
  while (i < lines.length && lines[i].trim() === "") i++;

  // 映射列索引
  const colIndex: Record<string, number> = {};
  for (let ci = 0; ci < headerCells.length; ci++) {
    const mapped = HEADER_ALIASES[headerCells[ci]];
    if (mapped) {
      colIndex[mapped] = ci;
    }
  }

  // 必须要有 name 和 type 列
  if (colIndex["name"] === undefined || colIndex["type"] === undefined) {
    return attributes;
  }

  // 解析数据行
  while (i < lines.length) {
    const cells = parseTableRow(lines[i]);
    if (!cells) break; // 不是表格行，结束

    const name = cells[colIndex["name"]];
    if (!name) {
      i++;
      continue; // 空行跳过
    }

    const typeRaw = cells[colIndex["type"]] || "string";
    const type = typeRaw as AttributeType;

    const requiredStr = (colIndex["required"] !== undefined ? cells[colIndex["required"]] : "").toLowerCase();
    const required = requiredStr === "是" || requiredStr === "true" || requiredStr === "yes";

    const description = colIndex["description"] !== undefined ? cells[colIndex["description"]] : undefined;

    // 处理示例/枚举值列
    let example: string | undefined;
    let values: string[] | undefined;

    if (colIndex["values"] !== undefined) {
      const valuesRaw = cells[colIndex["values"]];
      if (valuesRaw) {
        if (type === "enum") {
          // 解析枚举值：逗号分隔，每个值去除首尾空白
          values = valuesRaw.split(",").map((v) => v.trim()).filter((v) => v.length > 0);
        } else {
          example = valuesRaw;
        }
      }
    } else if (colIndex["example"] !== undefined) {
      example = cells[colIndex["example"]] || undefined;
    }

    attributes.push({ name, type, required, description, example, values });
    i++;
  }

  return attributes;
}

/**
 * 兼容入口：从 markdown 内容中解析第一个 `## 属性` 表格。
 * 委托给 parseAttributeTable。
 */
export function parseAttributes(content: string): Attribute[] {
  return parseAttributeTable(content, 0);
}

/**
 * 在内容中查找所有 `## 属性` 标题并解析其下的表格。
 * 返回每个属性表格的解析结果及所在行号。
 */
export function parseAllAttributeTables(content: string): { attributes: Attribute[]; line: number }[] {
  const results: { attributes: Attribute[]; line: number }[] = [];
  const lines = content.split("\n");

  let i = 0;
  while (i < lines.length) {
    if (lines[i].trim() === "## 属性" || lines[i].trim() === "## 属性 ") {
      const lineNum = i;
      const attributes = parseAttributeTable(content, i);
      if (attributes.length > 0) {
        results.push({ attributes, line: lineNum });
      }
      // Skip past this section to find next ## 属性
      // parseAttributeTable processes from i to some point, but we can't know exactly
      // where the table ends, so we conservatively advance
      i++;
    } else {
      i++;
    }
  }

  return results;
}

// ============================================================================
// 类型工具函数
// ============================================================================

/** 合法 Attribute 类型集合 */
const VALID_ATTR_TYPES = new Set([
  "string",
  "integer",
  "number",
  "boolean",
  "date",
  "enum",
]);

/**
 * 规范化类型字符串为 AttributeType。
 * 支持基本类型和 ref:xxx 格式。
 */
export function normalizeType(raw: string): AttributeType | null {
  const trimmed = raw.trim().toLowerCase();

  if (VALID_ATTR_TYPES.has(trimmed)) {
    return trimmed as AttributeType;
  }

  // ref:{entityLabel}
  const refMatch = /^ref\s*:\s*(.+)$/i.exec(trimmed);
  if (refMatch) {
    const entityLabel = refMatch[1].trim();
    if (entityLabel) {
      return `ref:${entityLabel}` as AttributeType;
    }
  }

  return null; // 非法类型
}

/**
 * 解析 enum 类型的候选值，支持逗号分隔和 [Label] 语法。
 */
export function parseEnumValues(raw: string): string[] {
  const parts = raw.split(",");
  const values: string[] = [];

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    // [Label] 语法 → 提取 Label
    const bracketMatch = /^\[([^\]]+)\]$/.exec(trimmed);
    if (bracketMatch) {
      values.push(bracketMatch[1]);
    } else {
      values.push(trimmed);
    }
  }

  return values;
}

/**
 * 验证 attribute type 是否合法（用于 TM007 诊断）。
 */
export function isValidAttributeType(type: AttributeType): boolean {
  if (VALID_ATTR_TYPES.has(type)) return true;
  if (type.startsWith("ref:")) {
    const label = type.slice(4);
    return label.length > 0;
  }
  return false;
}
