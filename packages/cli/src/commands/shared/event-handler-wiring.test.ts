/**
 * Task #4042 ESPlugin v2 Phase 6: Production wiring helpers
 *
 * 覆盖：
 *   - getOrCreateEventStore 单例：相同 dbPath 拿到同一个实例 + 跨调用共享数据
 *   - getOrCreateEventStore 单例：不同 dbPath 拿到不同实例
 *   - getHandlerForEsTypeForEnv：从 env.getComponent("event-source") 取 handler
 *   - getHandlerForEsTypeForEnv：env 没有 event-source 组件时返回 undefined（不抛错）
 *   - getHandlerForEsTypeForEnv：env 组件没有 getHandler 时返回 undefined（向后兼容）
 *   - createDefaultEventStoreDbPath：返回 ~/.roy-bot/event-store.db 路径
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

import {
  getOrCreateEventStore,
  resetEventStoreCacheForTest,
  getHandlerForEsTypeForEnv,
  createDefaultEventStoreDbPath,
  createEventHandlerForInteractive,
} from "./event-handler-wiring";
import { EventStoreImpl } from "@ai-setting/roy-bot-core/env/event-source/event-store";
import type { BaseEnvironment, EventSourceHandler } from "@ai-setting/roy-bot-core";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "event-handler-wiring-test-"));
  resetEventStoreCacheForTest();
});

afterEach(() => {
  resetEventStoreCacheForTest();
  // 清理 tmpDir
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ============================================================================
// getOrCreateEventStore 单例
// ============================================================================

describe("getOrCreateEventStore", () => {
  test("相同 dbPath 两次调用返回同一实例（单例语义）", () => {
    const dbPath = join(tmpDir, "singleton.db");
    const a = getOrCreateEventStore(dbPath);
    const b = getOrCreateEventStore(dbPath);
    expect(a).toBe(b); // 同一个对象引用
  });

  test("不同 dbPath 返回不同实例", () => {
    const dbA = join(tmpDir, "a.db");
    const dbB = join(tmpDir, "b.db");
    const a = getOrCreateEventStore(dbA);
    const b = getOrCreateEventStore(dbB);
    expect(a).not.toBe(b);
  });

  test("单例跨调用共享数据：第一次 insert 的 event 第二次 get 还能拿到", async () => {
    const dbPath = join(tmpDir, "shared.db");
    const a = getOrCreateEventStore(dbPath) as EventStoreImpl;
    const inserted = await a.insertTriggerEvent(
      {
        senderId: "ou_wiring_test",
        text: "phase6 singleton test",
        metadata: {
          eventType: "im.message.receive_v1",
          chatId: "oc_chat_wiring",
          messageId: "om_msg_wiring",
          senderId: "ou_wiring_test",
        },
      },
      "lark-cli",
    );
    expect(inserted).toBeTruthy();

    // 第二次调用：拿到的是同一个实例，能查到
    const b = getOrCreateEventStore(dbPath);
    expect(b).toBe(a);
    const fetched = await b.getEventById(inserted);
    expect(fetched).not.toBeNull();
    expect(fetched?.metadata.chatId).toBe("oc_chat_wiring");
  });

  test("resetEventStoreCacheForTest 后再次调用重新创建实例", () => {
    const dbPath = join(tmpDir, "reset.db");
    const a = getOrCreateEventStore(dbPath);
    resetEventStoreCacheForTest();
    const b = getOrCreateEventStore(dbPath);
    expect(a).not.toBe(b);
  });
});

// ============================================================================
// getHandlerForEsTypeForEnv
// ============================================================================

describe("getHandlerForEsTypeForEnv", () => {
  test("env 有 event-source 组件 + getHandler → 返回对应 handler", () => {
    const fakeHandler: EventSourceHandler = {
      type: "lark-cli",
      start: async () => undefined,
      stop: async () => undefined,
      validateConfig: () => null,
      getOptions: () => [],
      createInstance: () => ({} as any),
      handleEvent: async () => undefined,
      emitTriggerEvent: async () => "evt_test",
      replyMessage: async () => ({ ok: true }),
      extractReplyContext: () => ({} as any),
      buildNotifyHandlePrompt: () => ({ promptText: "" }),
    };
    const env = {
      getComponent: (name: string) => {
        if (name === "event-source") {
          return {
            getHandler: (type: string) => (type === "lark-cli" ? fakeHandler : undefined),
          };
        }
        return null;
      },
    } as unknown as BaseEnvironment;

    const getter = getHandlerForEsTypeForEnv(env);
    const h = getter("lark-cli");
    expect(h).toBe(fakeHandler);
    expect(getter("unknown")).toBeUndefined();
  });

  test("env 没有 event-source 组件 → 返回的 getter 永远返回 undefined（不抛错）", () => {
    const env = {
      getComponent: (_name: string) => null,
    } as unknown as BaseEnvironment;

    const getter = getHandlerForEsTypeForEnv(env);
    // 不抛错
    expect(() => getter("lark-cli")).not.toThrow();
    expect(getter("lark-cli")).toBeUndefined();
  });

  test("env 组件没有 getHandler 方法 → 返回的 getter 永远返回 undefined（向后兼容）", () => {
    const env = {
      getComponent: (_name: string) => ({}),
    } as unknown as BaseEnvironment;

    const getter = getHandlerForEsTypeForEnv(env);
    expect(() => getter("lark-cli")).not.toThrow();
    expect(getter("lark-cli")).toBeUndefined();
  });

  test("env.getComponent 抛错 → 返回的 getter 安全降级", () => {
    const env = {
      getComponent: (_name: string) => {
        throw new Error("component registry crashed");
      },
    } as unknown as BaseEnvironment;

    const getter = getHandlerForEsTypeForEnv(env);
    expect(() => getter("lark-cli")).not.toThrow();
    expect(getter("lark-cli")).toBeUndefined();
  });
});

// ============================================================================
// createDefaultEventStoreDbPath
// ============================================================================

describe("createDefaultEventStoreDbPath", () => {
  test("返回 ~/.roy-bot/event-store.db", () => {
    const path = createDefaultEventStoreDbPath();
    expect(path).toBe(join(homedir(), ".roy-bot", "event-store.db"));
  });
});

// ============================================================================
// createEventHandlerForInteractive — production wiring factory
// ============================================================================

describe("createEventHandlerForInteractive (production wiring factory)", () => {
  test("factory 注入 eventStore + getHandlerForEsTypeForEnv", () => {
    const fakeHandler: EventSourceHandler = {
      type: "lark-cli",
      start: async () => undefined,
      stop: async () => undefined,
      validateConfig: () => null,
      getOptions: () => [],
      createInstance: () => ({} as any),
      handleEvent: async () => undefined,
      emitTriggerEvent: async () => "evt",
      replyMessage: async () => ({ ok: true }),
      extractReplyContext: () => ({} as any),
      buildNotifyHandlePrompt: () => ({ promptText: "ok" }),
    };
    const env = {
      getComponent: (name: string) =>
        name === "event-source"
          ? { getHandler: (type: string) => (type === "lark-cli" ? fakeHandler : undefined) }
          : null,
    } as unknown as BaseEnvironment;

    const dbPath = join(tmpDir, "factory.db");
    const handler = createEventHandlerForInteractive({
      env,
      dbPath,
      eventTypes: ["task.background.*"],
      onEvent: async () => {},
    });
    // 工厂返回值是 EventHandler 实例
    expect(handler).toBeDefined();
    expect(typeof handler.start).toBe("function");
    expect(typeof handler.stop).toBe("function");
  });

  test("factory: dbPath 不传 → 默认 ~/.roy-bot/event-store.db（不抛错）", () => {
    const env = {
      getComponent: () => null,
    } as unknown as BaseEnvironment;

    expect(() =>
      createEventHandlerForInteractive({
        env,
        eventTypes: ["task.background.*"],
        onEvent: async () => {},
      }),
    ).not.toThrow();
  });

  test("factory: 复用 EventStore 单例（两次调用 dbPath 相同时拿到同一 EventStore）", async () => {
    const env = {
      getComponent: () => null,
    } as unknown as BaseEnvironment;
    const dbPath = join(tmpDir, "shared-factory.db");

    // 第一次 insert 一些 event
    const h1 = createEventHandlerForInteractive({
      env,
      dbPath,
      eventTypes: ["task.background.*"],
      onEvent: async () => {},
    });
    const store1 = getOrCreateEventStore(dbPath);
    const triggerId = await store1.insertTriggerEvent(
      {
        senderId: "ou_factory",
        text: "x",
        metadata: { eventType: "x", chatId: "oc_factory", messageId: "om_factory", senderId: "ou_factory" },
      },
      "lark-cli",
    );

    // 第二次构造 handler，拿到同一个 store
    const h2 = createEventHandlerForInteractive({
      env,
      dbPath,
      eventTypes: ["task.background.*"],
      onEvent: async () => {},
    });
    const store2 = getOrCreateEventStore(dbPath);
    expect(store1).toBe(store2);
    const fetched = await store2.getEventById(triggerId);
    expect(fetched).not.toBeNull();
    expect(fetched?.metadata.chatId).toBe("oc_factory");
  });
});

// ============================================================================
// Task #5459 — self-echo 门禁的自身身份解析必须**真的接到生产路径**
// ============================================================================
//
// 背景：`isSelfEchoEvent` 的「第 0 步 = senderId ∈ selfBotIds → 丢弃」是群聊
// 放行后的自循环闸门。历史上 `selfBotIds` 在生产 wiring **从未注入**（恒 []）
// ⇒ 闸门失效。这组测试锁住「factory 一定会注入 resolveSelfBotIds」。

describe("Task #5459 — factory 注入 self-echo 自身身份解析", () => {
  const env = { getComponent: () => null } as unknown as BaseEnvironment;

  test("未显式传 resolver → factory 自动注入（非 undefined）", () => {
    const h = createEventHandlerForInteractive({
      env,
      dbPath: join(tmpDir, "se-inject.db"),
      eventTypes: ["task.background.*"],
      onEvent: async () => {},
    });
    const filter = (h as unknown as {
      selfEchoFilter: { resolveSelfBotIds?: unknown };
    }).selfEchoFilter;
    expect(typeof filter.resolveSelfBotIds).toBe("function");
  });

  test("显式传 resolver → 保留调用方的（测试注入口优先，不被覆盖）", () => {
    const mine = async () => ["cli_test"];
    const h = createEventHandlerForInteractive({
      env,
      dbPath: join(tmpDir, "se-override.db"),
      eventTypes: ["task.background.*"],
      onEvent: async () => {},
      selfEchoFilter: { resolveSelfBotIds: mine },
    });
    const filter = (h as unknown as {
      selfEchoFilter: { resolveSelfBotIds?: unknown };
    }).selfEchoFilter;
    expect(filter.resolveSelfBotIds).toBe(mine);
  });

  test("注入的 resolver 同步返回数组（热路径不能有 await）", () => {
    const h = createEventHandlerForInteractive({
      env,
      dbPath: join(tmpDir, "se-call.db"),
      eventTypes: ["task.background.*"],
      onEvent: async () => {},
      // 注入假 resolver，避免测试真的 spawn lark-cli
      selfEchoFilter: { resolveSelfBotIds: () => ["cli_fake", "ou_fake"] },
    });
    const filter = (h as unknown as {
      selfEchoFilter: { resolveSelfBotIds: (p?: string) => readonly string[] };
    }).selfEchoFilter;
    expect(filter.resolveSelfBotIds("tongzhuli")).toEqual(["cli_fake", "ou_fake"]);
  });
});
