/**
 * @fileoverview Trace field-shape 验证测试 (Phase 6 closure)
 *
 * Phase 6 cli-e2e-test 失败：traces.db 中 span 名称对了，
 * 但 attributes 不包含 plan 里要求的命名字段（serverIds, workspaceRoot 等）。
 *
 * 修复策略：扩展 @TracedAs 的 paramFilter / resultFilter，
 * 让 filter 返回的对象 flatten 到 span attributes 顶层。
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LSPManager } from "./manager";

const XDG_DATA_HOME = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
const TRACES_DB_PATH = join(XDG_DATA_HOME, "roy-bot", "traces.db");

interface SpanRow {
  span_id: string;
  name: string;
  attributes: string | null;
  result: string | null;
}

describe("LSPManager trace field-shape (Phase 6 closure)", () => {
  let manager: LSPManager | undefined;

  afterEach(async () => {
    await manager?.dispose().catch(() => {});
    manager = undefined;
    vi.restoreAllMocks();
  });

  /**
   * Find latest span with given name, optionally filtered by attributes.
   * Filters prevent race conditions when multiple test files create spans
   * with the same name in parallel (`--parallel 4`).
   */
  function findLatestSpan(name: string, attributeFilter?: Record<string, unknown>): SpanRow | null {
    if (!existsSync(TRACES_DB_PATH)) return null;
    const db = new Database(TRACES_DB_PATH, { readonly: true });
    let sql = "SELECT span_id, name, attributes, result FROM span WHERE name = ?";
    const params: (string | number)[] = [name];
    if (attributeFilter) {
      for (const [key, value] of Object.entries(attributeFilter)) {
        // JSON attribute filter: match "key":value literally
        sql += " AND attributes LIKE ?";
        params.push(`%"${key}":${JSON.stringify(value)}%`);
      }
    }
    sql += " ORDER BY start_time DESC LIMIT 1";
    const row = db.query<SpanRow, (string | number)[]>(sql).get(...params);
    db.close();
    return row ?? null;
  }

  it("prewarm span attributes contain top-level 'serverIds' and 'workspaceRoot'", { timeout: 30000 }, async () => {
    manager = new LSPManager({
      idleTimeout: 5000,
      maxConnections: 5,
      autoDownload: false,
      workspaceRoot: "/trace-field/workspace",
    });

    await manager.prewarm(["typescript"], "/trace-field/workspace");
    await new Promise((r) => setTimeout(r, 200));

    const span = findLatestSpan("lsp-manager.prewarm", {
      serverIds: ["typescript"],
      workspaceRoot: "/trace-field/workspace",
    });
    expect(span).not.toBeNull();
    const attrs = JSON.parse(span!.attributes ?? "{}");
    // Phase 6 要求顶层 attributes 包含 serverIds / workspaceRoot
    expect(attrs).toHaveProperty("serverIds");
    expect(attrs).toHaveProperty("workspaceRoot");
    expect(attrs.serverIds).toEqual(["typescript"]);
    expect(attrs.workspaceRoot).toBe("/trace-field/workspace");
  });

  it("getDiagnostics span attributes contain top-level 'filePath'", { timeout: 30000 }, async () => {
    manager = new LSPManager({
      idleTimeout: 5000,
      maxConnections: 5,
      autoDownload: false,
    });

    await manager.getDiagnostics("/trace-field/test.ts");
    await new Promise((r) => setTimeout(r, 200));

    const span = findLatestSpan("lsp-manager.getDiagnostics", {
      filePath: "/trace-field/test.ts",
    });
    expect(span).not.toBeNull();
    const attrs = JSON.parse(span!.attributes ?? "{}");
    expect(attrs).toHaveProperty("filePath");
    expect(attrs.filePath).toBe("/trace-field/test.ts");
  });

  it("getOrCreateConnection span attributes contain top-level 'serverId' and 'filePath'", { timeout: 30000 }, async () => {
    manager = new LSPManager({
      idleTimeout: 5000,
      maxConnections: 5,
      autoDownload: false,
      workspaceRoot: "/trace-field/workspace",
    });

    await manager.getOrCreateConnection("typescript", "/trace-field/workspace/src/index.ts");
    await new Promise((r) => setTimeout(r, 200));

    const span = findLatestSpan("lsp-manager.getOrCreateConnection", {
      serverId: "typescript",
      filePath: "/trace-field/workspace/src/index.ts",
    });
    expect(span).not.toBeNull();
    const attrs = JSON.parse(span!.attributes ?? "{}");
    expect(attrs).toHaveProperty("serverId");
    expect(attrs).toHaveProperty("filePath");
    expect(attrs.serverId).toBe("typescript");
    expect(attrs.filePath).toBe("/trace-field/workspace/src/index.ts");
  });
});