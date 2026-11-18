/**
 * @fileoverview Task #5420 返工 — 「💬 会话查看」面板修复（r2 测试）
 *
 * 用户实测（2026-11-13 08:21 截图）：
 * 1. 5 条消息全部「（无文本内容）」—— 根因：新格式消息 content=""，
 *    正文在 parts（TextPart.content / ToolCallPart.toolName+arguments /
 *    ToolResultPart.output），toActivityMessage 只读 msg.content。
 * 2. 标题重复两次 —— 面板 title「💬 最近消息」+ 列表首行
 *    「💬 最近消息（最新 N 条）：」双写。
 * 3. 用户澄清（2026-11-13 08:21）：面板应展示**工具名称 + reason**
 *    （tool-call part 的 toolName + arguments.reason）。
 *    该方案由并行 agent 落地为 extractToolCallsFromMessages +
 *    formatRecentToolCallLines（见 lark-session-view-toolcalls-5420.test.ts）；
 *    本文件补 toActivityMessage 的 **parts 提取**与标题去重回归。
 */

import { describe, test, expect } from "bun:test";
import {
  toActivityMessage,
  formatRecentMessageLines,
  extractToolCallsFromMessages,
  formatRecentToolCallLines,
  type SessionMessageLite,
} from "./sub-session-activity";

// ============================================================================
// A. toActivityMessage — parts 结构提取（返工核心：内容不再空）
// ============================================================================

describe("toActivityMessage — parts 结构提取（返工）", () => {
  test("★ content 空但有 TextPart → 提取 part 正文（不再「无文本内容」）", () => {
    const m: SessionMessageLite = {
      role: "assistant",
      content: "",
      parts: [
        { type: "text", content: "已定位到 lark-card-action-handler.ts:71" },
      ] as Array<Record<string, unknown>>,
    };
    const r = toActivityMessage(m, 100);
    expect(r).toBeDefined();
    expect(r!.content).toContain("已定位到");
  });

  test("★ content 有值（旧格式）→ 原样提取", () => {
    const r = toActivityMessage({ role: "user", content: "旧格式正文" }, 100);
    expect(r!.content).toBe("旧格式正文");
  });

  test("★ content 与 parts 都空 → 占位「（无文本内容）」（显式 max 场景）", () => {
    const r = toActivityMessage({ role: "assistant", content: "" }, 100);
    expect(r).toBeDefined();
    expect(r!.content).toBe("（无文本内容）");
  });

  test("★ 多个 TextPart → 拼接", () => {
    const m: SessionMessageLite = {
      role: "assistant",
      content: "",
      parts: [
        { type: "text", content: "第一段" },
        { type: "text", content: "第二段" },
      ] as Array<Record<string, unknown>>,
    };
    const r = toActivityMessage(m, 100)!;
    expect(r.content).toContain("第一段");
    expect(r.content).toContain("第二段");
  });

  test("★ tool 角色带 ToolResultPart → 提取 output 摘要", () => {
    const m: SessionMessageLite = {
      role: "tool",
      content: "",
      parts: [
        {
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_file",
          output: "文件内容第一行\n第二行",
          state: "completed",
        },
      ] as Array<Record<string, unknown>>,
    };
    const r = toActivityMessage(m, 100)!;
    expect(r.content).toContain("文件内容第一行");
  });

  test("★ 超长 part 正文 → 截断 100 字（词边界 + …）", () => {
    const m: SessionMessageLite = {
      role: "assistant",
      content: "",
      parts: [
        { type: "text", content: "长".repeat(300) },
      ] as Array<Record<string, unknown>>,
    };
    const r = toActivityMessage(m, 100)!;
    expect(r.content.length).toBeLessThanOrEqual(100);
    expect(r.content).toContain("…");
  });

  test("★ 默认 max（活性面板 lastMessage）空消息 → undefined（旧语义不破）", () => {
    const r = toActivityMessage({ role: "assistant", content: "" });
    expect(r).toBeUndefined();
  });
});

// ============================================================================
// B. 工具调用提取（并行 agent 方案的对齐回归）
// ============================================================================

describe("extractToolCallsFromMessages + formatRecentToolCallLines（对齐）", () => {
  test("★ assistant tool-call part（arguments 对象）→ 工具名 + reason", () => {
    const calls = extractToolCallsFromMessages([
      {
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "task_create",
            arguments: { title: "修 bug", reason: "用户反馈面板空白" },
          },
        ],
      },
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("task_create");
    expect(calls[0].reason).toBe("用户反馈面板空白");
  });

  test("★ arguments 为 JSON 字符串 → 解析提取 reason", () => {
    const calls = extractToolCallsFromMessages([
      {
        role: "assistant",
        content: "",
        parts: [
          {
            type: "tool-call",
            toolCallId: "c2",
            toolName: "bash",
            arguments: '{"command":"git log","reason":"看提交"}',
          },
        ],
      },
    ]);
    expect(calls[0].toolName).toBe("bash");
    expect(calls[0].reason).toBe("看提交");
  });

  test("★ 渲染：工具名：reason，标题只出现一次", () => {
    const lines = formatRecentToolCallLines([
      { toolName: "bash", reason: "查看目录结构" },
      { toolName: "read_file" },
    ]);
    const all = lines.join("\n");
    // ★ 返工：标题去重后正文不含「最近工具调用」（标题只在面板 title）
    expect(all).not.toContain("最近工具调用");
    expect(all).toContain("- bash：查看目录结构");
    expect(all).toContain("- read_file：—");
  });

  test("★ 空 → 「暂无工具调用」单行", () => {
    const lines = formatRecentToolCallLines([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("暂无工具调用");
  });
});

// ============================================================================
// C. formatRecentMessageLines — 标题去重回归
// ============================================================================

describe("formatRecentMessageLines — 标题去重（返工）", () => {
  test("★ 整个面板正文不含「最近消息」字样（标题只在面板 title 一处）", () => {
    const lines = formatRecentMessageLines([
      { role: "user", content: "第一条" },
      { role: "assistant", content: "第二条" },
    ]);
    const all = lines.join("\n");
    expect(all).not.toContain("最近消息");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("第一条");
    expect(lines[0]).toContain("用户");
  });

  test("★ 0 条 → 单行「暂无消息」（不含重复标题）", () => {
    const lines = formatRecentMessageLines([]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("暂无消息");
    expect(lines[0]).not.toContain("最新");
  });
});
