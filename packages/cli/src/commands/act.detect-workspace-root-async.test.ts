/**
 * @fileoverview detectWorkspaceRootAsync 测试 (F8)
 *
 * 同步版 detectWorkspaceRoot 用 execFileSync，会阻塞 CLI 启动。
 * 异步版本 detectWorkspaceRootAsync 用 promisify(execFile)，不阻塞主线程。
 * 保留同步版本（兼容现有测试）。
 */
import { describe, expect, it } from "vitest";
import {
  detectWorkspaceRootAsync,
  detectWorkspaceRoot,
} from "./act";

describe("detectWorkspaceRootAsync (F8)", () => {
  it("exports an async version that returns a Promise<string>", async () => {
    expect(typeof detectWorkspaceRootAsync).toBe("function");
    const result = detectWorkspaceRootAsync("/some/path");
    expect(result).toBeInstanceOf(Promise);
    const value = await result;
    // /some/path 不在 git repo 中 → 应回退到 cwd 本身
    expect(typeof value).toBe("string");
    expect(value.length).toBeGreaterThan(0);
  });

  it("sync detectWorkspaceRoot still works (backward compat)", () => {
    expect(typeof detectWorkspaceRoot).toBe("function");
    const result = detectWorkspaceRoot("/some/path");
    expect(result).toBe("/some/path");
  });

  it("detectWorkspaceRootAsync result equals sync version for same cwd", async () => {
    const cwd = "/tmp";
    const syncResult = detectWorkspaceRoot(cwd);
    const asyncResult = await detectWorkspaceRootAsync(cwd);
    expect(asyncResult).toBe(syncResult);
  });
});