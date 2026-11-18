/**
 * Task #4042 ESPlugin v2 — P0 production-path verification.
 *
 * 复现 prior review 的 P0：
 *   `triggerEventId` 在生产链路里从未产生（0 non-test callers of emitTriggerEvent /
 *   DelegateToolParameters 无 triggerEventId 字段 / createTask 未透传）→ v2 分支
 *   unreachable → #4035 未在生产修复。
 *
 * 本测试走真实 tool.execute 路径，锁定修复：
 *   1. DelegateToolParameters 接受 triggerEventId（LLM/agent 可透传）
 *   2. execute 从共享 EventStore 校验 triggerEventId 是否存在
 *   3. 校验通过 → createTask → publishBackgroundEvent → task.background.started
 *      event.metadata.triggerEventId === 传入值
 *   4. 校验失败（store 里查不到）→ execute 直接拒绝，不创建 task
 *   5. 不传 triggerEventId → event metadata 不含该字段（向后兼容）
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BackgroundTaskManager,
  createDelegateTool,
  DelegateToolParameters,
} from "./delegate-tool";
import {
  EventStoreImpl,
  setSharedEventStore,
  resetSharedEventStore,
} from "../../event-source/event-store";
import { runWithEnvContextAsync } from "../../context";

let tmpDir: string;
let store: EventStoreImpl;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "delegate-trigger-prod-"));
  store = new EventStoreImpl({ dbPath: join(tmpDir, "events.db") });
  // 注册为 core 级共享单例（生产里由 cli event-handler-wiring 注册）
  setSharedEventStore(store);
});

afterEach(() => {
  resetSharedEventStore();
  try {
    store.close();
  } catch {
    // ignore
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

interface CapturedEvent {
  type: string;
  payload: unknown;
  metadata: Record<string, unknown>;
}

function makeTaskComponent(captured: CapturedEvent[]) {
  const env = {
    pushEnvEvent: (e: CapturedEvent) => captured.push(e),
    getComponent: (name: string) => {
      if (name === "session") {
        return {
          get: async (id: string) => ({ id, info: { metadata: {} } }),
          create: async (opts: any) => ({
            id: `sub_${Math.random().toString(36).slice(2, 10)}`,
            info: { metadata: { ...(opts.metadata ?? {}) } },
          }),
          update: async () => {},
        };
      }
      return null;
    },
  };
  // 真实 BackgroundTaskManager，但 stub executeTask 避免测试里真的跑 sub-agent
  const mgr = new BackgroundTaskManager(env as any);
  (mgr as any).executeTask = async () => {};

  return {
    env,
    backgroundTaskManager: mgr,
    getTagService: () => ({
      listTags: async () => [],
      findSimilarTasks: async () => [],
    }),
  } as any;
}

const ctx = { session_id: "parent_session_prod" };

describe("P0: triggerEventId production path", () => {
  test("DelegateToolParameters accepts triggerEventId (LLM can supply it)", () => {
    const parsed = DelegateToolParameters.parse({
      description: "调研 deepseek",
      prompt: "调研并汇报",
      subagent_type: "general",
      similar_task_ids: [],
      triggerEventId: "evt_from_es_001",
    });
    expect(parsed.triggerEventId).toBe("evt_from_es_001");
  });

  test("valid triggerEventId → flows into task.background.started metadata", async () => {
    // 1. 生产端 ES 先落库原始 trigger event
    const triggerEventId = await store.insertTriggerEvent(
      {
        senderId: "ou_user",
        metadata: {
          chatId: "oc_trigger_chat",
          messageId: "om_trigger_msg",
          senderId: "ou_user",
        },
      },
      "lark-cli",
    );

    const captured: CapturedEvent[] = [];
    const tool = createDelegateTool(makeTaskComponent(captured));

    // 2. 主 agent 调 delegate_task(prompt, triggerEventId)
    const result = await tool.execute(
      {
        description: "调研 deepseek",
        prompt: "调研并汇报",
        subagent_type: "general",
        similar_task_ids: [],
        triggerEventId,
      } as any,
      ctx as any,
    );

    expect(result.success).toBe(true);
    // 3. 校验通过：STARTED event 携带 triggerEventId
    const started = captured.find((e) => e.type === "task.background.started");
    expect(started).toBeDefined();
    expect(started!.metadata.triggerEventId).toBe(triggerEventId);
  });

  test("unknown triggerEventId → execute rejected, no task created", async () => {
    const captured: CapturedEvent[] = [];
    const tool = createDelegateTool(makeTaskComponent(captured));

    const result = await tool.execute(
      {
        description: "调研",
        prompt: "调研",
        subagent_type: "general",
        similar_task_ids: [],
        triggerEventId: "evt_does_not_exist",
      } as any,
      ctx as any,
    );

    expect(result.success).toBe(false);
    expect(String(result.error)).toContain("Unknown triggerEventId");
    // 没有创建任何 task event
    expect(captured.find((e) => e.type === "task.background.started")).toBeUndefined();
  });

  test("omitted triggerEventId → metadata has no triggerEventId (backward compatible)", async () => {
    const captured: CapturedEvent[] = [];
    const tool = createDelegateTool(makeTaskComponent(captured));

    const result = await tool.execute(
      {
        description: "无 trigger",
        prompt: "no trigger",
        subagent_type: "general",
        similar_task_ids: [],
      } as any,
      ctx as any,
    );

    expect(result.success).toBe(true);
    const started = captured.find((e) => e.type === "task.background.started");
    expect(started).toBeDefined();
    expect(started!.metadata.triggerEventId).toBeUndefined();
  });

  test("★ auto-derive: omitted triggerEventId is derived from EnvContext (v2 production path)", async () => {
    // 生产端 ES 先落库原始 trigger event
    const triggerEventId = await store.insertTriggerEvent(
      {
        senderId: "ou_user",
        metadata: { chatId: "oc_derive_chat", messageId: "om_derive_msg", senderId: "ou_user" },
      },
      "lark-cli",
    );

    const captured: CapturedEvent[] = [];
    const tool = createDelegateTool(makeTaskComponent(captured));

    // 模拟主 agent 处理飞书事件时的 ALS EnvContext（含 triggerEventId，但 LLM 不传参）
    await runWithEnvContextAsync(
      {
        envEvent: {
          metadata: { triggerEventId },
          payload: { triggerEventId },
        },
      } as any,
      async () => {
        const result = await tool.execute(
          {
            description: "调研 deepseek",
            prompt: "调研并汇报",
            subagent_type: "general",
            similar_task_ids: [],
            // ⚠️ 故意不传 triggerEventId
          } as any,
          ctx as any,
        );
        expect(result.success).toBe(true);
      },
    );

    const started = captured.find((e) => e.type === "task.background.started");
    expect(started).toBeDefined();
    expect(started!.metadata.triggerEventId).toBe(triggerEventId);
  });

  test("★ replyChannel snapshot: delegate 时刻的 EnvContext.replyChannel 冻结进 STARTED metadata", async () => {
    const captured: CapturedEvent[] = [];
    const tool = createDelegateTool(makeTaskComponent(captured));

    await runWithEnvContextAsync(
      {
        envEvent: {},
        replyChannel: {
          type: "lark-cli",
          appId: "cli_tongzhuli",
          chatId: "oc_3996",
          messageId: "om_trigger",
          userId: "ou_user",
          profile: "tongzhuli",
          params: { thread_id: "th_1" },
        },
      } as any,
      async () => {
        const result = await tool.execute(
          {
            description: "调研",
            prompt: "调研",
            subagent_type: "general",
            similar_task_ids: [],
          } as any,
          ctx as any,
        );
        expect(result.success).toBe(true);
      },
    );

    const started = captured.find((e) => e.type === "task.background.started");
    expect(started).toBeDefined();
    expect(started!.metadata.replyChannel).toEqual({
      type: "lark-cli",
      appId: "cli_tongzhuli",
      chatId: "oc_3996",
      messageId: "om_trigger",
      profile: "tongzhuli",
      params: { thread_id: "th_1", userId: "ou_user" },
    });
  });
});
