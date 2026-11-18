/**
 * @fileoverview 存量 checkpoint 适配（C 方案 Task #4933）
 *
 * 生产库 `~/.local/share/roy-bot/sessions.db` 有 555 个 checkpoint 全是旧格式
 * （summary / processKeyPoints / currentState / nextSteps / userIntents 五栏位，
 * 没有 content）。
 *
 * 适配策略（用户点名要求）：
 *   1. **读时适配（核心，默认行为）**：getCheckpoints / getCheckpoint /
 *      getContext 读到旧格式时在内存中合成 content，**不写回数据库**。
 *   2. **显式迁移**：`adaptStoredCheckpoints(sessionId, { apply: true })`
 *      把旧格式写回为新格式。默认 dry-run（apply=false）。
 *      ⚠️ daemon 持有 sessions.db 内存缓存，外部进程直写可能被覆盖 ——
 *      所以默认不批量写库，apply 需显式指定且建议在 daemon 重启后执行。
 *   3. **绝不**无备份写、不 truncate、不 drop。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

import { SessionComponent } from "./session-component";
import { ConfigComponent } from "../../config/config-component";
import type { Environment } from "../interface";
import type { SessionCheckpoint } from "./types";

function createTempDbPath(): string {
  return path.join(
    os.tmpdir(),
    `test-adapt-cp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`
  );
}

async function cleanupTempDb(dbPath: string): Promise<void> {
  try { await fsSync.promises.unlink(dbPath); } catch {}
  try { await fsSync.promises.unlink(`${dbPath}-wal`); } catch {}
  try { await fsSync.promises.unlink(`${dbPath}-shm`); } catch {}
}

/** 造一个旧格式 checkpoint 对象（五栏位，无 content） */
function makeLegacyCheckpoint(id: string, index = 0): Record<string, unknown> {
  return {
    id,
    messageIndex: index,
    title: `旧格式 ${id}`,
    summary: "Process: 实现了 A，发现了 B\nState: 正在做 C",
    processKeyPoints: ["关键发现甲，内容要足够长", "关键决策乙"],
    currentState: "当前状态：正在做 C，卡在 D。",
    nextSteps: ["后续步骤一", "后续步骤二"],
    userIntents: ["用户的意图"],
    messageCountBefore: 100,
    createdAt: 1700000000000 + index,
    type: "compact",
  };
}

describe("存量 checkpoint 适配（C 方案）", () => {
  let component: SessionComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let tempDbPath: string;

  beforeEach(() => {
    component = new SessionComponent();
    configComponent = new ConfigComponent();
    tempDbPath = createTempDbPath();
    mockEnv = {
      name: "test-env",
      version: "1.0.0",
      getComponent: vi.fn((name: string) => {
        if (name === "config") return configComponent;
        return undefined;
      }),
      hasComponent: vi.fn((name: string) => name === "config"),
      logger: vi.fn(),
      trace: vi.fn(),
    } as unknown as Environment;
  });

  afterEach(async () => {
    if (component.getStatus() !== "stopped") {
      try { await component.stop(); } catch {}
    }
    await cleanupTempDb(tempDbPath);
  });

  async function initAndSeed(legacyCount = 2) {
    await component.init({
      env: mockEnv,
      options: {
        configComponent,
        config: { storage: { type: "sqlite", dbPath: tempDbPath } },
      },
    });
    const session = await component.create({ title: "legacy session" });
    // 直接通过 store 写入旧格式 checkpoint（模拟生产库里的存量数据）
    const store = (component as any).store;
    for (let i = 0; i < legacyCount; i++) {
      await store.saveCheckpoint(session.id, makeLegacyCheckpoint(`cp_legacy_${i}`, i) as unknown as SessionCheckpoint);
    }
    return session;
  }

  it("读时适配：getCheckpoints 返回新形态（有 content，无五栏位依赖），数据库未改", async () => {
    const session = await initAndSeed(2);

    const cps = await component.getCheckpoints(session.id);
    expect(cps.length).toBe(2);
    for (const cp of cps) {
      expect(typeof cp.content).toBe("string");
      expect(cp.content.length).toBeGreaterThan(20);
      expect(cp.content).toContain("关键发现甲");
      expect(cp.content).toContain("正在做 C");
      expect(cp.content).toContain("后续步骤一");
      expect(cp.content).toContain("用户的意图");
    }

    // 数据库里的原始 JSON 仍是旧格式（读时适配不写回）
    const store = (component as any).store;
    const raw = await store.getCheckpoints(session.id);
    const rawCp = raw[0] as unknown as Record<string, unknown>;
    expect(rawCp.content).toBeUndefined();
    expect(rawCp.processKeyPoints).toBeDefined();
  });

  it("读时适配：getCheckpoint 单条读取同样适配", async () => {
    const session = await initAndSeed(1);
    const cp = await component.getCheckpoint(session.id, "cp_legacy_0");
    expect(cp).toBeDefined();
    expect(cp!.content).toContain("关键发现甲");
  });

  it("adaptStoredCheckpoints（默认 dry-run）：只报告不写库", async () => {
    const session = await initAndSeed(3);

    const report = await component.adaptStoredCheckpoints(session.id);
    expect(report.total).toBe(3);
    expect(report.legacy).toBe(3);
    expect(report.modern).toBe(0);
    expect(report.applied).toBe(0); // dry-run 不写
    expect(report.samples.length).toBeGreaterThan(0);
    expect(report.samples[0].contentPreview.length).toBeGreaterThan(0);

    // 数据库未变
    const store = (component as any).store;
    const raw = await store.getCheckpoints(session.id);
    expect((raw[0] as unknown as Record<string, unknown>).content).toBeUndefined();
  });

  it("adaptStoredCheckpoints({apply:true})：写回新格式，content 落库且五栏位清除", async () => {
    const session = await initAndSeed(3);

    const report = await component.adaptStoredCheckpoints(session.id, { apply: true });
    expect(report.applied).toBe(3);
    expect(report.legacy).toBe(3);

    // 数据库已变：新格式
    const store = (component as any).store;
    const raw = await store.getCheckpoints(session.id);
    expect(raw.length).toBe(3);
    for (const cp of raw) {
      const o = cp as unknown as Record<string, unknown>;
      expect(typeof o.content).toBe("string");
      expect((o.content as string).length).toBeGreaterThan(20);
      expect(o.processKeyPoints).toBeUndefined();
      expect(o.currentState).toBeUndefined();
      expect(o.summary).toBeUndefined();
    }
  });

  it("adaptStoredCheckpoints：混合格式时只统计旧格式，新格式不动", async () => {
    const session = await initAndSeed(2);
    // 再插一条新格式
    const store = (component as any).store;
    await store.saveCheckpoint(session.id, {
      id: "cp_new",
      messageIndex: 9,
      title: "新格式",
      content: "这是新格式的整段自然语言正文，长度超过阈值，不需要适配。",
      messageCountBefore: 10,
      createdAt: Date.now(),
      type: "compact",
    } as SessionCheckpoint);

    const report = await component.adaptStoredCheckpoints(session.id, { apply: true });
    expect(report.total).toBe(3);
    expect(report.legacy).toBe(2);
    expect(report.modern).toBe(1);
    expect(report.applied).toBe(2);

    const raw = await store.getCheckpoints(session.id);
    const newOne = raw.find((c: any) => c.id === "cp_new") as unknown as Record<string, unknown>;
    // 新格式原样保留
    expect(newOne.content).toBe("这是新格式的整段自然语言正文，长度超过阈值，不需要适配。");
  });

  it("adaptStoredCheckpoints：无 checkpoint 的 session 返回全 0 报告", async () => {
    const session = await initAndSeed(0);
    const report = await component.adaptStoredCheckpoints(session.id);
    expect(report.total).toBe(0);
    expect(report.legacy).toBe(0);
    expect(report.applied).toBe(0);
    expect(report.samples).toEqual([]);
  });

  it("readStoredCheckpointsRaw：能读到未适配的原始形态（供检查脚本用）", async () => {
    const session = await initAndSeed(2);
    const raw = await component.readStoredCheckpointsRaw(session.id);
    expect(raw.length).toBe(2);
    const o = raw[0] as unknown as Record<string, unknown>;
    expect(o.content).toBeUndefined();
    expect(o.processKeyPoints).toBeDefined();
  });
});

/**
 * ★ Review MINOR-2（Task #4933 收尾修复）：`getContext()` 的 startCheckpoint
 * 也必须走 adaptLegacyCheckpoint。
 *
 * 缺陷现场：getContext 内部 `this.store!.getCheckpoint(...)` 绕过了
 * SessionComponent.getCheckpoint() 的适配层 → 旧格式下 ctx.startCheckpoint
 * 的 `content === undefined`（违反必填 string 类型契约），且泄露旧五栏位。
 * 这是 resume 路径上的真实缺陷（resume 就是靠 getContext 拿 startCheckpoint）。
 */
describe("resume 路径适配：getContext().startCheckpoint 必须适配旧格式", () => {
  let component: SessionComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let tempDbPath: string;

  beforeEach(() => {
    component = new SessionComponent();
    configComponent = new ConfigComponent();
    tempDbPath = createTempDbPath();
    mockEnv = {
      name: "test-env",
      version: "1.0.0",
      getComponent: vi.fn((n: string) => (n === "config" ? configComponent : undefined)),
      hasComponent: vi.fn((n: string) => n === "config"),
      logger: vi.fn(),
      trace: vi.fn(),
    } as unknown as Environment;
  });

  afterEach(async () => {
    if (component.getStatus() !== "stopped") {
      try { await component.stop(); } catch {}
    }
    await cleanupTempDb(tempDbPath);
  });

  it("旧格式 checkpoint：getContext 返回的 startCheckpoint 有 content、无五栏位残留", async () => {
    await component.init({
      env: mockEnv,
      options: {
        configComponent,
        config: { storage: { type: "sqlite", dbPath: tempDbPath } },
      },
    });
    const session = await component.create({ title: "legacy resume" });
    const store = (component as any).store;

    // 预置 25 条消息，再在 index=10 处放一个旧格式 checkpoint
    for (let i = 0; i < 25; i++) {
      await store.addMessage(session.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `msg ${i}`,
      });
    }
    await store.saveCheckpoint(
      session.id,
      makeLegacyCheckpoint("cp_legacy_resume", 10) as unknown as SessionCheckpoint
    );
    // 让 getContext 走 checkpoint 快路径
    await component.update(session.id, {
      metadata: { checkpoints: { latestCheckpointId: "cp_legacy_resume" } },
    } as any);

    const ctx = await component.getContext(session.id);

    // ★ 核心断言 1：startCheckpoint 必须存在且 content 是字（不能被绕过适配）
    expect(ctx.startCheckpoint).toBeDefined();
    expect(typeof ctx.startCheckpoint!.content).toBe("string");
    expect(ctx.startCheckpoint!.content.length).toBeGreaterThan(20);
    expect(ctx.startCheckpoint!.content).toContain("关键发现甲");
    expect(ctx.startCheckpoint!.content).toContain("后续步骤一");

    // ★ 核心断言 2：不得残留旧五栏位字段
    const asRec = ctx.startCheckpoint as unknown as Record<string, unknown>;
    expect(asRec.processKeyPoints).toBeUndefined();
    expect(asRec.currentState).toBeUndefined();
    expect(asRec.nextSteps).toBeUndefined();
    expect(asRec.userIntents).toBeUndefined();

    // 元数据保留
    expect(ctx.startCheckpoint!.title).toBe("旧格式 cp_legacy_resume");
    expect(ctx.startCheckpoint!.messageIndex).toBe(10);
  });
});
