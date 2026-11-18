/**
 * @fileoverview Buffer description defensive handling tests (Task #2226)
 *
 * Bug: `task_search` 工具调用时，DB 存储为 BLOB 的 description 字段经
 * better-sqlite3 / bun:sqlite 读出为 Buffer 对象（truthy 但无 toLowerCase），
 * `searchTasksByKeywords` 中 `if (task.description)` truthy 检查绕过 null guard，
 * 随后 `task.description.toLowerCase()` 抛 TypeError。
 *
 * Fix contract:
 *   - `rowToTask` 对所有字符串字段做 `String(row.xxx ?? '')` 防御性转换
 *   - `searchTasksByKeywords` 中 `if (task.description)` 改为
 *     `if (typeof task.description === 'string' && task.description)`
 *
 * RED 阶段：所有 3 个测试必须在未修复前失败；GREEN 阶段应全部通过。
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { SQLiteTaskStore } from "./sqlite-task-store";

describe("SQLiteTaskStore Buffer description handling (Task #2226)", () => {
  let store: SQLiteTaskStore;

  beforeEach(async () => {
    store = new SQLiteTaskStore(":memory:");
  });

  afterEach(async () => {
    await store.close();
  });

  // --------------------------------------------------------------------------
  // Test 1: rowToTask converts Buffer description to string
  // --------------------------------------------------------------------------
  test("RED-1: rowToTask converts Buffer description to string", () => {
    // 直接构造一个 row，模拟 BLOB 列读出的 Buffer 值
    const bufferDesc = Buffer.from(
      "This description was stored as BLOB and read back as Buffer",
      "utf-8",
    );

    const task = (store as unknown as { rowToTask: (row: any) => any }).rowToTask({
      id: 1,
      title: "Buffer task",
      description: bufferDesc,
      status: "todo",
      priority: "medium",
      type: "normal",
      progress: 0,
      current_status: null,
      goals_and_expected_deliverables: null,
      parent_task_id: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      due_date: null,
      tags: null,
      project_path: "unknown",
      context: "{}",
    });

    // 行 1 核心断言：description 必须是 string 而非 Buffer
    expect(typeof task.description).toBe("string");
    expect(task.description).toBe(
      "This description was stored as BLOB and read back as Buffer",
    );
  });

  // --------------------------------------------------------------------------
  // Test 2: searchTasksByKeywords does not throw on Buffer description in DB
  // --------------------------------------------------------------------------
  test("RED-2: searchTasksByKeywords does not throw on Buffer description", async () => {
    // 1) 创建一个正常 task（description 写入时是 string）
    const created = await store.createTask({
      parent_task_id: 1,
      title: "Search with buffer desc",
      description: "Normal description at insert time",
      sessionId: "test",
      project_path: "unknown",
      context: "{}",
    });

    // 2) 用 raw SQL 把 description 改为 Buffer（模拟 BLOB 列读出）
    (store as unknown as { db: { prepare: (sql: string) => { run: (...args: any[]) => any } } }).db
      .prepare("UPDATE task SET description = ? WHERE id = ?")
      .run(Buffer.from("Buffer description from BLOB column", "utf-8"), created.id);

    // 3) 核心断言：searchTasksByKeywords 不抛 TypeError
    let threw: unknown = null;
    let result: { tasks: unknown[]; total: number } | undefined;
    try {
      result = await store.searchTasksByKeywords(["buffer"]);
    } catch (e) {
      threw = e;
    }

    expect(threw).toBeNull();
    expect(result).toBeDefined();
    // 应当找到那条被改写 description 的 task（搜索按 title 命中）
    expect(result!.tasks.length).toBeGreaterThanOrEqual(1);
  });

  // --------------------------------------------------------------------------
  // Test 3: rowToTask handles null/undefined description safely
  // --------------------------------------------------------------------------
  test("RED-3: rowToTask returns empty string for null/undefined description", () => {
    const task = (store as unknown as { rowToTask: (row: any) => any }).rowToTask({
      id: 1,
      title: "Null desc",
      description: null,
      status: "todo",
      priority: "medium",
      type: "normal",
      progress: 0,
      current_status: null,
      goals_and_expected_deliverables: null,
      parent_task_id: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      due_date: null,
      tags: null,
      project_path: "unknown",
      context: "{}",
    });

    expect(typeof task.description).toBe("string");
    expect(task.description).toBe("");
  });

  // --------------------------------------------------------------------------
  // Test 4: rowToTask converts Buffer in title and goals to string too
  // --------------------------------------------------------------------------
  test("RED-4: rowToTask defensively coerces Buffer in title and goals", () => {
    const task = (store as unknown as { rowToTask: (row: any) => any }).rowToTask({
      id: 1,
      title: Buffer.from("Title stored as BLOB", "utf-8"),
      description: Buffer.from("Desc as BLOB", "utf-8"),
      status: "todo",
      priority: "medium",
      type: "normal",
      progress: 0,
      current_status: null,
      goals_and_expected_deliverables: Buffer.from("Goals as BLOB", "utf-8"),
      parent_task_id: null,
      created_at: Date.now(),
      updated_at: Date.now(),
      due_date: null,
      tags: null,
      project_path: "unknown",
      context: "{}",
    });

    expect(typeof task.title).toBe("string");
    expect(task.title).toBe("Title stored as BLOB");
    expect(typeof task.description).toBe("string");
    expect(task.description).toBe("Desc as BLOB");
    expect(typeof task.goals_and_expected_deliverables).toBe("string");
    expect(task.goals_and_expected_deliverables).toBe("Goals as BLOB");
  });
});
