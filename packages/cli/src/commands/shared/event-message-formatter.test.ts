/**
 * @fileoverview EventMessageFormatter Tests
 * 
 * TDD: 测试所有后台任务通知格式统一包含 bgprocess: 和 Task # 信息
 */

import { describe, test, expect } from "bun:test";
import { EventMessageFormatter } from "./event-message-formatter";

describe("EventMessageFormatter - Background Task Notifications", () => {
  const formatter = new EventMessageFormatter({ prefix: "[通知]" });

  describe("formatTaskCompleted (reference format)", () => {
    test("should include bgprocess: and Task # when available", () => {
      const event = {
        type: "task.background.completed",
        payload: {
          backgroundTaskId: "task_123",
          description: "Some task",
          status: "completed",
          result: "Done",
          executionTimeMs: 1000,
          associatedTaskId: 42,
        },
      };

      const result = formatter.format(event);

      expect(result).toContain("bgprocess:");
      expect(result).toContain("task_123");
      expect(result).toContain("Task #42");
    });
  });

  /**
   * Bug: formatTaskCompleted 中阈值 10000 但截断到 100 字符（typo / 复制粘贴错误）
   * 用户要求：后台进程任务的通知不允许截断 → 完整保留 result
   *
   * 4 个场景：
   * - 150 字符（超过 100 但小于 10000，触发了 typo bug）
   * - 50000 字符（用户原始场景，远超 10000）
   * - 50 字符（短 result，原有逻辑已经能正确处理）
   * - undefined（边界，保留 if 守卫）
   */
  describe("formatTaskCompleted - 不截断 result (Bug fix)", () => {
    test("RED: 150 字符 result 不应被截断到 100 字符（核心 bug 修复）", () => {
      const longResult = "A".repeat(150);
      const event = {
        type: "task.background.completed",
        payload: {
          backgroundTaskId: "task_bug_1",
          description: "150-char result task",
          status: "completed",
          result: longResult,
          executionTimeMs: 2000,
          associatedTaskId: 1,
        },
      };

      const result = formatter.format(event);

      // ★ 核心断言：150 字符 result 必须完整保留
      expect(result).toContain(longResult);
      // ★ 不应有任何截断标记
      expect(result).not.toContain("[TRUNCATED]");
      expect(result).not.toContain("...");
    });

    test("RED: 50000 字符 result 应完整保留（用户原始场景）", () => {
      const hugeResult = "X".repeat(50000);
      const event = {
        type: "task.background.completed",
        payload: {
          backgroundTaskId: "task_bug_2",
          description: "50000-char result task",
          status: "completed",
          result: hugeResult,
          executionTimeMs: 3000,
          associatedTaskId: 2,
        },
      };

      const result = formatter.format(event);

      // ★ 用户原始场景：result 必须完整（不能只给 100 字符）
      expect(result).toContain(hugeResult);
      // ★ 不应有 [TRUNCATED] 标记
      expect(result).not.toContain("[TRUNCATED]");
    });

    test("RED: 50 字符短 result 完整保留（边界 - 短 result）", () => {
      const shortResult = "B".repeat(50);
      const event = {
        type: "task.background.completed",
        payload: {
          backgroundTaskId: "task_bug_3",
          description: "50-char result task",
          status: "completed",
          result: shortResult,
          executionTimeMs: 1000,
          associatedTaskId: 3,
        },
      };

      const result = formatter.format(event);

      // ★ 短 result 必须完整保留
      expect(result).toContain(shortResult);
      // ★ 不应有 [TRUNCATED] 标记
      expect(result).not.toContain("[TRUNCATED]");
    });

    test("RED: undefined result 不应输出 结果: 行，且不崩溃", () => {
      const event = {
        type: "task.background.completed",
        payload: {
          backgroundTaskId: "task_bug_4",
          description: "No result task",
          status: "completed",
          result: undefined,
          executionTimeMs: 1000,
          associatedTaskId: 4,
        },
      };

      const result = formatter.format(event);

      // ★ undefined result 不应输出 结果: 行（保留 if 守卫）
      expect(result).not.toContain("结果:");
      // ★ 不应崩溃（这里只是断言 result 是字符串）
      expect(typeof result).toBe("string");
      expect(result).toContain("bgprocess: task_bug_4");
    });
  });

  describe("formatTaskTimeout", () => {
    test("RED: should include bgprocess: line like completed notification", () => {
      const timeoutEvent = {
        type: "task.background.timeout",
        payload: {
          backgroundTaskId: "task_123_timeout",
          description: "Test timeout task",
          status: "timeout",
          executionTimeMs: 5000,
          associatedTaskId: 999,
        },
      };

      const result = formatter.format(timeoutEvent);

      // Should have bgprocess: line like completed
      expect(result).toContain("bgprocess:");
      expect(result).toContain("task_123_timeout");
      expect(result).toContain("Task #999");
    });

    test("RED: should show bgprocess: even when Task # is unavailable", () => {
      const timeoutEvent = {
        type: "task.background.timeout",
        payload: {
          backgroundTaskId: "task_456_timeout",
          description: "Fast timeout no task",
          status: "timeout",
          executionTimeMs: 3000,
        },
      };

      const result = formatter.format(timeoutEvent);

      // bgprocess: should always be shown for any notification
      expect(result).toContain("bgprocess:");
      expect(result).toContain("task_456_timeout");
      expect(result).toContain("超时");
      expect(result).not.toContain("Task #");
    });
  });

  describe("formatTaskFailed", () => {
    test("RED: should include bgprocess: and Task # when available", () => {
      const failedEvent = {
        type: "task.background.failed",
        payload: {
          backgroundTaskId: "task_111_failed",
          description: "Failing task",
          status: "failed",
          error: "Something went wrong",
          executionTimeMs: 2000,
          associatedTaskId: 555,
        },
      };

      const result = formatter.format(failedEvent);

      expect(result).toContain("bgprocess:");
      expect(result).toContain("task_111_failed");
      expect(result).toContain("Task #555");
    });

    test("RED: should show bgprocess: even without Task #", () => {
      const failedEvent = {
        type: "task.background.failed",
        payload: {
          backgroundTaskId: "task_222_failed",
          description: "Failing task no ID",
          status: "failed",
          error: "Error occurred",
          executionTimeMs: 3000,
        },
      };

      const result = formatter.format(failedEvent);

      expect(result).toContain("bgprocess:");
      expect(result).toContain("task_222_failed");
      expect(result).not.toContain("Task #");
    });
  });

  describe("formatTaskProgress", () => {
    test("RED: should include [Task #N] when associatedTaskId is available", () => {
      const progressEvent = {
        type: "task.background.progress",
        payload: {
          backgroundTaskId: "task_123_progress",
          description: "Progress task",
          status: "running",
          progress: 50,
          associatedTaskId: 42,
        },
      };

      const result = formatter.format(progressEvent);

      expect(result).toContain("🔄");
      // 后台任务的进度通知不再渲染虚假百分比，改用"还在进行中"文案
      // 真实进度由子代理通过 task_get / task_list 等工具主动查询
      expect(result).toContain("还在进行中");
      expect(result).toContain("请耐心等待");
      expect(result).toContain("task_get");
      expect(result).toContain("task_operation_list");
      expect(result).not.toContain("进度更新");
      expect(result).not.toContain("50%");
      expect(result).toContain("[Task #42]");
    });

    test("RED: should not include [Task #N] when associatedTaskId is not available", () => {
      const progressEvent = {
        type: "task.background.progress",
        payload: {
          backgroundTaskId: "task_456_progress",
          description: "Progress task no ID",
          status: "running",
          progress: 75,
        },
      };

      const result = formatter.format(progressEvent);

      expect(result).toContain("🔄");
      expect(result).toContain("还在进行中");
      expect(result).toContain("请耐心等待");
      expect(result).toContain("task_get");
      expect(result).toContain("task_operation_list");
      expect(result).not.toContain("进度更新");
      expect(result).not.toContain("75%");
      expect(result).not.toContain("Task #");
    });

    test("RED: should include progressMessage when available", () => {
      const progressEvent = {
        type: "task.background.progress",
        payload: {
          backgroundTaskId: "task_789_progress",
          description: "Progress with message",
          status: "running",
          progress: 30,
          progressMessage: "Processing step 2 of 5",
          associatedTaskId: 100,
        },
      };

      const result = formatter.format(progressEvent);

      expect(result).toContain("[Task #100]");
      expect(result).toContain("还在进行中");
      expect(result).toContain("请耐心等待");
      expect(result).toContain("task_get");
      expect(result).toContain("task_operation_list");
      expect(result).not.toContain("30%");
      // progressMessage 在消息段中显示，验证文案结构
      expect(result).toContain("- Processing step 2 of 5");
      expect(result).toContain("Processing step 2 of 5");
    });
  });

  describe("formatTaskStopped", () => {
    test("RED: should include bgprocess: and Task # when available", () => {
      const stoppedEvent = {
        type: "task.background.stopped",
        payload: {
          backgroundTaskId: "task_333_stopped",
          description: "Stopped task",
          status: "stopped",
          error: "Task stopped by user",
          executionTimeMs: 4000,
          associatedTaskId: 777,
        },
      };

      const result = formatter.format(stoppedEvent);

      expect(result).toContain("bgprocess:");
      expect(result).toContain("task_333_stopped");
      expect(result).toContain("Task #777");
    });

    test("RED: should show bgprocess: even without Task #", () => {
      const stoppedEvent = {
        type: "task.background.stopped",
        payload: {
          backgroundTaskId: "task_444_stopped",
          description: "Stopped task no ID",
          status: "stopped",
          error: "Task stopped by user",
          executionTimeMs: 5000,
        },
      };

      const result = formatter.format(stoppedEvent);

      expect(result).toContain("bgprocess:");
      expect(result).toContain("task_444_stopped");
      expect(result).not.toContain("Task #");
    });
  });

  /**
   * Task #3136 + #3146 + #3147 — sub-agent ask_user cascade（标准 notify event）
   *
   * formatTaskAskUser 应输出 ❓ 后台子代理 + query + bgprocess + subSessionId
   * + [🤖 Agent 操作提示] 块（**内容来自 payload.hints**，rule-based 由
   * BackgroundTaskManager 在构造 ASK_USER 事件时填充，formatter 只渲染）。
   */
  describe("formatTaskAskUser", () => {
    test("should include description, bgprocess, subSessionId, query and Agent 操作提示块 (hints from payload)", () => {
      const askUserEvent = {
        type: "task.background.ask_user",
        payload: {
          backgroundTaskId: "task_555_askuser",
          subSessionId: "sub-session-555",
          parentSessionId: "session-parent",
          subagentType: "general",
          description: "Deploy task",
          query: "Should I deploy to production?",
          sessionId: "sub-session-555",
          nodeId: "agent-1",
          nodeType: "agent",
          error: "__ASK_USER_ERROR__:...",
          executionTimeMs: 1500,
          // Task #3147 — hints 是 rule-based 提示数组，事件自带。
          // formatter 只渲染，handler 端零特殊化。
          hints: [
            "请把上面的问题原样通过 ask_user tool 展示给用户并等待答复",
            '得到用户回复后，通过 delegate_task(subagentType="general", sub_session_id="sub-session-555", prompt=<基于用户回复>) 复用 sub-session 让 sub-agent 继承之前消息历史继续推进，无需实现 resume function',
          ],
        },
      };

      const result = formatter.format(askUserEvent as any);

      expect(result).toContain("Deploy task");
      expect(result).toContain("task_555_askuser");
      expect(result).toContain("sub-session-555");
      expect(result).toContain("Should I deploy to production?");
      // Task #3147: [🤖 Agent 操作提示] 块来自 payload.hints
      expect(result).toContain("[🤖 Agent 操作提示]");
      expect(result).toContain("delegate_task");
      expect(result).toContain("sub_session_id");
      expect(result).not.toContain("existingSubSessionId");
      expect(result).toContain("sub-session-555");
    });

    test("should use fallback '(空问题)' when query is empty", () => {
      const askUserEvent = {
        type: "task.background.ask_user",
        payload: {
          backgroundTaskId: "task_666_askuser",
          subSessionId: "sub-session-666",
          description: "Empty query task",
          query: "",
          sessionId: "sub-session-666",
          nodeId: "agent-2",
          nodeType: "agent",
          error: "",
          executionTimeMs: 0,
          hints: [
            "请把上面的问题原样通过 ask_user tool 展示给用户并等待答复",
          ],
        },
      };

      const result = formatter.format(askUserEvent as any);

      expect(result).toContain("Empty query task");
      expect(result).toContain("(空问题)");
      // Task #3147: 即使 query 为空也应有 Agent 操作提示块（来自 payload.hints）
      expect(result).toContain("[🤖 Agent 操作提示]");
    });
  });
});
