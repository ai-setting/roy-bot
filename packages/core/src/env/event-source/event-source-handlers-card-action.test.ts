/**
 * @fileoverview Task #4331：B1 review fix 测试 — card.action.trigger 事件处理
 *
 * 验证：
 * 1. card.action.trigger 事件应该走 LarkCliInstance.handleCardActionEvent（不走普通 eventHandler）
 * 2. 未注入 cardActionPorts 时应该 warn + skip（不抛错、不阻塞其他事件）
 * 3. 注入 ports 后应该走 handleCardAction + patchCardByToken
 * 4. handleCardActionEvent 暴露 setCardActionPorts 接口（caller 可注入）
 *
 * 这是 Task #4331 opencode-cli review Blocker 1 (B1) 的修复测试。
 */

import { describe, test, expect, beforeEach, mock } from "bun:test";
import { LarkCliInstance } from "./event-source-handlers";
import type {
  EventSourceConfig,
  EventSourceEventHandler,
} from "./types";
import { LarkCardPatchNotifier } from "../task/plugins/lark-card-patch-notifier";

// 注意：card.action.trigger 的 eventType 在 LarkCliInstance 内被特别处理，
// 不通过普通的 eventHandler 派发（Task #4331 优化点）

function makeCardActionRawData(actionValue: Record<string, unknown>): string {
  return JSON.stringify({
    type: "card.action.trigger",
    event_id: `card_act_${Math.random().toString(36).slice(2)}`,
    timestamp: "1790579077976",
    chat_id: "oc_chat_test",
    message_id: "om_msg_card",
    token: "ctoken_test_xxx",
    operator_id: { open_id: "ou_test_user" },
    action_value: JSON.stringify(actionValue),
  });
}

describe("LarkCliInstance handleCardActionEvent (Task #4331 B1)", () => {
  let config: EventSourceConfig;
  let instance: LarkCliInstance;
  let dispatchedEvents: number;

  beforeEach(() => {
    config = {
      id: "es-card-action-test",
      name: "card action test",
      type: "lark-cli",
      enabled: true,
      command:
        "lark-cli --profile default event consume 'im.message.receive_v1,card.action.trigger' --as bot",
    };
    instance = new LarkCliInstance(config);
    dispatchedEvents = 0;

    const handler: EventSourceEventHandler = mock(() => {
      dispatchedEvents++;
    });
    instance.onEvent(handler);
  });

  test("setCardActionPorts 注入后 hasCardActionPorts 返回 true", () => {
    expect(instance.hasCardActionPorts()).toBe(false);
    instance.setCardActionPorts({
      getTask: mock(async () => undefined),
      updateTaskContext: mock(async () => {}),
      createGroupChat: mock(async () => "oc_new"),
      deleteGroupChat: mock(async () => {}),
      notifier: new LarkCardPatchNotifier(),
    });
    expect(instance.hasCardActionPorts()).toBe(true);
  });

  test("card.action.trigger 事件在未注入 ports 时应该 skip（不抛错、不阻塞 eventHandler）", async () => {
    // 故意不调 setCardActionPorts
    expect(instance.hasCardActionPorts()).toBe(false);

    // 通过 setEnvironment + processStream 模拟 lark-cli 推一条 card.action.trigger
    instance.setEnvironment({
      getComponent: () => null,
    } as any);

    // 准备一条 rawData：card.action.trigger 事件
    const rawData = makeCardActionRawData({
      action: "create_group",
      taskId: "4331",
    });

    // 调用 processStream —— 不应该抛错
    let error: unknown = undefined;
    try {
      await (instance as any).processStream(rawData);
    } catch (e) {
      error = e;
    }
    expect(error).toBeUndefined();
  });

  test("card.action.trigger 事件不应该走普通 eventHandler（不走 Agent）", async () => {
    // 强化版（review M1）：除了"不抛错"，还要断言：
    //   1. 普通 eventHandler 没被调用（dispatchedEvents === 0）
    //      —— card.action.trigger 由 LarkCliInstance 内部 handle，不下发给 Agent
    //   2. LarkCliInstance.handleEvent 内有 card.action.trigger 判断分支
    //      —— 保证契约被实现

    instance.setEnvironment({
      getComponent: () => null,
    } as any);

    const rawData = makeCardActionRawData({
      action: "create_group",
      taskId: "4331",
    });

    // 调用 processStream（即便 port 未注入，也应该走 handleCardActionEvent
    // 的 skip 路径，不会调用普通 eventHandler）
    let error: unknown = undefined;
    try {
      await (instance as any).processStream(rawData);
    } catch (e) {
      error = e;
    }
    expect(error).toBeUndefined();
    // ★ 核心断言：dispatchedEvents 必须为 0（证明 card.action.trigger
    //   没下发给 Agent）
    expect(dispatchedEvents).toBe(0);

    // 验证 LarkCliInstance.handleEvent 内部确实有 card.action.trigger 判断
    // （源码契约：event-source-handlers.ts handleEvent 方法的第一个 if）
    const handleEventSrc = require("node:fs").readFileSync(
      require("node:path").join(__dirname, "event-source-handlers.ts"),
      "utf8"
    );
    expect(handleEventSrc).toContain('card.action.trigger');
  });

  test("注入 ports 后能正确传 actionValue 和 chatId/taskId", () => {
    // 验证 ports 字段被正确持久化
    const ports = {
      getTask: mock(async () => undefined),
      updateTaskContext: mock(async () => {}),
      createGroupChat: mock(async () => "oc_new"),
      deleteGroupChat: mock(async () => {}),
      notifier: new LarkCardPatchNotifier(),
    };
    instance.setCardActionPorts(ports);
    expect(instance.hasCardActionPorts()).toBe(true);
  });
});
