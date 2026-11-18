/**
 * @fileoverview OntologyLSPPlugin 测试（组合式）
 *
 * 契约：
 *  1. 主诊断 = markdown LSP（来自自持的 LSPManager）+ Ontology TM 诊断（analyzer）
 *  2. onAfterTool 把合并诊断附加到 write/edit 的 result.output
 *  3. LSP 失败不影响 Ontology 诊断（互相独立，不降级、不抛出）
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import type { Diagnostic } from "vscode-languageserver-types";
import { OntologyLSPPlugin } from "./ontologylsp-plugin";

function injectMockLsp(
  plugin: OntologyLSPPlugin,
  getDiagnostics: (filePath: string) => Promise<Diagnostic[]>
) {
  (plugin as any).lspManager = {
    getDiagnostics: vi.fn(getDiagnostics),
    prewarm: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

const MD_DIAG: Diagnostic = {
  severity: 1,
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
  message: "File does not exist at path: ./missing.md",
  source: "markdown",
};

let counter = 0;
async function writeTempMd(content: string, name = "doc"): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "onto-test-"));
  const file = path.join(dir, `${name}-${counter++}.md`);
  await fsp.writeFile(file, content, "utf-8");
  return file;
}

describe("OntologyLSPPlugin", () => {
  let plugin: OntologyLSPPlugin;
  afterEach(async () => {
    await plugin?.dispose();
  });

  it("isSupported 仅 .md/.markdown", () => {
    expect(OntologyLSPPlugin.isSupported("/a/b.md")).toBe(true);
    expect(OntologyLSPPlugin.isSupported("/a/b.markdown")).toBe(true);
    expect(OntologyLSPPlugin.isSupported("/a/b.ts")).toBe(false);
  });

  it("getDiagnostics 合并 markdown LSP 诊断与 Ontology TM 诊断", async () => {
    plugin = new OntologyLSPPlugin();
    injectMockLsp(plugin, async () => [MD_DIAG]);

    // 含非法 title → TM003
    const file = await writeTempMd('[x]: ./x.md "concept"\n', "business");
    const diags = await plugin.getDiagnostics(file);

    expect(diags.some((d) => d.source === "markdown")).toBe(true);
    expect(diags.some((d) => d.code === "TM003")).toBe(true);
  });

  it("onAfterTool 把诊断附加到 result.output（含 Ontology 标题）", async () => {
    plugin = new OntologyLSPPlugin();
    injectMockLsp(plugin, async () => []);

    const file = await writeTempMd('[x]: ./x.md "concept"\n', "business");
    const result: any = { output: "written" };
    await plugin.onAfterTool({
      tool: { name: "write_file" },
      args: { path: file },
      result,
    });

    expect(typeof result.output).toBe("string");
    expect(result.output).toContain("Ontology");
    expect(result.output).toContain("TM003");
  });

  it("LSP 抛错时仍返回 Ontology 诊断（不降级、不抛出）", async () => {
    plugin = new OntologyLSPPlugin();
    injectMockLsp(plugin, async () => {
      throw new Error("md server down");
    });

    const file = await writeTempMd('[x]: ./x.md "concept"\n', "business");
    const diags = await plugin.getDiagnostics(file);
    expect(diags.some((d) => d.code === "TM003")).toBe(true);
    expect(diags.some((d) => d.source === "markdown")).toBe(false);
  });

  it("合法 model 文档：无 TM 诊断（LSP 为空时整体为空）", async () => {
    plugin = new OntologyLSPPlugin();
    injectMockLsp(plugin, async () => []);

    const content = [
      "---",
      "type: model",
      "---",
      "# 管线",
      "## 管道气压",
      "",
      "[管道气压] 是 [设施] 的 [is-a]。",
      "",
      '[管道气压]: ./e/p.md "entity"',
      '[设施]: ./e/f.md "entity"',
      '[is-a]: ./r/is-a.md "operator"',
    ].join("\n");
    const file = await writeTempMd(content, "pipeline-model");
    const diags = await plugin.getDiagnostics(file);
    expect(diags).toHaveLength(0);
  });

  it("非写工具不处理", async () => {
    plugin = new OntologyLSPPlugin();
    injectMockLsp(plugin, async () => [MD_DIAG]);
    const result: any = { output: "x" };
    await plugin.onAfterTool({
      tool: { name: "read_file" },
      args: { path: "/a.md" },
      result,
    });
    expect(result.output).toBe("x");
  });

  describe("跨文件诊断（workspaceRoot 集成）", () => {
    let root: string;

    async function setupWorkspace(): Promise<string> {
      root = await fsp.mkdtemp(path.join(os.tmpdir(), "onto-ws-"));
      await fsp.mkdir(path.join(root, "model/entity"), { recursive: true });
      await fsp.mkdir(path.join(root, "business"), { recursive: true });
      await fsp.writeFile(
        path.join(root, "model/entity/organization.md"),
        '# 组织\n\n[公司]: ./organization.md "entity"\n',
        "utf-8"
      );
      return root;
    }

    afterEach(async () => {
      if (root) await fsp.rm(root, { recursive: true, force: true });
      root = "";
    });

    it("实例引用 model 中存在的术语 → 无 TM021", async () => {
      await setupWorkspace();
      const intro = path.join(root, "business/intro.md");
      await fsp.writeFile(
        intro,
        '# 介绍\n\n[公司]: ../model/entity/organization.md "entity"\n',
        "utf-8"
      );
      plugin = new OntologyLSPPlugin({
        markdownBaseDiagnostics: false,
        workspaceRoot: root,
      });
      const diags = await plugin.getDiagnostics(intro);
      expect(diags.find((d) => d.code === "TM021")).toBeUndefined();
    });

    it("实例引用 model 中不存在的术语 → 报 TM021", async () => {
      await setupWorkspace();
      const intro = path.join(root, "business/intro.md");
      await fsp.writeFile(
        intro,
        '# 介绍\n\n[部门]: ../model/entity/organization.md "entity"\n',
        "utf-8"
      );
      plugin = new OntologyLSPPlugin({
        markdownBaseDiagnostics: false,
        workspaceRoot: root,
      });
      const diags = await plugin.getDiagnostics(intro);
      const tm021 = diags.find((d) => d.code === "TM021");
      expect(tm021).toBeDefined();
      expect(tm021!.message).toContain("部门");
    });

    it("未设置 workspaceRoot 时不产出跨文件诊断", async () => {
      const file = await writeTempMd('[幽灵]: ../model/ghost.md "entity"\n', "business");
      plugin = new OntologyLSPPlugin({ markdownBaseDiagnostics: false });
      const diags = await plugin.getDiagnostics(file);
      expect(diags.find((d) => d.code === "TM010" || d.code === "TM021")).toBeUndefined();
    });
  });
});
