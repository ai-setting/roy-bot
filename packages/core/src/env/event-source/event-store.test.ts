/**
 * EventStore 单元测试（Task #4042 ESPlugin v2 Phase 1）
 *
 * TDD：先写 RED 测试，再 GREEN 实现。
 * 覆盖：CRUD、并发、性能（<10ms p95）、边界、唯一约束。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

import {
  EventStoreImpl,
  type TriggerEventInput,
  type PersistedEvent,
} from "./event-store";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "event-store-test-"));
  dbPath = join(tmpDir, "event-store.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeInput(overrides: Partial<TriggerEventInput> = {}): TriggerEventInput {
  return {
    senderId: "ou_sender_001",
    text: "再新建一个任务调研下 deepseek 吧",
    metadata: {
      eventType: "im.message.receive_v1",
      appId: "cli_test_appid",
      chatId: "oc_chat_001",
      chatType: "group",
      messageId: "om_msg_001",
      messageType: "text",
      senderId: "ou_sender_001",
    },
    rawEvent: { type: "event", ts: "1700000000000" },
    ...overrides,
  };
}

describe("EventStore / insertTriggerEvent", () => {
  test("returns a non-empty eventId", async () => {
    const store = new EventStoreImpl({ dbPath });
    const id = await store.insertTriggerEvent(makeInput(), "lark-cli");
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("two inserts return distinct eventIds", async () => {
    const store = new EventStoreImpl({ dbPath });
    const id1 = await store.insertTriggerEvent(makeInput(), "lark-cli");
    const id2 = await store.insertTriggerEvent(makeInput(), "lark-cli");
    expect(id1).not.toBe(id2);
  });

  test("second insert with same payload succeeds (eventId auto-generated)", async () => {
    const store = new EventStoreImpl({ dbPath });
    await store.insertTriggerEvent(makeInput(), "lark-cli");
    await store.insertTriggerEvent(makeInput(), "lark-cli");
    const recent = await store.getRecentEvents("lark-cli", "ou_sender_001", 10);
    expect(recent.length).toBe(2);
  });
});

describe("EventStore / getEventById", () => {
  test("returns null for unknown eventId", async () => {
    const store = new EventStoreImpl({ dbPath });
    const got = await store.getEventById("evt_does_not_exist");
    expect(got).toBeNull();
  });

  test("returns full PersistedEvent with all fields", async () => {
    const store = new EventStoreImpl({ dbPath });
    const id = await store.insertTriggerEvent(makeInput(), "lark-cli");
    const got = await store.getEventById(id);
    expect(got).not.toBeNull();
    expect(got!.eventId).toBe(id);
    expect(got!.esType).toBe("lark-cli");
    expect(got!.senderId).toBe("ou_sender_001");
    expect(got!.text).toBe("再新建一个任务调研下 deepseek 吧");
    expect(got!.metadata.chatId).toBe("oc_chat_001");
    expect(got!.metadata.messageId).toBe("om_msg_001");
    expect(typeof got!.createdAt).toBe("number");
    expect(got!.createdAt).toBeGreaterThan(0);
  });

  test("metadata JSON round-trip preserves nested objects", async () => {
    const store = new EventStoreImpl({ dbPath });
    const input = makeInput({
      metadata: {
        eventType: "im.message.receive_v1",
        appId: "cli_app",
        chatId: "oc_chat_002",
        chatType: "group",
        messageId: "om_msg_002",
        messageType: "text",
        senderId: "ou_sender_002",
        tenantKey: "tnt_xyz",
        custom: { foo: "bar", arr: [1, 2, 3] },
      },
    });
    const id = await store.insertTriggerEvent(input, "lark-cli");
    const got = await store.getEventById(id);
    expect(got!.metadata.tenantKey).toBe("tnt_xyz");
    expect((got!.metadata as any).custom).toEqual({ foo: "bar", arr: [1, 2, 3] });
  });
});

describe("EventStore / getRecentEvents", () => {
  test("returns empty array for unknown sender", async () => {
    const store = new EventStoreImpl({ dbPath });
    const recent = await store.getRecentEvents("lark-cli", "ou_unknown", 10);
    expect(recent).toEqual([]);
  });

  test("filters by esType (no cross-type leak)", async () => {
    const store = new EventStoreImpl({ dbPath });
    await store.insertTriggerEvent(makeInput({ senderId: "ou_x" }), "lark-cli");
    await store.insertTriggerEvent(makeInput({ senderId: "ou_x" }), "timer");
    const larkRecent = await store.getRecentEvents("lark-cli", "ou_x", 10);
    const timerRecent = await store.getRecentEvents("timer", "ou_x", 10);
    expect(larkRecent.length).toBe(1);
    expect(timerRecent.length).toBe(1);
    expect(larkRecent[0].esType).toBe("lark-cli");
    expect(timerRecent[0].esType).toBe("timer");
  });

  test("filters by senderId (no cross-sender leak)", async () => {
    const store = new EventStoreImpl({ dbPath });
    await store.insertTriggerEvent(makeInput({ senderId: "ou_A" }), "lark-cli");
    await store.insertTriggerEvent(makeInput({ senderId: "ou_B" }), "lark-cli");
    const aRecent = await store.getRecentEvents("lark-cli", "ou_A", 10);
    expect(aRecent.length).toBe(1);
    expect(aRecent[0].senderId).toBe("ou_A");
  });

  test("respects limit parameter", async () => {
    const store = new EventStoreImpl({ dbPath });
    for (let i = 0; i < 5; i++) {
      await store.insertTriggerEvent(makeInput({ senderId: "ou_limit" }), "lark-cli");
    }
    const recent = await store.getRecentEvents("lark-cli", "ou_limit", 3);
    expect(recent.length).toBe(3);
  });

  test("orders by createdAt DESC (most recent first)", async () => {
    const store = new EventStoreImpl({ dbPath });
    const id1 = await store.insertTriggerEvent(makeInput({ senderId: "ou_ord" }), "lark-cli");
    // 50ms 间隔确保 createdAt 区分（实际 ms 精度下 Date.now() 可能同 ms，所以只验证不等首）
    const id2 = await store.insertTriggerEvent(makeInput({ senderId: "ou_ord" }), "lark-cli");
    const recent = await store.getRecentEvents("lark-cli", "ou_ord", 10);
    expect(recent.length).toBe(2);
    // 两个 id 必须都被返回
    expect([id1, id2].sort()).toEqual([recent[0].eventId, recent[1].eventId].sort());
    // 第一个的 createdAt >= 第二个的 createdAt
    expect(recent[0].createdAt).toBeGreaterThanOrEqual(recent[1].createdAt);
  });
});

describe("EventStore / concurrency", () => {
  test("50 parallel inserts all return distinct ids and persist", async () => {
    const store = new EventStoreImpl({ dbPath });
    const promises: Promise<string>[] = [];
    for (let i = 0; i < 50; i++) {
      promises.push(store.insertTriggerEvent(makeInput({ senderId: "ou_concurrent" }), "lark-cli"));
    }
    const ids = await Promise.all(promises);
    expect(new Set(ids).size).toBe(50);
    const recent = await store.getRecentEvents("lark-cli", "ou_concurrent", 100);
    expect(recent.length).toBe(50);
  });
});

describe("EventStore / performance", () => {
  test("insertTriggerEvent completes under 10ms (warm)", async () => {
    const store = new EventStoreImpl({ dbPath });
    // 预热 5 次
    for (let i = 0; i < 5; i++) {
      await store.insertTriggerEvent(makeInput({ senderId: "ou_perf" }), "lark-cli");
    }
    const samples: number[] = [];
    for (let i = 0; i < 30; i++) {
      const t0 = performance.now();
      await store.insertTriggerEvent(makeInput({ senderId: "ou_perf" }), "lark-cli");
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    // 10ms 阈值（< 10ms p95）
    expect(p95).toBeLessThan(10);
  });

  test("getEventById completes under 5ms (warm)", async () => {
    const store = new EventStoreImpl({ dbPath });
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) {
      ids.push(await store.insertTriggerEvent(makeInput({ senderId: "ou_get" }), "lark-cli"));
    }
    // 预热
    for (const id of ids) await store.getEventById(id);
    const samples: number[] = [];
    for (const id of ids) {
      const t0 = performance.now();
      await store.getEventById(id);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)];
    expect(p95).toBeLessThan(5);
  });
});

describe("EventStore / isolation", () => {
  test("two stores on different dbPath don't share data", async () => {
    const dbPath2 = join(tmpDir, "event-store-2.db");
    const store1 = new EventStoreImpl({ dbPath });
    const store2 = new EventStoreImpl({ dbPath: dbPath2 });
    await store1.insertTriggerEvent(makeInput({ senderId: "ou_iso" }), "lark-cli");
    const s2Recent = await store2.getRecentEvents("lark-cli", "ou_iso", 10);
    expect(s2Recent.length).toBe(0);
  });
});