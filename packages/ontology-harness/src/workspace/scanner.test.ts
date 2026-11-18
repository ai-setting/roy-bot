/**
 * @fileoverview workspace 扫描器测试（真实临时目录）
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { scanWorkspace, indexDocument } from "./scanner";
import { WorkspaceIndex } from "./index";
import { computeCrossFileDiagnostics } from "./cross-file";
import { analyzeOntology } from "../ontology/analyzer";

let root: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ws-scan-"));
  await fs.mkdir(path.join(root, "model/entity"), { recursive: true });
  await fs.mkdir(path.join(root, "business"), { recursive: true });
  await fs.mkdir(path.join(root, "node_modules/pkg"), { recursive: true });

  await fs.writeFile(
    path.join(root, "model/entity/organization.md"),
    '# 组织\n\n[公司]: ./organization.md "entity"\n',
    "utf-8"
  );
  await fs.writeFile(
    path.join(root, "business/intro.md"),
    '# 公司介绍\n\n[公司]: ../model/entity/organization.md "entity"\n',
    "utf-8"
  );
  // 应被忽略
  await fs.writeFile(
    path.join(root, "node_modules/pkg/readme.md"),
    '[噪声]: ./x.md "entity"\n',
    "utf-8"
  );
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("scanWorkspace", () => {
  it("扫描所有 .md 并建立全局索引", async () => {
    const idx = await scanWorkspace(root);
    expect(idx.definitionsOf("公司").length).toBeGreaterThanOrEqual(2);
    expect(idx.definesIn(path.join(root, "model/entity/organization.md"), "公司", "entity")).toBe(true);
  });

  it("忽略 node_modules", async () => {
    const idx = await scanWorkspace(root);
    expect(idx.definitionsOf("噪声")).toHaveLength(0);
  });

  it("扫描后实例→model 引用可解析（无 TM021）", async () => {
    const idx = await scanWorkspace(root);
    const intro = path.join(root, "business/intro.md");
    const content = await fs.readFile(intro, "utf-8");
    const diags = computeCrossFileDiagnostics(idx, intro, analyzeOntology(intro, content).document);
    expect(diags.find((d) => d.code === "TM021")).toBeUndefined();
  });

  it("indexDocument：增量把单个文件内容写入索引", () => {
    const idx = new WorkspaceIndex();
    indexDocument(idx, "/ws/a.md", '[A]: ./a.md "entity"\n');
    expect(idx.definesIn("/ws/a.md", "A", "entity")).toBe(true);
  });

  // ----------------------------------------------------------------
  // v8.3 (Task #3200) — 扫描器自动注册 operator document，
  // 让 TM125/TM126 跨文件钩子在扫描后真正生效
  // ----------------------------------------------------------------
  it("v8.3 scanner：扫描后 operator document 已被注册", async () => {
    const opRoot = await fs.mkdtemp(path.join(os.tmpdir(), "ws-op-"));
    try {
      await fs.writeFile(
        path.join(opRoot, "op1.md"),
        [
          "---",
          "type: operator",
          "domain: traffic",
          "id: op1",
          "---",
          "## 属性",
          "",
          "| name | type | example |",
          "|------|------|---------|",
          "| result | string | [r](./e/a.md) |",
          "",
        ].join("\n"),
        "utf-8"
      );
      await fs.writeFile(
        path.join(opRoot, "op2.md"),
        [
          "---",
          "type: operator",
          "domain: traffic",
          "id: op2",
          "---",
          "## 属性",
          "",
          "| name | type | example |",
          "|------|------|---------|",
          "| result | string | [r](./e/b.md) |",
          "",
        ].join("\n"),
        "utf-8"
      );

      const idx = await scanWorkspace(opRoot);
      // 两个 operator 都已注册
      expect(idx.getOperatorDocuments()).toHaveLength(2);
      const f1 = path.join(opRoot, "op1.md");
      const diags = computeCrossFileDiagnostics(
        idx,
        f1,
        analyzeOntology(f1, await fs.readFile(f1, "utf-8")).document
      );
      // TM125：同 domain 同名同 type 不同 link → 报错
      expect(diags.find((d) => d.code === "TM125")).toBeDefined();
    } finally {
      await fs.rm(opRoot, { recursive: true, force: true });
    }
  });
});
