/**
 * @fileoverview Task #5270 — 企微群聊卡 chat_type 修复
 *
 * ## 生产故障（2026-11-10，#5265 trace 取证 #41213）
 *
 * deliverTemplateCard 的 chatType 判定两个条件恒 false：
 * 1. `env.replyChannel?.chatType` —— ReplyChannel 顶层**没有**
 *    chatType 字段（chatType 在 `replyChannel.params.chatType`，
 *    wecom-cli-handler.ts buildWecomReplyChannel 塞入）
 * 2. `fields.chatId !== input.chatId` —— 两者取自同一来源，恒相等
 *
 * ⇒ chatType 恒为 "single" → chat_type=1 → 群 chatid（wr 前缀）
 *   + chat_type=1 不匹配 → 企微静默丢弃（sendCmd 不等 ack，
 *   本地记 ok=true，但群里看不到卡）。
 *
 * ## 修复
 *
 * chatType 改读 `env.replyChannel?.params?.chatType`：
 * 群聊（"group"）→ chat_type=2；单聊/缺省 → chat_type=1。
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  WecomTaskNotifyHook,
  type WecomTaskNotifyConfig,
} from "./wecom-task-notify-plugin";
import { TaskHookPoints } from "../hooks/task-hook-points";
import type { HookContext } from "../../hook/types";
import type { TaskCreateResultContext } from "../hooks/contexts";
import { runWithEnvContext, type EnvContext } from "../../context";
import { createMemoryWecomCardStore } from "./wecom-card-state-store";
import {
  registerWecomRespondTarget,
  __resetWecomRespondRegistryForTest,
} from "../../event-source/wecom-respond-registry";

// ============================================================================
// 测试辅助（与 wecom-card-sourceid-5260.test.ts 同款）
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

/** 群聊链路 envContext：replyChannel.params.chatType="group" */
function makeGroupEnvContext(
  overrides: Partial<EnvContext> = {}
): EnvContext {
  return {
    envEvent: {
      type: "event-source.event.wecom-cli",
      metadata: { chatId: "wr26OgBgAAQiflsvQ0UV3GQQILqfvt6Q" },
    },
    userId: "DongZhaoKun",
    replyChannel: {
      type: "wecom-cli",
      chatId: "wr26OgBgAAQiflsvQ0UV3GQQILqfvt6Q",
      params: { chatType: "group" },
    },
    pluginEnabled: { "wecom-bot-2:WecomTaskNotifyPlugin": true },
    ...overrides,
  } as EnvContext;
}

/** 单聊链路 envContext：replyChannel.params.chatType="single" */
function makeSingleEnvContext(
  overrides: Partial<EnvContext> = {}
): EnvContext {
  return {
    envEvent: {
      type: "event-source.event.wecom-cli",
      metadata: { chatId: "DongZhaoKun" },
    },
    userId: "DongZhaoKun",
    replyChannel: {
      type: "wecom-cli",
      chatId: "DongZhaoKun",
      params: { chatType: "single", userId: "DongZhaoKun" },
    },
    pluginEnabled: { "wecom-bot-2:WecomTaskNotifyPlugin": true },
    ...overrides,
  } as EnvContext;
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
    sourceId: "wecom-bot-2",
    pluginName: "WecomTaskNotifyPlugin",
    ...overrides,
  });
  return { hook, calls, store };
}

/** 注册 spy target，捕获 sendCmd 的 body（含 chat_type） */
function registerSpyTarget(
  sourceId: string,
  sentFrames: Array<{ cmd: string; chatid: string; chatType: unknown }>,
): void {
  registerWecomRespondTarget(sourceId, {
    respond: () => undefined,
    sendCmd: (cmd, body) => {
      sentFrames.push({
        cmd,
        chatid: String(body.chatid ?? ""),
        chatType: body.chat_type,
      });
      return undefined;
    },
  });
}

beforeEach(() => {
  __resetWecomRespondRegistryForTest();
});

afterEach(() => {
  __resetWecomRespondRegistryForTest();
});

// ============================================================================
// Task #5270 — chatType 判定修复（群聊卡 chat_type=2）
// ============================================================================

describe("Task #5270 — deliverTemplateCard chatType 读 params.chatType", () => {
  it("RED→GREEN：群聊（params.chatType=group）→ WS 帧 chat_type=2", async () => {
    const sentFrames: Array<{
      cmd: string;
      chatid: string;
      chatType: unknown;
    }> = [];
    registerSpyTarget("wecom-bot-2", sentFrames);
    const { hook } = makeHook();

    await runWithEnvContext(makeGroupEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_CREATE, {
          task: makeTask({ id: 52701 }),
        } as unknown as TaskCreateResultContext)
      );
    });

    // 模板卡经 WS 直发（非 markdown 回落）
    expect(sentFrames.length).toBe(1);
    expect(sentFrames[0]!.cmd).toBe("aibot_send_msg");
    expect(sentFrames[0]!.chatid).toBe(
      "wr26OgBgAAQiflsvQ0UV3GQQILqfvt6Q"
    );
    // ★ 关键断言：群聊 chat_type=2（修复前恒为 1 → 企微丢弃）
    expect(sentFrames[0]!.chatType).toBe(2);
  });

  it("单聊（params.chatType=single）→ WS 帧 chat_type=1", async () => {
    const sentFrames: Array<{
      cmd: string;
      chatid: string;
      chatType: unknown;
    }> = [];
    registerSpyTarget("wecom-bot-2", sentFrames);
    const { hook } = makeHook();

    await runWithEnvContext(makeSingleEnvContext(), async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_CREATE, {
          task: makeTask({ id: 52702 }),
        } as unknown as TaskCreateResultContext)
      );
    });

    expect(sentFrames.length).toBe(1);
    expect(sentFrames[0]!.chatid).toBe("DongZhaoKun");
    expect(sentFrames[0]!.chatType).toBe(1);
  });

  it("回归保护：params 缺 chatType → 回落 single（chat_type=1）", async () => {
    const sentFrames: Array<{
      cmd: string;
      chatid: string;
      chatType: unknown;
    }> = [];
    registerSpyTarget("wecom-bot-2", sentFrames);
    const { hook } = makeHook();

    const env = makeSingleEnvContext();
    (env.replyChannel as any).params = { userId: "DongZhaoKun" };

    await runWithEnvContext(env, async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_CREATE, {
          task: makeTask({ id: 52703 }),
        } as unknown as TaskCreateResultContext)
      );
    });

    expect(sentFrames.length).toBe(1);
    expect(sentFrames[0]!.chatType).toBe(1);
  });
});
