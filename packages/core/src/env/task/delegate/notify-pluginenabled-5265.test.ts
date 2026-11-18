/**
 * @fileoverview Task #5265 — 合成 envEvent（task.background.*）补 pluginEnabled 快照
 *
 * ## 生产故障（2026-11-10 12:45）
 *
 * 后台任务完成通知链路（task.background.completed → 通知会话）的
 * 合成 envEvent **pluginEnabled={}（空）** →
 * WecomTaskNotifyPlugin.execute 的 pluginEnabled 守卫
 * （key=wecom-bot-2:WecomTaskNotifyPlugin）不通过 → 插件直接 return
 * 不发卡（用户只看到纯文本）。
 *
 * 主会话（事件轮直发）pluginEnabled 有 key（event-source-handlers
 * L2193 构建）→ 有卡。chatId/replyChannel 均正确。
 *
 * ## 修复
 *
 * 1. `capturePluginEnabledSnapshot()`：delegate 时刻从 ALS EnvContext
 *    快照 pluginEnabled（与 captureReplyChannelSnapshot 同款模式）。
 * 2. `BackgroundTask.pluginEnabledSnapshot` 字段：随 task 存快照。
 * 3. `publishBackgroundEvent`：把快照写进 event.metadata.pluginEnabled，
 *    让通知轮的合成 envEvent 自带 pluginEnabled → dispatcher /
 *    buildRunEnvContext 透传 → 插件守卫放行。
 */

import { describe, expect, test } from "bun:test";

import {
  BackgroundTaskManager,
  capturePluginEnabledSnapshot,
} from "./delegate-tool";
import { runWithEnvContext } from "../../context";

// ============================================================================
// Mock env（与 notify-cross-chat-routing.test.ts 同款）
// ============================================================================

interface CapturedEvent {
  type: string;
  payload: unknown;
  metadata: Record<string, unknown>;
}

function makeMockEnv() {
  const events: CapturedEvent[] = [];
  return {
    events,
    pushEnvEvent: (input: {
      type: string;
      payload?: unknown;
      metadata?: Record<string, unknown>;
    }) => {
      events.push({
        type: input.type,
        payload: input.payload,
        metadata: input.metadata ?? {},
      });
    },
    getComponent: (name: string) => {
      if (name === "session") {
        return {
          create: async (opts: any) => ({
            id: `sub_${Math.random().toString(36).slice(2, 10)}`,
            info: { metadata: { ...(opts.metadata ?? {}) } },
          }),
          get: async () => null,
          update: async () => {},
        };
      }
      return null;
    },
  };
}

// ============================================================================
// 1. capturePluginEnabledSnapshot
// ============================================================================

describe("capturePluginEnabledSnapshot（Task #5265）", () => {
  test("ALS EnvContext 有 pluginEnabled → 原样快照", () => {
    const snap = runWithEnvContext(
      {
        envEvent: {},
        pluginEnabled: { "wecom-bot-2:WecomTaskNotifyPlugin": true },
      } as any,
      () => capturePluginEnabledSnapshot(),
    );
    expect(snap).toEqual({
      "wecom-bot-2:WecomTaskNotifyPlugin": true,
    });
  });

  test("无 EnvContext / 无 pluginEnabled → undefined（向后兼容）", () => {
    expect(
      runWithEnvContext(undefined, () => capturePluginEnabledSnapshot()),
    ).toBeUndefined();
    const empty = runWithEnvContext(
      { envEvent: {} } as any,
      () => capturePluginEnabledSnapshot(),
    );
    expect(empty).toBeUndefined();
  });

  // ★ DS review MINOR-1：空对象分支（keys.length===0）此前未被执行
  test("pluginEnabled 为空对象 {} → undefined（向后兼容）", () => {
    const emptyObj = runWithEnvContext(
      { envEvent: {}, pluginEnabled: {} } as any,
      () => capturePluginEnabledSnapshot(),
    );
    expect(emptyObj).toBeUndefined();
  });

  // ★ DS review MINOR-2：浅拷贝引用隔离 —— 快照后改原对象不影响快照
  test("浅拷贝：快照与原 pluginEnabled 不同引用，互不影响", () => {
    const pluginEnabled = { "wecom-bot-2:WecomTaskNotifyPlugin": true };
    const snap = runWithEnvContext(
      { envEvent: {}, pluginEnabled } as any,
      () => capturePluginEnabledSnapshot(),
    );
    expect(snap).toEqual(pluginEnabled);
    expect(snap).not.toBe(pluginEnabled); // 必须是拷贝，不是同引用
    // 快照后修改原对象 → 快照不受影响
    pluginEnabled["wecom-bot-2:WecomTaskNotifyPlugin"] = false;
    expect(snap!["wecom-bot-2:WecomTaskNotifyPlugin"]).toBe(true);
  });
});

// ============================================================================
// 2. publishBackgroundEvent 透传 pluginEnabled
// ============================================================================

describe("publishBackgroundEvent pluginEnabled 透传（Task #5265）", () => {
  test("pluginEnabledSnapshot 写进 event.metadata.pluginEnabled", () => {
    const env = makeMockEnv();
    const mgr = new BackgroundTaskManager(env as any);
    mgr.publishBackgroundEventWithTrigger(
      "task.background.completed",
      {
        backgroundTaskId: "bg",
        subSessionId: "sub",
        parentSessionId: "p",
        description: "d",
        result: "r",
      },
      "p_5265",
      "evt_5265",
      { type: "wecom-cli", chatId: "wr26Og_group" },
      // ★ 新参数：pluginEnabled 快照（delegate 时刻捕获）
      { "wecom-bot-2:WecomTaskNotifyPlugin": true },
    );
    expect(env.events.length).toBe(1);
    expect(env.events[0]!.metadata.pluginEnabled).toEqual({
      "wecom-bot-2:WecomTaskNotifyPlugin": true,
    });
    // replyChannel 仍正常透传（不回归 #4042）
    expect(env.events[0]!.metadata.replyChannel).toEqual({
      type: "wecom-cli",
      chatId: "wr26Og_group",
    });
  });

  test("不传快照时 metadata 不含 pluginEnabled（向后兼容）", () => {
    const env = makeMockEnv();
    const mgr = new BackgroundTaskManager(env as any);
    mgr.publishBackgroundEventWithTrigger(
      "task.background.started",
      {
        backgroundTaskId: "bg",
        subSessionId: "sub",
        parentSessionId: "p",
        description: "d",
        subagentType: "general",
      },
      "p",
      "evt_2",
    );
    expect(env.events[0]!.metadata.pluginEnabled).toBeUndefined();
  });
});
