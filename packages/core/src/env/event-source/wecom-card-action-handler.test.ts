/**
 * @fileoverview Task #5203 — 企微卡片按钮点击处理测试
 *
 * 协议（官方 101027 接收事件）：
 * template_card_event 回调帧：
 * {
 *   cmd: "aibot_event_callback", headers: {req_id},
 *   body: {
 *     msgid, create_time, aibotid, chatid?, chattype, from:{userid},
 *     msgtype: "event",
 *     event: {
 *       eventtype: "template_card_event",
 *       template_card_event: {
 *         card_type: "button_interaction",
 *         event_key: "<按钮 key>",
 *         task_id: "<发卡时的全量 id>",
 *       },
 *     },
 *   },
 * }
 * 5 秒内经 aibot_respond_update_msg（透传 req_id）更新卡片。
 */

import { describe, expect, test, beforeEach } from "bun:test";
import {
  extractWecomCardAction,
  handleWecomCardAction,
  __resetWecomCardActionInflightForTest,
  type WecomCardActionPorts,
} from "./wecom-card-action-handler";
import { WecomCardActionKey, newWecomCardTaskId } from "./wecom-card-builder";

/** 构造 template_card_event 回调帧 */
function makeCardEventFrame(input: {
  reqId: string;
  eventKey: string;
  taskId: string;
  userid?: string;
  chatid?: string;
  chattype?: string;
  msgid?: string;
}) {
  return {
    cmd: "aibot_event_callback",
    headers: { req_id: input.reqId },
    body: {
      msgid: input.msgid ?? "MSG-1",
      create_time: 1700000000,
      aibotid: "BOT-1",
      chatid: input.chatid,
      chattype: input.chattype ?? "single",
      from: { userid: input.userid ?? "DongZhaoKun" },
      msgtype: "event",
      event: {
        eventtype: "template_card_event",
        template_card_event: {
          card_type: "button_interaction",
          event_key: input.eventKey,
          task_id: input.taskId,
        },
      },
    },
  };
}

describe("extractWecomCardAction — 回调帧解析", () => {
  test("button_interaction：解析 event_key + task_id + 操作者", () => {
    const frame = makeCardEventFrame({
      reqId: "REQ-1",
      eventKey: WecomCardActionKey.MARK_DONE,
      taskId: "roy-task-42-1-abc",
    });
    const action = extractWecomCardAction(frame);
    expect(action).not.toBeNull();
    expect(action!.eventKey).toBe("task_mark_done");
    expect(action!.cardTaskId).toBe("roy-task-42-1-abc");
    expect(action!.taskId).toBe(42);
    expect(action!.userId).toBe("DongZhaoKun");
    expect(action!.reqId).toBe("REQ-1");
  });

  test("task_id 非法（非 roy-task 前缀）→ taskId=null，仍返回事件", () => {
    const frame = makeCardEventFrame({
      reqId: "REQ-2",
      eventKey: "task_view",
      taskId: "fBmjTL7ErRCQSNA6GZKMlcFiWX1shOvg",
    });
    const action = extractWecomCardAction(frame);
    expect(action).not.toBeNull();
    expect(action!.taskId).toBeNull();
  });

  test("非 template_card_event → null", () => {
    const frame = {
      cmd: "aibot_event_callback",
      headers: { req_id: "R" },
      body: {
        msgid: "M",
        msgtype: "event",
        event: { eventtype: "enter_chat" },
      },
    };
    expect(extractWecomCardAction(frame)).toBeNull();
  });

  test("消息帧（aibot_msg_callback）→ null", () => {
    const frame = {
      cmd: "aibot_msg_callback",
      headers: { req_id: "R" },
      body: { msgid: "M", msgtype: "text", text: { content: "hi" } },
    };
    expect(extractWecomCardAction(frame)).toBeNull();
  });
});

describe("handleWecomCardAction — 动作分发", () => {
  beforeEach(() => __resetWecomCardActionInflightForTest());

  function makePorts(): {
    ports: WecomCardActionPorts;
    calls: {
      completed: number[];
      reopened: number[];
      updates: Array<{
        reqId: string;
        cardTaskId: string;
        statusLabel: string;
      }>;
    };
  } {
    const calls = { completed: [] as number[], reopened: [] as number[], updates: [] as any[] };
    const ports: WecomCardActionPorts = {
      markTaskDone: async (taskId) => {
        calls.completed.push(taskId);
      },
      reopenTask: async (taskId) => {
        calls.reopened.push(taskId);
      },
      updateCard: async (reqId, cardTaskId, statusLabel) => {
        calls.updates.push({ reqId, cardTaskId, statusLabel });
      },
    };
    return { ports, calls };
  }

  test("task_mark_done → markTaskDone + updateCard（已确认）", async () => {
    const { ports, calls } = makePorts();
    const cardTaskId = newWecomCardTaskId(42);
    const result = await handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-10",
        eventKey: WecomCardActionKey.MARK_DONE,
        taskId: cardTaskId,
      }),
      ports,
    );
    expect(result.ok).toBe(true);
    expect(result.action).toBe("mark_done");
    expect(calls.completed).toEqual([42]);
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].reqId).toBe("REQ-10");
    expect(calls.updates[0].cardTaskId).toBe(cardTaskId);
    expect(calls.updates[0].statusLabel).toContain("已完成");
  });

  test("task_reopen → reopenTask + updateCard（进行中）", async () => {
    const { ports, calls } = makePorts();
    const result = await handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-11",
        eventKey: WecomCardActionKey.REOPEN,
        taskId: newWecomCardTaskId(43),
      }),
      ports,
    );
    expect(result.ok).toBe(true);
    expect(result.action).toBe("reopen");
    expect(calls.reopened).toEqual([43]);
    expect(calls.updates[0].statusLabel).toContain("进行中");
  });

  test("task_view → 只更新卡片（不触发 task 操作）", async () => {
    const { ports, calls } = makePorts();
    const result = await handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-12",
        eventKey: WecomCardActionKey.VIEW,
        taskId: newWecomCardTaskId(44),
      }),
      ports,
    );
    expect(result.ok).toBe(true);
    expect(result.action).toBe("view");
    expect(calls.completed).toHaveLength(0);
    expect(calls.reopened).toHaveLength(0);
    expect(calls.updates).toHaveLength(1);
  });

  test("taskId 解析失败（非 roy-task 前缀）→ ok=false，不触发操作", async () => {
    const { ports, calls } = makePorts();
    const result = await handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-13",
        eventKey: WecomCardActionKey.MARK_DONE,
        taskId: "external-id-xyz",
      }),
      ports,
    );
    expect(result.ok).toBe(false);
    expect(calls.completed).toHaveLength(0);
    expect(calls.updates).toHaveLength(0);
  });

  test("markTaskDone 抛异常 → ok=false 带错误（updateCard 仍尝试）", async () => {
    const calls = { updates: [] as any[] };
    const ports: WecomCardActionPorts = {
      markTaskDone: async () => {
        throw new Error("db locked");
      },
      updateCard: async (reqId, cardTaskId, statusLabel) => {
        calls.updates.push({ reqId, cardTaskId, statusLabel });
      },
    };
    const result = await handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-14",
        eventKey: WecomCardActionKey.MARK_DONE,
        taskId: newWecomCardTaskId(45),
      }),
      ports,
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain("db locked");
    // 卡片更新仍执行（用户看到「处理失败」而不是无响应）
    expect(calls.updates).toHaveLength(1);
  });

  test("并发去重：同 (taskId, action) 双击 → 第二次被拒", async () => {
    const { ports, calls } = makePorts();
    // markTaskDone 慢 → 第一次还在处理中
    const slowPorts: WecomCardActionPorts = {
      ...ports,
      markTaskDone: async () => {
        await new Promise((r) => setTimeout(r, 50));
        calls.completed.push(46);
      },
    };
    const cardTaskId = newWecomCardTaskId(46);
    const p1 = handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-A",
        eventKey: WecomCardActionKey.MARK_DONE,
        taskId: cardTaskId,
      }),
      slowPorts,
    );
    const p2 = handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-B",
        eventKey: WecomCardActionKey.MARK_DONE,
        taskId: cardTaskId,
      }),
      slowPorts,
    );
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain("处理中");
    expect(calls.completed).toEqual([46]);
  });
});

// ============================================================================
// ★ Task #5203 时间线详情：view → loadTimeline → 卡片正文刷时间线
// ============================================================================

import {
  buildWecomCardUpdateBody,
} from "./wecom-card-action-handler";

describe("view 动作时间线详情（Task #5203）", () => {
  beforeEach(() => __resetWecomCardActionInflightForTest());

  function makeTimelinePorts(timeline: any[] | Error) {
    const calls = {
      updates: [] as Array<{
        reqId: string;
        cardTaskId: string;
        statusLabel: string;
        note?: string;
        timeline?: any[];
      }>,
    };
    const ports: WecomCardActionPorts = {
      markTaskDone: async () => {},
      reopenTask: async () => {},
      loadTimeline: () => {
        if (timeline instanceof Error) throw timeline;
        return timeline;
      },
      updateCard: async (reqId, cardTaskId, statusLabel, note, tl) => {
        calls.updates.push({ reqId, cardTaskId, statusLabel, note, timeline: tl });
      },
    };
    return { ports, calls };
  }

  test("view → loadTimeline 取时间线 → updateCard 携带 timeline", async () => {
    const tl = [
      { title: "Task 创建", timestamp: "2026-11-09T00:00:00Z" },
      {
        title: "M1 GREEN",
        timestamp: "2026-11-09T01:00:00Z",
        description: "10 测试全过",
      },
    ];
    const { ports, calls } = makeTimelinePorts(tl);
    const result = await handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-TL-1",
        eventKey: WecomCardActionKey.VIEW,
        taskId: newWecomCardTaskId(44),
      }),
      ports,
    );
    expect(result.ok).toBe(true);
    expect(result.action).toBe("view");
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].timeline).toEqual(tl);
    expect(calls.updates[0].reqId).toBe("REQ-TL-1");
  });

  test("store 无记录（loadTimeline 返回 []）→ 降级：updateCard 仍成功、timeline 为空数组", async () => {
    const { ports, calls } = makeTimelinePorts([]);
    const result = await handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-TL-2",
        eventKey: WecomCardActionKey.VIEW,
        taskId: newWecomCardTaskId(45),
      }),
      ports,
    );
    expect(result.ok).toBe(true);
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].timeline).toEqual([]);
  });

  test("loadTimeline 抛异常 → 降级不阻断：updateCard 仍被调用", async () => {
    const { ports, calls } = makeTimelinePorts(new Error("db locked"));
    const result = await handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-TL-3",
        eventKey: WecomCardActionKey.VIEW,
        taskId: newWecomCardTaskId(46),
      }),
      ports,
    );
    expect(result.ok).toBe(true);
    expect(calls.updates).toHaveLength(1);
    expect(calls.updates[0].timeline).toEqual([]);
  });

  test("mark_done 动作不读时间线（loadTimeline 不被调）", async () => {
    let loadCalls = 0;
    const calls = { updates: [] as any[] };
    const ports: WecomCardActionPorts = {
      markTaskDone: async () => {},
      reopenTask: async () => {},
      loadTimeline: () => {
        loadCalls++;
        return [];
      },
      updateCard: async (reqId, cardTaskId, statusLabel, note, tl) => {
        calls.updates.push({ reqId, cardTaskId, statusLabel, note, timeline: tl });
      },
    };
    const result = await handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-TL-4",
        eventKey: WecomCardActionKey.MARK_DONE,
        taskId: newWecomCardTaskId(47),
      }),
      ports,
    );
    expect(result.ok).toBe(true);
    expect(loadCalls).toBe(0);
    expect(calls.updates[0].timeline).toBeUndefined();
  });
});

describe("buildWecomCardUpdateBody — 时间线渲染（Task #5203）", () => {
  test("带 timeline → horizontal_content_list 渲染（截断修复：quote_area 只渲染 ~2 行）", () => {
    const { body } = buildWecomCardUpdateBody({
      cardTaskId: "roy-task-44-1-abc",
      statusLabel: "👀 已查看",
      timeline: [
        { title: "Task 创建", timestamp: "2026-11-09T00:00:00Z" },
        {
          title: "M1 GREEN",
          timestamp: "2026-11-09T01:00:00Z",
          description: "10 测试全过（过程：TDD RED→GREEN）",
        },
      ],
    });
    const card = body.template_card as any;
    // ★ 截断修复：时间线走 horizontal_content_list（官方 ≤6 条）
    expect(card.horizontal_content_list).toBeDefined();
    expect(card.horizontal_content_list.length).toBe(2);
    // 最新在上（倒序）
    expect(card.horizontal_content_list[0].value).toContain("M1 GREEN");
    expect(card.horizontal_content_list[1].value).toContain("Task 创建");
    // 每行 value ≤26 字（官方建议）
    for (const h of card.horizontal_content_list) {
      expect(h.keyname.length).toBeLessThanOrEqual(5);
      expect(h.value.length).toBeLessThanOrEqual(26);
    }
    // sub_title_text 统计条数与显示条数一致
    expect(card.sub_title_text).toContain("共 2 条");
    // task_id 原样回填
    expect(card.task_id).toBe("roy-task-44-1-abc");
  });

  test("timeline 超 6 条 → 只显示最近 6 条 + sub_title_text 注明总数", () => {
    const timeline = Array.from({ length: 9 }, (_, i) => ({
      title: `步骤${i}`,
      timestamp: new Date(2026, 0, 1, i).toISOString(),
    }));
    const { body } = buildWecomCardUpdateBody({
      cardTaskId: "roy-task-44-1-abc",
      statusLabel: "👀 已查看",
      timeline,
    });
    const card = body.template_card as any;
    expect(card.horizontal_content_list.length).toBe(6);
    expect(card.sub_title_text).toContain("共 9 条");
    expect(card.sub_title_text).toContain("显示最近 6 条");
  });

  test("无 timeline → 无 quote_area（简单按钮态）", () => {
    const { body } = buildWecomCardUpdateBody({
      cardTaskId: "roy-task-44-1-abc",
      statusLabel: "👀 已查看",
    });
    const card = body.template_card as any;
    expect(card.quote_area).toBeUndefined();
  });
});
