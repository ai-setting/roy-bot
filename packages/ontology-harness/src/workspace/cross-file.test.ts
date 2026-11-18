/**
 * @fileoverview 跨文件诊断测试（TM010 唯一性 / TM021 跨文件引用解析）
 *
 * 约定：调用前需先把目标文件的定义 setFile 进索引（由扫描器/插件负责）。
 */

import { describe, it, expect } from "vitest";
import { WorkspaceIndex } from "./index";
import { computeCrossFileDiagnostics } from "./cross-file";
import type { OntologyDocument, TermDefinition } from "../ontology/types";

let line = 0;
function def(label: string, target: string, type: any): TermDefinition {
  const l = line++;
  return {
    label,
    target,
    type,
    rawTitle: type,
    range: { start: { line: l, character: 0 }, end: { line: l, character: 5 } },
  };
}
function doc(filePath: string, definitions: TermDefinition[]): OntologyDocument {
  return {
    filePath,
    frontmatter: { present: false, raw: {} },
    definitions,
    triples: [],
    partOf: [],
    attributes: [],
  };
}

/**
 * 构造一个最小的 operator OntologyDocument（带 domain + attributes），
 * 供 v8.3 跨文件 Operator chaining 钩子测试。
 */
function operatorDoc(
  filePath: string,
  domain: string,
  operatorId: string,
  attrs: Array<{ name: string; type: string; example?: string }>
): OntologyDocument {
  return {
    filePath,
    frontmatter: {
      present: true,
      type: "operator",
      domain,
      raw: { id: operatorId },
    },
    definitions: [],
    triples: [],
    partOf: [],
    attributes: attrs.map((a) => ({
      name: a.name,
      type: a.type as any,
      example: a.example,
      required: false,
    })),
  };
}

describe("computeCrossFileDiagnostics", () => {
  it("合法实例→model 引用：目标文件确实定义该术语，无诊断", () => {
    const idx = new WorkspaceIndex();
    // model：organization.md 自定义 公司
    idx.setFile("/ws/model/entity/organization.md", [def("公司", "./organization.md", "entity")]);
    // 实例：intro 引用 公司 → 指向 organization.md
    const intro = "/ws/business/intro.md";
    const introDefs = [def("公司", "../model/entity/organization.md", "entity")];
    idx.setFile(intro, introDefs);

    const diags = computeCrossFileDiagnostics(idx, intro, doc(intro, introDefs));
    expect(diags).toHaveLength(0);
  });

  it("TM021：引用的目标文件存在于索引但未定义该术语", () => {
    const idx = new WorkspaceIndex();
    idx.setFile("/ws/model/entity/organization.md", [def("部门", "./organization.md", "entity")]); // 不含 公司
    const intro = "/ws/business/intro.md";
    const introDefs = [def("公司", "../model/entity/organization.md", "entity")];
    idx.setFile(intro, introDefs);

    const diags = computeCrossFileDiagnostics(idx, intro, doc(intro, introDefs));
    const tm021 = diags.find((d) => d.code === "TM021");
    expect(tm021).toBeDefined();
    expect(tm021!.severity).toBe(1);
    expect(tm021!.message).toContain("公司");
  });

  it("TM021：目标文件定义了该术语但类型不符", () => {
    const idx = new WorkspaceIndex();
    idx.setFile("/ws/model/x.md", [def("X", "./x.md", "operator")]); // 定义为 operator
    const f = "/ws/business/b.md";
    const defs = [def("X", "../model/x.md", "entity")]; // 引用为 entity
    idx.setFile(f, defs);

    const diags = computeCrossFileDiagnostics(idx, f, doc(f, defs));
    const tm021 = diags.find((d) => d.code === "TM021");
    expect(tm021).toBeDefined();
    expect(tm021!.message).toMatch(/operator|类型/);
  });

  it("目标文件不在索引（未扫描/缺失）时不报 TM021（交给文件存在性检查）", () => {
    const idx = new WorkspaceIndex();
    const f = "/ws/business/b.md";
    const defs = [def("幽灵", "../model/ghost.md", "entity")];
    idx.setFile(f, defs);
    const diags = computeCrossFileDiagnostics(idx, f, doc(f, defs));
    expect(diags.find((d) => d.code === "TM021")).toBeUndefined();
  });

  it("自引用（规范定义）不报 TM021", () => {
    const idx = new WorkspaceIndex();
    const f = "/ws/model/entity/organization.md";
    const defs = [def("公司", "./organization.md", "entity")];
    idx.setFile(f, defs);
    const diags = computeCrossFileDiagnostics(idx, f, doc(f, defs));
    expect(diags).toHaveLength(0);
  });

  it("TM010：两个文件各自规范定义（自引用）同一 label → 唯一性冲突", () => {
    const idx = new WorkspaceIndex();
    // 两个文件都自引用声明拥有 公司
    idx.setFile("/ws/entity/org.md", [def("公司", "./org.md", "entity")]);
    const f = "/ws/entity/company.md";
    const defs = [def("公司", "./company.md", "entity")];
    idx.setFile(f, defs);

    const diags = computeCrossFileDiagnostics(idx, f, doc(f, defs));
    const tm010 = diags.find((d) => d.code === "TM010");
    expect(tm010).toBeDefined();
    expect(tm010!.message).toContain("公司");
  });

  it("TM010：同一 label 自引用类型不一致（entity vs operator）→ 唯一性冲突", () => {
    const idx = new WorkspaceIndex();
    idx.setFile("/ws/x.md", [def("X", "./x.md", "entity")]);
    const f = "/ws/x2.md";
    const defs = [def("X", "./x2.md", "operator")];
    idx.setFile(f, defs);
    const diags = computeCrossFileDiagnostics(idx, f, doc(f, defs));
    expect(diags.find((d) => d.code === "TM010")).toBeDefined();
  });

  it("唯一规范定义 + 多处引用（指向同一规范文件）不报 TM010", () => {
    const idx = new WorkspaceIndex();
    // account.md 自引用（唯一规范源）；finance-model 仅引用，不主张所有权
    idx.setFile("/ws/model/entity/account.md", [def("会计科目", "./account.md", "entity")]);
    const fm = "/ws/model/finance-model.md";
    const fmDefs = [def("会计科目", "./entity/account.md", "entity")];
    idx.setFile(fm, fmDefs);
    // 规范文件本身也不应报（唯一自引用）
    const accDiags = computeCrossFileDiagnostics(
      idx,
      "/ws/model/entity/account.md",
      doc("/ws/model/entity/account.md", [def("会计科目", "./account.md", "entity")])
    );
    expect(accDiags.find((d) => d.code === "TM010")).toBeUndefined();
    const diags = computeCrossFileDiagnostics(idx, fm, doc(fm, fmDefs));
    expect(diags.find((d) => d.code === "TM010")).toBeUndefined();
  });

  it("普通引用（非自引用）即便他处冲突也不在引用处报 TM010", () => {
    const idx = new WorkspaceIndex();
    idx.setFile("/ws/entity/org.md", [def("公司", "./org.md", "entity")]);
    idx.setFile("/ws/entity/company.md", [def("公司", "./company.md", "entity")]);
    // 实例文档仅引用 公司，TM010 应落在两个规范文件而非此处
    const inst = "/ws/business/intro.md";
    const instDefs = [def("公司", "../entity/org.md", "entity")];
    idx.setFile(inst, instDefs);
    const diags = computeCrossFileDiagnostics(idx, inst, doc(inst, instDefs));
    expect(diags.find((d) => d.code === "TM010")).toBeUndefined();
  });

  // ----------------------------------------------------------------
  // v8.3 Task #3200 — TM125 / TM126 跨文件钩子
  // ----------------------------------------------------------------
  it("v8.3 跨文件钩子：同 domain 同名同 type 不同 link → TM125", () => {
    const idx = new WorkspaceIndex();
    const f1 = "/ws/op1.md";
    const f2 = "/ws/op2.md";
    idx.setFile(f1, [def("op1", "./op1.md", "operator")]);
    idx.setFile(f2, [def("op2", "./op2.md", "operator")]);
    idx.setOperatorDocument(f1, operatorDoc(f1, "traffic", "op1", [
      { name: "result", type: "string", example: "[r](./e/a.md)" },
    ]));
    idx.setOperatorDocument(f2, operatorDoc(f2, "traffic", "op2", [
      { name: "result", type: "string", example: "[r](./e/b.md)" },
    ]));

    const diags = computeCrossFileDiagnostics(idx, f1, doc(f1, []));
    const tm125 = diags.filter((d) => d.code === "TM125");
    expect(tm125).toHaveLength(1);
    expect(tm125[0].severity).toBe(1);
  });

  it("v8.3 跨文件钩子：链式同 link → TM126 (warning)", () => {
    const idx = new WorkspaceIndex();
    const a = "/ws/A.md";
    const b = "/ws/B.md";
    idx.setFile(a, [def("A", "./A.md", "operator")]);
    idx.setFile(b, [def("B", "./B.md", "operator")]);
    // 同 domain = "weather"，linkTarget 一致 → 触发 TM126 链式提示
    // 当前 collectOperatorChainingOutputs 把 attributes 同时放入 inputs/outputs
    // 所以同 linkTarget 同名同类型即可触发。
    idx.setOperatorDocument(a, operatorDoc(a, "weather", "A", [
      { name: "temp", type: "number", example: "[t](./e/temp.md)" },
    ]));
    idx.setOperatorDocument(b, operatorDoc(b, "weather", "B", [
      { name: "temp", type: "number", example: "[t](./e/temp.md)" },
    ]));

    const diags = computeCrossFileDiagnostics(idx, a, doc(a, []));
    const tm126 = diags.filter((d) => d.code === "TM126");
    expect(tm126.length).toBeGreaterThanOrEqual(1);
    expect(tm126[0].severity).toBe(2); // Warning
  });

  it("v8.3 跨文件钩子：不同 domain 不触发 TM125/TM126", () => {
    const idx = new WorkspaceIndex();
    const f1 = "/ws/op1.md";
    const f2 = "/ws/op2.md";
    idx.setFile(f1, [def("op1", "./op1.md", "operator")]);
    idx.setFile(f2, [def("op2", "./op2.md", "operator")]);
    idx.setOperatorDocument(f1, operatorDoc(f1, "traffic", "op1", [
      { name: "result", type: "string", example: "[r](./e/a.md)" },
    ]));
    idx.setOperatorDocument(f2, operatorDoc(f2, "weather", "op2", [
      { name: "result", type: "string", example: "[r](./e/b.md)" },
    ]));

    const diags = computeCrossFileDiagnostics(idx, f1, doc(f1, []));
    expect(diags.find((d) => d.code === "TM125")).toBeUndefined();
    expect(diags.find((d) => d.code === "TM126")).toBeUndefined();
  });
});
