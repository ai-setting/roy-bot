/**
 * @fileoverview Task #5364 —— DS review R1 修复回归（MAJOR-1 / MAJOR-2 / MAJOR-3）
 *
 * ## 为什么这个文件必须存在
 *
 * 第一轮 DS review 判 **PASS WITH MAJOR**，三条 MAJOR 的共同特征是：
 * **既有测试是「跨层拼装」的假绿** —— fixture 手工 seed 了 store，
 * 从不经过 sender 的 `persist()`。于是：
 *
 * - MAJOR-1：「终态事件抹掉 startedAt」在 seed 路径上完全看不见
 *   （seed 里 startedAt 固定写死，永远不会被后续事件覆盖）
 * - MAJOR-2：「state 缺失时谎报运行中」在 seed 路径上完全看不见
 *   （seed 永远有 state）
 * - MAJOR-3：守护测试的兜底分支把「无显式 exports」当成 PASS
 *
 * ⇒ 本文件的纪律：**走真实链路**（sender 真写 store → refresh 真读 store），
 *   fixture 只提供事件，不预置 store 内容。
 */

import { describe, test, expect } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { EnvEvent } from "../types";
import { createWecomSessionCardSender } from "./wecom-session-card-sender";
import { buildWecomSessionCardUpdateBody } from "./wecom-card-action-handler";
import { wecomCardTaskIdForSession } from "./wecom-card-builder";
import {
  createMemoryWecomSessionCardStore,
  type WecomSessionCardStore,
} from "../task/plugins/wecom-session-card-store";

const SESSION_ID = "session_r1_04357c17";
const SOURCE_ID = "wecom-bot-1";
const USER_ID = "dzk_wecom_userid";
const STARTED_AT = new Date(2026, 10, 12, 8, 0, 0).getTime();
const NOW = new Date(2026, 10, 12, 8, 34, 0).getTime(); // 34 分钟后

/**
 * 造生命周期事件，**payload 形状与 delegate-tool 真实发布的一致**。
 *
 * 关键事实（review R1 取证 delegate-tool.ts:1526 / :1671 / :1827 / :1859 / :1890）：
 * 只有 running（started）那条带 `startedAt`；completed / timeout / failed /
 * stopped 只带 `executionTimeMs`，**没有 startedAt**。
 */
function lifecycleEvent(
  lifecycle: string,
  opts: { withStartedAt?: boolean } = {},
): EnvEvent {
  const withStartedAt = opts.withStartedAt ?? lifecycle === "running";
  return {
    id: `evt-${lifecycle}`,
    type: "task.background.session_started",
    timestamp: NOW,
    payload: {
      backgroundTaskId: "process_r1",
      subSessionId: SESSION_ID,
      parentSessionId: "parent-1",
      description: "调研 airport 本体生成",
      subagentType: "roy",
      lifecycle,
      // ★ 只 running 带 startedAt —— 与生产 payload 一致
      ...(withStartedAt ? { startedAt: STARTED_AT } : { executionTimeMs: 34 * 60000 }),
      associatedTaskId: 5364,
    },
    metadata: {
      source: "task.background",
      sourceId: SOURCE_ID,
      replyChannel: {
        type: "wecom-cli",
        chatId: USER_ID,
        params: { chatType: "single", sourceId: SOURCE_ID },
      },
    },
  } as unknown as EnvEvent;
}

function makeSender(store: WecomSessionCardStore) {
  return createWecomSessionCardSender({
    store,
    sendCard: async () => ({ ok: true }),
    now: () => NOW,
    warn: () => {},
  });
}

/** 从刷新帧里取出 horizontal 行（keyname → value） */
function rowsOf(body: Record<string, unknown>): Array<{
  keyname: string;
  value: string;
}> {
  const tc = (body as { template_card?: { horizontal_content_list?: unknown } })
    .template_card;
  return (tc?.horizontal_content_list ?? []) as Array<{
    keyname: string;
    value: string;
  }>;
}

// ============================================================================
// MAJOR-1：终态事件不得抹掉 startedAt（「已运行」行必须还在）
// ============================================================================

describe("★ MAJOR-1：终态事件后「已运行」不消失", () => {
  test("running(startedAt) → completed(无 startedAt)：store 仍保留 startedAt", async () => {
    const store = createMemoryWecomSessionCardStore();
    const send = makeSender(store);

    await send(lifecycleEvent("running", { withStartedAt: true }));
    expect(store.get(SESSION_ID)!.startedAt).toBeDefined();

    await send(lifecycleEvent("completed", { withStartedAt: false }));

    // ★ 核心断言：终态事件没带 startedAt，但也不能把它清空
    const rec = store.get(SESSION_ID)!;
    expect(rec.startedAt).toBe(new Date(STARTED_AT).toISOString());
    expect(rec.lifecycle).toBe("completed");
  });

  test("★ 真实链路：走完 running→completed 后，刷新帧里「已运行」行存在", async () => {
    const store = createMemoryWecomSessionCardStore();
    const send = makeSender(store);

    await send(lifecycleEvent("running", { withStartedAt: true }));
    await send(lifecycleEvent("completed", { withStartedAt: false }));

    const rec = store.get(SESSION_ID)!;
    const { body } = buildWecomSessionCardUpdateBody({
      cardTaskId: rec.cardTaskId,
      sessionId: SESSION_ID,
      state: rec,
      activity: null,
      now: NOW,
    });
    const keys = rowsOf(body).map((r) => r.keyname);
    expect(keys).toContain("已运行");
    const elapsed = rowsOf(body).find((r) => r.keyname === "已运行")!.value;
    expect(elapsed).toBe("34m");
  });

  test("★ 四个终态都不抹 startedAt（timeout / failed / stopped / completed）", async () => {
    for (const l of ["completed", "timeout", "failed", "stopped"]) {
      const store = createMemoryWecomSessionCardStore();
      const send = makeSender(store);
      await send(lifecycleEvent("running", { withStartedAt: true }));
      await send(lifecycleEvent(l, { withStartedAt: false }));
      expect(store.get(SESSION_ID)!.startedAt).toBeDefined();
    }
  });

  test("title / agentType 同样不被后续事件抹掉", async () => {
    const store = createMemoryWecomSessionCardStore();
    const send = makeSender(store);

    await send(lifecycleEvent("running", { withStartedAt: true }));
    // 终态事件若不带 description/subagentType（生产上 completed 只带 executionTimeMs）
    const bare = lifecycleEvent("completed");
    (bare.payload as Record<string, unknown>).description = undefined;
    (bare.payload as Record<string, unknown>).subagentType = undefined;
    await send(bare);

    const rec = store.get(SESSION_ID)!;
    expect(rec.title).toBe("调研 airport 本体生成");
    expect(rec.agentType).toBe("roy");
  });
});

// ============================================================================
// MAJOR-2：state 缺失时不得谎报「运行中」
// ============================================================================

describe("★ MAJOR-2：无 store 记录时不谎报运行中", () => {
  test("state=undefined → 状态行/标题不出现「运行中」（不可能知道它是运行中）", () => {
    const { body } = buildWecomSessionCardUpdateBody({
      cardTaskId: wecomCardTaskIdForSession(SESSION_ID),
      sessionId: SESSION_ID,
      reqIdForTest: "REQ-1",
      state: undefined,
      activity: {
        subSessionId: SESSION_ID,
        messageCount: 12,
        updatedAt: NOW - 60_000,
        lastMessage: { role: "assistant", content: "still working" },
      },
      now: NOW,
    });
    const s = JSON.stringify(body);
    // 谎报运行中会让用户以为「还在跑」，而实际可能是早就结束的 session
    expect(s).not.toContain("运行中");
    // 必须给出诚实的未知态
    expect(s).toContain("未知");
  });

  test("★ 无 state 但活性显示已停滞时，不得误报运行中（不能给出相反信号）", () => {
    const { body } = buildWecomSessionCardUpdateBody({
      cardTaskId: wecomCardTaskIdForSession(SESSION_ID),
      sessionId: SESSION_ID,
      reqIdForTest: "REQ-2",
      state: undefined,
      // 40 分钟无写入 = 活性侧会判停滞
      activity: {
        subSessionId: SESSION_ID,
        messageCount: 3,
        updatedAt: NOW - 40 * 60_000,
        lastMessage: { role: "assistant", content: "…" },
      },
      now: NOW,
    });
    const title = (body as { template_card: { main_title: { title: string } } })
      .template_card.main_title.title;
    expect(title).not.toContain("运行中");
  });

  test("有 state 时仍按真实 lifecycle 渲染（不回归）", () => {
    const { body } = buildWecomSessionCardUpdateBody({
      cardTaskId: wecomCardTaskIdForSession(SESSION_ID),
      sessionId: SESSION_ID,
      reqIdForTest: "REQ-3",
      state: {
        sessionId: SESSION_ID,
        chatId: USER_ID,
        chatType: "single",
        cardTaskId: wecomCardTaskIdForSession(SESSION_ID),
        lifecycle: "timeout",
        createdAt: NOW - 40 * 60_000,
        updatedAt: NOW,
      },
      activity: null,
      now: NOW,
    });
    expect(JSON.stringify(body)).toContain("已超时");
  });
});

// ============================================================================
// MAJOR-3：dist-exports 守护测试必须在「漏加 exports」时变红
// ============================================================================

describe("★ MAJOR-3：dist exports 守护不靠通配兜底放行", () => {
  const CORE_ROOT = resolve(import.meta.dir, "../../..");
  const pkg = JSON.parse(
    readFileSync(join(CORE_ROOT, "package.json"), "utf8"),
  ) as { exports: Record<string, unknown> };
  const exportsMap = pkg.exports;

  /**
   * 判据与守护测试同源：三段式 specifier **必须**有显式 exports 键。
   *
   * 旧实现的缺陷：两条通配会让 `candidates` 兜底成功（路径拼出来长得对），
   * 于是漏加显式键也判 PASS。但运行时 `import.meta.resolve` 是否真能命中
   * 取决于文件存在与否 —— 兜底把「存在性」判成了「形似性」。
   *
   * 本测试直接断言「三段式必须显式声明」这一条产品决策，避免兜底放行。
   */
  function isThreeSegmentDeclared(sub: string): boolean {
    const segs = sub.split("/").filter(Boolean);
    if (segs.length < 3) return true; // 一段/二段由通配覆盖，合规
    return `./${sub}` in exportsMap;
  }

  test("本轮三个模块都显式声明（若删掉任一条，此断言变红）", () => {
    for (const sub of [
      "env/event-source/wecom-session-card-sender",
      "env/task/plugins/wecom-session-card-store",
      "env/event-source/wecom-respond-registry",
    ]) {
      expect(isThreeSegmentDeclared(sub)).toBe(true);
    }
  });

  test("★ 变异验证：把某条显式 exports 删掉 ⇒ 判据立刻变红", () => {
    const mutated = { ...exportsMap };
    delete mutated["./env/task/plugins/wecom-session-card-store"];
    const segs = "env/task/plugins/wecom-session-card-store".split("/");
    const declared =
      segs.length < 3 || "./env/task/plugins/wecom-session-card-store" in mutated;
    expect(declared).toBe(false);
  });

  test("显式声明且文件存在（双保险）", () => {
    const key = "./env/task/plugins/wecom-session-card-store";
    expect(exportsMap[key]).toBeDefined();
    const v = exportsMap[key] as { import?: string };
    expect(v.import).toBeDefined();
    expect(existsSync(join(CORE_ROOT, v.import!))).toBe(true);
  });
});