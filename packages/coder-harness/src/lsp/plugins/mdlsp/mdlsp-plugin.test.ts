/**
 * @fileoverview MDLSPPlugin 测试 — LSP-first 行为
 *
 * 覆盖重构后的核心契约：
 *  1. markdown LSP 是主诊断来源（getDiagnostics 优先返回 LSPManager 的结果）
 *  2. wikilink 实体引用**默认关闭**，开启后在 LSP 诊断之后**追加**
 *  3. 无降级：LSP 抛错时仅记录、返回（不回退成 wikilink-only）
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { MDLSPPlugin } from "../mdlsp-plugin";
import type { Diagnostic } from "vscode-languageserver-types";

/** 构造一个最小的 LSPManager mock 并注入插件 */
function injectMockLspManager(
  plugin: MDLSPPlugin,
  getDiagnostics: (filePath: string) => Promise<Diagnostic[]>
) {
  (plugin as any).lspManager = {
    getDiagnostics: vi.fn(getDiagnostics),
    prewarm: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

const LSP_DIAG: Diagnostic = {
  severity: 1,
  range: {
    start: { line: 1, character: 0 },
    end: { line: 1, character: 10 },
  },
  message: "No link for './missing.md'",
  source: "markdown",
  code: "no-such-file",
};

describe("MDLSPPlugin (LSP-first)", () => {
  let plugin: MDLSPPlugin;

  afterEach(async () => {
    await plugin?.dispose();
  });

  describe("isSupported", () => {
    it("支持 .md / .markdown，不支持其它", () => {
      expect(MDLSPPlugin.isSupported("/a/b.md")).toBe(true);
      expect(MDLSPPlugin.isSupported("/a/b.markdown")).toBe(true);
      expect(MDLSPPlugin.isSupported("/a/b.ts")).toBe(false);
      expect(MDLSPPlugin.isSupported("/a/b.txt")).toBe(false);
    });
  });

  describe("默认配置", () => {
    it("entityReferences 默认关闭", () => {
      plugin = new MDLSPPlugin();
      const status = plugin.getStatus();
      expect(status.entityReferences).toBe(false);
    });
  });

  describe("getDiagnostics — 主来源 LSP", () => {
    it("返回 LSPManager 的诊断", async () => {
      plugin = new MDLSPPlugin();
      injectMockLspManager(plugin, async () => [LSP_DIAG]);

      const diags = await plugin.getDiagnostics("/ws/test.md");
      expect(diags).toHaveLength(1);
      expect(diags[0].message).toContain("missing.md");
      expect(diags[0].source).toBe("markdown");
    });

    it("默认不追加 wikilink 诊断（即使文本里有 [[...]]）", async () => {
      plugin = new MDLSPPlugin();
      // LSP 返回空；如果错误地走了 wikilink，会多出 hint
      injectMockLspManager(plugin, async () => []);

      // 写一个含 wikilink 的临时文件
      const diags = await plugin.getDiagnostics(
        await writeTempMd("see [[SomeEntity]] here")
      );
      expect(diags).toHaveLength(0);
    });
  });

  describe("getDiagnostics — entityReferences=true 时追加 wikilink", () => {
    it("在 LSP 诊断之后追加 wikilink 诊断", async () => {
      plugin = new MDLSPPlugin({ entityReferences: true });
      injectMockLspManager(plugin, async () => [LSP_DIAG]);

      const file = await writeTempMd("see [[SomeEntity]] here");
      const diags = await plugin.getDiagnostics(file);

      // 第一个是 LSP 诊断，后面是 wikilink 诊断
      expect(diags.length).toBeGreaterThanOrEqual(2);
      expect(diags[0].source).toBe("markdown");
      const wikilink = diags.find((d) => d.source === "MDLSP");
      expect(wikilink).toBeDefined();
      expect(wikilink!.message).toContain("SomeEntity");
    });
  });

  describe("无降级", () => {
    it("LSP 抛错时返回空（不回退 wikilink），即使 entityReferences=false", async () => {
      plugin = new MDLSPPlugin();
      injectMockLspManager(plugin, async () => {
        throw new Error("boom: markdown server failed to start");
      });

      const file = await writeTempMd("see [[SomeEntity]] here");
      const diags = await plugin.getDiagnostics(file);
      expect(diags).toEqual([]);
    });

    it("LSP 抛错 + entityReferences=true 时，只剩 wikilink 诊断（LSP 部分跳过）", async () => {
      plugin = new MDLSPPlugin({ entityReferences: true });
      injectMockLspManager(plugin, async () => {
        throw new Error("boom");
      });

      const file = await writeTempMd("see [[SomeEntity]] here");
      const diags = await plugin.getDiagnostics(file);
      // LSP 部分为空，但 wikilink 仍会产出
      expect(diags.every((d) => d.source === "MDLSP")).toBe(true);
      expect(diags.length).toBeGreaterThan(0);
    });
  });
});

// ---- helpers ----
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";

let _tmpCounter = 0;
async function writeTempMd(content: string): Promise<string> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "mdlsp-test-"));
  const file = path.join(dir, `doc-${_tmpCounter++}.md`);
  await fsp.writeFile(file, content, "utf-8");
  return file;
}
