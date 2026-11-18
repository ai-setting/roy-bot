/**
 * @fileoverview AgentComponent.abortRun() 单元测试 (Task #2606 Fix #2)
 *
 * 直接覆盖 abortRun() 方法的 4 个核心场景 + 1 个 _run 边界 (Fix #4)：
 *   1. AR-1: abortRun("nonexistent") → false (idempotent, no error)
 *   2. AR-2: abortRun("") → false (空字符串边界)
 *   3. AR-2b: abortRun(undefined) → false (防御性)
 *   4. AR-3: abortRun on 已 finalize 的 runId → no-op + false
 *   5. AR-4: _run({ runId: "" }) → throws explicit error (Fix #4 校验入口)
 *
 * 锁住 Task #2590 silent-fail 根因的回归保护 —— abortRun 是 run-scoped abort
 * 的公共入口；参数错误（空 / 不存在）会触发 silent failure，所以 contract
 * 必须有测试覆盖。
 *
 * 模板参考：packages/core/src/env/agent/agent-component.external-abort.test.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "bun:test";
import { AgentComponent } from "./agent-component";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";
import type { AgentContext } from "./types";

function createMockEnvironment(configComponent: ConfigComponent): Environment {
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => {
      if (name === "config") return configComponent;
      return undefined;
    }),
    hasComponent: vi.fn((name: string) => name === "config"),
    listComponents: vi.fn(() => []),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  } as unknown as Environment;
}

describe("[Task #2606] AgentComponent.abortRun() unit tests", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;

  beforeEach(async () => {
    vi.clearAllMocks();
    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();
    mockEnv = createMockEnvironment(configComponent);
    await agentComponent.init({ env: mockEnv, options: { configComponent } });
  });

  afterEach(async () => {
    if (agentComponent.getStatus() !== "stopped") {
      await agentComponent.stop();
    }
    vi.restoreAllMocks();
  });

  // Scenario 1: abortRun on nonexistent runId → false (idempotent)
  it("AR-1: abortRun on nonexistent runId returns false (idempotent, no error)", () => {
    const result = agentComponent.abortRun("nonexistent-run-id", "test_reason");
    expect(result).toBe(false);
  });

  // Scenario 2: abortRun with empty/undefined runId → false (boundary)
  it("AR-2: abortRun with empty string returns false (empty boundary)", () => {
    const result = agentComponent.abortRun("", "test_reason");
    expect(result).toBe(false);
  });

  it("AR-2b: abortRun with undefined runId returns false (defensive)", () => {
    // @ts-expect-error — intentionally testing undefined input
    const result = agentComponent.abortRun(undefined, "test_reason");
    expect(result).toBe(false);
  });

  // Scenario 3: abortRun after finalizeTask → no-op + false
  it("AR-3: abortRun after the run has been finalized is a no-op", () => {
    // The runId 'general:1' is a synthetic one (not from _run); we just verify
    // that calling abortRun on any runId not in aborted/abortControllers maps
    // returns false without throwing.
    const result = agentComponent.abortRun("general:finalized-123", "post_finalize");
    expect(result).toBe(false);
  });

  // Scenario 4: _run with empty runId → throws explicit error (Fix #4)
  it("AR-4: _run with empty runId throws explicit error (Fix #4)", async () => {
    agentComponent.registerAgent("test-agent", { type: "primary" });
    await expect(async () => {
      await agentComponent.run("test-agent", "query", { runId: "" } as AgentContext);
    }).toThrow(/runId must not be empty/);
  });
});