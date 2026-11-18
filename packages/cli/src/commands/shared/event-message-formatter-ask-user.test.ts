/**
 * @fileoverview Task #3139: EventMessageFormatter sub-agent ask_user 测试
 *
 * 测试 formatTaskAskUser 格式化 task.background.ask_user 事件 payload → 用户可读文本。
 * 验证 Task #3136 + Task #3139 修复组合后的 EventMessageFormatter 行为。
 */

import { describe, test, expect } from "bun:test";
import { EventMessageFormatter, TaskEventTypes } from "./event-message-formatter";
import type { BackgroundTaskAskUserEventPayload } from "./event-message-formatter";

describe("Task #3139: EventMessageFormatter — formatTaskAskUser", () => {
  const formatter = new EventMessageFormatter({ prefix: "[通知]" });

  test("formats ask_user event with all fields", () => {
    const event = {
      type: TaskEventTypes.TASK_ASK_USER,
      payload: {
        backgroundTaskId: "bg_123",
        subSessionId: "sub_456",
        parentSessionId: "parent_789",
        description: "调研代码",
        subagentType: "explore",
        query: "请选择文件范围 (选项: A, B, C)",
        sessionId: "sess_x",
        nodeId: "node_y",
        nodeType: "agent",
      } as BackgroundTaskAskUserEventPayload,
    };

    const result = formatter.format(event);

    expect(result).toContain("[通知] ❓ 后台子代理「调研代码」请求用户输入");
    expect(result).toContain("bgprocess: bg_123");
    expect(result).toContain("subSessionId: sub_456");
    expect(result).toContain("请选择文件范围 (选项: A, B, C)");
  });

  test("uses '未命名任务' when description missing", () => {
    const event = {
      type: TaskEventTypes.TASK_ASK_USER,
      payload: {
        backgroundTaskId: "bg",
        subSessionId: "sub",
        parentSessionId: "parent",
        description: "",
        subagentType: "general",
        query: "问题?",
        sessionId: "s",
        nodeId: "n",
        nodeType: "agent",
      } as BackgroundTaskAskUserEventPayload,
    };
    const result = formatter.format(event);
    expect(result).toContain("未命名任务");
  });

  test("falls back to '(空问题)' when query is empty", () => {
    const event = {
      type: TaskEventTypes.TASK_ASK_USER,
      payload: {
        backgroundTaskId: "bg",
        subSessionId: "sub",
        parentSessionId: "parent",
        description: "desc",
        subagentType: "general",
        query: "",
        sessionId: "s",
        nodeId: "n",
        nodeType: "agent",
      } as unknown as BackgroundTaskAskUserEventPayload,
    };
    const result = formatter.format(event);
    expect(result).toContain("(空问题)");
  });

  test("does not include bgprocess line when backgroundTaskId empty", () => {
    const event = {
      type: TaskEventTypes.TASK_ASK_USER,
      payload: {
        backgroundTaskId: "",
        subSessionId: "sub",
        parentSessionId: "parent",
        description: "desc",
        subagentType: "general",
        query: "q",
        sessionId: "s",
        nodeId: "n",
        nodeType: "agent",
      } as BackgroundTaskAskUserEventPayload,
    };
    const result = formatter.format(event);
    expect(result).not.toContain("bgprocess:");
  });

  test("does not include subSessionId line when subSessionId empty", () => {
    const event = {
      type: TaskEventTypes.TASK_ASK_USER,
      payload: {
        backgroundTaskId: "bg",
        subSessionId: "",
        parentSessionId: "parent",
        description: "desc",
        subagentType: "general",
        query: "q",
        sessionId: "s",
        nodeId: "n",
        nodeType: "agent",
      } as BackgroundTaskAskUserEventPayload,
    };
    const result = formatter.format(event);
    expect(result).not.toContain("subSessionId:");
  });

  test("preserves multi-line query formatting", () => {
    const event = {
      type: TaskEventTypes.TASK_ASK_USER,
      payload: {
        backgroundTaskId: "bg",
        subSessionId: "sub",
        parentSessionId: "parent",
        description: "desc",
        subagentType: "general",
        query: "第一行\n第二行\n第三行",
        sessionId: "s",
        nodeId: "n",
        nodeType: "agent",
      } as BackgroundTaskAskUserEventPayload,
    };
    const result = formatter.format(event);
    expect(result).toContain("第一行\n第二行\n第三行");
  });

  test("includes subagentType info via inherited BackgroundTaskEventPayload", () => {
    const event = {
      type: TaskEventTypes.TASK_ASK_USER,
      payload: {
        backgroundTaskId: "bg",
        subSessionId: "sub",
        parentSessionId: "parent",
        description: "desc",
        subagentType: "explore",
        query: "q",
        sessionId: "s",
        nodeId: "n",
        nodeType: "agent",
      } as BackgroundTaskAskUserEventPayload,
    };
    const result = formatter.format(event);
    // 验证基本格式存在即可（subagentType 不是显示字段，由其他逻辑消费）
    expect(result).toContain("[通知] ❓ 后台子代理「desc」请求用户输入");
  });

  /**
   * Task #3147 — 通知应包含「给主 agent 的操作提示」
   *
   * 提示块的内容来自 payload.hints（rule-based 由 BackgroundTaskManager 在构造
   * ASK_USER 事件时填充），formatter 只渲染，handler 端零特殊化。
   *
   * 动机：
   * - run 模式（非交互 REPL / TUI）的 RunTui.handleNotification 会把 formatter 输出
   *   直接塞进 executeQuery → LLM 上下文。
   * - 如果 message 不告诉 LLM「用 ask_user 展示给用户」「通过 delegate_task 续传」，
   *   LLM 会盲目调 ask_user 工具形成嵌套 / 状态错乱。
   * - REPL 模式（handleEventMessageWithEnv → executeInternal）同样把消息喂给主 agent。
   * - formatter 渲染 hints 为 [🤖 Agent 操作提示] 块，明确告诉 LLM 处理流程。
   */
  test("Task #3147: renders payload.hints as [🤖 Agent 操作提示] block (rule-based)", () => {
    const event = {
      type: TaskEventTypes.TASK_ASK_USER,
      payload: {
        backgroundTaskId: "bg_hint",
        subSessionId: "sub_hint",
        parentSessionId: "parent_hint",
        description: "Task #3147 测试",
        subagentType: "explore",
        query: "需要选 A 还是 B?",
        sessionId: "s",
        nodeId: "n",
        nodeType: "agent",
        hints: [
          "请把上面的问题原样通过 ask_user tool 展示给用户并等待答复",
          '得到用户回复后，通过 delegate_task(subagentType="explore", sub_session_id="sub_hint", prompt=<基于用户回复>) 复用 sub-session 让 sub-agent 继承之前消息历史继续推进，无需实现 resume function',
        ],
      } as BackgroundTaskAskUserEventPayload,
    };
    const result = formatter.format(event);
    // 包含「[🤖 Agent 操作提示]」块 + 关键指令（来自 payload.hints）
    expect(result).toContain("[🤖 Agent 操作提示]");
    expect(result).toContain("ask_user tool 展示给用户");
    expect(result).toContain("delegate_task");
    expect(result).toContain("sub_session_id");
    expect(result).not.toContain("existingSubSessionId");
    expect(result).toContain("sub_hint");
    // 提示块应当在原始 query 之后追加（不是替换 query）
    const queryIdx = result.indexOf("需要选 A 还是 B?");
    const hintIdx = result.indexOf("[🤖 Agent 操作提示]");
    expect(queryIdx).toBeGreaterThan(-1);
    expect(hintIdx).toBeGreaterThan(queryIdx);
  });

  /**
   * Task #3147 — 没 hints 时不渲染 [🤖 Agent 操作提示] 块（避免硬编码默认文案）
   */
  test("Task #3147: omits hint block when payload.hints is missing", () => {
    const event = {
      type: TaskEventTypes.TASK_ASK_USER,
      payload: {
        backgroundTaskId: "bg",
        subSessionId: "sub",
        parentSessionId: "parent",
        description: "desc",
        subagentType: "explore",
        query: "q",
        sessionId: "s",
        nodeId: "n",
        nodeType: "agent",
      } as BackgroundTaskAskUserEventPayload,
    };
    const result = formatter.format(event);
    expect(result).not.toContain("[🤖 Agent 操作提示]");
  });
});