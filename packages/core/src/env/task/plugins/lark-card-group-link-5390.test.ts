/**
 * Task #5390 — 建群 → link 原 sub-session（**真实生产数据形态**下的测试）
 *
 * ## 为什么 #5369 的测试没抓到问题
 *
 * `session-link-group-integration.test.ts` 里每个用例都**手工注入**
 * `task.context = { subSessionId: "session_abc" }`。但生产上从来没有代码把
 * `subSessionId` / `sessionId` 写进 task.context：
 *
 *   tasks.db 全库 4934 条任务，context 里带 subSessionId/sessionId 的 = **0 条**
 *
 * 所以那些测试断言的是「如果 context 里有 id，就会 link」——
 * 一个生产中永不成立的前提。真实建群时 `extractTargetSessionId()` 永远返回
 * undefined ⇒ `linkGroupSessionAlias` 每次静默 return ⇒ 群 session 从未成为
 * alias ⇒ 用户在新群问「我们聊了啥」得到「这个群其实还没有对话」。
 *
 * ## 真正可用的目标来源（本来就存在，只是没读）
 *
 * 卡片按钮 value 一直带 sessionId：
 *  - `buildSessionCard()`      → `value: { action, taskId, sessionId }`
 *  - `buildTaskCard()`         → `value: { action, taskId, ...(sessionId) }`
 *  - `CardActionEvent.actionValue.sessionId` 已在 handler 里声明
 *
 * 本测试即断言：**卡片带来的 sessionId 必须被用上**（主路径），
 * context 只作向后兼容兜底，`resolveSessionIdByTask` 作旧卡兜底。
 */
import { describe, test, expect } from "bun:test";
import {
  handleCardAction,
  type CardActionEvent,
  type CardActionPorts,
} from "./lark-card-action-handler";
import type { LarkCardPatchNotifier } from "./lark-card-patch-notifier";

const noopNotifier = {} as LarkCardPatchNotifier;

/** 生产形态的事件：卡片 value 带 sessionId（真实卡片就是这个形状） */
function makeEvent(sessionId?: string): CardActionEvent {
  return {
    actionValue: {
      action: "create_group",
      taskId: 42,
      ...(sessionId ? { sessionId } : {}),
    },
    chatId: "oc_source_chat",
    messageId: "om_card",
    token: "tok",
    operatorId: "ou_operator",
  };
}

/** 生产形态的 task：context 里**没有**任何 session id（tasks.db 实测） */
function makeTask(context: Record<string, unknown> = {}) {
  return {
    id: 42,
    title: "sub task",
    context: JSON.stringify(context),
    current_status: "running",
  };
}

function makePorts(
  getTask: () => Promise<any> | any,
  extra: Partial<CardActionPorts> = {}
): CardActionPorts {
  return {
    getTask: async () => await getTask(),
    updateTaskContext: async () => {},
    createGroupChat: async () => "oc_new_group",
    notifier: noopNotifier,
    ...extra,
  };
}

function collectingPorts(
  getTask: () => Promise<any> | any,
  calls: Array<{ chatId: string; originSessionId: string }>,
  extra: Partial<CardActionPorts> = {}
): CardActionPorts {
  return makePorts(getTask, {
    attachGroupSession: async ({ chatId, originSessionId }) => {
      calls.push({ chatId, originSessionId });
    },
    ...extra,
  });
}

describe("Task #5390：建群用卡片带来的 sessionId 链接原 sub-session", () => {
  test("★ 主路径：卡片 actionValue.sessionId 存在（task.context 空）→ 仍必须 link", async () => {
    const calls: Array<{ chatId: string; originSessionId: string }> = [];
    // task.context 是生产真实形态：只有 larkPerTask* 之类，没有任何 session id
    const ports = collectingPorts(
      () => makeTask({ type: "bug", project_path: "/repo", larkPerTaskChatTaskId: 42 }),
      calls
    );

    const r = await handleCardAction(makeEvent("session_from_card"), ports);

    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ chatId: "oc_new_group", originSessionId: "session_from_card" }]);
  });

  test("优先级：卡片 sessionId 胜过 task.context 的 subSessionId", async () => {
    const calls: Array<{ chatId: string; originSessionId: string }> = [];
    const ports = collectingPorts(
      () => makeTask({ subSessionId: "session_from_context" }),
      calls
    );

    await handleCardAction(makeEvent("session_from_card"), ports);

    expect(calls).toEqual([{ chatId: "oc_new_group", originSessionId: "session_from_card" }]);
  });

  test("向后兼容：卡片无 sessionId 但 context 有 subSessionId → 仍能 link", async () => {
    const calls: Array<{ chatId: string; originSessionId: string }> = [];
    const ports = collectingPorts(() => makeTask({ subSessionId: "session_abc" }), calls);

    await handleCardAction(makeEvent(), ports);

    expect(calls).toEqual([{ chatId: "oc_new_group", originSessionId: "session_abc" }]);
  });

  test("旧卡兜底：卡片/context 都没有 → 用 resolveSessionIdByTask 反查", async () => {
    const calls: Array<{ chatId: string; originSessionId: string }> = [];
    const ports = collectingPorts(() => makeTask({}), calls, {
      resolveSessionIdByTask: async (taskId: number) =>
        taskId === 42 ? "session_by_task" : undefined,
    });

    await handleCardAction(makeEvent(), ports);

    expect(calls).toEqual([{ chatId: "oc_new_group", originSessionId: "session_by_task" }]);
  });

  test("全都取不到 → 不调用端口（不猜，保持原有安全语义）", async () => {
    const calls: Array<{ chatId: string; originSessionId: string }> = [];
    const ports = collectingPorts(() => makeTask({}), calls);

    const r = await handleCardAction(makeEvent(), ports);

    expect(r.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  test("幂等命中已有群：卡片 sessionId 同样要能补链（老群升级路径）", async () => {
    const calls: Array<{ chatId: string; originSessionId: string }> = [];
    const ports = collectingPorts(
      () => makeTask({ larkPerTaskChatId: "oc_existing" }),
      calls
    );

    const r = await handleCardAction(makeEvent("session_from_card"), ports);

    expect(r.ok).toBe(true);
    expect(r.newChatId).toBe("oc_existing");
    expect(calls).toEqual([{ chatId: "oc_existing", originSessionId: "session_from_card" }]);
  });

  test("best-effort 不退化：link 抛错时建群仍成功", async () => {
    const ports = makePorts(() => makeTask({}), {
      attachGroupSession: async () => {
        throw new Error("session db unavailable");
      },
    });

    const r = await handleCardAction(makeEvent("session_from_card"), ports);

    expect(r.ok).toBe(true);
    expect(r.newChatId).toBe("oc_new_group");
  });

  test("★★ E2E：真实 buildTaskCard 的建群按钮带 sessionId，喂回 handler 能建链", async () => {
    // 这个用例堵的是 CV R1 MAJOR-1 指出的测试盲区：
    // 前面所有用例都手工构造 makeEvent(sessionId)，没有任何一条验证
    // 「生产真实卡片输出 → 事件」这条链。若 buildTaskCard 不塞 sessionId，
    // 手工构造的用例永远绿，生产却退化到反查兜底。
    const { buildTaskCard } = await import("./lark-card-patch-notifier");
    const card = buildTaskCard({
      status: "running",
      meta: { id: 42, title: "sub task", sessionId: "session_real_card" },
    } as any);

    // 从真实卡片里挖出建群/刷新按钮的 value（模拟飞书回传的 action_value）
    const json = JSON.stringify(card);
    const m = /"action":"create_group"/.test(json);
    expect(m).toBe(true);
    // 断言渲染出来的建群按钮 value 里确实有 sessionId
    const createGroupValues: any[] = [];
    JSON.stringify(card, (_k, v) => {
      if (v && typeof v === "object" && v.action === "create_group") createGroupValues.push(v);
      return v;
    });
    expect(createGroupValues.length).toBe(1);
    expect(createGroupValues[0].sessionId).toBe("session_real_card");

    // 喂回 handler：task.context 为空（生产真实形态）
    const calls: Array<{ chatId: string; originSessionId: string }> = [];
    const ports = collectingPorts(() => makeTask({}), calls);
    const r = await handleCardAction(
      {
        actionValue: createGroupValues[0],
        chatId: "oc_source_chat",
        messageId: "om_card",
        token: "tok",
        operatorId: "ou_operator",
      },
      ports
    );

    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ chatId: "oc_new_group", originSessionId: "session_real_card" }]);
  });

  test("buildSessionCard 的建群按钮同样带 sessionId（与 task 卡形状对齐）", async () => {
    // CV R2 MINOR-2：buildSessionCard 侧原来只有阅读确认，没有断言。
    const { buildSessionCard } = await import("./lark-card-patch-notifier");
    // 注意：session 卡的建群按钮只在 opts.task.id > 0 时渲染
    // （见 buildSessionCard 里 `if (typeof taskIdNum === "number" && taskIdNum > 0)`）
    const card = buildSessionCard({
      sessionId: "session_from_session_card",
      task: { id: 42, title: "sub task" },
    } as any);
    const vals: any[] = [];
    JSON.stringify(card, (_k, v) => {
      if (v && typeof v === "object" && v.action === "create_group") vals.push(v);
      return v;
    });
    expect(vals.length).toBe(1);
    expect(vals[0].sessionId).toBe("session_from_session_card");
  });

  test("不把空白 sessionId 当有效值（避免链到空字符串）", async () => {
    const calls: Array<{ chatId: string; originSessionId: string }> = [];
    const ports = collectingPorts(() => makeTask({}), calls);

    await handleCardAction(makeEvent("   "), ports);

    expect(calls).toEqual([]);
  });
});