/**
 * @fileoverview Task #5418 — 企微 task 卡「刷新活性」反查不到 bgTask 时
 * 回退 session store probe 的修复测试。
 *
 * ## 复现（用户截图 2026-11-13 06:07）
 *
 * Task #5416 的企微卡（`roy-task-5416-*`）点「刷新活性」：
 * - 标题「⚡ 活性已刷新 / 已读取子会话最新活性」
 * - 子区块却渲染「❔ 暂无数据（子会话已归档或未落盘）」
 *
 * 根因：task 路径 `loadSubSessionActivity(taskId)` 依赖
 * `listBackgroundTasks()` 内存 Map 反查 bgTask；进程重启后
 * terminalTasks 全丢（非持久化）→ 反查不到 → `activity=undefined`
 * → 渲染「暂无数据」。而 session store（sessions.db）里数据完好
 * （42 条消息）。
 *
 * ## 修复语义
 *
 * task 路径 probe 返回 `activity=undefined`（反查不到 / 数据源缺）
 * 且端口注入了 `loadSessionActivity` 时，回退到 session store
 * probe 再试一次 —— 数据在 session store 里就别撒谎「暂无数据」。
 * session probe 也拿不到（真无数据）才渲染「暂无数据」。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  handleWecomCardAction,
  __resetWecomCardActionInflightForTest,
  type WecomCardActionPorts,
} from "./wecom-card-action-handler";
import { WecomCardActionKey } from "./wecom-card-builder";
import type {
  ActivityProbeResult,
  SubSessionActivity,
} from "../task/plugins/sub-session-activity";

const TASK_ID = 5418;
const CARD_TASK_ID = `roy-task-${TASK_ID}-3-abc123`;
const REQ_ID = "aibot_event_req_5418";
const SESSION_ID = "session_c45acb2b-f362-41c6-91fa-9935b4a01c59";

function sessionActivity(): SubSessionActivity {
  return {
    subSessionId: SESSION_ID,
    messageCount: 42,
    updatedAt: Date.now() - 60 * 1000,
    lastMessage: { role: "assistant", content: "任务已完成" },
  };
}

function makeFrame() {
  return {
    cmd: "aibot_event_callback",
    headers: { req_id: REQ_ID },
    body: {
      event: {
        eventtype: "template_card_event",
        template_card_event: {
          event_key: WecomCardActionKey.REFRESH_ACTIVITY,
          task_id: CARD_TASK_ID,
        },
      },
      from: { userid: "user1" },
    },
  };
}

function makePorts(
  overrides: Partial<WecomCardActionPorts> = {},
): WecomCardActionPorts {
  return {
    markTaskDone: async () => {},
    reopenTask: async () => {},
    updateCard: async () => {},
    loadTimeline: () => [],
    loadTaskTitle: () => ({ title: "[测试] 功能验证", number: TASK_ID }),
    // task 路径反查不到 bgTask（进程重启后内存 Map 空）→ activity=undefined
    loadSubSessionActivity: async () => ({ activity: undefined, terminal: true }),
    // session 卡持久层反查：associatedTaskId → sessionId
    findSessionCardByTaskId: async (taskId) =>
      taskId === TASK_ID
        ? {
            sessionId: SESSION_ID,
            chatId: "wo26OgBgAA",
            chatType: "single" as const,
            cardTaskId: CARD_TASK_ID,
            lifecycle: "completed" as const,
            associatedTaskId: TASK_ID,
            createdAt: 0,
            updatedAt: 0,
          }
        : undefined,
    // session store probe：数据完好
    loadSessionActivity: async () =>
      ({ activity: sessionActivity(), terminal: true, lifecycle: "completed" }),
    ...overrides,
  };
}

beforeEach(() => {
  __resetWecomCardActionInflightForTest();
});

describe("Task #5418 — task 卡刷新活性回退 session probe", () => {
  test("★ 反查不到 bgTask → 回退 loadSessionActivity，渲染真实活性（不是暂无数据）", async () => {
    let captured: any;
    let sessionProbeCalled = 0;
    const ports = makePorts({
      loadSessionActivity: async () => {
        sessionProbeCalled++;
        return {
          activity: sessionActivity(),
          terminal: true,
          lifecycle: "completed",
        };
      },
      updateCard: async (...args: any[]) => {
        captured = args;
      },
    });

    const r = await handleWecomCardAction(makeFrame(), ports);

    expect(r.ok).toBe(true);
    expect(sessionProbeCalled).toBe(1);
    // activity 必须是 session store 的真实数据（42 条消息），不是 null
    expect(captured[6]?.activity).toBeDefined();
    expect(captured[6].activity).not.toBeNull();
    expect(captured[6].activity.messageCount).toBe(42);
  });

  test("★ session probe 也没有 → 仍渲染「暂无数据」（null，诚实降级）", async () => {
    let captured: any;
    const ports = makePorts({
      loadSessionActivity: async () => ({ activity: undefined, terminal: true }),
      updateCard: async (...args: any[]) => {
        captured = args;
      },
    });

    const r = await handleWecomCardAction(makeFrame(), ports);

    expect(r.ok).toBe(true);
    expect(captured[6]?.activity).toBeNull();
  });

  test("★ 未注入 loadSessionActivity → 行为不变（null 暂无数据，向后兼容）", async () => {
    let captured: any;
    const ports = makePorts({
      loadSessionActivity: undefined,
      updateCard: async (...args: any[]) => {
        captured = args;
      },
    });

    const r = await handleWecomCardAction(makeFrame(), ports);

    expect(r.ok).toBe(true);
    expect(captured[6]?.activity).toBeNull();
  });

  test("★ task probe 正常拿到数据 → 不调 session probe（不浪费一次查询）", async () => {
    let sessionProbeCalled = 0;
    const ports = makePorts({
      loadSubSessionActivity: async () => ({
        activity: sessionActivity(),
        terminal: false,
      }),
      loadSessionActivity: async () => {
        sessionProbeCalled++;
        return { activity: sessionActivity(), terminal: false };
      },
    });

    const r = await handleWecomCardAction(makeFrame(), ports);

    expect(r.ok).toBe(true);
    expect(sessionProbeCalled).toBe(0);
  });

  test("★ session probe 抛错 → 仍渲染「暂无数据」（best-effort 不阻断）", async () => {
    let captured: any;
    const ports = makePorts({
      loadSessionActivity: () => {
        throw new Error("db locked");
      },
      updateCard: async (...args: any[]) => {
        captured = args;
      },
    });

    const r = await handleWecomCardAction(makeFrame(), ports);

    expect(r.ok).toBe(true);
    expect(captured[6]?.activity).toBeNull();
  });

  test("★ CV 5418 m1：回退路径 terminal 必须透传（终态不误报疑似停滞）", async () => {
    let captured: any;
    const ports = makePorts({
      loadSessionActivity: async () => ({
        activity: sessionActivity(),
        terminal: true,
        lifecycle: "completed",
      }),
      updateCard: async (...args: any[]) => {
        captured = args;
      },
    });

    await handleWecomCardAction(makeFrame(), ports);

    expect(captured[6]?.activityTerminal).toBe(true);
  });

  test("★ CV 5418 M1：同一 task 多条 session 卡 → 取最新（未终结优先）", async () => {
    let captured: any;
    const ports = makePorts({
      findSessionCardByTaskId: async () => ({
        sessionId: "session_old",
        chatId: "wo26OgBgAA",
        chatType: "single" as const,
        cardTaskId: CARD_TASK_ID,
        lifecycle: "completed" as const,
        associatedTaskId: TASK_ID,
        createdAt: 1,
        updatedAt: 1,
        closedAt: 2,
      }),
      loadSessionActivity: async (sid: string) => ({
        activity: {
          ...sessionActivity(),
          subSessionId: sid,
          messageCount: sid === SESSION_ID ? 42 : 7,
        },
        terminal: false,
      }),
      updateCard: async (...args: any[]) => {
        captured = args;
      },
    });
    // 直接在端口层模拟「多命中取最新」：这里验证 handler 只用
    // 反查返回的那一条（选择逻辑在注入方，见 wecom-cli-handler）。
    // 注入方逻辑单测见 wecom-cli-handler.test.ts。

    const r = await handleWecomCardAction(makeFrame(), ports);

    expect(r.ok).toBe(true);
    expect(captured[6]?.activity.messageCount).toBe(7);
    expect(captured[6]?.activity.subSessionId).toBe("session_old");
  });
});
