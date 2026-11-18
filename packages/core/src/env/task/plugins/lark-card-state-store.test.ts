/**
 * @fileoverview LarkCardStateStore 单测（TDD RED 先行）
 *
 * 目标：把「任务进展卡片」的 messageId / chatId / profile / pin 状态
 * **持久化**下来，让 roy-bot 进程重启后仍能 patch 同一张卡片。
 *
 * 设计选型（见 Task #4536 决策记录）：
 * - 独立 SQLite 库文件（`~/.local/share/roy-bot/lark-cards.db`），
 *   **不写 task.context**（写 context 会同步触发 task:after.update → 插件重入；
 *   且 context 会被渲染进卡片正文，messageId 会污染用户可见内容）。
 * - 复用 `createCompatibleDatabase`（bun:sqlite / better-sqlite3 双运行时）。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  SqliteLarkCardStateStore,
  MemoryLarkCardStateStore,
  type LarkCardStateStore,
  type LarkCardState,
} from "./lark-card-state-store";

function makeState(overrides: Partial<LarkCardState> = {}): LarkCardState {
  return {
    taskId: 42,
    messageId: "om_card_1",
    chatId: "oc_chat_1",
    profile: "prof-a",
    pinned: true,
    status: "open",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

// ============================================================================
// 两个实现共用同一套契约
// ============================================================================

function contractTests(name: string, makeStore: () => LarkCardStateStore) {
  describe(`${name} — LarkCardStateStore contract`, () => {
    let store: LarkCardStateStore;

    beforeEach(() => {
      store = makeStore();
    });

    afterEach(() => {
      store.close();
    });

    it("upsert + get 往返", () => {
      store.upsert(makeState());
      const got = store.get(42);
      expect(got).toBeDefined();
      expect(got!.taskId).toBe(42);
      expect(got!.messageId).toBe("om_card_1");
      expect(got!.chatId).toBe("oc_chat_1");
      expect(got!.profile).toBe("prof-a");
      expect(got!.pinned).toBe(true);
      expect(got!.status).toBe("open");
    });

    it("upsert 同 taskId 覆盖（不产生第二行）", () => {
      store.upsert(makeState({ messageId: "om_card_1" }));
      store.upsert(makeState({ messageId: "om_card_2" }));
      expect(store.get(42)!.messageId).toBe("om_card_2");
      expect(store.list().length).toBe(1);
    });

    it("get 未存在的 taskId → undefined（不抛错）", () => {
      expect(store.get(999)).toBeUndefined();
    });

    it("markPinned 只改 pinned + updatedAt", () => {
      store.upsert(makeState({ pinned: true, updatedAt: 1 }));
      store.markPinned(42, false);
      const got = store.get(42)!;
      expect(got.pinned).toBe(false);
      expect(got.messageId).toBe("om_card_1");
      expect(got.updatedAt).toBeGreaterThan(1);
    });

    it("markClosed 记 status=closed + closedAt，并保留记录（可追溯）", () => {
      store.upsert(makeState());
      store.markClosed(42);
      const got = store.get(42)!;
      expect(got.status).toBe("closed");
      expect(typeof got.closedAt).toBe("number");
      // 关键：不删除 —— 保留 messageId 供事后追溯
      expect(got.messageId).toBe("om_card_1");
      expect(store.list().length).toBe(1);
    });

    it("markReopened 把 paused 记录翻回 open 并清掉 closedAt", () => {
      store.upsert(makeState());
      store.markClosed(42);
      store.markReopened(42);
      const got = store.get(42)!;
      expect(got.status).toBe("open");
      expect(got.closedAt).toBeUndefined();
    });

    it("markPaused 记 status=paused（保留 messageId 供 resume 复用）", () => {
      store.upsert(makeState());
      store.markPaused(42);
      const got = store.get(42)!;
      expect(got.status).toBe("paused");
      expect(got.messageId).toBe("om_card_1");
    });

    it("delete 真删除", () => {
      store.upsert(makeState());
      store.delete(42);
      expect(store.get(42)).toBeUndefined();
      expect(store.list().length).toBe(0);
    });

    it("list 返回全部记录", () => {
      store.upsert(makeState({ taskId: 1 }));
      store.upsert(makeState({ taskId: 2, messageId: "om_2" }));
      const all = store.list();
      expect(all.length).toBe(2);
      expect(all.map((s) => s.taskId).sort()).toEqual([1, 2]);
    });
  });
}

contractTests("MemoryLarkCardStateStore", () => new MemoryLarkCardStateStore());

// SQLite 实现也必须通过**同一套**契约 —— 否则它的 markPinned / markClosed 等方法
// 变成 no-op 测试也不会红（破坏性自检抓出的假绿，2026-10-25）。
contractTests("SqliteLarkCardStateStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "lark-card-contract-"));
  const store = new SqliteLarkCardStateStore(join(dir, "contract.db"));
  // 复用 afterEach 的 close()，目录由 /tmp 清理（测试进程生命周期内足够）
  return store;
});

// ============================================================================
// SQLite 实现：额外验证「跨实例可见」= 重启恢复的本质
// ============================================================================

describe("SqliteLarkCardStateStore — 跨实例持久化（模拟进程重启）", () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lark-card-state-"));
    dbPath = join(dir, "lark-cards.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("实例 A 写入 → close → 实例 B 从同一文件读回（重启恢复核心）", () => {
    const a = new SqliteLarkCardStateStore(dbPath);
    a.upsert(makeState());
    a.close();

    const b = new SqliteLarkCardStateStore(dbPath);
    const got = b.get(42);
    b.close();

    expect(got).toBeDefined();
    expect(got!.messageId).toBe("om_card_1");
    expect(got!.pinned).toBe(true);
  });

  it("构造时自动建目录 + 建表（新库路径直接可用）", () => {
    const nested = join(dir, "a", "b", "cards.db");
    const s = new SqliteLarkCardStateStore(nested);
    s.upsert(makeState({ taskId: 7, messageId: "om_7" }));
    expect(s.get(7)!.messageId).toBe("om_7");
    s.close();
  });

  it("重复构造同路径不抛错（表已存在）", () => {
    const a = new SqliteLarkCardStateStore(dbPath);
    a.upsert(makeState());
    a.close();
    const b = new SqliteLarkCardStateStore(dbPath);
    b.upsert(makeState({ messageId: "om_card_2" }));
    expect(b.get(42)!.messageId).toBe("om_card_2");
    b.close();
  });
});

// ============================================================================
// 创建工厂：失败降级
// ============================================================================

describe("createLarkCardStateStore — 失败降级到内存", () => {
  it("不可写路径 → 返回内存实现（不抛错、卡片流程不中断）", () => {
    // 用 /dev/null/xxx 构造必然失败的路径（ENOTDIR）
    const store = require("./lark-card-state-store").createLarkCardStateStore(
      "/dev/null/definitely-not-a-dir/lark-cards.db"
    );
    expect(store).toBeDefined();
    store.upsert(makeState());
    expect(store.get(42)!.messageId).toBe("om_card_1");
    store.close();
  });
});

// ============================================================================
// 测试环境保护（破坏性自检 S19 抓到的假绿，2026-10-25）
// ============================================================================

describe("createLarkCardStateStore — 测试环境默认不落真实库", () => {
  it("未显式指定路径 + 测试环境 → 返回内存实现（不污染真实用户库）", () => {
    // bun test 默认 NODE_ENV=test；这里必须**不传** dbPath
    const { createLarkCardStateStore } = require("./lark-card-state-store");
    const prev = process.env.ROY_AGENT_LARK_CARD_DB;
    delete process.env.ROY_AGENT_LARK_CARD_DB;
    try {
      const store = createLarkCardStateStore();
      // 内存实现的判据：同一实例内可读回，且不是 SqliteLarkCardStateStore
      expect(store instanceof SqliteLarkCardStateStore).toBe(false);
      store.upsert(makeState({ taskId: 999, messageId: "om_probe" }));
      expect(store.get(999)!.messageId).toBe("om_probe");
      store.close();
    } finally {
      if (prev !== undefined) process.env.ROY_AGENT_LARK_CARD_DB = prev;
    }
  });

  it("显式传路径时，测试环境也尊重该路径（不被环境保护吞掉）", () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-card-explicit-"));
    const p = join(dir, "explicit.db");
    try {
      const { createLarkCardStateStore } = require("./lark-card-state-store");
      const store = createLarkCardStateStore(p);
      expect(store instanceof SqliteLarkCardStateStore).toBe(true);
      store.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Task #4536 — xval MINOR 5: 并发/多进程鲁棒性", () => {
  it("WAL 开启 + 两个连接并发写不抛 SQLITE_BUSY", () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-card-wal-"));
    const p = join(dir, "wal.db");
    try {
      const a = new SqliteLarkCardStateStore(p);
      const b = new SqliteLarkCardStateStore(p);
      a.upsert(makeState({ taskId: 1 }));
      b.upsert(makeState({ taskId: 2, messageId: "om_2" }));
      a.markPinned(1, false);
      b.markClosed(2);
      expect(a.get(1)!.pinned).toBe(false);
      expect(b.get(2)!.status).toBe("closed");
      a.close();
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("timeline 往返（跨实例）", () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-card-tl-"));
    const p = join(dir, "tl.db");
    try {
      const a = new SqliteLarkCardStateStore(p);
      a.upsert(
        makeState({ timeline: JSON.stringify({ updateCount: 7, milestones: [{ title: "M" }] }) })
      );
      a.close();
      const b = new SqliteLarkCardStateStore(p);
      const rec = b.get(42)!;
      expect(rec.timeline).toBeDefined();
      const snap = JSON.parse(rec.timeline!);
      expect(snap.updateCount).toBe(7);
      expect(snap.milestones[0].title).toBe("M");
      b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Task #4536 — xval MINOR 5: PRAGMA 生效性", () => {
  it("journal_mode=WAL + busy_timeout 真的设置上了", () => {
    const dir = mkdtempSync(join(tmpdir(), "lark-card-pragma-"));
    const p = join(dir, "pragma.db");
    try {
      const s = new SqliteLarkCardStateStore(p);
      // 通过内部 db 句柄读回 PRAGMA（better-sqlite3/bun:sqlite 都支持 prepare）
      const db = (s as any).db;
      const jm = db.prepare("PRAGMA journal_mode").get();
      const bt = db.prepare("PRAGMA busy_timeout").get();
      const mode = jm?.journal_mode ?? jm?.mode;
      expect(String(mode).toLowerCase()).toBe("wal");
      const timeout = bt?.timeout ?? bt?.busy_timeout;
      expect(Number(timeout)).toBe(5000);
      s.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
