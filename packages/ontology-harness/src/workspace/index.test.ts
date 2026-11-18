/**
 * @fileoverview WorkspaceIndex 测试（纯内存全局符号表）
 */

import { describe, it, expect } from "vitest";
import { WorkspaceIndex } from "./index";
import type { TermDefinition } from "../ontology/types";

function def(label: string, target: string, type: any): TermDefinition {
  return {
    label,
    target,
    type,
    rawTitle: type,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
  };
}

describe("WorkspaceIndex", () => {
  it("setFile 记录文件的术语定义，definitionsOf 跨文件聚合", () => {
    const idx = new WorkspaceIndex();
    idx.setFile("/ws/model/entity/account.md", [def("会计科目", "./account.md", "entity")]);
    idx.setFile("/ws/model/finance-model.md", [def("会计科目", "./entity/account.md", "entity")]);

    const recs = idx.definitionsOf("会计科目");
    expect(recs).toHaveLength(2);
    // 两处都解析到同一规范文件
    const targets = new Set(recs.map((r) => r.targetAbs));
    expect(targets).toEqual(new Set(["/ws/model/entity/account.md"]));
  });

  it("definesIn：目标文件是否把某 label 定义为某 type", () => {
    const idx = new WorkspaceIndex();
    idx.setFile("/ws/model/entity/organization.md", [def("公司", "./organization.md", "entity")]);

    expect(idx.definesIn("/ws/model/entity/organization.md", "公司", "entity")).toBe(true);
    expect(idx.definesIn("/ws/model/entity/organization.md", "公司", "relation")).toBe(false);
    expect(idx.definesIn("/ws/model/entity/organization.md", "部门", "entity")).toBe(false);
    expect(idx.definesIn("/ws/不存在.md", "公司", "entity")).toBe(false);
  });

  it("setFile 二次调用替换该文件旧条目（增量更新）", () => {
    const idx = new WorkspaceIndex();
    idx.setFile("/ws/a.md", [def("X", "./a.md", "entity")]);
    expect(idx.definitionsOf("X")).toHaveLength(1);
    // 重新写入同一文件，X 改名为 Y
    idx.setFile("/ws/a.md", [def("Y", "./a.md", "entity")]);
    expect(idx.definitionsOf("X")).toHaveLength(0);
    expect(idx.definitionsOf("Y")).toHaveLength(1);
  });

  it("removeFile 移除该文件的全部条目", () => {
    const idx = new WorkspaceIndex();
    idx.setFile("/ws/a.md", [def("X", "./a.md", "entity")]);
    idx.removeFile("/ws/a.md");
    expect(idx.definitionsOf("X")).toHaveLength(0);
  });

  it("忽略无类型（无 title）的定义", () => {
    const idx = new WorkspaceIndex();
    idx.setFile("/ws/a.md", [def("X", "./a.md", undefined)]);
    expect(idx.definitionsOf("X")).toHaveLength(0);
  });

  it("canonicalTargetsOf：某 label 解析到的不同规范文件集合（唯一性判定基础）", () => {
    const idx = new WorkspaceIndex();
    idx.setFile("/ws/m1.md", [def("公司", "./entity/org.md", "entity")]);
    idx.setFile("/ws/m2.md", [def("公司", "./entity/company.md", "entity")]);
    const targets = idx.canonicalTargetsOf("公司");
    expect(targets.size).toBe(2); // 冲突：两个不同规范文件
  });

  it("typesOf：某 label 出现过的类型集合（类型一致性判定基础）", () => {
    const idx = new WorkspaceIndex();
    idx.setFile("/ws/m1.md", [def("X", "./x.md", "entity")]);
    idx.setFile("/ws/m2.md", [def("X", "./x.md", "relation")]);
    expect(idx.typesOf("X")).toEqual(new Set(["entity", "relation"]));
  });
});
