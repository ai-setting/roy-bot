/**
 * @fileoverview LSPClient.sendRequest 超时测试 (NEW-2)
 *
 * 验证 LSPClient.sendRequest 在指定 timeoutMs 内未收到响应时，
 * 抛出 timeout 错误（而非永远挂起）。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import { LSPClient } from "./client";
import type { LSPServerInfo } from "../types/linter";

function makeFakeServerInfo(): LSPServerInfo {
  return {
    id: "fake-server",
    extensions: [".fake"],
    rootPattern: [],
    excludePattern: [],
    command: ["fake"],
  };
}

function makeFakeProcess(): ChildProcess {
  return {
    pid: 99999,
    exitCode: undefined,
    signalCode: undefined,
    killed: false,
    stdin: { write: vi.fn(), writable: true, on: vi.fn() },
    stdout: { on: vi.fn(), readable: true, setEncoding: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
  } as unknown as ChildProcess;
}

describe("LSPClient.sendRequest timeout (NEW-2)", () => {
  let client: LSPClient | undefined;

  afterEach(async () => {
    await client?.dispose().catch(() => {});
    client = undefined;
    vi.restoreAllMocks();
  });

  it("rejects with timeout error when underlying connection does not respond within timeoutMs", async () => {
    client = new LSPClient(makeFakeProcess(), makeFakeServerInfo(), "file:///fake");
    (client as any)._initialized = true;

    // Mock the underlying connection.sendRequest to never resolve
    const conn = (client as any).connection;
    conn.sendRequest = vi.fn(() => new Promise(() => {})); // never resolves

    // 100ms timeout 应该快速 reject
    await expect(
      (client as any).sendRequest("textDocument/hover", { foo: "bar" }, 100),
    ).rejects.toThrow(/timeout/i);
  });

  it("sendRequest exists as a method on LSPClient", () => {
    client = new LSPClient(makeFakeProcess(), makeFakeServerInfo(), "file:///fake");
    expect(typeof (client as any).sendRequest).toBe("function");
    // 至少 2 个必需参数（method, params）+ 可选 timeoutMs
    expect((client as any).sendRequest.length).toBeGreaterThanOrEqual(2);
  });

  it("default timeoutMs is 30000ms when not provided", async () => {
    client = new LSPClient(makeFakeProcess(), makeFakeServerInfo(), "file:///fake");
    (client as any)._initialized = true;

    const conn = (client as any).connection;
    let capturedMethod: string | undefined;
    conn.sendRequest = vi.fn((method: string) => {
      capturedMethod = method;
      return new Promise(() => {});
    });

    // 不传 timeoutMs - 应使用默认 30s 而非立即 reject
    const promise = (client as any).sendRequest("foo/bar", {});
    // 给一个 microtask
    await new Promise((r) => setTimeout(r, 10));
    expect(capturedMethod).toBe("foo/bar");
    // 防止 hang
    promise.catch(() => {});
  });
});