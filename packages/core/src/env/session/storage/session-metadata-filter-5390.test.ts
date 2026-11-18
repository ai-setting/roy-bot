/**
 * Task #5390（P0 追加）— SQLiteSessionStore.list 的 `filter.metadata` 匹配不上
 *
 * ## 缺陷（sqlite.ts:379）
 * ```js
 * conditions.push(`json_extract(metadata, '$.${key}') = ?`);
 * params.push(JSON.stringify(value));   // ← 字符串被二次 stringify
 * ```
 * `json_extract` 返回 **原始类型**（`oc_xxx` 字符串 / `42` 数字），但参数是
 * `JSON.stringify(value)`：
 *  - string `"oc_xxx"` → 参数 `"\"oc_xxx\""`（带引号）⇒ **永不匹配**
 *  - number `42`       → 参数 `"42"` ⇒ SQLite 里 `42 = '42'` 为 false ⇒ **永不匹配**
 *
 * MemorySessionStore 同款过滤用的是 `s.metadata?.[key] !== value`（原始类型比较），
 * 所以**只有 SQLite 后端坏**，两个后端行为不一致 —— 这正是它能长期潜伏的原因。
 *
 * ## 生产影响（file:line）
 * `event-handler.ts:2375` 的 `ensureChatSession`：
 * ```ts
 * list({ filter: { metadata: { chatId, type: "lark-chat" } }, limit: 1 })
 * ```
 * 恒返回空 ⇒ 判定「群会话不存在」⇒ `create({ id: chatId })` 撞主键
 * ⇒ catch → `get(chatId)` 兜底。**结果仍正确**，但**每个群事件抛一次异常**
 * （日志噪音 + 一次多余的 insert 尝试）。
 *
 * 本测试用**真实 SQLite**（不是 mock）断言过滤能命中，并断言 Memory 后端同款
 * 语义 —— 两个后端必须完全一致。
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SQLiteSessionStore } from "./sqlite";
import { MemorySessionStore } from "./memory";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sess-meta-5390-"));
  dbPath = join(dir, "sessions.db");
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("Task #5390 P0：SQLite list 的 metadata 过滤（真实库，非 mock）", () => {
  test("★ 字符串字段 metadata.chatId 能命中（原实现恒空）", async () => {
    const store = new SQLiteSessionStore(dbPath);
    await store.initialize();
    await store.create({
      id: "oc_abc",
      title: "群会话",
      metadata: { chatId: "oc_abc", type: "lark-chat" },
    } as never);

    const hit = await store.list({ filter: { metadata: { chatId: "oc_abc" } } });
    expect(hit.map((s) => s.id)).toEqual(["oc_abc"]);

    const miss = await store.list({ filter: { metadata: { chatId: "oc_other" } } });
    expect(miss).toEqual([]);
  });

  test("★ 多键组合过滤（chatId + type，即 ensureChatSession 的真实形状）", async () => {
    const store = new SQLiteSessionStore(dbPath);
    await store.initialize();
    await store.create({
      id: "oc_multi",
      title: "群",
      metadata: { chatId: "oc_multi", type: "lark-chat" },
    } as never);
    // 干扰项：同 chatId 但 type 不同
    await store.create({
      id: "oc_multi_other",
      title: "别的",
      metadata: { chatId: "oc_multi", type: "cli-chat" },
    } as never);

    const hit = await store.list({
      filter: { metadata: { chatId: "oc_multi", type: "lark-chat" } },
    });
    expect(hit.map((s) => s.id)).toEqual(["oc_multi"]);
  });

  test("数字字段也能命中（JSON.stringify 同样会把它变成字符串）", async () => {
    const store = new SQLiteSessionStore(dbPath);
    await store.initialize();
    await store.create({
      id: "s_num",
      title: "n",
      metadata: { chatId: "x", shard: 7 },
    } as never);

    const hit = await store.list({ filter: { metadata: { shard: 7 } } });
    expect(hit.map((s) => s.id)).toEqual(["s_num"]);
    const miss = await store.list({ filter: { metadata: { shard: 8 } } });
    expect(miss).toEqual([]);
  });

  test("布尔字段也能命中", async () => {
    const store = new SQLiteSessionStore(dbPath);
    await store.initialize();
    await store.create({
      id: "s_bool",
      title: "b",
      metadata: { chatId: "y", pinned: true },
    } as never);

    expect(
      (await store.list({ filter: { metadata: { pinned: true } } })).map((s) => s.id),
    ).toEqual(["s_bool"]);
    // JSON 里 true 存成 1，查 false 不能把 true 的算进来
    expect(await store.list({ filter: { metadata: { pinned: false } } })).toEqual([]);
  });

  test("字段不存在时不命中（不能因为 JSON.stringify(undefined) 这类意外而误判）", async () => {
    const store = new SQLiteSessionStore(dbPath);
    await store.initialize();
    await store.create({ id: "s_plain", title: "p", metadata: {} } as never);

    expect(await store.list({ filter: { metadata: { chatId: "nope" } } })).toEqual([]);
  });

  test("复合类型（object）：同 key 顺序可命中；key 顺序不同不命中（已文档化的固有限制）", async () => {
    // CV R3 M1/M2：raw 绑定会让对象变成 SQL NULL、数组直接抛
    // `expected 1 values, received N`。改为复合类型走 json() 规范化两侧。
    //
    // ⚠️ 已知限制（实测确认）：SQLite 的 `json()` **不会对 key 排序**
    //   （`json('{"b":2,"a":1}')` → `{"b":2,"a":1}`），所以 key 顺序不同的
    //   等价对象**仍不会命中**。做到顺序无关需 json_tree 逐 key 比较，
    //   成本远高于收益 —— 全仓唯一生产调用是 `{chatId, type}`（纯字符串）。
    //   本用例把这条限制**锁定**下来，避免日后误以为它支持顺序无关。
    const store = new SQLiteSessionStore(dbPath);
    await store.initialize();
    await store.create({
      id: "s_obj",
      title: "o",
      metadata: { chatId: "z", deep: { a: 1, b: 2 } },
    } as never);

    expect(
      (await store.list({ filter: { metadata: { deep: { a: 1, b: 2 } } } })).map((s) => s.id),
    ).toEqual(["s_obj"]);
    // key 顺序不同 ⇒ 已知限制：不命中（锁定行为）
    expect(await store.list({ filter: { metadata: { deep: { b: 2, a: 1 } } } })).toEqual([]);
    // 真正不等 ⇒ 不命中
    expect(await store.list({ filter: { metadata: { deep: { a: 9 } } } })).toEqual([]);
  });

  test("数组类型不再抛异常，且能正确命中/不命中", async () => {
    const store = new SQLiteSessionStore(dbPath);
    await store.initialize();
    await store.create({
      id: "s_arr",
      title: "a",
      metadata: { chatId: "w", tags: [1, 2] },
    } as never);

    expect(
      (await store.list({ filter: { metadata: { tags: [1, 2] } } })).map((s) => s.id),
    ).toEqual(["s_arr"]);
    expect(await store.list({ filter: { metadata: { tags: [1, 3] } } })).toEqual([]);
  });
});

describe("Task #5390 P0：Memory 与 SQLite 过滤语义一致", () => {
  test("同一组 metadata 过滤，两个后端返回相同 id 集合", async () => {
    const sqlite = new SQLiteSessionStore(dbPath);
    await sqlite.initialize();
    const memory = new MemorySessionStore();

    const seeds = [
      { id: "a1", metadata: { chatId: "oc_same", type: "lark-chat", n: 1 } },
      { id: "a2", metadata: { chatId: "oc_same", type: "cli-chat" } },
      { id: "a3", metadata: { chatId: "oc_other", type: "lark-chat" } },
    ];
    for (const s of seeds) {
      await sqlite.create({ id: s.id, title: s.id, metadata: s.metadata } as never);
      await memory.create({ id: s.id, title: s.id, metadata: s.metadata } as never);
    }

    const filters = [
      { chatId: "oc_same" },
      { chatId: "oc_same", type: "lark-chat" },
      { n: 1 },
    ];
    for (const f of filters) {
      const a = (await sqlite.list({ filter: { metadata: f } })).map((s) => s.id).sort();
      const b = (await memory.list({ filter: { metadata: f } })).map((s) => s.id).sort();
      expect(a).toEqual(b);
    }
  });
});