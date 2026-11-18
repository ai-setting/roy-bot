/**
 * @fileoverview Task #5080 — 终态回执链路在「慢 resolver」下的**行为**护栏
 *
 * ## 这个文件测什么（以及不测什么）
 *
 * 本文件锁定的是**回执本身不丢**这条契约：`resolveCardUrl` 慢 / 卡死 /
 * 抛异常时，回执正文仍然完整送达（`✅ Task #N「…」已完成` + 交付摘要句）。
 *
 * ⚠️ **本文件不覆盖「链接还在不在」** —— 因为在这一层，resolver 是被
 *   **注入的假实现**，它返回什么完全由测试决定，测不出真实解析器的行为。
 *   「链接会不会丢」由另外两个文件覆盖：
 *   - `card-link-progressive.test.ts` —— 真实解析器层（有上界的位置查询）
 *   - `notice-real-resolver-e2e.test.ts` —— 真实解析器 + 真实 EventHandler
 *
 * ## 为什么还需要这个文件
 *
 * `event-handler.ts` 的 `resolveRuleNoticeCardUrlWithBudget()` 与 2500ms 预算
 * 赛跑。若预算机制本身坏了（例如不再 resolve），回执可能**整条卡住**或
 * **丢失**。这里守住「回执必须送达」这条底线。
 *
 * ## 被测的真实链路
 *
 *   `EventHandler.sendRuleNotice()`
 *     → `resolveRuleNoticeCardUrlWithBudget()`（2500ms 预算赛跑）
 *       → `resolveCardUrl(taskId)`（注入；这里模拟慢 / 卡死）
 *     → `buildTerminalNoticeText(..., { cardUrl })`
 *     → `telemetrySender({ text })`
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

let tmpDir: string;
let store: EventStoreImpl;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "notice-card-link-e2e-"));
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

function makeSessionComponent() {
  return {
    create: vi.fn().mockResolvedValue({ id: "sess-created", title: "t" }),
    get: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    getActiveSessionId: vi.fn().mockReturnValue(undefined),
    setActiveSession: vi.fn().mockResolvedValue(true),
  };
}

/** 生产形态的 5077 完成事件（含 associatedTaskId —— 实测 payload 里是有的） */
function makeCompletedEvent(associatedTaskId: number): any {
  return {
    id: "evt-completed-5080",
    type: "task.background.completed",
    timestamp: Date.now(),
    metadata: {
      source: "task.background",
      trigger_session_id: CHAT,
      replyChannel: {
        type: "lark-cli",
        chatId: CHAT,
        messageId: "om_x100b61303080ecb8b0e218b6241b1ef",
        profile: PROFILE,
      },
    },
    payload: {
      backgroundTaskId: "process_1793934948642_1wgujbhjl",
      subSessionId: "session_bc11204c-bd52-400d-afd6-11bb680e2703",
      parentSessionId: CHAT,
      status: "completed",
      description: "P3 Phase 2 滚动条键位",
      associatedTaskId,
      executionTimeMs: 1967161,
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

function startHandler(opts: {
  sent: SentNotice[];
  resolveCardUrl?: (taskId: number) => Promise<string | undefined>;
}) {
  const handler = new EventHandler({
    env: { subscribeAll: () => () => {}, getComponent: () => undefined } as any,
    eventTypes: ["task.background.*"],
    formatter: new EventMessageFormatter({ prefix: "[通知]" }),
    onEvent: async () => {},
    onEventWithEnv: async () => {},
    sessionComponent: makeSessionComponent() as any,
    eventStore: store,
    getHandlerForEsType: (esType: string) =>
      esType === "lark-cli" ? larkCliHandler : undefined,
    telemetrySender: async (notice: SentNotice) => {
      opts.sent.push(notice);
    },
    ...(opts.resolveCardUrl ? { resolveCardUrl: opts.resolveCardUrl } : {}),
    // ★ Task #5360：本文件锁定的是**文本直发/回执**的机制（文案 / 链接 /
    //   硬预算 / best-effort），不是"要不要发"。卡片化改造把默认模式改成
    //   `"auto"`（按 ES 配置 statusNotifications，缺省 false ⇒ 静默走卡片），
    //   所以显式钉 `"text"` 让这些机制断言继续测它们该测的东西。
    //   "默认 auto + 配置 false 时静默" 由 telemetry-notice-card-mode-5360.test.ts 覆盖。
    noticeTextDelivery: "text",
  } as any);

  let dispatch: ((e: any) => void) | null = null;
  (handler as any).env = {
    subscribeAll: (h: (e: any) => void) => {
      dispatch = h;
      return () => {
        dispatch = null;
      };
    },
    getComponent: () => undefined,
  };
  handler.start();
  return {
    emit: (e: any) => {
      if (!dispatch) throw new Error("not subscribed");
      dispatch(e);
    },
  };
}

// ============================================================================
// 核心回归：慢 resolver ⇒ 回执**仍必须带链接**
// ============================================================================

describe("终态回执 — resolver 慢时仍必须带链接（#5080）", () => {
  test("★ resolver 永不返回 ⇒ 回执仍照常发出（不丢消息）", async () => {
    const sent: SentNotice[] = [];
    // 模拟 lark-cli spawn 卡死（永不 resolve）
    const resolveCardUrl = vi.fn(
      () => new Promise<string | undefined>(() => {}),
    );

    const { emit } = startHandler({ sent, resolveCardUrl });
    emit(makeCompletedEvent(5077));

    await waitFor(() => sent.length > 0);

    expect(sent.length).toBe(1);
    const text = sent[0].text;

    // 正文形态与生产观测一致
    expect(text).toContain("✅ Task #5077");
    expect(text).toContain("已完成");
  }, 15000);

  test("★ resolver 慢（超外层 2500ms 预算）⇒ 回执仍照常发出", async () => {
    const sent: SentNotice[] = [];
    const resolveCardUrl = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 4000));
      return "https://applink.feishu.cn/client/chat/open?openChatId=x&position=1";
    });

    const { emit } = startHandler({ sent, resolveCardUrl });
    emit(makeCompletedEvent(5077));

    await waitFor(() => sent.length > 0);

    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain("✅ Task #5077");
  }, 15000);

  test("★ resolver 抛异常 ⇒ 回执仍照常发出（只丢链接，不丢消息）", async () => {
    const sent: SentNotice[] = [];
    const resolveCardUrl = vi.fn(async () => {
      throw new Error("boom");
    });

    const { emit } = startHandler({ sent, resolveCardUrl });
    emit(makeCompletedEvent(5077));

    await waitFor(() => sent.length > 0);

    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain("✅ Task #5077");
  }, 15000);
});
