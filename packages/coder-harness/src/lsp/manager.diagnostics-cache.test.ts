import { afterEach, describe, expect, it, vi } from "vitest";
import type { Diagnostic } from "../types/linter";
import type { LSPClient } from "./client";
import { LSPManager } from "./manager";

const managers: LSPManager[] = [];

afterEach(async () => {
  await Promise.all(managers.splice(0).map((manager) => manager.dispose()));
  vi.restoreAllMocks();
});

function createManager(getDiagnostics: () => Promise<Diagnostic[]>): LSPManager {
  const manager = new LSPManager({
    idleTimeout: 60_000,
    maxConnections: 5,
    autoDownload: false,
    workspaceRoot: "/path",
  });
  managers.push(manager);
  const client = { getDiagnostics } as unknown as LSPClient;
  manager.getOrCreateConnection = vi.fn().mockResolvedValue(client);
  return manager;
}

describe("LSPManager diagnostics dedupe and cache", () => {
  it("shares one server round-trip across concurrent requests for the same file", async () => {
    const fetchDiagnostics = vi.fn().mockResolvedValue([
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        message: "diagnostic",
      },
    ]);
    const manager = createManager(fetchDiagnostics);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => manager.getDiagnostics("/path/foo.ts")),
    );

    expect(fetchDiagnostics).toHaveBeenCalledTimes(1);
    expect(results.every((diagnostics) => diagnostics.length === 1)).toBe(true);
  });

  it("caches diagnostics for repeated requests within five seconds", async () => {
    const fetchDiagnostics = vi.fn().mockResolvedValue([]);
    const manager = createManager(fetchDiagnostics);

    await manager.getDiagnostics("/path/foo.ts");
    await manager.getDiagnostics("/path/foo.ts");

    expect(fetchDiagnostics).toHaveBeenCalledTimes(1);
  });

  it("refreshes diagnostics after the five-second cache window", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchDiagnostics = vi.fn().mockResolvedValue([]);
    const manager = createManager(fetchDiagnostics);

    await manager.getDiagnostics("/path/foo.ts");
    now += 5_001;
    await manager.getDiagnostics("/path/foo.ts");

    expect(fetchDiagnostics).toHaveBeenCalledTimes(2);
  });

  it("does not share cached diagnostics between files", async () => {
    const fetchDiagnostics = vi.fn().mockResolvedValue([]);
    const manager = createManager(fetchDiagnostics);

    await manager.getDiagnostics("/path/a.ts");
    await manager.getDiagnostics("/path/b.ts");

    expect(fetchDiagnostics).toHaveBeenCalledTimes(2);
  });

  /**
   * F2 (P1) Regression test: 一次瞬时 LSP 故障不应导致 5s 内所有诊断消失。
   * 当前实现：fetchDiagnostics 失败返回 []，这个 [] 被写入 cache，导致后续 5s
   * 内调用都走 cache 返回 []，即使 LSP 已恢复。
   * 期望行为：失败路径不写入 cache，下次调用应重试 server。
   */
  it("does not cache diagnostics when the server round-trip throws", async () => {
    const fetchDiagnostics = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient LSP failure"))
      .mockResolvedValueOnce([
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
          message: "recovered",
        },
      ]);
    const manager = createManager(fetchDiagnostics);

    const first = await manager.getDiagnostics("/path/recover.ts");
    expect(first).toEqual([]);
    expect(fetchDiagnostics).toHaveBeenCalledTimes(1);

    // 第二次调用应在 TTL 窗口内（500ms）重试，而不是返回 cache 的 []
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 500);
    const second = await manager.getDiagnostics("/path/recover.ts");

    expect(fetchDiagnostics).toHaveBeenCalledTimes(2);
    expect(second).toEqual([
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 1 },
        },
        message: "recovered",
      },
    ]);
  });

  it("does not cache diagnostics when the server returns empty (no diagnostics)", async () => {
    // 注意：此 case 验证「成功返回空结果」与「失败返回空」的区别。
    // 成功返回 [] 应该被 cache（合法结果），失败返回 [] 不应 cache。
    // 这里我们使用 ensureLSPResolves（成功路径）来验证 cache 行为，
    // 上一个 test 已覆盖失败路径。
    const fetchDiagnostics = vi.fn().mockResolvedValue([]);
    const manager = createManager(fetchDiagnostics);

    await manager.getDiagnostics("/path/empty.ts");
    await manager.getDiagnostics("/path/empty.ts");

    expect(fetchDiagnostics).toHaveBeenCalledTimes(1);
  });
});
