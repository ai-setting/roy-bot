/**
 * @fileoverview Task #5420 返工（2026-11-13 08:21 用户澄清）：
 * 「💬 会话查看」面板展示**最近 5 条工具调用**（工具名 + reason），
 * 不是消息内容摘要。
 *
 * ## 用户原话
 * 「不符合预期，我要展示工具名称和 reason」
 *
 * ## 真实结构（生产 sessions.db 勘察）
 * assistant 消息 parts 含 ToolCallPart：
 * `{type:'tool-call', toolName, arguments:{...含 reason}, toolCallId, state}`
 * reason 是 #5422 注入的必填参数（arguments.reason）。
 *
 * ## 旧实现的问题
 * - toActivityMessage 只读 msg.content；新格式消息 content=""
 *   正文在 parts ⇒ 全部「（无文本内容）」
 * - 面板 title「💬 最近消息」+ formatRecentMessageLines 首行
 *   「💬 最近消息（最新 N 条）：」标题双写
 *
 * ## 锁定的行为
 * 1. extractToolCallsFromMessages：从消息 parts 提取工具调用
 *    （toolName + arguments.reason），按消息时间序
 * 2. formatRecentToolCallLines：渲染「🔧 最近工具调用」行
 *    （标题只出现一次；无 reason → 「—」；空 → 「暂无工具调用」）
 * 3. 降级：非工具消息混合时只取 tool-call part
 */
import { describe, test, expect } from "bun:test";
import {
  extractToolCallsFromMessages,
  formatRecentToolCallLines,
} from "./sub-session-activity";
import type { SessionMessage } from "../../session/types";

function assistantMsg(parts: unknown[], timestamp = Date.now()): SessionMessage {
  return {
    id: "m1",
    sessionID: "s1",
    role: "assistant",
    content: "",
    timestamp,
    parts,
  } as unknown as SessionMessage;
}

function toolCallPart(toolName: string, args: Record<string, unknown>) {
  return {
    type: "tool-call",
    toolCallId: `call_${toolName}`,
    toolName,
    arguments: args,
    state: "pending",
  };
}

describe("extractToolCallsFromMessages（Task #5420 返工）", () => {
  test("T1. 从 parts 提取 toolName + arguments.reason", () => {
    const calls = extractToolCallsFromMessages([
      assistantMsg([
        { type: "text", content: "我来查一下" },
        toolCallPart("bash", { command: "ls", reason: "查看目录结构" }),
      ]),
    ]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.toolName).toBe("bash");
    expect(calls[0]!.reason).toBe("查看目录结构");
  });

  test("T2. 多条消息多个 tool-call 按序提取", () => {
    const calls = extractToolCallsFromMessages([
      assistantMsg([toolCallPart("bash", { reason: "r1" })], 1000),
      assistantMsg([toolCallPart("read_file", { reason: "r2" })], 2000),
      assistantMsg([toolCallPart("grep", { reason: "r3" })], 3000),
    ]);
    expect(calls.length).toBe(3);
    expect(calls.map((c) => c.toolName)).toEqual(["bash", "read_file", "grep"]);
  });

  test("T2b. ★ CV MAJOR-1 守门：ASC 窗口取尾部（slice(-n)）才是最近调用", () => {
    // 生产装配：getMessages ASC（旧→新）→ 提取 → 必须取尾部 n 条。
    // 模拟 8 条调用窗口、取最近 5 条：slice(-5) 丢掉最早 3 条。
    const window = [
      assistantMsg([toolCallPart("t1", { reason: "最早1" })], 1000),
      assistantMsg([toolCallPart("t2", { reason: "最早2" })], 2000),
      assistantMsg([toolCallPart("t3", { reason: "最早3" })], 3000),
      assistantMsg([toolCallPart("t4", { reason: "近1" })], 4000),
      assistantMsg([toolCallPart("t5", { reason: "近2" })], 5000),
      assistantMsg([toolCallPart("t6", { reason: "近3" })], 6000),
      assistantMsg([toolCallPart("t7", { reason: "近4" })], 7000),
      assistantMsg([toolCallPart("t8", { reason: "近5" })], 8000),
    ];
    const calls = extractToolCallsFromMessages(window);
    const recent5 = calls.slice(-5);
    expect(recent5.map((c) => c.toolName)).toEqual([
      "t4",
      "t5",
      "t6",
      "t7",
      "t8",
    ]);
    // 反例守门：slice(0,5)（旧 bug）取到的是最早 3 条 + 近 2 条
    const buggy = calls.slice(0, 5);
    expect(buggy[0]!.toolName).toBe("t1");
  });

  test("T3. arguments 是 JSON 字符串时也能解析 reason", () => {
    const calls = extractToolCallsFromMessages([
      assistantMsg([
        toolCallPart("bash", JSON.stringify({ reason: "字符串参数" })),
      ]),
    ]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.reason).toBe("字符串参数");
  });

  test("T4. 无 reason 的旧调用 → reason 为 undefined（降级由渲染层处理）", () => {
    const calls = extractToolCallsFromMessages([
      assistantMsg([toolCallPart("bash", { command: "ls" })]),
    ]);
    expect(calls.length).toBe(1);
    expect(calls[0]!.reason).toBeUndefined();
  });

  test("T5. 非工具消息（text/user）被跳过", () => {
    const calls = extractToolCallsFromMessages([
      assistantMsg([{ type: "text", content: "纯文本" }]),
      {
        id: "m2",
        sessionID: "s1",
        role: "user",
        content: "用户消息",
        timestamp: 1,
      } as unknown as SessionMessage,
    ]);
    expect(calls.length).toBe(0);
  });

  test("T6. tool-result part 不算工具调用（只取 tool-call）", () => {
    const calls = extractToolCallsFromMessages([
      assistantMsg([
        {
          type: "tool-result",
          toolCallId: "call_x",
          toolName: "bash",
          output: "out",
          state: "completed",
        },
      ]),
    ]);
    expect(calls.length).toBe(0);
  });
});

describe("formatRecentToolCallLines（Task #5420 返工）", () => {
  test("T7. 渲染工具名 + reason，标题只出现一次", () => {
    const lines = formatRecentToolCallLines([
      { toolName: "bash", reason: "查看目录结构" },
      { toolName: "read_file", reason: "读源码" },
    ]);
    const joined = lines.join("\n");
    // ★ 返工终版：标题去重后正文不含「最近工具调用」（标题只在面板 title）
    expect(joined).not.toContain("最近工具调用");
    expect(joined).toContain("bash");
    expect(joined).toContain("查看目录结构");
  });

  test("T8. 无 reason → 显示「—」", () => {
    const lines = formatRecentToolCallLines([
      { toolName: "bash", reason: undefined },
    ]);
    expect(lines.join("\n")).toContain("—");
  });

  test("T9. 空列表 → 「暂无工具调用」单行（无标题双写）", () => {
    const lines = formatRecentToolCallLines([]);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("暂无工具调用");
  });

  test("T10. undefined → 同空列表", () => {
    const lines = formatRecentToolCallLines(undefined);
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("暂无工具调用");
  });

  test("T11. 超长 reason 截断到 100 字", () => {
    const long = "r".repeat(300);
    const lines = formatRecentToolCallLines([
      { toolName: "bash", reason: long },
    ]);
    const joined = lines.join("\n");
    expect(joined).toContain("…");
    // reason 行总长不超过合理范围（工具名 + 100 字 + 装饰）
    expect(joined.length).toBeLessThan(160);
  });
});
