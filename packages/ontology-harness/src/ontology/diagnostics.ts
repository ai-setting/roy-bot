/**
 * @fileoverview Ontology 约束诊断（TM001–TM129）
 *
 * v8.3 schema enhancements（Task #3196, 飞书设计文档 TI6ldrfADoBGoOxFCYgcAX7fn2c）：
 *  | TM125 | 同 domain Operator.output_attributes 同名同类型但 link target 不同 | Error   |
 *  | TM126 | Operator A 的 output 与 Operator B 的 input 同名同类型同 link → 链式提示 | Warning |
 *  | TM127 | Operator.implement.impltype 必须是合法 enum（mcp/tool/skill/http-api/coding）| Error  |
 *  | TM128 | impltype 对应的 endpoint 字段必须存在且非空                       | Error   |
 *  | TM129 | link markdown 格式校验（v8.2 §1.10/1.11）                          | Error   |
 *
 * 历史 v8.0 约束清单：
 *  | TM001 | model 文件必须有 type: model                                     | Error   |
 *  | TM002 | Link Definition 必须有 title                                     | Warning |
 *  | TM003 | title 必须是 entity 或 operator                                  | Error   |
 *  | TM007 | Attribute type 必须是合法值                                     | Error   |
 *  | TM008 | ref Attribute 引用的实体必须在 model 中定义为 entity             | Error   |
 *  | TM009 | 实例必须提供 model 中必填的 Attribute                           | Error   |
 *  | TM010 | 实例的 Attribute 值与其 type 定义匹配                           | Error   |
 *  | TM011 | 三元组 predicate 必须是 operator（SPG 侧禁止三元组）              | Error   |
 *
 * 注意：TM125/TM126 是**跨文件**检查，需要工作区索引；当前单文件入口在
 * 一次调用中只贡献"自身信息"，最终一致性由 WorkspaceIndex 上的 crossFile
 * 钩子负责（见 workspace/cross-file.ts）。
 *
 * TM127/TM128 是单文件检查（frontmatter.implement），立即生效。
 * TM129 是单文件 link 格式校验，立即生效。
 */

import path from "node:path";
import type { Diagnostic } from "vscode-languageserver-types";
import {
  type OntologyDocument,
  type TermType,
  type AttributeType,
  VALID_ACCESS_MODES,
  VALID_IMPLTYPES,
  IMPLTYPE_REQUIRED_FIELD,
} from "./types";

const SEVERITY_ERROR = 1;
const SEVERITY_WARNING = 2;

/**
 * v8.3 — 仅匹配严格的 markdown hyperlink 形式 `[label](path "title")` 或
 * `[label](path)`，路径不能为空。TM129 用此模式快速判定 link 是否良构。
 */
const _LINK_PATTERN = /^\[(?:[^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/;

/**
 * v8.3 (Task #3200) — TM129 扩展：Link Definition `[label]: path` 的 target
 * 必须是合法路径形式：相对路径（./x, ../x, x）、绝对路径（/abs）、或 URL scheme
 * （http://, https://, mailto:, file://, ftp://）。
 *
 * 这是一个**轻量**路径合法性检查，与现有 parser 正则互补：
 *  - parser 正则 `\S+` 已保证非空白 / 非空。
 *  - 本检查进一步保证 target 含**至少一段有意义**的路径 / URL 主体。
 */
const _LINK_DEF_TARGET_RE = /^(?:\.{0,2}\/|\/|[a-zA-Z][a-zA-Z0-9+.-]*:\/\/)/;

/** 合法的 Attribute type 值（不含 ref:xxx） */
const VALID_ATTR_TYPES = new Set<string>([
  "string",
  "integer",
  "number",
  "boolean",
  "date",
  "enum",
]);

/** 判断文件名是否表示一个 model 文件（用于 TM001） */
export function looksLikeModelFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  // model.md / xxx-model.md / xxx_model.md
  return /(^|[-_])model\.md$/.test(base);
}

/**
 * 基于已解析的 OntologyDocument 计算 TM 诊断。
 */
export function computeDiagnostics(doc: OntologyDocument): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  // 符号表：label → 类型
  const symbolType = new Map<string, TermType>();
  for (const def of doc.definitions) {
    if (def.type) symbolType.set(def.label, def.type);
  }

  // TM001: model 文件必须有 type: model
  if (looksLikeModelFile(doc.filePath) && doc.frontmatter.type !== "model") {
    diagnostics.push({
      code: "TM001",
      severity: SEVERITY_ERROR,
      source: "Ontology",
      message: "model 文件必须在 frontmatter 中声明 `type: model`",
      range: doc.frontmatter.range ?? {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    });
  }

  // TM002 / TM003: Link Definition title
  for (const def of doc.definitions) {
    if (def.rawTitle === undefined) {
      diagnostics.push({
        code: "TM002",
        severity: SEVERITY_WARNING,
        source: "Ontology",
        message: `Link Definition [${def.label}] 缺少类型 title（应为 "entity"/"operator"）`,
        range: def.range,
      });
    } else if (def.type === undefined) {
      diagnostics.push({
        code: "TM003",
        severity: SEVERITY_ERROR,
        source: "Ontology",
        message: `非法的 Link Definition title "${def.rawTitle}"，必须是 entity/operator 之一`,
        range: def.range,
      });
    }
  }

  // TM011（原 TM004）: 三元组谓语必须是 operator（SPG 侧禁止三元组）
  for (const triple of doc.triples) {
    const predType = symbolType.get(triple.predicate);
    if (predType !== "operator") {
      diagnostics.push({
        code: "TM011",
        severity: SEVERITY_ERROR,
        source: "Ontology",
        message:
          predType === undefined
            ? `三元组谓语 [${triple.predicate}] 未定义（应为 operator）`
            : `三元组谓语 [${triple.predicate}] 类型为 ${predType}，应为 operator`,
        range: triple.parts.predicate,
      });
    }
  }

  // TM007: Attribute type 必须是合法值
  for (const attr of doc.attributes) {
    if (!isValidAttributeType(attr.type)) {
      diagnostics.push({
        code: "TM007",
        severity: SEVERITY_ERROR,
        source: "Ontology",
        message: `Attribute [${attr.name}] 类型 "${attr.type}" 不合法，必须是 string/integer/number/boolean/date/enum 或 ref:xxx`,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });
    }
  }

  // TM008: ref Attribute 引用的实体必须在 model 中定义为 entity
  for (const attr of doc.attributes) {
    if (attr.type.startsWith("ref:")) {
      const entityLabel = attr.type.slice(4);
      if (!entityLabel) continue; // 空 ref，TM007 已覆盖

      const refType = symbolType.get(entityLabel);
      if (refType !== "entity") {
        diagnostics.push({
          code: "TM008",
          severity: SEVERITY_ERROR,
          source: "Ontology",
          message:
            refType === undefined
              ? `Attribute [${attr.name}] 的 ref 引用 "${entityLabel}" 未定义为 entity`
              : `Attribute [${attr.name}] 的 ref 引用 "${entityLabel}" 类型为 ${refType}，应为 entity`,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
        });
      }
    }
  }

  // ----------------------------------------------------------------
  // v8.3 (Task #3196) — TM125 / TM126 / TM127 / TM128 / TM129
  // ----------------------------------------------------------------

  // TM127 / TM128 — Operator.implement 块字段校验（单文件）
  if (doc.frontmatter.implement !== undefined) {
    const implTypeImpls = checkImplementImpltype(doc.frontmatter.implement);
    diagnostics.push(...implTypeImpls);
  }

  // instance_getter.access_mode 必须在合法 enum 内
  // （无独立规则码，归到 TM127 同名 enum 校验家族 — 引用 v8.3 §1.3）
  if (doc.frontmatter.instance_getter !== undefined) {
    const getter = doc.frontmatter.instance_getter;
    if (
      typeof getter.access_mode === "string" &&
      !VALID_ACCESS_MODES.has(
        getter.access_mode as (typeof VALID_ACCESS_MODES extends Set<infer T> ? T : never),
      )
    ) {
      diagnostics.push({
        code: "TM127",
        severity: SEVERITY_ERROR,
        source: "Ontology",
        message: `instance_getter.access_mode "${getter.access_mode}" 不合法（v8.3 §1.3 — 必须是 http-api/mcp/tool/skill/coding 之一）`,
        range:
          doc.frontmatter.range ?? {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
      });
    }
  }

  // TM129 — Attribute 表格中 link 字段的 markdown hyperlink 格式校验（v8.3 §1.10）
  // 注：TM129 的目标不是 Link Definition（`[label]: path "title"`），而是属性表中
  // 通过 `link:` 字段嵌入的 markdown hyperlink，如 `[label](../path/to/file.md)`。
  // 此处对每个 attribute 的 example 字段进行 `[label](path "title")` 形式检查。
  for (const attr of doc.attributes) {
    if (typeof attr.example === "string" && attr.example.includes("](")) {
      if (!isWellFormedLink(attr.example)) {
        diagnostics.push({
          code: "TM129",
          severity: SEVERITY_ERROR,
          source: "Ontology",
          message: `Attribute [${attr.name}] 的 link "${attr.example}" 不是合法的 markdown hyperlink 形式 \`[label](path)\`（v8.3 §1.10 — link 格式校验）`,
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
        });
      }
    }
  }

  // TM129 — v8.3 (Task #3200) 扩展：Link Definition `[label]: path "title"` 的
  // target 必须是合法路径形式（相对/绝对/URL scheme）。parser 正则 `\S+` 已保证
  // 非空非空白，本检查进一步确保 target 含可识别的路径段或 scheme。
  for (const def of doc.definitions) {
    if (!_LINK_DEF_TARGET_RE.test(def.target)) {
      diagnostics.push({
        code: "TM129",
        severity: SEVERITY_ERROR,
        source: "Ontology",
        message: `Link Definition [${def.label}] 的 target "${def.target}" 不是合法路径形式（v8.3 §1.11 — 应为 ./xxx / ../xxx / 绝对路径 / http(s):// 等 URL scheme）`,
        range: def.range,
      });
    }
  }

  return diagnostics;
}

/**
 * v8.3 (Task #3196) — TM127 / TM128 单文件检查。
 *
 * v8.3 §1.4 Operator.implement 块字段验证：
 *  - TM127 (error): impltype 必须是合法 enum（mcp/tool/skill/http-api/coding）
 *  - TM128 (error): 对应 endpoint 字段必须存在且非空
 */
function checkImplementImpltype(impl: { [k: string]: unknown }): Diagnostic[] {
  const out: Diagnostic[] = [];
  const impltype = impl.impltype;

  if (!impltype || typeof impltype !== "string" || !impltype.trim()) {
    out.push({
      code: "TM127",
      severity: SEVERITY_ERROR,
      source: "Ontology",
      message:
        "v8.3 implement 块缺少 impltype 字段（v8.3 §1.4 — impltype 必须是 mcp/tool/skill/http-api/coding 之一）",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    });
    return out;
  }

  if (!VALID_IMPLTYPES.has(impltype as (typeof VALID_IMPLTYPES extends Set<infer T> ? T : never))) {
    out.push({
      code: "TM127",
      severity: SEVERITY_ERROR,
      source: "Ontology",
      message: `v8.3 implement.impltype "${impltype}" 不是合法 enum（v8.3 §1.4 — 必须为 mcp/tool/skill/http-api/coding 之一）`,
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 0 },
      },
    });
    return out;
  }

  // TM128 — 对应 endpoint 字段必须存在且非空
  const requiredField = (IMPLTYPE_REQUIRED_FIELD as Record<string, string>)[impltype];
  if (requiredField) {
    const v = impl[requiredField];
    if (v === undefined || v === null) {
      out.push({
        code: "TM128",
        severity: SEVERITY_ERROR,
        source: "Ontology",
        message: `v8.3 implement.impltype="${impltype}" 缺少必填字段 "${requiredField}"（v8.3 §1.4 — 每个 impltype 映射到特定 endpoint 字段）`,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });
    } else if (typeof v === "string" && !v.trim()) {
      out.push({
        code: "TM128",
        severity: SEVERITY_ERROR,
        source: "Ontology",
        message: `v8.3 implement.impltype="${impltype}" 的 "${requiredField}" 字段必须非空（v8.3 §1.4 — 每个 impltype 映射到特定 endpoint 字段）`,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
      });
    }
  }
  return out;
}

/**
 * v8.3 (Task #3196) — TM129 Link Definition 格式校验。
 *
 * 接受 `[label](path)` 或 `[label](path "title")`，路径必须非空且不含空格。
 */
export function isWellFormedLink(target: string): boolean {
  if (typeof target !== "string" || !target.trim()) return false;
  // 兼容 raw 形式如 `./e/a.md "entity"`
  const m = target.match(/^\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
  return m !== null;
}

/**
 * 检查 Attribute type 是否合法。
 * 合法值：string, integer, number, boolean, date, enum, ref:xxx
 */
function isValidAttributeType(type: AttributeType): boolean {
  // ref:xxx 格式
  if (type.startsWith("ref:")) {
    return type.length > 4; // ref: 后面必须有内容
  }
  return VALID_ATTR_TYPES.has(type);
}

/**
 * v8.3 (Task #3196) — TM125 / TM126 跨文件 Operator chaining 检查。
 *
 * 必须在 WorkspaceIndex 上调用：对所有同 domain 的 Operator，扫描其
 * output_attributes（带 link），并在两两之间检测冲突 / 链式机会。
 *
 * - TM125 (error)：同 domain 中，同名同类型但 link_target_path 不同的
 *   两个 output_attributes → operator chaining 冲突。
 * - TM126 (warning)：Operator A 的 output 与 Operator B 的 input 同
 *   名同类型同 link_target_path → 正向链式提示。
 *
 * 在 roy-bot 端，本函数标注为"待 cross-file 钩子调用"；
 * 单文件入口只在本次诊断中标注有 implement/output attr 信息的
 * Operator 文件贡献。
 */
export interface ChainingOutput {
  operatorId: string;
  domain: string;
  filePath: string;
  name: string;
  outputs: Array<{
    name: string;
    type: string;
    linkTarget: string | null;
  }>;
  inputs: Array<{
    name: string;
    type: string;
    linkTarget: string | null;
  }>;
}

export function collectOperatorChainingOutputs(doc: OntologyDocument): ChainingOutput | null {
  if (doc.frontmatter.type !== "operator") return null;
  if (!doc.frontmatter.domain) return null;
  const fileBase = path.basename(doc.filePath).replace(/\.md$/i, "");
  const id = (doc.frontmatter.raw?.id as string) || fileBase;
  // 从表格解析已经处理；此处简化只取 attribute 表中的 attribute
  // input/output 拆分需要 attribute-table 加强 — 当前版本先存 attribute
  // 不区分 input/output，由跨文件钩子按模型约定（待办）精确匹配。
  const items: Array<{
    name: string;
    type: string;
    linkTarget: string | null;
  }> = [];
  for (const a of doc.attributes) {
    items.push({
      name: a.name,
      type: a.type,
      linkTarget: a.example && a.example.startsWith("[") && a.example.includes("](")
        ? a.example
        : null,
    });
  }
  return {
    operatorId: id,
    domain: doc.frontmatter.domain,
    filePath: doc.filePath,
    name: id,
    outputs: items,
    inputs: items, // TODO: 区分 input vs output（需扩展 attribute-table parser）
  };
}

/**
 * v8.3 (Task #3196) — TM125 / TM126 跨文件诊断（运行于 workspace 上）。
 *
 * 输入是已经收集好的所有 Operator 的 ChainingOutput 数组（来自
 * collectOperatorChainingOutputs 在每个 operator 文件上的调用结果）。
 */
export function checkOperatorChaining(all: ChainingOutput[]): Diagnostic[] {
  const out: Diagnostic[] = [];

  // Phase 2: TM125 — domain-scoped output_attribute uniqueness
  // 按 (domain, name, type) 分组，并收集不同 linkTarget 计数。
  interface Bucket {
    domain: string;
    name: string;
    type: string;
    owners: ChainingOutput[];
    linkTargets: Set<string>;
  }
  const buckets = new Map<string, Bucket>();
  for (const op of all) {
    for (const o of op.outputs) {
      const key = `${op.domain}::${o.name}::${o.type}`;
      let b = buckets.get(key);
      if (!b) {
        b = {
          domain: op.domain,
          name: o.name,
          type: o.type,
          owners: [],
          linkTargets: new Set<string>(),
        };
        buckets.set(key, b);
      }
      b.owners.push(op);
      if (o.linkTarget) b.linkTargets.add(o.linkTarget);
    }
  }
  for (const b of buckets.values()) {
    if (b.linkTargets.size >= 2) {
      out.push({
        code: "TM125",
        severity: SEVERITY_ERROR,
        source: "Ontology",
        message: `domain "${b.domain}" 存在同名同类型 (${b.name}:${b.type}) 但 link target 不同的 Operator 输出（v8.3 §2.3 — operator chaining 唯一性）`,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
      });
    }
  }

  // Phase 3: TM126 — cross-operator chaining hint
  // 当一个 operator 的 output 与另一个 operator 的 input 同名同类型同 link → 链式提示
  const indexById = new Map<string, ChainingOutput>();
  for (const op of all) indexById.set(op.operatorId, op);
  for (const a of all) {
    for (const out1 of a.outputs) {
      // 同一 chain 不查自己；只查另一个 operator
      for (const b of all) {
        if (a.operatorId === b.operatorId) continue;
        // 同一 domain 才考虑
        if (a.domain !== b.domain) continue;
        for (const inB of b.inputs) {
          if (
            out1.name === inB.name &&
            out1.type === inB.type &&
            out1.linkTarget &&
            inB.linkTarget &&
            out1.linkTarget === inB.linkTarget
          ) {
            out.push({
              code: "TM126",
              severity: SEVERITY_WARNING,
              source: "Ontology",
              message: `Operator ${a.operatorId} 的 output "${out1.name}" (${out1.type}) 与 Operator ${b.operatorId} 的 input 同名同类型同 link — 推荐链式组合（v8.3 §2.4）`,
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
            });
          }
        }
      }
    }
  }

  return out;
}
