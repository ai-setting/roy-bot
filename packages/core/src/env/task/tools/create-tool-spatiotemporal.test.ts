/**
 * @fileoverview Spatio-temporal context tests for task_create (Task #2325)
 *
 * Verifies the new spatio-temporal context behavior:
 * 1. task_create tool description explicitly mentions space (project_path +
 *    worktree_path) and time (context.created_at) dimensions.
 * 2. createTask auto-detects worktree via `git rev-parse --show-toplevel` and
 *    injects worktree_path into context when missing.
 * 3. createTask auto-injects created_at (ISO 8601 timestamp) into context when
 *    missing.
 * 4. Explicit values in context take precedence over auto-detection
 *    (manual override still works).
 *
 * TDD: this file documents the expected contract. The implementation lives
 * in create-tool.ts. Description checks make sure the LLM prompt carries the
 * spatio-temporal vocabulary so downstream sub-agents understand the fields.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";
import { createTaskTool, getTaskTool } from "./index";
import type { TaskComponent as TaskComponentType } from "../task-component";
import { createTaskTool as createTaskToolDirect } from "./create-tool";

describe("task_create spatio-temporal context (Task #2325)", () => {
  let taskComponent: TaskComponentType;

  beforeEach(async () => {
    const configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    await taskComponent.init({
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(tmpdir(), `task-spatiotemporal-${Date.now()}-${Math.random()}.db`),
          },
        },
      },
    });
  });

  afterEach(async () => {
    await taskComponent.stop();
  });

  // ------------------------------------------------------------------------
  // Description hygiene: must advertise spatio-temporal vocabulary
  // ------------------------------------------------------------------------

  describe("description vocabulary", () => {
    // Mock minimal TaskComponent for type compat
    const mockTaskComponent = {
      createTask: async () => ({
        id: 1,
        title: "mock",
        description: "",
        status: "active" as const,
        priority: "medium" as const,
        type: "normal" as const,
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        progress: 0,
      }),
    } as unknown as TaskComponentType;

    it("should mention Space / project_path / worktree_path in description", () => {
      const tool = createTaskToolDirect(mockTaskComponent);
      expect(tool.description).toBeDefined();
      // LLM 应当从描述里知道 worktree_path 是空间维度的一部分
      expect(tool.description).toMatch(/worktree_path/);
      expect(tool.description).toMatch(/project_path/);
    });

    it("should mention Time / created_at / context time dimensions", () => {
      const tool = createTaskToolDirect(mockTaskComponent);
      expect(tool.description).toBeDefined();
      expect(tool.description).toMatch(/created_at/);
      // 明确时间维度的存在（防止 LLM 误以为 context 只是 worktree metadata）
      expect(tool.description).toMatch(/time/i);
    });

    it("should advertise auto-detection for worktree_path", () => {
      const tool = createTaskToolDirect(mockTaskComponent);
      expect(tool.description).toBeDefined();
      // LLM 应当知道 worktree_path 可以自动检测（无需手动填）
      // 使用宽松匹配：auto / detect / 自动 / detect
      expect(
        tool.description!.match(/auto|detect|自动/i)
      ).not.toBeNull();
    });

    it("should not break existing description hygiene invariants", () => {
      // Regression: 强化时空描述不应破坏 Task #2075 的树形决策指引
      const tool = createTaskToolDirect(mockTaskComponent);
      expect(tool.description).toMatch(/task_tree/);
      expect(tool.description).toMatch(/depth\s*[:=]\s*1/);
      expect(tool.description).toMatch(/Path A/);
      expect(tool.description).toMatch(/Path B/);
      expect(tool.description).toMatch(/Path C/);
      expect(tool.description).toMatch(/≤\s*10/);
      expect(tool.description).toMatch(/≤\s*5/);
      // Hygiene: 仍然不硬编码具体 ID 或绝对路径
      expect(tool.description).not.toMatch(/parent_task_id\s*=\s*619\b/);
      expect(tool.description).not.toMatch(/roy_world/);
    });
  });

  // ------------------------------------------------------------------------
  // Auto-injected worktree_path + created_at
  // ------------------------------------------------------------------------

  describe("auto-detection (worktree_path + created_at)", () => {
    it("should auto-inject created_at into context JSON when missing", async () => {
      const tool = createTaskTool(taskComponent);
      const result = await tool.execute(
        {
          title: "Test task 1",
          project_path: "/tmp/proj",
          context: '{"type": "general"}',
        },
        { session_id: "sess_st_001" }
      );
      expect(result.success).toBe(true);
      const taskId = result.metadata?.task_id as number;
      const getTool = getTaskTool(taskComponent);
      const got = await getTool.execute(
        { task_id: taskId },
        { session_id: "sess_st_001" }
      );
      const task = JSON.parse(got.output as string);
      const ctx = JSON.parse(task.context);
      expect(ctx.created_at).toBeDefined();
      // ISO 8601 format check: YYYY-MM-DDTHH:MM:SS.sssZ
      expect(ctx.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    it("should preserve explicitly provided created_at (manual override)", async () => {
      const tool = createTaskTool(taskComponent);
      const explicitTs = "2026-01-01T00:00:00.000Z";
      const result = await tool.execute(
        {
          title: "Test task 2",
          project_path: "/tmp/proj",
          context: JSON.stringify({ type: "feature", created_at: explicitTs }),
        },
        { session_id: "sess_st_002" }
      );
      expect(result.success).toBe(true);
      const taskId = result.metadata?.task_id as number;
      const got = await getTaskTool(taskComponent).execute(
        { task_id: taskId },
        { session_id: "sess_st_002" }
      );
      const ctx = JSON.parse(JSON.parse(got.output as string).context);
      expect(ctx.created_at).toBe(explicitTs);
    });

    it("should auto-inject worktree_path when cwd is in a worktree", async () => {
      // We are running inside a worktree (the test infrastructure), so this
      // is the realistic case.
      const tool = createTaskTool(taskComponent);
      const result = await tool.execute(
        {
          title: "Test task 3",
          project_path: "/tmp/proj",
          context: '{"type": "feature"}',
        },
        { session_id: "sess_st_003" }
      );
      expect(result.success).toBe(true);
      const taskId = result.metadata?.task_id as number;
      const got = await getTaskTool(taskComponent).execute(
        { task_id: taskId },
        { session_id: "sess_st_003" }
      );
      const ctx = JSON.parse(JSON.parse(got.output as string).context);
      // bun test 在主 repo 里跑，worktree 应该在子目录里
      const cwd = process.cwd();
      if (cwd.includes(".worktrees/") || cwd.includes(".worktree/")) {
        expect(ctx.worktree_path).toBeDefined();
        expect(ctx.worktree_path).toBe(cwd);
      } else {
        // 即使不在 worktree，也应保留 context 不崩；worktree_path 可为 undefined
        expect(ctx.worktree_path === undefined || ctx.worktree_path === cwd).toBe(true);
      }
    });

    it("should preserve explicitly provided worktree_path (manual override)", async () => {
      const tool = createTaskTool(taskComponent);
      const result = await tool.execute(
        {
          title: "Test task 4",
          project_path: "/tmp/proj",
          context: JSON.stringify({
            type: "feature",
            worktree_path: "/my/explicit/worktree",
          }),
        },
        { session_id: "sess_st_004" }
      );
      expect(result.success).toBe(true);
      const taskId = result.metadata?.task_id as number;
      const got = await getTaskTool(taskComponent).execute(
        { task_id: taskId },
        { session_id: "sess_st_004" }
      );
      const ctx = JSON.parse(JSON.parse(got.output as string).context);
      expect(ctx.worktree_path).toBe("/my/explicit/worktree");
    });

    it("should still inject created_at when context is empty {}", async () => {
      const tool = createTaskTool(taskComponent);
      const result = await tool.execute(
        {
          title: "Test task 5",
          project_path: "/tmp/proj",
          context: "{}",
        },
        { session_id: "sess_st_005" }
      );
      expect(result.success).toBe(true);
      const taskId = result.metadata?.task_id as number;
      const got = await getTaskTool(taskComponent).execute(
        { task_id: taskId },
        { session_id: "sess_st_005" }
      );
      const ctx = JSON.parse(JSON.parse(got.output as string).context);
      expect(ctx.created_at).toBeDefined();
    });

    it("should not throw on malformed context JSON (graceful degradation)", async () => {
      const tool = createTaskTool(taskComponent);
      const result = await tool.execute(
        {
          title: "Test task 6",
          project_path: "/tmp/proj",
          context: "not-json",
        },
        { session_id: "sess_st_006" }
      );
      // 不能因为 context 不是 JSON 而崩；要么成功，要么明确报错
      // 选择保持向后兼容：解析失败时回退到原字符串，不注入 created_at/worktree_path
      if (result.success) {
        const taskId = result.metadata?.task_id as number;
        const got = await getTaskTool(taskComponent).execute(
          { task_id: taskId },
          { session_id: "sess_st_006" }
        );
        const task = JSON.parse(got.output as string);
        // context 应当保留原样或被规整化
        expect(task.context).toBeDefined();
      } else {
        expect(result.error).toBeDefined();
      }
    });
  });
});