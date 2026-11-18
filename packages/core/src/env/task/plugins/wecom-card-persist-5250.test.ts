/**
 * @fileoverview Task #5250 — 企微卡片持久化 + 「刷新详情」可重复点击
 *
 * ## 目标 1：持久化重启恢复
 *
 * 用户明令（08:10）：卡片状态像 lark-cli 一样持久化，
 * 重启 daemon 后 task_id 映射不丢。
 * SqliteWecomCardStateStore 已存在（#5193），但缺：
 * - 跨实例（close → 重开）恢复测试（映射/时间线完整性）
 * - createWecomCardStateStore 显式路径 → SQLite 实例断言
 *
 * ## 目标 2：「刷新详情」可重复点击
 *
 * 「查看详情」改「刷新详情」：
 * - deliverTemplateCard 改发 button_interaction 卡（带刷新按钮）
 * - view 刷新后按钮仍可点击（不再替换成死的「已处理」）
 * - 连续两次 view 点击 → 两次 updateCard 均成功
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createWecomCardStateStore,
  SqliteWecomCardStateStore,
} from "./wecom-card-state-store";

describe("Task #5250 — SqliteWecomCardStateStore 重启恢复", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wecom-cards-5250-"));
    dbPath = join(dir, "wecom-cards.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function sampleRecord(taskId: number) {
    return {
      taskId,
      chatId: "DongZhaoKun",
      pinned: false,
      status: "open" as const,
      createdAt: 1700000000000,
      updatedAt: 1700000001000,
      updateCount: 3,
      timeline: JSON.stringify([
        { title: "Task 创建", timestamp: "2026-11-10T00:00:00Z" },
        { title: "M1 GREEN", timestamp: "2026-11-10T01:00:00Z" },
      ]),
    };
  }

  it("写入 → close → 重开新实例 → 映射完整恢复（重启不丢）", () => {
    // 第一"次运行"
    const store1 = new SqliteWecomCardStateStore(dbPath);
    store1.upsert(sampleRecord(101));
    store1.upsert(sampleRecord(102));
    store1.close();

    // "重启"后：新实例从磁盘恢复
    const store2 = new SqliteWecomCardStateStore(dbPath);
    const rec101 = store2.get(101);
    expect(rec101).toBeDefined();
    expect(rec101!.chatId).toBe("DongZhaoKun");
    expect(rec101!.status).toBe("open");
    expect(rec101!.updateCount).toBe(3);
    // 时间线完整恢复（刷新详情的数据源）
    const timeline = JSON.parse(rec101!.timeline ?? "[]");
    expect(timeline).toHaveLength(2);
    expect(timeline[0].title).toBe("Task 创建");

    // list 全量恢复
    const all = store2.list();
    expect(all.map((r) => r.taskId).sort()).toEqual([101, 102]);

    // 恢复后仍可写（touch / markClosed）
    store2.markClosed(101);
    expect(store2.get(101)!.status).toBe("closed");
    store2.close();
  });

  it("重启恢复后 markReopened / markPaused 状态机正常", () => {
    const store1 = new SqliteWecomCardStateStore(dbPath);
    store1.upsert(sampleRecord(201));
    store1.markClosed(201);
    store1.close();

    const store2 = new SqliteWecomCardStateStore(dbPath);
    expect(store2.get(201)!.status).toBe("closed");
    store2.markReopened(201);
    const rec = store2.get(201)!;
    expect(rec.status).toBe("open");
    expect(rec.closedAt).toBeUndefined();
    store2.markPaused(201);
    expect(store2.get(201)!.status).toBe("paused");
    store2.close();
  });
});

describe("Task #5250 — createWecomCardStateStore 工厂（显式路径 → SQLite）", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wecom-cards-5250-f-"));
    dbPath = join(dir, "wecom-cards.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("显式路径 → SqliteWecomCardStateStore 实例（可持久）", () => {
    const store = createWecomCardStateStore(dbPath);
    expect(store).toBeInstanceOf(SqliteWecomCardStateStore);
    store.upsert({
      taskId: 301,
      chatId: "u1",
      pinned: false,
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      updateCount: 1,
    });
    const store2 = createWecomCardStateStore(dbPath);
    expect(store2.get(301)?.chatId).toBe("u1");
    store.close();
    store2.close();
  });
});
