/**
 * @fileoverview bgTaskId ALS TDD tests (Task #2144)
 *
 * 镜像 process-registry.ts 的 ALS 模式：把当前 BackgroundTask 的 bgTaskId
 * 推到 ALS 栈顶，让 workflow_run 等工具在 sub-session 内部能读到所属
 * bgTaskId，从而把启动的 workflow runId 注册到 BackgroundTaskManager 的
 * workflowRunRegistries 里，供 stopTask() 级联 stop。
 *
 * 主 session 直接调用（CLI `roy-bot workflow run ...`）时无 bgTaskId，
 * getCurrentBgTaskId() 返回 undefined，工具跳过 attach —— 保持零变化。
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect } from "bun:test";
import {
  runWithBgTaskIdAsync,
  getCurrentBgTaskId,
} from "./bg-task-id-storage";

describe("bgTaskId ALS (Task #2144)", () => {
  test("returns undefined outside any bgTask scope", () => {
    expect(getCurrentBgTaskId()).toBeUndefined();
  });

  test("exposes bgTaskId inside runWithBgTaskIdAsync", async () => {
    await runWithBgTaskIdAsync("bg_aaa", async () => {
      expect(getCurrentBgTaskId()).toBe("bg_aaa");
    });
    // Outside the scope again
    expect(getCurrentBgTaskId()).toBeUndefined();
  });

  test("nested scopes shadow outer id (innermost wins)", async () => {
    await runWithBgTaskIdAsync("outer", async () => {
      await runWithBgTaskIdAsync("inner", async () => {
        expect(getCurrentBgTaskId()).toBe("inner");
      });
      // Back to outer after inner scope exits
      expect(getCurrentBgTaskId()).toBe("outer");
    });
  });

  test("parallel scopes are isolated", async () => {
    await Promise.all([
      runWithBgTaskIdAsync("A", async () => {
        await new Promise((r) => setTimeout(r, 30));
        expect(getCurrentBgTaskId()).toBe("A");
      }),
      runWithBgTaskIdAsync("B", async () => {
        await new Promise((r) => setTimeout(r, 10));
        expect(getCurrentBgTaskId()).toBe("B");
      }),
    ]);
  });

  test("propagates across awaited microtasks (AsyncLocalStorage contract)", async () => {
    await runWithBgTaskIdAsync("bg_propagate", async () => {
      // Microtask boundary
      await Promise.resolve();
      expect(getCurrentBgTaskId()).toBe("bg_propagate");

      // setTimeout boundary (macrotask)
      await new Promise((r) => setTimeout(r, 5));
      expect(getCurrentBgTaskId()).toBe("bg_propagate");
    });
  });
});
