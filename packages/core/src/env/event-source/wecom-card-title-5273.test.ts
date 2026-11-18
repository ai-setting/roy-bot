/**
 * @fileoverview Task #5273 — 企微更新卡补 taskId + title
 *
 * 用户反馈：企微群里任务卡片缺 Task #ID 和标题，只有
 * 「👀 已查看」+ 操作记录 +「刷新详情」按钮。
 *
 * 根因：按钮点击后的更新帧 buildWecomCardUpdateFrame 的
 * main_title 只渲染 `📋 ${statusLabel}`，不带任务号/标题
 * （初始进展卡 buildWecomTextNoticeCard 是带的）。
 *
 * 本文件锁定修复后的契约：
 * 1. buildWecomCardUpdateFrame 带 taskTitle/taskNumber 时
 *    main_title 含 `Task #<n>` 与标题
 * 2. 缺省时向后兼容（不 throw，仍渲染 statusLabel）
 * 3. buildWecomCardUpdateBody 透传 taskTitle/taskNumber
 * 4. handleWecomCardAction 经 loadTaskTitle 端口把标题带进更新卡
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  buildWecomCardUpdateFrame,
  WecomCardActionKey,
} from "./wecom-card-builder";
import {
  __resetWecomCardActionInflightForTest,
  buildWecomCardUpdateBody,
  handleWecomCardAction,
} from "./wecom-card-action-handler";

const baseFrameInput = {
  reqId: "req-5273",
  taskId: "roy-task-42-3-abc",
  statusLabel: "👀 已查看",
};

describe("Task #5273 — buildWecomCardUpdateFrame 补 taskId+title", () => {
  test("带 taskTitle/taskNumber → main_title 含 Task #42 与标题", () => {
    const frame = buildWecomCardUpdateFrame({
      ...baseFrameInput,
      taskTitle: "优化企微任务卡片显示",
      taskNumber: 42,
    });
    const card = frame.body.template_card as {
      main_title: { title: string };
    };
    expect(card.main_title.title).toContain("Task #42");
    expect(card.main_title.title).toContain("优化企微任务卡片显示");
  });

  test("缺省 taskTitle/taskNumber → 向后兼容（不 throw，仍渲染 statusLabel）", () => {
    const frame = buildWecomCardUpdateFrame(baseFrameInput);
    const card = frame.body.template_card as {
      main_title: { title: string };
    };
    expect(card.main_title.title).toContain("👀 已查看");
  });

  test("只带 taskTitle 不带 taskNumber → 渲染标题、无 Task # 前缀", () => {
    const frame = buildWecomCardUpdateFrame({
      ...baseFrameInput,
      taskTitle: "只有标题",
    });
    const card = frame.body.template_card as {
      main_title: { title: string };
    };
    expect(card.main_title.title).toContain("只有标题");
    expect(card.main_title.title).not.toContain("Task #");
  });

  test("标题超长截断（60 字上限，与初始卡 clip 一致）", () => {
    const longTitle = "标".repeat(120);
    const frame = buildWecomCardUpdateFrame({
      ...baseFrameInput,
      taskTitle: longTitle,
      taskNumber: 7,
    });
    const card = frame.body.template_card as {
      main_title: { title: string };
    };
    // 标题本身截到 60 字（前缀/后缀不计入）
    const titleMarks = (card.main_title.title.match(/标/g) ?? []).length;
    expect(titleMarks).toBeLessThanOrEqual(60);
    expect(card.main_title.title).toContain("Task #7");
  });

  test("保留 cmd 契约：aibot_respond_update_msg + req_id 透传", () => {
    const frame = buildWecomCardUpdateFrame({
      ...baseFrameInput,
      taskTitle: "t",
      taskNumber: 1,
    });
    expect(frame.cmd).toBe("aibot_respond_update_msg");
    expect(frame.headers.req_id).toBe("req-5273");
    expect((frame.body as Record<string, unknown>).response_type).toBe(
      "update_template_card",
    );
  });
});

describe("Task #5273 — buildWecomCardUpdateBody 透传 taskTitle/taskNumber", () => {
  test("透传后 main_title 含 Task # 与标题", () => {
    const { cmd, body } = buildWecomCardUpdateBody({
      cardTaskId: "roy-task-9-1-x",
      statusLabel: "🔄 进行中",
      note: "用户已重新打开任务",
      action: "reopen",
      taskTitle: "企微卡片标题修复",
      taskNumber: 9,
    });
    expect(cmd).toBe("aibot_respond_update_msg");
    const card = body.template_card as {
      main_title: { title: string };
      button_list: { text: string }[];
    };
    expect(card.main_title.title).toContain("Task #9");
    expect(card.main_title.title).toContain("企微卡片标题修复");
    expect(card.button_list[0].text).toBe("刷新详情");
  });
});

describe("Task #5273 — handleWecomCardAction 经 loadTaskTitle 带标题", () => {
  beforeEach(() => __resetWecomCardActionInflightForTest());

  function frameFor(eventKey: string, taskId: string) {
    return {
      cmd: "aibot_event_callback",
      headers: { req_id: "cb-req-5273" },
      body: {
        from: { userid: "user-a" },
        event: {
          eventtype: "template_card_event",
          template_card_event: { event_key: eventKey, task_id: taskId },
        },
      },
    };
  }

  test("view 动作：loadTaskTitle 返回标题 → updateCard 收到 taskTitle/taskNumber", async () => {
    const seen: Record<string, unknown> = {};
    const result = await handleWecomCardAction(frameFor(WecomCardActionKey.VIEW, "roy-task-11-2-k"), {
      markTaskDone: async () => {},
      reopenTask: async () => {},
      updateCard: async (reqId, cardTaskId, statusLabel, note, timeline, action, extra) => {
        seen.reqId = reqId;
        seen.cardTaskId = cardTaskId;
        seen.statusLabel = statusLabel;
        seen.action = action;
        seen.extra = extra;
      },
      loadTimeline: () => [],
      loadTaskTitle: (taskId) =>
        taskId === 11 ? { title: "标题穿透测试任务", number: 11 } : undefined,
    });
    expect(result.ok).toBe(true);
    expect(seen.statusLabel).toBe("👀 已查看");
    expect(seen.action).toBe("view");
    const extra = seen.extra as { taskTitle?: string; taskNumber?: number };
    expect(extra.taskTitle).toBe("标题穿透测试任务");
    expect(extra.taskNumber).toBe(11);
  });

  // ★ CV B1/M2：生产实现（wecom-cli-handler）返回 Promise，
  //   消费端必须 await——否则真实点击路径 taskExtra 恒 undefined。
  test("★CV-B1 loadTaskTitle 返回 Promise.resolve → updateCard 收到标题", async () => {
    const seen: Record<string, unknown> = {};
    const result = await handleWecomCardAction(frameFor(WecomCardActionKey.VIEW, "roy-task-21-1-p"), {
      markTaskDone: async () => {},
      reopenTask: async () => {},
      updateCard: async (_r, _c, _s, _n, _t, _a, extra) => {
        seen.extra = extra;
      },
      loadTimeline: () => [],
      loadTaskTitle: (taskId) =>
        taskId === 21
          ? Promise.resolve({ title: "异步标题任务", number: 21 })
          : undefined,
    });
    expect(result.ok).toBe(true);
    const extra = seen.extra as { taskTitle?: string; taskNumber?: number };
    expect(extra.taskTitle).toBe("异步标题任务");
    expect(extra.taskNumber).toBe(21);
  });

  test("★CV-B1 loadTaskTitle 返回 Promise.reject → 降级为无标题，卡片更新不阻断", async () => {
    const result = await handleWecomCardAction(frameFor(WecomCardActionKey.VIEW, "roy-task-22-1-q"), {
      markTaskDone: async () => {},
      reopenTask: async () => {},
      updateCard: async (_r, _c, _s, _n, _t, _a, extra) => {
        expect(extra?.taskTitle).toBeUndefined();
      },
      loadTimeline: () => [],
      loadTaskTitle: () => Promise.reject(new Error("async boom")),
    });
    expect(result.ok).toBe(true);
  });

  test("loadTaskTitle 缺省/返回 undefined → 仍 ok（向后兼容）", async () => {
    const result = await handleWecomCardAction(frameFor(WecomCardActionKey.MARK_DONE, "roy-task-12-1-m"), {
      markTaskDone: async () => {},
      reopenTask: async () => {},
      updateCard: async () => {},
    });
    expect(result.ok).toBe(true);
  });

  test("loadTaskTitle 抛错 → 降级为无标题，卡片更新不阻断", async () => {
    const result = await handleWecomCardAction(frameFor(WecomCardActionKey.VIEW, "roy-task-13-1-n"), {
      markTaskDone: async () => {},
      reopenTask: async () => {},
      updateCard: async (_r, _c, _s, _n, _t, _a, extra) => {
        expect(extra?.taskTitle).toBeUndefined();
      },
      loadTimeline: () => [],
      loadTaskTitle: () => {
        throw new Error("boom");
      },
    });
    expect(result.ok).toBe(true);
  });
});

describe("Task #5273 返工 — m1 悬挂分隔符", () => {
  test("★CV-m1 只带 taskTitle 不带 taskNumber → 无悬挂分隔符（📋 · x → 📋 x）", () => {
    const frame = buildWecomCardUpdateFrame({
      reqId: "m1b",
      taskId: "roy-task-6-1-w",
      statusLabel: "👀 已查看",
      taskTitle: "只有标题",
    });
    const card = frame.body.template_card as {
      main_title: { title: string };
    };
    expect(card.main_title.title).toBe("📋 只有标题 · 👀 已查看");
    expect(card.main_title.title.startsWith("📋 · ")).toBe(false);
  });

  test("★CV-m1 只带 taskNumber 不带 taskTitle → 无悬挂分隔符", () => {
    const frame = buildWecomCardUpdateFrame({
      reqId: "m1",
      taskId: "roy-task-5-1-z",
      statusLabel: "👀 已查看",
      taskNumber: 5,
    });
    const card = frame.body.template_card as {
      main_title: { title: string };
    };
    expect(card.main_title.title).toBe("📋 Task #5 · 👀 已查看");
    expect(card.main_title.title).not.toMatch(/·\s*·/);
    expect(card.main_title.title.trim().endsWith("·")).toBe(false);
  });

  test("★CV-m3 标题截断：clip 后含 … 时总长 ≤ 60+1", () => {
    const longTitle = "标".repeat(120);
    const frame = buildWecomCardUpdateFrame({
      reqId: "m3",
      taskId: "roy-task-7-1-y",
      statusLabel: "👀 已查看",
      taskTitle: longTitle,
      taskNumber: 7,
    });
    const card = frame.body.template_card as {
      main_title: { title: string };
    };
    const titleMarks = (card.main_title.title.match(/标/g) ?? []).length;
    // clip(text, 60) 截 60 字 + …；标题本体 ≤ 61 字符
    expect(titleMarks).toBeLessThanOrEqual(60);
    expect(card.main_title.title).toContain("Task #7");
  });
});
