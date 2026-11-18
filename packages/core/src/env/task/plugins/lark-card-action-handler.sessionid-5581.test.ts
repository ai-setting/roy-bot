/**
 * Task #5581：task 卡按钮 sessionId 透传（buildTaskMetaFromTask）
 *
 * 背景（0.7.15 冒烟缺陷 B）：MCP 路径建卡时 notifier 反查不可用，
 * meta.sessionId 缺省 ⇒ 「💬 会话查看」按钮 value 只有 taskId ⇒
 * 点击报 `Missing required field: sessionId`。
 *
 * 修复：buildTaskMetaFromTask 透传 task.session_id → meta.sessionId，
 * 让 buildTaskCard 的 sessionIdForButton 拿到值。
 */

import { describe, it, expect } from "bun:test";
import {
  handleCardAction,
  type CardActionEvent,
  type CardActionPorts,
} from "./lark-card-action-handler";

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 5581,
    title: "sessionId 透传测试",
    description: "测试描述",
    goals: "测试目标",
    priority: "high",
    type: "normal",
    project_path: "~/proj",
    parent_task_id: null,
    current_status: "进行中",
    context: "{}",
    ...overrides,
  };
}

function makePorts(task: any): CardActionPorts {
  return {
    getTask: async () => task,
    updateTaskContext: async () => {},
    createGroupChat: async () => "oc_new_group_5581",
    deleteGroupChat: async () => {},
  };
}

function makeEvent(
  action: "create_group" | "disband_group",
): CardActionEvent {
  return {
    actionValue: { action, taskId: 5581, sessionId: "session_event_side" },
    chatId: "oc_trigger_chat",
    messageId: "om_card_5581",
    token: "token_xxx",
  };
}

function buttonsOf(cardUpdate: any): any[] {
  return (cardUpdate.body.elements as any[]).filter((e) => e.tag === "button");
}

describe("lark-card-action-handler / Task #5581 sessionId 透传", () => {
  it("create_group：task 带 session_id ⇒ 重建卡片按钮 value 带 sessionId", async () => {
    const task = makeTask({ session_id: "session_from_task_5581" });
    const r = await handleCardAction(makeEvent("create_group"), makePorts(task));
    expect(r.ok).toBe(true);
    expect(r.cardUpdate).toBeDefined();
    const btns = buttonsOf(r.cardUpdate);
    // 群按钮 + 刷新按钮都要带 sessionId（来自 task.session_id）
    for (const btn of btns) {
      expect(btn.value.sessionId).toBe("session_from_task_5581");
    }
  });

  it("disband_group：task 带 session_id ⇒ 重建卡片按钮 value 带 sessionId", async () => {
    const task = makeTask({
      session_id: "session_from_task_5581",
      context: JSON.stringify({
        larkPerTaskChatId: "oc_existing_5581",
        larkPerTaskChatName: "Task #5581 - 旧群",
      }),
    });
    const r = await handleCardAction(makeEvent("disband_group"), makePorts(task));
    expect(r.ok).toBe(true);
    expect(r.cardUpdate).toBeDefined();
    const btns = buttonsOf(r.cardUpdate);
    for (const btn of btns) {
      expect(btn.value.sessionId).toBe("session_from_task_5581");
    }
  });

  it("task 无 session_id ⇒ 按钮 value 不写 sessionId 键（向后兼容，不猜）", async () => {
    const task = makeTask(); // 无 session_id
    const r = await handleCardAction(makeEvent("create_group"), makePorts(task));
    expect(r.ok).toBe(true);
    expect(r.cardUpdate).toBeDefined();
    const btns = buttonsOf(r.cardUpdate);
    for (const btn of btns) {
      expect(btn.value.sessionId).toBeUndefined();
      expect(Object.prototype.hasOwnProperty.call(btn.value, "sessionId")).toBe(
        false,
      );
    }
  });
});
