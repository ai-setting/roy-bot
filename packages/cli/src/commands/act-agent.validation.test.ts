/**
 * @fileoverview act --agent 参数校验测试
 */

import { describe, expect, test } from "vitest";
import {
  buildActAgentContext,
  isWorkflowPausedActResult,
  validateActAgent,
} from "./act-agent-validation";

describe("validateActAgent", () => {
  test("should pass when agent is not specified", () => {
    expect(validateActAgent(undefined, undefined)).toEqual({ valid: true });
  });

  test("should pass when agent is default", () => {
    expect(validateActAgent(undefined, "default")).toEqual({ valid: true });
  });

  test("should pass when agent exists", () => {
    const lookup = {
      getAgent: (name: string) => (name === "explore" ? { name: "explore" } : undefined),
    };
    expect(validateActAgent(lookup, "explore")).toEqual({ valid: true });
  });

  test("should fail when agent does not exist", () => {
    const lookup = { getAgent: () => undefined };
    const result = validateActAgent(lookup, "unknown-agent");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.message).toContain("unknown-agent");
    }
  });

  test("should fail when agent component is unavailable", () => {
    const result = validateActAgent(undefined, "explore");
    expect(result.valid).toBe(false);
  });
});

describe("buildActAgentContext", () => {
  test("should return undefined when agent is not specified", () => {
    expect(buildActAgentContext(undefined)).toBeUndefined();
  });

  test("should return undefined when agent is default", () => {
    expect(buildActAgentContext("default")).toBeUndefined();
  });

  test("should return agentType for handle_query routing", () => {
    expect(buildActAgentContext("explore")).toEqual({ agentType: "explore" });
  });

  test("should not use agent key (handle_query reads agentType only)", () => {
    const ctx = buildActAgentContext("explore");
    expect(ctx).toBeDefined();
    expect(ctx).not.toHaveProperty("agent");
    expect(ctx?.agentType).toBe("explore");
  });
});

describe("isWorkflowPausedActResult", () => {
  test("should return true for paused workflow JSON result", () => {
    const result = JSON.stringify({
      status: "paused",
      sessionId: "workflow_run-1",
      hint: "Resume with: roy-bot workflow run -s workflow_run-1",
    });
    expect(isWorkflowPausedActResult(result)).toBe(true);
  });

  test("should return false for plain text or completed output", () => {
    expect(isWorkflowPausedActResult("执行完成")).toBe(false);
    expect(isWorkflowPausedActResult(JSON.stringify({ status: "completed" }))).toBe(false);
    expect(isWorkflowPausedActResult("not json")).toBe(false);
  });
});
