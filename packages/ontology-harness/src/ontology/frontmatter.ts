/**
 * @fileoverview frontmatter 解析
 *
 * 识别文件开头的 YAML frontmatter（`---` 包裹），提取 type/domain 等字段。
 * Typed Markdown 用 `type: model` / `type: operator` 标注文件角色。
 *
 * v8.3 (Task #3196)：额外提取 Entity 的 `instance_getter` 块和
 * Operator 的 `implement` 块。两者皆为可选，对应规则 TM127/TM128
 * 在 diagnostics.ts 中实现。
 */

import { parse as parseYaml } from "yaml";
import {
  type Frontmatter,
  type InstanceGetter,
  type Implement,
  type AccessMode,
  type ImplType,
  VALID_ACCESS_MODES,
  VALID_IMPLTYPES,
} from "./types";

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

/**
 * 从 raw 对象解析 v8.3 `instance_getter` 块。
 *
 * 规整化：必须是对象；`access_mode` 必须是合法 enum；其它字段自由保留。
 * 解析失败 / 字段非法时返回 undefined（由 diagnostics.ts 报更具体的错误）。
 */
function parseInstanceGetter(raw: unknown): InstanceGetter | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const out: InstanceGetter = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v;
  }
  if (
    typeof out.access_mode === "string" &&
    !VALID_ACCESS_MODES.has(out.access_mode as AccessMode)
  ) {
    // 非法 enum 仍保留 raw（让 diagnostics.ts 报 TM127-类似规则）
    // 但保留为字符串以便诊断。
  }
  return out;
}

/**
 * 从 raw 对象解析 v8.3 `implement` 块。
 *
 * 规整化：必须是对象；`impltype` 必须是合法 enum；其它字段自由保留。
 */
function parseImplement(raw: unknown): Implement | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const out: Implement = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = v;
  }
  return out;
}

/**
 * 解析文件开头的 frontmatter。
 *
 * 仅当 `---` 出现在文件**第一行**时才视为 frontmatter；
 * 非法 YAML 不抛错，present 仍为 true 但字段为 undefined。
 */
export function parseFrontmatter(content: string): Frontmatter {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { present: false, raw: {} };
  }

  const body = match[1];
  // 计算 range：第 0 行是开头 `---`，结束 `---` 在 body 行数 + 1 处
  const bodyLines = body.split("\n").length;
  const endLine = bodyLines + 1; // 0:开头--- , 1..bodyLines:内容, bodyLines+1:结尾---

  let raw: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(body);
    if (parsed && typeof parsed === "object") {
      raw = parsed as Record<string, unknown>;
    }
  } catch {
    // 非法 YAML：保持空 raw
  }

  const typeVal = raw.type;
  const domainVal = raw.domain;
  const instanceGetter = parseInstanceGetter(raw.instance_getter);
  const implement = parseImplement(raw.implement);

  const fm: Frontmatter = {
    present: true,
    type: typeof typeVal === "string" ? typeVal : undefined,
    domain: typeof domainVal === "string" ? domainVal : undefined,
    raw,
    range: {
      start: { line: 0, character: 0 },
      end: { line: endLine, character: 3 },
    },
  };
  if (instanceGetter !== undefined) fm.instance_getter = instanceGetter;
  if (implement !== undefined) fm.implement = implement;
  return fm;
}

// Re-export for tests
export { VALID_ACCESS_MODES, VALID_IMPLTYPES };
export type { AccessMode, ImplType };
