/**
 * @fileoverview compact_session TaskComponent 生命周期集成测试
 *
 * Task #4982 — 验证 TaskComponent.start() 用真实 deps 注册
 * compact_session 工具、stop() 注销为 no-deps 版本。
 *
 * 复用 query-background-process-tool-integration.test.ts 的
 * harness 模式（真实 TaskComponent + ToolComponent + temp dir）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import { ConfigComponent } from "../../../config/config-component";
import { BaseEnvironment } from "../../environment";
import { TaskComponent } from "../../task/task-component";
import { ToolComponent } from "../tool-component";
import { compactSessionTool } from "./compact-session-tool";

interface TestHarness {
  env: BaseEnvironment;
  task: TaskComponent;
  tool: ToolComponent;
  tempDir: string;
}

async function createTestHarness(): Promise<TestHarness> {
  const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "compact-session-tool-int-"));
  const env = new BaseEnvironment({ name: "compact-session-tool-test" });
  const config = new ConfigComponent();
  const tool = new ToolComponent();
  const task = new TaskComponent();

  config.setXdgDataHome(tempDir);
  env.registerComponent(config);
  env.registerComponent(tool);
  env.registerComponent(task);

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

describe("compact_session TaskComponent registration", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = await createTestHarness();
  });

  afterEach(async () => {
    try {
      await harness.env.stop();
    } catch {
      // best-effort cleanup
    }
  });

  test("TaskComponent.start() should register compact_session", async () => {
    await harness.task.start();
    expect(harness.tool.getTool("compact_session")).toBeDefined();
  });

  test("registered tool should be a DIFFERENT instance from the no-deps default", async () => {
    await harness.task.start();
    const registered = harness.tool.getTool("compact_session");
    expect(registered).toBeDefined();
    // start() must override the no-deps default with a deps-bound instance
    expect(registered).not.toBe(compactSessionTool);
  });

  test("no-deps default should refuse execution (not initialized)", async () => {
    const result = await compactSessionTool.execute(
      { session_id: "sub_1" },
      { session_id: "parent_1" } as any,
    );
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("not initialized");
  });

  test("TaskComponent.stop() should reset compact_session to no-deps version", async () => {
    await harness.task.start();
    expect(harness.tool.getTool("compact_session")).toBeDefined();

    await harness.task.stop();
    const registered = harness.tool.getTool("compact_session");
    expect(registered).toBeDefined();
    // After stop, the registered instance should be the no-deps default again
    expect(registered).toBe(compactSessionTool);

    // And it should refuse execution
    const result = await registered!.execute(
      { session_id: "sub_1" },
      { session_id: "parent_1" } as any,
    );
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("not initialized");
  });
});
