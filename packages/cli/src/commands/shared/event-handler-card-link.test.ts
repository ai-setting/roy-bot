/**
 * @fileoverview Task #5036 — 终态回执里嵌入「跳到任务卡片」链接（EventHandler 集成）
 *
 * 用户诉求：`✅ Task #4954「…」已完成（耗时 1h5m）` 这类回执看不出对应哪张卡，
 * 得点进 pin 列表翻找。改进：回执正文附可点击链接，直达卡片消息。
 *
 * 本文件锁定接线契约（纯逻辑在 `card-message-link.test.ts` / `terminal-notice.test.ts`）：
 *   1. 注入 `resolveCardUrl` 且该 Task 有卡片 → 回执正文含该 URL
 *   2. 注入但解析不出（`undefined`）→ 回执正文**不含**链接（零痕迹降级）
 *   3. **不注入**（既有调用方）→ 行为与改动前逐字一致
 *   4. 解析抛异常 → 回执照常发出（只丢链接，不丢消息）
 *   5. `taskId` 从 payload.associatedTaskId 取；无 taskId → 不解析
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EventStoreImpl } from "@ai-setting/roy-bot-core/env/event-source/event-store";
import { larkCliHandler } from "@ai-setting/roy-bot-core/env/event-source/event-source-handlers";

import { EventHandler } from "./event-handler";
import { EventMessageFormatter } from "./event-message-formatter";

const CHAT = "oc_0c4501033c8200beb51ac65d2c308ad3";
const PROFILE = "tongzhuli";
const CARD_URL = `https://applink.feishu.cn/client/chat/open?openChatId=${CHAT}&position=127`;

let tmpDir: string;
let store: EventStoreImpl;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "card-link-notice-test-"));
  store = new EventStoreImpl({ dbPath: join(tmpDir, "events.db") });
});

afterEach(() => {
  store.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

interface SentNotice {
  chatId: string;
  profile?: string;
  text: string;
  idempotencyKey?: string;
}

async function waitFor(fn: () => boolean, timeout = 4000, interval = 5): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));
  }
  if (!fn()) throw new Error(`waitFor timed out after ${timeout}ms`);
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

async function seedTrigger(): Promise<string> {
  return larkCliHandler.emitTriggerEvent(
    {
      senderId: "ou_1759934f98e0677e17f09591389c24f1",
      text: "实施 P1 布局+状态栏",
      metadata: {
        eventType: "im.message.receive_v1",
        appId: "cli_aXXXXXXXXXXXXXX",
        chatId: CHAT,
        chatType: "group",
        messageId: "om_x100b61303080ecb8b0e218b6241b1ef",
        messageType: "text",
        senderId: "ou_1759934f98e0677e17f09591389c24f1",
        tenantKey: "19de90477f80db86",
        profile: PROFILE,
      },
    },
    store,
  );
}

function makeCompletedEvent(opts: {
  triggerEventId?: string;
  associatedTaskId?: number;
}): any {
  return {
    id: "evt-completed",
    type: "task.background.completed",
    timestamp: Date.now(),
    metadata: {
      source: "task.background",
      trigger_session_id: "parent-1",
      ...(opts.triggerEventId ? { triggerEventId: opts.triggerEventId } : {}),
      replyChannel: {
        type: "lark-cli",
        chatId: CHAT,
        messageId: "om_x100b61303080ecb8b0e218b6241b1ef",
        profile: PROFILE,
      },
    },
    payload: {
      backgroundTaskId: "process_1793077167757_5rngpu1th",
      subSessionId: "session_sub_4954",
      parentSessionId: "parent-1",
      status: "completed",
      description: "实施 P1 布局+状态栏",
      ...(opts.associatedTaskId !== undefined
        ? { associatedTaskId: opts.associatedTaskId }
        : {}),
      executionTimeMs: 65 * 60 * 1000,
    },
  };
}

function startHandler(opts: {
  sent: SentNotice[];
  resolveCardUrl?: (taskId: number) => Promise<string | undefined>;
  onEventWithEnv?: (f: any) => Promise<void>;
}) {
  const handler = new EventHandler({
    env: { subscribeAll: () => () => {}, getComponent: () => undefined } as any,
    eventTypes: ["task.background.*"],
    formatter: new EventMessageFormatter({ prefix: "[通知]" }),
    onEvent: async () => {},
    onEventWithEnv: opts.onEventWithEnv ?? (async () => {}),
    sessionComponent: makeSessionComponent() as any,
    eventStore: store,
    getHandlerForEsType: (esType: string) =>
      esType === "lark-cli" ? larkCliHandler : undefined,
    telemetrySender: async (notice: SentNotice) => {
      opts.sent.push(notice);
    },
    ...(opts.resolveCardUrl ? { resolveCardUrl: opts.resolveCardUrl } : {}),
    // ★ Task #5360：本文件锁定的是**终态回执文本**（文案 / 卡片链接 / 硬预算 /
    //   best-effort），不是"要不要发"。卡片化改造把默认模式改成 `"auto"`
    //   （按 ES 配置 statusNotifications，缺省 false ⇒ 静默走卡片），
    //   所以显式钉 `"text"` 让这些机制断言继续测它们该测的东西。
    //   "默认 auto + 配置 false 时静默" 由 telemetry-notice-card-mode-5360.test.ts 覆盖。
    noticeTextDelivery: "text",
  } as any);

  const { env, emit } = makeSubscribableEnv();
  (handler as any).env = env;
  handler.start();
  return { handler, emit };
}

// ============================================================================
// 1. 有卡片 → 回执带链接
// ============================================================================

describe("终态回执 — 嵌入卡片链接", () => {
  test("★ 注入 resolveCardUrl 返回 URL → 回执正文含该链接（可点击 Markdown）", async () => {
    const triggerEventId = await seedTrigger();
    const sent: SentNotice[] = [];
    const resolveCardUrl = vi.fn(async () => CARD_URL);

    const { emit } = startHandler({ sent, resolveCardUrl });
    emit(makeCompletedEvent({ triggerEventId, associatedTaskId: 4954 }));

    await waitFor(() => sent.length === 1);

    expect(resolveCardUrl).toHaveBeenCalledWith(4954);
    expect(sent[0].text).toContain(`[📌 查看任务卡片](${CARD_URL})`);
    // 标题与帮助句都在（链接是插入不是替换）
    expect(sent[0].text).toContain("✅ Task #4954「实施 P1 布局+状态栏」已完成");
    expect(sent[0].text).toContain("助手随后补充交付摘要");
  });

  test("★ 解析不出 URL（undefined）→ 回执照发但不含链接", async () => {
    const triggerEventId = await seedTrigger();
    const sent: SentNotice[] = [];

    const { emit } = startHandler({
      sent,
      resolveCardUrl: async () => undefined,
    });
    emit(makeCompletedEvent({ triggerEventId, associatedTaskId: 4954 }));

    await waitFor(() => sent.length === 1);

    expect(sent[0].text).toContain("已完成");
    expect(sent[0].text).not.toContain("查看任务卡片");
    expect(sent[0].text).not.toContain("applink");
  });

  test("★ 解析抛异常 → 回执照常送达（只丢链接，不丢消息）", async () => {
    const triggerEventId = await seedTrigger();
    const sent: SentNotice[] = [];

    const { emit } = startHandler({
      sent,
      resolveCardUrl: async () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    });
    emit(makeCompletedEvent({ triggerEventId, associatedTaskId: 4954 }));

    await waitFor(() => sent.length === 1);

    expect(sent[0].text).toContain("已完成");
    expect(sent[0].text).not.toContain("查看任务卡片");
  });

  test("无 associatedTaskId → 不调用解析器，回执不含链接", async () => {
    const triggerEventId = await seedTrigger();
    const sent: SentNotice[] = [];
    const resolveCardUrl = vi.fn(async () => CARD_URL);

    const { emit } = startHandler({ sent, resolveCardUrl });
    emit(makeCompletedEvent({ triggerEventId })); // 不带 associatedTaskId

    await waitFor(() => sent.length === 1);

    expect(resolveCardUrl).not.toHaveBeenCalled();
    expect(sent[0].text).not.toContain("查看任务卡片");
  });
});

// ============================================================================
// 2. 不注入 → 完全向后兼容
// ============================================================================

describe("终态回执 — 向后兼容（未注入 resolveCardUrl）", () => {
  test("★ 既有调用方不注入 → 文案与改动前逐字一致", async () => {
    const triggerEventId = await seedTrigger();
    const sent: SentNotice[] = [];

    const { emit } = startHandler({ sent });
    emit(makeCompletedEvent({ triggerEventId, associatedTaskId: 4954 }));

    await waitFor(() => sent.length === 1);

    expect(sent[0].text).toBe(
      "✅ Task #4954「实施 P1 布局+状态栏」已完成（耗时 1h5m）\n助手随后补充交付摘要。",
    );
  });
});

// ============================================================================
// DS review M2：链接解析不得拖慢回执送达
// ============================================================================

describe("终态回执 — 链接解析硬预算（DS review M2）", () => {
  test("★ 解析器 hang 住 10s → 回执仍在 ~1.5s 预算内送达（不附链接）", async () => {
    const triggerEventId = await seedTrigger();
    const sent: SentNotice[] = [];
    const t0 = Date.now();

    const { emit } = startHandler({
      sent,
      // 永不 resolve —— 模拟 lark-cli 卡死
      resolveCardUrl: () => new Promise<string | undefined>(() => {}),
    });
    emit(makeCompletedEvent({ triggerEventId, associatedTaskId: 4954 }));

    await waitFor(() => sent.length === 1, 6000);

    const elapsed = Date.now() - t0;
    // 必须显著小于 hang 时长（10s）与「3.5s lookup + 5s sender」之和
    expect(elapsed).toBeLessThan(3000);
    // 回执正文仍完整（只是少了链接）
    expect(sent[0].text).toContain("✅ Task #4954「实施 P1 布局+状态栏」已完成");
    expect(sent[0].text).toContain("助手随后补充交付摘要");
    expect(sent[0].text).not.toContain("查看任务卡片");
  }, 15000);

  test("★ 解析很快（正常路径）→ 链接照样附上", async () => {
    const triggerEventId = await seedTrigger();
    const sent: SentNotice[] = [];
    const URL = "https://applink.feishu.cn/client/chat/open?openChatId=oc_x&position=7";

    const { emit } = startHandler({ sent, resolveCardUrl: async () => URL });
    emit(makeCompletedEvent({ triggerEventId, associatedTaskId: 4954 }));

    await waitFor(() => sent.length === 1);
    expect(sent[0].text).toContain(`[📌 查看任务卡片](${URL})`);
  });
});
