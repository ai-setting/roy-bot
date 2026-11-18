/**
 * @fileoverview Task #5261 — 企微卡片 reopen 时间线保留
 *
 * ## 用户反馈（12:29）
 *
 * 任务重开（reopen）后卡片时间线清零——之前的里程碑/操作记录丢了。
 *
 * ## 取证（Task #5261）
 *
 * - 卡片点击「重新打开」路径：wecom-card-action-handler.ts
 *   doHandle 中 timeline 仅在 actionType==="view" 时经
 *   ports.loadTimeline 从 store 加载，reopen 分支
 *   timeline=undefined → buildWecomCardUpdateBody →
 *   buildWecomCardUpdateFrame 里 `milestones: input.milestones ?? []`
 *   → 更新后卡片正文时间线为空数组，历史里程碑从卡片上消失。
 * - store 层 markReopened 只翻 status，不清 timeline（数据没丢）。
 * - 插件 sendCardUpdate reopen 分支仅复用记录，未追加「已重开」里程碑。
 *
 * ## 修复
 *
 * 1. reopen 动作也走 loadTimeline（历史时间线刷回卡片）
 * 2. 插件 sendCardUpdate reopen 分支追加「🔄 已重开」里程碑
 */

import { describe, it, expect } from "bun:test";
import {
  WecomTaskNotifyHook,
  type WecomTaskNotifyConfig,
} from "./wecom-task-notify-plugin";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type {
  TaskCreateResultContext,
  TaskUpdateResultContext,
  TaskOperationCreateResultContext,
} from "../hooks/contexts";
import { runWithEnvContext, type EnvContext } from "../../context";
import { createMemoryWecomCardStore } from "./wecom-card-state-store";
import {
  handleWecomCardAction,
  __resetWecomCardActionInflightForTest,
  type WecomCardActionPorts,
} from "../../event-source/wecom-card-action-handler";
import { WecomCardActionKey, newWecomCardTaskId } from "../../event-source/wecom-card-builder";
import { beforeEach } from "bun:test";

// ============================================================================
// 测试辅助（与 wecom-card-single-refresh-5255.test.ts 同款）
// ============================================================================

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 1,
    title: "测试任务",
    description: "测试描述",
    status: "active",
    priority: "high",
    type: "normal",
    progress: 50,
    current_status: "进行中",
    createdAt: "2026-06-01T00:00:00Z",
    updatedAt: "2026-06-01T01:00:00Z",
    project_path: "/tmp/test",
    context: "{}",
    ...overrides,
  };
}

function makeOperation(overrides: Partial<any> = {}): any {
  return {
    id: 100,
    taskId: 1,
    sessionId: "session-abc",
    milestoneType: "milestone",
    milestoneTitle: "完成需求分析",
    milestoneDescription: "已完成核心功能的需求拆解",
    processDescription: "读代码 + 写测试",
    timestamp: "2026-06-01T02:00:00Z",
    ...overrides,
  };
}

function makeWecomEnvContext(overrides: Partial<EnvContext> = {}): EnvContext {
  return {
    envEvent: {
      type: "event-source.event.wecom-cli",
      metadata: { sourceId: "es-wecom-1", chatId: "DongZhaoKun" },
    },
    sourceId: "es-wecom-1",
    userId: "DongZhaoKun",
    replyChannel: {
      type: "wecom-cli",
      chatId: "DongZhaoKun",
      params: { chatType: "single", userId: "DongZhaoKun" },
    },
    pluginEnabled: { "es-wecom-1:WecomTaskNotifyPlugin": true },
    ...overrides,
  } as EnvContext;
}

function makeHookContext<T>(
  hookPoint: string,
  data: T,
  metadata: Record<string, unknown> = {}
): HookContext<T> {
  return {
    component: { name: "task", version: "1.0.0" },
    data,
    metadata,
    phase: "after",
    hookPoint,
  };
}

function makeHook(overrides: Partial<WecomTaskNotifyConfig> = {}) {
  const calls: Array<{ chatId: string; content: string }> = [];
  const sender = {
    send: async (input: { chatId: string; content: string }) => {
      calls.push({ ...input });
      return { ok: true as const };
    },
  };
  const store = createMemoryWecomCardStore();
  const hook = new WecomTaskNotifyHook({
    sender: sender as any,
    cardStateStore: store,
    sourceId: "es-wecom-1",
    pluginName: "WecomTaskNotifyPlugin",
    ...overrides,
  });
  return { hook, calls, store };
}

function makeCardEventFrame(input: {
  reqId: string;
  eventKey: string;
  taskId: string;
}) {
  return {
    cmd: "aibot_event_callback",
    headers: { req_id: input.reqId },
    body: {
      msgid: "MSG-1",
      create_time: 1700000000,
      aibotid: "BOT-1",
      chatid: "DongZhaoKun",
      chattype: "single",
      from: { userid: "DongZhaoKun" },
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

// ============================================================================
// Tests
// ============================================================================

describe("Task #5261 — reopen 保留历史时间线", () => {
  beforeEach(() => __resetWecomCardActionInflightForTest());

  it("RED-1: 插件 sendCardUpdate reopen 分支追加「已重开」里程碑（历史不丢）", async () => {
    const { hook, store } = makeHook();
    await runWithEnvContext(makeWecomEnvContext(), async () => {
      // 首卡
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_CREATE, {
          task: makeTask({ id: 31 }),
        } as unknown as TaskCreateResultContext)
      );
      // 一条操作记录进时间线
      await hook.execute(
        makeHookContext(TaskHookPoints.OPERATION_AFTER_CREATE, {
          operation: makeOperation({ taskId: 31, milestoneTitle: "历史里程碑A" }),
        } as unknown as TaskOperationCreateResultContext)
      );
      // 终态
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_UPDATE, {
          task: makeTask({ id: 31, status: "completed" }),
          changes: { status: "completed" },
        } as unknown as TaskUpdateResultContext)
      );
    });

    const before = JSON.parse(store.get(31)!.timeline) as Array<{ title: string }>;
    expect(before.some((m) => m.title.includes("历史里程碑A"))).toBe(true);

    // reopen：closed → 非终态
    await runWithEnvContext(makeWecomEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_UPDATE, {
          task: makeTask({ id: 31, status: "active" }),
          changes: { status: "active" },
        } as unknown as TaskUpdateResultContext)
      );
    });

    const after = JSON.parse(store.get(31)!.timeline) as Array<{ title: string }>;
    // 历史里程碑仍在
    expect(after.some((m) => m.title.includes("历史里程碑A"))).toBe(true);
    // 追加了「已重开」记录
    expect(after.some((m) => m.title.includes("已重开") || m.title.includes("重开"))).toBe(true);
    expect(store.get(31)!.status).toBe("open");
  });

  it("RED-2: 卡片点击「重新打开」→ updateCard 收到历史时间线（非空）", async () => {
    const { hook, store } = makeHook();
    // 先用插件造历史时间线（首卡 + 操作 + 终态 + reopen 落库）
    await runWithEnvContext(makeWecomEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_CREATE, {
          task: makeTask({ id: 32 }),
        } as unknown as TaskCreateResultContext)
      );
      await hook.execute(
        makeHookContext(TaskHookPoints.OPERATION_AFTER_CREATE, {
          operation: makeOperation({ taskId: 32, milestoneTitle: "历史里程碑B" }),
        } as unknown as TaskOperationCreateResultContext)
      );
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_UPDATE, {
          task: makeTask({ id: 32, status: "completed" }),
          changes: { status: "completed" },
        } as unknown as TaskUpdateResultContext)
      );
    });

    const updates: Array<{ timeline?: Array<{ title: string }> }> = [];
    const ports: WecomCardActionPorts = {
      markTaskDone: async () => {},
      reopenTask: async () => {},
      updateCard: async (_reqId, _cardTaskId, _statusLabel, _note, timeline) => {
        updates.push({ timeline });
      },
      loadTimeline: (taskId) => {
        const rec = store.get(taskId);
        if (!rec?.timeline) return [];
        try {
          const arr = JSON.parse(rec.timeline);
          return Array.isArray(arr) ? arr : [];
        } catch {
          return [];
        }
      },
    };

    const result = await handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-5261",
        eventKey: WecomCardActionKey.REOPEN,
        taskId: newWecomCardTaskId(32),
      }),
      ports,
    );
    expect(result.ok).toBe(true);
    expect(updates).toHaveLength(1);
    // ★ 核心：reopen 更新帧必须带历史时间线（旧行为 undefined → 空数组）
    const tl = updates[0].timeline;
    expect(Array.isArray(tl)).toBe(true);
    expect(tl!.length).toBeGreaterThan(0);
    expect(tl!.some((m) => m.title.includes("历史里程碑B"))).toBe(true);
  });

  it("N1 回归: view 动作仍带历史时间线（#5203 行为不变）", async () => {
    const { hook, store } = makeHook();
    await runWithEnvContext(makeWecomEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_CREATE, {
          task: makeTask({ id: 33 }),
        } as unknown as TaskCreateResultContext)
      );
      await hook.execute(
        makeHookContext(TaskHookPoints.OPERATION_AFTER_CREATE, {
          operation: makeOperation({ taskId: 33, milestoneTitle: "历史里程碑C" }),
        } as unknown as TaskOperationCreateResultContext)
      );
    });

    const updates: Array<{ timeline?: Array<{ title: string }> }> = [];
    const ports: WecomCardActionPorts = {
      markTaskDone: async () => {},
      reopenTask: async () => {},
      updateCard: async (_reqId, _cardTaskId, _statusLabel, _note, timeline) => {
        updates.push({ timeline });
      },
      loadTimeline: (taskId) => {
        const rec = store.get(taskId);
        if (!rec?.timeline) return [];
        try {
          const arr = JSON.parse(rec.timeline);
          return Array.isArray(arr) ? arr : [];
        } catch {
          return [];
        }
      },
    };

    const result = await handleWecomCardAction(
      makeCardEventFrame({
        reqId: "REQ-VIEW",
        eventKey: WecomCardActionKey.VIEW,
        taskId: newWecomCardTaskId(33),
      }),
      ports,
    );
    expect(result.ok).toBe(true);
    expect(updates).toHaveLength(1);
    expect(updates[0].timeline!.some((m) => m.title.includes("历史里程碑C"))).toBe(true);
  });
});
