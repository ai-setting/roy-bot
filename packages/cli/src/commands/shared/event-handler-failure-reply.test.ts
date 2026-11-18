/**
 * @fileoverview Task #4418：EventHandler 层的「不允许静默」接线测试
 *
 * ## 背景
 *
 * `QueryExecutor.execute` 的 catch 是主兜底，但它只能覆盖「已经走到执行器」
 * 的失败。真实链路里还存在**还没到执行器就失败**的路径：
 *
 *   - session 解析 / ensureChatSession 抛错
 *   - 事件分发（onEventWithEnv）在进入 REPL 之前抛错
 *   - run 模式下 TUI 层 `handleNotification` 自己吞掉异常
 *
 * 这些以前只有 `console.error`（见 event-handler.ts 的 catch），飞书侧永远
 * 等不到回复 —— 正是用户说的「react 的中断不要沉默」。
 *
 * ## 本文件锁定
 *
 * 1. `processQueue` 的 onEventWithEnv 抛错 → 必须 spawn lark-cli 回一条说明
 * 2. 回的是**触发事件的那条消息**（+messages-reply --message-id om_xxx），
 *    不是随便发到某个群
 * 3. ask_user（正常交互）不算失败 → 不发
 * 4. 没有 replyChannel（本地/无事件）→ 不崩、不发
 * 5. 兜底发送失败也不能让队列循环挂掉（best-effort）
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";
import { createChildProcessMockModule } from "@ai-setting/roy-bot-core/test-utils/child-process-mock";

// 完整导出面（Bun 的 ESM exports 语义，见 Task #4420）
const mockSpawn = vi.fn();
vi.mock("node:child_process", () =>
  createChildProcessMockModule({
    spawn: (...args: any[]) => mockSpawn(...args),
  }),
);

import { EventHandler } from "./event-handler";
import type { EnvEvent } from "@ai-setting/roy-bot-core";
import { __resetFailureReplyDedupForTest } from "@ai-setting/roy-bot-core/env/error-reply";

function fakeProc(exitCode = 0) {
  const handlers: Record<string, (arg: any) => void> = {};
  const proc: any = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    kill: vi.fn(),
    on: vi.fn((event: string, cb: (arg: any) => void) => {
      handlers[event] = cb;
      return proc;
    }),
  };
  queueMicrotask(() => handlers.close?.(exitCode));
  return proc;
}

function makeHandler(onEventWithEnv: (fe: any) => Promise<void>) {
  return new EventHandler({
    // 不启动 start()，直接推队列
    env: { subscribeAll: vi.fn(() => () => {}) } as any,
    eventTypes: ["event-source.event.*", "task.background.*"],
    onEvent: async () => {},
    onEventWithEnv,
    isIdle: () => true,
  });
}

function larkEvent(overrides: { chatId?: string; messageId?: string } = {}): EnvEvent {
  return {
    type: "event-source.event.lark.message",
    payload: {},
    metadata: {
      sourceId: "test-source",
      replyChannel: {
        type: "lark-cli",
        chatId: overrides.chatId ?? "oc_4418_chat",
        messageId: overrides.messageId ?? "om_4418_msg",
        profile: "tongzhuli",
      },
    },
  } as unknown as EnvEvent;
}

async function drain(handler: EventHandler, event: EnvEvent) {
  const formatted = await (handler as any).formatEvent(event);
  (handler as any).queue.push(formatted);
  await (handler as any).processQueue();
}

describe("#4418 EventHandler —— processQueue 失败不允许沉默", () => {
  beforeEach(() => {
    // 去重是进程级的（生产语义），测试间必须清空，否则后一个用例被前一个吸收
    __resetFailureReplyDedupForTest();
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => fakeProc(0));
  });

  test("★ onEventWithEnv 抛错 → 回飞书（+messages-reply 到触发消息）", async () => {
    const handler = makeHandler(async () => {
      throw new Error(
        "Failed after 4 attempts. Last error: Upstream request failed: Endpoint is unavailable.",
      );
    });

    await drain(handler, larkEvent());

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const [cmd, args] = mockSpawn.mock.calls[0];
    expect(cmd).toBe("lark-cli");
    expect(args).toContain("+messages-reply");
    expect(args).toContain("--message-id");
    expect(args).toContain("om_4418_msg");
    // profile 必须带上（多 appId 场景）
    expect(args).toContain("--profile");
    expect(args).toContain("tongzhuli");
  });

  test("ask_user（正常交互）抛错 → 不发失败说明", async () => {
    const handler = makeHandler(async () => {
      const err = new Error('__ASK_USER_ERROR__:{"query":"继续吗"}');
      err.name = "AskUserError";
      throw err;
    });

    await drain(handler, larkEvent());

    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test("没有 replyChannel（本地事件）→ 不发、不崩", async () => {
    const handler = makeHandler(async () => {
      throw new Error("boom");
    });

    const event = {
      type: "task.background.failed",
      payload: {},
      metadata: { sourceId: "local" },
    } as unknown as EnvEvent;

    await expect(drain(handler, event)).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  test("兜底发送失败 → 队列循环仍然完成（best-effort，不抛）", async () => {
    mockSpawn.mockImplementation(() => fakeProc(1));

    const handler = makeHandler(async () => {
      throw new Error("boom");
    });

    await expect(drain(handler, larkEvent())).resolves.toBeUndefined();
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});
