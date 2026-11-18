/**
 * @fileoverview RED tests: SQLiteTaskStore supports milestone_* fields + action_* deprecated alias
 *
 * 目标：
 * 1) SQLiteTaskStore.createOperation 接受 milestoneType/Title/Description + processDescription
 * 2) SQLiteTaskStore.createOperation 接受 actionType/Title/Description（向后兼容，自动映射到 milestone_* + log deprecation）
 * 3) rowToOperation 输出同时包含 milestone_* 与 action_* (deprecated alias)
 * 4) listOperations filter 支持 milestoneType 与 actionType 两种字段名（兼容）
 * 5) searchTasksByKeywords 搜索 milestone 类型三字段与 action 类型三字段（兼容）
 * 6) updateOperation 支持 milestoneTitle/Description 与 actionTitle/Description 两种字段
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { SQLiteTaskStore } from "./sqlite-task-store";

describe("SQLiteTaskStore: milestone_* schema + action_* deprecated alias", () => {
  let store: SQLiteTaskStore;
  let taskId: number;

  beforeEach(async () => {
    store = new SQLiteTaskStore(":memory:");
    const t = await store.createTask({
      title: "Test Task",
      sessionId: "test-session",
      project_path: "unknown",
      context: "{}",
    });
    taskId = t.id;
  });

  afterEach(async () => {
    await store.close();
  });

  // --------------------------------------------------------------------------
  // 1. milestone_* 主字段写入/读取
  // --------------------------------------------------------------------------

  it("createOperation accepts milestoneType/Title/Description (canonical)", async () => {
    const op = await store.createOperation({
      taskId,
      sessionId: "test-session",
      milestoneType: "progress",
      milestoneTitle: "🎯 GREEN 通过：milestone schema",
      milestoneDescription: "milestone_* 字段全链路打通，6/6 单元测试通过",
      processDescription: "RED 先写失败测试（4 个）→ 创建迁移 004 → ALTER TABLE RENAME COLUMN 改 schema → 跑全链路 storage 与 tool 测试 → GREEN。保留数据 + 幂等 + 升级路径",
    } as any);

    expect(op.id).toBeGreaterThan(0);
    expect(op.milestoneType).toBe("progress");
    expect(op.milestoneTitle).toBe("🎯 GREEN 通过：milestone schema");
    expect(op.milestoneDescription).toBe("milestone_* 字段全链路打通，6/6 单元测试通过");
    expect(op.processDescription.length).toBeGreaterThanOrEqual(100);
  });

  it("createOperation: rowToOperation output includes BOTH milestone_* and action_* (deprecated alias)", async () => {
    const op = await store.createOperation({
      taskId,
      sessionId: "test-session",
      milestoneType: "milestone",
      milestoneTitle: "Schema rename complete",
      milestoneDescription: "action_* -> milestone_*",
    } as any);

    // 主字段
    expect(op.milestoneType).toBe("milestone");
    expect(op.milestoneTitle).toBe("Schema rename complete");
    expect(op.milestoneDescription).toBe("action_* -> milestone_*");

    // 兼容 alias（deprecated）
    // @ts-ignore - 访问 deprecated alias 验证兼容
    expect(op.actionType).toBe("milestone");
    // @ts-ignore - 访问 deprecated alias 验证兼容
    expect(op.actionTitle).toBe("Schema rename complete");
    // @ts-ignore - 访问 deprecated alias 验证兼容
    expect(op.actionDescription).toBe("action_* -> milestone_*");
  });

  // --------------------------------------------------------------------------
  // 2. action_* 兼容写入（DB 层保留 action_* 输入但写入时自动映射到 milestone_*）
  // --------------------------------------------------------------------------

  it("createOperation: legacy action_* parameters are coerced into milestone_* (storage layer compat)", async () => {
    const op = await store.createOperation({
      taskId,
      sessionId: "test-session",
      actionType: "decision",         // 旧字段
      actionTitle: "Legacy decision",
      actionDescription: "Legacy desc",
      processDescription: "旧 action_* 字段路径：直接落到 milestone_* 列；storage 不拒绝，rowToOperation 同时输出两套字段兼容旧调用方",
    } as any);

    // 主字段必须有值
    expect(op.milestoneType).toBe("decision");
    expect(op.milestoneTitle).toBe("Legacy decision");
    expect(op.milestoneDescription).toBe("Legacy desc");
    // alias 也保留
    // @ts-ignore - deprecated alias
    expect(op.actionType).toBe("decision");
  });

  // --------------------------------------------------------------------------
  // 3. listOperations 兼容 milestoneType 与 actionType
  // --------------------------------------------------------------------------

  it("listOperations filter by milestoneType", async () => {
    await store.createOperation({ taskId, sessionId: "s1", milestoneType: "milestone", milestoneTitle: "M1" } as any);
    await store.createOperation({ taskId, sessionId: "s2", milestoneType: "progress", milestoneTitle: "P1" } as any);
    await store.createOperation({ taskId, sessionId: "s3", milestoneType: "milestone", milestoneTitle: "M2" } as any);

    const milestoneOps = await store.listOperations({ taskId, milestoneType: "milestone" } as any);
    expect(milestoneOps.length).toBe(2);
    milestoneOps.forEach((op) => expect(op.milestoneType).toBe("milestone"));
  });

  it("listOperations filter by actionType (deprecated) also works", async () => {
    await store.createOperation({ taskId, sessionId: "s1", milestoneType: "milestone", milestoneTitle: "M1" } as any);
    await store.createOperation({ taskId, sessionId: "s2", milestoneType: "progress", milestoneTitle: "P1" } as any);

    // @ts-ignore - deprecated alias alias
    const milestoneOps = await store.listOperations({ taskId, actionType: "milestone" });
    expect(milestoneOps.length).toBe(1);
    expect(milestoneOps[0].milestoneType).toBe("milestone");
  });

  // --------------------------------------------------------------------------
  // 4. updateOperation 兼容 milestone* 与 action* 两种字段
  // --------------------------------------------------------------------------

  it("updateOperation accepts milestoneTitle/Description", async () => {
    const op = await store.createOperation({
      taskId, sessionId: "s", milestoneType: "progress", milestoneTitle: "Original"
    } as any);

    const updated = await store.updateOperation(op.id, {
      milestoneTitle: "Updated via milestone_*",
      milestoneDescription: "New desc",
    } as any);

    expect(updated).toBeDefined();
    expect(updated!.milestoneTitle).toBe("Updated via milestone_*");
    expect(updated!.milestoneDescription).toBe("New desc");
  });

  it("updateOperation accepts actionTitle/Description (deprecated alias, auto-mapped)", async () => {
    const op = await store.createOperation({
      taskId, sessionId: "s", milestoneType: "progress", milestoneTitle: "Original"
    } as any);

    const updated = await store.updateOperation(op.id, {
      actionTitle: "Updated via legacy action_*",
      actionDescription: "Legacy desc",
    } as any);

    expect(updated).toBeDefined();
    // 主字段被同步更新
    expect(updated!.milestoneTitle).toBe("Updated via legacy action_*");
    expect(updated!.milestoneDescription).toBe("Legacy desc");
  });

  // --------------------------------------------------------------------------
  // 5. searchTasksByKeywords 兼容 milestone_* 与 action_*
  // --------------------------------------------------------------------------

  it("searchTasksByKeywords matches milestone_title content (canonical)", async () => {
    const op = await store.createOperation({
      taskId, sessionId: "s", milestoneType: "milestone",
      milestoneTitle: "搜索关键字标记-xyz",
      milestoneDescription: "",
    } as any);
    void op;

    const { tasks } = await store.searchTasksByKeywords(["xyz"]);
    expect(tasks.length).toBeGreaterThan(0);
    expect(tasks[0].id).toBe(taskId);
  });
});
