/**
 * @fileoverview Task #5360 — 飞书卡片「💬 会话查看」按钮端到端（原「刷新活性」，Task #5420 改名）
 *
 * ## 用户诉求（2026-11-11 20:50）
 *
 * > 「卡片新增「刷新」按钮（类似企微卡片的刷新按钮）：按下后展示该任务对应
 * >   subsession 的消息数 + 最近一条 msg（截断）—— 用来判断有无 LLM 推进」
 *
 * ## 本文件锁定的不变量
 *
 * A. `buildTaskCard` 顶部**多一个**刷新按钮，且**原来的建群/解散群按钮不变**
 * B. 点击 → `handleCardAction` 返回 `cardUpdate`（patch 原卡，不发新卡）
 * C. 刷新**绝不改任务状态**（不调 updateTask / 不改 context / 不改 updateCount）
 * D. 无活性数据 → 面板照出 + 「暂无数据」（按钮必须有反馈）
 * E. **旧字段一个都不能少**（用户明令第 4 条）：header / 任务详情 / 执行动态 / 进度
 * F. 未知 action **不会**走解散群分支（防误伤，改造前的 if/else 隐患）
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  handleCardAction,
  isCardActionName,
  __resetCardActionInflightForTest,
  type CardActionPorts,
} from "./lark-card-action-handler";
import {
  LarkCardPatchNotifier,
  buildTaskCard,
  type Milestone,
  type TaskMeta,
} from "./lark-card-patch-notifier";
import type { ActivityProbeResult, SubSessionActivity } from "./sub-session-activity";

// ★ 相对时间基准（原为硬编码 `new Date(2026,10,11,20,47,12)` —— 一旦真实
//   时钟走过该时刻，「3 分钟前写入」就变成「十几小时前写入」，liveness 从
//   🟢 变 🔴，本文件多条断言会随时间推移无端变红）。活性判定是相对量，
//   基准必须跟着 now 走。
const NOW = Date.now();
const MIN = 60 * 1000;
const TASK_ID = 5360;
const MESSAGE_ID = "om_card_5360";
const SESSION_ID = "session_04357c17-9ff8-4e3d-a498-bc254da5caf9";

const META: TaskMeta = {
  id: TASK_ID,
  title: "任务通知卡片化改造",
  description: "用卡片替代文本通知 + 新增 subsession 活性展示",
  goals: "1. 卡片化 2. 刷新按钮 3. 企微同步",
  priority: "high",
  type: "normal",
  projectPath: "~/work/codework/personal/roy_world/roy-bot",
  currentStatus: "TDD 实施中",
};

const MILESTONES: Milestone[] = [
  { title: "Task 创建", timestamp: "2026-11-11T12:47:00.000Z" },
  { title: "方案设计完成", timestamp: "2026-11-11T12:50:00.000Z" },
];

function act(overrides: Partial<SubSessionActivity> = {}): SubSessionActivity {
  return {
    subSessionId: "session_sub_5360",
    messageCount: 128,
    updatedAt: NOW - 3 * MIN,
    lastMessage: {
      role: "assistant",
      content: "已定位到 wecom-card-builder.ts:485 的按钮覆盖逻辑",
    },
    ...overrides,
  };
}

function probeResult(
  overrides: Partial<ActivityProbeResult> = {},
): ActivityProbeResult {
  return { activity: act(), terminal: false, ...overrides };
}

/**
 * 造一个"已经发过卡"的 notifier（内部有 messageId 的累计 state）。
 *
 * 直接操作私有 states 太脆，所以用 `hydrateState`（公开的持久层恢复入口）
 * 灌一份快照 —— 这正是真实进程重启后的路径。
 */
function makeHydratedNotifier(): LarkCardPatchNotifier {
  const n = new LarkCardPatchNotifier();
  // ★ 澄清 22:37：刷新路径读 session 卡状态（session 是主键）——
  //   这里同时把 task 卡状态与 session 卡状态都灌进去，模拟真实进程内状态。
  n.rememberSessionCard(MESSAGE_ID, {
    title: META.title,
    statusPhrase: "运行中",
    agentType: "roy",
    startedAt: "2026-11-11T12:47:00.000Z",
    milestones: MILESTONES,
    updateCount: 3,
  });
  n.hydrateState(MESSAGE_ID, {
    chatId: "oc_test",
    profile: "tongzhuli",
    meta: META,
    startedAt: "2026-11-11T12:47:00.000Z",
    updateCount: 3,
    spinnerIndex: 1,
    milestones: MILESTONES,
    processSteps: [],
    progress: 42,
  });
  return n;
}

function makePorts(
  overrides: Partial<CardActionPorts> = {},
): CardActionPorts & { patched: unknown[] } {
  const patched: unknown[] = [];
  const ports: CardActionPorts & { patched: unknown[] } = {
    getTask: async (id) => ({
      id,
      title: META.title,
      status: "active",
      progress: 42,
      context: "{}",
      current_status: META.currentStatus,
      // ★ 澄清 22:37：操作记录随 task 信息一起进卡片
      milestones: MILESTONES,
    }),
    updateTaskContext: async () => {},
    notifier: makeHydratedNotifier(),
    patchByToken: async (_token, card) => {
      patched.push(card);
    },
    loadSessionActivity: async () => probeResult(),
    patched,
    ...overrides,
  };
  return ports;
}

function click(
  action: "create_group" | "disband_group" | "refresh_activity",
  ports: CardActionPorts,
) {
  return handleCardAction(
    {
      // ★ 澄清 22:37：sessionId 是卡片主键（必需），taskId 是附加增强。
      //   这些用例验证「有 task 的卡片仍保留全部 task 信息」，所以两者都给。
      actionValue: {
        action,
        taskId: String(TASK_ID),
        sessionId: SESSION_ID,
      },
      chatId: "oc_test",
      messageId: MESSAGE_ID,
      token: "tok_30min",
      profile: "tongzhuli",
    },
    ports as CardActionPorts,
  );
}

/** 把卡片 JSON 压成可 grep 的字符串（断言"某字段还在不在"用） */
function flat(card: unknown): string {
  return JSON.stringify(card);
}

/** 取 body.elements 里指定 elementId 的面板 */
function findPanel(card: any, elementId: string): any | undefined {
  return (card?.body?.elements ?? []).find(
    (e: any) => e?.element_id === elementId,
  );
}

beforeEach(() => {
  __resetCardActionInflightForTest();
});

// ============================================================================
// A. buildTaskCard：刷新按钮
// ============================================================================

describe("buildTaskCard — 会话查看按钮（Task #5360，#5420 改名）", () => {
  test("★ 顶部第 1 个按钮仍是建群/解散群（旧行为零变更）", () => {
    const card = buildTaskCard({ status: "running", meta: META });
    const first = card.body.elements[0] as any;
    expect(first.tag).toBe("button");
    expect(first.value.action).toBe("create_group");
    expect(first.value.taskId).toBe(String(TASK_ID));
  });

  test("★ 第 2 个按钮是「💬 会话查看」（原「刷新活性」，#5420 改名），action=refresh_activity", () => {
    const card = buildTaskCard({ status: "running", meta: META });
    const second = card.body.elements[1] as any;
    expect(second.tag).toBe("button");
    expect(second.text.content).toBe("💬 会话查看"); // ★ Task #5420：按钮改名
    expect(second.value.action).toBe("refresh_activity");
    expect(second.value.taskId).toBe(String(TASK_ID));
    // type=default：辅助信息不该抢群操作（primary/danger）的视觉重心
    expect(second.type).toBe("default");
  });

  test("有专属群时：第 1 个仍翻成解散群，第 2 个刷新按钮照在", () => {
    const card = buildTaskCard({
      status: "running",
      meta: { ...META, perTaskChatId: "oc_group_x", perTaskChatName: "任务群" },
    });
    expect((card.body.elements[0] as any).value.action).toBe("disband_group");
    expect((card.body.elements[1] as any).value.action).toBe("refresh_activity");
  });

  test("无 taskId → 不渲染刷新按钮（点下去也查不到东西，纯噪音）", () => {
    const card = buildTaskCard({
      status: "running",
      meta: { title: "无 id 的任务" },
    });
    const actions = (card.body.elements ?? [])
      .filter((e: any) => e.tag === "button")
      .map((e: any) => e.value?.action);
    expect(actions).not.toContain("refresh_activity");
  });
});

// ============================================================================
// B/C/D. handleCardAction refresh_activity 分支
// ============================================================================

describe("handleCardAction — refresh_activity", () => {
  test("★ 成功：返回 cardUpdate（patch 原卡）+ 含活性面板", async () => {
    const ports = makePorts();
    const r = await click("refresh_activity", ports);

    expect(r.ok).toBe(true);
    expect(r.action).toBe("refresh_activity");
    expect(r.cardUpdate).toBeDefined();

    const panel = findPanel(r.cardUpdate, "task_activity");
    expect(panel).toBeDefined();
    const text = flat(panel);
    expect(text).toContain("子会话活性");
    expect(text).toContain("🟢");
    expect(text).toContain("消息数 128 条");
    expect(text).toContain("wecom-card-builder.ts:485");
  });

  test("★ 刷新是只读：不调 updateTaskContext（不动 task.context）", async () => {
    let contextWrites = 0;
    const ports = makePorts({
      updateTaskContext: async () => {
        contextWrites++;
      },
    });
    await click("refresh_activity", ports);
    expect(contextWrites).toBe(0);
  });

  test("★ 刷新不改 updateCount（用户点 N 次 ≠ 卡片更新 N 次）", async () => {
    const ports = makePorts();
    const before = (ports.notifier as any).exportState(MESSAGE_ID);
    const r = await click("refresh_activity", ports);
    const after = (ports.notifier as any).exportState(MESSAGE_ID);

    expect(r.ok).toBe(true);
    expect(after.updateCount).toBe(before.updateCount);
    expect(after.milestones.length).toBe(before.milestones.length);
  });

  test("★ 无活性数据（含 null）→ 面板照出 + 「暂无数据」，仍 patch 成功", async () => {
    const ports = makePorts({
      loadSessionActivity: async () => ({ activity: undefined, terminal: false }),
    });
    const r = await click("refresh_activity", ports);

    expect(r.ok).toBe(true);
    const panel = findPanel(r.cardUpdate, "task_activity");
    expect(panel).toBeDefined();
    expect(flat(panel)).toContain("暂无数据");
  });

  test("★ loadSubSessionActivity 抛错 → 降级「暂无数据」，绝不失败", async () => {
    const ports = makePorts({
      loadSessionActivity: () => {
        throw new Error("db locked");
      },
    });
    const r = await click("refresh_activity", ports);
    expect(r.ok).toBe(true);
    expect(flat(findPanel(r.cardUpdate, "task_activity"))).toContain("暂无数据");
  });

  test("端口未注入 → 依然 ok + 「暂无数据」（按钮必须有反馈）", async () => {
    const ports = makePorts({ loadSessionActivity: undefined });
    const r = await click("refresh_activity", ports);
    expect(r.ok).toBe(true);
    expect(flat(findPanel(r.cardUpdate, "task_activity"))).toContain("暂无数据");
  });

  test("终态任务 → 活性显示「已结束」而非「疑似停滞」", async () => {
    const ports = makePorts({
      // ★ 澄清 22:37：终态由 session 层决定 —— probe.terminal 表示
      //   「跑这个 session 的后台任务已结束」，与有无 task 无关。
      loadSessionActivity: async () => ({
        activity: act({ updatedAt: NOW - 40 * MIN }),
        terminal: true,
      }),
    });
    const r = await click("refresh_activity", ports);
    const text = flat(findPanel(r.cardUpdate, "task_activity"));
    expect(text).toContain("已结束");
    expect(text).not.toContain("疑似停滞");
  });

  test("notifier 不认这张卡 → fallback 重建（仍 ok，有反馈）", async () => {
    const ports = makePorts({ notifier: new LarkCardPatchNotifier() });
    const r = await click("refresh_activity", ports);
    expect(r.ok).toBe(true);
    expect(findPanel(r.cardUpdate, "task_activity")).toBeDefined();
  });

  test("★ CV MINOR-3：降级重建保留真实 title 与 status（不能硬编码 running）", async () => {
    // notifier 不认这张卡（模拟重启后未 hydrate）
    const ports = makePorts({
      notifier: new LarkCardPatchNotifier(),
      getTask: async (id) => ({
        id,
        title: META.title,
        context: "{}",
        status: "completed", // ← 已完成的任务
        current_status: "已收尾",
      }),
    });
    const r = await click("refresh_activity", ports);
    const card = r.cardUpdate as any;

    expect(r.ok).toBe(true);
    // ★ 澄清 22:37：卡片身份是 session；但 task 信息不能丢 —— 它在任务面板里。
    expect(card.header.title.content).toContain("会话卡");
    const taskPanel = flat(findPanel(card, "task_detail"));
    expect(taskPanel).toContain(META.title!);
    // ★ CV MAJOR-4 后的正确语义：该用例给了活跃的 activity（probe.activity 存在
    //   且 terminal=false）⇒ session 看起来还在跑，**不接受** task.status 的
    //   终态作为"会话已结束"的证据 ⇒ header 保持 running 蓝。
    //   （task 的 completed 事实仍如实显示在「任务信息」面板里。）
    expect(card.header.template).toBe("blue");
    expect(flat(findPanel(card, "task_detail"))).toContain("completed");
  });

  test("★ 澄清 22:37：task 不存在也照样刷新（session 才是主键）", async () => {
    const ports = makePorts({ getTask: async () => undefined });
    const r = await click("refresh_activity", ports);
    expect(r.ok).toBe(true);
    // 卡片降级为「只有 session 活性」，不整卡失败
    expect(flat(r.cardUpdate)).toContain("消息数 128 条");
  });
});

// ============================================================================
// E. 旧信息一个都不能少（用户明令第 4 条）
// ============================================================================

describe("刷新后旧字段零丢失（用户明令：之前展示的信息一个都不能少）", () => {
  test("★ 澄清 22:37：header 是 session 身份；task 号/标题在「任务信息」面板（信息不少）", async () => {
    const ports = makePorts();
    const r = await click("refresh_activity", ports);
    const card = r.cardUpdate as any;

    // 卡片身份 = session（用户澄清第 1 点）
    expect(card.header.title.content).toContain("会话卡");
    expect(card.header.subtitle.content).toContain("第 3 次更新");
    expect(card.header.template).toBeDefined();

    // 但 task 原有信息一个不少（澄清第 3 点）—— 在任务面板里
    const taskPanel = flat(findPanel(card, "task_detail"));
    expect(taskPanel).toContain(`#${TASK_ID}`);
    expect(taskPanel).toContain(META.title!);
  });

  test("★ 原按钮（建群/解散群）刷新后仍在", async () => {
    const ports = makePorts();
    const r = await click("refresh_activity", ports);
    const buttons = (r.cardUpdate as any).body.elements.filter(
      (e: any) => e.tag === "button",
    );
    const actions = buttons.map((b: any) => b.value.action);
    expect(actions).toContain("create_group");
    expect(actions).toContain("refresh_activity");
  });

  test("★ `📋 任务详情` 面板仍在（elementId=task_detail）", async () => {
    const ports = makePorts();
    const r = await click("refresh_activity", ports);
    const panel = findPanel(r.cardUpdate, "task_detail");
    expect(panel).toBeDefined();
    expect(flat(panel)).toContain("任务 ID");
    expect(flat(panel)).toContain(META.title!);
  });

  test("★ `task_timeline` 面板仍在（操作记录一条不少）", async () => {
    const ports = makePorts();
    const r = await click("refresh_activity", ports);
    const panel = findPanel(r.cardUpdate, "task_timeline");
    expect(panel).toBeDefined();
    const text = flat(panel);
    for (const m of MILESTONES) {
      expect(text).toContain(m.title);
    }
  });

  test("★ 进度百分比保留（在任务信息面板里）", async () => {
    const ports = makePorts();
    const r = await click("refresh_activity", ports);
    const taskPanel = flat(findPanel(r.cardUpdate, "task_detail"));
    expect(taskPanel).toContain("进度");
    expect(taskPanel).toContain("42"); // META 里 progress=42
  });

  test("★ 活性面板位置：任务详情之后、执行动态之前（不覆盖任何旧面板）", async () => {
    const ports = makePorts();
    const r = await click("refresh_activity", ports);
    // ★ 澄清 22:37 后的层级：会话详情 → 任务信息(task_detail) → 操作记录(task_timeline)
    //   → 活性(task_activity)。活性放最后是因为它是"最新事实"，不该插在历史中间。
    const ids = (r.cardUpdate as any).body.elements
      .map((e: any) => e?.element_id)
      .filter(Boolean);
    const iDetail = ids.indexOf("task_detail");
    const iTimeline = ids.indexOf("task_timeline");
    const iActivity = ids.indexOf("task_activity");
    expect(iDetail).toBeGreaterThanOrEqual(0);
    expect(iTimeline).toBeGreaterThan(iDetail);
    expect(iActivity).toBeGreaterThan(iTimeline);
  });
});

// ============================================================================
// F. 未知 action 不得误伤（改造前 if/else 的隐患）
// ============================================================================

describe("未知 action 防护（Task #5360 安全加固）", () => {
  test("isCardActionName 白名单", () => {
    expect(isCardActionName("create_group")).toBe(true);
    expect(isCardActionName("disband_group")).toBe(true);
    expect(isCardActionName("refresh_activity")).toBe(true);
    expect(isCardActionName("bogus")).toBe(false);
    expect(isCardActionName(undefined)).toBe(false);
    expect(isCardActionName(42)).toBe(false);
  });

  test("★ 未知 action → ok:false，且绝不触发解散群（不删群、不写 context）", async () => {
    let contextWrites = 0;
    let deleted = 0;
    const ports = makePorts({
      updateTaskContext: async () => {
        contextWrites++;
      },
      deleteGroupChat: async () => {
        deleted++;
      },
    });

    const r = await handleCardAction(
      {
        actionValue: { action: "delete_everything" as any, taskId: String(TASK_ID), sessionId: "session_test_card" },
        chatId: "oc_test",
        messageId: MESSAGE_ID,
        token: "tok",
        profile: "tongzhuli",
      },
      ports,
    );

    expect(r.ok).toBe(false);
    expect(r.error).toContain("Unknown action");
    expect(deleted).toBe(0);
    expect(contextWrites).toBe(0);
    expect(r.cardUpdate).toBeUndefined();
  });

  test("★ 澄清 22:37：有 sessionId 无 taskId → 正常刷新（无 task 的 session 卡）", async () => {
    const ports = makePorts();
    const r = await handleCardAction(
      {
        actionValue: {
          action: "refresh_activity",
          taskId: "",
          sessionId: SESSION_ID,
        },
        chatId: "oc_test",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      ports,
    );
    expect(r.ok).toBe(true);
    expect(flat(r.cardUpdate)).toContain("消息数 128 条");
  });
});
// ============================================================================
// H. ★ CV R4：旧卡（无 sessionId）的建群/解散群必须仍可用（回归护栏）
// ============================================================================

describe("★ CV R4：旧 task 卡的 group 按钮不被 session 主键要求打死", () => {
  /**
   * 背景：引入 session 主键后，若所有 action 都要求 sessionId，
   * **已经发出去的旧卡**（按钮 value 只有 taskId）点建群/解散群就会报
   * "sessionId is required" —— 这是修复 B1 时引入的回归。
   *
   * 本组断言：group 动作走专用路径，只要有合法 taskId 就工作。
   */
  function legacyClick(action: "create_group" | "disband_group") {
    return handleCardAction(
      {
        // 改造前发出去的卡片形态：**只有 taskId**
        actionValue: { action, taskId: String(TASK_ID) },
        chatId: "oc_test",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      makePorts(),
    );
  }

  test("★ 旧卡（无 sessionId）建群 → ok，且真的调了 createGroupChat", async () => {
    let created = 0;
    const ports = makePorts({
      createGroupChat: async () => {
        created++;
        return "oc_new_group";
      },
    });
    const r = await handleCardAction(
      {
        actionValue: { action: "create_group", taskId: String(TASK_ID) },
        chatId: "oc_test",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      ports,
    );
    expect(r.ok).toBe(true);
    expect(created).toBe(1);
  });

  test("★ 旧卡（无 sessionId）解散群 → ok，且真的调了 deleteGroupChat", async () => {
    let deleted = 0;
    const ports = makePorts({
      getTask: async (id) => ({
        id,
        title: META.title,
        context: JSON.stringify({ larkPerTaskChatId: "oc_existing_group" }),
        current_status: "x",
      }),
      deleteGroupChat: async () => {
        deleted++;
      },
    });
    const r = await handleCardAction(
      {
        actionValue: { action: "disband_group", taskId: String(TASK_ID) },
        chatId: "oc_test",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      ports,
    );
    expect(r.ok).toBe(true);
    expect(deleted).toBe(1);
  });

  test("★ 旧卡 group 动作仍写 task.context（能力不退化）", async () => {
    const writes: string[] = [];
    const ports = makePorts({
      createGroupChat: async () => "oc_new_group",
      updateTaskContext: async (_id, ctx) => {
        writes.push(ctx);
      },
    });
    const r = await handleCardAction(
      {
        actionValue: { action: "create_group", taskId: String(TASK_ID) },
        chatId: "oc_test",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      ports,
    );
    expect(r.ok).toBe(true);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0]).toContain("oc_new_group");
  });

  test("★ 非法 taskId + group 动作 → ok:false（不误建群）", async () => {
    let created = 0;
    const ports = makePorts({
      createGroupChat: async () => {
        created++;
        return "oc_x";
      },
    });
    const r = await handleCardAction(
      {
        actionValue: { action: "create_group", taskId: "abc" },
        chatId: "oc_test",
        messageId: MESSAGE_ID,
        token: "tok",
      },
      ports,
    );
    expect(r.ok).toBe(false);
    expect(created).toBe(0);
  });
});
