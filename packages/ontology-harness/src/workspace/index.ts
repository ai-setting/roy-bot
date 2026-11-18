/**
 * @fileoverview WorkspaceIndex — 跨文件全局符号表（纯内存）
 *
 * 把每个文件贡献的术语定义（带类型的 link definition）聚合成全局视图，
 * 供跨文件诊断（唯一性、实例→model 引用解析）查询。
 *
 * 设计为纯内存、可增量：`setFile` 替换某文件的全部条目，`removeFile` 移除。
 * 不做任何 IO，便于单测与被扫描器/插件复用。
 */

import type { Range } from "vscode-languageserver-types";
import type { OntologyDocument, TermDefinition, TermType } from "../ontology/types";
import { resolveTargetPath } from "./resolve-target";

/** 索引中的一条术语定义记录 */
export interface IndexedTerm {
  label: string;
  type: TermType;
  /** 该定义所在文件（绝对路径） */
  definingFile: string;
  /** 目标解析后的绝对路径；外部链接为 null */
  targetAbs: string | null;
  /** 是否自引用（目标即定义文件本身） */
  isSelf: boolean;
  range: Range;
}

export class WorkspaceIndex {
  /** definingFile(abs) → 该文件的术语记录 */
  private byFile = new Map<string, IndexedTerm[]>();
  /** label → 术语记录（跨文件聚合） */
  private byLabel = new Map<string, IndexedTerm[]>();
  /**
   * v8.3 (Task #3200) — 索引 operator 文件的 OntologyDocument，
   * 提供给跨文件 Operator chaining 钩子（TM125/TM126）。
   * 文件变更时通过 setOperatorDocument 覆盖；空 / undefined 清除。
   */
  private operatorDocs = new Map<string, OntologyDocument>();

  /** 替换某文件的全部术语条目（增量更新）。仅收录有类型的定义。 */
  setFile(fileAbs: string, definitions: TermDefinition[]): void {
    this.removeFile(fileAbs);

    const terms: IndexedTerm[] = [];
    for (const d of definitions) {
      if (!d.type) continue; // 无 title 的定义不进全局表（属文件级 TM002）
      const { absPath } = resolveTargetPath(fileAbs, d.target);
      terms.push({
        label: d.label,
        type: d.type,
        definingFile: fileAbs,
        targetAbs: absPath,
        isSelf: absPath === fileAbs,
        range: d.range,
      });
    }

    this.byFile.set(fileAbs, terms);
    for (const t of terms) {
      const list = this.byLabel.get(t.label) ?? [];
      list.push(t);
      this.byLabel.set(t.label, list);
    }
  }

  /** 移除某文件的全部条目。 */
  removeFile(fileAbs: string): void {
    const old = this.byFile.get(fileAbs);
    if (!old) return;
    this.byFile.delete(fileAbs);
    for (const t of old) {
      const list = this.byLabel.get(t.label);
      if (!list) continue;
      const next = list.filter((x) => x.definingFile !== fileAbs);
      if (next.length > 0) this.byLabel.set(t.label, next);
      else this.byLabel.delete(t.label);
    }
    this.clearOperatorDocument(fileAbs);
  }

  /** 跨文件聚合：某 label 的所有定义记录。 */
  definitionsOf(label: string): IndexedTerm[] {
    return [...(this.byLabel.get(label) ?? [])];
  }

  /**
   * 某 label 的"规范定义"（自引用）记录。
   * 唯一性判定只看自引用：引用别处只是"使用"，不主张所有权。
   */
  selfDefinitionsOf(label: string): IndexedTerm[] {
    return (this.byLabel.get(label) ?? []).filter((t) => t.isSelf);
  }

  /** 该文件是否已被索引（用于区分"未扫描/缺失"与"已知但未定义"）。 */
  hasFile(fileAbs: string): boolean {
    return this.byFile.has(fileAbs);
  }

  /** 目标文件是否把某 label 定义为某 type。 */
  definesIn(fileAbs: string, label: string, type: TermType): boolean {
    const terms = this.byFile.get(fileAbs);
    if (!terms) return false;
    return terms.some((t) => t.label === label && t.type === type);
  }

  /** 某文件内对某 label 的全部定义（用于类型不符的精确报错）。 */
  definitionsInFile(fileAbs: string, label: string): IndexedTerm[] {
    return (this.byFile.get(fileAbs) ?? []).filter((t) => t.label === label);
  }

  /** 某 label 解析到的不同规范文件集合（唯一性判定基础）。 */
  canonicalTargetsOf(label: string): Set<string> {
    const set = new Set<string>();
    for (const t of this.byLabel.get(label) ?? []) {
      if (t.targetAbs) set.add(t.targetAbs);
    }
    return set;
  }

  /** 某 label 出现过的类型集合（类型一致性判定基础）。 */
  typesOf(label: string): Set<TermType> {
    const set = new Set<TermType>();
    for (const t of this.byLabel.get(label) ?? []) set.add(t.type);
    return set;
  }

  /** 已索引的文件数（诊断/调试用）。 */
  get fileCount(): number {
    return this.byFile.size;
  }

  // ----------------------------------------------------------------
  // v8.3 (Task #3200) — operator document 索引（供 TM125/TM126 钩子）
  // ----------------------------------------------------------------

  /**
   * 索引一个 operator 文件的完整 OntologyDocument（包含 frontmatter.domain
   * 与 attributes.link）。扫描器在解析后调用，computeCrossFileDiagnostics
   * 会消费这些信息计算 v8.3 §2.3 / §2.4 跨文件 operator chaining 诊断。
   */
  setOperatorDocument(fileAbs: string, doc: OntologyDocument): void {
    this.operatorDocs.set(fileAbs, doc);
  }

  /**
   * 获取所有已索引的 operator 文件 OntologyDocument（用于跨文件
   * chaining 诊断；过滤掉非 operator / 无 domain 的文件）。
   */
  getOperatorDocuments(): OntologyDocument[] {
    const out: OntologyDocument[] = [];
    for (const d of this.operatorDocs.values()) {
      if (d.frontmatter.type === "operator" && d.frontmatter.domain) out.push(d);
    }
    return out;
  }

  /** 清除某文件的 operator 文档索引（removeFile 顺手清理）。 */
  private clearOperatorDocument(fileAbs: string): void {
    this.operatorDocs.delete(fileAbs);
  }
}
