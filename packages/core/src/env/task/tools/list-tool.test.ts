/**
 * @fileoverview task_list tool specific tests
 *
 * Regression coverage for the bug where the `total` field was placed at
 * the END of the returned JSON, causing it to be lost when
 * ToolComponent.truncateOutput (maxOutputSize=50000) cut off the tail
 * of large responses.
 *
 * These tests verify:
 *   1. `total` is the FIRST property in the raw JSON string output
 *      (so it survives tail-truncation).
 *   2. `truncated` is true when total > count (data WAS truncated).
 *   3. `truncated` is false when total === count (data was NOT truncated).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import { createTaskTool } from "./create-tool";
import { listTasksTool } from "./list-tool";

describe("listTasksTool - output structure (bug fix: total position + truncated flag)", () => {
  let taskComponent: TaskComponent;
  let parentTaskId: number;

  beforeEach(async () => {
    const configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    await taskComponent.init({
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(tmpdir(), `list-tool-test-${Date.now()}.db`),
          },
        },
      },
    });

    // Bypass tool validation via the store to create a parent task
    const parentTask = await (taskComponent as any).store.createTask({
      title: "Parent Task",
      project_path: "unknown",
      context: "{}",
      sessionId: "sess_init",
    });
    parentTaskId = parentTask.id;
  });

  afterEach(async () => {
    await taskComponent.stop();
  });

  it("should place `total` as the FIRST key in the raw JSON output (regression test for truncation bug)", async () => {
    // Create some tasks so total > 0
    const createTool = createTaskTool(taskComponent);
    await createTool.execute(
      { parent_task_id: parentTaskId, title: "Task A", project_path: "unknown", context: "{}" },
      { session_id: "sess_123" }
    );
    await createTool.execute(
      { parent_task_id: parentTaskId, title: "Task B", project_path: "unknown", context: "{}" },
      { session_id: "sess_123" }
    );

    const tool = listTasksTool(taskComponent);
    const result = await tool.execute({}, { session_id: "sess_123" });

    expect(result.success).toBe(true);
    expect(typeof result.output).toBe("string");

    const raw = result.output as string;

    // The JSON object's literal first key MUST be "total" so that the
    // tail-truncation logic in tool-component.ts cannot strip it.
    expect(raw.startsWith('{"total":')).toBe(true);

    // Sanity: still parseable JSON with the expected shape
    const data = JSON.parse(raw);
    expect(typeof data.total).toBe("number");
    expect(typeof data.count).toBe("number");
    expect(typeof data.truncated).toBe("boolean");
    expect(Array.isArray(data.tasks)).toBe(true);
  });

  it("should set `truncated: true` when total > count (pagination in effect)", async () => {
    // Create 5 child tasks; parent itself counts towards total but is NOT
    // returned via depth:0... we'll use the default depth and rely on
    // limit to force truncation of the returned array.
    for (let i = 0; i < 5; i++) {
      const createTool = createTaskTool(taskComponent);
      await createTool.execute(
        { parent_task_id: parentTaskId, title: `Task ${i}`, project_path: "unknown", context: "{}" },
        { session_id: "sess_123" }
      );
    }

    const tool = listTasksTool(taskComponent);
    const result = await tool.execute({ limit: 2, offset: 0 }, { session_id: "sess_123" });

    expect(result.success).toBe(true);
    const data = JSON.parse(result.output as string);

    // total is the count of all matching rows BEFORE pagination
    expect(data.total).toBeGreaterThan(data.count);
    expect(data.count).toBe(2);
    expect(data.truncated).toBe(true);
  });

  it("should set `truncated: false` when total === count (no pagination truncation)", async () => {
    // Create just 1 task. Total = 1, default limit = 20 → no truncation.
    const createTool = createTaskTool(taskComponent);
    await createTool.execute(
      { parent_task_id: parentTaskId, title: "Solo Task", project_path: "unknown", context: "{}" },
      { session_id: "sess_123" }
    );

    const tool = listTasksTool(taskComponent);
    // Use a large limit so total === count
    const result = await tool.execute({ limit: 100, offset: 0 }, { session_id: "sess_123" });

    expect(result.success).toBe(true);
    const data = JSON.parse(result.output as string);

    expect(data.total).toBe(data.count);
    expect(data.truncated).toBe(false);
  });

  it("should survive simulated truncation: `total` remains visible in the first 200 chars", async () => {
    // This simulates what tool-component.ts does: tail-truncates the
    // output string with maxOutputSize (default 50000 chars). For very
    // large outputs, anything beyond the limit is lost. Ensure the
    // most critical field, total, is at the front so it's never lost.
    const createTool = createTaskTool(taskComponent);
    await createTool.execute(
      { parent_task_id: parentTaskId, title: "Sample", project_path: "unknown", context: "{}" },
      { session_id: "sess_123" }
    );

    const tool = listTasksTool(taskComponent);
    const result = await tool.execute({}, { session_id: "sess_123" });

    expect(result.success).toBe(true);
    const raw = result.output as string;

    // The first 200 characters of the JSON output MUST contain the
    // `total` key, since `total` is the most important field and
    // ToolComponent.truncateOutput cuts from the END.
    const head = raw.substring(0, 200);
    expect(head).toContain("\"total\":");

    // And the actual `total` value must be parseable from the head alone
    // (in case the agent only sees a truncated response).
    const match = head.match(/"total"\s*:\s*(\d+)/);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBeGreaterThanOrEqual(1);
  });
});
