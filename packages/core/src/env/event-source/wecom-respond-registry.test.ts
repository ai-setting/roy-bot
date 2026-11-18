/**
 * @fileoverview Task #5174 — wecom_respond 工具 + 注册表 + sendWecomReply 测试
 *
 * 出站主路径 = CLI（Task #5174 用户明令 11:29）；WS 回帧 = fallback。
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  registerWecomRespondTarget,
  unregisterWecomRespondTarget,
  getWecomRespondTarget,
  __resetWecomRespondRegistryForTest,
  sendWecomReply,
  wecomRespondTool,
} from "./wecom-respond-registry";
import { runWithEnvContext, createEnvContext } from "../context/env-context";

describe("wecom-respond-registry — 注册表", () => {
  beforeEach(() => __resetWecomRespondRegistryForTest());

  test("register + get", () => {
    const target = { respond: () => undefined };
    registerWecomRespondTarget("src-1", target);
    expect(getWecomRespondTarget("src-1")).toBe(target);
  });

  test("unregister", () => {
    registerWecomRespondTarget("src-1", { respond: () => undefined });
    unregisterWecomRespondTarget("src-1");
    expect(getWecomRespondTarget("src-1")).toBeUndefined();
  });

  test("重复注册覆盖", () => {
    const t1 = { respond: () => undefined };
    const t2 = { respond: () => undefined };
    registerWecomRespondTarget("src-1", t1);
    registerWecomRespondTarget("src-1", t2);
    expect(getWecomRespondTarget("src-1")).toBe(t2);
  });
});

describe("sendWecomReply — CLI 优先 / WS fallback", () => {
  beforeEach(() => __resetWecomRespondRegistryForTest());

  test("空 content → 失败（不发）", async () => {
    const r = await sendWecomReply({
      sourceId: "s",
      rawChatId: "u",
      content: "   ",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("empty content");
  });

  test("CLI 失败 + 无 reqId → 失败并带 cli 原因", async () => {
    // 用不存在的 CLI 二进制强制 CLI 失败
    process.env.WECOM_CLI_BIN = "/nonexistent/wecom-cli-xyz";
    try {
      const r = await sendWecomReply({
        sourceId: "s",
        rawChatId: "u1",
        content: "hi",
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("cli:");
    } finally {
      delete process.env.WECOM_CLI_BIN;
    }
  });

  test("CLI 失败 + 有 reqId + 注册实例 → 走 WS，channel=ws", async () => {
    process.env.WECOM_CLI_BIN = "/nonexistent/wecom-cli-xyz";
    const calls: Array<{ reqId: string; body: Record<string, unknown> }> = [];
    registerWecomRespondTarget("s", {
      respond: (reqId, body) => {
        calls.push({ reqId, body });
        return undefined;
      },
    });
    try {
      const r = await sendWecomReply({
        sourceId: "s",
        rawChatId: "u2",
        reqId: "r-9",
        content: "fallback!",
      });
      expect(r.ok).toBe(true);
      expect(r.channel).toBe("ws");
      expect(calls.length).toBe(1);
      expect(calls[0].reqId).toBe("r-9");
      expect(calls[0].body).toEqual({
        msgtype: "markdown",
        markdown: { content: "fallback!" },
      });
    } finally {
      delete process.env.WECOM_CLI_BIN;
    }
  });

  test("两个通道都失败 → 失败且错误含 cli: 与 ws:", async () => {
    process.env.WECOM_CLI_BIN = "/nonexistent/wecom-cli-xyz";
    registerWecomRespondTarget("s", {
      respond: () => new Error("bridge not connected"),
    });
    try {
      const r = await sendWecomReply({
        sourceId: "s",
        rawChatId: "u3",
        reqId: "r-1",
        content: "x",
      });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("cli:");
      expect(r.error).toContain("ws:");
      expect(r.error).toContain("bridge not connected");
    } finally {
      delete process.env.WECOM_CLI_BIN;
    }
  });
});

describe("wecomRespondTool — 参数 schema", () => {
  test("content 必填，chat_id / req_id 可选", () => {
    const shape = (wecomRespondTool.parameters as any)._def.shape();
    expect(shape.content).toBeDefined();
    expect(shape.chat_id).toBeDefined();
    expect(shape.req_id).toBeDefined();
  });
});

describe("wecomRespondTool — execute", () => {
  beforeEach(() => __resetWecomRespondRegistryForTest());

  function runTool(args: Record<string, unknown>) {
    return wecomRespondTool.execute(args as never, {
      workdir: "/tmp",
    } as never);
  }

  function withWecomEventEnvContext(sourceId: string, chatId?: string) {
    return createEnvContext({
      envEvent: {
        type: "event-source.event.wecom-cli",
        metadata: { sourceId, chatId, reqId: "evt-req-1" },
      },
      sourceId,
      userId: "tester",
    });
  }

  test("无 chat_id 且无 EnvContext → 失败（无法定位目标）", async () => {
    const result = await runTool({ content: "hi" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("chat_id");
  });

  test("EnvContext 提供 chatId → 走发送（CLI 失败则 WS fallback）", async () => {
    process.env.WECOM_CLI_BIN = "/nonexistent/wecom-cli-xyz";
    registerWecomRespondTarget("src-1", { respond: () => undefined });
    try {
      const ctx = withWecomEventEnvContext("src-1", "DongZhaoKun");
      const result = await runWithEnvContext(ctx, () =>
        runTool({ content: "hello" }),
      );
      expect(result.success).toBe(true);
      expect(String(result.output)).toContain("ws");
    } finally {
      delete process.env.WECOM_CLI_BIN;
    }
  });

  test("Task #5333 MINOR-1：EnvContext 无 envEvent.chatId 时，回落到 replyChannel.chatId（delegate sub-agent 兜底）", async () => {
    process.env.WECOM_CLI_BIN = "/nonexistent/wecom-cli-xyz";
    registerWecomRespondTarget("src-1", { respond: () => undefined });
    try {
      // 模拟 delegate 出去的 sub-agent：envEvent 无 chatId（父级 ALS 未继承），
      // 但 replyChannel 是 delegate 时刻的快照（Task #4042），带 chatId。
      const ctx = createEnvContext({
        envEvent: {
          type: "event-source.event.wecom-cli",
          metadata: { sourceId: "src-1", reqId: "evt-req-1" },
        },
        sourceId: "src-1",
        userId: "tester",
        replyChannel: { chatId: "SNAPSHOT-CHAT-1" },
      } as never);
      const result = await runWithEnvContext(ctx, () =>
        runTool({ content: "hello from sub-agent" }),
      );
      expect(result.success).toBe(true);
      expect(String((result.metadata as any)?.chat_id)).toBe("SNAPSHOT-CHAT-1");
    } finally {
      delete process.env.WECOM_CLI_BIN;
    }
  });

  test("envEvent.chatId 优先于 replyChannel.chatId（当前事件权威定位）", async () => {
    process.env.WECOM_CLI_BIN = "/nonexistent/wecom-cli-xyz";
    registerWecomRespondTarget("src-1", { respond: () => undefined });
    try {
      const ctx = createEnvContext({
        envEvent: {
          type: "event-source.event.wecom-cli",
          metadata: { sourceId: "src-1", chatId: "EVENT-CHAT-1", reqId: "evt-req-1" },
        },
        sourceId: "src-1",
        userId: "tester",
        replyChannel: { chatId: "SNAPSHOT-CHAT-1" },
      } as never);
      const result = await runWithEnvContext(ctx, () =>
        runTool({ content: "hello" }),
      );
      expect(result.success).toBe(true);
      expect(String((result.metadata as any)?.chat_id)).toBe("EVENT-CHAT-1");
    } finally {
      delete process.env.WECOM_CLI_BIN;
    }
  });

  test("显式 chat_id 优先于 EnvContext", async () => {
    process.env.WECOM_CLI_BIN = "/nonexistent/wecom-cli-xyz";
    const calls: string[] = [];
    registerWecomRespondTarget("src-1", {
      respond: () => {
        calls.push("ws-called");
        return undefined;
      },
    });
    try {
      const ctx = withWecomEventEnvContext("src-1", "from-context");
      const result = await runWithEnvContext(ctx, () =>
        runTool({ content: "x", chat_id: "explicit-chat" }),
      );
      expect(result.success).toBe(true);
      expect(String((result.metadata as any)?.chat_id)).toBe("explicit-chat");
    } finally {
      delete process.env.WECOM_CLI_BIN;
    }
  });

  test("发送全失败 → 工具失败并透传错误", async () => {
    process.env.WECOM_CLI_BIN = "/nonexistent/wecom-cli-xyz";
    registerWecomRespondTarget("src-1", {
      respond: () => new Error("bridge down"),
    });
    try {
      const ctx = withWecomEventEnvContext("src-1", "c1");
      const result = await runWithEnvContext(ctx, () =>
        runTool({ content: "hi" }),
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("bridge down");
    } finally {
      delete process.env.WECOM_CLI_BIN;
    }
  });
});

// =============================================================================
// 框架级自动补发（Task #5174 — LLM 不调工具时的兜底）
// =============================================================================

import {
  autoReplyWecomTurn,
  markWecomReplySent,
  wasWecomReplySent,
  __resetWecomReplySentForTest,
} from "./wecom-respond-registry";

describe("autoReplyWecomTurn — 框架级兜底补发", () => {
  beforeEach(() => {
    __resetWecomRespondRegistryForTest();
    __resetWecomReplySentForTest();
    process.env.WECOM_CLI_BIN = "/nonexistent/wecom-cli-xyz";
  });
  // 每个 test 结束后恢复（bun:test 无 afterEach in this block above）
  const restore = () => delete process.env.WECOM_CLI_BIN;

  const wecomEvent = (extra: Record<string, unknown> = {}) => ({
    type: "event-source.event.wecom-cli",
    metadata: {
      sourceId: "src-1",
      chatId: "DongZhaoKun",
      senderId: "DongZhaoKun",
      reqId: "evt-req",
      ...extra,
    },
  });

  test("非企微事件 → skipped", async () => {
    const r = await autoReplyWecomTurn({ type: "task.background.completed" }, "hi");
    expect(r.skipped).toBe(true);
    restore();
  });

  test("空文本 → skipped", async () => {
    const r = await autoReplyWecomTurn(wecomEvent(), "   ");
    expect(r.skipped).toBe(true);
    restore();
  });

  test("已通过工具发送 → skipped（防双发）", async () => {
    const ctx = createEnvContext({
      envEvent: wecomEvent(),
      sourceId: "src-1",
      userId: "u",
    });
    const r = await runWithEnvContext(ctx, async () => {
      markWecomReplySent();
      expect(wasWecomReplySent()).toBe(true);
      return autoReplyWecomTurn(wecomEvent(), "hello");
    });
    expect(r.skipped).toBe(true);
    if (r.skipped) expect(r.reason).toContain("already replied");
    restore();
  });

  test("未发送 + 有 chatId → 尝试发送（CLI 失败则 WS fallback）", async () => {
    registerWecomRespondTarget("src-1", { respond: () => undefined });
    const ctx = createEnvContext({
      envEvent: wecomEvent(),
      sourceId: "src-1",
      userId: "u",
    });
    const r = await runWithEnvContext(ctx, () =>
      autoReplyWecomTurn(wecomEvent(), "framework reply"),
    );
    expect(r.skipped).toBe(false);
    if (!r.skipped) {
      expect(r.ok).toBe(true);
      expect(r.channel).toBe("ws");
    }
    restore();
  });

  test("无 chatId / senderId → skipped", async () => {
    const evt = { type: "event-source.event.wecom-cli", metadata: { sourceId: "s" } };
    const r = await autoReplyWecomTurn(evt, "hi");
    expect(r.skipped).toBe(true);
    if (r.skipped) expect(r.reason).toContain("chatId");
    restore();
  });
});
