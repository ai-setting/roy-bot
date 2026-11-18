/**
 * @fileoverview 三元组解析
 *
 * 支持两种书写形式（设计文档 §3.1）：
 *  - 谓语在尾部： `[S] <连接词> [O] 的 [R]`   （是 / 属于 / has ...）
 *  - 谓语在中部： `[S] 的 [R] 是 [O]`
 *
 * subject / object 为 entity，predicate 为 relation 或 operator。
 */

import type { Range } from "vscode-languageserver-types";
import type { Triple } from "./types";

// link definition 行（[label]: ...），三元组解析应跳过
const LINK_DEF_LINE_RE = /^\s{0,3}\[[^\]]+\]:\s*\S+/;

// 谓语在中部： [S] 的 [R] 是 [O]
const FORM_B_RE = /\[([^\]]+)\]\s*的\s*\[([^\]]+)\]\s*是\s*\[([^\]]+)\]/g;
// 谓语在尾部： [S] <非括号连接词> [O] 的 [R]
const FORM_A_RE = /\[([^\]]+)\]\s*[^[\]]*?\[([^\]]+)\]\s*的\s*\[([^\]]+)\]/g;

interface RoleLabels {
  subject: string;
  object: string;
  predicate: string;
}

/**
 * 解析文档中的所有三元组。
 */
export function parseTriples(content: string): Triple[] {
  const triples: Triple[] = [];
  const lines = content.split("\n");

  for (let line = 0; line < lines.length; line++) {
    const text = lines[line];
    if (LINK_DEF_LINE_RE.test(text)) continue;

    // 已占用的 [start,end) 区间，用于避免 Form A 与 Form B 重叠重复
    const claimed: Array<[number, number]> = [];

    // 先匹配更具体的 Form B（谓语在中部）
    collect(text, line, FORM_B_RE, (m) => ({
      subject: m[1],
      predicate: m[2],
      object: m[3],
    }), claimed, triples);

    // 再匹配 Form A（谓语在尾部），跳过与 Form B 重叠的区间
    collect(text, line, FORM_A_RE, (m) => ({
      subject: m[1],
      object: m[2],
      predicate: m[3],
    }), claimed, triples);
  }

  // 按出现顺序排序（行内按 character）
  triples.sort((a, b) =>
    a.range.start.line - b.range.start.line ||
    a.range.start.character - b.range.start.character
  );
  return triples;
}

function collect(
  text: string,
  line: number,
  re: RegExp,
  toRoles: (m: RegExpExecArray) => RoleLabels,
  claimed: Array<[number, number]>,
  out: Triple[]
): void {
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = m.index + m[0].length;
    if (overlaps(claimed, start, end)) continue;
    claimed.push([start, end]);

    const roles = toRoles(m);
    const parts = locateParts(text, start, m[0], roles);

    out.push({
      subject: roles.subject,
      object: roles.object,
      predicate: roles.predicate,
      raw: m[0],
      range: {
        start: { line, character: start },
        end: { line, character: end },
      },
      parts: {
        subject: toRange(line, parts.subject),
        object: toRange(line, parts.object),
        predicate: toRange(line, parts.predicate),
      },
    });
  }
}

function overlaps(claimed: Array<[number, number]>, s: number, e: number): boolean {
  return claimed.some(([cs, ce]) => s < ce && cs < e);
}

/**
 * 在匹配文本中按出现顺序定位三个 `[label]` 的字符区间（相对整行）。
 *
 * 注意：subject/object/predicate 在原文中的**物理顺序**取决于书写形式，
 * 这里按它们在 raw 文本里第一次出现的位置定位，cursor 单调前进以处理重复 label。
 */
function locateParts(
  text: string,
  matchStart: number,
  raw: string,
  roles: RoleLabels
): { subject: [number, number]; object: [number, number]; predicate: [number, number] } {
  // 按 raw 中出现顺序排列三个角色
  const ordered: Array<{ key: keyof RoleLabels; label: string; pos: number }> = (
    ["subject", "object", "predicate"] as const
  ).map((key) => ({ key, label: roles[key], pos: raw.indexOf(`[${roles[key]}]`) }));
  ordered.sort((a, b) => a.pos - b.pos);

  const result: Record<string, [number, number]> = {};
  let cursor = 0;
  for (const { key, label } of ordered) {
    const idx = raw.indexOf(`[${label}]`, cursor);
    const absStart = matchStart + idx;
    const absEnd = absStart + label.length + 2; // 含 []
    result[key] = [absStart, absEnd];
    cursor = idx + label.length + 2;
  }

  return {
    subject: result.subject,
    object: result.object,
    predicate: result.predicate,
  };
}

function toRange(line: number, span: [number, number]): Range {
  return {
    start: { line, character: span[0] },
    end: { line, character: span[1] },
  };
}
