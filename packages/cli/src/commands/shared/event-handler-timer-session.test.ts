/**
 * EventHandler —— timer 独立 session 路由测试（Task #4815）
 *
 * 核心语义：
 * 1. trigger_session_id 指向**已存在**的 session → 复用它（优2 路径，既有行为）
 * 2. trigger_session_id 指向**不存在**的 session，且事件声明了
 *    `createSessionIfMissing` 标记 → **按该 ID 创建** session（不 fallback 主会话）
 * 3. 未声明标记 → 保持既有 fallback 行为（优3 主会话）
 * 4. 创建出的 session 被缓存到 trigger 维度 → 后续同 trigger 事件复用
 */

import { describe, test, expect, vi } from "bun:test";
import { EventHandler } from "./event-handler";
import type { EventHandlerOptions } from "./event-handler";
import { EventMessageFormatter, type FormattedEvent } from "./event-message-formatter";

const formatter = new EventMessageFormatter({ prefix: "[测试]" });

async function waitFor(fn: () => boolean, timeout = 3000, interval = 5): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));
  }
  if (!fn()) throw new Error(`waitFor timed out after ${timeout}ms`);
}

/** timer 事件：带 trigger_session_id + createSessionIfMissing */
function timerEvent(
  triggerSessionId: string,
  createIfMissing: boolean,
  tag = "e",
) {
  return {
    type: "event-source.event.timer",
    payload: { tag },
    metadata: {
      sourceId: "daily-summary",
      trigger_session_id: triggerSessionId,
      ...(createIfMissing ? { createSessionIfMissing: true } : {}),
    },
  };
}

function makeSessionComponent(options: { existing?: string[] } = {}) {
  const existing = new Set(options.existing ?? ["main-session"]);
  const created: string[] = [];
  return {
    created,
    component: {
      create: vi.fn().mockImplementation(async (opts: any) => {
        const id = opts?.id ?? `gen-${Math.random().toString(36).slice(2, 8)}`;
        created.push(id);
        existing.add(id);
        return { id, title: opts?.title ?? "Event Session" };
      }),
      get: vi.fn().mockImplementation(async (id: string) =>
        existing.has(id) ? { id, title: "Existing" } : undefined,
      ),
      list: vi.fn().mockResolvedValue([]),
      getActiveSessionId: vi.fn().mockReturnValue("main-session"),
      setActiveSession: vi.fn().mockResolvedValue(true),
    },
  };
}

function createOptions(
  sessionComponent: unknown,
  onEventWithEnv: any,
): EventHandlerOptions {
  return {
    env: { subscribeAll: vi.fn().mockReturnValue(() => {}) } as any,
    eventTypes: ["event-source.event.*", "task.background.*"],
    formatter,
    isIdle: () => true,
    onEvent: vi.fn().mockResolvedValue(undefined),
    onEventWithEnv,
    sessionComponent: sessionComponent as any,
  };
}

describe("EventHandler — timer 独立 session 路由 (Task #4815)", () => {
  test("trigger_session_id 指向已存在 session 时应复用它", async () => {
    const sc = makeSessionComponent({ existing: ["my-daily-session"] });
    const seen: (string | undefined)[] = [];
    const handler = new EventHandler(
      createOptions(sc.component, async (fe: FormattedEvent) => {
        seen.push(fe.eventSessionId);
      }),
    );
    handler.start();

    handler.enqueue(formatter.formatWithEvent(timerEvent("my-daily-session", false) as any));
    await waitFor(() => seen.length > 0);

    expect(seen[0]).toBe("my-daily-session");
    expect(sc.component.create).not.toHaveBeenCalled();

    handler.stop();
  });

  test("createSessionIfMissing=true 且 session 不存在时应按该 ID 创建", async () => {
    const sc = makeSessionComponent();
    const seen: (string | undefined)[] = [];
    const handler = new EventHandler(
      createOptions(sc.component, async (fe: FormattedEvent) => {
        seen.push(fe.eventSessionId);
      }),
    );
    handler.start();

    handler.enqueue(formatter.formatWithEvent(timerEvent("brand-new-session", true) as any));
    await waitFor(() => seen.length > 0);

    // 应使用指定 ID 创建
    expect(sc.component.create).toHaveBeenCalledTimes(1);
    expect(sc.component.create.mock.calls[0][0]).toMatchObject({ id: "brand-new-session" });
    // 事件应路由到该 session（而非主会话）
    expect(seen[0]).toBe("brand-new-session");

    handler.stop();
  });

  test("createSessionIfMissing=true 时不应 fallback 到主会话", async () => {
    const sc = makeSessionComponent();
    // 主会话存在
    sc.component.getActiveSessionId.mockReturnValue("main-session");
    const seen: (string | undefined)[] = [];
    const handler = new EventHandler(
      createOptions(sc.component, async (fe: FormattedEvent) => {
        seen.push(fe.eventSessionId);
      }),
    );
    handler.start();

    handler.enqueue(formatter.formatWithEvent(timerEvent("new-session-x", true) as any));
    await waitFor(() => seen.length > 0);

    expect(seen[0]).not.toBe("main-session");
    expect(seen[0]).toBe("new-session-x");

    handler.stop();
  });

  test("未声明 createSessionIfMissing 时应保持既有 fallback 行为（主会话）", async () => {
    const sc = makeSessionComponent();
    const seen: (string | undefined)[] = [];
    const handler = new EventHandler(
      createOptions(sc.component, async (fe: FormattedEvent) => {
        seen.push(fe.eventSessionId);
      }),
    );
    handler.start();

    handler.enqueue(formatter.formatWithEvent(timerEvent("missing-session", false) as any));
    await waitFor(() => seen.length > 0);

    // 既有行为：找不到 → fallback 主会话
    expect(seen[0]).toBe("main-session");
    expect(sc.component.create).not.toHaveBeenCalled();

    handler.stop();
  });

  test("创建出的 session 应被缓存（后续同 trigger 事件不再重复创建）", async () => {
    const sc = makeSessionComponent();
    const seen: (string | undefined)[] = [];
    const handler = new EventHandler(
      createOptions(sc.component, async (fe: FormattedEvent) => {
        seen.push(fe.eventSessionId);
      }),
    );
    handler.start();

    handler.enqueue(formatter.formatWithEvent(timerEvent("cached-session", true, "e1") as any));
    await waitFor(() => seen.length >= 1);

    handler.enqueue(formatter.formatWithEvent(timerEvent("cached-session", true, "e2") as any));
    await waitFor(() => seen.length >= 2);

    expect(sc.component.create).toHaveBeenCalledTimes(1);
    expect(seen[1]).toBe("cached-session");

    handler.stop();
  });

  test("独立 session 模式不应污染 REPL 主会话的 active 指针", async () => {
    // ★ 真机验证发现的回归点：优 2 的 existing 分支会调 setActiveSession，
    //   导致「每日总结」的独立 session 抢走 REPL 主会话的 active 指针。
    const sc = makeSessionComponent();
    const handler = new EventHandler(
      createOptions(sc.component, async () => {}),
    );
    handler.start();

    // 第一次：session 不存在 → 按 ID 创建
    handler.enqueue(formatter.formatWithEvent(timerEvent("isolated-session", true, "e1") as any));
    await waitFor(() => sc.created.length > 0);

    // 第二次：session 已存在 → 走 existing 分支（不应再污染 active）
    handler.enqueue(formatter.formatWithEvent(timerEvent("isolated-session", true, "e2") as any));
    await waitFor(() => sc.component.setActiveSession.mock.calls.length >= 0);
    await new Promise((r) => setTimeout(r, 50));

    // setActiveSession 不应被调用（独立 session 不污染主会话）
    expect(sc.component.setActiveSession).not.toHaveBeenCalled();

    handler.stop();
  });

  test("★ MAJOR-1 独立 session 不应劫持无 trigger 事件（应留在主会话）", async () => {
    // 回归点：独立 session 模式下写 activeEventSessionId 会让**没有** trigger 的
    //   事件（lark-cli / bounty 等）被导向 timer 的独立 session，
    //   用户 REPL 主会话再也收不到这些 IM 事件。
    const sc = makeSessionComponent();
    const seen: { tag: string; sessionId?: string }[] = [];
    const handler = new EventHandler(
      createOptions(sc.component, async (fe: FormattedEvent) => {
        const tag = (fe.envEvent?.payload as { tag?: string })?.tag ?? "?";
        seen.push({ tag, sessionId: fe.eventSessionId });
      }),
    );
    handler.start();

    // 1) 先入队 timer 事件（独立 session）
    handler.enqueue(formatter.formatWithEvent(timerEvent("isolated-session", true, "timer-e") as any));
    await waitFor(() => seen.length >= 1);

    // 2) 再入队一条**无 trigger** 的普通事件（模拟 lark-cli IM 事件）
    handler.enqueue(
      formatter.formatWithEvent({
        type: "event-source.event.lark-cli",
        payload: { tag: "im-e" },
        metadata: { sourceId: "lark-source" },
      } as any),
    );
    await waitFor(() => seen.length >= 2);

    // timer 事件 → 独立 session
    expect(seen[0].sessionId).toBe("isolated-session");
    // 无 trigger 的事件 → 应留在主会话（不能被 timer 独立 session 劫持）
    expect(seen[1].sessionId).toBe("main-session");

    handler.stop();
  });
});
