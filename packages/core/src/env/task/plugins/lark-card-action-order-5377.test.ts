/**
 * Task #5377：卡片 action 校验顺序 bug（RED → GREEN）
 *
 * ## 生产 bug（3 次点击全失败）
 * main `handleCardAction` 在 :139 **先**要求 taskId、:143 **后**才判 action 白名单：
 * ```ts
 * if (!taskId || NaN) return { ok:false, error: `Invalid taskId: ${raw}` };   // 先早退
 * if (action !== "create_group" && action !== "disband_group") return Unknown action;  // 不可达
 * ```
 * session 卡按钮 value = `{ action:"refresh_activity", sessionId }`（**无 taskId**）
 * ⇒ 永远在 :139 早退，日志 `handleCardActionEvent failed: Invalid taskId: undefined`。
 *
 * ## 契约（本测试锁定的行为）
 * 1. 先判 action 白名单：未知 action ⇒ `Unknown action: <action>`（**任何** taskId 形状下都如此）
 * 2. 再按 action 取对应主键：
 *    - `create_group` / `disband_group` → 需 `taskId`
 *    - `refresh_activity`（session 类）→ 需 `sessionId`，**不看 taskId**
 * 3. 缺对应主键才报错，且错误信息**指明字段名**（taskId / sessionId）
 * 4. 防线：白名单外的 action 绝不能落到「解散群」分支（否则会误删用户群）
 */

import { describe, it, expect } from "bun:test";
import {
  handleCardAction,
  isCardActionName,
  validateCardActionValue,
  type CardActionEvent,
  type CardActionPorts,
} from "./lark-card-action-handler";

function makeNotifier(): any {
  return {
    async startTask() {
      return { messageId: "om_start", pinned: true };
    },
    async updateTask() {
      return { ok: true };
    },
    async finishTask() {},
  };
}

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 5377,
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

/** session 卡（#5360/#5364 形态）：**没有** taskId */
function sessionCardEvent(actionValue: Record<string, unknown>): CardActionEvent {
  return {
    actionValue: actionValue as CardActionEvent["actionValue"],
    chatId: "oc_chat",
    messageId: "om_session_card",
    token: "token",
  };
}

describe("Task #5377 / action 白名单先于主键校验", () => {
  it("session 卡点 refresh_activity（无 taskId）不得被 Invalid taskId 拦掉", async () => {
    let getTaskCalled = 0;
    const ports: CardActionPorts = {
      getTask: async () => {
        getTaskCalled++;
        return makeTask();
      },
      notifier: makeNotifier(),
    };

    const r = await handleCardAction(
      sessionCardEvent({ action: "refresh_activity", sessionId: "session_abc" }),
      ports
    );

    // RED（main）：error === "Invalid taskId: undefined" ← 正是生产日志
    expect(r.error).not.toMatch(/Invalid taskId/);
    // 也绝不能是 "Unknown action" —— refresh_activity 是白名单内的合法 action
    expect(r.error).not.toMatch(/Unknown action/);
    // 走到 session 主键校验之后 ⇒ 错误必须指向 session 语义（而不是 taskId）
    expect(r.error).toMatch(/refresh_activity/);
    // session 卡没有 task ⇒ 不该去读 task
    expect(getTaskCalled).toBe(0);
  });

  it("refresh_activity 缺 sessionId ⇒ 错误信息指名 sessionId 字段", async () => {
    const ports: CardActionPorts = {
      getTask: async () => makeTask(),
      notifier: makeNotifier(),
    };

    const r = await handleCardAction(sessionCardEvent({ action: "refresh_activity" }), ports);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/sessionId/);
    expect(r.error).not.toMatch(/Invalid taskId/);
  });

  it("未知 action 且无 taskId ⇒ Unknown action（不是 Invalid taskId）", async () => {
    const ports: CardActionPorts = {
      getTask: async () => makeTask(),
      notifier: makeNotifier(),
    };

    const r = await handleCardAction(sessionCardEvent({ action: "drop_database" }), ports);
    expect(r.ok).toBe(false);
    // RED（main）：先报 "Invalid taskId: undefined"
    expect(r.error).toBe("Unknown action: drop_database");
  });

  it("未知 action 即使带合法 taskId ⇒ 仍是 Unknown action", async () => {
    const r = await handleCardAction(
      sessionCardEvent({ action: "drop_database", taskId: 5377 }),
      { getTask: async () => makeTask(), notifier: makeNotifier() }
    );
    expect(r.error).toBe("Unknown action: drop_database");
  });

  it("action 缺失（{}）⇒ Unknown action，不是 Invalid taskId", async () => {
    const r = await handleCardAction(sessionCardEvent({}), {
      getTask: async () => makeTask(),
      notifier: makeNotifier(),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^Unknown action/);
  });
});

describe("Task #5377 / 按 action 类型取主键", () => {
  it("create_group 缺 taskId ⇒ 错误指明 taskId 字段（不是 Unknown action）", async () => {
    const r = await handleCardAction(sessionCardEvent({ action: "create_group" }), {
      getTask: async () => makeTask(),
      notifier: makeNotifier(),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/taskId/);
    expect(r.error).not.toMatch(/Unknown action/);
    expect(r.error).toMatch(/Missing required field: taskId/);
  });

  it("disband_group 缺 taskId ⇒ 错误指明 taskId 字段", async () => {
    const r = await handleCardAction(sessionCardEvent({ action: "disband_group" }), {
      getTask: async () => makeTask(),
      notifier: makeNotifier(),
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Missing required field: taskId/);
  });

  it("group 动作 taskId 非法字符串 ⇒ 保留 Invalid taskId 语义（向后兼容已有断言）", async () => {
    const r = await handleCardAction(
      sessionCardEvent({ action: "create_group", taskId: "abc" }),
      { getTask: async () => undefined, notifier: makeNotifier() }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Invalid taskId/);
  });

  it("session 类 action 带 taskId 时主键仍是 sessionId（不从 taskId 回退）", async () => {
    const r = await handleCardAction(
      sessionCardEvent({ action: "refresh_activity", taskId: 5377 }),
      { getTask: async () => makeTask(), notifier: makeNotifier() }
    );
    // 有 taskId 但无 sessionId ⇒ 仍按 session 主键判定为缺 sessionId
    expect(r.error).toMatch(/sessionId/);
  });
});

describe("Task #5377 / 回归：合法 group 动作行为不变", () => {
  it("create_group 合法 ⇒ 真建群并回写 context", async () => {
    let created: any;
    let updatedContext: string | undefined;
    const r = await handleCardAction(
      {
        actionValue: { action: "create_group", taskId: "5377" },
        chatId: "oc_chat",
        messageId: "om_card",
        token: "token",
      },
      {
        getTask: async () => makeTask(),
        createGroupChat: async (o) => {
          created = o;
          return "oc_new";
        },
        updateTaskContext: async (_id, ctx) => {
          updatedContext = ctx;
        },
        notifier: makeNotifier(),
      }
    );
    expect(r.ok).toBe(true);
    expect(r.newChatId).toBe("oc_new");
    expect(created).toBeDefined();
    expect(JSON.parse(updatedContext!).larkPerTaskChatId).toBe("oc_new");
  });

  it("白名单外的 action 绝不会解散群（deleteGroupChat 不被调用）", async () => {
    // ★ CV MINOR-3 修复：这条以前传的是 refresh_activity（**白名单内**），
    //   名不副实。现在真的传一个白名单外的拼写错误动作，且卡片上**有活跃群**
    //   （若误落到 disband 分支就会删群）。
    let deleted = 0;
    let getTaskCalled = 0;
    const r = await handleCardAction(
      sessionCardEvent({ action: "disband_group_typo", taskId: 5377 }),
      {
        getTask: async () => {
          getTaskCalled++;
          return makeTask({ context: JSON.stringify({ larkPerTaskChatId: "oc_live" }) });
        },
        deleteGroupChat: async () => {
          deleted++;
        },
        notifier: makeNotifier(),
      }
    );
    expect(deleted).toBe(0);
    // 连 task 都不该读 —— 未知 action 在读 task / 建删群之前就被挡下
    expect(getTaskCalled).toBe(0);
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Unknown action: disband_group_typo");
  });

  it("session 动作（白名单内）也不会走群路径", async () => {
    let deleted = 0;
    const r = await handleCardAction(
      sessionCardEvent({ action: "refresh_activity", taskId: 5377, sessionId: "s" }),
      {
        getTask: async () => makeTask({ context: JSON.stringify({ larkPerTaskChatId: "oc_live" }) }),
        deleteGroupChat: async () => {
          deleted++;
        },
        notifier: makeNotifier(),
      }
    );
    expect(deleted).toBe(0);
    expect(r.ok).toBe(false);
    // ★ 不再依赖「端口未注入」才失败：错误必须是 session 语义
    expect(r.error).toMatch(/refresh_activity/);
  });
});

describe("Task #5377 / isCardActionName 白名单", () => {
  it("三个 action 都合法", () => {
    expect(isCardActionName("create_group")).toBe(true);
    expect(isCardActionName("disband_group")).toBe(true);
    expect(isCardActionName("refresh_activity")).toBe(true);
  });

  it("未知/非字符串一律非法", () => {
    for (const v of ["drop", "", "CREATE_GROUP", undefined, null, 42, {}]) {
      expect(isCardActionName(v)).toBe(false);
    }
  });
});
describe("Task #5377 / validateCardActionValue 边界", () => {
  it("taskId 数字 0 / 负数 → 拒绝（不能用 falsy 判据放过 0）", () => {
    expect(validateCardActionValue({ action: "create_group", taskId: 0 }).ok).toBe(false);
    expect(validateCardActionValue({ action: "create_group", taskId: -5 }).ok).toBe(false);
  });

  it("taskId 字符串带空白 → 正确解析", () => {
    const r = validateCardActionValue({ action: "create_group", taskId: "  42  " });
    expect(r.ok).toBe(true);
    if (r.ok && r.action !== "refresh_activity") expect(r.taskId).toBe(42);
  });

  it("sessionId 纯空白 / 非字符串 → 拒绝", () => {
    expect(validateCardActionValue({ action: "refresh_activity", sessionId: "   " }).ok).toBe(false);
    expect(validateCardActionValue({ action: "refresh_activity", sessionId: 123 }).ok).toBe(false);
  });

  it("action 是 null / 对象 → Unknown action（不抛错）", () => {
    expect(validateCardActionValue({ action: null }).error).toMatch(/Unknown action/);
    expect(validateCardActionValue({ action: {} }).error).toMatch(/Unknown action/);
  });
});

describe("Task #5377 / 并发去重（CV MINOR-7：先缺测试，现在补上）", () => {
  it("session 路径：同一卡片并发双击 refresh_activity → 第二次被去重拒绝", async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ports: CardActionPorts = {
      getTask: async () => makeTask(),
      notifier: makeNotifier(),
      refreshSessionCard: async () => {
        calls++;
        await gate; // 卡住第一次，让第二次在同一 inflight key 上撞进来
        return {};
      },
    };
    const ev = sessionCardEvent({ action: "refresh_activity", sessionId: "session_dup" });

    const p1 = handleCardAction(ev, ports);
    const p2 = await handleCardAction(ev, ports); // 后到的同 key 请求
    release();
    const r1 = await p1;

    expect(r1.ok).toBe(true);
    expect(calls).toBe(1); // 端口只被真正调用一次
    expect(p2.ok).toBe(false);
    expect(p2.error).toMatch(/重复点击/);
  });

  it("task 路径：同一卡片并发双击 create_group → 第二次被去重拒绝（回归）", async () => {
    let creates = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const ports: CardActionPorts = {
      getTask: async () => makeTask(),
      notifier: makeNotifier(),
      createGroupChat: async () => {
        creates++;
        await gate;
        return "oc_once";
      },
    };
    const ev: CardActionEvent = {
      actionValue: { action: "create_group", taskId: 5377 },
      chatId: "oc_chat",
      messageId: "om_dup_card",
      token: "token",
    };

    const p1 = handleCardAction(ev, ports);
    const p2 = await handleCardAction(ev, ports);
    release();
    const r1 = await p1;

    expect(r1.ok).toBe(true);
    expect(creates).toBe(1); // 不会建出两个群
    expect(p2.ok).toBe(false);
    expect(p2.error).toMatch(/重复点击/);
  });

  it("不同卡片（messageId 不同）的 refresh 互不去重", async () => {
    let calls = 0;
    const ports: CardActionPorts = {
      getTask: async () => makeTask(),
      notifier: makeNotifier(),
      refreshSessionCard: async () => {
        calls++;
        return {};
      },
    };
    const a = await handleCardAction(
      { ...sessionCardEvent({ action: "refresh_activity", sessionId: "s1" }), messageId: "om_a" },
      ports
    );
    const b = await handleCardAction(
      { ...sessionCardEvent({ action: "refresh_activity", sessionId: "s1" }), messageId: "om_b" },
      ports
    );
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(calls).toBe(2);
  });
});

describe("Task #5377 / ACTION_SUBJECT_FIELD 与分支一致性（CV MINOR-5 锁）", () => {
  it("每个白名单 action 都能被 validateCardActionValue 正确路由到自己的主键", () => {
    // ★ Task #5397（用户拍板「做「无 task 也能建群」」）：group 动作的主键从
    //   「必须 taskId」放宽为「**taskId 优先，无则 sessionId**」。
    //   原断言是 `onlySession.ok === false`（只认 taskId），已被本需求推翻。
    for (const action of ["create_group", "disband_group"] as const) {
      // 只带 sessionId ⇒ 合法（session-only 路径）
      const onlySession = validateCardActionValue({ action, sessionId: "s" });
      expect(onlySession.ok).toBe(true);
      if (onlySession.ok) {
        expect(onlySession.action).toBe(action);
        expect((onlySession as any).sessionId).toBe("s");
        expect(onlySession.taskId).toBeUndefined();
      }

      // 只带 taskId ⇒ 合法（task 路径，行为不变）
      const withTask = validateCardActionValue({ action, taskId: 7 });
      expect(withTask.ok).toBe(true);
      if (withTask.ok) expect(withTask.action).toBe(action);

      // 两者都缺 ⇒ 拒绝，且错误信息**同时点名**两个字段
      const neither = validateCardActionValue({ action });
      expect(neither.ok).toBe(false);
      expect((neither as any).error).toMatch(/taskId or sessionId/);
    }

    // session 动作只认 sessionId：给 taskId 也不行
    const onlyTask = validateCardActionValue({ action: "refresh_activity", taskId: 7 });
    expect(onlyTask.ok).toBe(false);
    expect(onlyTask.error).toMatch(/sessionId/);

    const withSession = validateCardActionValue({ action: "refresh_activity", sessionId: "s" });
    expect(withSession.ok).toBe(true);
  });
});
