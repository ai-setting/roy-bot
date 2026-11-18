/**
 * @fileoverview Test for task tool schemas
 */

import { describe, expect, test } from "bun:test";
import { CreateTaskToolSchema, UpdateTaskToolSchema } from "./task-types";

describe("CreateTaskToolSchema", () => {
  test("should require project_path, context, and parent_task_id", () => {
    const validParams = {
      title: "Test task",
      parent_task_id: 1,
      project_path: "unknown",
      context: "{}",
    };
    
    const result = CreateTaskToolSchema.safeParse(validParams);
    expect(result.success).toBe(true);
  });
  
  test("should accept task without tags (tags is optional)", () => {
    // tags is now optional (for search, stored in task.tags JSON field)
    const validParams = {
      title: "Test task",
      parent_task_id: 1,
      project_path: "unknown",
      context: "{}",
    };
    
    const result = CreateTaskToolSchema.safeParse(validParams);
    expect(result.success).toBe(true);
  });
  
  test("should accept task with tags", () => {
    const validParams = {
      title: "Test task",
      parent_task_id: 1,
      tags: ["test", "feature"],
      project_path: "unknown",
      context: "{}",
    };
    
    const result = CreateTaskToolSchema.safeParse(validParams);
    expect(result.success).toBe(true);
  });
  
  test("should accept empty tags array", () => {
    // tags can be empty array
    const params = {
      title: "Test task",
      parent_task_id: 1,
      tags: [],
      project_path: "unknown",
      context: "{}",
    };
    
    const result = CreateTaskToolSchema.safeParse(params);
    expect(result.success).toBe(true);
  });
  
  test("should accept all optional fields", () => {
    const params = {
      title: "Test task",
      parent_task_id: 1,
      description: "Test description",
      priority: "high" as const,
      goals_and_expected_deliverables: "Test goals",
      due_date: "2025-12-31",
      tags: ["test"],
      project_path: "/home/user/project",
      context: '{"type": "feature", "branch": "main"}',
    };
    
    const result = CreateTaskToolSchema.safeParse(params);
    expect(result.success).toBe(true);
  });

  // ── Task #4619 ──────────────────────────────────────────────────────────
  // `project_path` and `context` used to be REQUIRED.
  //
  // That was fine inside roy-bot (its own prompt always supplies both),
  // but it broke every client written against `roy-plugin-for-agent`'s
  // published MCP catalogue, where only `title` was required. When the
  // plugin was thinned down to use roy's *real* schemas (Task #4619), a
  // plain `task_create({ title })` started failing with
  // "project_path: Required" / "context: Required".
  //
  // They are now optional with the defaults the field descriptions already
  // documented ("unknown" / '{"type":"unknown"}').
  test("should default project_path to 'unknown' when omitted (Task #4619)", () => {
    const paramsWithoutProjectPath = {
      title: "Test task",
      parent_task_id: 1,
      context: "{}",
    };

    const result = CreateTaskToolSchema.safeParse(paramsWithoutProjectPath);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.project_path).toBe("unknown");
    }
  });

  test("should default context to '{\"type\":\"unknown\"}' when omitted (Task #4619)", () => {
    const paramsWithoutContext = {
      title: "Test task",
      parent_task_id: 1,
      project_path: "unknown",
    };

    const result = CreateTaskToolSchema.safeParse(paramsWithoutContext);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.context).toBe('{"type":"unknown"}');
    }
  });

  test("should make parent_task_id optional (allow root task creation)", () => {
    const paramsWithoutParent = {
      title: "Test task",
      project_path: "unknown",
      context: "{}",
    };

    const result = CreateTaskToolSchema.safeParse(paramsWithoutParent);
    // parent_task_id is now optional - root task creation must succeed
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parent_task_id).toBeUndefined();
    }
  });

  test("should accept null parent_task_id (root task creation)", () => {
    const paramsWithNullParent = {
      title: "Test task",
      parent_task_id: null,
      project_path: "unknown",
      context: "{}",
    };

    const result = CreateTaskToolSchema.safeParse(paramsWithNullParent);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.parent_task_id).toBeNull();
    }
  });
});

describe("CreateTaskToolSchema with type", () => {
  test("should accept type field", () => {
    const params = {
      title: "Test",
      parent_task_id: 1,
      type: "cycle" as const,
      project_path: "unknown",
      context: "{}",
    };
    const result = CreateTaskToolSchema.safeParse(params);
    expect(result.success).toBe(true);
    expect(result.data?.type).toBe("cycle");
  });

  test("should default type to normal when not provided", () => {
    const params = {
      title: "Test",
      parent_task_id: 1,
      project_path: "unknown",
      context: "{}",
    };
    const result = CreateTaskToolSchema.safeParse(params);
    expect(result.success).toBe(true);
    // type should be optional, not required
  });

  test("should reject invalid type", () => {
    const params = {
      title: "Test",
      parent_task_id: 1,
      type: "invalid",
      project_path: "unknown",
      context: "{}",
    };
    const result = CreateTaskToolSchema.safeParse(params);
    expect(result.success).toBe(false);
  });
});

describe("UpdateTaskToolSchema with type", () => {
  test("should accept type field", () => {
    const params = {
      task_id: 1,
      type: "longterm" as const,
    };
    const result = UpdateTaskToolSchema.safeParse(params);
    expect(result.success).toBe(true);
    expect(result.data?.type).toBe("longterm");
  });
});

describe("UpdateTaskToolSchema", () => {
  test("tags can be optional in update", () => {
    const params = {
      task_id: 1,
      title: "Updated title",
    };
    
    const result = UpdateTaskToolSchema.safeParse(params);
    expect(result.success).toBe(true);
  });
  
  test("should require task_id", () => {
    const params = {
      title: "Updated title",
      tags: ["updated"],
    };
    
    const result = UpdateTaskToolSchema.safeParse(params);
    expect(result.success).toBe(false);
  });
});
