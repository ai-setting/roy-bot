/**
 * @ai-setting/roy-bot-ontology-harness — Ontology Harness
 *
 * 领域/行业建模与约束规范（Typed Markdown Ontology）。
 *
 * 基于 SPG（空间语义层）+ TPG（时间语义层）架构：
 *  - SPG: Entity + Attribute — 描述"有什么、由什么构成、是什么类别"
 *  - TPG: Operator — 描述"发生什么、什么条件下触发、执行什么动作"
 *
 * 站在 coder-harness 的 markdown LSP 能力之上，提供：
 *  - Ontology 语义解析（frontmatter / Link Definition 类型 / 三元组 / part-of / 属性表格）
 *  - 约束诊断（文件级 TM001–TM129）
 *  - 跨文件 workspace 索引与诊断（TM010 唯一性 / TM021 跨文件引用 / TM125–TM126）
 *  - OntologyLSPPlugin：通过 `--plugin ontologylsp` 加载，附带 markdown 基础诊断
 *
 * v8.3 (Task #3196) 新增：TM125–TM129 + instance_getter / access_mode /
 * implement / impltype 字段支持（与内部本体 v8.3 一致）。
 */

// ============================================================================
// Ontology Types
// ============================================================================

export type {
  TermType,
  ModelType,
  TermDefinition,
  Triple,
  PartOfRelation,
  Frontmatter,
  OntologyDocument,
  Attribute,
  AttributeType,
  // v8.3 新增（Task #3196）
  AccessMode,
  ImplType,
  InstanceGetter,
  Implement,
} from "./ontology/types";
export {
  VALID_ACCESS_MODES,
  VALID_IMPLTYPES,
  IMPLTYPE_REQUIRED_FIELD,
} from "./ontology/types";

// ============================================================================
// Ontology Analyzer
// ============================================================================

export { analyzeOntology } from "./ontology/analyzer";
export type { AnalyzeResult } from "./ontology/analyzer";
export { parseFrontmatter } from "./ontology/frontmatter";
export { parseTermDefinitions } from "./ontology/link-def-types";
export { parseTriples } from "./ontology/triple-parser";
export { parsePartOf } from "./ontology/part-of";
export {
  computeDiagnostics,
  looksLikeModelFile,
  // v8.3 新增（Task #3196）
  isWellFormedLink,
  collectOperatorChainingOutputs,
  checkOperatorChaining,
} from "./ontology/diagnostics";
export type { ChainingOutput } from "./ontology/diagnostics";
export { parseAttributeTable, parseAllAttributeTables } from "./ontology/attribute-table";

// ============================================================================
// Workspace（跨文件引用解析 / 全局符号表）
// ============================================================================

export { resolveTargetPath } from "./workspace/resolve-target";
export type { ResolvedTarget } from "./workspace/resolve-target";
export { WorkspaceIndex } from "./workspace/index";
export type { IndexedTerm } from "./workspace/index";
export { computeCrossFileDiagnostics } from "./workspace/cross-file";
export { scanWorkspace, indexDocument } from "./workspace/scanner";
export type { ScanOptions } from "./workspace/scanner";

// ============================================================================
// Plugin
// ============================================================================

export { OntologyLSPPlugin, createOntologyLSPPlugin } from "./plugins/ontologylsp-plugin";
export type { OntologyLSPPluginConfig } from "./plugins/ontologylsp-plugin";
