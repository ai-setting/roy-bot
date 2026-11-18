/**
 * @fileoverview handleBackgroundTask Resume Mode Tests
 *
 * TDD: 测试 handleBackgroundTask 接收并透传 existingSubSessionId 给 createTask
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { handleBackgroundTask } from "./delegate-tool";

describe("handleBackgroundTask - existingSubSessionId pass-through", () => {
  let mockBgMgr: any;

  beforeEach(() => {
    mockBgMgr = {
      resolveEntryAgent: vi.fn().mockReturnValue(undefined),
      createTask: vi.fn().mockResolvedValue({ taskId: "process_123", subSessionId: "sub-1" }),
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test("should pass existingSubSessionId through to createTask", async () => {
    const result = await (handleBackgroundTask as any)(
      mockBgMgr,
      "parent-1",
      "Resume work",
      "Continue from where left off",
      "general",
      1800000,
      undefined,
      "existing-sub-1"  // ★ existingSubSessionId 参数
    );

    expect(mockBgMgr.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        parentSessionId: "parent-1",
        existingSubSessionId: "existing-sub-1",
      })
    );
    expect(result.success).toBe(true);
    expect(result.metadata.sessionId).toBe("sub-1");
  });

  // ★ Task #5462：background 返回文案必须携带 subSessionId + 续跑提示，
  // 否则父 agent（LLM）看不到 sub session ID，无法在下一次 delegate 时复用
  //（Task #5456 排查结论 RC-2：delegate 返回不打印 subSessionId）。
  describe("output 文案携带 Sub-session 续跑提示 (Task #5462)", () => {
    test("output 含「🔗 Sub-session: <subSessionId>」行", async () => {
      const result = await (handleBackgroundTask as any)(
        mockBgMgr,
        "parent-1",
        "Resume work",
        "Continue from where left off",
        "general",
        1800000,
        undefined,
        "existing-sub-1"
      );
      expect(result.output).toContain("🔗 Sub-session: sub-1");
    });

    test("output 含续跑提示 delegate_task(sub_session_id=...)", async () => {
      const result = await (handleBackgroundTask as any)(
        mockBgMgr,
        "parent-1",
        "Resume work",
        "Continue from where left off",
        "general",
        1800000,
        undefined,
        undefined
      );
      expect(result.output).toMatch(/delegate_task\(sub_session_id="sub-1"/);
      expect(result.output).toContain("续跑");
    });
  });


  test("should not pass existingSubSessionId when omitted (backward compat)", async () => {
    const result = await (handleBackgroundTask as any)(
      mockBgMgr,
      "parent-1",
      "New task",
      "Start fresh",
      "general",
      undefined,
      undefined
      // ★ 没有第 8 个参数
    );

    const createCall = mockBgMgr.createTask.mock.calls[0][0];
    expect(createCall.existingSubSessionId).toBeUndefined();
    expect(result.success).toBe(true);
  });
});
