/**
 * @fileoverview EventMessageFormatter subSessionId Output Tests
 *
 * TDD: 测试 EventMessageFormatter 在输出消息中展示 subSessionId
 * 用途：让 default agent 看到超时/失败通知时能直接拿到 subSessionId 用于复用重试
 */

import { describe, test, expect } from "vitest";
import { EventMessageFormatter } from "./event-message-formatter";
import type { EnvEvent } from "@ai-setting/roy-bot-core";

describe("EventMessageFormatter - subSessionId in output", () => {
  const formatter = new EventMessageFormatter();

  test("formatWithEvent should include subSessionId in formatted TIMEOUT message", () => {
    const event: EnvEvent = {
      id: "evt-1",
      timestamp: Date.now(),
      type: "task.background.timeout",
      payload: {
        backgroundTaskId: "process_1",
        subSessionId: "sub-session-xyz",
        parentSessionId: "parent-1",
        status: "timeout",
        description: "Long task",
        executionTimeMs: 1000,
      },
      metadata: {
        source: "task.background",
        trigger_session_id: "parent-1",
      },
    };

    const result = formatter.formatWithEvent(event);
    expect(result.message).toContain("subSessionId: sub-session-xyz");
    // ★ 同时验证 triggerSessionId 仍被提取
    expect(result.triggerSessionId).toBe("parent-1");
  });

  test("formatWithEvent should include subSessionId in formatted FAILED message", () => {
    const event: EnvEvent = {
      id: "evt-2",
      timestamp: Date.now(),
      type: "task.background.failed",
      payload: {
        backgroundTaskId: "process_2",
        subSessionId: "sub-session-abc",
        parentSessionId: "parent-2",
        status: "failed",
        description: "Failed task",
        error: "Something went wrong",
        executionTimeMs: 500,
      },
      metadata: {
        source: "task.background",
        trigger_session_id: "parent-2",
      },
    };

    const result = formatter.formatWithEvent(event);
    expect(result.message).toContain("subSessionId: sub-session-abc");
  });

  test("formatWithEvent should include subSessionId in formatted COMPLETED message", () => {
    const event: EnvEvent = {
      id: "evt-3",
      timestamp: Date.now(),
      type: "task.background.completed",
      payload: {
        backgroundTaskId: "process_3",
        subSessionId: "sub-session-done",
        parentSessionId: "parent-3",
        status: "completed",
        description: "Done task",
        executionTimeMs: 2000,
      },
      metadata: {
        source: "task.background",
        trigger_session_id: "parent-3",
      },
    };

    const result = formatter.formatWithEvent(event);
    expect(result.message).toContain("subSessionId: sub-session-done");
  });
});
