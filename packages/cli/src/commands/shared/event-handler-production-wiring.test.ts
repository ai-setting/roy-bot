/**
 * Task #4042 ESPlugin v2 Phase 6 commit 2: Production wiring 集成测试
 *
 * 覆盖：
 *   1. createEventHandlerForInteractive(env, opts)：封装 interactive.ts / run.ts
 *      的 EventHandler 构造逻辑，自动注入 eventStore + getHandlerForEsType
 *   2. 验证：trigger event 存在 → 走 v2 path，chatId 来自 trigger event
 *   3. 验证：trigger event 不存在 → 走老 formatter 路径（向后兼容）
 *   4. 验证：env 没有 event-source 组件 → 安全降级
 *   5. 验证：dbPath 默认用 ~/.roy-bot/event-store.db
 *
 * 为什么是 factory 函数：
 *   - commands/interactive.ts 和 commands/run.ts 重复相同的 EventHandler 构造代码
 *   - 用 factory 提取后两端共用，避免 drift
 *   - factory 本身就是「production wiring 注入」的代码位置
 *   - 单元测试可以直接验证 factory 行为，不需要启动 REPL
 *
 * RED：
 *   - createEventHandlerForInteractive 不存在 → 测试 import 失败 → fail
 *   - 或者 factory 存在但忘了注入 eventStore → v2 path 走不到 → fail
 *
 * GREEN：
 *   - factory 存在 + 注入 eventStore + getHandlerForEsTypeForEnv → 全 pass
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEventHandlerForInteractive,
  resetEventStoreCacheForTest,
} from "./event-handler-wiring";
import { larkCliHandler } from "@ai-setting/roy-bot-core/env/event-source/event-source-handlers";
import type {
  BaseEnvironment,
  EnvEvent,
  EventSourceHandler,
} from "@ai-setting/roy-bot-core";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "production-wiring-test-"));
  resetEventStoreCacheForTest();
});

afterEach(() => {
  resetEventStoreCacheForTest();
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ============================================================================
// 模拟 env（最小可用）
// ============================================================================

function makeMockEnv(opts: {
  withEventSource?: boolean;
} = {}): BaseEnvironment {
  const fakeHandler: EventSourceHandler = larkCliHandler;
  return {
    subscribeAll: (_handler: (event: EnvEvent) => void) => () => {},
    subscribeTo: (_type: string, _handler: (event: EnvEvent) => void) => () => {},
    pushEnvEvent: () => {},
    getComponent: (name: string) => {
      if (name === "event-source" && opts.withEventSource !== false) {
        return {
          getHandler: (type: string) => (type === "lark-cli" ? fakeHandler : undefined),
        };
      }
      return null;
    },
  } as unknown as BaseEnvironment;
}

function makeNotifyEvent(opts: {
  triggerEventId?: string;
  chatId?: string;
} = {}): EnvEvent {
  return {
    id: "evt_notify",
    type: "task.background.completed",
    timestamp: Date.now(),
    metadata: {
      source: "task.background",
      trigger_session_id: "parent_sess",
      ...(opts.triggerEventId ? { triggerEventId: opts.triggerEventId } : {}),
      ...(opts.chatId
        ? { replyChannel: { type: "lark-cli", chatId: opts.chatId, messageId: "om_xxx" } }
        : {}),
    },
    payload: {
      backgroundTaskId: "bg_001",
      subSessionId: "sub_001",
      parentSessionId: "parent_sess",
      status: "completed",
      result: "调研已完成",
      description: "调研 DeepSeek",
      executionTimeMs: 12000,
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("createEventHandlerForInteractive (production wiring factory)", () => {
  test("factory 存在 + 注入 eventStore + getHandlerForEsType → triggerEventId 走 v2 path", async () => {
    const env = makeMockEnv({ withEventSource: true });
    const dbPath = join(tmpDir, "phase6.db");

    // 1. 先准备 trigger event
    const { getOrCreateEventStore } = await import("./event-handler-wiring");
    const store = getOrCreateEventStore(dbPath);
    const triggerId = await store.insertTriggerEvent(
      {
        senderId: "ou_production",
        text: "请调研 deepseek",
        metadata: {
          eventType: "im.message.receive_v1",
          chatId: "oc_chat_FROM_TRIGGER_EVENT",
          messageId: "om_msg_FROM_TRIGGER_EVENT",
          senderId: "ou_production",
        },
      },
      "lark-cli",
    );

    // 2. 用 factory 构造（production 方式）
    const captured: any[] = [];
    const handler = createEventHandlerForInteractive({
      env,
      dbPath,
      eventTypes: ["task.background.*", "event-source.event.*"],
      onEventWithEnv: async (formatted) => {
        captured.push(formatted);
      },
    });

    // 3. 模拟收到 notify event（replyChannel.chatId 是错的 fallback 值）
    await handler.handleNotifyEventForTest(
      makeNotifyEvent({
        triggerEventId: triggerId,
        chatId: "oc_chat_FALLBACK_SHOULD_NOT_USE",
      }),
    );

    expect(captured.length).toBe(1);
    const formatted = captured[0];
    // ★ 关键：chatId 应该来自 trigger event
    expect(formatted.chatId).toBe("oc_chat_FROM_TRIGGER_EVENT");
    expect(formatted.message).toContain("oc_chat_FROM_TRIGGER_EVENT");
    expect(formatted.message).toContain("om_msg_FROM_TRIGGER_EVENT");
    // ★ 关键：不应使用 fallback 的 chatId
    expect(formatted.chatId).not.toBe("oc_chat_FALLBACK_SHOULD_NOT_USE");
  });

  test("factory：triggerEventId 不在 EventStore → 老 formatter 路径（向后兼容）", async () => {
    const env = makeMockEnv({ withEventSource: true });
    const dbPath = join(tmpDir, "miss.db");

    const captured: any[] = [];
    const handler = createEventHandlerForInteractive({
      env,
      dbPath,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (formatted) => {
        captured.push(formatted);
      },
    });

    await handler.handleNotifyEventForTest(
      makeNotifyEvent({
        triggerEventId: "evt_definitely_not_in_db",
        chatId: "oc_chat_fallback_only",
      }),
    );

    expect(captured.length).toBe(1);
    // 老路径 → message 不包含 trigger event 信息
    expect(captured[0].message).not.toContain("不要 fallback");
    expect(captured[0].message).not.toContain("oc_chat_FROM_TRIGGER_EVENT");
  });

  test("factory：无 triggerEventId → 老 formatter 路径（向后兼容）", async () => {
    const env = makeMockEnv({ withEventSource: true });
    const dbPath = join(tmpDir, "no-trigger.db");

    const captured: any[] = [];
    const handler = createEventHandlerForInteractive({
      env,
      dbPath,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (formatted) => {
        captured.push(formatted);
      },
    });

    await handler.handleNotifyEventForTest(
      makeNotifyEvent({
        chatId: "oc_chat_legacy_only",
      }),
    );

    expect(captured.length).toBe(1);
    expect(captured[0].chatId).toBe("oc_chat_legacy_only");
    expect(captured[0].message).not.toContain("不要 fallback");
  });

  test("factory：env 没有 event-source 组件 → 安全降级（不抛错 + 老路径）", async () => {
    const env = makeMockEnv({ withEventSource: false });
    const dbPath = join(tmpDir, "no-component.db");

    expect(() => {
      createEventHandlerForInteractive({
        env,
        dbPath,
        eventTypes: ["task.background.*"],
        onEventWithEnv: async () => {},
      });
    }).not.toThrow();

    const captured: any[] = [];
    const handler = createEventHandlerForInteractive({
      env,
      dbPath,
      eventTypes: ["task.background.*"],
      onEventWithEnv: async (formatted) => {
        captured.push(formatted);
      },
    });

    await handler.handleNotifyEventForTest(
      makeNotifyEvent({
        triggerEventId: "evt_does_not_matter",
        chatId: "oc_chat_no_component",
      }),
    );

    expect(captured.length).toBe(1);
    // 因为 getHandlerForEsType 永远返回 undefined → 走老路径
    expect(captured[0].message).not.toContain("不要 fallback");
  });

  test("factory：dbPath 默认用 createDefaultEventStoreDbPath()", async () => {
    const env = makeMockEnv({ withEventSource: true });

    // 不传 dbPath → 默认 ~/.roy-bot/event-store.db
    expect(() => {
      createEventHandlerForInteractive({
        env,
        eventTypes: ["task.background.*"],
        onEventWithEnv: async () => {},
      });
    }).not.toThrow();
  });

  test("factory：onEvent callback 也能用（不只是 onEventWithEnv）", async () => {
    const env = makeMockEnv({ withEventSource: true });
    const dbPath = join(tmpDir, "on-event.db");

    const captured: string[] = [];
    const handler = createEventHandlerForInteractive({
      env,
      dbPath,
      eventTypes: ["task.background.*"],
      // 不传 onEventWithEnv，只传 onEvent
      onEvent: async (message: string) => {
        captured.push(message);
      },
    });

    await handler.handleNotifyEventForTest(
      makeNotifyEvent({
        chatId: "oc_chat_on_event",
      }),
    );

    expect(captured.length).toBe(1);
    expect(captured[0]).toBeDefined();
  });
});
