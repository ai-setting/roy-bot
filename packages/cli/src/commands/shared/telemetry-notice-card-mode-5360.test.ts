/**
 * @fileoverview Task #5360 — 文本通知下线的行为矩阵（EventHandler 侧端到端）
 *
 * ## 用户需求
 *
 * 1. 原始需求（20:50）：「去掉通知类文本消息（`⏱️ 后台任务运行中 20m` /
 *    `✅ 已完成 36m` 这类 rule-based 直发的状态推送文本），改为全部用卡片承载」
 * 2. 补充需求（20:54）：「`event-sources.json` 新增配置项控制状态通知消息，
 *    **默认 false 不启动**；false = 不发状态通知文本（走卡片），true = 恢复之前
 *    的推送」
 *
 * ## 行为矩阵（本文件逐格断言）
 *
 * | 事件 | auto + false（默认） | auto + true | card | text | stdout |
 * |------|------|------|------|------|------|
 * | started / progress | 静默 | 发文本 | 静默 | 发文本 | **发文本** |
 * | completed / timeout | 静默 | 发文本 | 静默 | 发文本 | **发文本** |
 *
 * ## 必须守住的不变量（否则改造就是功能倒退）
 *
 * I1. `sink === "stdout"` **永远**发文本（CLI 本地没有卡片可看）—— 最高优先级
 * I2. 静默模式下 `started` / `progress` **仍不 claimSession、仍不跑 agent**（#4552 收益）
 * I3. 静默模式下 `completed` / `timeout` **仍继续 enqueue**（agent 要读结果、组织总结）
 * I4. `statusNotifications: true` **只恢复文本，不抑制卡片**（两者正交）
 * I5. 类型严格：`"true"` / `1` / `null` 一律按 false
 */

import { describe, test, expect, vi } from "bun:test";
import { EventHandler } from "./event-handler";
import type { EventHandlerOptions } from "./event-handler";
import { EventMessageFormatter } from "./event-message-formatter";
import {
  shouldDeliverNoticeText,
  DEFAULT_NOTICE_TEXT_DELIVERY,
  type NoticeTextDelivery,
} from "./telemetry-notice";

// ----------------------------------------------------------------------------
// 基础夹具（与 event-handler-telemetry-notice.test.ts 同形态）
// ----------------------------------------------------------------------------

const CHAT = "oc_8904d6f184e31b6cc51ba53a0a19aa2f";
const START = new Date(2026, 10, 11, 20, 47, 12).getTime();
const FIVE_HOURS = 5 * 3600 * 1000;

interface SentNotice {
  chatId?: string;
  text: string;
  sink?: "lark" | "stdout";
}

async function waitFor(fn: () => boolean, timeout = 2000, interval = 5): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));
  }
}

function makeSessionComponent() {
  return {
    create: vi.fn().mockResolvedValue({ id: "should-not-be-used", title: "t" }),
    get: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    getActiveSessionId: vi.fn().mockReturnValue(undefined),
    setActiveSession: vi.fn().mockResolvedValue(true),
  };
}

function makeHandler(opts: {
  sent: SentNotice[];
  onEventWithEnv?: any;
  delivery?: NoticeTextDelivery;
  statusNotifications?: boolean;
  resolveStatusNotifications?: (e: any) => boolean;
}): EventHandler {
  return new EventHandler({
    env: { subscribeAll: () => () => {}, getComponent: () => undefined } as any,
    eventTypes: ["task.background.*", "event-source.event.*"],
    formatter: new EventMessageFormatter({ prefix: "[通知]" }),
    onEvent: async () => {},
    onEventWithEnv: opts.onEventWithEnv ?? (async () => {}),
    sessionComponent: makeSessionComponent() as any,
    ...(opts.delivery !== undefined ? { noticeTextDelivery: opts.delivery } : {}),
    ...(opts.resolveStatusNotifications
      ? { resolveStatusNotifications: opts.resolveStatusNotifications }
      : {}),
    telemetrySender: async (notice: SentNotice) => {
      opts.sent.push(notice);
    },
  } as EventHandlerOptions);
}

function bgEvent(
  type: string,
  payloadOver: Record<string, unknown> = {},
  metaOver: Record<string, unknown> = {},
) {
  return {
    id: `evt-${type}`,
    type,
    timestamp: Date.now(),
    payload: {
      backgroundTaskId: "process_1792988622098_r6rml36s6",
      subSessionId: "sub-1",
      parentSessionId: "parent-1",
      status: "running",
      description: "调研 airport 本体生成",
      associatedTaskId: 4547,
      startedAt: START,
      timeoutMs: FIVE_HOURS,
      ...payloadOver,
    },
    metadata: {
      source: "task.background",
      sourceId: "src",
      trigger_session_id: "parent-1",
      replyChannel: { type: "lark-cli", chatId: CHAT, messageId: "om_x", profile: "tongzhuli" },
      ...metaOver,
    },
  } as any;
}

// ============================================================================
// 0. 纯函数 shouldDeliverNoticeText（矩阵本体）
// ============================================================================

describe("shouldDeliverNoticeText — 行为矩阵", () => {
  test("★ I1：stdout 永远发文本（所有模式，含 card 强制静默）", () => {
    for (const d of ["auto", "card", "text", undefined] as const) {
      for (const cfg of [true, false, undefined]) {
        expect(shouldDeliverNoticeText(d, "stdout", cfg)).toBe(true);
      }
    }
  });

  test("★ auto + 配置 false（默认）→ 静默", () => {
    expect(shouldDeliverNoticeText("auto", "lark", false)).toBe(false);
  });

  test("★ auto + 配置缺失（undefined）→ 静默（默认 false 语义）", () => {
    expect(shouldDeliverNoticeText("auto", "lark", undefined)).toBe(false);
  });

  test("★ auto + 配置 true → 发文本（旧行为）", () => {
    expect(shouldDeliverNoticeText("auto", "lark", true)).toBe(true);
  });

  test("card 强制静默：忽略配置值", () => {
    expect(shouldDeliverNoticeText("card", "lark", true)).toBe(false);
    expect(shouldDeliverNoticeText("card", "lark", false)).toBe(false);
  });

  test("text 强制发：忽略配置值", () => {
    expect(shouldDeliverNoticeText("text", "lark", false)).toBe(true);
    expect(shouldDeliverNoticeText("text", "lark", true)).toBe(true);
  });

  test("★ 缺省 delivery（undefined）按 auto 语义", () => {
    expect(shouldDeliverNoticeText(undefined, "lark", false)).toBe(false);
    expect(shouldDeliverNoticeText(undefined, "lark", true)).toBe(true);
  });

  test("★ 默认模式是 auto（不是 card / text）", () => {
    expect(DEFAULT_NOTICE_TEXT_DELIVERY).toBe("auto");
  });
});

// ============================================================================
// 1. 默认（auto + ES 缺省 false）→ 静默 + 不跑 agent
// ============================================================================

describe("默认配置（auto + statusNotifications 缺省 false）", () => {
  test("★ progress：不发文本（telemetrySender 计数 0）", async () => {
    const sent: SentNotice[] = [];
    const handler = makeHandler({ sent });
    handler.handleEvent(bgEvent("task.background.progress"));
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(0);
  });

  test("★ started：不发文本", async () => {
    const sent: SentNotice[] = [];
    const handler = makeHandler({ sent });
    handler.handleEvent(bgEvent("task.background.started", { startedAt: START }));
    await new Promise((r) => setTimeout(r, 50));
    expect(sent).toHaveLength(0);
  });

  test("★ I2：静默模式下 progress 仍不跑 agent（#4552 收益必须保住）", async () => {
    const sent: SentNotice[] = [];
    const runs: string[] = [];
    const handler = makeHandler({
      sent,
      onEventWithEnv: async (f: any) => {
        runs.push(f.message);
      },
    });
    handler.handleEvent(bgEvent("task.background.progress"));
    await new Promise((r) => setTimeout(r, 120));
    expect(sent).toHaveLength(0);
    expect(runs).toHaveLength(0); // ← 关键：既不直发也不进 lane
  });

  test("★ completed：不发文本，但 I3 仍然 enqueue 走 agent", async () => {
    const sent: SentNotice[] = [];
    const runs: string[] = [];
    const handler = makeHandler({
      sent,
      onEventWithEnv: async (f: any) => {
        runs.push(f.message);
      },
    });
    handler.handleEvent(
      bgEvent("task.background.completed", { status: "completed", executionTimeMs: 36 * 60 * 1000 }),
    );
    await waitFor(() => runs.length > 0, 2000);
    expect(sent).toHaveLength(0);
    expect(runs.length).toBeGreaterThan(0); // ← agent 必须参与
  });

  test("★ timeout：不发文本，但仍然 enqueue", async () => {
    const sent: SentNotice[] = [];
    const runs: string[] = [];
    const handler = makeHandler({
      sent,
      onEventWithEnv: async (f: any) => {
        runs.push(f.message);
      },
    });
    handler.handleEvent(
      bgEvent("task.background.timeout", {
        status: "timeout",
        error: "Task execution timeout after 18000000ms",
      }),
    );
    await waitFor(() => runs.length > 0, 2000);
    expect(sent).toHaveLength(0);
    expect(runs.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 2. auto + 配置 true → 恢复文本（逐字旧行为）
// ============================================================================

describe("auto + statusNotifications: true（恢复旧文本推送）", () => {
  test("★ progress → 发 1 条文本，文案含 Task #id + 标题 + 已跑时长", async () => {
    const sent: SentNotice[] = [];
    const handler = makeHandler({
      sent,
      resolveStatusNotifications: () => true,
    });
    handler.handleEvent(bgEvent("task.background.progress"));
    await waitFor(() => sent.length > 0);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Task #4547");
    expect(sent[0].text).toContain("调研 airport 本体生成");
    expect(sent[0].text).toContain("后台运行中");
  });

  test("★ completed → 发 1 条终态回执，文案含「已完成」", async () => {
    const sent: SentNotice[] = [];
    const handler = makeHandler({
      sent,
      resolveStatusNotifications: () => true,
    });
    handler.handleEvent(
      bgEvent("task.background.completed", { status: "completed", executionTimeMs: 36 * 60 * 1000 }),
    );
    await waitFor(() => sent.length > 0);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("✅");
    expect(sent[0].text).toContain("已完成");
    expect(sent[0].text).toContain("36m");
  });

  test("★ timeout → 发 1 条，文案含「已超时」", async () => {
    const sent: SentNotice[] = [];
    const handler = makeHandler({
      sent,
      resolveStatusNotifications: () => true,
    });
    handler.handleEvent(
      bgEvent("task.background.timeout", {
        status: "timeout",
        error: "Task execution timeout after 18000000ms",
      }),
    );
    await waitFor(() => sent.length > 0);
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("⏱️");
    expect(sent[0].text).toContain("已超时");
  });

  test("★ I4：true 只恢复文本，completed 仍继续 enqueue（卡片+文本+agent 三者并存）", async () => {
    const sent: SentNotice[] = [];
    const runs: string[] = [];
    const handler = makeHandler({
      sent,
      resolveStatusNotifications: () => true,
      onEventWithEnv: async (f: any) => {
        runs.push(f.message);
      },
    });
    handler.handleEvent(
      bgEvent("task.background.completed", { status: "completed", executionTimeMs: 1000 }),
    );
    await waitFor(() => sent.length > 0 && runs.length > 0);
    expect(sent).toHaveLength(1);
    expect(runs.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// 3. 强制覆盖 card / text
// ============================================================================

describe("强制覆盖（测试 / 应急回滚用）", () => {
  test("★ card：配置 true 也静默（覆盖优先级更高）", async () => {
    const sent: SentNotice[] = [];
    const handler = makeHandler({
      sent,
      delivery: "card",
      resolveStatusNotifications: () => true,
    });
    handler.handleEvent(bgEvent("task.background.progress"));
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toHaveLength(0);
  });

  test("★ text：配置 false 也发文本", async () => {
    const sent: SentNotice[] = [];
    const handler = makeHandler({
      sent,
      delivery: "text",
      resolveStatusNotifications: () => false,
    });
    handler.handleEvent(bgEvent("task.background.progress"));
    await waitFor(() => sent.length > 0);
    expect(sent).toHaveLength(1);
  });
});

// ============================================================================
// 4. I1：CLI 本地（stdout）永远发文本 —— 最高优先级
// ============================================================================

describe("★ I1：sink === stdout 永远发文本", () => {
  test("card 强制静默 + stdout → 仍发文本（本地没有卡片可看）", async () => {
    const sent: SentNotice[] = [];
    const handler = makeHandler({ sent, delivery: "card" });
    handler.handleEvent(
      bgEvent(
        "task.background.progress",
        {},
        {
          replyChannel: {
            type: "lark-cli",
            chatId: "cli:sess-123",
            messageId: "om_x",
            profile: "tongzhuli",
            // ★ sink 来自 `params.sink`（Task #4568），不是 chatId 前缀推断 ——
            //   见 targetFromEventMetadata 的注释：params 能完好穿过
            //   _captureReplyChannelSnapshot → event.metadata.replyChannel.params
            params: { sink: "stdout" },
          },
        },
      ),
    );
    await waitFor(() => sent.length > 0);
    expect(sent).toHaveLength(1);
    expect(sent[0].sink).toBe("stdout");
  });
});

// ============================================================================
// 5. 解析器异常 / 未注入 → 安全侧（静默，不抛）
// ============================================================================

describe("解析器异常与未注入", () => {
  test("★ 未注入 resolveStatusNotifications → auto 解析为 false（静默）", async () => {
    const sent: SentNotice[] = [];
    const handler = makeHandler({ sent }); // 不传解析器
    handler.handleEvent(bgEvent("task.background.progress"));
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toHaveLength(0);
  });

  test("★ 解析器抛异常 → 静默（不污染事件循环）", async () => {
    const sent: SentNotice[] = [];
    const runs: string[] = [];
    const handler = makeHandler({
      sent,
      resolveStatusNotifications: () => {
        throw new Error("config read failed");
      },
      onEventWithEnv: async (f: any) => {
        runs.push(f.message);
      },
    });
    handler.handleEvent(bgEvent("task.background.progress"));
    await new Promise((r) => setTimeout(r, 100));
    expect(sent).toHaveLength(0);
    expect(runs).toHaveLength(0); // 心跳仍不进 lane
  });

  test("★ 解析器返回非布尔 true 值（1 / \"true\"）→ 视为 false", async () => {
    const sent: SentNotice[] = [];
    const handler = makeHandler({
      sent,
      // 故意返回非严格布尔（模拟实现方疏忽）
      resolveStatusNotifications: () => 1 as unknown as boolean,
    });
    handler.handleEvent(bgEvent("task.background.progress"));
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toHaveLength(0);
  });
});