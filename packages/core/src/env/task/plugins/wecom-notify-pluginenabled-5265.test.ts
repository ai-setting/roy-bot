/**
 * @fileoverview Task #5265 — 集成测试：通知轮合成 envEvent 自带 pluginEnabled
 * → WecomTaskNotifyPlugin 守卫放行 → 发卡。
 *
 * 生产故障（2026-11-10 12:45）：task.background.completed 通知轮的
 * 合成 envEvent pluginEnabled={} → 插件守卫（key=wecom-bot-2:
 * WecomTaskNotifyPlugin）不通过 → return 不发卡（纯文本）。
 *
 * 本测试复刻通知轮 EnvContext 形态（pluginEnabled 来自合成事件
 * metadata），断言插件在快照注入后能正常发卡。
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
): HookContext<T> {
  return {
    component: { name: "task", version: "1.0.0" },
    data,
    metadata: {},
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
    sourceId: "wecom-bot-2",
    pluginName: "WecomTaskNotifyPlugin",
    ...overrides,
  });
  return { hook, calls, store };
}

describe("Task #5265 — 通知轮 pluginEnabled 快照注入后插件放行", () => {
  beforeEach(() => {
    __resetWecomRespondRegistryForTest();
  });

  afterEach(() => {
    __resetWecomRespondRegistryForTest();
  });

  it("修复前形态（pluginEnabled={}）→ 守卫拦截不发卡（回归保护）", async () => {
    const sentFrames: Array<{ cmd: string; chatid: string }> = [];
    registerWecomRespondTarget("wecom-bot-2", {
      respond: () => undefined,
      sendCmd: (cmd, body) => {
        sentFrames.push({ cmd, chatid: String(body.chatid ?? "") });
        return undefined;
      },
    });
    const { hook, calls } = makeHook();

    // 通知轮 EnvContext：pluginEnabled 为空对象（生产故障形态）
    const env = {
      envEvent: {
        type: "task.background.completed",
        metadata: { replyChannel: { type: "wecom-cli", chatId: "wr26Og" } },
      },
      replyChannel: { type: "wecom-cli", chatId: "wr26Og" },
      pluginEnabled: {},
    } as unknown as EnvContext;

    await runWithEnvContext(env, async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_CREATE, {
          task: makeTask({ id: 62702 }),
        } as unknown as TaskCreateResultContext),
      );
    });

    expect(sentFrames).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("修复后形态（pluginEnabled 有 key）→ 守卫放行发卡", async () => {
    const sentFrames: Array<{ cmd: string; chatid: string }> = [];
    registerWecomRespondTarget("wecom-bot-2", {
      respond: () => undefined,
      sendCmd: (cmd, body) => {
        sentFrames.push({ cmd, chatid: String(body.chatid ?? "") });
        return undefined;
      },
    });
    const { hook, calls } = makeHook();

    // 修复后通知轮 EnvContext：publishBackgroundEvent 注入
    // metadata.pluginEnabled → dispatcher 重建 → EnvContext 有 key
    const env = {
      envEvent: {
        type: "task.background.completed",
        metadata: {
          pluginEnabled: { "wecom-bot-2:WecomTaskNotifyPlugin": true },
          replyChannel: { type: "wecom-cli", chatId: "wr26Og" },
        },
      },
      replyChannel: { type: "wecom-cli", chatId: "wr26Og" },
      pluginEnabled: { "wecom-bot-2:WecomTaskNotifyPlugin": true },
    } as unknown as EnvContext;

    await runWithEnvContext(env, async () => {
      await hook.execute(
        makeHookContext(TaskHookPoints.AFTER_CREATE, {
          task: makeTask({ id: 62703 }),
        } as unknown as TaskCreateResultContext),
      );
    });

    expect(sentFrames).toHaveLength(1);
    expect(sentFrames[0]!.cmd).toBe("aibot_send_msg");
    expect(sentFrames[0]!.chatid).toBe("wr26Og");
    expect(calls).toHaveLength(0); // 不回落 markdown
  });
});
