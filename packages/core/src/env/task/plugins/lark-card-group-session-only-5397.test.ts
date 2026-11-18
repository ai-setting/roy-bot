/**
 * Task #5397 — 无 task 也能建群（设计决定，非 bug）
 *
 * ## 用户拍板（2026-11-12 15:35）
 *
 * > 「做「无 task 也能建群」」
 *
 * ## 改造前的三处硬依赖（实测确认）
 *
 * ```
 * lark-card-action-handler.ts:105   ACTION_SUBJECT_FIELD.create_group = "taskId"
 * lark-card-action-handler.ts:722   if (!task) return { ok:false, error:"Task #xxx not found" }
 * lark-card-patch-notifier.ts:1590  taskIdNum>0 才 push 建群按钮
 * ```
 *
 * ⇒ 没有 task 的 sub-session 连建群按钮都不渲染。
 *
 * ## 本测试锁定的契约
 *
 * ### A. 卡片渲染（块 1）
 * 1. **无 task** 的 session 卡 ⇒ **仍渲染**建群按钮（文案「为本会话建群」），
 *    value = `{ action:"create_group", sessionId }`（**不带** taskId）
 * 2. **有 task** 的 session 卡 ⇒ 仍渲染（文案「为这个任务建群」），value 带
 *    taskId + sessionId（**不回归**）
 * 3. **已有群** ⇒ 按钮翻「解散该群」（action=disband_group）+ 渲染群链接
 *
 * ### B. 校验层（块 2）
 * 4. `create_group` **只带 sessionId** ⇒ ok（不再要求 taskId）
 * 5. `create_group` **两者都缺** ⇒ ok:false，error 含字段名提示
 * 6. `create_group` taskId 非法字符串 ⇒ 保留 `Invalid taskId:` 语义（向后兼容）
 *
 * ### C. 建群/解绑 session-only 路径（块 2）
 * 7. 点无 task 的建群 ⇒ `createGroupChat` 被调 + `attachGroupSession({chatId, originSessionId})`
 *    被调 + `updateTaskContext` **零调用**（无 task 不写 task.context）
 * 8. **重复建群保护**：`findGroupChatForSession` 返回已有群 ⇒ 不调 `createGroupChat`，
 *    返回已有 chatId
 * 9. 无 task 的解绑 ⇒ `deleteGroupChat(existing)` + `detachGroupSession(existing)`；
 *    **不碰** `updateTaskContext`
 * 10. 无群时解绑 ⇒ ok:false，不调 deleteGroupChat
 *
 * ### D. task 路径不回归（块 3 的对立面）
 * 11. 有 task + 无群 ⇒ 建群后仍写 `task.context.larkPerTaskChatId`
 * 12. 有 task + 已有群（context 有）⇒ 幂等命中，不新建
 */
import { describe, test, expect } from "bun:test";
import {
  handleCardAction,
  validateCardActionValue,
  __resetCardActionInflightForTest,
  type CardActionEvent,
  type CardActionPorts,
} from "./lark-card-action-handler";
import type { LarkCardPatchNotifier } from "./lark-card-patch-notifier";

const SESSION = "session_no_task_abc";
const noopNotifier = {} as LarkCardPatchNotifier;

function makeTask(context: Record<string, unknown> = {}) {
  return {
    id: 42,
    title: "sub task",
    context: JSON.stringify(context),
    current_status: "running",
  };
}

/** 无 task 的卡片点击（session 卡真实形状：value 里没有 taskId） */
function sessionOnlyEvent(action: "create_group" | "disband_group"): CardActionEvent {
  return {
    actionValue: { action, sessionId: SESSION } as CardActionEvent["actionValue"],
    chatId: "oc_source_chat",
    messageId: "om_session_card",
    token: "tok",
    operatorId: "ou_operator",
  };
}

function makePorts(extra: Partial<CardActionPorts> = {}): CardActionPorts {
  return {
    notifier: noopNotifier,
    ...extra,
  };
}

// ============================================================================
// A. 卡片渲染
// ============================================================================
describe("Task #5397 / A. session 卡无条件渲染建群按钮", () => {
  let buildSessionCard: typeof import("./lark-card-patch-notifier").buildSessionCard;

  test("A1. 无 task ⇒ 仍渲染 create_group 按钮（文案「为本会话建群」，value 无 taskId）", async () => {
    ({ buildSessionCard } = await import("./lark-card-patch-notifier"));
    const card = buildSessionCard({ sessionId: SESSION } as any);
    const buttons = (card.body.elements ?? []).filter((e: any) => e.tag === "button");
    const groupBtn = buttons.find((b: any) => b.value?.action === "create_group");

    expect(groupBtn).toBeDefined();
    expect(groupBtn!.text.content).toBe("为本会话建群");
    expect(groupBtn!.value.sessionId).toBe(SESSION);
    expect(groupBtn!.value.taskId).toBeUndefined();
  });

  test("A2. 有 task ⇒ 仍渲染（文案「为这个任务建群」，value 带 taskId + sessionId）", async () => {
    ({ buildSessionCard } = await import("./lark-card-patch-notifier"));
    const card = buildSessionCard({
      sessionId: SESSION,
      task: { id: 42, title: "sub task" },
    } as any);
    const groupBtn = (card.body.elements ?? [])
      .filter((e: any) => e.tag === "button")
      .find((b: any) => b.value?.action === "create_group");

    expect(groupBtn).toBeDefined();
    expect(groupBtn!.text.content).toBe("为这个任务建群");
    expect(groupBtn!.value.taskId).toBe("42");
    expect(groupBtn!.value.sessionId).toBe(SESSION);
  });

  test("A3. 已有群 ⇒ 按钮翻「解散该群」+ 渲染群链接", async () => {
    ({ buildSessionCard } = await import("./lark-card-patch-notifier"));
    const card = buildSessionCard({
      sessionId: SESSION,
      perTaskChatId: "oc_existing_group",
    } as any);
    const flat = JSON.stringify(card);

    expect(flat).toContain("解散该群");
    expect(flat).toContain("disband_group");
    expect(flat).toContain("oc_existing_group");
  });
});

// ============================================================================
// B. 校验层
// ============================================================================
describe("Task #5397 / B. group 动作允许 taskId 缺省", () => {
  test("B1. 只带 sessionId ⇒ ok（不报缺 taskId）", () => {
    const r = validateCardActionValue({ action: "create_group", sessionId: SESSION });
    expect(r.ok).toBe(true);
    expect((r as any).sessionId).toBe(SESSION);
  });

  test("B2. 两者都缺 ⇒ ok:false，error 指明字段", () => {
    const r = validateCardActionValue({ action: "create_group" });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/Missing required field/);
    expect((r as any).error).toMatch(/taskId or sessionId/);
  });

  test("B3. taskId 非法字符串 ⇒ 保留 Invalid taskId 语义（向后兼容）", () => {
    const r = validateCardActionValue({ action: "create_group", taskId: "abc" });
    expect(r.ok).toBe(false);
    expect((r as any).error).toMatch(/Invalid taskId/);
  });
});

// ============================================================================
// C. session-only 建群 / 解绑
// ============================================================================
describe("Task #5397 / C. 无 task 的建群与解绑", () => {
  test("C1. 无 task 建群 ⇒ createGroupChat + attachGroupSession，不写 task.context", async () => {
    __resetCardActionInflightForTest();
    const created: any[] = [];
    const attached: Array<{ chatId: string; originSessionId: string }> = [];
    let updateContextCalls = 0;
    let getTaskCalls = 0;

    const r = await handleCardAction(
      sessionOnlyEvent("create_group"),
      makePorts({
        getTask: async () => {
          getTaskCalls++;
          return makeTask();
        },
        updateTaskContext: async () => {
          updateContextCalls++;
        },
        createGroupChat: async (o) => {
          created.push(o);
          return "oc_new_group";
        },
        attachGroupSession: async ({ chatId, originSessionId }) => {
          attached.push({ chatId, originSessionId });
        },
      })
    );

    expect(r.ok).toBe(true);
    expect(r.newChatId).toBe("oc_new_group");
    expect(created).toHaveLength(1);
    expect(attached).toEqual([{ chatId: "oc_new_group", originSessionId: SESSION }]);
    // ⭐ 无 task 路径：没有 task 可读、没有 task.context 可写
    expect(getTaskCalls).toBe(0);
    expect(updateContextCalls).toBe(0);
  });

  test("C2. 重复建群保护：已有群 ⇒ 不新建，返回已有 chatId", async () => {
    __resetCardActionInflightForTest();
    let createCalls = 0;

    const r = await handleCardAction(
      sessionOnlyEvent("create_group"),
      makePorts({
        findGroupChatForSession: async () => ({ chatId: "oc_already_here" }),
        createGroupChat: async () => {
          createCalls++;
          return "oc_should_not_happen";
        },
      })
    );

    expect(r.ok).toBe(true);
    expect(r.newChatId).toBe("oc_already_here");
    expect(createCalls).toBe(0);
  });

  test("C3. 无 task 解绑 ⇒ deleteGroupChat + detachGroupSession，不写 task.context", async () => {
    __resetCardActionInflightForTest();
    const deleted: string[] = [];
    const unlinked: string[] = [];
    let updateContextCalls = 0;

    const r = await handleCardAction(
      sessionOnlyEvent("disband_group"),
      makePorts({
        findGroupChatForSession: async () => ({ chatId: "oc_existing_group" }),
        deleteGroupChat: async (chatId) => {
          deleted.push(chatId);
        },
        detachGroupSession: async (chatId) => {
          unlinked.push(chatId);
        },
        updateTaskContext: async () => {
          updateContextCalls++;
        },
      })
    );

    expect(r.ok).toBe(true);
    expect(deleted).toEqual(["oc_existing_group"]);
    expect(unlinked).toEqual(["oc_existing_group"]);
    expect(updateContextCalls).toBe(0);
  });

  // ★ CV 5397 M3：detach 用 aliasSessionId 而不是 chatId
  test("C5. 解绑优先 detach aliasSessionId（不是 chatId）", async () => {
    __resetCardActionInflightForTest();
    const unlinked: string[] = [];
    const deleted: string[] = [];

    await handleCardAction(
      sessionOnlyEvent("disband_group"),
      makePorts({
        findGroupChatForSession: async () => ({
          chatId: "oc_group_5397",
          aliasSessionId: "session_alias_row_5397",
        }),
        deleteGroupChat: async (chatId) => {
          deleted.push(chatId);
        },
        detachGroupSession: async (chatId) => {
          unlinked.push(chatId);
        },
      })
    );

    // 解散用群 id，解绑用元数据行 id —— 两者语义不同，不能混用
    expect(deleted).toEqual(["oc_group_5397"]);
    expect(unlinked).toEqual(["session_alias_row_5397"]);
  });

  test("C4. 无群时解绑 ⇒ ok:false，不调 deleteGroupChat", async () => {
    __resetCardActionInflightForTest();
    let deleteCalls = 0;

    const r = await handleCardAction(
      sessionOnlyEvent("disband_group"),
      makePorts({
        findGroupChatForSession: async () => undefined,
        deleteGroupChat: async () => {
          deleteCalls++;
        },
      })
    );

    expect(r.ok).toBe(false);
    expect(deleteCalls).toBe(0);
  });
});

// ============================================================================
// D. task 路径不回归
// ============================================================================
describe("Task #5397 / D. task 路径零回归", () => {
  test("D1. 有 task + 无群 ⇒ 建群后仍写 task.context.larkPerTaskChatId", async () => {
    __resetCardActionInflightForTest();
    let writtenContext: string | undefined;

    const r = await handleCardAction(
      {
        actionValue: { action: "create_group", taskId: "42", sessionId: SESSION } as any,
        chatId: "oc_source_chat",
        messageId: "om_task_card",
        token: "tok",
        operatorId: "ou_operator",
      },
      makePorts({
        getTask: async () => makeTask(),
        createGroupChat: async () => "oc_task_group",
        updateTaskContext: async (_id, ctx) => {
          writtenContext = ctx;
        },
      })
    );

    expect(r.ok).toBe(true);
    expect(r.newChatId).toBe("oc_task_group");
    expect(writtenContext).toBeDefined();
    expect(JSON.parse(writtenContext!).larkPerTaskChatId).toBe("oc_task_group");
  });

  test("D2. 有 task + context 已有群 ⇒ 幂等命中，不新建", async () => {
    __resetCardActionInflightForTest();
    let createCalls = 0;

    const r = await handleCardAction(
      {
        actionValue: { action: "create_group", taskId: "42", sessionId: SESSION } as any,
        chatId: "oc_source_chat",
        messageId: "om_task_card",
        token: "tok",
        operatorId: "ou_operator",
      },
      makePorts({
        getTask: async () => makeTask({ larkPerTaskChatId: "oc_ctx_group" }),
        createGroupChat: async () => {
          createCalls++;
          return "oc_should_not_happen";
        },
      })
    );

    expect(r.ok).toBe(true);
    expect(r.newChatId).toBe("oc_ctx_group");
    expect(createCalls).toBe(0);
  });
});