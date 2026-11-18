/**
 * Task #4622 — RED test: `getTaskWithOperations` must stay **backward
 * compatible** with the already-published CLI 1.7.59.
 *
 * ## Why this test exists (a release blocker found while shipping 1.7.61)
 *
 * The published `@ai-setting/roy-bot-cli@1.7.59` declares:
 *
 *     "dependencies": { "@ai-setting/roy-bot-core": "^1.5.83" }
 *
 * `^1.5.83` accepts `1.7.61`, so installing the new core **silently
 * upgrades** the CLI's core. The published CLI's `tasks get` command reads:
 *
 *     const result = await taskComponent.getTaskWithOperations(args.id);
 *     output.log(`Task #${result.task.id}: ${result.task.title}`);
 *
 * i.e. it expects the **nested** shape `{ task, operations }`. Core 1.7.61
 * (Task #4619, commit 777813f7) flattens it to `{ ...task, operations }`
 * so the plugin's MCP contract stays flat.
 *
 * Measured consequence (npm pack of the real published tarball):
 *
 *     OLD CLI on NEW core (flat)   → TypeError: Cannot read properties of
 *                                    undefined (reading 'id')
 *     OLD CLI on OLD core (nested) → 42
 *
 * So publishing core 1.7.61 **alone** breaks `roy-bot tasks get` for
 * every user on CLI 1.7.59 — a released, already-shipped package.
 *
 * ## The fix
 *
 * Keep the flat shape (the plugin contract — `task.title`,
 * `task.operations` — must not regress), but ALSO carry a `task` alias
 * pointing at the same task object so the nested access keeps working.
 *
 * Both access styles then work:
 *
 *     result.id          → flat access (new clients)
 *     result.task.id     → nested access (published CLI 1.7.59)
 *
 * The alias is a **reference to the same object**, not a copy, so it can
 * never drift.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { TaskComponent } from "./task-component";
import { ConfigComponent } from "../../config/config-component";
import { tmpdir } from "os";
import { join } from "path";

describe("Task #4622: getTaskWithOperations keeps BOTH access shapes", () => {
  let taskComponent: TaskComponent;
  let configComponent: ConfigComponent;

  beforeEach(async () => {
    configComponent = new ConfigComponent();
    taskComponent = new TaskComponent();
    await taskComponent.init({
      options: {
        configComponent,
        config: {
          storage: {
            type: "sqlite",
            dbPath: join(tmpdir(), `task-shape-compat-${Date.now()}-${Math.random()}.db`),
          },
        },
      },
    });
  });

  afterEach(async () => {
    await taskComponent.dispose?.();
  });

  it("exposes the task fields at the top level (the flat shape the plugin contract needs)", async () => {
    const task = await taskComponent.createTask({
      title: "Flat Shape",
      sessionId: "sess_1",
      project_path: "unknown",
      context: "{}",
    });

    const result = await taskComponent.getTaskWithOperations(task.id);

    // Flat access — what the plugin's MCP `task_get` publishes.
    expect(result?.id).toBe(task.id);
    expect(result?.title).toBe("Flat Shape");
    expect(Array.isArray(result?.operations)).toBe(true);
  });

  it("ALSO exposes a nested `task` alias so published CLI 1.7.59 keeps working", async () => {
    const task = await taskComponent.createTask({
      title: "Nested Alias",
      sessionId: "sess_1",
      project_path: "unknown",
      context: "{}",
    });

    const result = await taskComponent.getTaskWithOperations(task.id);

    // ⚠️ This is the exact access the published CLI 1.7.59 performs:
    //    `output.log(`Task #${result.task.id}: ${result.task.title}`)`
    // Without the alias this throws
    // "TypeError: Cannot read properties of undefined (reading 'id')".
    expect(result?.task).toBeDefined();
    expect(result?.task?.id).toBe(task.id);
    expect(result?.task?.title).toBe("Nested Alias");
  });

  it("the nested alias mirrors the flat fields (it can never drift)", async () => {
    const task = await taskComponent.createTask({
      title: "Same Object",
      sessionId: "sess_1",
      project_path: "unknown",
      context: "{}",
    });

    const result = await taskComponent.getTaskWithOperations(task.id);

    // The alias carries the same values as the flat fields.
    expect(result?.task?.id).toBe(result?.id);
    expect(result?.task?.title).toBe(result?.title);
    expect(result?.task?.status).toBe(result?.status);
  });

  it("the result is JSON-serialisable (the MCP wire depends on it)", async () => {
    const task = await taskComponent.createTask({
      title: "Serialisable",
      sessionId: "sess_1",
      project_path: "unknown",
      context: "{}",
    });

    const result = await taskComponent.getTaskWithOperations(task.id);

    // ⚠️ A self-referential alias (`result.task === result`) would make
    //    `JSON.stringify` throw "Converting circular structure to JSON" —
    //    and this exact object is what `task_get` puts on the MCP wire.
    expect(() => JSON.stringify(result)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(result));
    expect(parsed.id).toBe(task.id);
    expect(parsed.task.id).toBe(task.id);
    expect(Array.isArray(parsed.operations)).toBe(true);
  });

  it("returns undefined for a missing task (unchanged)", async () => {
    const result = await taskComponent.getTaskWithOperations(999_999);
    expect(result).toBeUndefined();
  });
});
