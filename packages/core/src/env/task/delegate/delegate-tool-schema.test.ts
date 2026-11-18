/**
 * @fileoverview DelegateToolParameters Schema Tests
 *
 * TDD: 测试 DelegateToolParameters 是否接受 sub_session_id 参数
 * 用途：让父 agent 在重试超时/失败的后台任务时传入已有的 sub session ID
 */

import { describe, test, expect } from "vitest";
import { DelegateToolParameters } from "./delegate-tool";

describe("DelegateToolParameters Schema - sub_session_id", () => {
  test("should accept sub_session_id as optional string", () => {
    const parsed = DelegateToolParameters.parse({
      description: "Resume task",
      prompt: "Continue working",
      subagent_type: "general",
      similar_task_ids: [],
      sub_session_id: "session_abc123",
    });
    expect(parsed.sub_session_id).toBe("session_abc123");
  });

  test("should accept when sub_session_id is omitted (backward compatible)", () => {
    const parsed = DelegateToolParameters.parse({
      description: "New task",
      prompt: "Do work",
      subagent_type: "general",
      similar_task_ids: [],
    });
    expect(parsed.sub_session_id).toBeUndefined();
  });

  test("should reject non-string sub_session_id", () => {
    expect(() => {
      DelegateToolParameters.parse({
        description: "Bad input",
        prompt: "Do work",
        subagent_type: "general",
        similar_task_ids: [],
        sub_session_id: 12345, // 数字不行
      });
    }).toThrow();
  });

  // ★ Task #5462：参数描述必须表达硬约束（同一任务链续跑必须传），
  // 而不是「Leave empty for a new session」的可选语气
  //（Task #5456 排查结论 RC-1 配套：LLM 把留空当默认动作）。
  describe("sub_session_id 参数描述为硬约束 (Task #5462)", () => {
    const description = DelegateToolParameters.shape.sub_session_id.description ?? "";

    test("描述含「必须」的硬约束措辞", () => {
      expect(description).toMatch(/必须/);
    });

    test("描述说明续跑时从哪里复制 sub_session_id", () => {
      expect(description).toMatch(/子 session|Sub-session/);
      expect(description).toMatch(/复制/);
    });

    test("描述写明留空的唯一合法场景（兜底）+ 丢弃上下文后果", () => {
      expect(description).toMatch(/兜底|仅当/);
      expect(description).toMatch(/丢弃|等于丢/);
    });

    test("描述不再含「Leave empty for a new session」的可选语气", () => {
      expect(description).not.toMatch(/Leave empty for a new session/);
    });
  });
});
