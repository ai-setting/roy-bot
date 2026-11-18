/**
 * @fileoverview Task #4552 (A1) — 生产默认直发路径（不注入 sender 时真的 spawn lark-cli）
 *
 * ## 为什么必须单独测
 *
 * 前面两组测试都**注入**了 `telemetrySender` spy（避免真发消息），这带来的
 * 盲区是：如果 EventHandler 的默认实现接错了（比如拼成 no-op、或者传错参数），
 * 所有注入式测试依然全绿 —— 生产环境却一条进展提示都发不出去，
 * 而 A1 之后心跳**不再走 agent**，等于用户彻底收不到任何进展信息。
 *
 * 所以这一组刻意**不注入** sender，改为 mock `node:child_process`，
 * 断言默认实现真的拼出了正确的 lark-cli 命令。
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { createChildProcessMockModule } from "@ai-setting/roy-bot-core/test-utils/child-process-mock";

const mockSpawn = vi.fn();
vi.mock("node:child_process", () =>
  createChildProcessMockModule({
    spawn: (...args: any[]) => mockSpawn(...args),
  }),
);

import { EventHandler } from "./event-handler";
import type { EventHandlerOptions } from "./event-handler";
import { EventMessageFormatter } from "./event-message-formatter";

const CHAT = "oc_8904d6f184e31b6cc51ba53a0a19aa2f";
const PROFILE = "tongzhuli";
const START = new Date(2026, 9, 26, 12, 23, 42).getTime();

function fakeProc() {
  const handlers: Record<string, (arg: any) => void> = {};
  const proc: any = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
  };
  proc.on = vi.fn((event: string, h: (arg: any) => void) => {
    handlers[event] = h;
    return proc;
  });
  queueMicrotask(() => handlers["close"]?.(0));
  return proc;
}

async function waitFor(fn: () => boolean, timeout = 3000, interval = 5): Promise<void> {
  const start = Date.now();
  while (!fn() && Date.now() - start < timeout) {
    await new Promise((r) => setTimeout(r, interval));
  }
  if (!fn()) throw new Error(`waitFor timed out after ${timeout}ms`);
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

beforeEach(() => {
  mockSpawn.mockReset();
  mockSpawn.mockReturnValue(fakeProc());
});

describe("Task #4552 A1 — 生产默认直发（不注入 telemetrySender）", () => {
  test("progress 走默认实现 → 真的 spawn lark-cli im +messages-send", async () => {
    const onEventWithEnv = vi.fn(async () => {});
    const handler = new EventHandler({
      env: { subscribeAll: () => () => {}, getComponent: () => undefined } as any,
      eventTypes: ["task.background.*"],
      formatter: new EventMessageFormatter({ prefix: "[通知]" }),
      onEvent: async () => {},
      onEventWithEnv,
      // ★ 刻意不传 telemetrySender —— 走生产默认实现
      //
      // ★ Task #5360：同理显式钉 `"text"` —— 本测试验证的是**默认 sender
      //   真的 spawn lark-cli**（机制），不是"要不要发"。卡片化后默认
      //   `"auto"` + ES 缺省 false ⇒ 静默，那条路径由
      //   telemetry-notice-card-mode-5360.test.ts 覆盖。
      noticeTextDelivery: "text",
    } as EventHandlerOptions);

    const { env, emit } = makeSubscribableEnv();
    (handler as any).env = env;
    handler.start();

    emit({
      id: "evt-p",
      type: "task.background.progress",
      timestamp: Date.now(),
      payload: {
        backgroundTaskId: "bg-1",
        subSessionId: "sub-1",
        parentSessionId: "parent-1",
        status: "running",
        description: "调研 airport 本体生成",
        associatedTaskId: 4547,
        startedAt: START,
        timeoutMs: 5 * 3600 * 1000,
      },
      metadata: {
        source: "task.background",
        trigger_session_id: "parent-1",
        replyChannel: { type: "lark-cli", chatId: CHAT, profile: PROFILE },
      },
    } as any);

    await waitFor(() => mockSpawn.mock.calls.length === 1);

    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("lark-cli");
    expect(args[0]).toBe("--profile");
    expect(args[1]).toBe(PROFILE);
    expect(args).toContain("+messages-send");
    expect(args[args.indexOf("--chat-id") + 1]).toBe(CHAT);

    const markdown = args[args.indexOf("--markdown") + 1];
    expect(markdown).toContain("Task #4547");
    expect(markdown).toContain("17:23");

    // 仍然不跑 agent
    expect(onEventWithEnv).toHaveBeenCalledTimes(0);

    handler.stop();
  });
});
