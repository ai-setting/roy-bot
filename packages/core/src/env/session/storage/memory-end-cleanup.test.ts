/**
 * @fileoverview MemorySessionStore 终态清理 + saveCheckpoint checkpoint-aligned 裁剪 (Task #2539 / #2532 round 2)
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 *
 * 用户要求：
 *   - 当积累到一定消息触发压缩（checkpoint）后，store 只需保留「最新 checkpoint 之后」的消息，
 *     旧 checkpoint 之前的消息可以直接丢弃；旧 checkpoint 整体也可只保留最新 1 个。
 *   - saveCheckpoint / 终态清理（endSessionCleanup）需要体现该语义。
 *   - 选项：keepAllMessagesUntilCompaction 默认 true（保留所有消息直到 maxMessagesPerSession 触发）。
 */

import { describe, test, expect, beforeEach } from "bun:test";

import { MemorySessionStore } from "./memory";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function makeSessionWithMessages(
  store: MemorySessionStore,
  count: number,
): Promise<string> {
  const session = await store.create({ title: "test" });
  for (let i = 0; i < count; i++) {
    await store.addMessage(session.id, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i}`,
    });
  }
  return session.id;
}

function makeCheckpoint(id: string, messageIndex: number, type = "manual") {
  return {
    id,
    sessionID: "ignored", // saveCheckpoint 接收外部传入，不会用
    messageIndex,
    title: `ckpt-${id}`,
    createdAt: Date.now(),
    type: type as any,
  } as any;
}

// ---------------------------------------------------------------------------
// 1. saveCheckpoint: keepAllMessagesUntilCompaction=true（默认）→ 仅裁 checkpoint，不裁 message
// ---------------------------------------------------------------------------
describe("MemorySessionStore.saveCheckpoint checkpoint-aligned 裁剪 (Task #2539)", () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore({
      maxMessagesPerSession: 1000,
      maxCheckpointsPerSession: 100,
      keepAllMessagesUntilCompaction: true,
    });
  });

  test("keepAllMessagesUntilCompaction=true（默认）：saveCheckpoint 仅裁旧 checkpoint，消息全部保留", async () => {
    const sid = await makeSessionWithMessages(store, 50);
    await store.saveCheckpoint(sid, makeCheckpoint("ckpt-a", 10));
    await store.saveCheckpoint(sid, makeCheckpoint("ckpt-b", 20));
    await store.saveCheckpoint(sid, makeCheckpoint("ckpt-c", 30));

    const cps = await store.getCheckpoints(sid);
    // 默认保留所有 checkpoints（cap=100），3 个全在
    expect(cps.map((c) => c.id)).toEqual(["ckpt-a", "ckpt-b", "ckpt-c"]);

    // 消息全部保留
    const msgs = await store.getMessages(sid, 0, 1000);
    expect(msgs.length).toBe(50);
  });

  test("keepAllMessagesUntilCompaction=true：saveCheckpoint 后 maxCheckpointsPerSession 仍生效", async () => {
    const localStore = new MemorySessionStore({
      maxMessagesPerSession: 1000,
      maxCheckpointsPerSession: 2,
      keepAllMessagesUntilCompaction: true,
    });
    const sid = await makeSessionWithMessages(localStore, 50);
    await localStore.saveCheckpoint(sid, makeCheckpoint("a", 10));
    await localStore.saveCheckpoint(sid, makeCheckpoint("b", 20));
    await localStore.saveCheckpoint(sid, makeCheckpoint("c", 30));

    const cps = await localStore.getCheckpoints(sid);
    expect(cps.map((c) => c.id)).toEqual(["b", "c"]);
  });
});

// ---------------------------------------------------------------------------
// 2. saveCheckpoint: keepAllMessagesUntilCompaction=false → 裁到「最新 checkpoint + 其后消息」
// ---------------------------------------------------------------------------
describe("MemorySessionStore.saveCheckpoint 激进模式 (Task #2539)", () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore({
      maxMessagesPerSession: 1000,
      maxCheckpointsPerSession: 100,
      keepAllMessagesUntilCompaction: false,
    });
  });

  test("saveCheckpoint 后只剩最新 1 个 checkpoint + 其后消息；旧 checkpoint 与前 message 全部释放", async () => {
    const sid = await makeSessionWithMessages(store, 50);

    await store.saveCheckpoint(sid, makeCheckpoint("ckpt-old", 10));
    await store.saveCheckpoint(sid, makeCheckpoint("ckpt-mid", 20));
    await store.saveCheckpoint(sid, makeCheckpoint("ckpt-new", 40));

    // checkpoints: 只剩 ckpt-new
    const cps = await store.getCheckpoints(sid);
    expect(cps.map((c) => c.id)).toEqual(["ckpt-new"]);

    // messages: 仅保留 checkpoint 之后的（从 messageIndex=40 之后 → 10 条）
    const msgs = await store.getMessages(sid, 0, 1000);
    expect(msgs.length).toBe(10);
    expect(msgs[0].content).toBe("msg-40");
    expect(msgs[msgs.length - 1].content).toBe("msg-49");
  });

  test("saveCheckpoint 在 keepAllMessagesUntilCompaction=false 下保存第一个 checkpoint：按激进语义裁掉 pre-checkpoint messages", async () => {
    const sid = await makeSessionWithMessages(store, 50);
    await store.saveCheckpoint(sid, makeCheckpoint("ckpt-first", 30));

    const cps = await store.getCheckpoints(sid);
    expect(cps.length).toBe(1);

    // 激进模式：保留「最新 checkpoint 之后」的消息，包括第一个 checkpoint 也要裁前面
    const msgs = await store.getMessages(sid, 0, 1000);
    expect(msgs.length).toBe(20);
    expect(msgs[0].content).toBe("msg-30");
    expect(msgs[msgs.length - 1].content).toBe("msg-49");
  });
});

// ---------------------------------------------------------------------------
// 3. endSessionCleanup: 终态触发按 checkpoint 对齐裁剪
// ---------------------------------------------------------------------------
describe("MemorySessionStore.endSessionCleanup (Task #2539)", () => {
  test("endSessionCleanup 默认（keepAllMessagesUntilCompaction=true）：裁旧 checkpoint，但 message 全部保留", async () => {
    const store = new MemorySessionStore({
      maxMessagesPerSession: 1000,
      maxCheckpointsPerSession: 100,
      keepAllMessagesUntilCompaction: true,
    });
    const sid = await makeSessionWithMessages(store, 50);
    await store.saveCheckpoint(sid, makeCheckpoint("a", 10));
    await store.saveCheckpoint(sid, makeCheckpoint("b", 20));
    await store.saveCheckpoint(sid, makeCheckpoint("c", 30));

    await store.endSessionCleanup(sid);

    const cps = await store.getCheckpoints(sid);
    // 默认：仍按 maxCheckpointsPerSession 裁（这里 cap=100，3 个全在）
    expect(cps.map((c) => c.id)).toEqual(["a", "b", "c"]);
    // message 全部保留
    const msgs = await store.getMessages(sid, 0, 1000);
    expect(msgs.length).toBe(50);
  });

  test("endSessionCleanup 激进（keepAllMessagesUntilCompaction=false）：保留最新 1 checkpoint + 其后消息", async () => {
    const store = new MemorySessionStore({
      maxMessagesPerSession: 1000,
      maxCheckpointsPerSession: 100,
      keepAllMessagesUntilCompaction: false,
    });
    const sid = await makeSessionWithMessages(store, 50);
    await store.saveCheckpoint(sid, makeCheckpoint("a", 10));
    await store.saveCheckpoint(sid, makeCheckpoint("b", 20));
    await store.saveCheckpoint(sid, makeCheckpoint("c", 40));

    await store.endSessionCleanup(sid);

    const cps = await store.getCheckpoints(sid);
    expect(cps.map((c) => c.id)).toEqual(["c"]);

    const msgs = await store.getMessages(sid, 0, 1000);
    expect(msgs.length).toBe(10);
    expect(msgs[0].content).toBe("msg-40");
    expect(msgs[msgs.length - 1].content).toBe("msg-49");
  });

  test("endSessionCleanup 对不存在的 sessionId 不报错（幂等 no-op）", async () => {
    const store = new MemorySessionStore();
    await expect(store.endSessionCleanup("nonexistent")).resolves.toBeUndefined();
  });

  test("endSessionCleanup 在没有 checkpoint 的 session 上仅触发 maxMessages 裁剪", async () => {
    const store = new MemorySessionStore({
      maxMessagesPerSession: 5,
      maxCheckpointsPerSession: 100,
      keepAllMessagesUntilCompaction: false,
    });
    const sid = await makeSessionWithMessages(store, 20);

    // saveCheckpoint 不存在 → 激进模式无 checkpoint 可裁，message 由 maxMessages 兜底
    await store.endSessionCleanup(sid);

    const msgs = await store.getMessages(sid, 0, 1000);
    expect(msgs.length).toBeLessThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// 4. saveCheckpoint 与 endSessionCleanup 的交互（避免纯 splice 硬截断）
// ---------------------------------------------------------------------------
describe("MemorySessionStore saveCheckpoint + endSessionCleanup (Task #2539)", () => {
  test("激进模式下 saveCheckpoint 已裁过的 checkpoint 不被 endSessionCleanup 二次裁剪", async () => {
    const store = new MemorySessionStore({
      maxMessagesPerSession: 1000,
      maxCheckpointsPerSession: 100,
      keepAllMessagesUntilCompaction: false,
    });
    const sid = await makeSessionWithMessages(store, 50);
    await store.saveCheckpoint(sid, makeCheckpoint("a", 10));
    await store.saveCheckpoint(sid, makeCheckpoint("b", 20));
    await store.saveCheckpoint(sid, makeCheckpoint("c", 40));

    // saveCheckpoint "c" 已经把 messages 裁到只保留 [40..49]
    let msgs = await store.getMessages(sid, 0, 1000);
    expect(msgs.length).toBe(10);

    await store.endSessionCleanup(sid);

    // endSessionCleanup 应 idempotent，不应再次裁短 messages
    msgs = await store.getMessages(sid, 0, 1000);
    expect(msgs.length).toBe(10);
    expect(msgs[0].content).toBe("msg-40");
    expect(msgs[msgs.length - 1].content).toBe("msg-49");
  });
});