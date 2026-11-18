/**
 * @fileoverview Task #5419 —— 企微 session 卡对齐飞书（#5403 规格）
 *
 * ## 用户需求（2026-11-13）
 *
> 「企微 es 的逻辑也要 review 下，希望还是只发一个卡片也是 subsession
>  关联的，而不是 task 关联的，有刷新详情按钮可以刷新 subsession 状态
>  （包括是否建任务，以及任务名称和动态，也包括 subsession 的消息数）
>  因为企微无法自动同步，就通过刷新按钮来同步包括 session 消息数。
>  另外也有按钮进行飞书建群哈，功能跟飞书一样，建关联飞书群，建完可以
>  展示或者发一条企微消息带上飞书群跳转链接哈」
 *
 * ## 本文件锁定
 *
 * A. 刷新增强：
 *   1. `loadSessionTaskInfo` 端口（session→task 反查 + 全量 task 信息）
 *   2. 刷新帧渲染任务名称 / 状态 / 任务操作记录
 *   3. 端口缺失/抛错 ⇒ 降级（不阻断刷新）
 * B. 建群按钮：
 *   4. `WecomCardActionKey.CREATE_LARK_GROUP` + session 卡渲染按钮
 *   5. handler 路由：session 主键路径放行 create_lark_group
 *   6. 幂等：已有群 ⇒ 返回已有 chatId，不重复建
 *   7. 建群成功 ⇒ 窗口内更新卡（带群链接）+ 发一条企微消息带 applink
 *   8. 建群失败 ⇒ ok=false + 卡片仍更新（错误提示）
 */

import { describe, test, expect } from "bun:test";
import {
  __resetWecomCardActionInflightForTest,
  handleWecomCardAction,
  buildWecomSessionCardUpdateBody,
  type WecomCardActionPorts,
} from "./wecom-card-action-handler";
import {
  WecomCardActionKey,
  buildWecomSessionCard,
  wecomCardTaskIdForSession,
} from "./wecom-card-builder";
import {
  createMemoryWecomSessionCardStore,
  type WecomSessionCardState,
  type WecomSessionCardStore,
} from "../task/plugins/wecom-session-card-store";

const SESSION_ID = "session_5419_align";
const REQ_ID = "REQ-5419-1";
const NOW = new Date(2026, 10, 13, 9, 0, 0).getTime();
const MIN = 60 * 1000;

function frame(key: string) {
  return {
    cmd: "aibot_event_callback",
    headers: { req_id: REQ_ID },
    body: {
      event: {
        eventtype: "template_card_event",
        template_card_event: {
          event_key: key,
          task_id: wecomCardTaskIdForSession(SESSION_ID),
        },
      },
      from: { userid: "user1" },
    },
  };
}

function seed(over: Partial<WecomSessionCardState> = {}): WecomSessionCardStore {
  const store = createMemoryWecomSessionCardStore();
  store.upsert({
    sessionId: SESSION_ID,
    chatId: "dzk_userid",
    chatType: "single",
    sourceId: "wecom-bot-1",
    cardTaskId: wecomCardTaskIdForSession(SESSION_ID),
    lifecycle: "running",
    title: "企微卡对齐飞书",
    agentType: "roy",
    startedAt: new Date(NOW - 30 * MIN).toISOString(),
    createdAt: NOW - 30 * MIN,
    updatedAt: NOW - MIN,
    ...over,
  });
  return store;
}

function makePorts(
  store: WecomSessionCardStore | undefined,
  extra: Partial<WecomCardActionPorts> = {},
): WecomCardActionPorts {
  return {
    markTaskDone: async () => {},
    reopenTask: async () => {},
    updateCard: async () => {},
    ...(store ? { loadSessionCardState: (sid: string) => store.get(sid) } : {}),
    ...extra,
  };
}

// ============================================================================
// A. 刷新增强：任务信息进刷新卡
// ============================================================================

describe("#5419 A：刷新增强", () => {
  test("A1 loadSessionTaskInfo 注入 ⇒ 刷新帧带任务名称与状态", async () => {
    __resetWecomCardActionInflightForTest();
    const store = seed({ associatedTaskId: 5419 });
    let capturedState: WecomSessionCardState | undefined;
    const ports = makePorts(store, {
      updateSessionCard: async (_reqId, input) => {
        capturedState = input.state;
      },
      loadSessionActivity: async () => ({
        activity: { messageCount: 42, updatedAt: NOW - MIN },
        terminal: false,
      }),
    });
    // 生产接线形状：session→task 反查 + getTaskWithOperations
    ports.loadSessionTaskInfo = async (sessionId) => {
      if (sessionId !== SESSION_ID) return undefined;
      return {
        id: 5419,
        title: "企微 ES 卡片对齐飞书",
        status: "active",
        progress: 15,
        milestones: [
          { title: "差异清单落盘", timestamp: new Date(NOW - 5 * MIN).toISOString() },
          { title: "TDD 实施中", timestamp: new Date(NOW - MIN).toISOString() },
        ],
      };
    };

    const r = await handleWecomCardAction(
      frame(WecomCardActionKey.REFRESH_ACTIVITY),
      ports,
    );
    expect(r.ok).toBe(true);
    expect(capturedState).toBeDefined();

    // 用快照 + task info 重建刷新帧（生产 updateSessionCard 的实现路径）
    const body = buildWecomSessionCardUpdateBody({
      cardTaskId: wecomCardTaskIdForSession(SESSION_ID),
      sessionId: SESSION_ID,
      reqIdForTest: REQ_ID,
      state: capturedState,
      activity: { messageCount: 42, updatedAt: NOW - MIN },
      task: {
        id: 5419,
        title: "企微 ES 卡片对齐飞书",
        status: "active",
      },
      now: NOW,
    });
    const text = JSON.stringify(body.body);
    expect(text).toContain("企微 ES 卡片对齐飞书");
    expect(text).toContain("active");
  });

  test("A2 loadSessionTaskInfo 未注入 ⇒ 刷新照常（降级，不抛错）", async () => {
    __resetWecomCardActionInflightForTest();
    const store = seed();
    let updated = false;
    const r = await handleWecomCardAction(
      frame(WecomCardActionKey.REFRESH_ACTIVITY),
      makePorts(store, {
        updateSessionCard: async () => {
          updated = true;
        },
        loadSessionActivity: async () => ({
          activity: { messageCount: 7, updatedAt: NOW - MIN },
          terminal: false,
        }),
      }),
    );
    expect(r.ok).toBe(true);
    expect(updated).toBe(true);
  });

  test("A3 loadSessionTaskInfo 抛错 ⇒ 降级，刷新仍成功", async () => {
    __resetWecomCardActionInflightForTest();
    const store = seed({ associatedTaskId: 5419 });
    let updated = false;
    const r = await handleWecomCardAction(
      frame(WecomCardActionKey.REFRESH_ACTIVITY),
      makePorts(store, {
        updateSessionCard: async () => {
          updated = true;
        },
        loadSessionActivity: async () => ({
          activity: { messageCount: 7, updatedAt: NOW - MIN },
          terminal: false,
        }),
        loadSessionTaskInfo: async () => {
          throw new Error("task store unavailable");
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(updated).toBe(true);
  });

  test("A4 无任务（反查 undefined）⇒ 刷新帧无任务行", () => {
    const body = buildWecomSessionCardUpdateBody({
      cardTaskId: wecomCardTaskIdForSession(SESSION_ID),
      sessionId: SESSION_ID,
      reqIdForTest: REQ_ID,
      state: seed().get(SESSION_ID),
      activity: { messageCount: 3, updatedAt: NOW - MIN },
      now: NOW,
    });
    const text = JSON.stringify(body.body);
    expect(text).not.toContain("任务");
    expect(text).toContain(SESSION_ID);
  });
});

// ============================================================================
// B. 建群按钮
// ============================================================================

describe("#5419 B：建关联飞书群按钮", () => {
  test("B1 session 卡渲染建群按钮（key=task_create_lark_group）", () => {
    const card = buildWecomSessionCard({
      sessionId: SESSION_ID,
      lifecycle: "running",
    });
    const keys = card.button_list.map((b) => b.key);
    expect(keys).toContain(WecomCardActionKey.CREATE_LARK_GROUP);
  });

  test("B2 路由：session 主键 + create_lark_group ⇒ 走建群处理（不再报 requires task card）", async () => {
    __resetWecomCardActionInflightForTest();
    const store = seed();
    const r = await handleWecomCardAction(
      frame(WecomCardActionKey.CREATE_LARK_GROUP),
      makePorts(store, {
        // 建群端口未注入 ⇒ 明确报错（而不是老的「requires a task card」）
        loadSessionActivity: async () => ({
          activity: { messageCount: 1, updatedAt: NOW },
          terminal: false,
        }),
      }),
    );
    // 端口未注入：ok=false 但错误信息是建群语义，不是「requires task card」
    expect(r.ok).toBe(false);
    expect(r.error).toContain("createLarkGroupForSession");
    expect(r.error).not.toContain("requires a task card");
  });

  test("B3 幂等：已有群 ⇒ 返回已有 chatId，不重复建群", async () => {
    __resetWecomCardActionInflightForTest();
    const store = seed();
    let createCalls = 0;
    let captured: { perTaskChatId?: string } | undefined;
    const r = await handleWecomCardAction(
      frame(WecomCardActionKey.CREATE_LARK_GROUP),
      makePorts(store, {
        loadSessionActivity: async () => ({
          activity: { messageCount: 1, updatedAt: NOW },
          terminal: false,
        }),
        findGroupChatForSession: async (sid) =>
          sid === SESSION_ID
            ? { chatId: "oc_existing_group" }
            : undefined,
        createLarkGroupForSession: async () => {
          createCalls += 1;
          return "oc_new_group";
        },
        updateSessionCard: async (_reqId, input) => {
          captured = { perTaskChatId: input.perTaskChatId };
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(createCalls).toBe(0);
    expect(r.newChatId).toBe("oc_existing_group");
    // 幂等命中也要刷卡片带已有群链接
    expect(captured?.perTaskChatId).toBe("oc_existing_group");
  });

  test("B4 建群成功 ⇒ createLarkGroupForSession 被调 + 卡片更新带群链接 + 发企微消息带 applink", async () => {
    __resetWecomCardActionInflightForTest();
    const store = seed();
    let createdFor: string | undefined;
    let capturedChatId: string | undefined;
    let notifyText = "";
    const r = await handleWecomCardAction(
      frame(WecomCardActionKey.CREATE_LARK_GROUP),
      makePorts(store, {
        loadSessionActivity: async () => ({
          activity: { messageCount: 1, updatedAt: NOW },
          terminal: false,
        }),
        findGroupChatForSession: async () => undefined,
        createLarkGroupForSession: async (sid) => {
          createdFor = sid;
          return "oc_new_group_5419";
        },
        updateSessionCard: async (_reqId, input) => {
          capturedChatId = input.perTaskChatId;
        },
        notifyGroupLink: async (input) => {
          notifyText = JSON.stringify(input ?? {});
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(createdFor).toBe(SESSION_ID);
    expect(r.newChatId).toBe("oc_new_group_5419");
    // 卡片更新带群 chatId（渲染层由 buildWecomSessionUpdateFrame
    // 落成「飞书群」行；applink 由 notifyGroupLink 消息承载）
    expect(capturedChatId).toBe("oc_new_group_5419");
    // 企微消息带 applink（best-effort 通道被调用；chatId 由
    // handler 传，applink 由生产接线构造——见 wecom-cli-handler）
    expect(notifyText).toContain("oc_new_group_5419");
  });

  test("B5 建群抛错 ⇒ ok=false + 卡片仍更新（错误反馈，用户点了必须有响应）", async () => {
    __resetWecomCardActionInflightForTest();
    const store = seed();
    let cardUpdated = false;
    const r = await handleWecomCardAction(
      frame(WecomCardActionKey.CREATE_LARK_GROUP),
      makePorts(store, {
        loadSessionActivity: async () => ({
          activity: { messageCount: 1, updatedAt: NOW },
          terminal: false,
        }),
        findGroupChatForSession: async () => undefined,
        createLarkGroupForSession: async () => {
          throw new Error("lark-cli +chat-create failed");
        },
        updateSessionCard: async () => {
          cardUpdated = true;
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("lark-cli +chat-create failed");
    expect(cardUpdated).toBe(true);
  });

  test("B6 notifyGroupLink 抛错 ⇒ 不阻断建群结果（best-effort）", async () => {
    __resetWecomCardActionInflightForTest();
    const store = seed();
    const r = await handleWecomCardAction(
      frame(WecomCardActionKey.CREATE_LARK_GROUP),
      makePorts(store, {
        loadSessionActivity: async () => ({
          activity: { messageCount: 1, updatedAt: NOW },
          terminal: false,
        }),
        findGroupChatForSession: async () => undefined,
        createLarkGroupForSession: async () => "oc_ok_group",
        notifyGroupLink: async () => {
          throw new Error("ws send failed");
        },
        updateSessionCard: async () => {},
      }),
    );
    expect(r.ok).toBe(true);
    expect(r.newChatId).toBe("oc_ok_group");
  });
});

// ============================================================================
// C. CV 5419 修复回归
// ============================================================================

describe("#5419 C：CV 修复回归", () => {
  test("C1 notifyGroupLink 收到点击者 userId（企微侧通知目标）", async () => {
    __resetWecomCardActionInflightForTest();
    const store = seed();
    let notified: { userId?: string; chatId?: string } | undefined;
    const r = await handleWecomCardAction(
      frame(WecomCardActionKey.CREATE_LARK_GROUP),
      makePorts(store, {
        loadSessionActivity: async () => ({
          activity: { messageCount: 1, updatedAt: NOW },
          terminal: false,
        }),
        findGroupChatForSession: async () => undefined,
        createLarkGroupForSession: async () => "oc_cv_group",
        notifyGroupLink: async (input) => {
          notified = { userId: input.userId, chatId: input.chatId };
        },
        updateSessionCard: async () => {},
      }),
    );
    expect(r.ok).toBe(true);
    expect(notified?.userId).toBe("user1"); // frame 里 from.userid
    expect(notified?.chatId).toBe("oc_cv_group");
  });

  test("C2 建群失败 ⇒ 卡片更新带 errorHint（用户可见反馈）", async () => {
    __resetWecomCardActionInflightForTest();
    const store = seed();
    let capturedHint: string | undefined;
    const r = await handleWecomCardAction(
      frame(WecomCardActionKey.CREATE_LARK_GROUP),
      makePorts(store, {
        loadSessionActivity: async () => ({
          activity: { messageCount: 1, updatedAt: NOW },
          terminal: false,
        }),
        findGroupChatForSession: async () => undefined,
        createLarkGroupForSession: async () => {
          throw new Error("quota exceeded");
        },
        updateSessionCard: async (_reqId, input) => {
          capturedHint = input.errorHint;
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(capturedHint).toContain("建群失败");
    expect(capturedHint).toContain("quota exceeded");
  });
});
