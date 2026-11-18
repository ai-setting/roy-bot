/**
 * @fileoverview WecomTaskNotifyHook Tests（Task #5193）
 *
 * 覆盖场景（对齐 LarkCliTaskNotifyHook 的测试结构）：
 * - Plugin interface compliance（Hook 接口）
 * - 事件源判定（wecom 事件才发，lark/CLI 事件跳过）
 * - 任务生命周期 → markdown 消息发送（create/update/complete/delete）
 * - 操作记录 → 时间线追加 + 节流
 * - state store 持久化（taskId→chatId/status）
 * - chat_id 解析（复用 resolveWecomCliChatId 的 sender 层，本层 mock）
 */

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import {
  WecomTaskNotifyHook,
  createWecomTaskNotifyHook,
  extractWecomFields,
  buildWecomTaskCard,
  type WecomTaskNotifyConfig,
  WecomNotifyType,
} from "./wecom-task-notify-plugin";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type {
  TaskCreateResultContext,
  TaskUpdateResultContext,
  TaskOperationCreateResultContext,
  TaskDeleteResultContext,
} from "../hooks/contexts";
import {
  runWithEnvContext,
  type EnvContext,
} from "../../context";
import {
  createMemoryWecomCardStore,
  type WecomCardStateStore,
} from "./wecom-card-state-store";

// ============================================================================
// 测试辅助
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

/** 企微 replyChannel（单聊：chatId = userid） */
function makeWecomReplyChannel(overrides: Partial<any> = {}): any {
  return {
    type: "wecom-cli",
    chatId: "DongZhaoKun",
    params: { chatType: "single", userId: "DongZhaoKun" },
    ...overrides,
  };
}

function makeWecomEnvContext(
  overrides: Partial<EnvContext> = {}
): EnvContext {
  return {
    envEvent: {
      type: "event-source.event.wecom-cli",
      metadata: { sourceId: "es-wecom-1", chatId: "DongZhaoKun" },
    },
    sourceId: "es-wecom-1",
    userId: "DongZhaoKun",
    replyChannel: makeWecomReplyChannel(),
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

/** 捕获发送调用的 sender（不 spawn wecom-cli） */
function makeCapturingSender() {
  const calls: Array<{ chatId: string; content: string }> = [];
  const sender = {
    send: mock(async (input: { chatId: string; content: string }) => {
      calls.push({ ...input });
      return { ok: true as const };
    }),
  };
  return { sender, calls };
}

/** 创建带 mock sender 的 hook（默认配置） */
function makeHook(
  overrides: Partial<WecomTaskNotifyConfig> = {},
  senderOverrides: Partial<ReturnType<typeof makeCapturingSender>["sender"]> = {}
) {
  const { sender, calls } = makeCapturingSender();
  Object.assign(sender, senderOverrides);
  const store: WecomCardStateStore = createMemoryWecomCardStore();
  const hook = new WecomTaskNotifyHook({
    sender: sender as any,
    cardStateStore: store,
    sourceId: "es-wecom-1",
    pluginName: "WecomTaskNotifyPlugin",
    ...overrides,
  });
  return { hook, sender, calls, store };
}

// ============================================================================
// Tests
// ============================================================================

describe("WecomTaskNotifyHook（Task #5193）", () => {
  // ========================================================================
  // 1. Plugin 接口合规性
  // ========================================================================
  describe("Plugin interface compliance", () => {
    it("should implement Hook interface", () => {
      const hook = new WecomTaskNotifyHook();
      expect(typeof hook.execute).toBe("function");
      expect(typeof hook.name).toBe("string");
      expect(typeof hook.priority).toBe("number");
    });

    it("should have default name WecomTaskNotifyHook", () => {
      const hook = new WecomTaskNotifyHook();
      expect(hook.name).toBe("WecomTaskNotifyHook");
    });

    it("should accept config in constructor", () => {
      const hook = new WecomTaskNotifyHook({
        enabled: false,
        priority: 10,
        pluginName: "custom-plugin",
        sourceId: "custom-source",
      });
      expect(hook.name).toBe("custom-plugin");
      expect(hook.priority).toBe(10);
    });
  });

  // ========================================================================
  // 2. extractWecomFields（事件源判定）
  // ========================================================================
  describe("extractWecomFields", () => {
    it("wecom 事件 → isWecom=true + chatId", () => {
      const fields = extractWecomFields(makeWecomEnvContext());
      expect(fields.isWecom).toBe(true);
      expect(fields.chatId).toBe("DongZhaoKun");
    });

    it("lark 事件 → isWecom=false（plugin 跳过）", () => {
      const env = {
        envEvent: { type: "event-source.event.lark-cli", metadata: {} },
        sourceId: "es-lark-1",
        userId: "ou_test",
        replyChannel: { type: "lark-cli", chatId: "oc_123" },
      };
      const fields = extractWecomFields(env as any);
      expect(fields.isWecom).toBe(false);
    });

    it("CLI 事件（无 wecom replyChannel）→ isWecom=false", () => {
      const env = {
        envEvent: { type: "event-source.event.cli-command", metadata: {} },
        sourceId: "es-cli-1",
        userId: "",
      };
      const fields = extractWecomFields(env as any);
      expect(fields.isWecom).toBe(false);
    });
  });

  // ========================================================================
  // 3. 卡片渲染（markdown）
  // ========================================================================
  describe("buildWecomTaskCard（markdown 渲染）", () => {
    it("创建卡片：含标题/状态/任务 ID，无 JSON 原文", () => {
      const md = buildWecomTaskCard({
        task: makeTask({ id: 42, title: "时空增强任务" }),
        statusLabel: "🚀 进行中",
        milestones: [
          { title: "Task 创建", timestamp: "2026-06-01T00:00:00Z" },
        ],
      });
      expect(md).toContain("Task #42");
      expect(md).toContain("时空增强任务");
      expect(md).toContain("进行中");
      expect(md).not.toContain('{"');
    });

    it("更新卡片：含时间线条目", () => {
      const md = buildWecomTaskCard({
        task: makeTask(),
        statusLabel: "🔄 进行中",
        milestones: [
          { title: "Task 创建", timestamp: "2026-06-01T00:00:00Z" },
          {
            title: "完成需求分析",
            timestamp: "2026-06-01T02:00:00Z",
            description: "已完成核心功能的需求拆解",
          },
        ],
      });
      expect(md).toContain("完成需求分析");
      expect(md).toContain("已完成核心功能的需求拆解");
    });

    it("终态卡片：含完成标记", () => {
      const md = buildWecomTaskCard({
        task: makeTask({ status: "completed" }),
        statusLabel: "🎉 已完成",
        milestones: [],
      });
      expect(md).toContain("已完成");
    });
  });

  // ========================================================================
  // 4. 任务创建 → 发初始卡片
  // ========================================================================
  describe("task:after.create → 发初始 markdown 卡片", () => {
    it("wecom 事件上下文中创建任务 → sender 被调用一次", async () => {
      const { hook, calls } = makeHook();
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_CREATE, {
            task: makeTask({ id: 7 }),
          } as unknown as TaskCreateResultContext)
        );
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].chatId).toBe("DongZhaoKun");
      expect(calls[0].content).toContain("Task #7");
    });

    it("非 wecom 事件（lark）→ 不发送", async () => {
      const { hook, calls } = makeHook();
      await runWithEnvContext(
        makeWecomEnvContext({
          envEvent: { type: "event-source.event.lark-cli", metadata: {} },
          replyChannel: { type: "lark-cli", chatId: "oc_1" } as any,
        }),
        async () => {
          await hook.execute(
            makeHookContext(TaskHookPoints.AFTER_CREATE, {
              task: makeTask(),
            } as unknown as TaskCreateResultContext)
          );
        }
      );
      expect(calls).toHaveLength(0);
    });

    it("发送失败 → 不抛错（下次 update 重试）", async () => {
      const { hook, calls } = makeHook({
        sender: {
          send: mock(async (input: { chatId: string; content: string }) => {
            calls.push({ ...input });
            return { ok: false as const, error: "cli down" };
          }),
        } as any,
      });
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_CREATE, {
            task: makeTask(),
          } as unknown as TaskCreateResultContext)
        );
      });
      // 不抛错即通过（失败被吞掉，记录 warn）；调用确实发生了
      expect(calls).toHaveLength(1);
    });
  });

  // ========================================================================
  // 5. 任务更新 → 发更新卡片（节流）
  // ========================================================================
  describe("task:after.update → 更新卡片", () => {
    it("已有卡片 → 单卡语义不发新卡（时间线落库，Task #5255）", async () => {
      const { hook, calls, store } = makeHook();
      // 先创建
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_CREATE, {
            task: makeTask({ id: 9 }),
          } as unknown as TaskCreateResultContext)
        );
      });
      calls.length = 0;
      // 再更新 → 单卡语义：不发新卡
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_UPDATE, {
            task: makeTask({ id: 9, progress: 80, current_status: "写测试中" }),
            changes: { progress: 80 },
          } as unknown as TaskUpdateResultContext)
        );
      });
      expect(calls).toHaveLength(0);
      // 记录保持 open（终态卡仍可发）
      expect(store.get(9)!.status).toBe("open");
    });

    it("无变更（changes 空）→ 不发送", async () => {
      const { hook, calls } = makeHook();
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_CREATE, {
            task: makeTask({ id: 10 }),
          } as unknown as TaskCreateResultContext)
        );
      });
      calls.length = 0;
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_UPDATE, {
            task: makeTask({ id: 10 }),
            changes: {},
          } as unknown as TaskUpdateResultContext)
        );
      });
      expect(calls).toHaveLength(0);
    });

    it("终态 status=completed → 发完成卡片", async () => {
      const { hook, calls } = makeHook();
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_CREATE, {
            task: makeTask({ id: 11 }),
          } as unknown as TaskCreateResultContext)
        );
      });
      calls.length = 0;
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_UPDATE, {
            task: makeTask({ id: 11, status: "completed" }),
            changes: { status: "completed" },
          } as unknown as TaskUpdateResultContext)
        );
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].content).toContain("已完成");
    });

    it("to_validate（待验证）→ 不当终态，普通更新", async () => {
      const { hook, calls } = makeHook();
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_CREATE, {
            task: makeTask({ id: 12 }),
          } as unknown as TaskCreateResultContext)
        );
      });
      calls.length = 0;
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_UPDATE, {
            task: makeTask({ id: 12, status: "to_validate" }),
            changes: { status: "to_validate" },
          } as unknown as TaskUpdateResultContext)
        );
      });
      // 单卡语义（Task #5255）：to_validate 非终态 → 不发新卡
      expect(calls).toHaveLength(0);
    });
  });

  // ========================================================================
  // 6. 操作记录 → 时间线追加 + 节流
  // ========================================================================
  describe("task:operation:after.create → 时间线追加", () => {
    it("有卡片 → 追加里程碑（单卡语义：不发新卡，时间线落库）", async () => {
      const { hook, calls, store } = makeHook({ operationThrottleMs: 0 });
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_CREATE, {
            task: makeTask({ id: 13 }),
          } as unknown as TaskCreateResultContext)
        );
      });
      calls.length = 0;
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.OPERATION_AFTER_CREATE, {
            operation: makeOperation({ taskId: 13 }),
          } as unknown as TaskOperationCreateResultContext)
        );
      });
      // 单卡语义（Task #5255）：operation 不发新卡
      expect(calls).toHaveLength(0);
      // 时间线已持久化
      const rec = store.get(13);
      expect(rec).toBeDefined();
      expect(rec!.timeline).toContain("完成需求分析");
    });

    it("节流窗口内 → 不发送（时间线仍累积）", async () => {
      const { hook, calls, store } = makeHook({ operationThrottleMs: 60_000 });
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_CREATE, {
            task: makeTask({ id: 14 }),
          } as unknown as TaskCreateResultContext)
        );
      });
      calls.length = 0;
      // 第 1 条 operation：单卡语义不发新卡（时间线落库）
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.OPERATION_AFTER_CREATE, {
            operation: makeOperation({ taskId: 14, id: 200 }),
          } as unknown as TaskOperationCreateResultContext)
        );
      });
      expect(calls).toHaveLength(0);
      // 第 2 条 operation：同样不发新卡
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.OPERATION_AFTER_CREATE, {
            operation: makeOperation({ taskId: 14, id: 201 }),
          } as unknown as TaskOperationCreateResultContext)
        );
      });
      // 不发送
      expect(calls).toHaveLength(0);
      // 时间线累积（数据不丢）
      const rec = store.get(14);
      expect(rec!.timeline).toContain("完成需求分析");
    });

    it("无卡片（从未创建）→ 不凭空发卡", async () => {
      const { hook, calls } = makeHook();
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.OPERATION_AFTER_CREATE, {
            operation: makeOperation({ taskId: 999 }),
          } as unknown as TaskOperationCreateResultContext)
        );
      });
      expect(calls).toHaveLength(0);
    });
  });

  // ========================================================================
  // 7. 任务完成 → 终态卡片
  // ========================================================================
  describe("task:after.complete → 终态卡片", () => {
    it("completed → 发完成消息", async () => {
      const { hook, calls } = makeHook();
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_CREATE, {
            task: makeTask({ id: 15 }),
          } as unknown as TaskCreateResultContext)
        );
      });
      calls.length = 0;
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_COMPLETE, {
            task: makeTask({ id: 15, status: "completed" }),
            terminalStatus: "completed",
          } as any)
        );
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].content).toContain("已完成");
    });

    it("to_validate → 跳过（不是验收完成）", async () => {
      const { hook, calls } = makeHook();
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_CREATE, {
            task: makeTask({ id: 16 }),
          } as unknown as TaskCreateResultContext)
        );
      });
      calls.length = 0;
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_COMPLETE, {
            task: makeTask({ id: 16, status: "to_validate" }),
            terminalStatus: "to_validate",
          } as any)
        );
      });
      expect(calls).toHaveLength(0);
    });

    it("无卡片 → 不发（幂等 skip）", async () => {
      const { hook, calls } = makeHook();
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_COMPLETE, {
            task: makeTask({ id: 777, status: "completed" }),
            terminalStatus: "completed",
          } as any)
        );
      });
      expect(calls).toHaveLength(0);
    });
  });

  // ========================================================================
  // 8. 任务删除 → 收尾
  // ========================================================================
  describe("task:after.delete → 收尾", () => {
    it("deleted=true → 发取消消息 + store 标 closed", async () => {
      const { hook, calls, store } = makeHook();
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_CREATE, {
            task: makeTask({ id: 17 }),
          } as unknown as TaskCreateResultContext)
        );
      });
      calls.length = 0;
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_DELETE, {
            id: 17,
            deleted: true,
          } as unknown as TaskDeleteResultContext)
        );
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].content).toContain("已取消");
      const rec = store.get(17);
      expect(rec!.status).toBe("closed");
    });

    it("deleted=false → 什么都不做", async () => {
      const { hook, calls } = makeHook();
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_DELETE, {
            id: 18,
            deleted: false,
          } as unknown as TaskDeleteResultContext)
        );
      });
      expect(calls).toHaveLength(0);
    });

    it("无卡片记录 → 幂等 skip（不发新卡）", async () => {
      const { hook, calls } = makeHook();
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_DELETE, {
            id: 888,
            deleted: true,
          } as unknown as TaskDeleteResultContext)
        );
      });
      expect(calls).toHaveLength(0);
    });
  });

  // ========================================================================
  // 9. state store 持久化
  // ========================================================================
  describe("wecom-card-state-store", () => {
    it("create → upsert open 记录", async () => {
      const { hook, store } = makeHook();
      await runWithEnvContext(makeWecomEnvContext(), async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_CREATE, {
            task: makeTask({ id: 20 }),
          } as unknown as TaskCreateResultContext)
        );
      });
      const rec = store.get(20);
      expect(rec).toBeDefined();
      expect(rec!.status).toBe("open");
      expect(rec!.chatId).toBe("DongZhaoKun");
    });

    it("memory store upsert/get/delete 幂等", () => {
      const store = createMemoryWecomCardStore();
      store.upsert({
        taskId: 1,
        chatId: "u1",
        pinned: false,
        status: "open",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      expect(store.get(1)?.chatId).toBe("u1");
      store.markClosed(1);
      expect(store.get(1)?.status).toBe("closed");
      store.delete(1);
      expect(store.get(1)).toBeUndefined();
    });
  });

  // ========================================================================
  // 10. pluginEnabled 守卫
  // ========================================================================
  describe("pluginEnabled 守卫", () => {
    it("pluginEnabled 未启用 → skip", async () => {
      const { hook, calls } = makeHook();
      const env = makeWecomEnvContext();
      env.pluginEnabled = { "es-wecom-1:WecomTaskNotifyPlugin": false };
      await runWithEnvContext(env, async () => {
        await hook.execute(
          makeHookContext(TaskHookPoints.AFTER_CREATE, {
            task: makeTask(),
          } as unknown as TaskCreateResultContext)
        );
      });
      expect(calls).toHaveLength(0);
    });
  });
});

// ============================================================================
// 工厂函数
// ============================================================================

describe("createWecomTaskNotifyHook", () => {
  it("returns WecomTaskNotifyHook instance", () => {
    const hook = createWecomTaskNotifyHook({});
    expect(hook).toBeInstanceOf(WecomTaskNotifyHook);
  });
});
