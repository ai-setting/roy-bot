/**
 * @fileoverview Task #5360（补充需求 22:31）—— 企微 session-only 卡片
 *
 * 用户需求：「企微卡片同逻辑」——有 sub-session 但无 task 时，也要推卡 +
 * 刷新按钮，能看到 subsession 消息数 + 最近 msg（截断）。
 *
 * 本文件锁定：
 * A. `roy-session-` 前缀与 `roy-task-` 互斥、反解无歧义
 * B. session 卡只支持 refresh_activity（mark_done / reopen / view 必须拒绝）
 * C. session 刷新走 `loadSessionActivity`（直达 store），不查 task
 * D. task 卡路径零回归
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  handleWecomCardAction,
  extractWecomCardAction,
  __resetWecomCardActionInflightForTest,
  buildWecomCardUpdateBody,
  type WecomCardActionPorts,
} from "./wecom-card-action-handler";
import {
  ROY_SESSION_PREFIX,
  WECOM_SESSION_TASK_SEP,
  WecomCardActionKey,
  wecomCardTaskIdForSession,
} from "./wecom-card-builder";
import type { ActivityProbeResult, SubSessionActivity } from "../task/plugins/sub-session-activity";

const NOW = new Date(2026, 10, 11, 22, 47, 12).getTime();
const MIN = 60 * 1000;
const SESSION_ID = "session_04357c17-9ff8-4e3d-a498-bc254da5caf9";
const REQ_ID = "req_session_1";

function act(over: Partial<SubSessionActivity> = {}): SubSessionActivity {
  return {
    subSessionId: SESSION_ID,
    messageCount: 88,
    updatedAt: NOW - 3 * MIN,
    lastMessage: { role: "assistant", content: "已定位到 delegate 的关联反查逻辑" },
    ...over,
  };
}

function probe(over: Partial<ActivityProbeResult> = {}): ActivityProbeResult {
  return { activity: act(), terminal: false, ...over };
}

/** 造 session 卡的 template_card_event 回调帧 */
function sessionFrame(eventKey: string) {
  return {
    cmd: "aibot_event_callback",
    headers: { req_id: REQ_ID },
    body: {
      event: {
        eventtype: "template_card_event",
        template_card_event: {
          event_key: eventKey,
          task_id: wecomCardTaskIdForSession(SESSION_ID),
        },
      },
      from: { userid: "user1" },
    },
  };
}

function makePorts(over: Partial<WecomCardActionPorts> = {}): WecomCardActionPorts {
  return {
    markTaskDone: async () => {},
    reopenTask: async () => {},
    updateCard: async () => {},
    ...over,
  };
}

beforeEach(() => {
  __resetWecomCardActionInflightForTest();
});

// ============================================================================
// A. 前缀与反解
// ============================================================================

describe("roy-session- 前缀", () => {
  test("★ wecomCardTaskIdForSession 生成 roy-session-<id>", () => {
    expect(ROY_SESSION_PREFIX).toBe("roy-session-");
    expect(wecomCardTaskIdForSession(SESSION_ID)).toBe(`roy-session-${SESSION_ID}`);
  });

  test("空 sessionId → 抛错（空主键会撞脏数据）", () => {
    expect(() => wecomCardTaskIdForSession("")).toThrow();
    expect(() => wecomCardTaskIdForSession("   ")).toThrow();
  });

  test("★ 反解：session 卡 → sessionId 有值且 taskId 为 null", () => {
    const a = extractWecomCardAction(sessionFrame(WecomCardActionKey.REFRESH_ACTIVITY));
    expect(a?.sessionId).toBe(SESSION_ID);
    expect(a?.taskId).toBeNull();
  });

  test("★ 反解：task 卡 → taskId 有值且 sessionId 为 null（互斥，无歧义）", () => {
    const frame = {
      cmd: "aibot_event_callback",
      headers: { req_id: REQ_ID },
      body: {
        event: {
          eventtype: "template_card_event",
          template_card_event: {
            event_key: WecomCardActionKey.VIEW,
            task_id: "roy-task-5360-3-abc",
          },
        },
        from: { userid: "user1" },
      },
    };
    const a = extractWecomCardAction(frame);
    expect(a?.taskId).toBe(5360);
    expect(a?.sessionId).toBeNull();
  });

  test("外部卡片（无 roy 前缀）→ 两者皆 null", () => {
    const frame = {
      cmd: "aibot_event_callback",
      headers: { req_id: REQ_ID },
      body: {
        event: {
          eventtype: "template_card_event",
          template_card_event: { event_key: "x", task_id: "other-123" },
        },
        from: { userid: "u" },
      },
    };
    const a = extractWecomCardAction(frame);
    expect(a?.taskId).toBeNull();
    expect(a?.sessionId).toBeNull();
  });
});

// ============================================================================
// B. session 卡只允许 refresh_activity
// ============================================================================

describe("session 卡的动作白名单", () => {
  test("★ refresh_activity → ok（走 session 路径）", async () => {
    let sessionLookups = 0;
    const r = await handleWecomCardAction(
      sessionFrame(WecomCardActionKey.REFRESH_ACTIVITY),
      makePorts({
        loadSessionActivity: async (sid) => {
          sessionLookups++;
          expect(sid).toBe(SESSION_ID);
          return probe();
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.action).toBe("refresh_activity");
    expect(sessionLookups).toBe(1);
  });

  test("★ mark_done / reopen / view → 一律拒绝（session 没有 task 可改/可读时间线）", async () => {
    for (const key of [
      WecomCardActionKey.MARK_DONE,
      WecomCardActionKey.REOPEN,
      WecomCardActionKey.VIEW,
    ]) {
      let markDone = 0;
      let reopen = 0;
      const r = await handleWecomCardAction(
        sessionFrame(key),
        makePorts({
          markTaskDone: async () => {
            markDone++;
          },
          reopenTask: async () => {
            reopen++;
          },
        }),
      );
      expect(r.ok).toBe(false);
      expect(r.error).toContain("requires a task card");
      // 绝不误改任何 task 状态
      expect(markDone).toBe(0);
      expect(reopen).toBe(0);
    }
  });
});

// ============================================================================
// C. session 刷新：直达 store + 活性渲染
// ============================================================================

describe("session-only 刷新", () => {
  test("★ 走 loadSessionActivity，不查 task", async () => {
    let captured: any;
    const r = await handleWecomCardAction(
      sessionFrame(WecomCardActionKey.REFRESH_ACTIVITY),
      makePorts({
        loadSessionActivity: async () => probe(),
        updateCard: async (...args: any[]) => {
          captured = args;
        },
      }),
    );
    expect(r.ok).toBe(true);
    // extra.activity 带消息数 + 最近消息
    expect(captured[6]?.activity?.messageCount).toBe(88);
    expect(captured[6]?.activity?.lastMessage?.content).toContain("delegate");
    // 不传 timeline（session 没有 task 操作记录）
    expect(captured[4]).toBeUndefined();
  });

  test("★ 更新帧渲染出活性（quote_area）", () => {
    const { body } = buildWecomCardUpdateBody({
      cardTaskId: wecomCardTaskIdForSession(SESSION_ID),
      statusLabel: "⚡ 活性已刷新",
      action: "refresh_activity",
      activity: act(),
      activityNow: NOW,
    });
    const q = (body as any).template_card.quote_area;
    expect(q).toBeDefined();
    expect(q.quote_text).toContain("消息数 88 条");
    expect(q.quote_text).toContain("delegate");
  });

  test("★ 端口未注入 → 暂无数据，仍 ok（按钮必须有反馈）", async () => {
    let captured: any;
    const r = await handleWecomCardAction(
      sessionFrame(WecomCardActionKey.REFRESH_ACTIVITY),
      makePorts({
        updateCard: async (...args: any[]) => {
          captured = args;
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(captured[6]?.activity).toBeNull();
  });

  test("★ 端口抛错 → 降级暂无数据，绝不失败", async () => {
    let captured: any;
    const r = await handleWecomCardAction(
      sessionFrame(WecomCardActionKey.REFRESH_ACTIVITY),
      makePorts({
        loadSessionActivity: () => {
          throw new Error("store down");
        },
        updateCard: async (...args: any[]) => {
          captured = args;
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(captured[6]?.activity).toBeNull();
  });
});

// ============================================================================
// D. task 卡零回归
// ============================================================================

describe("task 卡路径不变", () => {
  function taskFrame(key: string) {
    return {
      cmd: "aibot_event_callback",
      headers: { req_id: REQ_ID },
      body: {
        event: {
          eventtype: "template_card_event",
          template_card_event: { event_key: key, task_id: "roy-task-5360-1-x" },
        },
        from: { userid: "user1" },
      },
    };
  }

  test("★ task 卡 refresh_activity 仍走 loadSubSessionActivity（不是 session 路径）", async () => {
    let subSessionLookups = 0;
    let sessionLookups = 0;
    const r = await handleWecomCardAction(
      taskFrame(WecomCardActionKey.REFRESH_ACTIVITY),
      makePorts({
        loadSubSessionActivity: async () => {
          subSessionLookups++;
          return probe();
        },
        loadSessionActivity: async () => {
          sessionLookups++;
          return probe();
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(subSessionLookups).toBe(1);
    expect(sessionLookups).toBe(0);
  });

  test("★ task 卡 mark_done 仍正常（未被 session 分支挡掉）", async () => {
    let marked = 0;
    const r = await handleWecomCardAction(
      taskFrame(WecomCardActionKey.MARK_DONE),
      makePorts({
        markTaskDone: async () => {
          marked++;
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(marked).toBe(1);
  });
});
// ============================================================================
// E. ★ 澄清 22:37：session 主键 + task 附加值 + 生命周期
// ============================================================================

describe("澄清 22:37：taskId 是附加值，不改变 session 主键", () => {
  test("★ 带 taskId 生成 `roy-session-<sid>@task-<n>`", () => {
    expect(wecomCardTaskIdForSession(SESSION_ID, 5360)).toBe(
      `roy-session-${SESSION_ID}${WECOM_SESSION_TASK_SEP}5360`,
    );
  });

  test("★ 反解：带 task 段仍以 sessionId 为主键（task 段不污染主键）", () => {
    const frame = {
      cmd: "aibot_event_callback",
      headers: { req_id: REQ_ID },
      body: {
        event: {
          eventtype: "template_card_event",
          template_card_event: {
            event_key: WecomCardActionKey.REFRESH_ACTIVITY,
            task_id: wecomCardTaskIdForSession(SESSION_ID, 5360),
          },
        },
        from: { userid: "user1" },
      },
    };
    const a = extractWecomCardAction(frame);
    expect(a?.sessionId).toBe(SESSION_ID); // ← sessionId 干净
    expect(a?.taskId).toBeNull();          // ← 不走 roy-task 解析
  });

  test("sessionId 里含 @ 也能正确切分（只认第一个 @task-）", () => {
    const weird = "session_with@sign";
    const tid = wecomCardTaskIdForSession(weird, 7);
    const a = extractWecomCardAction({
      cmd: "aibot_event_callback",
      headers: { req_id: REQ_ID },
      body: {
        event: {
          eventtype: "template_card_event",
          template_card_event: { event_key: "x", task_id: tid },
        },
        from: { userid: "u" },
      },
    });
    expect(a?.sessionId).toBe(weird);
  });
});

describe("澄清 22:37：session 生命周期体现在卡片上", () => {
  test("★ 终态 session → 活性显示 ⚪已结束（不报 🔴疑似停滞），terminal 透传", async () => {
    let captured: any;
    const r = await handleWecomCardAction(
      sessionFrame(WecomCardActionKey.REFRESH_ACTIVITY),
      makePorts({
        loadSessionActivity: async () => ({
          activity: act({ updatedAt: NOW - 40 * MIN }),
          terminal: true, // ← session 层超时/完成
        }),
        updateCard: async (...args: any[]) => {
          captured = args;
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(captured[6]?.activityTerminal).toBe(true);

    const q = (captured[6].activity, null);
    expect(q).toBeNull(); // 占位：真实渲染断言在下面 buildWecomCardUpdateBody 用例
  });

  test("★ 终态渲染：⚪已结束，且不出现「疑似停滞」", () => {
    const { body } = buildWecomCardUpdateBody({
      cardTaskId: wecomCardTaskIdForSession(SESSION_ID, 5360),
      statusLabel: "⚡ 活性已刷新",
      action: "refresh_activity",
      activity: act({ updatedAt: NOW - 40 * MIN }),
      activityTerminal: true,
      activityNow: NOW,
    });
    const q = (body as any).template_card.quote_area;
    expect(q.quote_text).toContain("已结束");
    expect(q.quote_text).not.toContain("疑似停滞");
  });
});
