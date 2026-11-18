/**
 * @fileoverview Ontology analyzer：解析 + 诊断编排
 *
 * 把 frontmatter / link-definition / triple / part-of 解析串起来，
 * 产出一个 OntologyDocument，并基于它计算 TM 约束诊断。
 */

import type { Diagnostic } from "vscode-languageserver-types";
import type { OntologyDocument } from "./types";
import { parseFrontmatter } from "./frontmatter";
import { parseTermDefinitions } from "./link-def-types";
import { parseTriples } from "./triple-parser";
import { parsePartOf } from "./part-of";
import { parseAllAttributeTables } from "./attribute-table";
import { computeDiagnostics } from "./diagnostics";

export interface AnalyzeResult {
  document: OntologyDocument;
  diagnostics: Diagnostic[];
}

/**
 * 解析并诊断一个 markdown 文档的 Ontology 语义。
 */
export function analyzeOntology(filePath: string, content: string): AnalyzeResult {
  const document: OntologyDocument = {
    filePath,
    frontmatter: parseFrontmatter(content),
    definitions: parseTermDefinitions(content),
    triples: parseTriples(content),
    partOf: parsePartOf(content),
    attributes: parseAllAttributeTables(content).flatMap((r) => r.attributes),
  };

  const diagnostics = computeDiagnostics(document);

  return { document, diagnostics };
}
