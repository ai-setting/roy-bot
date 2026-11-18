/**
 * @fileoverview Task #5255 — 企微卡片单卡刷新（一张卡走全程）
 *
 * ## 用户诉求（10:34 截图）
 *
 * 同一任务刷出 4 张卡（每次状态变化发新卡），体验差。
 * 要求：一张卡走全程，状态变化原地刷新。
 *
 * ## 协议取证（Task #5255，官方 101463/101032 + aibot-node-sdk）
 *
 * - `aibot_respond_update_msg` 仅适用于 template_card_event
 *   （用户点按钮）回调，5 秒窗口内，req_id 须透传回调帧
 *   ——企微协议**没有**「任意时刻主动 patch 已发卡片」的接口
 *   （对比飞书 LarkCardPatchNotifier）。
 * - task_id 官方语义（101032）：「同一机器人不能重复，只在发消息
 *   时有效，更新消息时无效」→ 无法用旧 task_id 重发实现原地刷新。
 *
 * ## 协议内最优解（本任务实现）
 *
 * 一张卡走全程 = **控制发卡次数**：
 * 1. 仅首卡：sendCardUpdate 无记录时不再降级补发新卡（终态除外），
 *    进展统一走节流时间线（数据不丢，点「刷新详情」可见全部）
 * 2. 终态合并：closed 后 60s 内的重复终态不再发新卡
 *    （防 task:after.update + task:after.complete 双发）
 * 3. 「刷新详情」点击走 updateCard（#5250 已有链路，回归守护）
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
  TaskCompleteResultContext,
  TaskOperationCreateResultContext,
} from "../hooks/contexts";
import { runWithEnvContext, type EnvContext } from "../../context";
import { createMemoryWecomCardStore } from "./wecom-card-state-store";

// ============================================================================
// 测试辅助（与 wecom-task-notify-plugin.test.ts 同款）
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

function makeHook(
  overrides: Partial<WecomTaskNotifyConfig> = {}
) {
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

// ============================================================================
// Tests — 单卡语义
// ============================================================================

describe("Task #5255 — 单卡语义（一张卡走全程）", () => {
  it("RED-1: 无记录的 update 不再降级补发新卡（进展走节流时间线）", async () => {
    const { hook, calls, store } = makeHook();
    // 首卡从未发出（模拟首卡失败/未创建）
    // 任务 update（非终态）→ 不应凭空发新卡
    await runWithEnvContext(makeWecomEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_UPDATE, {
          task: makeTask({ id: 21, progress: 80 }),
          changes: { progress: 80 },
        } as unknown as TaskUpdateResultContext)
      );
    });
    // 单卡语义：无首卡 → 不补发（进展数据走时间线落库）
    expect(calls).toHaveLength(0);
    expect(store.get(21)).toBeUndefined();
  });

  it("RED-2: 终态后 60s 内的重复终态不再发新卡（双发合并）", async () => {
    const { hook, calls, store } = makeHook();
    // 首卡
    await runWithEnvContext(makeWecomEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_CREATE, {
          task: makeTask({ id: 22 }),
        } as unknown as TaskCreateResultContext)
      );
    });
    expect(calls).toHaveLength(1);
    calls.length = 0;

    // 第一次终态（task:after.update status=completed）→ 发终态卡
    await runWithEnvContext(makeWecomEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_UPDATE, {
          task: makeTask({ id: 22, status: "completed" }),
          changes: { status: "completed" },
        } as unknown as TaskUpdateResultContext)
      );
    });
    expect(calls).toHaveLength(1);
    calls.length = 0;

    // ★ 紧接着 task:after.complete 也触发（AFTER_UPDATE 与
    //   AFTER_COMPLETE 不互斥，双发路径）→ 单卡语义：不再发新卡
    await runWithEnvContext(makeWecomEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_COMPLETE, {
          task: makeTask({ id: 22, status: "completed" }),
          terminalStatus: "completed",
        } as unknown as TaskCompleteResultContext)
      );
    });
    expect(calls).toHaveLength(0);
    expect(store.get(22)!.status).toBe("closed");
  });

  it("RED-3: 全生命周期只发 2 张卡（首卡 + 终态卡）", async () => {
    const { hook, calls } = makeHook({ operationThrottleMs: 60_000 });
    // create → 首卡
    await runWithEnvContext(makeWecomEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_CREATE, {
          task: makeTask({ id: 23 }),
        } as unknown as TaskCreateResultContext)
      );
    });
    expect(calls).toHaveLength(1);

    // update（progress）→ 不发新卡
    await runWithEnvContext(makeWecomEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_UPDATE, {
          task: makeTask({ id: 23, progress: 40 }),
          changes: { progress: 40 },
        } as unknown as TaskUpdateResultContext)
      );
    });
    expect(calls).toHaveLength(1);

    // operation → 节流窗口内不发（时间线落库）
    await runWithEnvContext(makeWecomEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.OPERATION_AFTER_CREATE, {
          operation: makeOperation({ taskId: 23, id: 300 }),
        } as unknown as TaskOperationCreateResultContext)
      );
    });
    expect(calls).toHaveLength(1);

    // 终态 → 第 2 张卡（终态卡）
    await runWithEnvContext(makeWecomEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_UPDATE, {
          task: makeTask({ id: 23, status: "completed", progress: 100 }),
          changes: { status: "completed" },
        } as unknown as TaskUpdateResultContext)
      );
    });
    expect(calls).toHaveLength(2);
  });

  it("RED-4: reopen（closed → 非终态 update）仍可翻回 open 继续更新", async () => {
    const { hook, calls, store } = makeHook();
    // 首卡 + 终态
    await runWithEnvContext(makeWecomEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_CREATE, {
          task: makeTask({ id: 24 }),
        } as unknown as TaskCreateResultContext)
      );
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_UPDATE, {
          task: makeTask({ id: 24, status: "completed" }),
          changes: { status: "completed" },
        } as unknown as TaskUpdateResultContext)
      );
    });
    expect(calls).toHaveLength(2);
    calls.length = 0;

    // reopen：用户重新激活任务 → 单卡语义不发新卡，
    // 但记录翻回 open（后续终态可再发终态卡）
    await runWithEnvContext(makeWecomEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_UPDATE, {
          task: makeTask({ id: 24, status: "active" }),
          changes: { status: "active" },
        } as unknown as TaskUpdateResultContext)
      );
    });
    expect(calls).toHaveLength(0);
    expect(store.get(24)!.status).toBe("open");
  });
});
