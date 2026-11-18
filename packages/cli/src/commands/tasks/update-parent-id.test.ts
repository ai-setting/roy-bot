/**
 * Regression test for: tasks update --parent-id silently ignores the value.
 *
 * Bug: packages/cli/src/commands/tasks/update.ts builds UpdateTaskOptions without
 * including parent_task_id. So the CLI flag is read by yargs but never propagated
 * to the TaskComponent.updateTask() call.
 *
 * This test mocks taskComponent via mock.module() and asserts that parent_task_id
 * is forwarded when the user passes --parent-id. Pattern adapted from
 * packages/cli/src/commands/tasks/list.test.ts (dynamic import + mock.module).
 *
 * Why dynamic import: a static `import { UpdateCommand } from "./update"` evaluates
 * `./update` at parse time, BEFORE mock.module() registrations take effect. That
 * causes the handler's `import { EnvironmentService }` binding to resolve the real
 * service, which transitively pulls in core source and crashes the test runner
 * before any assertion runs. The dynamic `await import("./update")` runs AFTER
 * mock.module() has registered the replacements.
 */

import { describe, it, expect, mock, beforeEach } from "bun:test";

interface CapturedUpdate {
  taskId?: number;
  options?: any;
}

// === Module mocks (registered BEFORE dynamic import of "./update") ===
const captured: CapturedUpdate = {};

mock.module("../../services/environment.service", () => {
  return {
    EnvironmentService: class {
      async create(_opts: any) { /* no-op */ }
      getEnvironment() {
        return {
          getComponent(name: string) {
            if (name === "session") {
              return { getActiveSessionId: () => "test-session" };
            }
            if (name === "task") {
              return {
                updateTask: async (taskId: number, options: any) => {
                  captured.taskId = taskId;
                  captured.options = options;
                  return {
                    id: taskId,
                    title: options.title || "x",
                    description: options.description ?? "",
                    status: options.status ?? "todo",
                    priority: options.priority ?? "medium",
                    type: options.type ?? "normal",
                    progress: options.progress ?? 0,
                    current_status: options.current_status ?? "",
                    goals_and_expected_deliverables: "",
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    project_path: options.project_path ?? "/tmp",
                    context: options.context ?? "{}",
                  };
                },
                createOperation: async () => ({ id: 1 }),
              };
            }
            return null;
          },
          dispose: async () => {},
        };
      }
      async dispose() {}
    },
  };
});

mock.module("../../services/output.service", () => ({
  OutputService: class {
    log(_s: string) {}
    error(_s: string) {}
    info(_s: string) {}
    success(_s: string) {}
    json(_o: any) {}
  },
}));

// Dynamic import — must come AFTER mock.module() registrations.
const updateModule = await import("./update");
const { UpdateCommand } = updateModule as any;

async function invokeHandler(args: Record<string, unknown>): Promise<void> {
  await (UpdateCommand.handler as unknown as (a: Record<string, unknown>) => Promise<void>)(args);
}

beforeEach(() => {
  captured.taskId = undefined;
  captured.options = undefined;
});

describe("UpdateCommand --parent-id regression", () => {
  it("passes --parent-id through to taskComponent.updateTask as parent_task_id", async () => {
    // Simulate yargs producing { id: 7, "parent-id": 42 }
    await invokeHandler({ id: 7, "parent-id": 42 });
    expect(captured.taskId).toBe(7);
    expect(captured.options).toBeDefined();
    // The bug: parent_task_id is never set on the options object
    expect(captured.options.parent_task_id).toBe(42);
  });

  it("parent_task_id can be set to null to promote a task to root", async () => {
    await invokeHandler({ id: 7, "parent-id": null });
    expect(captured.options.parent_task_id).toBeNull();
  });

  it("parent_task_id is undefined when --parent-id is omitted (no accidental root promotion)", async () => {
    await invokeHandler({ id: 7, title: "untouched parent" });
    expect(captured.options.parent_task_id).toBeUndefined();
  });
});