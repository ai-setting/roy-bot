/**
 * @fileoverview Task #5360（补充需求 22:31）—— session-only 卡片 render + 刷新
 *
 * 用户需求：「有 sub-session 但无 task —— 也要能刷新看 subsession 情况
 * （消息数 + 最近 msg）」。
 *
 * 本文件锁定四件事：
 * A. `buildSessionCard` 有活性面板 + 刷新按钮，**没有**建群按钮（无 task 可绑）
 * B. 刷新按钮 value 带 `sessionId`（不是 taskId），handler 走 session-only 路径
 * C. session 卡与 task 卡活性渲染**同源**（同 formatActivityLines → 颜色口径一致）
 * D. task 卡行为**逐字不变**（防「顺手改了 task 卡」）
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  buildSessionCard,
  buildTaskCard,
  LarkCardPatchNotifier,
  type Milestone,
  type TaskMeta,
} from "./lark-card-patch-notifier";
import {
  handleCardAction,
  __resetCardActionInflightForTest,
  type CardActionPorts,
} from "./lark-card-action-handler";
import type { SubSessionActivity } from "./sub-session-activity";
import { createSessionActivityProbe } from "./sub-session-activity";
import { __resetSharedLarkSessionCardStoreForTest } from "./lark-card-state-store";

// ★ 相对时间基准（同 lark-card-activity-5360：避免硬编码日期随时间变成时间炸弹）
const NOW = Date.now();
const MIN = 60 * 1000;
const SESSION_ID = "session_04357c17-9ff8-4e3d-a498-bc254da5caf9";
const MESSAGE_ID = "om_session_card_1";

function act(over: Partial<SubSessionActivity> = {}): SubSessionActivity {
  return {
    subSessionId: SESSION_ID,
    messageCount: 88,
    updatedAt: NOW - 3 * MIN,
    lastMessage: { role: "assistant", content: "已定位到 delegate 的关联反查逻辑" },
    ...over,
  };
}

const META: TaskMeta = {
  id: 5360,
  title: "任务通知卡片化改造",
  description: "desc",
  currentStatus: "进行中",
};

function flat(card: unknown): string {
  return JSON.stringify(card);
}

function panel(card: any, id: string): any {
  return (card?.body?.elements ?? []).find((e: any) => e?.element_id === id);
}

beforeEach(() => {
  __resetCardActionInflightForTest();
  // ★ Task #5591：notifier 构造即回灌 session store ⇒ 共享内存
  //   store 也要一并重置（否则上一用例落库的卡被本用例构造回灌，
  //   "应发新卡"场景静默命中旧卡 → CV R4/R5 用例误红）。
  __resetSharedLarkSessionCardStoreForTest();
});

// ============================================================================
// A. buildSessionCard 结构
// ============================================================================

describe("buildSessionCard — 结构", () => {
  test("★ 有活性面板 + 刷新按钮，值带 sessionId（不是 taskId）", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      title: "调研 airport 本体生成",
      activity: act(),
      activityNow: NOW,
    });

    const buttons = (card.body.elements ?? []).filter(
      (e: any) => e.tag === "button",
    );
    // ★ Task #5397：无 task 的卡现在有 **两个** 按钮 —— 建群 + 刷新
    //   （原断言是 `toHaveLength(1)`，只允许刷新按钮；已被
    //   「无 task 也能建群」的需求推翻）。
    const refresh = buttons.find((b: any) => b.value?.action === "refresh_activity");
    expect(refresh).toBeDefined();
    expect(refresh!.value.sessionId).toBe(SESSION_ID);
    expect(refresh!.value.taskId).toBeUndefined();

    const p = panel(card, "task_activity");
    expect(p).toBeDefined();
    expect(flat(p)).toContain("消息数 88 条");
    expect(flat(p)).toContain("delegate 的关联反查");
  });

  test("★ 无 task 也渲染建群按钮（Task #5397 推翻旧规格：不再「点了也没意义」）", () => {
    // 旧断言（已被本需求推翻）：
    //   expect(actions).not.toContain("create_group");
    //   expect(actions).not.toContain("disband_group");
    // 原因：当时建群/解绑绑定在 task 上，无 task 时点了确实没意义。
    // ★ 现在：无 task 的 sub-session 由 **session-only 路径** 建群（建完
    //   linkSession 到本会话 ⇒ 群里能读到历史），所以按钮必须有。
    const card = buildSessionCard({ sessionId: SESSION_ID, activity: act() });
    const actions = (card.body.elements ?? [])
      .filter((e: any) => e.tag === "button")
      .map((e: any) => e.value?.action);
    expect(actions).toContain("create_group");
    // 还没建群 ⇒ 不应出现解绑
    expect(actions).not.toContain("disband_group");
  });

  test("★ 已有群 ⇒ 翻成解散按钮 + 渲染群链接（Task #5397）", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      activity: act(),
      perTaskChatId: "oc_group_5397",
    });
    const actions = (card.body.elements ?? [])
      .filter((e: any) => e.tag === "button")
      .map((e: any) => e.value?.action);
    expect(actions).toContain("disband_group");
    expect(actions).not.toContain("create_group");
    expect(JSON.stringify(card)).toContain("oc_group_5397");
  });

  test("会话详情面板：sessionId + agent + 开始时间 + 已运行", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      title: "调研 airport",
      agentType: "roy",
      startedAt: "2026-11-11T14:47:12.000Z",
      elapsedText: "12m",
    });
    const p = panel(card, "session_detail");
    expect(p).toBeDefined();
    const t = flat(p);
    expect(t).toContain(SESSION_ID);
    expect(t).toContain("调研 airport");
    expect(t).toContain("roy");
    expect(t).toContain("12m");
  });

  test("header 带会话标题（无 title 时退化为 sessionId 截断）", () => {
    const withTitle = buildSessionCard({ sessionId: SESSION_ID, title: "调研 airport" });
    expect((withTitle.header as any).title.content).toContain("调研 airport");

    const noTitle = buildSessionCard({ sessionId: SESSION_ID });
    expect((noTitle.header as any).title.content).toContain("会话卡实时更新");
  });

  test("无活性数据（null）→ 面板照出 + 暂无数据", () => {
    const card = buildSessionCard({ sessionId: SESSION_ID, activity: null, activityNow: NOW });
    expect(flat(panel(card, "task_activity"))).toContain("暂无数据");
  });

  test("不传 activity → 不渲染活性面板（首次发卡零噪音）", () => {
    const card = buildSessionCard({ sessionId: SESSION_ID });
    expect(panel(card, "task_activity")).toBeUndefined();
  });

  test("里程碑面板（有才渲染）", () => {
    const ms: Milestone[] = [
      { title: "sub-agent 启动", timestamp: "2026-11-11T14:47:12.000Z" },
    ];
    const card = buildSessionCard({ sessionId: SESSION_ID, milestones: ms });
    const p = panel(card, "session_timeline");
    expect(p).toBeDefined();
    expect(flat(p)).toContain("sub-agent 启动");
  });
});

// ============================================================================
// C. 两卡活性口径一致
// ============================================================================

describe("活性渲染与 task 卡同源（不会出现同 session 两色）", () => {
  test("★ 同一份 activity → session 卡与 task 卡都显示 🟢 + 消息数 + 最近消息", () => {
    const taskCard = buildTaskCard({
      status: "running",
      meta: META,
      activity: act(),
      activityNow: NOW,
    });
    const sessionCard = buildSessionCard({
      sessionId: SESSION_ID,
      activity: act(),
      activityNow: NOW,
    });

    for (const card of [taskCard, sessionCard]) {
      const t = flat(card);
      expect(t).toContain("🟢");
      expect(t).toContain("消息数 88 条");
      expect(t).toContain("delegate 的关联反查");
    }
  });

  test("★ 停滞阈值一致：40 分钟无写入 → 两卡都是 🔴 疑似停滞", () => {
    const stale = act({ updatedAt: NOW - 40 * MIN });
    const a = flat(buildTaskCard({ status: "running", meta: META, activity: stale, activityNow: NOW }));
    const b = flat(buildSessionCard({ sessionId: SESSION_ID, activity: stale, activityNow: NOW }));
    for (const t of [a, b]) {
      expect(t).toContain("🔴");
      expect(t).toContain("疑似停滞");
    }
  });
});

// ============================================================================
// B. session-only 刷新路径
// ============================================================================

function makePorts(over: Partial<CardActionPorts> = {}): CardActionPorts {
  return {
    getTask: async (id) => ({ id, title: "不应被调用", context: "{}" }),
    updateTaskContext: async () => {},
    notifier: new LarkCardPatchNotifier(),
    ...over,
  };
}

describe("handleCardAction — session 主键刷新（有无 task 都走这条）", () => {
  test("★ value 只有 sessionId → 走 loadSessionActivity，不查 task", async () => {
    let taskLookups = 0;
    let sessionLookups = 0;

    const r = await handleCardAction(
      {
        // 注意：taskId 为空 —— 这正是「有 sub-session 但无 task」的形态
        actionValue: { action: "refresh_activity", taskId: "", sessionId: SESSION_ID } as any,
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      makePorts({
        getTask: async () => {
          taskLookups++;
          return undefined;
        },
        loadSessionActivity: async (sid) => {
          sessionLookups++;
          expect(sid).toBe(SESSION_ID);
          return { activity: act(), terminal: false };
        },
      }),
    );

    expect(r.ok).toBe(true);
    expect(r.action).toBe("refresh_activity");
    expect(sessionLookups).toBe(1);
    expect(taskLookups).toBe(0); // ← 关键：完全不走 task 路径
  });

  test("★ session-only 刷新返回的卡片是**session 卡**（含活性 + 建群按钮，Task #5397）", async () => {
    const r = await handleCardAction(
      {
        actionValue: { action: "refresh_activity", taskId: "", sessionId: SESSION_ID } as any,
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      makePorts({
        getTask: async () => undefined,
        loadSessionActivity: async () => ({ activity: act(), terminal: false }),
      }),
    );

    const card = r.cardUpdate as any;
    expect(card).toBeDefined();
    const t = flat(card);
    expect(t).toContain("消息数 88 条");
    // ★ Task #5397（推翻旧规格）：无 task 的 session 卡**也**有建群按钮
    //   —— 原断言是 `expect(t).not.toContain("create_group")`。
    expect(t).toContain("create_group");
    // 刷新后按钮仍可再点（sessionId 保留）
    const refresh = card.body.elements.find(
      (e: any) => e.tag === "button" && e.value?.action === "refresh_activity",
    );
    expect(refresh.value.sessionId).toBe(SESSION_ID);
  });

  test("session-only + 无活性数据 → 暂无数据，仍 ok", async () => {
    const r = await handleCardAction(
      {
        actionValue: { action: "refresh_activity", taskId: "", sessionId: SESSION_ID } as any,
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      makePorts({
        getTask: async () => undefined,
        loadSessionActivity: async () => ({ activity: undefined, terminal: false }),
      }),
    );
    expect(r.ok).toBe(true);
    expect(flat(r.cardUpdate)).toContain("暂无数据");
  });

  test("session-only + 端口抛错 → 降级暂无数据，绝不失败", async () => {
    const r = await handleCardAction(
      {
        actionValue: { action: "refresh_activity", taskId: "", sessionId: SESSION_ID } as any,
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      makePorts({
        getTask: async () => undefined,
        loadSessionActivity: () => {
          throw new Error("store down");
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(flat(r.cardUpdate)).toContain("暂无数据");
  });

  test("两者都没有 → ok:false（不 patch 空卡）", async () => {
    const r = await handleCardAction(
      {
        actionValue: { action: "refresh_activity", taskId: "", sessionId: "" } as any,
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      makePorts(),
    );
    expect(r.ok).toBe(false);
    expect(r.cardUpdate).toBeUndefined();
  });

  test("★ 澄清 22:37：task 与 session 都给 → **仍以 session 为刷新主键**", async () => {
    // 旧语义（错）会走 task 路径；新语义（对）永远读 session store，
    // 因为「消息数 + 最近 msg」是会话属性，task 只是附带信息。
    let sessionLookups = 0;
    let subSessionLookups = 0;
    const r = await handleCardAction(
      {
        actionValue: {
          action: "refresh_activity",
          taskId: "5360",
          sessionId: SESSION_ID,
        } as any,
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      makePorts({
        loadSessionActivity: async () => {
          sessionLookups++;
          return { activity: act(), terminal: false };
        },
        loadSubSessionActivity: async () => {
          subSessionLookups++;
          return { activity: act(), terminal: false };
        },
        getTask: async (id) => ({
          id,
          title: META.title,
          status: "active",
          progress: 60,
          current_status: "实现中",
          context: "{}",
        }),
      }),
    );
    expect(r.ok).toBe(true);
    expect(sessionLookups).toBe(1);   // ← 读 session
    expect(subSessionLookups).toBe(0); // ← 不走 task→bgTask 绕路
    // 而且 task 信息被**同步进卡片**（用户要求一个不少）
    const t = flat(r.cardUpdate);
    expect(t).toContain(`#5360`);
    expect(t).toContain(META.title!);
  });
});

// ============================================================================
// D. task 卡零回归
// ============================================================================

describe("task 卡行为不变（防顺手改坏）", () => {
  test("task 卡仍有建群按钮 + 刷新按钮 + 任务详情 + 执行动态 + 进度", () => {
    const card: any = buildTaskCard({
      status: "running",
      meta: META,
      milestones: [{ title: "Task 创建", timestamp: "2026-11-11T14:00:00.000Z" }],
      activity: act(),
      activityNow: NOW,
    });
    const actions = card.body.elements
      .filter((e: any) => e.tag === "button")
      .map((e: any) => e.value?.action);
    expect(actions).toContain("create_group");
    expect(actions).toContain("refresh_activity");

    const ids = card.body.elements.map((e: any) => e?.element_id).filter(Boolean);
    expect(ids).toContain("task_detail");
    expect(ids).toContain("task_activity");
    expect(ids).toContain("task_timeline");
    expect(flat(card)).toContain("📊 进度");
  });

  test("★ task 卡的刷新按钮仍带 taskId（未被我改成 sessionId）", () => {
    const card: any = buildTaskCard({ status: "running", meta: META });
    const btn = card.body.elements.find(
      (e: any) => e.tag === "button" && e.value?.action === "refresh_activity",
    );
    expect(btn.value.taskId).toBe("5360");
    expect(btn.value.sessionId).toBeUndefined();
  });
});
// ============================================================================
// E. ★ 澄清 22:37 —— task 是「附加增强」，生命周期是 session 层的
// ============================================================================

describe("澄清 22:37：有 task → 信息同步进卡片（一个不少）", () => {
  test("★ task 的 ID/标题/状态/进度/操作记录 全部出现在卡片里", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      task: {
        id: 5360,
        title: "任务通知卡片化改造",
        status: "active",
        progress: 60,
        currentStatus: "TDD 实施中",
        milestones: [
          { title: "Task 创建", timestamp: "2026-11-11T14:00:00.000Z" },
          { title: "方案设计完成", timestamp: "2026-11-11T14:20:00.000Z" },
        ],
      },
      activity: act(),
      activityNow: NOW,
    });

    const taskPanel = panel(card, "task_detail");
    expect(taskPanel).toBeDefined();
    const t = flat(taskPanel);
    expect(t).toContain("#5360");
    expect(t).toContain("任务通知卡片化改造");
    expect(t).toContain("active");
    expect(t).toContain("TDD 实施中");
    // 进度条（renderProgressBar 输出含百分号）
    expect(t).toContain("60");

    // 操作记录时间线
    const timeline = panel(card, "task_timeline");
    expect(timeline).toBeDefined();
    expect(flat(timeline)).toContain("Task 创建");
    expect(flat(timeline)).toContain("方案设计完成");
  });

  test("★ 无 task → 不渲染任何任务面板，但活性照旧（卡片身份不变）", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      activity: act(),
      activityNow: NOW,
    });
    expect(panel(card, "task_detail")).toBeUndefined();
    expect(panel(card, "task_timeline")).toBeUndefined();
    // 活性面板仍在
    expect(flat(panel(card, "task_activity"))).toContain("消息数 88 条");
  });

  test("task 面板位置：会话详情之后、活性之前（信息层级 会话→任务→活性）", () => {
    const card: any = buildSessionCard({
      sessionId: SESSION_ID,
      startedAt: "2026-11-11T14:00:00.000Z",
      task: { id: 1, title: "t" },
      activity: act(),
      activityNow: NOW,
    });
    const ids = card.body.elements.map((e: any) => e?.element_id).filter(Boolean);
    const iDetail = ids.indexOf("session_detail");
    const iTask = ids.indexOf("task_detail");
    const iActivity = ids.indexOf("task_activity");
    expect(iDetail).toBeGreaterThanOrEqual(0);
    expect(iTask).toBeGreaterThan(iDetail);
    expect(iActivity).toBeGreaterThan(iTask);
  });
});

describe("澄清 22:37：生命周期是 session 层的（无 task 也有）", () => {
  test("★ 无 task + 超时 → 卡片显示「已超时」，活性报 ⚪已结束而非 🔴停滞", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      lifecycle: "timeout",
      activity: act({ updatedAt: NOW - 40 * MIN }), // 40 分钟无写入
      activityNow: NOW,
    });
    const t = flat(card);
    expect(t).toContain("已超时");
    // ★ 关键：终态时不该报「疑似停滞」（那是「还在跑但卡住」的信号）
    expect(t).toContain("已结束");
    expect(t).not.toContain("疑似停滞");
  });

  test("★ 无 task + 完成 → 「已完成」+ 绿色 header", () => {
    const card: any = buildSessionCard({
      sessionId: SESSION_ID,
      lifecycle: "completed",
      activity: act(),
      activityNow: NOW,
    });
    expect(flat(card)).toContain("已完成");
    expect(card.header.template).toBe("green");
  });

  test("★ 无 task + 停止 → 「已停止」+ 灰色 header", () => {
    const card: any = buildSessionCard({
      sessionId: SESSION_ID,
      lifecycle: "stopped",
    });
    expect(flat(card)).toContain("已停止");
    expect(card.header.template).toBe("grey");
  });

  test("running → 「运行中」+ 蓝色 header（默认）", () => {
    const card: any = buildSessionCard({ sessionId: SESSION_ID });
    expect(flat(card)).toContain("运行中");
    expect(card.header.template).toBe("blue");
  });

  test("★ 显式 statusPhrase 覆盖 lifecycle 推导的文案", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      lifecycle: "completed",
      statusPhrase: "收尾中（自定义）",
    });
    expect(flat(card)).toContain("收尾中（自定义）");
  });
});

describe("★ 澄清 22:37：刷新时 task 信息与生命周期都要同步", () => {
  test("session 刷新 + 有 task → 卡片含 task 面板 + 活性面板", async () => {
    const r = await handleCardAction(
      {
        actionValue: {
          action: "refresh_activity",
          taskId: "5360",
          sessionId: SESSION_ID,
        } as any,
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      {
        getTask: async (id) => ({
          id,
          title: META.title,
          status: "active",
          progress: 75,
          current_status: "CV 阶段",
          context: "{}",
        }),
        updateTaskContext: async () => {},
        notifier: new LarkCardPatchNotifier(),
        loadSessionActivity: async () => ({ activity: act(), terminal: false }),
      },
    );

    expect(r.ok).toBe(true);
    const t = flat(r.cardUpdate);
    // task 信息进来了
    expect(t).toContain("#5360");
    expect(t).toContain(META.title!);
    expect(t).toContain("CV 阶段");
    // 活性也在
    expect(t).toContain("消息数 88 条");
  });

  test("★ getTask 抛错 → 卡片仍出（只有活性，不整卡失败）", async () => {
    const r = await handleCardAction(
      {
        actionValue: { action: "refresh_activity", taskId: "5360", sessionId: SESSION_ID } as any,
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      {
        getTask: () => {
          throw new Error("task store down");
        },
        updateTaskContext: async () => {},
        notifier: new LarkCardPatchNotifier(),
        loadSessionActivity: async () => ({ activity: act(), terminal: false }),
      },
    );
    expect(r.ok).toBe(true);
    expect(flat(r.cardUpdate)).toContain("消息数 88 条");
  });
});

// ============================================================================
// F. ★ CV 三个 BLOCKER 的回归护栏
// ============================================================================

describe("★ CV BLOCKER-1：task 卡的刷新按钮必须带 sessionId", () => {
  test("★ buildTaskCard(meta.sessionId) → 刷新按钮 value 含 sessionId", () => {
    const card: any = buildTaskCard({
      status: "running",
      meta: { ...META, sessionId: SESSION_ID },
    });
    const btn = card.body.elements.find(
      (e: any) => e.tag === "button" && e.value?.action === "refresh_activity",
    );
    expect(btn.value.sessionId).toBe(SESSION_ID);
    // 仍带 taskId（task 是附加值，不是被替换）
    expect(btn.value.taskId).toBe("5360");
  });

  test("★ 旧卡（value 只有 taskId）→ 通过 resolveSessionIdByTask 反查后仍可刷新", async () => {
    let lookedUp = 0;
    const r = await handleCardAction(
      {
        // 改造前发出去的卡片形态：只有 taskId
        actionValue: { action: "refresh_activity", taskId: "5360" } as any,
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      {
        getTask: async (id) => ({ id, title: META.title, status: "active", context: "{}" }),
        updateTaskContext: async () => {},
        notifier: new LarkCardPatchNotifier(),
        loadSessionActivity: async () => ({ activity: act(), terminal: false }),
        resolveSessionIdByTask: async (tid) => {
          lookedUp++;
          expect(tid).toBe(5360);
          return SESSION_ID;
        },
      },
    );
    expect(lookedUp).toBe(1);
    expect(r.ok).toBe(true); // ← 不再被 "sessionId is required" 打死
    expect(flat(r.cardUpdate)).toContain("消息数 88 条");
  });

  test("★ 反查不到 sessionId → 才拒绝（不猜）", async () => {
    const r = await handleCardAction(
      {
        actionValue: { action: "refresh_activity", taskId: "5360" } as any,
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      {
        getTask: async () => undefined,
        updateTaskContext: async () => {},
        notifier: new LarkCardPatchNotifier(),
        resolveSessionIdByTask: async () => undefined,
      },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("sessionId is required");
  });
});

describe("★ CV BLOCKER-3：session 生命周期能表达 timeout/failed/stopped", () => {
  test("★ createSessionActivityProbe 透传 getLifecycle（不再硬写 terminal:false）", async () => {
    const probe = createSessionActivityProbe({
      getSession: () => ({ messageCount: 5, updatedAt: NOW }),
      getLifecycle: () => "timeout",
    });
    const r = await probe("s1");
    expect(r.lifecycle).toBe("timeout");
    expect(r.terminal).toBe(true);
  });

  test("★ getLifecycle 缺省/抛错 → running（乐观，不凭空宣布结束）", async () => {
    for (const ports of [
      { getSession: () => ({ messageCount: 1, updatedAt: NOW }) },
      {
        getSession: () => ({ messageCount: 1, updatedAt: NOW }),
        getLifecycle: () => {
          throw new Error("boom");
        },
      },
    ]) {
      const r = await createSessionActivityProbe(ports as any)("s1");
      expect(r.lifecycle).toBe("running");
      expect(r.terminal).toBe(false);
    }
  });

  test("★ 无 task 的 session + timeout → 卡片显示「已超时」而不是「运行中」", async () => {
    const r = await handleCardAction(
      {
        actionValue: { action: "refresh_activity", sessionId: SESSION_ID } as any,
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      {
        getTask: async () => undefined,
        updateTaskContext: async () => {},
        notifier: new LarkCardPatchNotifier(),
        loadSessionActivity: async () => ({
          activity: act({ updatedAt: NOW - 40 * MIN }),
          terminal: true,
          lifecycle: "timeout",
        }),
      },
    );
    const t = flat(r.cardUpdate);
    expect(t).toContain("已超时");     // ← 区分出 timeout
    expect(t).not.toContain("已完成");
    expect(t).toContain("已结束");      // ← 活性报终态
  });

  test("★ 三档终态文案各不同（completed / timeout / stopped）", () => {
    const cases: Array<[any, string]> = [
      ["completed", "已完成"],
      ["timeout", "已超时"],
      ["stopped", "已停止"],
      ["failed", "已失败"],
    ];
    for (const [life, phrase] of cases) {
      const card = buildSessionCard({ sessionId: SESSION_ID, lifecycle: life });
      expect(flat(card)).toContain(phrase);
    }
  });
});

describe("★ CV MAJOR-4：session 还活着时，task 的终态不能把卡片判成结束", () => {
  test("★ session 有活性 + task 已完成 → 仍显示运行中（不藏活性）", async () => {
    const r = await handleCardAction(
      {
        actionValue: {
          action: "refresh_activity",
          taskId: "5360",
          sessionId: SESSION_ID,
        } as any,
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      {
        // task 已被标记完成（用户手点 / 旧状态残留）
        getTask: async (id) => ({ id, title: META.title, status: "completed", context: "{}" }),
        updateTaskContext: async () => {},
        notifier: new LarkCardPatchNotifier(),
        // 但 session 3 分钟前还在写
        loadSessionActivity: async () => ({ activity: act(), terminal: false }),
      },
    );
    const t = flat(r.cardUpdate);
    // 活着的 session 不该被 task 的终态覆盖
    expect(t).toContain("运行中");
    expect(t).toContain("🟢");
    expect(t).not.toContain("已结束");
  });
});

// ============================================================================
// G. ★ CV R4 BLOCKER：一张卡承载整个生命周期（不能每个生命周期发一张新卡）
// ============================================================================

describe("★ CV R4：生命周期推进 patch 同一张卡", () => {
  /**
   * 为什么这条必须有：`startSessionCard` 每次都 `messages-send` = 发新消息。
   * 若每个生命周期都 start：一个 session 会产出「启动卡 + 完成卡」两张，
   * 且每张都被 pin（置顶堆积）—— 而用户要的是「超时/完成体现在卡片上」，
   * 也就是**同一张卡**的状态推进。
   */
  function makeSpyNotifier() {
    const n = new LarkCardPatchNotifier();
    const sent: any[] = [];
    const patched: any[] = [];
    // 拦住真实 lark-cli
    (n as any).runLarkCli = async (args: string[], op: string) => {
      const cardJson = args.includes("--content")
        ? args[args.indexOf("--content") + 1]
        : JSON.parse(args[args.indexOf("--data") + 1]).content;
      if (op === "send") {
        sent.push(JSON.parse(cardJson));
        return JSON.stringify({ message_id: `om_session_${sent.length}` });
      }
      patched.push(JSON.parse(cardJson));
      return "{}";
    };
    (n as any).pinMessage = async () => {};
    return { n, sent, patched };
  }

  test("★ 首次 upsert → 发新卡（created=true）", async () => {
    const { n, sent, patched } = makeSpyNotifier();
    const r = await n.upsertSessionCard({
      chatId: "oc_x",
      sessionId: SESSION_ID,
      lifecycle: "running",
    });
    expect(r.created).toBe(true);
    expect(sent).toHaveLength(1);
    expect(patched).toHaveLength(0);
  });

  test("★ 同一 session 的终态 → **patch 同一张卡**（不新增消息）", async () => {
    const { n, sent, patched } = makeSpyNotifier();
    await n.upsertSessionCard({ chatId: "oc_x", sessionId: SESSION_ID, lifecycle: "running" });
    const r2 = await n.upsertSessionCard({
      chatId: "oc_x",
      sessionId: SESSION_ID,
      lifecycle: "completed",
    });

    expect(r2.created).toBe(false);
    expect(sent).toHaveLength(1);      // ← 只有一张卡
    expect(patched).toHaveLength(1);   // ← 终态走 patch
    expect(r2.messageId).toBe("om_session_1");
  });

  test("★ 终态 patch 的卡片显示「已完成」（生命周期真的体现在那张卡上）", async () => {
    const { n, patched } = makeSpyNotifier();
    await n.upsertSessionCard({ chatId: "oc_x", sessionId: SESSION_ID, lifecycle: "running" });
    await n.upsertSessionCard({ chatId: "oc_x", sessionId: SESSION_ID, lifecycle: "completed" });
    expect(JSON.stringify(patched[0])).toContain("已完成");
  });

  test("★ 超时 → patch 出的卡显示「已超时」（区分终态种类）", async () => {
    const { n, patched } = makeSpyNotifier();
    await n.upsertSessionCard({ chatId: "oc_x", sessionId: SESSION_ID, lifecycle: "running" });
    await n.upsertSessionCard({ chatId: "oc_x", sessionId: SESSION_ID, lifecycle: "timeout" });
    const t = JSON.stringify(patched[0]);
    expect(t).toContain("已超时");
    expect(t).not.toContain("已完成");
  });

  test("★ 不同 session 各自一张卡（不串卡）", async () => {
    const { n, sent } = makeSpyNotifier();
    await n.upsertSessionCard({ chatId: "oc_x", sessionId: "s1", lifecycle: "running" });
    await n.upsertSessionCard({ chatId: "oc_x", sessionId: "s2", lifecycle: "running" });
    expect(sent).toHaveLength(2);
  });

  test("★ 里程碑跨生命周期累积（不丢启动那条）", async () => {
    const { n, patched } = makeSpyNotifier();
    await n.upsertSessionCard({
      chatId: "oc_x",
      sessionId: SESSION_ID,
      lifecycle: "running",
      milestones: [{ title: "子会话启动", timestamp: "2026-11-11T14:00:00.000Z" }],
    });
    await n.upsertSessionCard({
      chatId: "oc_x",
      sessionId: SESSION_ID,
      lifecycle: "completed",
      milestones: [{ title: "子会话完成", timestamp: "2026-11-11T15:00:00.000Z" }],
    });
    const t = JSON.stringify(patched[0]);
    expect(t).toContain("子会话启动");
    expect(t).toContain("子会话完成");
  });
});

describe("★ CV R5 MAJOR：生命周期 patch 不能擦掉「消息数 + 最近 msg」", () => {
  function spy() {
    const n = new LarkCardPatchNotifier();
    const sent: any[] = [];
    const patched: any[] = [];
    (n as any).runLarkCli = async (args: string[], op: string) => {
      const json = args.includes("--content")
        ? args[args.indexOf("--content") + 1]
        : JSON.parse(args[args.indexOf("--data") + 1]).content;
      (op === "send" ? sent : patched).push(JSON.parse(json));
      return op === "send" ? JSON.stringify({ message_id: "om_s1" }) : "{}";
    };
    (n as any).pinMessage = async () => {};
    return { n, sent, patched };
  }

  test("★ 终态 patch 未传 activity → 沿用上次的（消息数仍在）", async () => {
    const { n, patched } = spy();
    await n.upsertSessionCard({
      chatId: "oc_x",
      sessionId: SESSION_ID,
      lifecycle: "running",
      activity: act(),
      activityNow: NOW,
    });
    // 终态事件没带 activity（只带 lifecycle）
    await n.upsertSessionCard({
      chatId: "oc_x",
      sessionId: SESSION_ID,
      lifecycle: "completed",
    });

    const t = JSON.stringify(patched[0]);
    expect(t).toContain("已完成");        // 生命周期推进了
    expect(t).toContain("消息数 88 条");  // ← 刷新信息没被擦掉
    expect(t).toContain("delegate 的关联反查");
  });

  test("★ 终态 patch 带新 activity → 用新的（不显示过期数据）", async () => {
    const { n, patched } = spy();
    await n.upsertSessionCard({
      chatId: "oc_x",
      sessionId: SESSION_ID,
      lifecycle: "running",
      activity: act({ messageCount: 10 }),
    });
    await n.upsertSessionCard({
      chatId: "oc_x",
      sessionId: SESSION_ID,
      lifecycle: "completed",
      activity: act({ messageCount: 99 }),
    });
    const t = JSON.stringify(patched[0]);
    expect(t).toContain("消息数 99 条");
    expect(t).not.toContain("消息数 10 条");
  });
});
