/**
 * @fileoverview End-to-end integration — verify delegate_task prompt includes
 *                 the reuse candidate section when recent tasks exist.
 *
 * Uses REAL TaskComponent + TaskCreationRegistry + delegate tool, with a
 * mocked handle_query to inspect the prompt that gets sent.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "../task-component";
import { ConfigComponent } from "../../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";
import {
  getOrCreateTaskReuseRegistry,
  disposeTaskReuseRegistry,
} from "../task-reuse-registry";

describe("delegate_task prompt injection — reuse candidate section", () => {
  let taskComponent: TaskComponent;
  let env: any;
  let handleQueryMock: any;
  let tool: any;

  beforeEach(async () => {
    taskComponent = new TaskComponent();
    const configComponent = new ConfigComponent();
    await taskComponent.init({
      name: "task",
      version: "1.0.0",
      enabled: true,
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(
              tmpdir(),
              `reuse-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
            ),
          },
        },
      },
    });

    handleQueryMock = {
      fn: async (..._args: unknown[]) => "Task completed",
      calls: [] as unknown[][],
      mockResolvedValue(value: string) {
        this.fn = async () => value;
      },
    };

    env = {
      getComponent: (name: string) => {
        if (name === "task") return taskComponent;
        if (name === "session") {
          return {
            get: async (id: string) => ({ id }),
            create: async (opts: any) => ({
              id: `sub-${Math.random().toString(36).slice(2)}`,
              info: { metadata: opts.metadata ?? {} },
            }),
          };
        }
        if (name === "agent") {
          return {
            getAgent: () => undefined,
            registerAgent: (_name: string, cfg: any) => ({ ...cfg }),
            getRegistry: () => ({
              getSystemPrompt: async () => undefined,
              list: () => [],
              get: () => undefined,
            }),
          };
        }
        return undefined;
      },
      handle_query: async (...args: unknown[]) => {
        handleQueryMock.calls.push(args);
        return await handleQueryMock.fn(...args);
      },
      currentSessionId: "test-session-A",
    };

    // Wire env onto taskComponent so handle_query is reachable.
    (taskComponent as any).env = env;

    // Install registry hook via singleton
    getOrCreateTaskReuseRegistry(env);

    // Build the delegate tool using the real factory.
    const module = await import("./delegate-tool");
    tool = module.createDelegateTool(taskComponent);
  });

  afterEach(async () => {
    disposeTaskReuseRegistry(env);
    await taskComponent.stop();
  });

  test("no prior tasks → no reuse candidate section in prompt", async () => {
    const ctx = { session_id: "test-session-A" };
    const result = await tool.execute(
      {
        description: "delegation",
        prompt: "do something",
        subagent_type: "roy",
        similar_task_ids: [],
      },
      ctx
    );
    expect(result.success).toBe(true);
    // Wait for background task to dispatch
    await new Promise((r) => setTimeout(r, 100));
    // The prompt sent to handle_query should NOT contain "Recent task context"
    const promptSent = handleQueryMock.calls[0]?.[0] as string | undefined;
    if (promptSent) {
      expect(promptSent).not.toContain("Recent task context");
    }
  });

  test("a-stock-screener fixture: 4 prior tasks → reuse section lists all 4", async () => {
    const titles = [
      "design a-stock-screener v0.7.0",
      "implement v0.7.0 fee/calendar/kline modules",
      "register a-stock-screener-v0.7.0",
      "run a-stock-screener v0.7.0 and analyze",
    ];
    for (const t of titles) {
      await taskComponent.createTask({
        title: t,
        sessionId: "test-session-A",
        project_path: "/test/proj",
        context: '{"type":"feature"}',
      });
    }
    // Sanity: registry should have 4 entries before delegation
    const r = getOrCreateTaskReuseRegistry(env);
    if (r.size() !== 4) {
      throw new Error(`expected 4 entries before delegation, got ${r.size()}`);
    }

    const ctx = { session_id: "test-session-A" };
    const result = await tool.execute(
      {
        description: "delegation v0.7.1 fix",
        prompt: "fix the kline DateLike bug",
        subagent_type: "roy",
        similar_task_ids: [], // user did NOT supply explicit similar IDs
      },
      ctx
    );
    expect(result.success).toBe(true);
    // Wait for background task to dispatch and call handle_query
    for (let i = 0; i < 50 && handleQueryMock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }

    const promptSent = handleQueryMock.calls[0]?.[0];
    if (!promptSent) throw new Error("expected handle_query to have been called with prompt");
    expect(promptSent).toContain("Recent task context");
    // Should mention all 4 prior tasks
    expect(promptSent).toContain("design a-stock-screener v0.7.0");
    expect(promptSent).toContain("implement v0.7.0");
    expect(promptSent).toContain("register a-stock-screener");
    expect(promptSent).toContain("run a-stock-screener");
    // Reuse instructions should be present
    expect(promptSent).toContain("task_get");
    expect(promptSent).toContain("task_update");
  });

  test("similar_task_ids deduplicates: explicit IDs are not duplicated in reuse section", async () => {
    await taskComponent.createTask({
      title: "design a",
      sessionId: "s1",
      project_path: "/p",
      context: "{}",
    });
    await taskComponent.createTask({
      title: "implement b",
      sessionId: "s1",
      project_path: "/p",
      context: "{}",
    });

    // Get the first task id
    const all = await taskComponent.listTasks({});
    const taskIdA = all.tasks[0].id;

    const ctx = { session_id: "test-session-A" };
    await tool.execute(
      {
        description: "d",
        prompt: "p",
        subagent_type: "roy",
        similar_task_ids: [taskIdA],
      },
      ctx
    );
    await new Promise((r) => setTimeout(r, 200));

    const promptSent = handleQueryMock.calls[0]?.[0];
    if (!promptSent) throw new Error("expected handle_query to have been called with prompt");
    // Similar Tasks Reference section should mention the explicit ID
    expect(promptSent).toContain("Similar Tasks Reference");
    // Reuse candidate section should also appear (because there are 2 candidates)
    expect(promptSent).toContain("Recent task context");
    // The explicit ID should NOT appear twice in the reuse candidate section
    // (it's deduplicated against similar_task_ids)
    const reuseSectionStart = promptSent.indexOf("Recent task context");
    const reuseSection = promptSent.slice(reuseSectionStart);
    const taskIdAOccurrences = (reuseSection.match(new RegExp(`#${taskIdA}:`, "g")) || []).length;
    expect(taskIdAOccurrences).toBe(0); // 0 = task A excluded from reuse section
  });
});