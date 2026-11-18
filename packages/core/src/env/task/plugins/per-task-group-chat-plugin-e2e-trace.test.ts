/**
 * @fileoverview PerTaskGroupChatPlugin 端到端 trace 测试（卡片语义版, Task #4230）
 *
 * 说明：
 * - 旧实现会在真实飞书建群 + 发纯文本消息（sendToChat / sendToMain）；
 *   Task #4230 删除了纯文本路径，改为"建群后发一张卡片，后续 patch 同一张卡片"。
 * - 因此本测试：
 *   1. mock createGroupChat（不真实建群）
 *   2. mock LarkCardPatchNotifier.startTask/updateTask/finishTask（不真实发卡）
 *   3. 断言仍然存在的 spans，并断言卡片 notifier 被正确调用
 *
 * 验证要点（每个 hook 一条 trace）：
 *   1. execute → onAfterCreate → attachChatIdToTask
 *   2. execute → onAfterUpdate
 *   3. execute → onAfterComplete
 *   4. execute → onAfterOperationCreate
 *
 * ★ 使用独立 SQLite DB（/tmp/opencode），避免与其它 test file 的 trace 串扰。
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import {
  OTelTracerProvider,
  setTracerProvider,
  resetTracerProvider,
} from "../../log-trace/opentelemetry/tracer-provider";
import { SQLiteSpanStorage } from "../../log-trace/span-storage";
import { PerTaskGroupChatPlugin } from "./per-task-group-chat-plugin";
import { LarkCardPatchNotifier } from "./lark-card-patch-notifier";
import { runWithEnvContext } from "../../context";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type {
  TaskCreateResultContext,
  TaskUpdateResultContext,
  TaskCompleteResultContext,
} from "../hooks/contexts";

// ---------------------------------------------------------------------------
// mock 基础设施：避免真实 lark-cli（建群 / 发卡）
// ---------------------------------------------------------------------------

interface CardCall {
  op: "start" | "update" | "finish";
  opts: any;
}

const cardCalls: CardCall[] = [];
const NOTIFIER_PROTO = LarkCardPatchNotifier.prototype as any;
const PLUGIN_PROTO = PerTaskGroupChatPlugin.prototype as any;
const ORIGINALS: any = {};

beforeAll(() => {
  for (const m of ["startTask", "updateTask", "finishTask"] as const) {
    ORIGINALS[`notifier_${m}`] = Object.getOwnPropertyDescriptor(
      LarkCardPatchNotifier.prototype,
      m
    )?.value;
  }
  ORIGINALS.plugin_createGroupChat = Object.getOwnPropertyDescriptor(
    PerTaskGroupChatPlugin.prototype,
    "createGroupChat"
  )?.value;

  NOTIFIER_PROTO.startTask = async (opts: any) => {
    cardCalls.push({ op: "start", opts });
    return { messageId: "om_card_e2e", pinned: true };
  };
  NOTIFIER_PROTO.updateTask = async (opts: any) => {
    cardCalls.push({ op: "update", opts });
  };
  NOTIFIER_PROTO.finishTask = async (opts: any) => {
    cardCalls.push({ op: "finish", opts });
  };
  // 不真实建群
  PLUGIN_PROTO.createGroupChat = async () => "oc_e2e_test_chat";
});

afterAll(() => {
  for (const m of ["startTask", "updateTask", "finishTask"] as const) {
    if (ORIGINALS[`notifier_${m}`] !== undefined) {
      NOTIFIER_PROTO[m] = ORIGINALS[`notifier_${m}`];
    }
  }
  if (ORIGINALS.plugin_createGroupChat !== undefined) {
    PLUGIN_PROTO.createGroupChat = ORIGINALS.plugin_createGroupChat;
  }
  resetTracerProvider();
});

describe("PerTaskGroupChatPlugin 端到端 trace 测试（卡片语义）", () => {
  it("应在建群/更新/完成/操作时记录正确 spans，并 patch 同一张卡片", async () => {
    // 1. 独立 DB（避免与其它 test file 串扰）
    const dbDir = "/tmp/opencode";
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, `roy-e2e-trace-${process.pid}.db`);

    console.log(`\n📁 Spans DB: ${dbPath}\n`);

    // ★ 清除环境里的 TRACEPARENT，否则所有 execute 会挂在同一个父 span 下
    //   （只有一条 trace），无法验证"每个 hook 一条 trace"。
    const savedTraceparent = process.env.TRACEPARENT;
    const savedTraceId = process.env.TRACE_ID;
    delete process.env.TRACEPARENT;
    delete process.env.TRACE_ID;

    try {
      // 2. 初始化 provider
      const provider = new OTelTracerProvider(undefined, dbPath);
      await provider.initialize();
      setTracerProvider(provider);
      // 强制创建 tracer 并清空上下文，确保每个 execute 成为新的根 span
      (provider.getTracer("roy-tracer") as any).setCurrentContext(undefined);

      await runE2EScenario(provider, dbPath);
    } finally {
      resetTracerProvider();
      if (savedTraceparent !== undefined) process.env.TRACEPARENT = savedTraceparent;
      if (savedTraceId !== undefined) process.env.TRACE_ID = savedTraceId;
    }
  }, 30000);
});

// ---------------------------------------------------------------------------
// 场景主体（在干净 trace 上下文里执行）
// ---------------------------------------------------------------------------

async function runE2EScenario(_provider: OTelTracerProvider, dbPath: string): Promise<void> {
  console.log("🚀 PerTaskGroupChatPlugin 端到端 trace 测试（Task #4230 卡片语义）\n");

  // 3. 创建 plugin
  const plugin = new PerTaskGroupChatPlugin({
    pluginName: "PerTaskGroupChatPlugin",
    sourceId: "id_e2e_trace_test",
    autoCreateGroup: true,   // ★ Task #4331：测试显式开启默认建群
  });

  // 4. 注入 taskUpdater（把 chat_id 写进 task.context）
  const taskContextStore = new Map<number, string>();
  (plugin as any).taskUpdater = async (taskId: number, context: string) => {
    taskContextStore.set(taskId, context);
  };

  const taskId = Math.floor(Date.now() / 1000) % 100000;
  const task = {
    id: taskId,
    title: "E2E trace test task",
    context: "{}",
    parent_task_id: 0,
    description: "test task for e2e trace",
    priority: "medium",
    status: "in_progress",
    project_path: "/tmp/test",
  };

  const env = {
    envEvent: { metadata: {} },
    sourceId: "id_e2e_trace_test",
    userId: "ou_test_user",
    replyChannel: {
      type: "lark-cli",
      chatId: "oc_main_chat_e2e",
      messageId: "om_test_msg",
      params: { userId: "ou_b9924f48dc122c3dad0ff4f37851c09b" },
      userId: "ou_b9924f48dc122c3dad0ff4f37851c09b",
      appId: "cli_aXXXXXXXXXXXXXX",
      profile: "default",
    },
    pluginEnabled: { "id_e2e_trace_test:PerTaskGroupChatPlugin": true },
  } as any;

  // [测试 1] AFTER_CREATE → 建群 + 发初始卡片
  const createCtx: HookContext<TaskCreateResultContext> = {
    component: { name: "task", version: "1.0.0" },
    data: { task: task as any, sessionId: "e2e-test", tagService: {} as any },
    metadata: {},
    phase: "after",
    hookPoint: TaskHookPoints.AFTER_CREATE,
  } as any;

  await runWithEnvContext(env, async () => {
    await plugin.execute(createCtx);
  });

  const savedContext = taskContextStore.get(taskId);
  expect(savedContext).toBeDefined();
  const parsed = JSON.parse(savedContext!);
  expect(parsed.larkPerTaskChatId).toBe("oc_e2e_test_chat");
  expect(parsed.larkPerTaskChatProfile).toBe("default");

  // [测试 2] AFTER_UPDATE → patch 同一张卡片
  const updateCtx: HookContext<TaskUpdateResultContext> = {
    component: { name: "task", version: "1.0.0" },
    data: {
      task: { ...task, context: savedContext || "{}" } as any,
      changes: { progress: 50 },
      tagService: {} as any,
    },
    metadata: {},
    phase: "after",
    hookPoint: TaskHookPoints.AFTER_UPDATE,
  } as any;

  await runWithEnvContext(env, async () => {
    await plugin.execute(updateCtx);
  });

  // [测试 3] OPERATION_AFTER_CREATE → patch 同一张卡片（metadata.task 传入）
  const operationCtx: HookContext<any> = {
    component: { name: "task", version: "1.0.0" },
    data: {
      operation: {
        id: 99999,
        taskId,
        sessionId: "e2e-test",
        milestoneType: "progress",
        milestoneTitle: "Step 1 done",
        actionType: "progress",
        actionTitle: "Step 1 done",
        timestamp: new Date().toISOString(),
      },
    },
    metadata: {
      task: { ...task, context: savedContext || "{}" } as any,
    },
    phase: "after",
    hookPoint: TaskHookPoints.OPERATION_AFTER_CREATE,
  } as any;

  await runWithEnvContext(env, async () => {
    await plugin.execute(operationCtx);
  });

  // [测试 4] AFTER_COMPLETE → finish 同一张卡片（放在最后，完成后清理 messageId）
  const completeCtx: HookContext<TaskCompleteResultContext> = {
    component: { name: "task", version: "1.0.0" },
    data: {
      task: { ...task, context: savedContext || "{}" } as any,
      result: { summary: "Task done!" },
      terminalStatus: "completed",
      tagService: {} as any,
    },
    metadata: {},
    phase: "after",
    hookPoint: TaskHookPoints.AFTER_COMPLETE,
  } as any;

  await runWithEnvContext(env, async () => {
    await plugin.execute(completeCtx);
  });

  // 5. 等 spans 落库
  await new Promise((r) => setTimeout(r, 500));

  // 6. ★ Task #4237 契约：卡片全生命周期归 LarkCliTaskNotifyHook ——
  //    本插件只建群 + 绑定 + 持久化 chatId，**不**发/不 patch 卡片
  const cardOps = cardCalls.map((c) => c.op);
  expect(cardOps).toEqual([]);
  // 群与绑定仍是插件职责
  expect(parsed.larkPerTaskChatId).toBe("oc_e2e_test_chat");

  // 7. 验证 spans
  const storage = new SQLiteSpanStorage(dbPath);
  await storage.initialize();

  const allTraces = storage.listTraces(50);
  allTraces.sort((a, b) => b.startTime - a.startTime);

  const collectAllNames = (s: any, acc: Set<string>) => {
    acc.add(s.name);
    for (const c of s.children || []) collectAllNames(c, acc);
  };

  const now = Date.now();
  const e2eTraceIds = new Set<string>();
  for (const t of allTraces) {
    if (now - t.startTime > 60_000) continue;
    const spans = storage.findByTraceId(t.traceId);
    const names = new Set<string>();
    for (const s of spans) collectAllNames(s, names);
    const isHookTrace =
      names.has("per-task-group-chat.onAfterCreate") ||
      names.has("per-task-group-chat.onAfterUpdate") ||
      names.has("per-task-group-chat.onAfterComplete") ||
      names.has("per-task-group-chat.onAfterOperationCreate");
    if (!isHookTrace) continue;
    e2eTraceIds.add(t.traceId);
  }

  expect(e2eTraceIds.size).toBeGreaterThanOrEqual(4);

  let afterCreateFound = false;
  let afterUpdateFound = false;
  let afterCompleteFound = false;
  let afterOperationFound = false;

  for (const traceId of e2eTraceIds) {
    const spans = storage.findByTraceId(traceId);
    const spanNames = new Set<string>();
    for (const s of spans) collectAllNames(s, spanNames);
    const spanNameList = [...spanNames];

    // 每个 hook trace 都必须有 execute 入口 span
    expect(spanNameList).toContain("per-task-group-chat.execute");

    if (spanNameList.includes("per-task-group-chat.onAfterCreate")) {
      afterCreateFound = true;
      // 建群后把 chat_id 写回 task.context
      expect(spanNameList).toContain("per-task-group-chat.attachChatIdToTask");
      // ★ 旧 sendToChat / sendToMain span 已删除
      expect(spanNameList).not.toContain("per-task-group-chat.sendToChat");
      expect(spanNameList).not.toContain("per-task-group-chat.sendToMain");
    }
    if (spanNameList.includes("per-task-group-chat.onAfterUpdate")) {
      afterUpdateFound = true;
      expect(spanNameList).not.toContain("per-task-group-chat.sendToChat");
    }
    if (spanNameList.includes("per-task-group-chat.onAfterComplete")) {
      afterCompleteFound = true;
      expect(spanNameList).not.toContain("per-task-group-chat.sendToChat");
    }
    if (spanNameList.includes("per-task-group-chat.onAfterOperationCreate")) {
      afterOperationFound = true;
      expect(spanNameList).not.toContain("per-task-group-chat.sendToChat");
    }

    console.log(`    traceId: ${traceId} (${spanNameList.length} spans)`);
  }

  storage.close();

  expect(afterCreateFound).toBe(true);
  expect(afterUpdateFound).toBe(true);
  expect(afterCompleteFound).toBe(true);
  expect(afterOperationFound).toBe(true);

  console.log("\n✅ 端到端 trace 测试完成 - spans 正确记录 + 卡片 notifier 调用正确");
}
