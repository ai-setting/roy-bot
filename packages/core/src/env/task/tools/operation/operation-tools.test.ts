/**
 * @fileoverview Operation Tools Tests
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "../../task-component";
import { ConfigComponent } from "../../../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";
import { createTaskTool } from "../create-tool";
import {
  CreateOperationToolSchema,
  UpdateOperationToolSchema,
  PROCESS_DESCRIPTION_MIN_LENGTH,
  PROCESS_DESCRIPTION_MAX_LENGTH,
} from "./operation-types";
import {
  createOperationTool,
  getOperationTool,
  listOperationsTool,
  updateOperationTool,
  deleteOperationTool
} from "./index";

/**
 * Helper: 生成落在 [100, PROCESS_DESCRIPTION_MAX_LENGTH] 区间的字符串
 * （数字 + 中文填充字符，确保字符数可精确计算）
 */
function buildProcessDescription(targetLength: number): string {
  // 1 数字 + 填充中文（每个中文 1 字符）
  const prefix = "[process] ";
  const filler = "过".repeat(Math.max(0, targetLength - prefix.length));
  return prefix + filler;
}

describe("Operation Tools", () => {
  let taskComponent: TaskComponent;
  let taskId: number;
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
            dbPath: join(tmpdir(), `operation-tools-test-${Date.now()}.db`),
          },
        },
      },
    });
    
    // Create a parent task first (bypass validation via store)
    const parentTask = await (taskComponent as any).store.createTask({
      title: "Parent Task",
      project_path: "unknown",
      context: "{}",
      sessionId: "sess_init",
    });
    parentTaskId = parentTask.id;
    
    // Create a task for testing operations
    const createTool = createTaskTool(taskComponent);
    const result = await createTool.execute(
      { title: "Test Task", parent_task_id: parentTaskId, project_path: "unknown", context: "{}" },
      { session_id: "sess_123" }
    );
    taskId = result.metadata?.task_id as number;
  });
  
  afterEach(async () => {
    await taskComponent.stop();
  });
  
  describe("task_operation_create", () => {
    it("should create an operation record", async () => {
      const tool = createOperationTool(taskComponent);
      const result = await tool.execute(
        {
          task_id: taskId,
          milestone_type: "progress",
          milestone_title: "Made progress",
          milestone_description: "Completed feature X",
        },
        { session_id: "sess_456" }
      );
      
      expect(result.success).toBe(true);
      expect(result.output).toContain("Operation created");
      expect(result.metadata?.operation_id).toBeGreaterThan(0);
      expect(result.metadata?.session_id).toBe("sess_456");
    });
    
    it("should track sessionId from context", async () => {
      const tool = createOperationTool(taskComponent);
      const result = await tool.execute(
        {
          task_id: taskId,
          milestone_type: "milestone",
          milestone_title: "Reached milestone",
        },
        { session_id: "sess_789" }
      );
      
      expect(result.success).toBe(true);
      expect(result.metadata?.session_id).toBe("sess_789");
    });
  });
  
  describe("task_operation_get", () => {
    it("should get operation by id", async () => {
      // Create an operation first
      const createTool = createOperationTool(taskComponent);
      const createResult = await createTool.execute(
        { task_id: taskId, milestone_type: "progress", milestone_title: "Test" },
        { session_id: "sess_123" }
      );
      
      const opId = createResult.metadata?.operation_id as number;
      
      // Get it
      const tool = getOperationTool(taskComponent);
      const result = await tool.execute(
        { operation_id: opId },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(true);
      const op = JSON.parse(result.output as string);
      expect(op.milestoneType).toBe("progress");
      expect(op.sessionId).toBe("sess_123");
    });
    
    it("should return error for non-existent operation", async () => {
      const tool = getOperationTool(taskComponent);
      const result = await tool.execute(
        { operation_id: 99999 },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });
  });
  
  describe("task_operation_list", () => {
    it("should list operations for a task", async () => {
      // Create multiple operations
      const createTool = createOperationTool(taskComponent);
      await createTool.execute(
        { task_id: taskId, milestone_type: "create", milestone_title: "Created" },
        { session_id: "sess_1" }
      );
      await createTool.execute(
        { task_id: taskId, milestone_type: "progress", milestone_title: "Progress 1" },
        { session_id: "sess_2" }
      );
      await createTool.execute(
        { task_id: taskId, milestone_type: "progress", milestone_title: "Progress 2" },
        { session_id: "sess_3" }
      );
      
      // List them
      const tool = listOperationsTool(taskComponent);
      const result = await tool.execute(
        { task_id: taskId },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output as string);
      expect(data.count).toBeGreaterThanOrEqual(3);
    });
    
    it("should filter by action_type", async () => {
      const createTool = createOperationTool(taskComponent);
      await createTool.execute(
        { task_id: taskId, milestone_type: "progress", milestone_title: "P1" },
        { session_id: "sess_1" }
      );
      await createTool.execute(
        { task_id: taskId, milestone_type: "milestone", milestone_title: "M1" },
        { session_id: "sess_2" }
      );
      await createTool.execute(
        { task_id: taskId, milestone_type: "progress", milestone_title: "P2" },
        { session_id: "sess_3" }
      );
      
      const tool = listOperationsTool(taskComponent);
      const result = await tool.execute(
        { task_id: taskId, milestone_type: "progress" },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(true);
      const data = JSON.parse(result.output as string);
      expect(data.operations.every((op: any) => op.milestoneType === "progress")).toBe(true);
    });
  });
  
  describe("task_operation_update", () => {
    it("should update operation", async () => {
      // Create an operation
      const createTool = createOperationTool(taskComponent);
      const createResult = await createTool.execute(
        { task_id: taskId, milestone_type: "progress", milestone_title: "Original" },
        { session_id: "sess_123" }
      );
      
      const opId = createResult.metadata?.operation_id as number;
      
      // Update it
      const tool = updateOperationTool(taskComponent);
      const result = await tool.execute(
        { operation_id: opId, milestone_title: "Updated", milestone_description: "New description" },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(true);
      
      // Verify
      const getTool = getOperationTool(taskComponent);
      const getResult = await getTool.execute(
        { operation_id: opId },
        { session_id: "sess_123" }
      );
      const op = JSON.parse(getResult.output as string);
      expect(op.milestoneTitle).toBe("Updated");
      expect(op.milestoneDescription).toBe("New description");
    });
  });
  
  describe("task_operation_delete", () => {
    it("should delete operation", async () => {
      // Create an operation
      const createTool = createOperationTool(taskComponent);
      const createResult = await createTool.execute(
        { task_id: taskId, milestone_type: "progress", milestone_title: "Delete me" },
        { session_id: "sess_123" }
      );
      
      const opId = createResult.metadata?.operation_id as number;
      
      // Delete it
      const tool = deleteOperationTool(taskComponent);
      const result = await tool.execute(
        { operation_id: opId },
        { session_id: "sess_123" }
      );
      
      expect(result.success).toBe(true);
      
      // Verify it's gone
      const getTool = getOperationTool(taskComponent);
      const getResult = await getTool.execute(
        { operation_id: opId },
        { session_id: "sess_123" }
      );
      expect(getResult.success).toBe(false);
    });
  });
  
  describe("cross-session tracking", () => {
    it("should track operations from multiple sessions", async () => {
      const createTool = createOperationTool(taskComponent);
      
      await createTool.execute(
        { task_id: taskId, milestone_type: "create", milestone_title: "Session 1" },
        { session_id: "sess_alpha" }
      );
      
      await createTool.execute(
        { task_id: taskId, milestone_type: "progress", milestone_title: "Session 2" },
        { session_id: "sess_beta" }
      );
      
      await createTool.execute(
        { task_id: taskId, milestone_type: "milestone", milestone_title: "Session 3" },
        { session_id: "sess_gamma" }
      );
      
      // List and check sessions
      const tool = listOperationsTool(taskComponent);
      const result = await tool.execute(
        { task_id: taskId },
        { session_id: "sess_123" }
      );
      
      const data = JSON.parse(result.output as string);
      const sessions = new Set(data.operations.map((op: any) => op.sessionId));

      expect(sessions.has("sess_alpha")).toBe(true);
      expect(sessions.has("sess_beta")).toBe(true);
      expect(sessions.has("sess_gamma")).toBe(true);
    });
  });

  // ==========================================================================
  // process_description schema & storage tests (Task #2203)
  // 设计哲学：操作记录只承担 milestone 概要，详细过程通过 sessionId 回查
  // ==========================================================================

  describe("process_description schema validation", () => {
    it("accepts process_description in [100,150] chars", () => {
      const minText = buildProcessDescription(PROCESS_DESCRIPTION_MIN_LENGTH);
      const maxText = buildProcessDescription(PROCESS_DESCRIPTION_MAX_LENGTH);
      const middleText = buildProcessDescription(125);

      expect(minText.length).toBe(PROCESS_DESCRIPTION_MIN_LENGTH);
      expect(maxText.length).toBe(PROCESS_DESCRIPTION_MAX_LENGTH);

      expect(() =>
        CreateOperationToolSchema.parse({
          task_id: 1,
          milestone_type: "milestone",
          milestone_title: "X",
          process_description: minText,
        })
      ).not.toThrow();

      expect(() =>
        CreateOperationToolSchema.parse({
          task_id: 1,
          milestone_type: "milestone",
          milestone_title: "X",
          process_description: maxText,
        })
      ).not.toThrow();

      expect(() =>
        CreateOperationToolSchema.parse({
          task_id: 1,
          milestone_type: "milestone",
          milestone_title: "X",
          process_description: middleText,
        })
      ).not.toThrow();
    });

    it("rejects process_description shorter than 100 chars", () => {
      const tooShort = buildProcessDescription(PROCESS_DESCRIPTION_MIN_LENGTH - 1);
      expect(() =>
        CreateOperationToolSchema.parse({
          task_id: 1,
          milestone_type: "milestone",
          milestone_title: "X",
          process_description: tooShort,
        })
      ).toThrow(/process_description 太短/);
    });

    it("rejects process_description longer than the max limit", () => {
      const tooLong = buildProcessDescription(PROCESS_DESCRIPTION_MAX_LENGTH + 1);
      expect(() =>
        CreateOperationToolSchema.parse({
          task_id: 1,
          milestone_type: "milestone",
          milestone_title: "X",
          process_description: tooLong,
        })
      ).toThrow(/process_description 太长/);
    });

    // Task #4764: 上限放宽 150 -> 500，300 字符样本必须被接受
    it("accepts a 300-char process_description (Task #4764 widened limit)", () => {
      const sample300 = buildProcessDescription(300);
      expect(sample300.length).toBe(300);
      expect(() =>
        CreateOperationToolSchema.parse({
          task_id: 1,
          milestone_type: "milestone",
          milestone_title: "X",
          process_description: sample300,
        })
      ).not.toThrow();
    });

    it("update tool accepts a 300-char process_description (Task #4764)", () => {
      const sample300 = buildProcessDescription(300);
      expect(() =>
        UpdateOperationToolSchema.parse({
          operation_id: 1,
          process_description: sample300,
        })
      ).not.toThrow();
    });

    it("update tool accepts process_description in [100,150] chars", () => {
      const text = buildProcessDescription(120);
      expect(() =>
        UpdateOperationToolSchema.parse({
          operation_id: 1,
          process_description: text,
        })
      ).not.toThrow();
    });

    it("update tool rejects too-short process_description", () => {
      const tooShort = buildProcessDescription(99);
      expect(() =>
        UpdateOperationToolSchema.parse({
          operation_id: 1,
          process_description: tooShort,
        })
      ).toThrow(/process_description 太短/);
    });

    it("update tool rejects too-long process_description", () => {
      const tooLong = buildProcessDescription(PROCESS_DESCRIPTION_MAX_LENGTH + 1);
      expect(() =>
        UpdateOperationToolSchema.parse({
          operation_id: 1,
          process_description: tooLong,
        })
      ).toThrow(/process_description 太长/);
    });
  });

  describe("process_description end-to-end via tool", () => {
    it("creates operation with process_description and persists it", async () => {
      const tool = createOperationTool(taskComponent);
      const text = buildProcessDescription(120);

      const result = await tool.execute(
        {
          task_id: taskId,
          milestone_type: "milestone",
          milestone_title: "Reached design lock",
          milestone_description: "State: design approved",
          process_description: text,
        },
        { session_id: "sess_process_e2e" }
      );

      expect(result.success).toBe(true);

      // 回读：get/list 都要看得到 process_description
      const opId = result.metadata?.operation_id as number;
      const getTool = getOperationTool(taskComponent);
      const getResult = await getTool.execute({ operation_id: opId }, { session_id: "sess_x" });
      const op = JSON.parse(getResult.output as string);
      expect(op.processDescription).toBe(text);

      const listTool = listOperationsTool(taskComponent);
      const listResult = await listTool.execute({ task_id: taskId }, { session_id: "sess_x" });
      const data = JSON.parse(listResult.output as string);
      const found = data.operations.find((o: any) => o.id === opId);
      expect(found.processDescription).toBe(text);
    });

    it("backward compatible: no process_description still works", async () => {
      const tool = createOperationTool(taskComponent);
      const result = await tool.execute(
        {
          task_id: taskId,
          milestone_type: "progress",
          milestone_title: "No process desc",
        },
        { session_id: "sess_no_pd" }
      );

      expect(result.success).toBe(true);

      const opId = result.metadata?.operation_id as number;
      const getTool = getOperationTool(taskComponent);
      const getResult = await getTool.execute({ operation_id: opId }, { session_id: "sess_x" });
      const op = JSON.parse(getResult.output as string);
      // 缺省值必须为空字符串（与 action_description 风格一致）
      expect(op.processDescription).toBe("");
    });

    it("update tool can replace process_description", async () => {
      const createTool = createOperationTool(taskComponent);
      const createResult = await createTool.execute(
        {
          task_id: taskId,
          milestone_type: "progress",
          milestone_title: "Original",
          process_description: buildProcessDescription(110),
        },
        { session_id: "sess_update_pd" }
      );
      const opId = createResult.metadata?.operation_id as number;

      const newText = buildProcessDescription(140);
      const updateTool = updateOperationTool(taskComponent);
      const updateResult = await updateTool.execute(
        { operation_id: opId, process_description: newText },
        { session_id: "sess_update_pd" }
      );
      expect(updateResult.success).toBe(true);

      const getTool = getOperationTool(taskComponent);
      const getResult = await getTool.execute({ operation_id: opId }, { session_id: "sess_x" });
      const op = JSON.parse(getResult.output as string);
      expect(op.processDescription).toBe(newText);
    });

    it("tool-level guard: too short process_description is rejected (back-compat)", async () => {
      // schema 拒绝后，tool execute 走 parse 失败分支，返回 success=false
      const tool = createOperationTool(taskComponent);
      const result = await tool.execute(
        {
          task_id: taskId,
          milestone_type: "progress",
          milestone_title: "Too short",
          process_description: buildProcessDescription(99),
        },
        { session_id: "sess_too_short" }
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/process_description 太短/);
    });

    it("tool-level guard: too long process_description is rejected", async () => {
      const tool = createOperationTool(taskComponent);
      const result = await tool.execute(
        {
          task_id: taskId,
          milestone_type: "progress",
          milestone_title: "Too long",
          process_description: buildProcessDescription(PROCESS_DESCRIPTION_MAX_LENGTH + 1),
        },
        { session_id: "sess_too_long" }
      );

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/process_description 太长/);
    });
  });
});

// ==========================================================================
// action_* 兼容窗口期 alias 测试 (Task #2211 兼容性铁律) — 自包含测试
// ==========================================================================

describe("action_* deprecated alias compat (Task #2211)", () => {
  let taskComponent: TaskComponent;
  let taskId: number;

  beforeEach(async () => {
    const configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    await taskComponent.init({
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(tmpdir(), `alias-test-${Date.now()}-${Math.random()}.db`),
          },
        },
      },
    });

    const parentTask = await (taskComponent as any).store.createTask({
      title: "Parent Task",
      project_path: "unknown",
      context: "{}",
      sessionId: "sess_init",
    });

    const createTool = createTaskTool(taskComponent);
    const result = await createTool.execute(
      { title: "Alias Test Task", parent_task_id: parentTask.id, project_path: "unknown", context: "{}" },
      { session_id: "sess_alias" }
    );
    taskId = result.metadata?.task_id as number;
  });

  afterEach(async () => {
    await taskComponent.stop();
  });

  it("task_operation_create accepts action_* and emits deprecation warning", async () => {
    const createTool = createOperationTool(taskComponent);
    const result = await createTool.execute(
      {
        task_id: taskId,
        action_type: "decision",
        action_title: "Legacy decision title",
        action_description: "Legacy desc",
      },
      { session_id: "sess_legacy" }
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain("DEPRECATION NOTICE");
    expect(result.output).toContain("action_type");
    expect(result.output).toContain("action_title");
    expect(result.output).toContain("action_description");

    const meta = result.metadata as any;
    expect(meta.deprecated_fields_used).toContain("action_type");
    expect(meta.deprecated_fields_used).toContain("action_title");
    expect(meta.deprecated_fields_used).toContain("action_description");
  });

  it("task_operation_create maps action_* into milestone_* in storage", async () => {
    const createTool = createOperationTool(taskComponent);
    const createRes = await createTool.execute(
      { task_id: taskId, action_type: "problem", action_title: "Legacy problem", action_description: "d" },
      { session_id: "sess_legacy2" }
    );
    expect(createRes.success).toBe(true);
    const opId = createRes.metadata?.operation_id as number;

    const getTool = getOperationTool(taskComponent);
    const getRes = await getTool.execute({ operation_id: opId }, { session_id: "s" });
    expect(getRes.success).toBe(true);
    const op = JSON.parse(getRes.output as string);
    expect(op.milestoneType).toBe("problem");
    expect(op.milestoneTitle).toBe("Legacy problem");
    expect(op.milestoneDescription).toBe("d");
    expect(op.actionType).toBe("problem");
    expect(op.actionTitle).toBe("Legacy problem");
  });

  it("task_operation_update accepts action_title/description alias and warns", async () => {
    const createTool = createOperationTool(taskComponent);
    const createRes = await createTool.execute(
      { task_id: taskId, milestone_type: "progress", milestone_title: "Original" },
      { session_id: "s" }
    );
    const opId = createRes.metadata?.operation_id as number;

    const updateTool = updateOperationTool(taskComponent);
    const res = await updateTool.execute(
      { operation_id: opId, action_title: "Legacy updated title", action_description: "legacy desc" },
      { session_id: "s" }
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain("DEPRECATION NOTICE");
    expect((res.metadata as any).deprecated_fields_used).toContain("action_title");

    const getTool = getOperationTool(taskComponent);
    const getRes = await getTool.execute({ operation_id: opId }, { session_id: "s" });
    const op = JSON.parse(getRes.output as string);
    expect(op.milestoneTitle).toBe("Legacy updated title");
    expect(op.milestoneDescription).toBe("legacy desc");
  });

  it("task_operation_list accepts action_type alias and warns", async () => {
    const listTool = listOperationsTool(taskComponent);
    const res = await listTool.execute(
      { task_id: taskId, action_type: "progress" },
      { session_id: "s" }
    );
    expect(res.success).toBe(true);
    expect(res.output).toContain("DEPRECATION NOTICE");
    expect((res.metadata as any).deprecated_fields_used).toContain("action_type");
  });
});
