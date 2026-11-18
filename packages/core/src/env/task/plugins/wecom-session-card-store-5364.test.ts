/**
 * @fileoverview Task #5364 —— session 卡持久层单测
 *
 * ## 为什么它必须存在（B 方案的根基）
 *
 * B 方案 = 「一张卡 + 按钮刷新」。生命周期事件**不再发消息**，所以
 * 刷新时看到的全部信息只能来自本 store。store 丢了：
 * - 卡片永远停在「运行中」（超时/完成看不见）
 * - 操作记录 / 任务号 / 会话详情全丢
 * - 甚至可能重发第二张卡（`get` 返回 undefined ⇒ 走首发分支）
 *
 * ## 锁定的不变量
 *
 * 1. 按 **sessionId**（字符串）存取 —— 不是 taskId
 * 2. upsert 幂等 + 部分字段累积（milestones 不丢）
 * 3. `cardTaskId` 必须持久化 —— 刷新帧的 task_id 协议要求原样回填
 * 4. sqlite 实现：重启（新实例）后仍可读（真持久化，不是内存假象）
 * 5. 测试环境守卫：不污染真实用户库
 */

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SqliteWecomSessionCardStore,
  createMemoryWecomSessionCardStore,
  type WecomSessionCardState,
} from "./wecom-session-card-store";

const SESSION_ID = "session_store_04357c17";
const tmpDir = mkdtempSync(join(tmpdir(), "wecom-session-store-"));
let counter = 0;

function dbPath(): string {
  counter += 1;
  return join(tmpDir, `s${counter}.db`);
}

afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function rec(over: Partial<WecomSessionCardState> = {}): WecomSessionCardState {
  return {
    sessionId: SESSION_ID,
    chatId: "dzk_userid",
    chatType: "single",
    cardTaskId: `roy-session-${SESSION_ID}`,
    lifecycle: "running",
    createdAt: 1000,
    updatedAt: 1000,
    ...over,
  };
}

// ============================================================================
// A. 内存实现语义
// ============================================================================

describe("内存 store", () => {
  test("upsert → get 往返（含全部可选字段）", () => {
    const store = createMemoryWecomSessionCardStore();
    store.upsert(
      rec({
        sourceId: "wecom-bot-1",
        title: "调研 airport",
        agentType: "roy",
        startedAt: "2026-11-12T00:00:00.000Z",
        associatedTaskId: 5364,
        milestones: JSON.stringify([{ title: "运行中", timestamp: "t" }]),
      }),
    );
    const got = store.get(SESSION_ID)!;
    expect(got.title).toBe("调研 airport");
    expect(got.agentType).toBe("roy");
    expect(got.associatedTaskId).toBe(5364);
    expect(got.cardTaskId).toBe(`roy-session-${SESSION_ID}`);
    expect(JSON.parse(got.milestones!)).toHaveLength(1);
  });

  test("★ upsert 是覆盖写（幂等），不是追加重复行", () => {
    const store = createMemoryWecomSessionCardStore();
    store.upsert(rec());
    store.upsert(rec({ lifecycle: "completed", updatedAt: 2000 }));
    expect(store.list()).toHaveLength(1);
    expect(store.get(SESSION_ID)!.lifecycle).toBe("completed");
  });

  test("★ get 返回副本（外部修改不污染 store）", () => {
    const store = createMemoryWecomSessionCardStore();
    store.upsert(rec());
    const a = store.get(SESSION_ID)!;
    a.lifecycle = "failed";
    expect(store.get(SESSION_ID)!.lifecycle).toBe("running");
  });

  test("未知 sessionId → undefined（不抛）", () => {
    expect(createMemoryWecomSessionCardStore().get("nope")).toBeUndefined();
  });

  test("markClosed / delete", () => {
    const store = createMemoryWecomSessionCardStore();
    store.upsert(rec());
    store.markClosed(SESSION_ID);
    expect(store.get(SESSION_ID)!.closedAt).toBeDefined();
    store.delete(SESSION_ID);
    expect(store.get(SESSION_ID)).toBeUndefined();
  });

  test("★ 主键是 sessionId（字符串），不同 session 互不覆盖", () => {
    const store = createMemoryWecomSessionCardStore();
    store.upsert(rec({ sessionId: "session_a" }));
    store.upsert(rec({ sessionId: "session_b", lifecycle: "completed" }));
    expect(store.list()).toHaveLength(2);
    expect(store.get("session_a")!.lifecycle).toBe("running");
    expect(store.get("session_b")!.lifecycle).toBe("completed");
  });
});

// ============================================================================
// B. SQLite 实现（真持久化）
// ============================================================================

describe("SQLite store", () => {
  test("★ 新实例（模拟进程重启）仍能读到 —— 这是 B 方案的关键", () => {
    const path = dbPath();
    const a = new SqliteWecomSessionCardStore(path);
    a.upsert(rec({ title: "重启前", associatedTaskId: 5364 }));
    a.close();

    const b = new SqliteWecomSessionCardStore(path);
    const got = b.get(SESSION_ID)!;
    expect(got.title).toBe("重启前");
    expect(got.associatedTaskId).toBe(5364);
    expect(got.cardTaskId).toBe(`roy-session-${SESSION_ID}`);
    b.close();
  });

  test("★ cardTaskId 持久化（刷新帧协议要求原样回填）", () => {
    const path = dbPath();
    const store = new SqliteWecomSessionCardStore(path);
    store.upsert(rec({ cardTaskId: "roy-session-x@task-5364" }));
    expect(store.get(SESSION_ID)!.cardTaskId).toBe("roy-session-x@task-5364");
    store.close();
  });

  test("upsert 幂等（ON CONFLICT 更新而非插新行）", () => {
    const path = dbPath();
    const store = new SqliteWecomSessionCardStore(path);
    store.upsert(rec());
    store.upsert(rec({ lifecycle: "timeout", updatedAt: 3000 }));
    expect(store.list()).toHaveLength(1);
    expect(store.get(SESSION_ID)!.lifecycle).toBe("timeout");
    store.close();
  });

  test("chatType 双向（group / single）", () => {
    const path = dbPath();
    const store = new SqliteWecomSessionCardStore(path);
    store.upsert(rec({ sessionId: "s-g", chatType: "group" }));
    store.upsert(rec({ sessionId: "s-s", chatType: "single" }));
    expect(store.get("s-g")!.chatType).toBe("group");
    expect(store.get("s-s")!.chatType).toBe("single");
    store.close();
  });

  test("milestones / closedAt 持久化", () => {
    const path = dbPath();
    const store = new SqliteWecomSessionCardStore(path);
    store.upsert(
      rec({
        lifecycle: "failed",
        milestones: JSON.stringify([{ title: "已失败", timestamp: "t1" }]),
        closedAt: 5000,
      }),
    );
    const got = store.get(SESSION_ID)!;
    expect(got.closedAt).toBe(5000);
    expect(JSON.parse(got.milestones!)[0].title).toBe("已失败");
    store.close();
  });

  test("list 按 createdAt 升序（诊断可读性）", () => {
    const path = dbPath();
    const store = new SqliteWecomSessionCardStore(path);
    store.upsert(rec({ sessionId: "b", createdAt: 2000 }));
    store.upsert(rec({ sessionId: "a", createdAt: 1000 }));
    expect(store.list().map((r) => r.sessionId)).toEqual(["a", "b"]);
    store.close();
  });
});