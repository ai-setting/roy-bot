/**
 * Task #4042 ESPlugin v2 Phase 3：lark-cli handler 4 个新方法测试
 *
 * 覆盖：
 *   - emitTriggerEvent(payload) → 返回 triggerEventId，持久化到 EventStore
 *   - extractReplyContext(event) → 返回 ReplyContext（chatId / messageId / senderId）
 *   - buildNotifyHandlePrompt(input) → 构造主 agent prompt，含明确 chatId 提示
 *   - replyMessage(input) → spawn lark-cli 调 im +messages-reply（用 mock runner）
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStoreImpl, type PersistedEvent } from "./event-store";
import {
  larkCliHandler,
  LarkCliInstance,
  type LarkCliRunner,
} from "./event-source-handlers";
import type {
  EventSourceConfig,
  TriggerEventInput,
  ReplyContext,
  ReplyMessageInput,
  ReplyMessageResult,
  BuildNotifyHandlePromptInput,
  BuildNotifyHandlePromptResult,
  PostProcessNotifyEventInput,
} from "./types";

let tmpDir: string;
let dbPath: string;
let store: EventStoreImpl;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "lark-cli-handler-test-"));
  dbPath = join(tmpDir, "events.db");
  store = new EventStoreImpl({ dbPath });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// Mock runner 捕获调用，便于断言
function makeMockRunner(): LarkCliRunner & {
  calls: { command: string }[];
} {
  const calls: { command: string }[] = [];
  return {
    calls,
    run: async (command: string) => {
      calls.push({ command });
      return { stdout: '{"ok":true}', stderr: "", code: 0 };
    },
  };
}

function makeInput(overrides: Partial<TriggerEventInput> = {}): TriggerEventInput {
  return {
    senderId: "ou_sender_lc_001",
    text: "请帮我查 deepseek 模型能力",
    metadata: {
      eventType: "im.message.receive_v1",
      appId: "cli_appid_lc",
      chatId: "oc_chat_lc_001",
      chatType: "group",
      messageId: "om_msg_lc_001",
      messageType: "text",
      senderId: "ou_sender_lc_001",
      tenantKey: "tnt_lc_xyz",
    },
    rawEvent: { type: "event", v: 1 },
    ...overrides,
  };
}

describe("larkCliHandler / emitTriggerEvent", () => {
  test("returns triggerEventId and persists to store", async () => {
    const triggerEventId = await larkCliHandler.emitTriggerEvent(makeInput(), store);
    expect(typeof triggerEventId).toBe("string");
    expect(triggerEventId.length).toBeGreaterThan(0);
    const got = await store.getEventById(triggerEventId);
    expect(got).not.toBeNull();
    expect(got!.esType).toBe("lark-cli");
    expect(got!.senderId).toBe("ou_sender_lc_001");
    expect(got!.metadata.chatId).toBe("oc_chat_lc_001");
  });
});

describe("larkCliHandler / extractReplyContext", () => {
  test("extracts chatId/messageId/senderOpenId/tenantKey from PersistedEvent", async () => {
    const id = await larkCliHandler.emitTriggerEvent(makeInput(), store);
    const event = await store.getEventById(id);
    expect(event).not.toBeNull();
    const ctx = larkCliHandler.extractReplyContext(event!);
    expect(ctx.esType).toBe("lark-cli");
    expect(ctx.chatId).toBe("oc_chat_lc_001");
    expect(ctx.messageId).toBe("om_msg_lc_001");
    expect(ctx.senderOpenId).toBe("ou_sender_lc_001");
    expect(ctx.tenantKey).toBe("tnt_lc_xyz");
  });
});

describe("larkCliHandler / buildNotifyHandlePrompt", () => {
  test("promptText contains trigger chatId explicitly (the key bug fix)", async () => {
    const id = await larkCliHandler.emitTriggerEvent(makeInput(), store);
    const triggerEvent = await store.getEventById(id);

    const input: BuildNotifyHandlePromptInput = {
      notifyEvent: {
        type: "task.background.completed",
        taskId: 4042,
        description: "调研 DeepSeek",
        result: "DeepSeek 是 MoE 架构...",
      },
      triggerEvent: triggerEvent!,
      subAgentResult: {
        summary: "已完成调研，输出 5 页报告。",
      },
    };
    const out = larkCliHandler.buildNotifyHandlePrompt(input);
    expect(out.promptText).toContain("oc_chat_lc_001");
    expect(out.promptText).toContain("om_msg_lc_001");
    expect(out.promptText).toContain("调研 DeepSeek");
    // 关键：prompt 里要明确告诉主 agent "chatId 来自 trigger event"
    expect(out.systemHint).toMatch(/trigger/i);
    expect(out.systemHint).toContain("im +messages-reply");
    expect(out.systemHint).toContain("不要 fallback");
  });

  // ---- Bug A (#4105)：按事件子类型措辞，中间态不再冒充"完成了" ----

  async function promptFor(type: string) {
    const id = await larkCliHandler.emitTriggerEvent(makeInput(), store);
    const triggerEvent = await store.getEventById(id);
    return larkCliHandler.buildNotifyHandlePrompt({
      notifyEvent: { type, taskId: 4105, description: "通知层 bug 调查" },
      triggerEvent: triggerEvent!,
      subAgentResult: { summary: "(无结果)" },
    });
  }

  test("started → 『已启动』，不冒充『完成了』，且不引导回复", async () => {
    const out = await promptFor("task.background.started");
    expect(out.promptText).toContain("已启动");
    expect(out.promptText).not.toContain("完成了");
    // 中间态：不应出现"回复用户"指引
    expect(out.promptText).not.toContain("im +messages-reply");
    expect(out.systemHint).not.toContain("im +messages-reply");
  });

  test("progress → 『进行中』，不冒充『完成了』", async () => {
    const out = await promptFor("task.background.progress");
    expect(out.promptText).toContain("进行中");
    expect(out.promptText).not.toContain("完成了");
    expect(out.systemHint).not.toContain("im +messages-reply");
  });

  test("failed / timeout / stopped → 各自措辞正确且 actionable", async () => {
    expect((await promptFor("task.background.failed")).promptText).toContain("失败");
    expect((await promptFor("task.background.timeout")).promptText).toContain("超时");
    expect((await promptFor("task.background.stopped")).promptText).toContain("已停止");
    // 终态仍引导回复
    expect((await promptFor("task.background.failed")).systemHint).toContain("im +messages-reply");
  });

  test("ask_user → 『请求用户输入』，不冒充『完成了』，不引导 lark-cli 回复", async () => {
    const out = await promptFor("task.background.ask_user");
    expect(out.promptText).toContain("请求用户输入");
    expect(out.promptText).not.toContain("完成了");
    expect(out.systemHint).not.toContain("im +messages-reply");
  });
});

describe("larkCliHandler / replyMessage", () => {
  test("invokes lark-cli im +messages-reply with correct flags", async () => {
    const runner = makeMockRunner();
    larkCliHandler.setRunner(runner);
    const input: ReplyMessageInput = {
      messageId: "om_msg_lc_001",
      chatId: "oc_chat_lc_001",
      content: "Sub-agent 完成报告",
      profile: "zhishitong",
    };
    const result: ReplyMessageResult = await larkCliHandler.replyMessage(input);
    expect(result.success).toBe(true);
    expect(runner.calls.length).toBe(1);
    const cmd = runner.calls[0].command;
    // 必须含 profile / im +messages-reply / --message-id / --chat-id / --content
    expect(cmd).toContain("--profile zhishitong");
    expect(cmd).toContain("im +messages-reply");
    expect(cmd).toContain("--message-id om_msg_lc_001");
    expect(cmd).toContain("--chat-id oc_chat_lc_001");
    expect(cmd).toContain("Sub-agent");
    // ★ Task #4557 (F1)：这条 shell 命令也必须显式 --as bot。
    //   缺了它 lark-cli 用默认身份 = user（真人账号）发出 → 被
    //   `lark-cli event consume im.message.receive_v1` 当成用户消息回灌 →
    //   又跑一次完整 agent run（同类 bug 的实测回灌率 45%）。
    //   注：AST 一致性扫描**看不到**这条拼接字符串（命令名藏在模板串里），
    //   所以在这里单独补断言（交叉验证 H1）。
    expect(cmd).toContain("--as bot");
  });

  test("replyMessage without profile omits --profile flag", async () => {
    const runner = makeMockRunner();
    larkCliHandler.setRunner(runner);
    const result = await larkCliHandler.replyMessage({
      messageId: "om_msg_x",
      chatId: "oc_chat_x",
      content: "hi",
    });
    expect(result.success).toBe(true);
    expect(runner.calls[0].command).not.toContain("--profile");
    expect(runner.calls[0].command).toContain("im +messages-reply");
    // ★ Task #4557 (F1)：无 profile 时同样必须带 --as bot
    expect(runner.calls[0].command).toContain("--as bot");
  });

  test("replyMessage handles spawn error gracefully (success=false, no throw)", async () => {
    const failingRunner: LarkCliRunner = {
      run: async () => {
        return { stdout: "", stderr: "lark-cli: not found", code: 127 };
      },
    };
    larkCliHandler.setRunner(failingRunner);
    const result = await larkCliHandler.replyMessage({
      messageId: "om_msg_e",
      chatId: "oc_chat_e",
      content: "hello",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("lark-cli");
  });
});

describe("larkCliHandler / EventSourceHandler interface compliance", () => {
  test("exposes the 4 v2 methods", () => {
    expect(typeof larkCliHandler.emitTriggerEvent).toBe("function");
    expect(typeof larkCliHandler.replyMessage).toBe("function");
    expect(typeof larkCliHandler.extractReplyContext).toBe("function");
    expect(typeof larkCliHandler.buildNotifyHandlePrompt).toBe("function");
  });
  test("still exposes v1 methods (type, validateConfig, createInstance)", () => {
    expect(larkCliHandler.type).toBe("lark-cli");
    expect(typeof larkCliHandler.validateConfig).toBe("function");
    expect(typeof larkCliHandler.createInstance).toBe("function");
  });
});

// ============================================================================
// Task #4230 — postProcessNotifyEvent（notify prompt 镜像）已删除
// ============================================================================
//
// 旧行为：notify event 走完 buildNotifyHandlePrompt 后，把 formattedPrompt
// 以 markdown 普通消息镜像到 per-task 群。用户明确要求"旧逻辑的普通消息通知
// 不要"，且任务进展已由 LarkCardPatchNotifier 的单卡片 patch 承担 —— 该镜像
// 已被彻底删除（handler 不再实现 postProcessNotifyEvent）。

describe("larkCliHandler / postProcessNotifyEvent 已删除（Task #4230）", () => {
  test("larkCliHandler 不再实现 postProcessNotifyEvent（镜像普通消息已删除）", () => {
    expect((larkCliHandler as any).postProcessNotifyEvent).toBeUndefined();
  });

  test("larkCliHandler 仍保留 ESPlugin v2 的其它钩子（extractReplyContext / buildNotifyHandlePrompt）", () => {
    expect(typeof larkCliHandler.extractReplyContext).toBe("function");
    expect(typeof larkCliHandler.buildNotifyHandlePrompt).toBe("function");
  });

  test("没有任何 handler 实现 postProcessNotifyEvent（防止旧逻辑复活）", async () => {
    const { builtInHandlers } = await import("./event-source-handlers");
    const implementing = builtInHandlers.filter(
      (h) => typeof h.postProcessNotifyEvent === "function",
    );
    expect(implementing.map((h) => h.type)).toEqual([]);
  });
});
