/**
 * Task #4331：卡片按钮点击 callback 处理测试
 *
 * 覆盖 handleCardAction 在 create_group / disband_group / 错误路径下的行为。
 */

import { describe, it, expect } from "bun:test";
import {
  handleCardAction,
  type CardActionEvent,
  type CardActionPorts,
} from "./lark-card-action-handler";
import type { LarkCardPatchNotifier, TaskMeta } from "./lark-card-patch-notifier";

function makeNotifier(): LarkCardPatchNotifier & { updated: TaskMeta[] } {
  const updated: TaskMeta[] = [];
  return {
    updated,
    async startTask() {
      return { messageId: "om_start", pinned: true };
    },
    async updateTask(opts: any) {
      updated.push(opts.meta);
      return { ok: true };
    },
    async finishTask() {},
  } as any;
}

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 4331,
    title: "测试任务",
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

describe("lark-card-action-handler / Task #4331", () => {
  it("create_group：调 createGroupChat + 写 task.context.larkPerTaskChatId + 渲染按钮翻“解散”的新卡片", async () => {
    let created: any = undefined;
    let updatedContext: string | undefined;
    const notifier = makeNotifier();

    const ports: CardActionPorts = {
      getTask: async () => makeTask(),
      updateTaskContext: async (_id, ctx) => {
        updatedContext = ctx;
      },
      createGroupChat: async (o) => {
        created = o;
        return "oc_new_group_xxx";
      },
      notifier,
    };

    const event: CardActionEvent = {
      actionValue: { action: "create_group", taskId: "4331", sessionId: "session_test_card" },
      chatId: "oc_trigger_chat",
      messageId: "om_card",
      token: "token_xxx",
    };

    const r = await handleCardAction(event, ports);
    expect(r.ok).toBe(true);
    expect(r.action).toBe("create_group");
    expect(r.newChatId).toBe("oc_new_group_xxx");
    expect(created).toBeDefined();
    expect(created.name).toContain("Task #4331");
    expect(updatedContext).toBeDefined();
    const ctx = JSON.parse(updatedContext!);
    expect(ctx.larkPerTaskChatId).toBe("oc_new_group_xxx");
    expect(ctx.larkPerTaskChatName).toContain("Task #4331");

    // cardUpdate 应该是按钮翻“解散”的新卡片
    expect(r.cardUpdate).toBeDefined();
    const btn = (r.cardUpdate!.body.elements as any[]).find((e) => e.tag === "button");
    expect(btn.text.content).toBe("解散该群");
    expect(btn.type).toBe("danger");
  });

  it("disband_group：调 deleteGroupChat + 清 task.context.larkPerTaskChatId + 渲染按钮翻“建群”的新卡片", async () => {
    let deletedChatId: string | undefined;
    let updatedContext: string | undefined;
    const notifier = makeNotifier();

    const ports: CardActionPorts = {
      getTask: async () =>
        makeTask({
          context: JSON.stringify({ larkPerTaskChatId: "oc_existing", larkPerTaskChatName: "Task 4331 - 旧群" }),
        }),
      updateTaskContext: async (_id, ctx) => {
        updatedContext = ctx;
      },
      deleteGroupChat: async (chatId) => {
        deletedChatId = chatId;
      },
      notifier,
    };

    const event: CardActionEvent = {
      actionValue: { action: "disband_group", taskId: 4331, sessionId: "session_test_card" },
      chatId: "oc_trigger_chat",
      messageId: "om_card",
      token: "token_xxx",
    };

    const r = await handleCardAction(event, ports);
    expect(r.ok).toBe(true);
    expect(r.action).toBe("disband_group");
    expect(deletedChatId).toBe("oc_existing");
    expect(updatedContext).toBeDefined();
    const ctx = JSON.parse(updatedContext!);
    expect(ctx.larkPerTaskChatId).toBeUndefined();

    // cardUpdate 应该是按钮翻“建群”的新卡片
    expect(r.cardUpdate).toBeDefined();
    const btn = (r.cardUpdate!.body.elements as any[]).find((e) => e.tag === "button");
    expect(btn.text.content).toBe("为这个任务建群");
    expect(btn.type).toBe("primary");
  });

  it("create_group：已有专属群时 ok=true 幂等（不重复建群，只把卡片刷成有群形态）", async () => {
    const ports: CardActionPorts = {
      getTask: async () =>
        makeTask({
          context: JSON.stringify({
            larkPerTaskChatId: "oc_existing",
            larkPerTaskChatName: "Task 4331 - 已存在的群",
          }),
        }),
      createGroupChat: async () => {
        throw new Error("不该被调用");
      },
      notifier: makeNotifier(),
    };

    const event: CardActionEvent = {
      actionValue: { action: "create_group", taskId: 4331, sessionId: "session_test_card" },
      chatId: "oc_trigger_chat",
      messageId: "om_card",
      token: "token",
    };

    const r = await handleCardAction(event, ports);
    // ★ Task #4339：从 ok=false 改为 ok=true —— 这是幂等命中而不是错误
    expect(r.ok).toBe(true);
    expect(r.newChatId).toBe("oc_existing");
    // 卡片必须被刷成"已有群"形态（按钮翻解散 + 出现群链接）
    const btn = (r.cardUpdate!.body.elements as any[]).find((e) => e.tag === "button");
    expect(btn.text.content).toBe("解散该群");
  });

  it("disband_group：无专属群时返回 ok=false（避免误解散）", async () => {
    const ports: CardActionPorts = {
      getTask: async () => makeTask({ context: "{}" }),
      deleteGroupChat: async () => {
        throw new Error("不该被调用");
      },
      notifier: makeNotifier(),
    };

    const event: CardActionEvent = {
      actionValue: { action: "disband_group", taskId: 4331, sessionId: "session_test_card" },
      chatId: "oc_trigger_chat",
      messageId: "om_card",
      token: "token",
    };

    const r = await handleCardAction(event, ports);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("无专属群");
  });

  it("无效 taskId → ok=false", async () => {
    const ports: CardActionPorts = {
      getTask: async () => undefined,
      notifier: makeNotifier(),
    };

    const event: CardActionEvent = {
      actionValue: { action: "create_group", taskId: "abc", sessionId: "session_test_card" },
      chatId: "oc_trigger_chat",
      messageId: "om_card",
      token: "token",
    };

    const r = await handleCardAction(event, ports);
    expect(r.ok).toBe(false);
    // ★ 澄清 22:37 后：非法 taskId 在「建群」这个动作上仍是硬失败
    //   （建群必须绑定合法 task），报错文案从 Invalid taskId 调整为
    //   「requires a task」—— 行为（ok=false + 不建群）不变。
    expect(r.error).toMatch(/requires a task|Invalid taskId/);
  });

  it("createGroupChat 抛错 → ok=false（不静默成功）", async () => {
    const ports: CardActionPorts = {
      getTask: async () => makeTask(),
      createGroupChat: async () => {
        throw new Error("lark-cli 网络错误");
      },
      notifier: makeNotifier(),
    };

    const event: CardActionEvent = {
      actionValue: { action: "create_group", taskId: 4331, sessionId: "session_test_card" },
      chatId: "oc_trigger_chat",
      messageId: "om_card",
      token: "token",
    };

    const r = await handleCardAction(event, ports);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("lark-cli 网络错误");
  });

  it("ports.getTask 未注入 → ok=false", async () => {
    const ports: CardActionPorts = {
      notifier: makeNotifier(),
    };

    const event: CardActionEvent = {
      actionValue: { action: "create_group", taskId: 4331, sessionId: "session_test_card" },
      chatId: "oc_trigger_chat",
      messageId: "om_card",
      token: "token",
    };

    const r = await handleCardAction(event, ports);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("getTask");
  });
});
