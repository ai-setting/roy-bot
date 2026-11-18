/**
 * @fileoverview Task #4568 — `cli-command` EventSource handler（TDD RED→GREEN）
 *
 * ## 用户诉求（飞书 p2p 2026-10-27）
 *
 * > 「从 cli 的入口输入的 query 触发的 delegate 就无法达到 event 送到 agent
 * >   让其处理的目标了 …… 达到说从 cli 命令行输入也作为一个 cli-command es（默认），
 * >   也可以进行 trigger event 的记录，以此达到类似的 rule base 通知和部分 event
 * >   进入 agent 进行处理 response 的效果。」
 *
 * ## 本文件锁定的契约
 *
 * 1. `cliCommandHandler.emitTriggerEvent()` **必须**把 `es_type` 写成
 *    `'cli-command'`，**不能**写成 `'lark-cli'`。
 *    为什么这条是核心：`getHandlerForEsType(esType)` 是 v2 notify prompt 的
 *    唯一分派 key。若写成 `lark-cli`，agent 会收到「用 lark-cli 发到 oc_xxx」
 *    的 prompt —— 而 CLI 路径根本没有 oc_xxx（Task #4568 设计 §5.2 决策①）。
 *
 * 2. 落库的 metadata **必须**自包含回复目标：
 *    `chatId = "cli:<sessionId>"` + `params.sink = "stdout"`。
 *    为什么：`_captureReplyChannelSnapshot()`（delegate-tool.ts:2676）要求
 *    `chatId || messageId` 至少一个非空，否则整份快照被丢弃 → notify event
 *    无回复目标 → 规则通知静默丢失（探针 D 实测）。
 *
 * 3. `buildNotifyHandlePrompt()` 必须明确告诉 agent「CLI 没有 IM 通道，
 *    把结论输出到 stdout，不要调用 lark-cli」。
 *    为什么：否则 agent 会照抄飞书 prompt 的惯性去编一个 chatId。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStoreImpl } from "./event-store";
import {
  cliCommandHandler,
  buildCliReplyChannel,
  CLI_COMMAND_ES_TYPE,
  CLI_SESSION_CHAT_ID_PREFIX,
} from "./cli-command-handler";

let tmpDir: string;
let store: EventStoreImpl;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cli-cmd-handler-"));
  store = new EventStoreImpl({ dbPath: join(tmpDir, "events.db") });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// 组 1：emitTriggerEvent
// ============================================================================

describe("cliCommandHandler.emitTriggerEvent", () => {
  test("返回 evt_ 前缀的唯一 ID 并落盘 EventStore", async () => {
    const id = await cliCommandHandler.emitTriggerEvent!(
      {
        senderId: "cli:test:1234",
        text: "帮我 delegate 一个任务",
        metadata: { eventType: "cli.query" },
      },
      store,
    );

    expect(typeof id).toBe("string");
    expect(id.startsWith("evt_")).toBe(true);

    // 真的落盘了：能查回来
    const persisted = await store.getEventById(id);
    expect(persisted).not.toBeNull();
  });

  test("es_type 必须是 'cli-command'（不是 'lark-cli'）★ 核心", async () => {
    const id = await cliCommandHandler.emitTriggerEvent!(
      { senderId: "cli:test:1234", metadata: { eventType: "cli.query" } },
      store,
    );
    const persisted = await store.getEventById(id);
    expect(persisted!.esType).toBe("cli-command");
    expect(persisted!.esType).not.toBe("lark-cli");
    // handler 自己声明的 type 必须与落库一致，否则 getHandlerForEsType 会 miss
    expect(cliCommandHandler.type).toBe(CLI_COMMAND_ES_TYPE);
    expect(CLI_COMMAND_ES_TYPE).toBe("cli-command");
  });

  test("metadata 自包含回复目标（chatId + params.sink）", async () => {
    const replyChannel = buildCliReplyChannel({ sessionId: "sess-abc" });
    const id = await cliCommandHandler.emitTriggerEvent!(
      {
        senderId: "cli:test:1234",
        text: "delegate",
        metadata: {
          eventType: "cli.query",
          sessionId: "sess-abc",
          cwd: "/tmp/work",
          chatId: replyChannel.chatId,
          replyChannel,
        },
      },
      store,
    );

    const persisted = await store.getEventById(id);
    const meta = persisted!.metadata as Record<string, any>;
    expect(meta.eventType).toBe("cli.query");
    expect(meta.sessionId).toBe("sess-abc");
    expect(meta.cwd).toBe("/tmp/work");
    // ★ chatId 必须非空，否则 _captureReplyChannelSnapshot() 整份丢弃
    expect(typeof meta.chatId).toBe("string");
    expect(meta.chatId).toBe(`cli:sess-abc`);
    expect(meta.replyChannel?.params?.sink).toBe("stdout");
  });

  test("payload 的 command / argv / cwd / query 都落进 rawEvent", async () => {
    const id = await cliCommandHandler.emitTriggerEvent!(
      {
        senderId: "cli:test:1234",
        text: "查一下天气",
        metadata: { eventType: "cli.query", sessionId: "s1" },
        rawEvent: {
          command: "run",
          argv: ["run", "--no-quiet"],
          cwd: "/tmp/work",
          query: "查一下天气",
          sessionId: "s1",
          pid: 4321,
        },
      },
      store,
    );

    const persisted = await store.getEventById(id);
    const raw = persisted!.rawEvent as Record<string, unknown>;
    expect(raw.command).toBe("run");
    expect(raw.argv).toEqual(["run", "--no-quiet"]);
    expect(raw.cwd).toBe("/tmp/work");
    expect(raw.query).toBe("查一下天气");
    expect(raw.sessionId).toBe("s1");
    expect(raw.pid).toBe(4321);
  });

  test("连续两次 emit → 两个不同 ID（不撞键）", async () => {
    const a = await cliCommandHandler.emitTriggerEvent!(
      { senderId: "cli:t:1", metadata: { eventType: "cli.query" } },
      store,
    );
    const b = await cliCommandHandler.emitTriggerEvent!(
      { senderId: "cli:t:1", metadata: { eventType: "cli.query" } },
      store,
    );
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// 组 2：buildCliReplyChannel
// ============================================================================

describe("buildCliReplyChannel", () => {
  test("默认 sink=stdout，chatId = 'cli:<sessionId>'", () => {
    const rc = buildCliReplyChannel({ sessionId: "sess-xyz" });
    expect(rc.type).toBe("cli-command");
    expect(rc.chatId).toBe("cli:sess-xyz");
    expect(rc.chatId.startsWith(CLI_SESSION_CHAT_ID_PREFIX)).toBe(true);
    expect(rc.params?.sink).toBe("stdout");
    expect(rc.params?.cliSessionId).toBe("sess-xyz");
  });

  test("chatId 永不为空（否则 _captureReplyChannelSnapshot 整份丢弃）", () => {
    for (const sid of ["a", "session_123", "x".repeat(200)]) {
      const rc = buildCliReplyChannel({ sessionId: sid });
      expect(typeof rc.chatId).toBe("string");
      expect(rc.chatId.length).toBeGreaterThan(0);
    }
  });

  test("空 sessionId → 仍有非空 chatId（降级不炸）", () => {
    const rc = buildCliReplyChannel({ sessionId: "" });
    expect(typeof rc.chatId).toBe("string");
    expect(rc.chatId.length).toBeGreaterThan(0);
    expect(rc.chatId).toBe("cli:default");
  });
});

// ============================================================================
// 组 3：extractReplyContext
// ============================================================================

describe("cliCommandHandler.extractReplyContext", () => {
  test("从 trigger event metadata 提取 chatId / sessionId", async () => {
    const replyChannel = buildCliReplyChannel({ sessionId: "sess-abc" });
    const id = await cliCommandHandler.emitTriggerEvent!(
      {
        senderId: "cli:test:1234",
        metadata: {
          eventType: "cli.query",
          sessionId: "sess-abc",
          chatId: replyChannel.chatId,
          replyChannel,
        },
      },
      store,
    );
    const persisted = await store.getEventById(id);
    const ctx = cliCommandHandler.extractReplyContext!(persisted!);
    expect(ctx.esType).toBe("cli-command");
    expect(ctx.chatId).toBe("cli:sess-abc");
  });
});

// ============================================================================
// 组 4：buildNotifyHandlePrompt —— 关键：告诉 agent「CLI 没有 IM 通道」
// ============================================================================

function makeTriggerEvent(overrides: Record<string, unknown> = {}) {
  const meta = {
    eventType: "cli.query",
    sessionId: "sess-abc",
    cwd: "/tmp/work",
    chatId: "cli:sess-abc",
    replyChannel: buildCliReplyChannel({ sessionId: "sess-abc" }),
    ...overrides,
  };
  return {
    eventId: "evt_cli_1",
    esType: "cli-command",
    senderId: "cli:test:1234",
    text: "delegate 一个任务",
    metadata: meta,
    rawEvent: { command: "run", query: "delegate 一个任务" },
    createdAt: Date.now(),
  };
}

/**
 * ★ 生产真实形状：`BuildNotifyHandlePromptInput.notifyEvent` 是 CLI EventHandler
 * **归一化后的扁平结构**（见 types.ts:734），不是 BackgroundTaskManager 的
 * payload 信封。第一版测试按 `.payload.*` 写，被 TDD 抓出来改正。
 */
function makeNotifyEvent(type = "task.background.completed") {
  return {
    type,
    taskId: 4568,
    description: "CLI 触发的后台任务",
    result: "任务结果正文",
    subSessionId: "sub-1",
  };
}

/** 直接调 handler 的旧调用方可能传 payload 信封 —— 兼容路径的测试用 */
function makeLegacyNotifyEvent(type = "task.background.completed") {
  return {
    id: "evt_bg_1",
    type,
    timestamp: Date.now(),
    metadata: { triggerEventId: "evt_cli_1" },
    payload: {
      backgroundTaskId: "process_1",
      subSessionId: "sub-1",
      parentSessionId: "sess-abc",
      description: "CLI 触发的后台任务",
      subagentType: "general",
      result: "任务结果正文",
      executionTimeMs: 1234,
    },
  };
}

describe("cliCommandHandler.buildNotifyHandlePrompt", () => {
  test("prompt 明确声明「CLI 无 IM 通道，输出到 stdout，不要调 lark-cli」★ 核心", () => {
    const out = cliCommandHandler.buildNotifyHandlePrompt!({
      notifyEvent: makeNotifyEvent() as any,
      triggerEvent: makeTriggerEvent() as any,
    });

    const text = out.promptText;
    expect(text).toContain("cli-command");
    // 必须明确"不要调 lark-cli"——否则 agent 照抄飞书惯性编 chatId
    expect(text.toLowerCase()).toContain("lark-cli");
    expect(text).toMatch(/不要|无需|禁止/);
    // 必须说明输出到 stdout / 终端
    expect(text).toMatch(/stdout|终端/);
  });

  test("taskId 缺失时用 backgroundTaskId 短片段兜底（不显示 #?）", () => {
    const out = cliCommandHandler.buildNotifyHandlePrompt!({
      notifyEvent: { type: "task.background.completed", description: "d", result: "r" } as any,
      triggerEvent: makeTriggerEvent() as any,
    });
    // ★ 真机验证发现 `Task #?` 很突兀 —— 缺失时不得渲染 `#?`
    expect(out.promptText).not.toContain("#?");
    expect(out.promptText).toContain("后台任务");
  });

  test("有 backgroundTaskId 时用它生成可读标签", () => {
    const out = cliCommandHandler.buildNotifyHandlePrompt!({
      notifyEvent: {
        type: "task.background.completed",
        description: "d",
        result: "r",
        backgroundTaskId: "process_1793101794979_dyvi6vhxx",
      } as any,
      triggerEvent: makeTriggerEvent() as any,
    });
    expect(out.promptText).toContain("dyvi6vhxx");
    expect(out.promptText).not.toContain("#?");
  });

  test("有 taskId 时渲染 Task #<id>（不出现双重前缀）", () => {
    const out = cliCommandHandler.buildNotifyHandlePrompt!({
      notifyEvent: { type: "task.background.completed", taskId: 4568, description: "d", result: "r" } as any,
      triggerEvent: makeTriggerEvent() as any,
    });
    expect(out.promptText).toContain("Task #4568");
    expect(out.promptText).not.toContain("Task #Task #");
  });

  test("prompt 含触发上下文（cwd / sessionId）", () => {
    const out = cliCommandHandler.buildNotifyHandlePrompt!({
      notifyEvent: makeNotifyEvent() as any,
      triggerEvent: makeTriggerEvent() as any,
    });
    expect(out.promptText).toContain("/tmp/work");
    expect(out.promptText).toContain("sess-abc");
  });

  test("prompt 含 sub-agent 结果正文（agent 才能组织回复）", () => {
    const out = cliCommandHandler.buildNotifyHandlePrompt!({
      notifyEvent: makeNotifyEvent() as any,
      triggerEvent: makeTriggerEvent() as any,
    });
    expect(out.promptText).toContain("任务结果正文");
  });

  test("timeout 事件 → prompt 显示超时语义（不是完成）", () => {
    const out = cliCommandHandler.buildNotifyHandlePrompt!({
      notifyEvent: makeNotifyEvent("task.background.timeout") as any,
      triggerEvent: makeTriggerEvent() as any,
    });
    expect(out.promptText).toMatch(/超时/);
  });

  test("ruleNotice 已送达 → prompt 要求只发增量（不重复回执原文）", () => {
    const out = cliCommandHandler.buildNotifyHandlePrompt!({
      notifyEvent: makeNotifyEvent() as any,
      triggerEvent: makeTriggerEvent() as any,
      ruleNotice: {
        attempted: true,
        delivered: true,
        chatId: "cli:sess-abc",
        text: "[通知] Task #1 已完成",
        sentAt: Date.now(),
      },
    });
    expect(out.promptText).toContain("[通知] Task #1 已完成");
    expect(out.promptText).toMatch(/增量|不要重复/);
  });

  test("兼容旧调用方：notifyEvent 用 payload 信封也能读到结果", () => {
    const out = cliCommandHandler.buildNotifyHandlePrompt!({
      notifyEvent: makeLegacyNotifyEvent() as any,
      triggerEvent: makeTriggerEvent() as any,
    });
    expect(out.promptText).toContain("任务结果正文");
    expect(out.promptText).toContain("CLI 触发的后台任务");
  });

  test("ruleNotice 未送达 → prompt 要求 agent 自己讲完整", () => {
    const out = cliCommandHandler.buildNotifyHandlePrompt!({
      notifyEvent: makeNotifyEvent() as any,
      triggerEvent: makeTriggerEvent() as any,
      ruleNotice: {
        attempted: true,
        delivered: false,
        error: "no-target",
      },
    });
    expect(out.promptText).toMatch(/未送达|没送达|讲清楚|完整/);
  });
});

// ============================================================================
// 组 5：接口完整性（EventSourceHandler 契约）
// ============================================================================

describe("cliCommandHandler 接口完整性", () => {
  test("type / validateConfig / createInstance 齐备", () => {
    expect(cliCommandHandler.type).toBe("cli-command");
    expect(cliCommandHandler.validateConfig({} as any)).toEqual([]);
    expect(typeof cliCommandHandler.createInstance).toBe("function");
  });

  test("内置类型常量登记（BUILT_IN_EVENT_SOURCE_TYPES 含 cli-command）", async () => {
    const { BUILT_IN_EVENT_SOURCE_TYPES, isBuiltInEventSourceType } = await import("./types");
    expect((BUILT_IN_EVENT_SOURCE_TYPES as any).CLI_COMMAND).toBe("cli-command");
    expect(isBuiltInEventSourceType("cli-command")).toBe(true);
  });

  test("builtInHandlers 数组包含 cliCommandHandler（EventHandler 才能分派到）", async () => {
    const { builtInHandlers, getBuiltInHandler } = await import("./event-source-handlers");
    expect(builtInHandlers.some((h) => h.type === "cli-command")).toBe(true);
    expect(getBuiltInHandler("cli-command")).toBeDefined();
  });
});
