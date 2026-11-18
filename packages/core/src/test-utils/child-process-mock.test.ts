/**
 * @fileoverview Unit tests for the shared child_process mock factory.
 *
 * 背景（Task #4420）：
 *   Bun 的 `mock.module("child_process", () => ({...}))` 走 **ESM exports 语义** ——
 *   返回对象必须是**完整导出面**。少任何一个命名导出（如 `exec`），任何静态
 *   import 该导出的模块都会在加载期直接抛：
 *     SyntaxError: Export named 'exec' not found in module 'node:child_process'.
 *   这会让整个测试文件瞬间从「部分红」变成「全红」，且错误信息指向被 import
 *   的模块而不是 mock 本身，极难定位。
 *
 * 这个 helper 的核心保证：**导出面从真实模块自省派生**，因此永远完整，
 * 不会因为 Node/Bun 新增导出或源码新增 import 而再次腐化。
 */

import { describe, test, expect } from "bun:test";
import {
  createChildProcessMockModule,
  CHILD_PROCESS_EXPORT_NAMES,
} from "./child-process-mock";

describe("createChildProcessMockModule — 完整导出面", () => {
  test("覆盖 node:child_process 的全部 ESM 命名导出", () => {
    const mocked = createChildProcessMockModule();
    const ns: Record<string, unknown> = require("node:child_process");

    // 真实模块的每个可枚举 key 都必须在 mock 里存在
    const actualKeys = Object.keys(ns);
    expect(actualKeys.length).toBeGreaterThan(0);

    for (const key of actualKeys) {
      expect(mocked).toHaveProperty(key);
    }
  });

  test("显式钉住当前用到的 8 个命名导出（防止自省逻辑本身退化）", () => {
    const mocked = createChildProcessMockModule();
    for (const name of [
      "ChildProcess",
      "exec",
      "execFile",
      "execFileSync",
      "execSync",
      "fork",
      "spawn",
      "spawnSync",
    ]) {
      expect(typeof mocked[name]).not.toBe("undefined");
    }
    // 这 8 个 + default 是 Bun 当前命名空间的完整枚举
    expect(CHILD_PROCESS_EXPORT_NAMES).toContain("exec");
    expect(CHILD_PROCESS_EXPORT_NAMES).toContain("spawnSync");
  });

  test("ESM default 导出存在（require() 没有 default，ESM namespace 有）", () => {
    const mocked = createChildProcessMockModule();
    expect(mocked.default).toBeDefined();

    // 真实 ESM namespace 确实有 default，而 require() 没有 —— 这是必须在
    // mock 里显式补 default 的原因
    expect("default" in require("node:child_process")).toBe(false);
  });

  test("default 上的导出与命名导出一致（含覆盖项）", () => {
    const spawnOverride = () => ({ pid: 1 });
    const mocked = createChildProcessMockModule({ spawn: spawnOverride as any });

    expect(mocked.spawn).toBe(spawnOverride as any);
    expect((mocked.default as any).spawn).toBe(spawnOverride as any);
  });
});

describe("createChildProcessMockModule — 覆盖语义", () => {
  test("未覆盖的导出保留真实实现（exec 可 awaitable）", () => {
    const mocked = createChildProcessMockModule();
    // exec 是真实函数，可被 promisify 使用 —— 源码顶层
    // `promisify(exec)` 不会炸
    expect(typeof mocked.exec).toBe("function");
    expect(typeof mocked.spawn).toBe("function");
  });

  test("覆盖 spawn 后不影响其他导出", () => {
    const spawnOverride = () => ({ pid: 42 });
    const mocked = createChildProcessMockModule({ spawn: spawnOverride as any });

    expect(mocked.spawn).toBe(spawnOverride as any);
    expect(typeof mocked.exec).toBe("function");
    expect(typeof mocked.spawnSync).toBe("function");
    expect(typeof mocked.execFile).toBe("function");
  });

  test("多次调用互不干扰（每次返回新对象）", () => {
    const a = createChildProcessMockModule();
    const b = createChildProcessMockModule();
    expect(a).not.toBe(b);
    expect(a.default).not.toBe(b.default);
  });
});
