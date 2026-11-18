/**
 * @fileoverview 终态规则回执（completed / timeout）—— EventHandler 集成测试
 *
 * 用户 2026-10-27 明确要求：
 *   「progress 通知完就 return 不进 agent；timeout / complete 通知完还要走 agent；
 *    同时把 eventsource 渠道、trigger chatId、以及「用 lark-cli 发回复」的提示
 *    附加到 notify event 的 format prompt 里。」
 *
 * 本文件锁定：
 *   1. timeout / completed → **直发 1 条回执 + 仍然触发 agent**
 *   2. 回执失败 / 无 chatId → agent 照常跑，且 prompt **如实**告诉 agent 没送达
 *   3. failed / stopped → 不直发（只走 agent）
 *   4. notify prompt 必带：渠道名、chatId、触发 messageId、lark-cli 命令、只发增量的要求
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStoreImpl } from "@ai-setting/roy-bot-core/env/event-source/event-store";
import { larkCliHandler } from "@ai-setting/roy-bot-core/env/event-source/event-source-handlers";

import { EventHandler } from "./event-handler";
import { EventMessageFormatter } from "./event-message-formatter";

const CHAT = "oc_8904d6f184e31b6cc51ba53a0a19aa2f";
const PROFILE = "tongzhuli";
const MSG = "om_x100b61303080ecb8b0e218b6241b1ef";

let tmpDir: string;
let store: EventStoreImpl;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "rule-notice-test-"));
  store = new EventStoreImpl({ dbPath: join(tmpDir, "events.db") });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// Helpers
// ============================================================================

interface SentNotice {
  chatId: string;
  profile?: string;
  text: string;
  idempotencyKey?: string;
}

function makeSessionComponent() {
  return {
    create: vi.fn().mockResolvedValue({ id: "sess-created", title: "t" }),
    get: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    getActiveSessionId: vi.fn().mockReturnValue(undefined),
    setActiveSession: vi.fn().mockResolvedValue(true),
  };
}

function makeSubscribableEnv() {
  let dispatch: ((e: any) => void) | null = null;
  return {
    env: {
      subscribeAll: (h: (e: any) => void) => {
        dispatch = h;
        return () => {
          dispatch = null;
        };
      },
      getComponent: () => undefined,
    } as any,
    emit: (e: any) => {
      if (!dispatch) throw new Error("not subscribed yet");
      dispatch(e);
    },
  };
}

async function waitFor(fn: () => boolean, timeout = 4000, interval = 5): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));
  }
  if (!fn()) throw new Error(`waitFor timed out after ${timeout}ms`);
}

/** 落一个真实的 lark-cli trigger event（chatId/chatType/messageId/profile 都有） */
async function seedTrigger(over: Record<string, unknown> = {}): Promise<string> {
  return larkCliHandler.emitTriggerEvent(
    {
      senderId: "ou_1759934f98e0677e17f09591389c24f1",
      text: "修 50GB traces.db 性能问题",
      metadata: {
        eventType: "im.message.receive_v1",
        appId: "cli_aXXXXXXXXXXXXXX",
        chatId: CHAT,
        chatType: "group",
        messageId: MSG,
        messageType: "text",
        senderId: "ou_1759934f98e0677e17f09591389c24f1",
        tenantKey: "19de90477f80db86",
        profile: PROFILE,
        ...over,
      },
    },
    store,
  );
}

function makeNotifyEvent(opts: {
  type: string;
  triggerEventId?: string;
  /** false = 不带 replyChannel 快照（模拟老 delegate 路径） */
  withReplyChannel?: boolean;
  payload?: Record<string, unknown>;
}): any {
  const { type } = opts;
  return {
    id: `evt-${type}`,
    type,
    timestamp: Date.now(),
    metadata: {
      source: "task.background",
      trigger_session_id: "parent-1",
      ...(opts.triggerEventId ? { triggerEventId: opts.triggerEventId } : {}),
      ...(opts.withReplyChannel === false
        ? {}
        : {
            replyChannel: {
              type: "lark-cli",
              chatId: CHAT,
              messageId: MSG,
              profile: PROFILE,
            },
          }),
    },
    payload: {
      backgroundTaskId: "process_1793077167757_5rngpu1th",
      subSessionId: "session_sub_4561",
      parentSessionId: "parent-1",
      status: type.replace("task.background.", ""),
      description: "修 50GB traces.db 性能问题",
      associatedTaskId: 4561,
      executionTimeMs: 2 * 3600 * 1000,
      error: "Task execution timeout after 7200000ms",
      ...opts.payload,
    },
  };
}

function startHandler(opts: {
  sent: SentNotice[];
  onEventWithEnv: (f: any) => Promise<void>;
  senderThrows?: boolean;
}) {
  const handler = new EventHandler({
    env: { subscribeAll: () => () => {}, getComponent: () => undefined } as any,
    eventTypes: ["task.background.*"],
    formatter: new EventMessageFormatter({ prefix: "[通知]" }),
    onEvent: async () => {},
    onEventWithEnv: opts.onEventWithEnv,
    sessionComponent: makeSessionComponent() as any,
    eventStore: store,
    getHandlerForEsType: (esType: string) =>
      esType === "lark-cli" ? larkCliHandler : undefined,
    // ★ Task #5360：本文件锁定的是**文本直发/回执**的机制（文案 / 链接 /
    //   硬预算 / best-effort），不是"要不要发"。卡片化改造把默认模式改成
    //   `"auto"`（按 ES 配置 statusNotifications，缺省 false ⇒ 静默走卡片），
    //   所以显式钉 `"text"` 让这些机制断言继续测它们该测的东西。
    //   "默认 auto + 配置 false 时静默" 由 telemetry-notice-card-mode-5360.test.ts 覆盖。
    noticeTextDelivery: "text",
    telemetrySender: async (notice: SentNotice) => {
      if (opts.senderThrows) throw new Error("lark-cli exited with code 1");
      opts.sent.push(notice);
    },
  } as any);

  const { env, emit } = makeSubscribableEnv();
  (handler as any).env = env;
  handler.start();
  return { handler, emit };
}

// ============================================================================
// 1. timeout / completed：直发 + 仍走 agent
// ============================================================================

describe("终态回执 — timeout / completed 双通道", () => {
  test("timeout：直发 1 条回执 + 仍触发 agent，prompt 带渠道/chatId/lark-cli 指令", async () => {
    const triggerEventId = await seedTrigger();
    const sent: SentNotice[] = [];
    const captured: any[] = [];
    const onEventWithEnv = vi.fn(async (f: any) => {
      captured.push(f);
    });

    const { handler, emit } = startHandler({ sent, onEventWithEnv });
    emit(makeNotifyEvent({ type: "task.background.timeout", triggerEventId }));

    await waitFor(() => sent.length === 1 && captured.length === 1);

    // ① 回执：只报事实，不放子任务正文
    expect(sent[0].chatId).toBe(CHAT);
    expect(sent[0].profile).toBe(PROFILE);
    expect(sent[0].text).toContain("⏱️ Task #4561");
    expect(sent[0].text).toContain("已超时");
    expect(sent[0].idempotencyKey).toBeTruthy();

    // ② agent 照常被触发
    expect(onEventWithEnv).toHaveBeenCalledTimes(1);

    // ③ prompt 必须带「渠道 + trigger chatId + 用 lark-cli 回复 + 只发增量」
    const msg: string = captured[0].message;
    expect(msg).toContain("Notify Event: task.background.timeout");
    expect(msg).toContain("触发渠道（EventSource）");
    expect(msg).toContain("ES: lark-cli");
    expect(msg).toContain("群聊");
    expect(msg).toContain(CHAT);
    expect(msg).toContain(MSG);
    expect(msg).toContain(PROFILE);
    expect(msg).toContain("im +messages-reply");
    expect(msg).toContain("--as bot");
    expect(msg).toContain("只发增量");
    // 子 session 可用于续跑
    expect(msg).toContain("session_sub_4561");

    handler.stop();
  });

  test("completed：直发 1 条回执（不含 result 正文）+ 仍触发 agent", async () => {
    const triggerEventId = await seedTrigger();
    const sent: SentNotice[] = [];
    const captured: any[] = [];
    const onEventWithEnv = vi.fn(async (f: any) => {
      captured.push(f);
    });

    const { handler, emit } = startHandler({ sent, onEventWithEnv });
    emit(
      makeNotifyEvent({
        type: "task.background.completed",
        triggerEventId,
        payload: {
          result: "这是一份很长的交付报告".repeat(200),
          executionTimeMs: 3 * 3600 * 1000,
        },
      }),
    );

    await waitFor(() => sent.length === 1 && captured.length === 1);

    expect(sent[0].text).toContain("✅ Task #4561");
    expect(sent[0].text).toContain("已完成");
    expect(sent[0].text).not.toContain("这是一份很长的交付报告");

    expect(captured[0].message).toContain("只发增量");

    handler.stop();
  });
});

// ============================================================================
// 2. 回执失败 / 无目标：agent 仍跑，prompt 如实说「未送达」
// ============================================================================

describe("终态回执 — 失败不影响 agent，且 prompt 说真话", () => {
  test("sender 抛错 → 回执未送达，agent 照常跑，prompt 要求 agent 讲清楚", async () => {
    const triggerEventId = await seedTrigger();
    const sent: SentNotice[] = [];
    const captured: any[] = [];
    const onEventWithEnv = vi.fn(async (f: any) => {
      captured.push(f);
    });

    const { handler, emit } = startHandler({ sent, onEventWithEnv, senderThrows: true });
    emit(makeNotifyEvent({ type: "task.background.timeout", triggerEventId }));

    await waitFor(() => captured.length === 1);

    expect(sent.length).toBe(0);
    expect(onEventWithEnv).toHaveBeenCalledTimes(1);

    const msg: string = captured[0].message;
    expect(msg).toContain("回执未送达");
    expect(msg).toContain("lark-cli exited with code 1");
    // 未送达时**不能**说「只发增量」——否则 agent 会漏掉「超时」这个事实
    expect(msg).not.toContain("只发增量");

    handler.stop();
  });

  test("无 chatId（trigger 没落 chatId、notify 也没 replyChannel）→ 不发，但 agent 仍跑", async () => {
    const triggerEventId = await larkCliHandler.emitTriggerEvent(
      {
        senderId: "ou_x",
        text: "x",
        metadata: { eventType: "x", senderId: "ou_x" },
      },
      store,
    );
    const sent: SentNotice[] = [];
    const captured: any[] = [];
    const onEventWithEnv = vi.fn(async (f: any) => {
      captured.push(f);
    });

    const { handler, emit } = startHandler({ sent, onEventWithEnv });
    emit(
      makeNotifyEvent({
        type: "task.background.timeout",
        triggerEventId,
        withReplyChannel: false,
      }),
    );

    await waitFor(() => captured.length === 1);

    expect(sent.length).toBe(0);
    expect(captured[0].message).toContain("回执未送达");
    expect(captured[0].message).toContain("no-target");

    handler.stop();
  });
});

// ============================================================================
// 3. failed / stopped 不进回执白名单
// ============================================================================

describe("终态回执 — 白名单边界", () => {
  for (const type of ["task.background.failed", "task.background.stopped"]) {
    test(`${type} → 不直发（只走 agent），prompt 明说不直发回执`, async () => {
      const triggerEventId = await seedTrigger();
      const sent: SentNotice[] = [];
      const captured: any[] = [];
      const onEventWithEnv = vi.fn(async (f: any) => {
        captured.push(f);
      });

      const { handler, emit } = startHandler({ sent, onEventWithEnv });
      emit(makeNotifyEvent({ type, triggerEventId }));

      await waitFor(() => captured.length === 1);

      expect(sent.length).toBe(0);
      expect(onEventWithEnv).toHaveBeenCalledTimes(1);
      expect(captured[0].message).toContain("不直发规则回执");

      handler.stop();
    });
  }
});
