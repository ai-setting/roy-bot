/**
 * @fileoverview Task #3142（精简版）: Interactive.handleSubagentAskUserCascade test
 *
 * Task #3142 精简版后：
 * - REPL.handleSubagentAskUserCascade **不再调 BackgroundTaskManager.resumeFromAskUserAnswer()**
 * - REPL 只负责把子代理的 ask_user 问题显示给用户并收集答复
 * - 续传责任交还给主 agent：主 agent 走 delegate_task + subSessionId 自动续传
 *
 * 测试范围：
 *   1. event dispatch（handleEventMessageWithEnv 路由到 cascade handler）
 *   2. promptUser 调用 + 用户答复收集
 *   3. timeout sentinel → 不调 resume（即便现在根本没有 resume 调用，也保持幂等）
 *   4. 不依赖 BackgroundTaskManager（彻底移除 resume 相关依赖）
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { REPL } from "./run";

/**
 * Mock REPL — 用最少 stub 满足 handleSubagentAskUserCascade 的依赖：
 * - promptUser 返回指定字符串（模拟用户输入 / timeout sentinel）
 * - 不再 mock BackgroundTaskManager / resumeFromAskUserAnswer（已移除）
 */
function createMockRepl(env?: any): REPL {
  const repl = new REPL(
    {
      useInk: false,
      history: false,
    } as any,
    env ?? {
      getComponent: () => undefined,
    },
  );
  return repl;
}

describe("Task #3142 (精简版): REPL.handleSubagentAskUserCascade", () => {
  let consoleLogSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    vi.clearAllMocks();
  });

  // ========================================================================
  // 1. event dispatch (handleEventMessageWithEnv 路由)
  // ========================================================================

  describe("handleEventMessageWithEnv — task.background.ask_user dispatch", () => {
    test("routes task.background.ask_user to cascade handler (no resume call)", async () => {
      // Task #3142 精简版：不再 mock BackgroundTaskManager
      const env = {
        getComponent: () => undefined,
      };
      const repl = createMockRepl(env);
      // mock promptUser → 返回 user answer
      (repl as any).promptUser = vi.fn().mockResolvedValue("我的回答 A");

      const payload = {
        backgroundTaskId: "bg_1",
        subSessionId: "sub_1",
        parentSessionId: "parent_1",
        description: "test desc",
        subagentType: "general",
        query: "请选择 A 或 B",
        sessionId: "sess_1",
        nodeId: "n1",
        nodeType: "agent",
      };
      const formattedEvent = {
        message: "test message",
        envEvent: { type: "task.background.ask_user", payload },
        eventSessionId: "parent_1",
      };

      await repl.handleEventMessageWithEnv(formattedEvent);

      // 验证 promptUser 被调
      expect((repl as any).promptUser).toHaveBeenCalledTimes(1);

      // 验证答复被打印
      const allLogs = consoleLogSpy.mock.calls.flat().join("\n");
      expect(allLogs).toContain("我的回答 A");
      // 验证「续传交还给主 agent」的提示文案打印
      expect(allLogs).toContain("续传由主 agent 通过 delegate_task");
      expect(allLogs).toContain("subSessionId=sub_1");
    });

    test("non-ask_user events still go through normal event handling (regression)", async () => {
      const env = {
        getComponent: () => undefined,
      };
      const repl = createMockRepl(env);
      // mock executeInternal + ensureActiveSession
      (repl as any).executeInternal = vi.fn().mockResolvedValue(undefined);
      (repl as any).ensureActiveSession = vi.fn().mockResolvedValue(undefined);

      const formattedEvent = {
        message: "task completed",
        envEvent: {
          type: "task.background.completed",
          payload: { backgroundTaskId: "bg_x", description: "x" },
          metadata: {},
        },
        eventSessionId: "parent",
      };

      await repl.handleEventMessageWithEnv(formattedEvent);

      // 普通事件走 executeInternal
      expect((repl as any).executeInternal).toHaveBeenCalledTimes(1);
    });
  });

  // ========================================================================
  // 2. timeout sentinel → 不调 resume（保持幂等）
  // ========================================================================

  describe("timeout sentinel handling", () => {
    test("promptUser returns timeout sentinel → no resume, shows timeout hint", async () => {
      const env = {
        getComponent: () => undefined,
      };
      const repl = createMockRepl(env);
      (repl as any).promptUser = vi.fn().mockResolvedValue("__ASK_USER_TIMEOUT__:{}");

      const payload = {
        backgroundTaskId: "bg_to",
        subSessionId: "sub_to",
        parentSessionId: "p_to",
        description: "to desc",
        subagentType: "general",
        query: "q?",
        sessionId: "s",
        nodeId: "n",
        nodeType: "agent",
      };
      const envEvent = { type: "task.background.ask_user", payload };

      // 不应该 throw
      await expect(
        (repl as any).handleSubagentAskUserCascade(payload, envEvent),
      ).resolves.toBeUndefined();

      // 验证 timeout 提示文案打印
      const allLogs = consoleLogSpy.mock.calls.flat().join("\n");
      expect(allLogs).toContain("等待用户输入超时");
      // 不应该出现「续传由主 agent」提示（timeout 不走成功路径）
      expect(allLogs).not.toContain("续传由主 agent 通过 delegate_task");
    });
  });

  // ========================================================================
  // 3. 不依赖 BackgroundTaskManager
  // ========================================================================

  describe("BackgroundTaskManager not required (Task #3142 simplified)", () => {
    test("env.getComponent returns undefined → silently handled (no error)", async () => {
      // Task #3142 精简版后：BackgroundTaskManager 不再被需要 → getComponent 返回
      // undefined 也不报错（之前会报 'BackgroundTaskManager not found'）。
      const env = {
        getComponent: () => undefined, // 没有任何 component
      };
      const repl = createMockRepl(env);
      (repl as any).promptUser = vi.fn().mockResolvedValue("answer");

      const payload = {
        backgroundTaskId: "bg_no_mgr",
        subSessionId: "sub_no_mgr",
        parentSessionId: "p_no_mgr",
        description: "no mgr desc",
        subagentType: "general",
        query: "q?",
        sessionId: "s",
        nodeId: "n",
        nodeType: "agent",
      };
      const envEvent = { type: "task.background.ask_user", payload };

      // 不应该 throw
      await expect(
        (repl as any).handleSubagentAskUserCascade(payload, envEvent),
      ).resolves.toBeUndefined();

      // 关键：精简版后**不应该**出现「BackgroundTaskManager not found」错误
      const errorCalls = consoleErrorSpy.mock.calls.flat().join(" ");
      expect(errorCalls).not.toContain("BackgroundTaskManager not found");
    });
  });
});
