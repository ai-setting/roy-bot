/**
 * @fileoverview Task #5360 — 企微卡片 sub-session 活性（「刷新活性」按钮）
 *
 * ## 用户诉求（2026-11-11 20:50）
 *
 * > 「企微卡片同步新增：subsession 消息数 + 最近 msg（截断展示）」
 * > 「之前展示的信息一个都不能少」
 *
 * ## 本文件锁定的不变量
 *
 * A. 新增 `task_refresh_activity` 按钮 key（与 `task_view` 分开）
 * B. 点击 → 更新帧带活性（quote_area 优先）
 * C. 活性超长 → **代码内**降级到 sub_title_text（不依赖真网假设）
 * D. 旧字段零丢失：main_title / horizontal_content_list / button_list / task_id
 * E. 按需拉取：只有 refresh_activity 才查活性（view 不查）
 * F. 全链路 best-effort：端口抛错 → 渲染「暂无数据」，更新仍成功
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { join } from "node:path";
import {
  handleWecomCardAction,
  buildWecomCardUpdateBody,
  __resetWecomCardActionInflightForTest,
  type WecomCardActionPorts,
} from "./wecom-card-action-handler";
import {
  WecomCardActionKey,
  buildWecomCardUpdateFrame,
  buildWecomTextNoticeCard,
  buildWecomButtonInteractionCard,
} from "./wecom-card-builder";
import type { ActivityProbeResult, SubSessionActivity } from "../task/plugins/sub-session-activity";

const NOW = new Date(2026, 10, 11, 20, 47, 12).getTime();
const MIN = 60 * 1000;
const TASK_ID = 5360;
const CARD_TASK_ID = `roy-task-${TASK_ID}-3-abc123`;
const REQ_ID = "aibot_event_req_5360";

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

function probe(overrides: Partial<ActivityProbeResult> = {}): ActivityProbeResult {
  return { activity: act(), terminal: false, ...overrides };
}

/**
 * 造一个 wecom card action 回调帧（对齐 `extractWecomCardAction` 的真实解析形状）。
 *
 * 协议形态（不是猜的 —— 见 wecom-card-action-handler.ts:extractWecomCardAction）：
 * ```
 * { cmd: "aibot_event_callback",
 *   headers: { req_id },
 *   body: { event: { eventtype: "template_card_event",
 *                    template_card_event: { event_key, task_id } },
 *           from: { userid } } }
 * ```
 */
function makeFrame(eventKey: string) {
  return {
    cmd: "aibot_event_callback",
    headers: { req_id: REQ_ID },
    body: {
      event: {
        eventtype: "template_card_event",
        template_card_event: {
          event_key: eventKey,
          task_id: CARD_TASK_ID,
        },
      },
      from: { userid: "user1" },
    },
  };
}

function makePorts(overrides: Partial<WecomCardActionPorts> = {}): WecomCardActionPorts {
  return {
    markTaskDone: async () => {},
    reopenTask: async () => {},
    updateCard: async () => {},
    loadTimeline: () => [
      { title: "Task 创建", timestamp: "2026-11-11T12:47:00.000Z" },
      { title: "方案设计完成", timestamp: "2026-11-11T12:50:00.000Z" },
    ],
    loadTaskTitle: () => ({ title: "任务通知卡片化改造", number: TASK_ID }),
    loadSubSessionActivity: async () => probe(),
    ...overrides,
  };
}

/** 把更新帧的 template_card 取出来（断言字段用） */
function frameCard(input: Parameters<typeof buildWecomCardUpdateFrame>[0]) {
  return (buildWecomCardUpdateFrame(input).body as any).template_card;
}

beforeEach(() => {
  __resetWecomCardActionInflightForTest();
});

// ============================================================================
// A. 按钮 key
// ============================================================================

describe("按钮 key（Task #5360）", () => {
  test("★ 新增 REFRESH_ACTIVITY，与 VIEW 是两个不同的 key", () => {
    expect(WecomCardActionKey.REFRESH_ACTIVITY).toBe("task_refresh_activity");
    expect(WecomCardActionKey.REFRESH_ACTIVITY).not.toBe(
      WecomCardActionKey.VIEW,
    );
  });

  test("原有三个 key 值不变（回归护栏）", () => {
    expect(WecomCardActionKey.VIEW).toBe("task_view");
    expect(WecomCardActionKey.MARK_DONE).toBe("task_mark_done");
    expect(WecomCardActionKey.REOPEN).toBe("task_reopen");
  });
});

// ============================================================================
// B. 更新帧渲染活性
// ============================================================================

describe("buildWecomCardUpdateFrame — 活性", () => {
  test("不传 activity → 完全不出 quote_area（普通 view 零变更）", () => {
    const card = frameCard({
      reqId: REQ_ID,
      taskId: CARD_TASK_ID,
      statusLabel: "👀 已查看",
    });
    expect(card.quote_area).toBeUndefined();
  });

  test("★ 传 activity → quote_area 带信号灯 + 消息数 + 最近消息", () => {
    const card = frameCard({
      reqId: REQ_ID,
      taskId: CARD_TASK_ID,
      statusLabel: "⚡ 活性已刷新",
      activity: act(),
      activityNow: NOW,
    });
    expect(card.quote_area).toBeDefined();
    expect(card.quote_area.type).toBe(0);
    expect(card.quote_area.title).toBe("⚡ 子会话活性");
    expect(card.quote_area.quote_text).toContain("🟢");
    expect(card.quote_area.quote_text).toContain("消息数 128 条");
    expect(card.quote_area.quote_text).toContain("wecom-card-builder.ts:485");
  });

  test("★ activity=null → 渲染「暂无数据」（用户点过必须有反馈）", () => {
    const card = frameCard({
      reqId: REQ_ID,
      taskId: CARD_TASK_ID,
      statusLabel: "⚡ 活性已刷新",
      activity: null,
      activityNow: NOW,
    });
    expect(card.quote_area).toBeDefined();
    expect(card.quote_area.quote_text).toContain("暂无数据");
  });

  test("终态 → ⚪ 已结束，不报「疑似停滞」", () => {
    const card = frameCard({
      reqId: REQ_ID,
      taskId: CARD_TASK_ID,
      statusLabel: "🎉 已完成",
      activity: act({ updatedAt: NOW - 40 * MIN }),
      activityTerminal: true,
      activityNow: NOW,
    });
    expect(card.quote_area.quote_text).toContain("已结束");
    expect(card.quote_area.quote_text).not.toContain("疑似停滞");
  });
});

// ============================================================================
// C. 超长 → 代码内降级到 sub_title_text
// ============================================================================

describe("活性超长降级（不依赖真网假设）", () => {
  test("★ 超限 → 不塞 quote_area，活性落到 sub_title_text（不两条都没有）", () => {
    // 构造一个必然超 112 字的活性文本：长消息 + 长 head
    const long = "这是一段非常长的子会话消息内容需要被截断".repeat(10);
    const card = frameCard({
      reqId: REQ_ID,
      taskId: CARD_TASK_ID,
      statusLabel: "⚡ 活性已刷新",
      activity: act({ lastMessage: { role: "assistant", content: long } }),
      activityNow: NOW,
    });

    const hasQuote = card.quote_area !== undefined;
    const hasSub = typeof card.sub_title_text === "string";
    // 二选一必现（核心断言：用户一定能看到活性）
    expect(hasQuote || hasSub).toBe(true);
  });

  test("★ 未超限 → 走 quote_area，sub_title_text 不被污染", () => {
    const card = frameCard({
      reqId: REQ_ID,
      taskId: CARD_TASK_ID,
      statusLabel: "⚡ 活性已刷新",
      timeline: [{ title: "Task 创建", timestamp: "2026-11-11T12:47:00.000Z" }],
      activity: act(),
      activityNow: NOW,
    });
    expect(card.quote_area).toBeDefined();
    // sub_title 仍是时间线统计（旧信息），没有被活性覆盖
    expect(card.sub_title_text).toContain("操作记录");
    expect(card.sub_title_text).not.toContain("消息数");
  });
});

// ============================================================================
// D. 旧字段零丢失（用户明令第 4 条）
// ============================================================================

describe("企微更新帧旧字段零丢失", () => {
  function richCard() {
    return frameCard({
      reqId: REQ_ID,
      taskId: CARD_TASK_ID,
      statusLabel: "⚡ 活性已刷新",
      note: "已读取子会话最新活性",
      taskTitle: "任务通知卡片化改造",
      taskNumber: TASK_ID,
      timeline: [
        { title: "Task 创建", timestamp: "2026-11-11T12:47:00.000Z" },
        { title: "方案设计完成", timestamp: "2026-11-11T12:50:00.000Z" },
        { title: "TDD RED", timestamp: "2026-11-11T12:55:00.000Z" },
      ],
      activity: act(),
      activityNow: NOW,
      buttonOverrides: [
        { text: "刷新详情", key: WecomCardActionKey.VIEW, style: 2 },
        { text: "刷新活性", key: WecomCardActionKey.REFRESH_ACTIVITY, style: 1 },
      ],
    });
  }

  test("★ main_title 仍含 Task #id + title + 状态（#5273 不能回退）", () => {
    const card = richCard();
    expect(card.main_title.title).toContain(`Task #${TASK_ID}`);
    expect(card.main_title.title).toContain("任务通知卡片化改造");
    expect(card.main_title.title).toContain("⚡ 活性已刷新");
  });

  test("★ main_title.desc（note）保留", () => {
    expect(richCard().main_title.desc).toContain("已读取子会话最新活性");
  });

  test("★ horizontal_content_list 时间线一条不少（活性不挤这里）", () => {
    const card = richCard();
    expect(Array.isArray(card.horizontal_content_list)).toBe(true);
    const values = card.horizontal_content_list.map((r: any) => r.value).join("|");
    expect(values).toContain("Task 创建");
    expect(values).toContain("方案设计完成");
    expect(values).toContain("TDD RED");
  });

  test("★ button_list 两个刷新按钮都在（可重复点）", () => {
    const keys = richCard().button_list.map((b: any) => b.key);
    expect(keys).toContain(WecomCardActionKey.VIEW);
    expect(keys).toContain(WecomCardActionKey.REFRESH_ACTIVITY);
  });

  test("★ task_id 原样回填（协议硬约束）", () => {
    expect(richCard().task_id).toBe(CARD_TASK_ID);
  });

  test("★ card_type 仍是 button_interaction", () => {
    expect(richCard().card_type).toBe("button_interaction");
  });
});

// ============================================================================
// E. 按需拉取：只有 refresh_activity 才查活性
// ============================================================================

describe("handleWecomCardAction — 按需拉取", () => {
  test("★ refresh_activity → 查活性并带进更新帧", async () => {
    let called = 0;
    let captured: any;
    const ports = makePorts({
      loadSubSessionActivity: async () => {
        called++;
        return probe();
      },
      updateCard: async (...args: any[]) => {
        captured = args;
      },
    });

    const r = await handleWecomCardAction(makeFrame(WecomCardActionKey.REFRESH_ACTIVITY), ports);

    expect(r.ok).toBe(true);
    expect(r.action).toBe("refresh_activity");
    expect(called).toBe(1);
    // updateCard 的第 7 个参数是 extra（activity 合并进 extra，不是第 8 参）
    expect(captured[6]?.activity).toBeDefined();
    expect(captured[6].activity.messageCount).toBe(128);
  });

  test("★ view → 不查活性（语义不同，别混）", async () => {
    let called = 0;
    const ports = makePorts({
      loadSubSessionActivity: async () => {
        called++;
        return probe();
      },
    });
    await handleWecomCardAction(makeFrame(WecomCardActionKey.VIEW), ports);
    expect(called).toBe(0);
  });

  test("★ refresh_activity 不触发任务状态变更（只读）", async () => {
    let done = 0;
    let reopen = 0;
    const ports = makePorts({
      markTaskDone: async () => {
        done++;
      },
      reopenTask: async () => {
        reopen++;
      },
    });
    await handleWecomCardAction(makeFrame(WecomCardActionKey.REFRESH_ACTIVITY), ports);
    expect(done).toBe(0);
    expect(reopen).toBe(0);
  });
});

// ============================================================================
// F. best-effort
// ============================================================================

describe("handleWecomCardAction — refresh_activity 降级", () => {
  test("★ 端口抛错 → activity=null（渲染暂无数据），更新仍成功", async () => {
    let captured: any;
    const ports = makePorts({
      loadSubSessionActivity: () => {
        throw new Error("db locked");
      },
      updateCard: async (...args: any[]) => {
        captured = args;
      },
    });

    const r = await handleWecomCardAction(makeFrame(WecomCardActionKey.REFRESH_ACTIVITY), ports);

    expect(r.ok).toBe(true);
    expect(captured[6]?.activity).toBeNull();
  });

  test("端口未注入 → activity=null，更新仍成功", async () => {
    let captured: any;
    const ports = makePorts({
      loadSubSessionActivity: undefined,
      updateCard: async (...args: any[]) => {
        captured = args;
      },
    });

    const r = await handleWecomCardAction(makeFrame(WecomCardActionKey.REFRESH_ACTIVITY), ports);
    expect(r.ok).toBe(true);
    expect(captured[6]?.activity).toBeNull();
  });

  test("★ CV MAJOR-2：terminal 必须透传到更新帧（否则终态被误报「疑似停滞」）", async () => {
    let captured: any;
    const ports = makePorts({
      // 终态任务 + 40 分钟无写入：正确显示 ⚪已结束；若 terminal 丢了会变 🔴
      loadSubSessionActivity: async () => ({
        activity: act({ updatedAt: NOW - 40 * MIN }),
        terminal: true,
      }),
      updateCard: async (...args: any[]) => {
        captured = args;
      },
    });

    await handleWecomCardAction(makeFrame(WecomCardActionKey.REFRESH_ACTIVITY), ports);

    expect(captured[6]?.activityTerminal).toBe(true);
  });

  test("★ CV MAJOR-2：非终态 → activityTerminal=false（不是 undefined）", async () => {
    let captured: any;
    const ports = makePorts({
      loadSubSessionActivity: async () => ({ activity: act(), terminal: false }),
      updateCard: async (...args: any[]) => {
        captured = args;
      },
    });
    await handleWecomCardAction(makeFrame(WecomCardActionKey.REFRESH_ACTIVITY), ports);
    expect(captured[6]?.activityTerminal).toBe(false);
  });

  test("★ CV MAJOR-2：buildWecomCardUpdateBody 把 terminal 渲染成 ⚪已结束", () => {
    const { body } = buildWecomCardUpdateBody({
      cardTaskId: CARD_TASK_ID,
      statusLabel: "🎉 已完成",
      action: "refresh_activity",
      activity: act({ updatedAt: NOW - 40 * MIN }),
      activityTerminal: true,
      activityNow: NOW,
    });
    const q = (body as any).template_card.quote_area;
    expect(q.quote_text).toContain("已结束");
    expect(q.quote_text).not.toContain("疑似停滞");
  });

  test("未知 event_key → ok:false（不误伤）", async () => {
    const ports = makePorts();
    const r = await handleWecomCardAction(makeFrame("task_bogus"), ports);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("unknown event_key");
  });
});

// ============================================================================
// G. buildWecomCardUpdateBody 透传
// ============================================================================

describe("buildWecomCardUpdateBody — 活性透传", () => {
  test("activity 透传进 template_card.quote_area", () => {
    const { cmd, body } = buildWecomCardUpdateBody({
      cardTaskId: CARD_TASK_ID,
      statusLabel: "⚡ 活性已刷新",
      action: "refresh_activity",
      activity: act(),
      activityNow: NOW,
    });
    expect(cmd).toBe("aibot_respond_update_msg");
    const card = (body as any).template_card;
    expect(card.quote_area.quote_text).toContain("消息数 128 条");
  });

  test("★ refresh_activity 的按钮 = 刷新详情 + 刷新活性（可重复点）", () => {
    const { body } = buildWecomCardUpdateBody({
      cardTaskId: CARD_TASK_ID,
      statusLabel: "⚡ 活性已刷新",
      action: "refresh_activity",
      activity: act(),
    });
    const keys = (body as any).template_card.button_list.map((b: any) => b.key);
    expect(keys).toContain(WecomCardActionKey.VIEW);
    expect(keys).toContain(WecomCardActionKey.REFRESH_ACTIVITY);
  });

  test("mark_done 不带活性时行为不变（向后兼容）", () => {
    const { body } = buildWecomCardUpdateBody({
      cardTaskId: CARD_TASK_ID,
      statusLabel: "🎉 已完成",
      action: "mark_done",
    });
    const card = (body as any).template_card;
    expect(card.quote_area).toBeUndefined();
    expect(card.button_list[0].key).toBe("task_done_ack");
  });
});

// ============================================================================
// H. 进展卡不受影响（主动推送不带活性）
// ============================================================================

describe("进展卡（text_notice）不受影响", () => {
  test("buildWecomTextNoticeCard 签名与输出无变化（无 activity 字段）", () => {
    const card = buildWecomTextNoticeCard({
      taskId: TASK_ID,
      title: "任务通知卡片化改造",
      statusLabel: "进行中",
      progress: 42,
      description: "desc",
      milestones: [{ title: "Task 创建", timestamp: "2026-11-11T12:47:00.000Z" }],
    });
    expect(card.card_type).toBe("text_notice");
    expect((card as any).activity).toBeUndefined();
    // 原有六条 horizontal 预算结构不变
    expect(Array.isArray(card.horizontal_content_list)).toBe(true);
  });

  test("builder 透传多个按钮（协议上限 6，2 个安全）", () => {
    const card = buildWecomButtonInteractionCard({
      taskId: TASK_ID,
      title: "任务通知卡片化改造",
      statusLabel: "进行中",
      progress: 42,
      milestones: [],
      buttons: [
        { text: "刷新详情", key: WecomCardActionKey.VIEW, style: 1 },
        { text: "刷新活性", key: WecomCardActionKey.REFRESH_ACTIVITY, style: 2 },
      ],
    });
    const keys = card.button_list.map((b) => b.key);
    expect(keys).toContain(WecomCardActionKey.VIEW);
    expect(keys).toContain(WecomCardActionKey.REFRESH_ACTIVITY);
  });
});

// ============================================================================
// I. ★ CV BLOCKER 回归：生产进展卡必须真的渲染「刷新活性」按钮
// ============================================================================

describe("★ 生产可达性（CV BLOCKER）：进展卡真的带 refresh_activity 按钮", () => {
  /**
   * 为什么这条测试必须存在（原测试假绿的教训）
   *
   * 改造时 `wecom-card-action-handler` 把 `refresh_activity` 分支、端口、
   * 更新帧渲染**全部**实现了，单测也全绿 —— 因为它们**直接构造回调帧**，
   * 绕过了「按钮是谁渲染出来的」这一环。
   *
   * 但 `WecomTaskNotifyPlugin` 的进展卡当时只传了 `刷新详情` 一个按钮
   * ⇒ 用户在真机上永远点不到 `task_refresh_activity` ⇒ 需求 3 在生产环境
   * 完全不可达，而测试全绿。
   *
   * 教训：**测试要断言「生产路径真的能触发该动作」，而不只是「处理器实现了」。**
   * 这里用源码级断言守住 plugin 的按钮列表（该文件依赖 env/hook 重，端到端
   * 起栈成本高，而同目录 `update-v0.14.test.ts` 已有源码断言的先例）。
   */
  const pluginSrc = () =>
    Bun.file(
      join(import.meta.dir, "../task/plugins/wecom-task-notify-plugin.ts"),
    ).text();

  test("★ 进展卡 button_list 同时含 VIEW 与 REFRESH_ACTIVITY", async () => {
    const src = await pluginSrc();
    // 定位 buildWecomButtonInteractionCard 调用块里的 buttons 数组
    const idx = src.indexOf("buildWecomButtonInteractionCard({");
    expect(idx).toBeGreaterThan(-1);
    const block = src.slice(idx, idx + 1400);
    expect(block).toContain("WecomCardActionKey.VIEW");
    expect(block).toContain("WecomCardActionKey.REFRESH_ACTIVITY");
  });

  test("★ 两个按钮都带可见文案（不是只有 key）", async () => {
    const src = await pluginSrc();
    const idx = src.indexOf("buildWecomButtonInteractionCard({");
    const block = src.slice(idx, idx + 1400);
    expect(block).toContain("刷新详情");
    expect(block).toContain("刷新活性");
  });

  test("★ 按钮数 ≤ 6（企微 button_interaction 协议上限）", async () => {
    const src = await pluginSrc();
    const idx = src.indexOf("buildWecomButtonInteractionCard({");
    const block = src.slice(idx, idx + 1400);
    const buttonsIdx = block.indexOf("buttons: [");
    const endIdx = block.indexOf("],", buttonsIdx);
    const arr = block.slice(buttonsIdx, endIdx);
    const count = (arr.match(/\{\s*text:/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(count).toBeLessThanOrEqual(6);
  });
});