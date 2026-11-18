/**
 * Task #2164 (Phase 4 TDD, RED phase) — `BackgroundTaskManager.DEFAULT_WORKFLOW_ENTRY_AGENT`
 * must equal "workflow-runner" (not the legacy "workflow-agent").
 *
 * 铁律:
 * - 这是一个单例元数据常量，必须被命名为 "workflow-runner" 才能保持与
 *   `registerWorkflowRunner()` 同步; 任何 drift 都会导致 `resolveEntryAgent()`
 *   在 fallback 路径返回不存在的 agent name。
 */
import { describe, expect, test } from "vitest";
import { BackgroundTaskManager } from "./delegate-tool";

describe("BackgroundTaskManager.DEFAULT_WORKFLOW_ENTRY_AGENT (Task #2164)", () => {
  test("is 'workflow-runner' (not 'workflow-agent')", () => {
    expect(BackgroundTaskManager.DEFAULT_WORKFLOW_ENTRY_AGENT).toBe("workflow-runner");
  });
});
