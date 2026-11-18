/**
 * @fileoverview Real TaskComponent lifecycle integration tests for
 * query_background_process manager wiring.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigComponent } from "../../../config/config-component";
import { BaseEnvironment } from "../../environment";
import {
  BackgroundTaskManager,
  type BackgroundTask,
} from "../../task/delegate/delegate-tool";
import { TaskComponent } from "../../task/task-component";
import { ToolComponent } from "../tool-component";

interface TestHarness {
  env: BaseEnvironment;
  task: TaskComponent;
  tool: ToolComponent;
  tempDir: string;
}

async function createTestHarness(): Promise<TestHarness> {
  const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "task-tool-int-"));
  const env = new BaseEnvironment({ name: "query-bg-process-test" });
  const config = new ConfigComponent();
  const tool = new ToolComponent();
  const task = new TaskComponent();

  config.setXdgDataHome(tempDir);
  env.registerComponent(config);
  env.registerComponent(tool);
  env.registerComponent(task);

  // Components are initialized explicitly so TaskComponent receives its real
  // ConfigComponent dependency. The BaseEnvironment remains the real registry
  // used by TaskComponent.start() to discover ToolComponent.
  await config.init({
    name: "config",
    version: "1.0.0",
    enabled: true,
    env,
  });
  await tool.init({
    name: "tool",
    version: "1.0.0",
    enabled: true,
    env,
    options: { configComponent: config },
  });
  await task.init({
    name: "task",
    version: "1.0.0",
    enabled: true,
    env,
    options: {
      configComponent: config,
      config: {
        storage: {
          type: "sqlite",
          dbPath: path.join(tempDir, "tasks.db"),
        },
      },
    },
  });
  await env.init();

  return { env, task, tool, tempDir };
}

function seedRealManagerTask(
  harness: TestHarness,
  overrides: Partial<BackgroundTask> = {},
): { manager: BackgroundTaskManager; task: BackgroundTask } {
  const manager = (harness.task as any)
    .backgroundTaskManager as BackgroundTaskManager | undefined;
  if (!manager) {
    throw new Error("TaskComponent.start() must be called before seeding a task");
  }

  const now = Date.now();
  const task: BackgroundTask = {
    id: "process_owned_by_session_a",
    subSessionId: "sub-session-a",
    parentSessionId: "session-a",
    description: "session A private result",
    subagentType: "roy",
    status: "running",
    createdAt: now - 2_000,
    startedAt: now - 1_000,
    lastUpdatedAt: now - 1_000,
    result: "sensitive result",
    error: "sensitive error",
    abortController: new AbortController(),
    ...overrides,
  };

  // Seed the actual manager created and registered by TaskComponent.start().
  // This avoids replacing the lifecycle path with a handcrafted manager.
  (manager as any).tasks.set(task.id, task);
  return { manager, task };
}

describe("TaskComponent × query_background_process real lifecycle", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    if (harness.task.getStatus() !== "stopped") {
      await harness.task.stop();
    }
    fsSync.rmSync(harness.tempDir, { recursive: true, force: true });
  });

  test("TaskComponent.start() replaces the default tool with a manager-bound instance", async () => {
    const defaultTool = harness.tool.getTool("query_background_process");
    expect(defaultTool).toBeDefined();

    const beforeStart = await defaultTool!.execute(
      { bgProcessId: "process_missing" },
      { session_id: "session-a" },
    );
    expect(beforeStart.success).toBe(false);

    await harness.task.start();

    const managerBoundTool = harness.tool.getTool("query_background_process");
    expect(managerBoundTool).toBeDefined();
    expect(managerBoundTool).not.toBe(defaultTool);

    const afterStart = await managerBoundTool!.execute(
      { bgProcessId: "process_missing" },
      { session_id: "session-a" },
    );
    expect(afterStart.success).toBe(true);
    expect(JSON.parse(afterStart.output as string)).toMatchObject({
      alive: false,
      status: "not_found",
    });
  });

  test("TaskComponent.stop() removes the manager-bound tool and disposes its manager", async () => {
    await harness.task.start();
    const managerBoundTool = harness.tool.getTool("query_background_process");
    expect(managerBoundTool).toBeDefined();

    await harness.task.stop();

    expect((harness.task as any).backgroundTaskManager).toBeUndefined();
    const stoppedTool = harness.tool.getTool("query_background_process");
    expect(stoppedTool).toBeDefined();
    expect(stoppedTool).not.toBe(managerBoundTool);

    const result = await stoppedTool!.execute(
      { bgProcessId: "process_missing" },
      { session_id: "session-a" },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("not initialized");
  });

  test("matching session_id can query a task from the real manager", async () => {
    await harness.task.start();
    const { task } = seedRealManagerTask(harness, {
      result: undefined,
      error: undefined,
    });
    const queryTool = harness.tool.getTool("query_background_process")!;

    const result = await queryTool.execute(
      { bgProcessId: task.id },
      { session_id: task.parentSessionId },
    );

    expect(result.success).toBe(true);
    expect(JSON.parse(result.output as string)).toMatchObject({
      alive: true,
      status: "running",
      description: "session A private result",
    });
  });

  test("wrong session_id returns not_found without leaking result or error", async () => {
    await harness.task.start();
    const { task } = seedRealManagerTask(harness);
    const queryTool = harness.tool.getTool("query_background_process")!;

    const result = await queryTool.execute(
      { bgProcessId: task.id },
      { session_id: "session-b" },
    );

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output as string);
    expect(output.status).toBe("not_found");
    expect(output.alive).toBe(false);
    expect(output.result).toBeUndefined();
    expect(output.error).toBeUndefined();
  });

  test("missing session_id fails safe as not_found without leaking result or error", async () => {
    await harness.task.start();
    const { task } = seedRealManagerTask(harness);
    const queryTool = harness.tool.getTool("query_background_process")!;

    const result = await queryTool.execute({ bgProcessId: task.id }, {});

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output as string);
    expect(output.status).toBe("not_found");
    expect(output.alive).toBe(false);
    expect(output.result).toBeUndefined();
    expect(output.error).toBeUndefined();
  });

  test("stopped task remains not_found when queried from another session", async () => {
    await harness.task.start();
    const { manager, task } = seedRealManagerTask(harness);
    const stopped = await manager.stopTask(task.id);
    expect(stopped.success).toBe(true);
    expect(manager.getTask(task.id)?.status).toBe("stopped");

    const queryTool = harness.tool.getTool("query_background_process")!;
    const result = await queryTool.execute(
      { bgProcessId: task.id },
      { session_id: "forged-session-id" },
    );

    expect(result.success).toBe(true);
    const output = JSON.parse(result.output as string);
    expect(output.status).toBe("not_found");
    expect(output.alive).toBe(false);
    expect(output.result).toBeUndefined();
    expect(output.error).toBeUndefined();
  });
});

describe("TaskComponent × query_background_process multi-environment isolation", () => {
  let harnessA: TestHarness;
  let harnessB: TestHarness;

  beforeEach(async () => {
    [harnessA, harnessB] = await Promise.all([
      createTestHarness(),
      createTestHarness(),
    ]);
  });

  afterEach(async () => {
    await Promise.all(
      [harnessA, harnessB].map(async (currentHarness) => {
        if (currentHarness.task.getStatus() !== "stopped") {
          await currentHarness.task.stop();
        }
        fsSync.rmSync(currentHarness.tempDir, { recursive: true, force: true });
      }),
    );
  });

  test("keeps independent managers and lifecycle across two environments", async () => {
    await Promise.all([harnessA.task.start(), harnessB.task.start()]);

    const taskA = seedRealManagerTask(harnessA, {
      id: "process_environment_a",
      parentSessionId: "environment-session-a",
      description: "environment A task",
      result: "environment A result",
      error: undefined,
    }).task;
    const taskB = seedRealManagerTask(harnessB, {
      id: "process_environment_b",
      parentSessionId: "environment-session-b",
      description: "environment B task",
      result: "environment B result",
      error: undefined,
    }).task;
    const queryToolA = harnessA.tool.getTool("query_background_process")!;
    const queryToolB = harnessB.tool.getTool("query_background_process")!;

    expect(queryToolA).not.toBe(queryToolB);

    const ownA = await queryToolA.execute(
      { bgProcessId: taskA.id },
      { session_id: taskA.parentSessionId },
    );
    expect(ownA.success).toBe(true);
    expect(JSON.parse(ownA.output as string)).toMatchObject({
      status: "running",
      description: "environment A task",
      result: "environment A result",
    });

    const crossEnvironmentA = await queryToolB.execute(
      { bgProcessId: taskA.id },
      { session_id: taskA.parentSessionId },
    );
    expect(crossEnvironmentA.success).toBe(true);
    expect(JSON.parse(crossEnvironmentA.output as string)).toMatchObject({
      alive: false,
      status: "not_found",
    });
    expect(JSON.parse(crossEnvironmentA.output as string).result).toBeUndefined();

    await harnessA.task.stop();

    expect((harnessA.task as any).backgroundTaskManager).toBeUndefined();
    const ownB = await queryToolB.execute(
      { bgProcessId: taskB.id },
      { session_id: taskB.parentSessionId },
    );
    expect(ownB.success).toBe(true);
    expect(JSON.parse(ownB.output as string)).toMatchObject({
      alive: true,
      status: "running",
      description: "environment B task",
      result: "environment B result",
    });

    const crossEnvironmentAfterStop = await queryToolB.execute(
      { bgProcessId: taskA.id },
      { session_id: taskA.parentSessionId },
    );
    expect(crossEnvironmentAfterStop.success).toBe(true);
    expect(JSON.parse(crossEnvironmentAfterStop.output as string)).toMatchObject({
      alive: false,
      status: "not_found",
    });
  });
});
