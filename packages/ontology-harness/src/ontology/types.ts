/**
 * @fileoverview Typed Markdown Ontology 核心类型
 *
 * SPG（空间语义层）+ TPG（时间语义层）架构：
 * - SPG: Entity + Attribute — 描述"有什么、由什么构成、是什么类别"
 * - TPG: Operator — 描述"发生什么、什么条件下触发、执行什么动作"
 *
 * 对应设计文档 docs/typed-markdown-ontology-design.md。
 *
 * v8.3 schema enhancements（飞书设计文档 TI6ldrfADoBGoOxFCYgcAX7fn2c / 2026-08-20）：
 * - Entity 新增可选 `instance_getter` + `access_mode`（http-api/mcp/tool/skill/coding）
 * - Operator 新增可选 `implement` 块（`impltype` + 对应 endpoint 字段）
 * - 输出属性双语义（operator chaining / 引用）
 * - 五大新规则：TM125（operator chaining uniqueness）/ TM126（chaining hint）
 *   / TM127（impltype enum）/ TM128（endpoint field）/ TM129（link format）
 */

import type { Range } from "vscode-languageserver-types";

/** Term 类型（由 Link Definition 的 title 标注）：entity（SPG）或 operator（TPG） */
export type TermType = "entity" | "operator";

/** Attribute 类型系统 */
export type AttributeType =
  | "string"
  | "integer"
  | "number"
  | "boolean"
  | "date"
  | "enum"
  | `ref:${string}`;

/**
 * v8.3 — `access_mode` enum：Entity 的 `instance_getter` 块允许声明
 * 实例获取方式。VALID_ACCESS_MODES 与内部本体 v8.3 保持一致。
 */
export type AccessMode = "http-api" | "mcp" | "tool" | "skill" | "coding";

/** v8.3 — 合法 access_mode 集合 */
export const VALID_ACCESS_MODES: ReadonlySet<AccessMode> = new Set<AccessMode>([
  "http-api",
  "mcp",
  "tool",
  "skill",
  "coding",
]);

/**
 * v8.3 — `impltype` enum：Operator 的 `implement` 块允许声明实现方式。
 * 每个 impltype 映射到一个 required endpoint 字段：
 *   mcp       → mcp_endpoint
 *   tool      → tool_name
 *   skill     → skill_name
 *   http-api  → http_endpoint
 *   coding    → coding_module
 */
export type ImplType = "mcp" | "tool" | "skill" | "http-api" | "coding";

/** v8.3 — 合法 impltype 集合 */
export const VALID_IMPLTYPES: ReadonlySet<ImplType> = new Set<ImplType>([
  "mcp",
  "tool",
  "skill",
  "http-api",
  "coding",
]);

/** v8.3 — impltype → 必填 endpoint 字段映射（与内部本体 v8.3 完全一致） */
export const IMPLTYPE_REQUIRED_FIELD: Readonly<Record<ImplType, string>> = {
  mcp: "mcp_endpoint",
  tool: "tool_name",
  skill: "skill_name",
  "http-api": "http_endpoint",
  coding: "coding_module",
};

/** 单个 Attribute 定义（从属性表格解析） */
export interface Attribute {
  name: string;
  type: AttributeType;
  required: boolean;
  description?: string;
  /** string 类型的示例值 */
  example?: string;
  /** enum 类型的候选值列表 */
  values?: string[];
}

/** frontmatter 中的文件类型 */
export type ModelType = "model" | "operator";

/**
 * 一条 Link Definition 解析结果，例如：
 *   `[星科科技]: ./entity/star-tech.md "entity"`
 */
export interface TermDefinition {
  /** 标签名（`[]` 内文本），如 "星科科技" / "is-a" */
  label: string;
  /** 目标路径（未解析的原始字符串），如 "./entity/star-tech.md" */
  target: string;
  /** title 标注的类型；缺失或非法时为 undefined */
  type?: TermType;
  /** title 原始字符串（用于诊断非法 title） */
  rawTitle?: string;
  /** 在文档中的位置（整个 link definition 行） */
  range: Range;
}

/**
 * 一条三元组，例如：`[星科科技] 是 [公司] 的 [is-a]`
 */
export interface Triple {
  /** 主语标签 */
  subject: string;
  /** 宾语标签 */
  object: string;
  /** 谓语（关系/算子）标签 */
  predicate: string;
  /** 原始匹配文本 */
  raw: string;
  /** 三元组在文档中的位置 */
  range: Range;
  /** 各组成部分各自的位置（用于精准诊断） */
  parts: {
    subject: Range;
    object: Range;
    predicate: Range;
  };
}

/**
 * 一条 part-of 关系（由 Header 层级推断），例如：
 *   `# 财务报表` 下的 `## 资产负债表` → 资产负债表 part-of 财务报表
 */
export interface PartOfRelation {
  /** 子概念（更深层 header） */
  child: string;
  /** 父概念（上一级 header） */
  parent: string;
  /** 子 header 的位置 */
  range: Range;
}

/**
 * v8.3 §1.3 — Entity `instance_getter` 块（可选）。
 *
 * 数字化程度高的企业（航空、银行、电商）推荐填写；
 * 低数字化企业可省略整个块。
 */
export interface InstanceGetter {
  /** 实例获取方式，参见 AccessMode enum */
  access_mode?: AccessMode;
  /** 人类可读描述 */
  description?: string;
  /** 自由字段（如 endpoint URL、tool name 等） */
  [key: string]: unknown;
}

/**
 * v8.3 §1.4 — Operator `implement` 块（可选）。
 *
 * 声明 operator 是如何被实现的（MCP tool / TongAgent tool /
 * skill / HTTP API / Python coding module）。`impltype` 与对应
 * endpoint 字段由 TM127/TM128 验证。
 */
export interface Implement {
  /** 实现方式 enum */
  impltype?: ImplType;
  /** 人类可读描述 */
  description?: string;
  /** 自由字段（endpoint / tool_name / skill_name / coding_module 等） */
  [key: string]: unknown;
}

/** frontmatter 解析结果 */
export interface Frontmatter {
  /** 是否存在 frontmatter 块 */
  present: boolean;
  /** type 字段值（model/operator/其它原始字符串） */
  type?: string;
  /** 领域 */
  domain?: string;
  /** 解析出的所有键值（原始） */
  raw: Record<string, unknown>;
  /** frontmatter 块的位置（若存在） */
  range?: Range;
  /**
   * v8.3 — Entity 可选的 `instance_getter` 块。
   * 解析成功且为对象时填充；缺失或非法时为 undefined。
   */
  instance_getter?: InstanceGetter;
  /**
   * v8.3 — Operator 可选的 `implement` 块。
   * 解析成功且为对象时填充；缺失或非法时为 undefined。
   */
  implement?: Implement;
}

/**
 * 单个文档的 Ontology 解析模型
 */
export interface OntologyDocument {
  filePath: string;
  frontmatter: Frontmatter;
  definitions: TermDefinition[];
  triples: Triple[];
  partOf: PartOfRelation[];
  /** 从 `## 属性` 标题下 Markdown 表格中解析出的 Attribute 列表 */
  attributes: Attribute[];
}
