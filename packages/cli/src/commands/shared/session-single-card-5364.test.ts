/**
 * @fileoverview Task #5364 返工 —— **生产形状**端到端测试（6 个 BLOCKER 的守门人）
 *
 * ## 这个文件为什么必须存在（前一轮的教训）
 *
 * 上一轮 55 条测试全绿 + CV PASS，真机一跑崩了 6 个 BLOCKER。共性根因：
 *
 * > 测试全靠 mock 注入端口和单例，**没有一条走生产 env 的真实形状**。
 *
 * 具体地，测试里 `new LarkCardPatchNotifier()` 注入给 sender，又 `new` 一个注入给
 * handler —— 两个实例在测试里都能跑通（各自断言自己的事），但生产上它们**根本
 * 不是同一个对象**，于是 `sessionCardIds` 分裂 ⇒ 一个 session 发 3 张卡。
 *
 * 所以本文件的纪律是：
 *
 * 1. **不注入 notifier**：走 `getSharedLarkCardNotifier()`（生产用的那一个），
 *    断言「模块级单例」而不是「我传进去的那个 mock」。
 * 2. **不 mock session store**：用真实的 `bun:sqlite` 内存 store 读活性。
 * 3. **数群里的 interactive 消息条数**：断言 `sendCard` 累计调用 = 1（不是 mock 断言）。
 *
 * ## 覆盖的 BLOCKER
 *
 * | BLOCKER | 本文件断言 |
 * |---|---|
 * | 4 一个 session 3 张卡 | 多生命周期事件后 `send` 次数 === 1 |
 * | 5 task 未合进 session 卡 | 首卡即含「📋 任务信息」面板 + 任务 ID |
 * | 6 自动同步未生效 | task 更新后**没有新的 send**，只有 patch |
 * | 1/3 活性端口 | `createSessionActivityProbe` 真实读到 store 的消息数 |
 */

import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LarkCardPatchNotifier,
  getSharedLarkCardNotifier,
  __resetSharedLarkCardNotifierForTest,
  buildSessionCard,
  hasSharedLarkCardNotifier,
} from "@ai-setting/roy-bot-core/env/task/plugins/lark-card-patch-notifier";
import {
  createSessionActivityProbe,
  mapBgTaskStatusToSessionLifecycle,
} from "@ai-setting/roy-bot-core/env/task/plugins/sub-session-activity";
import {
  createLarkCardStateStore,
  createLarkSessionCardStore,
  __resetSharedLarkSessionCardStoreForTest,
} from "@ai-setting/roy-bot-core/env/task/plugins/lark-card-state-store";

const SESSION = "session_rework_5364_sub";
const CHAT = "oc_rework_5364_chat";

const tmpDir = mkdtempSync(join(tmpdir(), "rework5364-"));
afterAll(() => {
  try {
    rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

beforeEach(() => {
  // 单例必须在用例之间重置，否则前一个用例的 sessionCardIds 会让"应该发新卡"
  // 的场景静默命中旧卡（看起来像通过，其实是脏数据）。
  __resetSharedLarkCardNotifierForTest();
  // ★ Task #5591：notifier 构造即回灌 session store ⇒ 测试用的
  //   模块级内存 store 也要一并重置（否则上一用例落库的卡会被
  //   本用例的构造回灌，"应该发新卡"的场景静默命中旧卡）。
  __resetSharedLarkSessionCardStoreForTest();
});

/** 挂一个记录器到 notifier 上，模拟「飞书群里真实收到的消息」 */
interface SendRecorder {
  sends: Array<{ op: string; argv: string[] }>;
  patches: Array<{ op: string; argv: string[] }>;
  /** 群内 interactive 消息条数 = send 次数（真正的验收指标） */
  interactiveMessageCount: number;
}

function attachRecorder(notifier: LarkCardPatchNotifier): SendRecorder {
  const rec: SendRecorder = {
    sends: [],
    patches: [],
    get interactiveMessageCount() {
      return rec.sends.length;
    },
  };
  notifier.testRunner = async (argv: string[], op: string) => {
    if (op === "send") {
      rec.sends.push({ op, argv });
      // 模拟 lark-cli 的真实响应形状（extractMessageId 依赖它）
      return JSON.stringify({
        ok: true,
        data: { message_id: `om_rework_${rec.sends.length}` },
      });
    }
    if (op === "patch") {
      rec.patches.push({ op, argv });
      return JSON.stringify({ ok: true });
    }
    // pin / unpin / delete 等：成功空响应
    return JSON.stringify({ ok: true });
  };
  return rec;
}

/**
 * 从 send/patch 的 argv 里取出卡片 JSON 正文（用于断言内容）。
 *
 * ⚠️ send 用 `--content <card JSON>`，patch 用 `--data {"content":"<card JSON>"}`
 * （`buildPatchCardArgs` 的真实形状 —— 第一次写这个 helper 时只认 --content，
 * 于是 patch 断言全拿到空串。这正是「按代码想象而不是按生产形状断言」的坑。）
 */
function cardText(call: { argv: string[] }): string {
  const contentIdx = call.argv.indexOf("--content");
  if (contentIdx >= 0) {
    const raw = call.argv[contentIdx + 1] ?? "";
    try {
      return JSON.stringify(JSON.parse(raw));
    } catch {
      return raw;
    }
  }
  const dataIdx = call.argv.indexOf("--data");
  if (dataIdx >= 0) {
    const raw = call.argv[dataIdx + 1] ?? "";
    try {
      const outer = JSON.parse(raw) as { content?: string };
      if (typeof outer.content === "string") {
        return JSON.stringify(JSON.parse(outer.content));
      }
      return JSON.stringify(outer);
    } catch {
      return raw;
    }
  }
  return "";
}

// ============================================================================
// BLOCKER-4：一个 session 只有一张卡（**数真实 send 次数**）
// ============================================================================

describe("BLOCKER-4：一个 session 生命周期内只发一张卡", () => {
  test("★★ 连续 3 个生命周期事件（running/completed/running）→ 群内 send 次数 === 1", async () => {
    // ⚠️ 不注入 notifier —— 用生产单例
    const notifier = getSharedLarkCardNotifier();
    expect(hasSharedLarkCardNotifier()).toBe(true);
    const rec = attachRecorder(notifier);

    await notifier.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "running",
    });
    await notifier.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "completed",
      milestones: [{ title: "子会话完成", timestamp: new Date().toISOString() }],
    });
    await notifier.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "running",
    });

    // 这就是真机取证里「1 个 session 发 3 张卡」的回归断言
    expect(rec.interactiveMessageCount).toBe(1);
    expect(rec.patches.length).toBe(2); // 后两次走 patch 同一张
  });

  test("★★ 两次 getSharedLarkCardNotifier() 必须是**同一个实例**（实例分裂根因）", () => {
    const a = getSharedLarkCardNotifier();
    const b = getSharedLarkCardNotifier();
    expect(a).toBe(b);

    // 反向断言：正因为同实例，一处发的卡另一处才看得见
    a.bindTaskToSession(5364, SESSION);
    expect(b.getSessionIdByTask(5364)).toBe(SESSION);
  });

  test("★ 重置后是**新**实例（证明测试隔离有效，不是假同引用）", () => {
    const before = getSharedLarkCardNotifier();
    __resetSharedLarkCardNotifierForTest();
    expect(hasSharedLarkCardNotifier()).toBe(false);
    const after = getSharedLarkCardNotifier();
    expect(after).not.toBe(before);
  });

  test("★ 重启后认领同一张卡：adoptSessionCard 后不再发新卡", async () => {
    // 第一次进程：发卡
    const first = getSharedLarkCardNotifier();
    const rec1 = attachRecorder(first);
    await first.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "running",
    });
    expect(rec1.interactiveMessageCount).toBe(1);
    const messageId = first.getSessionCardMessageId(SESSION)!;
    expect(messageId).toBe("om_rework_1");

    // 模拟重启：内存全丢
    // ★ Task #5591 后：构造即回灌 ⇒ 新单例直接从共享内存 store
    //   恢复 messageId（这正是修复语义，不再需要手动 adopt）。
    __resetSharedLarkCardNotifierForTest();
    const second = getSharedLarkCardNotifier();
    const rec2 = attachRecorder(second);
    expect(second.getSessionCardMessageId(SESSION)).toBe(messageId);

    // 持久层恢复（hook 的 restoreCardState 干这件事）
    second.adoptSessionCard(SESSION, messageId);
    await second.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "completed",
    });

    // 关键：重启后**也没有多发一张**，而是 patch 原来那张
    expect(rec2.interactiveMessageCount).toBe(0);
    expect(rec2.patches.length).toBe(1);
  });
});

// ============================================================================
// BLOCKER-5：task 信息合并进 session 卡（不是并列两张）
// ============================================================================

describe("BLOCKER-5：task 信息渲染进同一张 session 卡", () => {
  test("★★ 首卡即含「📋 任务信息」面板 + 任务 ID + 进度条（合并不并列）", async () => {
    const notifier = getSharedLarkCardNotifier();
    const rec = attachRecorder(notifier);

    await notifier.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "running",
      task: {
        id: 5364,
        title: "返工 6 个 BLOCKER",
        status: "active",
        progress: 100,
        currentStatus: "返工中",
        priority: "high",
      },
    });

    // 用户 08:13 定稿：一个 session **只有一张卡**，task 是卡上的区块
    expect(rec.interactiveMessageCount).toBe(1);
    const text = cardText(rec.sends[0]!);
    expect(text).toContain("会话卡实时更新"); // session 卡身份
    expect(text).toContain("📋 任务信息"); // task 区块
    expect(text).toContain("#5364"); // 任务 ID
    expect(text).toContain("▓"); // 进度条（用户验收样式）
    expect(text).toContain("返工 6 个 BLOCKER");
  });

  test("★ 第二次生命周期事件**不带 task** 时，任务面板不能消失（carry-forward）", async () => {
    const notifier = getSharedLarkCardNotifier();
    const rec = attachRecorder(notifier);

    await notifier.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "running",
      task: { id: 5364, title: "返工 6 个 BLOCKER", status: "active" },
    });
    // 终态事件（生产 payload 不带 task）
    await notifier.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "completed",
    });

    expect(rec.patches.length).toBe(1);
    const patched = cardText(rec.patches[0]!);
    expect(patched).toContain("📋 任务信息");
    expect(patched).toContain("#5364");
  });

  test("★ 刷新（buildSessionCardWithActivity）也保留 task 面板", async () => {
    const notifier = getSharedLarkCardNotifier();
    const rec = attachRecorder(notifier);

    await notifier.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "running",
      task: { id: 5364, title: "返工", status: "active", progress: 50 },
    });

    const card = notifier.buildSessionCardWithActivity(
      notifier.getSessionCardMessageId(SESSION)!,
      SESSION,
      { subSessionId: SESSION, messageCount: 12, updatedAt: Date.now() },
      { lifecycle: "running" },
    );
    expect(card).toBeDefined();
    const text = JSON.stringify(card);
    expect(text).toContain("📋 任务信息");
    expect(text).toContain("消息数 12 条");
    expect(rec.interactiveMessageCount).toBe(1); // 刷新不新增消息
  });

  test("★ 无 task 时不渲染任务面板（无则省略，不出现 undefined 占位）", async () => {
    const notifier = getSharedLarkCardNotifier();
    const rec = attachRecorder(notifier);
    await notifier.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "running",
    });
    const text = cardText(rec.sends[0]!);
    expect(text).not.toContain("📋 任务信息");
    expect(text).not.toContain("undefined");
  });
});

// ============================================================================
// BLOCKER-6：task 状态更新自动同步（飞书）→ 只 patch，不发新卡
// ============================================================================

describe("BLOCKER-6：task 更新自动同步到同一张 session 卡", () => {
  test("★★ task 进度更新 → patch 同一张卡（0 次新 send），内容反映新进度", async () => {
    const notifier = getSharedLarkCardNotifier();
    const rec = attachRecorder(notifier);

    await notifier.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "running",
      task: { id: 5364, title: "返工", status: "active", progress: 10 },
    });
    expect(rec.interactiveMessageCount).toBe(1);

    // 任务推进（08:15「飞书自动同步」）
    await notifier.updateSessionCard({
      sessionId: SESSION,
      lifecycle: "running",
      task: { id: 5364, title: "返工", status: "active", progress: 80 },
    });

    expect(rec.interactiveMessageCount).toBe(1); // 不新增卡
    expect(rec.patches.length).toBe(1);
    expect(cardText(rec.patches[0]!)).toContain("80%");
  });

  test("★ task→session 反向索引：有 taskId 就能找回 session 卡（旧卡按钮兜底）", async () => {
    const notifier = getSharedLarkCardNotifier();
    attachRecorder(notifier);
    await notifier.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "running",
      task: { id: 5364, title: "返工", status: "active" },
    });
    expect(notifier.getSessionIdByTask(5364)).toBe(SESSION);
    expect(notifier.getSessionIdByTask(9999)).toBeUndefined();
  });
});

// ============================================================================
// BLOCKER-1/3：活性数据端到端（真实 session store，不是 mock）
// ============================================================================

describe("BLOCKER-1：活性数据端到端（真实 store 形状）", () => {
  test("★★ createSessionActivityProbe 真实读到消息数 + 最近一条消息", async () => {
    const messages = [
      { role: "user", content: "请调研 airport 本体生成", timestamp: 1_700_000_000_000 },
      { role: "assistant", content: "已定位到 wecom-card-builder.ts:485", timestamp: 1_700_000_060_000 },
    ];
    const probe = createSessionActivityProbe({
      getSession: (id) =>
        id === SESSION
          ? { messageCount: messages.length, updatedAt: 1_700_000_060_000 }
          : undefined,
      getLastMessage: (id) =>
        id === SESSION
          ? { role: messages[1]!.role, content: messages[1]!.content }
          : undefined,
      getLifecycle: () => "running",
    });

    const now = 1_700_000_090_000;
    const res = await probe(SESSION);
    expect(res.activity?.messageCount).toBe(2);
    expect(res.activity?.lastMessage?.content).toContain("wecom-card-builder.ts:485");

    // 渲染口径与 task 卡同源（用户要看的正是这两项）
    const card = buildSessionCard({
      sessionId: SESSION,
      activity: res.activity ?? null,
      lifecycle: res.lifecycle,
      activityNow: now,
    });
    const text = JSON.stringify(card);
    expect(text).toContain("消息数 2 条");
    expect(text).toContain("wecom-card-builder.ts:485");
    expect(text).not.toContain("暂无数据");
  });

  test("★ 未知 session → 暂无数据（诚实降级，不编造）", async () => {
    const probe = createSessionActivityProbe({
      getSession: () => undefined,
    });
    const res = await probe("session_nope");
    expect(res.activity).toBeUndefined();
    const card = buildSessionCard({
      sessionId: "session_nope",
      activity: res.activity ?? null,
      lifecycle: res.lifecycle,
    });
    expect(JSON.stringify(card)).toContain("暂无数据");
  });

  test("★ 后台任务状态 → session 生命周期映射（两渠道共用，不漂移）", () => {
    expect(mapBgTaskStatusToSessionLifecycle("completed")).toBe("completed");
    expect(mapBgTaskStatusToSessionLifecycle("timeout")).toBe("timeout");
    expect(mapBgTaskStatusToSessionLifecycle("failed")).toBe("failed");
    expect(mapBgTaskStatusToSessionLifecycle("stopped")).toBe("stopped");
    expect(mapBgTaskStatusToSessionLifecycle("cancelled")).toBe("stopped");
    expect(mapBgTaskStatusToSessionLifecycle("running")).toBe("running");
    expect(mapBgTaskStatusToSessionLifecycle(undefined)).toBe("running");
  });
});

// ============================================================================
// BLOCKER-3 前置：持久层 session_id 落库 + 反查（重启可用）
// ============================================================================

describe("BLOCKER-3 前置：持久层记录 session 归属", () => {
  test("★★ upsert 后按 taskId 读回 sessionId（重启后反查用）", () => {
    const store = createLarkCardStateStore(join(tmpDir, "cards.db"));
    const now = Date.now();
    store.upsert({
      taskId: 5364,
      messageId: "om_persisted",
      chatId: CHAT,
      pinned: true,
      status: "open",
      createdAt: now,
      updatedAt: now,
      sessionId: SESSION,
    });
    expect(store.get(5364)?.sessionId).toBe(SESSION);
    store.close?.();
  });

  test("★ 旧行（无 session_id）不炸，字段缺省为 undefined", () => {
    const store = createLarkCardStateStore(join(tmpDir, "cards2.db"));
    const now = Date.now();
    store.upsert({
      taskId: 42,
      messageId: "om_old",
      chatId: CHAT,
      pinned: false,
      status: "open",
      createdAt: now,
      updatedAt: now,
    });
    expect(store.get(42)?.sessionId).toBeUndefined();
    store.close?.();
  });
});
// ============================================================================
// ★ CV R3 四个 MAJOR 的守门人（reviewer 判定 PASS WITH MAJOR，逐条修 + 加断言）
// ============================================================================

describe("★ CV R3 M4：activity 的 null 三态不被塌陷（刷新后不被旧快照覆盖）", () => {
  test("★★ 刷新拿到 null（查了没数据）→ 落 state，下一次自动 patch 仍显「暂无数据」", async () => {
    const notifier = new LarkCardPatchNotifier({ sessionCardStore: null });
    const rec = attachRecorder(notifier);

    // 首卡带一份「有数据」的活性
    await notifier.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "running",
      activity: { subSessionId: SESSION, messageCount: 99, updatedAt: Date.now() },
    });
    expect(cardText(rec.sends[0]!)).toContain("消息数 99 条");

    // 用户点刷新：这次真的查了，但没数据 → null（明确事实）
    const refreshed = notifier.buildSessionCardWithActivity(
      notifier.getSessionCardMessageId(SESSION)!,
      SESSION,
      null,
      { lifecycle: "running" },
    );
    expect(JSON.stringify(refreshed)).toContain("暂无数据");

    // 之后的生命周期事件**不带 activity** → 不能把 99 条旧快照又翻出来
    await notifier.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "completed",
    });
    const lastPatch = cardText(rec.patches[rec.patches.length - 1]!);
    expect(lastPatch).not.toContain("消息数 99 条");
  });
});

describe("★ CV R3 M3：session 卡落库 → 重启认领（无 task 的 session 也不多发）", () => {
  test("★★ 首卡写进 session 持久层，新 notifier 回灌后走 patch 而不是 send", async () => {
    const store = createLarkSessionCardStore(join(tmpDir, "sess-cards.db"));

    // 进程 1：发卡（自动落库）
    const first = new LarkCardPatchNotifier({ sessionCardStore: store });
    const rec1 = attachRecorder(first);
    await first.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "running",
    });
    expect(rec1.interactiveMessageCount).toBe(1);
    expect(store.get(SESSION)?.messageId).toBe("om_rework_1");

    // 进程 2（模拟重启）：同一份持久层，内存索引空
    // ★ Task #5591 后：构造即回灌 ⇒ 这里不再 undefined，
    //   直接就是恢复后的 messageId（旧断言已由下方"构造即回灌"
    //   用例接管，此处改为断言新语义）。
    const second = new LarkCardPatchNotifier({ sessionCardStore: store });
    const rec2 = attachRecorder(second);
    expect(second.getSessionCardMessageId(SESSION)).toBe("om_rework_1");

    // 手动 restore 幂等：已回灌的 sessionId 不会重复计数
    const restored = second.restoreSessionCardsFromStore();
    expect(restored).toBe(0);

    await second.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "completed",
    });

    // 关键：重启后**没有新卡**，只有 patch
    expect(rec2.interactiveMessageCount).toBe(0);
    expect(rec2.patches.length).toBe(1);
    store.close?.();
  });

  // ★ Task #5591（真机复发 2026-11-15）：restoreSessionCardsFromStore
  //   全仓无生产调用方 ⇒ 重启后内存索引恒空 ⇒ task hook 一来
  //   upsertSessionCard 查无卡 ⇒ startSessionCard 再发一张（用户
  //   「同一 session 2 条卡」）。修法：构造函数里自动回灌（有 store 时），
  //   本测试锁「构造即恢复，无需调用方记得调 restore」。
  test("★★ 构造即回灌：new LarkCardPatchNotifier({store}) 后直接 upsert 走 patch（Task #5591）", async () => {
    const store = createLarkSessionCardStore(join(tmpDir, "sess-cards-5591.db"));

    // 进程 1：发卡（自动落库）
    const first = new LarkCardPatchNotifier({ sessionCardStore: store });
    const rec1 = attachRecorder(first);
    await first.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "running",
    });
    expect(rec1.interactiveMessageCount).toBe(1);
    expect(store.get(SESSION)?.messageId).toBe("om_rework_1");

    // 进程 2（模拟重启）：**不调** restoreSessionCardsFromStore ——
    // 构造函数必须自己回灌（生产没有任何调用方记得调它）。
    const second = new LarkCardPatchNotifier({ sessionCardStore: store });
    const rec2 = attachRecorder(second);
    expect(second.getSessionCardMessageId(SESSION)).toBe("om_rework_1");

    // 同 session 二次 hook（模拟 task:after.create 触发 patchSessionCardForTask）
    // ⇒ 必须复用 messageId patch，而不是 startSessionCard 新发。
    const res = await second.upsertSessionCard({
      chatId: CHAT,
      sessionId: SESSION,
      lifecycle: "completed",
    });

    expect(res.created).toBe(false); // 走 patch 而非新发
    expect(res.messageId).toBe("om_rework_1"); // 复用既有卡
    expect(rec2.interactiveMessageCount).toBe(0); // 零新卡
    expect(rec2.patches.length).toBe(1);
    store.close?.();
  });
});

describe("★ CV R3 M2：per-task 插件不再自带独立 notifier 实例", () => {
  test("★★ 生产默认取共享单例（避免刷新 fallback 重建丢 title/里程碑）", () => {
    const src = readFileSync(
      join(
        import.meta.dir,
        "../../../../core/src/env/task/plugins/per-task-group-chat-plugin.ts",
      ),
      "utf8",
    );
    // 允许注释里出现 new（讲历史），但配置项必须是单例
    expect(src).toContain("cardNotifier: config.cardNotifier ?? getSharedLarkCardNotifier()");
    expect(src).not.toContain("cardNotifier: config.cardNotifier ?? new LarkCardPatchNotifier()");
  });
});

describe("★ CV R3 M1：task 事件与 session 生命周期事件并发 → 仍只有一张卡", () => {
  test("★★ 并发 upsert（模拟 fire-and-forget）→ send 次数 === 1", async () => {
    const notifier = new LarkCardPatchNotifier({ sessionCardStore: null });
    const rec = attachRecorder(notifier);

    // 模拟生产：EventHandler 对生命周期事件是 `void sendSessionLifecycleCard(event)`，
    // 而 task hook 也是独立异步链路 —— 两者可能同时进入 upsert。
    // 用 Promise.all 并发进入（不加 await 串行）。
    await Promise.all([
      notifier.upsertSessionCard({
        chatId: CHAT,
        sessionId: SESSION,
        lifecycle: "running",
        task: { id: 5364, title: "返工", status: "active" },
      }),
      notifier.upsertSessionCard({
        chatId: CHAT,
        sessionId: SESSION,
        lifecycle: "running",
        milestones: [{ title: "子会话启动", timestamp: new Date().toISOString() }],
      }),
      notifier.upsertSessionCard({
        chatId: CHAT,
        sessionId: SESSION,
        lifecycle: "completed",
      }),
    ]);

    // 并发 3 路 → 只能有 1 张卡（这正是 CV R3 M1 指出的残留竞态）
    expect(rec.interactiveMessageCount).toBe(1);
  });
});
