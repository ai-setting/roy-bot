/**
 * @fileoverview Task #5580 —— session 卡片任务信息区改造
 *
 * 用户需求（2026-11-13）：
 * 1. 「任务信息」改为该 session 内**所有 task 的 list**；
 *    list 太多 → 罗列最近 5 个 + 展示任务总数（「共 12 个任务，最近 5 个：」）
 * 2. 点击某个任务 → 下面的「执行动态」切换到对应任务
 * 3. 「执行动态」下面新增「任务里程碑」区（task_operation 的 milestone list），
 *    也随点击任务切换
 * 4. task hook 触发的**任务卡片**功能保留（与 session 卡并存）
 *
 * 本文件锁定：
 * A. buildSessionCard 渲染任务列表面板（≤5 + 总数）
 * B. select_task action：白名单 / 校验 / handler 切换渲染
 * C. 任务卡片（buildTaskCard / sendCardStart 路径）行为不变
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  buildSessionCard,
  buildTaskCard,
  LarkCardPatchNotifier,
  type SessionCardTaskSummary,
} from "./lark-card-patch-notifier";
import {
  handleCardAction,
  isCardActionName,
  validateCardActionValue,
  __resetCardActionInflightForTest,
  type CardActionPorts,
} from "./lark-card-action-handler";

const SESSION_ID = "session_5580_task_list";
const MESSAGE_ID = "om_session_card_5580";

function flat(card: unknown): string {
  return JSON.stringify(card);
}

function panel(card: any, id: string): any {
  return (card?.body?.elements ?? []).find((e: any) => e?.element_id === id);
}

function makeSummary(
  id: number,
  title: string,
  over: Partial<SessionCardTaskSummary> = {},
): SessionCardTaskSummary {
  return {
    id,
    ...(title ? { title } : {}),
    ...over,
  };
}

beforeEach(() => {
  __resetCardActionInflightForTest();
});

// ============================================================================
// A. buildSessionCard —— 任务列表面板
// ============================================================================

describe("buildSessionCard — 任务列表（Task #5580 需求一）", () => {
  test("★ tasks 数组 → 渲染「任务列表」面板，逐个列出", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      tasks: [
        makeSummary(1, "任务一"),
        makeSummary(2, "任务二"),
        makeSummary(3, "任务三"),
      ],
    });
    const listPanel = panel(card, "session_task_list");
    expect(listPanel).toBeDefined();
    const t = flat(listPanel);
    expect(t).toContain("#1");
    expect(t).toContain("任务一");
    expect(t).toContain("#2");
    expect(t).toContain("任务二");
    expect(t).toContain("#3");
  });

  test("★ ≤5 个 → 不显示总数前缀（直接罗列）", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      tasks: [makeSummary(1, "a"), makeSummary(2, "b")],
      taskTotal: 2,
    });
    const t = flat(panel(card, "session_task_list"));
    expect(t).toContain("#1");
    expect(t).toContain("#2");
    expect(t).not.toContain("共 2 个任务");
  });

  test("★ >5 个 → 只罗列最近 5 个 + 总数提示「共 N 个任务，最近 5 个」", () => {
    // 调用方按**最近优先**传入（#12 最新 → #1 最旧）
    const tasks = Array.from({ length: 12 }, (_, i) =>
      makeSummary(12 - i, `任务${12 - i}`),
    );
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      tasks,
      taskTotal: 12,
    });
    const listPanel = panel(card, "session_task_list");
    const t = flat(listPanel);
    expect(t).toContain("共 12 个任务");
    expect(t).toContain("最近 5 个");
    // 最近 5 个在列（#12 最新 → #8）
    expect(t).toContain("#12 ");
    expect(t).toContain("#8 ");
    // 第 6 新的（#7）与最旧的都不出现
    expect(t).not.toContain("#7 ");
    expect(t).not.toContain("#1 ");
    // 面板里正好 5 个 select 按钮
    const btns = (listPanel.elements ?? []).filter(
      (e: any) => e?.tag === "button" && e?.value?.action === "select_task",
    );
    expect(btns.length).toBe(5);
  });

  test("★ 每个任务条目带 select_task 按钮（点击切换执行动态）", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      tasks: [makeSummary(7, "点我"), makeSummary(8, "点我二")],
    });
    const buttons = (card.body.elements ?? [])
      .flatMap((e: any) =>
        e?.tag === "collapsible_panel" ? (e?.elements ?? []) : [e],
      )
      .filter((e: any) => e?.tag === "button")
      .map((e: any) => e?.value);
    const selectBtns = buttons.filter((v: any) => v?.action === "select_task");
    expect(selectBtns.length).toBe(2);
    for (const v of selectBtns) {
      expect(v.sessionId).toBe(SESSION_ID);
      expect(["7", "8"]).toContain(String(v.taskId));
    }
  });

  test("★ 无 tasks → 不渲染任务列表面板（零噪音）", () => {
    const card = buildSessionCard({ sessionId: SESSION_ID });
    expect(panel(card, "session_task_list")).toBeUndefined();
  });

  test("★ 选中任务（selectedTask）→ 「执行动态」面板渲染该任务的里程碑", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      tasks: [makeSummary(1, "t1"), makeSummary(2, "t2")],
      selectedTask: {
        ...makeSummary(2, "t2"),
        status: "active",
        progress: 40,
        currentStatus: "推进中",
      },
      selectedTaskMilestones: [
        { title: "Task 创建", timestamp: "2026-11-13T10:00:00.000Z" },
        { title: "方案设计完成", timestamp: "2026-11-13T11:00:00.000Z" },
      ],
    });
    // 选中任务的里程碑进「任务里程碑」面板
    const msPanel = panel(card, "session_task_milestones");
    expect(msPanel).toBeDefined();
    const t = flat(msPanel);
    expect(t).toContain("Task 创建");
    expect(t).toContain("方案设计完成");
    // 选中任务的信息也可见
    expect(flat(card)).toContain("#2");
    expect(flat(card)).toContain("推进中");
  });

  test("★ 未选中任务 → 不渲染任务里程碑面板", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      tasks: [makeSummary(1, "t1")],
    });
    expect(panel(card, "session_task_milestones")).toBeUndefined();
  });

  test("★ 旧的单 task 区块（task 入参）仍渲染 —— 兼容不回归", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      task: {
        id: 99,
        title: "旧区块任务",
        status: "active",
      },
      tasks: [makeSummary(99, "旧区块任务")],
    });
    // 旧 task_detail 面板仍在（不破坏 #5364 语义）
    expect(panel(card, "task_detail")).toBeDefined();
    expect(flat(panel(card, "task_detail"))).toContain("#99");
  });
});

// ============================================================================
// B. select_task action
// ============================================================================

describe("select_task action（Task #5580 需求一.2/.3）", () => {
  test("★ 白名单包含 select_task", () => {
    expect(isCardActionName("select_task")).toBe(true);
  });

  test("★ validateCardActionValue：select_task 需要 sessionId + taskId", () => {
    const ok = validateCardActionValue({
      action: "select_task",
      sessionId: SESSION_ID,
      taskId: "5",
    });
    expect(ok.ok).toBe(true);
    const missing = validateCardActionValue({ action: "select_task" });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("sessionId");
  });

  test("★ 点击任务 → 卡片渲染该任务的执行动态 + 任务里程碑区", async () => {
    const ports: CardActionPorts = {
      getTask: async (id) => ({
        id,
        title: `任务${id}`,
        status: "active",
        progress: 55,
        current_status: "TDD 实施中",
        context: "{}",
      }),
      loadSessionTasks: async () => [
        makeSummary(1, "任务1"),
        makeSummary(2, "任务2"),
      ],
      loadTaskMilestones: async (taskId) => [
        { title: `任务${taskId} 创建`, timestamp: "2026-11-13T10:00:00.000Z" },
        { title: `任务${taskId} 里程碑`, timestamp: "2026-11-13T11:00:00.000Z" },
      ],
      loadSessionActivity: async () => ({
        activity: {
          subSessionId: SESSION_ID,
          messageCount: 10,
          updatedAt: Date.now() - 60 * 1000,
        },
        terminal: false,
      }),
      notifier: new LarkCardPatchNotifier(),
    };
    const r = await handleCardAction(
      {
        actionValue: {
          action: "select_task",
          sessionId: SESSION_ID,
          taskId: "2",
        },
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      ports,
    );
    expect(r.ok).toBe(true);
    const t = flat(r.cardUpdate);
    // 切到任务 #2
    expect(t).toContain("#2");
    expect(t).toContain("任务2");
    expect(t).toContain("TDD 实施中");
    // 里程碑区是该任务的
    const msPanel = panel(r.cardUpdate, "session_task_milestones");
    expect(msPanel).toBeDefined();
    expect(flat(msPanel)).toContain("任务2 创建");
    expect(flat(msPanel)).toContain("任务2 里程碑");
    // 任务列表仍在（可继续切换）
    expect(panel(r.cardUpdate, "session_task_list")).toBeDefined();
  });

  test("★ 缺 sessionId → 明确报字段名（不猜）", async () => {
    const r = await handleCardAction(
      {
        actionValue: { action: "select_task", taskId: "2" },
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      { notifier: new LarkCardPatchNotifier() },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("sessionId");
  });

  test("★ getTask 失败 → 降级不整卡失败（best-effort 语义）", async () => {
    const r = await handleCardAction(
      {
        actionValue: {
          action: "select_task",
          sessionId: SESSION_ID,
          taskId: "404",
        },
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      {
        getTask: async () => undefined,
        // ★ CV P5：task #404 必须在列表内（否则 membership 校验会先拒绝，
        //   测不到「getTask 失败降级」这条路径）
        loadSessionTasks: async () => [
          makeSummary(1, "唯一任务"),
          makeSummary(404, "读不到的任务"),
        ],
        notifier: new LarkCardPatchNotifier(),
      },
    );
    expect(r.ok).toBe(true);
    // 任务列表仍在（用户可点别的）
    expect(panel(r.cardUpdate, "session_task_list")).toBeDefined();
    // getTask 读不到 → 用**列表条目**兜底选中态（不整卡失败），
    // 里程碑区照出但诚实写「暂无里程碑」（不是静默消失）
    const ms = panel(r.cardUpdate, "session_task_milestones");
    expect(ms).toBeDefined();
    expect(flat(ms)).toContain("暂无里程碑");
  });
});

// ============================================================================
// C. 任务卡片功能保留（需求二）
// ============================================================================

  test("★ 面板顺序：任务列表 → 任务信息 → 执行动态 → 任务里程碑（用户指定次序）", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      tasks: [makeSummary(2, "任务二")],
      selectedTask: makeSummary(2, "任务二"),
      selectedTaskMilestones: [
        { title: "任务2 里程碑", timestamp: "2026-11-13T11:00:00.000Z" },
      ],
      milestones: [{ title: "子会话启动", timestamp: "2026-11-13T09:00:00.000Z" }],
    });
    const ids = (card.body.elements ?? [])
      .filter((e: any) => e?.tag === "collapsible_panel")
      .map((e: any) => e.element_id);
    const iList = ids.indexOf("session_task_list");
    const iDetail = ids.indexOf("session_selected_task_detail");
    const iTimeline = ids.indexOf("session_timeline");
    const iMilestones = ids.indexOf("session_task_milestones");
    expect(iList).toBeGreaterThanOrEqual(0);
    expect(iDetail).toBeGreaterThan(iList);
    // 执行动态在任务里程碑**之前**（用户：「执行动态」下面新增「任务里程碑」）
    expect(iTimeline).toBeGreaterThanOrEqual(0);
    expect(iMilestones).toBeGreaterThan(iTimeline);
  });

// ============================================================================
// D. state carry-forward：后续 lifecycle patch 不能擦掉任务列表
// ============================================================================

describe("session 卡状态沿用（Task #5580）", () => {
  test("★ 首卡带任务列表后，后续 lifecycle patch 不擦掉列表", () => {
    const n = new LarkCardPatchNotifier({ runLarkCli: async () => "" } as any);
    // 直接种 state（绕过真实发卡）
    (n as any).sessionCardIds.set(SESSION_ID, MESSAGE_ID);
    (n as any).rememberSessionCard(MESSAGE_ID, {
      sessionId: SESSION_ID,
      milestones: [],
      updateCount: 1,
      sessionTasks: [makeSummary(1, "任务一"), makeSummary(2, "任务二")],
      taskTotal: 2,
    });

    const card = n.buildSessionCardWithActivity(MESSAGE_ID, SESSION_ID, null, {
      lifecycle: "completed",
    });
    expect(card).toBeDefined();
    const listPanel = panel(card, "session_task_list");
    expect(listPanel).toBeDefined();
    expect(flat(listPanel)).toContain("#1");
    expect(flat(listPanel)).toContain("#2");
  });

  test("★ 选中任务后，后续 patch 仍保留选中任务的里程碑区", () => {
    const n = new LarkCardPatchNotifier({ runLarkCli: async () => "" } as any);
    (n as any).sessionCardIds.set(SESSION_ID, MESSAGE_ID);
    (n as any).rememberSessionCard(MESSAGE_ID, {
      sessionId: SESSION_ID,
      milestones: [],
      updateCount: 2,
      sessionTasks: [makeSummary(2, "任务二")],
      selectedTask: makeSummary(2, "任务二"),
      selectedTaskMilestones: [
        { title: "任务2 里程碑", timestamp: "2026-11-13T11:00:00.000Z" },
      ],
    });

    const card = n.buildSessionCardWithActivity(MESSAGE_ID, SESSION_ID, null, {});
    expect(card).toBeDefined();
    const ms = panel(card, "session_task_milestones");
    expect(ms).toBeDefined();
    expect(flat(ms)).toContain("任务2 里程碑");
  });

  test("★ 刷新（refresh_activity）也会带回任务列表（不擦面板）", async () => {
    const r = await handleCardAction(
      {
        actionValue: { action: "refresh_activity", sessionId: SESSION_ID },
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      {
        notifier: new LarkCardPatchNotifier(),
        loadSessionActivity: async () => ({
          activity: { subSessionId: SESSION_ID, messageCount: 3, updatedAt: Date.now() },
          terminal: false,
        }),
        loadSessionTasks: async () => [
          makeSummary(11, "刷新后仍在"),
          makeSummary(12, "第二个"),
        ],
      },
    );
    expect(r.ok).toBe(true);
    const listPanel = panel(r.cardUpdate, "session_task_list");
    expect(listPanel).toBeDefined();
    expect(flat(listPanel)).toContain("#11");
    expect(flat(listPanel)).toContain("刷新后仍在");
  });

  test("★ 查了确实没有任务（[]）能覆盖旧列表（不让旧数据永远擦不掉）", () => {
    const n = new LarkCardPatchNotifier({ runLarkCli: async () => "" } as any);
    (n as any).sessionCardIds.set(SESSION_ID, MESSAGE_ID);
    (n as any).rememberSessionCard(MESSAGE_ID, {
      sessionId: SESSION_ID,
      milestones: [],
      updateCount: 1,
      sessionTasks: [makeSummary(1, "旧任务")],
      taskTotal: 1,
    });

    const card = n.buildSessionCardWithActivity(MESSAGE_ID, SESSION_ID, null, {
      sessionTasks: [],
    });
    expect(card).toBeDefined();
    expect(panel(card, "session_task_list")).toBeUndefined();
  });
});

// ============================================================================
// E. CV 自审发现的缺陷（P2 / P5 / P6 / P9 / P12）
// ============================================================================

describe("CV 缺陷守护（Task #5580）", () => {
  test("★ P2：selectedTask 与绑定 task 相同时，不重复渲染两块任务详情", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      // 旧的单 task 区块（session 绑定的那个 task）
      task: { id: 7, title: "绑定任务", status: "active" },
      tasks: [makeSummary(7, "绑定任务"), makeSummary(8, "另一个")],
      // 用户点了同一个 task
      selectedTask: makeSummary(7, "绑定任务"),
      selectedTaskMilestones: [],
    });
    // 旧区块（task_detail）让位；选中区块（session_selected_task_detail）在
    expect(panel(card, "task_detail")).toBeUndefined();
    expect(panel(card, "session_selected_task_detail")).toBeDefined();
  });

  test("★ P2：selectedTask 与绑定 task 不同时，两块都在", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      task: { id: 7, title: "绑定任务", status: "active" },
      tasks: [makeSummary(7, "绑定任务"), makeSummary(8, "另一个")],
      selectedTask: makeSummary(8, "另一个"),
      selectedTaskMilestones: [],
    });
    expect(panel(card, "task_detail")).toBeDefined();
    expect(panel(card, "session_selected_task_detail")).toBeDefined();
  });

  test("★ P5：taskId 不属于该 session → 拒绝切换（不展示越界任务）", async () => {
    const r = await handleCardAction(
      {
        actionValue: { action: "select_task", sessionId: SESSION_ID, taskId: "999" },
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      {
        getTask: async (id) => ({
          id,
          title: `越界任务${id}`,
          status: "active",
          context: "{}",
        }),
        loadSessionTasks: async () => [makeSummary(1, "本会话任务")],
        notifier: new LarkCardPatchNotifier(),
      },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not a member");
  });

  test("★ P5：列表读不到（数据源不可用）→ 不拦，正常切换", async () => {
    const r = await handleCardAction(
      {
        actionValue: { action: "select_task", sessionId: SESSION_ID, taskId: "5" },
        chatId: "oc_x",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      {
        getTask: async (id) => ({ id, title: `任务${id}`, status: "active", context: "{}" }),
        loadSessionTasks: async () => [],
        notifier: new LarkCardPatchNotifier(),
      },
    );
    expect(r.ok).toBe(true);
  });

  test("★ P6：端口返回 { tasks, total } → 「共 N 个任务」用真实 total", () => {
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      tasks: [makeSummary(30, "t30"), makeSummary(29, "t29")],
      taskTotal: 47,
    });
    const t = flat(panel(card, "session_task_list"));
    expect(t).toContain("共 47 个任务");
  });

  test("★ P9：taskId 存在但非法 → 报 Invalid（不是 Missing）", () => {
    const bad = validateCardActionValue({
      action: "select_task",
      sessionId: SESSION_ID,
      taskId: "abc",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error).toContain("Invalid taskId");
      expect(bad.error).not.toContain("Missing required field: taskId");
    }
    const missing = validateCardActionValue({
      action: "select_task",
      sessionId: SESSION_ID,
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toContain("Missing required field: taskId");
  });

  test("★ P12：传入顺序错乱也保证按 id 降序取「最近 5 个」", () => {
    // 故意打乱（且不按 id 升序）
    const shuffled = [
      makeSummary(3, "t3"),
      makeSummary(12, "t12"),
      makeSummary(7, "t7"),
      makeSummary(9, "t9"),
      makeSummary(1, "t1"),
      makeSummary(11, "t11"),
    ];
    const card = buildSessionCard({
      sessionId: SESSION_ID,
      tasks: shuffled,
      taskTotal: 6,
    });
    const t = flat(panel(card, "session_task_list"));
    // 最近 5 个 = 12, 11, 9, 7, 3；#1 落选
    expect(t).toContain("#12");
    expect(t).toContain("#11");
    expect(t).toContain("#9");
    expect(t).toContain("#7");
    expect(t).toContain("#3");
    const btns = (panel(card, "session_task_list").elements ?? []).filter(
      (e: any) => e?.tag === "button",
    );
    expect(btns.length).toBe(5);
    expect(btns.map((b: any) => b.value.taskId)).toEqual(["12", "11", "9", "7", "3"]);
  });
});

describe("任务卡片功能保留（Task #5580 需求二）", () => {
  test("★ buildTaskCard 行为不变：建群按钮 + 任务详情 + 执行动态 + 进度", () => {
    const card: any = buildTaskCard({
      status: "running",
      meta: { id: 5580, title: "保留的任务卡" },
      milestones: [{ title: "Task 创建", timestamp: "2026-11-13T10:00:00.000Z" }],
    });
    const actions = card.body.elements
      .filter((e: any) => e.tag === "button")
      .map((e: any) => e.value?.action);
    expect(actions).toContain("create_group");
    expect(actions).toContain("refresh_activity");
    const ids = card.body.elements.map((e: any) => e?.element_id).filter(Boolean);
    expect(ids).toContain("task_detail");
    expect(ids).toContain("task_timeline");
    expect(flat(card)).toContain("📊 进度");
    expect(flat(card)).toContain("保留的任务卡");
  });

  test("★ session 卡的改造不影响 task 卡渲染（两卡并存语义）", () => {
    const sessionCard = buildSessionCard({
      sessionId: SESSION_ID,
      tasks: [makeSummary(1, "t1")],
    });
    const taskCard: any = buildTaskCard({
      status: "running",
      meta: { id: 1, title: "t1" },
    });
    // session 卡 header 是子会话；task 卡 header 是 Task
    expect(flat(sessionCard)).toContain("会话卡实时更新");
    expect(flat(taskCard)).toContain("任务卡实时更新");
    // task 卡没有 session_task_list 面板
    expect(panel(taskCard, "session_task_list")).toBeUndefined();
  });
});

// ============================================================================
// D. 需求二：任务卡片与 session 卡片**并存**（Task #5580 反转 #5364 单卡语义）
// ============================================================================

  test("★★ 终态 update：session 卡 patch 之外，任务卡片也收尾（不永不 unpin）", async () => {
    const { LarkCliTaskNotifyHook } = await import("./lark-cli-task-notify-plugin");
    const finishCalls: any[] = [];
    const notifier = {
      // session 卡 patch 成功（模拟有 session 卡）
      upsertSessionCard: async () => ({ messageId: "om_session_5580c" }),
      getSessionIdByTask: () => "session_5580_coexist",
      getSessionCardMessageId: () => "om_session_5580c",
      startTask: async () => ({ messageId: "om_task_5580c", pinned: true }),
      finishTask: async (opts: any) => {
        finishCalls.push(opts);
      },
      bindTaskToSession: () => {},
    };
    const plugin = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: {
        get: () => ({
          taskId: 5580,
          messageId: "om_task_5580c",
          chatId: "oc_5580",
          pinned: true,
          status: "open",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
        upsert: () => {},
        list: () => [],
        markPinned: () => {},
        markPaused: () => {},
        markReopened: () => {},
        markClosed: () => {},
        delete: () => {},
        close: () => {},
      } as any,
    } as any);

    await (
      plugin as unknown as { onAfterUpdate: (ctx: unknown) => Promise<void> }
    ).onAfterUpdate({
      data: {
        task: {
          id: 5580,
          title: "终态并存",
          status: "completed",
          progress: 100,
          context: JSON.stringify({ larkPerTaskChatId: "oc_5580" }),
          createdAt: "2026-11-13T10:00:00.000Z",
        },
        changes: { status: "completed" },
      },
    });

    // 任务卡片必须收尾（completed 文案 + unpin），不能因为 session 卡
    // patch 成功就 return 掉。
    expect(finishCalls.length).toBe(1);
    expect(finishCalls[0].status).toBe("completed");
  });

describe("需求二：task hook 任务卡片保留并 pin（与 session 卡并存）", () => {
  test("★★ onAfterCreate 有 sessionId → 既 patch session 卡，也发 task 卡（+pin）", async () => {
    const { LarkCliTaskNotifyHook } = await import("./lark-cli-task-notify-plugin");
    const upserts: Array<Record<string, unknown>> = [];
    const taskCardStarts: any[] = [];
    const notifier = {
      upsertSessionCard: async (opts: Record<string, unknown>) => {
        upserts.push(opts);
        return { messageId: "om_session_5580" };
      },
      getSessionIdByTask: () => undefined,
      startTask: async (opts: any) => {
        taskCardStarts.push(opts);
        return { messageId: "om_task_5580", pinned: true };
      },
      bindTaskToSession: () => {},
      getSessionCardMessageId: () => "om_session_5580",
    };
    const plugin = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
    } as any);

    await (
      plugin as unknown as { onAfterCreate: (ctx: unknown) => Promise<void> }
    ).onAfterCreate({
      data: {
        task: {
          id: 5580,
          title: "并存验证",
          status: "active",
          progress: 10,
          current_status: "进行中",
          createdAt: "2026-11-13T10:00:00.000Z",
          context: JSON.stringify({ larkPerTaskChatId: "oc_5580" }),
        },
        sessionId: "session_5580_coexist",
      },
    });

    // ① session 卡照常 patch（需求一）
    expect(upserts.length).toBe(1);
    // ② 任务卡片也发出来（需求二：不能只有 session 卡）
    expect(taskCardStarts.length).toBe(1);
    expect(taskCardStarts[0].chatId).toBe("oc_5580");
    expect(taskCardStarts[0].meta?.id).toBe(5580);
  });

  test("★★ CV P1：update 阶段复用的是 create 写入的 task 卡 messageId（身份断言）", async () => {
    const { LarkCliTaskNotifyHook } = await import("./lark-cli-task-notify-plugin");
    const notifier = {
      upsertSessionCard: async () => ({ messageId: "om_session_p1" }),
      getSessionIdByTask: () => "session_p1",
      getSessionCardMessageId: () => "om_session_p1",
      startTask: async () => ({ messageId: "om_task_p1", pinned: true }),
      // update 侧调用点：用它断言「复用同一个 messageId」
      updateTask: async () => true,
      bindTaskToSession: () => {},
    };
    const store = new Map<number, any>();
    const cardStateStore = {
      get: (id: number) => store.get(id),
      upsert: (st: any) => {
        store.set(st.taskId, st);
      },
      list: () => [...store.values()],
      markPinned: () => {},
      markPaused: () => {},
      markReopened: () => {},
      markClosed: () => {},
      delete: () => {},
      close: () => {},
    };
    const plugin = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore,
    } as any);

    // ① create → 任务卡发卡，并把 messageId 落进 task 卡槽位
    await (
      plugin as unknown as { onAfterCreate: (ctx: unknown) => Promise<void> }
    ).onAfterCreate({
      data: {
        task: {
          id: 5580,
          title: "身份断言",
          status: "active",
          progress: 5,
          context: JSON.stringify({ larkPerTaskChatId: "oc_p1" }),
          createdAt: "2026-11-13T10:00:00.000Z",
        },
        sessionId: "session_p1",
      },
    });
    expect(store.get(5580)?.messageId).toBe("om_task_p1");

    // ② update → 必须复用它（不是新发一张，也不是 session 卡 id）
    const updateCalls: any[] = [];
    (notifier as any).updateTask = async (o: any) => {
      updateCalls.push(o);
      return true;
    };
    await (
      plugin as unknown as { onAfterUpdate: (ctx: unknown) => Promise<void> }
    ).onAfterUpdate({
      data: {
        task: {
          id: 5580,
          title: "身份断言",
          status: "active",
          progress: 40,
          context: JSON.stringify({ larkPerTaskChatId: "oc_p1" }),
          createdAt: "2026-11-13T10:00:00.000Z",
        },
        changes: { progress: 40 },
      },
    });
    expect(updateCalls.length).toBeGreaterThan(0);
    expect(updateCalls[0].messageId).toBe("om_task_p1");
    expect(updateCalls[0].messageId).not.toBe("om_session_p1");
  });

  test("★★ 关闭开关（emitTaskCard=false）→ 退回单卡语义（可回滚）", async () => {
    const { LarkCliTaskNotifyHook } = await import("./lark-cli-task-notify-plugin");
    const upserts: Array<Record<string, unknown>> = [];
    const taskCardStarts: any[] = [];
    const notifier = {
      upsertSessionCard: async (opts: Record<string, unknown>) => {
        upserts.push(opts);
        return { messageId: "om_session_5580b" };
      },
      getSessionIdByTask: () => undefined,
      startTask: async (opts: any) => {
        taskCardStarts.push(opts);
        return { messageId: "om_task_5580b", pinned: true };
      },
      bindTaskToSession: () => {},
      getSessionCardMessageId: () => "om_session_5580b",
    };
    const plugin = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      emitTaskCard: false,
    } as any);

    await (
      plugin as unknown as { onAfterCreate: (ctx: unknown) => Promise<void> }
    ).onAfterCreate({
      data: {
        task: {
          id: 5581,
          title: "单卡回滚",
          status: "active",
          context: JSON.stringify({ larkPerTaskChatId: "oc_5581" }),
        },
        sessionId: "session_5581_single",
      },
    });

    expect(upserts.length).toBe(1);
    expect(taskCardStarts.length).toBe(0);
  });
});

// ============================================================================
// E. 交叉验证（CV）自审：四个高风险点的回归护栏
// ============================================================================
//
// CV 用换模型独立评审时反复空转（输出只有工具调用，无结论），改为主智能体
// 逐条代码自审 + 用测试固化结论。这四条正是当时怀疑的对象。

describe("CV 风险点固化（Task #5580）", () => {
  test("★ R1：select_task 缺 taskId → 硬失败（不像 create_group 那样降级 session-only）", () => {
    const v = validateCardActionValue({
      action: "select_task",
      sessionId: "s1",
      // 故意不给 taskId
    });
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.error).toContain("taskId");
  });

  test("★ R2：单卡模式（emitTaskCard=false）session 卡 id 仍写进 cardMessageIds（后续 patch 可达）", async () => {
    const { LarkCliTaskNotifyHook } = await import("./lark-cli-task-notify-plugin");
    const store: any = {
      recs: new Map<number, any>(),
      get(id: number) {
        return this.recs.get(id);
      },
      upsert(r: any) {
        this.recs.set(r.taskId, r);
      },
      list() {
        return [...this.recs.values()];
      },
    };
    const notifier = {
      upsertSessionCard: async () => ({ messageId: "om_session_r2" }),
      getSessionIdByTask: () => undefined,
      startTask: async () => ({ messageId: "om_task_r2", pinned: true }),
      bindTaskToSession: () => {},
      getSessionCardMessageId: () => "om_session_r2",
    };
    const plugin: any = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
      cardStateStore: store,
      emitTaskCard: false,
    } as any);
    await plugin.onAfterCreate({
      data: {
        task: {
          id: 7,
          title: "t",
          status: "active",
          context: JSON.stringify({ larkPerTaskChatId: "oc_7" }),
        },
        sessionId: "s7",
      },
    });
    // 单卡模式：后续 task update/finish 必须能找到这张 session 卡
    expect(plugin.cardMessageIds.get(7)).toBe("om_session_r2");
  });

  test("★★ R4：两卡并存时 task 终态 patch 的是**任务卡**（不打死 session 卡）", async () => {
    const { LarkCliTaskNotifyHook } = await import("./lark-cli-task-notify-plugin");
    const finished: any[] = [];
    const notifier: any = {
      upsertSessionCard: async () => ({ messageId: "om_SESSION_R4" }),
      getSessionIdByTask: () => "s9",
      startTask: async () => ({ messageId: "om_TASK_R4", pinned: true }),
      finishTask: async (o: any) => {
        finished.push(o);
      },
      bindTaskToSession: () => {},
      getSessionCardMessageId: () => "om_SESSION_R4",
      isSessionCardMessage: (id: string) => id === "om_SESSION_R4",
    };
    const plugin: any = new LarkCliTaskNotifyHook({
      cardMode: true,
      cardNotifier: notifier,
    } as any);
    const task: any = {
      id: 9,
      title: "t",
      status: "active",
      progress: 5,
      context: JSON.stringify({ larkPerTaskChatId: "oc_9" }),
    };
    await plugin.onAfterCreate({ data: { task, sessionId: "s9" } });
    expect(plugin.cardMessageIds.get(9)).toBe("om_TASK_R4");
    await plugin.onAfterUpdate({
      data: {
        task: { ...task, status: "completed" },
        changes: { status: "completed" },
      },
    });
    expect(finished.length).toBeGreaterThan(0);
    expect(finished[0].messageId).toBe("om_TASK_R4");
  });

  test("★ R3：select_task 在没有活性端口时不写「暂无数据」（那是「查了没有」的语义）", async () => {
    const r = await handleCardAction(
      {
        actionValue: { action: "select_task", sessionId: "sR3", taskId: "1" },
        chatId: "oc",
        messageId: "om",
        token: "t",
      },
      {
        notifier: new LarkCardPatchNotifier(),
        getTask: async (id) => ({ id, title: "x", status: "active", context: "{}" }),
        loadSessionTasks: async () => [makeSummary(1, "x")],
      },
    );
    expect(r.ok).toBe(true);
    expect(flat(r.cardUpdate)).not.toContain("暂无数据");
  });
});
