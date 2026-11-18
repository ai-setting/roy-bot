/**
 * @fileoverview delegate_task Tool Configuration Tests
 *
 * Tests for explore agent configuration, DEFAULT_TIMEOUT, and tool parameters.
 */

import { describe, test, expect } from "vitest";

describe("Explore agent configuration", () => {
  test("should have read_file in allowedTools", async () => {
    const { builtInSubAgents } = await import("./delegate-tool");
    const explore = builtInSubAgents.find((a: any) => a.id === "explore");
    expect(explore).toBeDefined();
    expect(explore.allowedTools).toContain("read_file");
    expect(explore.allowedTools).toContain("glob");
    expect(explore.allowedTools).toContain("grep");
    expect(explore.allowedTools).toContain("bash");
  });

  test("should have delegate_task and stop_task in deniedTools", async () => {
    const { builtInSubAgents } = await import("./delegate-tool");
    const explore = builtInSubAgents.find((a: any) => a.id === "explore");
    expect(explore).toBeDefined();
    expect(explore.deniedTools).toContain("delegate_task");
    expect(explore.deniedTools).toContain("stop_task");
  });
});

describe("DEFAULT_TIMEOUT", () => {
  test("should be 1800000 (30 minutes)", async () => {
    const mod = await import("./delegate-tool");
    expect(mod.DEFAULT_TIMEOUT).toBe(1800000);
  });
});

describe("DelegateTaskTool parameters", () => {
  test("should have timeout parameter", async () => {
    const { DelegateToolParameters } = await import("./delegate-tool");
    expect(DelegateToolParameters.shape.timeout).toBeDefined();
  });

  test("should NOT have task_id parameter (auto-created internally)", async () => {
    const { DelegateToolParameters } = await import("./delegate-tool");
    expect(DelegateToolParameters.shape.task_id).toBeUndefined();
  });

  test("should NOT have cleanup parameter (always keep sub-session)", async () => {
    const { DelegateToolParameters } = await import("./delegate-tool");
    expect(DelegateToolParameters.shape.cleanup).toBeUndefined();
  });

  test("should have description parameter", async () => {
    const { DelegateToolParameters } = await import("./delegate-tool");
    expect(DelegateToolParameters.shape.description).toBeDefined();
  });
});
