/**
 * @fileoverview 跨文件诊断（workspace 级）
 *
 * 在 WorkspaceIndex 之上，对单个文件计算跨文件约束：
 *  | TM010 | 术语唯一性：同一 label 不得被多个文件"规范定义"（自引用）或定义为多种类型 | Error |
 *  | TM021 | 跨文件引用：目标文件未定义该术语或类型不符 | Error |
 *
 * v8.3（Task #3200）扩展：
 *  | TM125 | domain 内同名同类型 operator output link target 不一致          | Error   |
 *  | TM126 | operator output 与另一 operator input 同名同类型同 link → 链式提示 | Warning |
 *
 * 唯一性只针对"规范定义"（self-definition，目标解析回文件自身）。
 * 引用别处的术语不主张所有权——它的有效性由 TM021 判定。这样既守住
 * "一术语一规范源"，又避免对每个正常引用误报。
 *
 * 前置：调用前应先把该文件（及其引用的目标文件）`setFile` 进索引；
 * operator 文件还应通过 `setOperatorDocument` 注册完整 OntologyDocument
 * （扫描器负责；没有注册时 TM125/TM126 仅基于该文件自身属性判定）。
 * 文件是否物理存在不在此判定（交给 markdown LSP / 扫描器）。
 */

import type { Diagnostic } from "vscode-languageserver-types";
import type { OntologyDocument } from "../ontology/types";
import {
  checkOperatorChaining,
  collectOperatorChainingOutputs,
} from "../ontology/diagnostics";
import { WorkspaceIndex } from "./index";
import { resolveTargetPath } from "./resolve-target";

const SEVERITY_ERROR = 1;

export function computeCrossFileDiagnostics(
  index: WorkspaceIndex,
  fileAbs: string,
  doc: OntologyDocument
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const d of doc.definitions) {
    if (!d.type) continue;

    const { absPath } = resolveTargetPath(fileAbs, d.target);
    const isSelf = absPath === fileAbs;

    // ---- TM010 唯一性（只针对规范定义/自引用） ----
    if (isSelf) {
      const selfDefs = index.selfDefinitionsOf(d.label);
      const files = new Set(selfDefs.map((s) => s.definingFile));
      const types = new Set(selfDefs.map((s) => s.type));
      if (files.size > 1 || types.size > 1) {
        const reason =
          types.size > 1
            ? `被定义为多种类型（${[...types].join(" / ")}）`
            : `被 ${files.size} 个文件同时规范定义`;
        diagnostics.push({
          code: "TM010",
          severity: SEVERITY_ERROR,
          source: "Ontology",
          message: `术语 [${d.label}] 唯一性冲突：${reason}`,
          range: d.range,
        });
      }
    }

    // ---- TM021 跨文件引用解析 ----
    if (absPath && !isSelf && index.hasFile(absPath)) {
      if (!index.definesIn(absPath, d.label, d.type)) {
        const inTarget = index.definitionsInFile(absPath, d.label);
        const message =
          inTarget.length > 0
            ? `跨文件引用 [${d.label}] 类型不符：引用为 ${d.type}，目标文件声明为 ${inTarget
                .map((t) => t.type)
                .join(" / ")}`
            : `跨文件引用 [${d.label}] 未解析：目标文件未将其定义为 ${d.type}`;
        diagnostics.push({
          code: "TM021",
          severity: SEVERITY_ERROR,
          source: "Ontology",
          message,
          range: d.range,
        });
      }
    }
  }

  // ---- v8.3 (Task #3200) TM125 / TM126 — 跨文件 operator chaining ----
  // 收集所有 operator 文件的 chaining 输出（基于已注册的 operator document），
  // 以及本次传入文件的 chaining 输出（兜底：注册时机可能晚于扫描时序）。
  const chainingAll: Array<NonNullable<ReturnType<typeof collectOperatorChainingOutputs>>> = [];
  for (const odoc of index.getOperatorDocuments()) {
    const c = collectOperatorChainingOutputs(odoc);
    if (c) chainingAll.push(c);
  }
  // 兜底：若当前文档是 operator 但尚未注册到 index
  if (doc.frontmatter.type === "operator" && doc.frontmatter.domain) {
    const c = collectOperatorChainingOutputs(doc);
    if (c && !index.getOperatorDocuments().some((d) => d.filePath === doc.filePath)) {
      chainingAll.push(c);
    }
  }
  if (chainingAll.length >= 2) {
    diagnostics.push(...checkOperatorChaining(chainingAll));
  }

  return diagnostics;
}
