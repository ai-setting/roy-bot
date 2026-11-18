/**
 * Task #4339：卡片按钮 callback 的健壮性修复
 *
 * 覆盖 reports/2026-10-19-lark-cli-multi-event-consume-research.md 里提出的：
 *   - P1-2 shell 安全引用（shellQuote）
 *   - P1-3 卡片 patch 必须保留已累积的里程碑历史
 *   - P2-1 双击竞态：同一 (taskId, action) 并发只执行一次
 *   - P2-2 「已有专属群」= 幂等命中（ok=true）而非错误
 */

import { describe, it, expect, beforeEach, mock, afterEach } from "bun:test";
import {
  handleCardAction,
  shellQuote,
  truncateText,
  __resetCardActionInflightForTest,
  type CardActionEvent,
  type CardActionPorts,
} from "./lark-card-action-handler";
import { LarkCardPatchNotifier } from "./lark-card-patch-notifier";

function makeTask(overrides: Partial<any> = {}): any {
  return {
    id: 4339,
    title: "带 引号\"和$变量 的标题",
    description: "描述",
    goals: "目标",
    priority: "high",
    type: "normal",
    project_path: "~/proj",
    parent_task_id: null,
    current_status: "进行中",
    context: "{}",
    ...overrides,
  };
}

function makeEvent(overrides: Partial<CardActionEvent> = {}): CardActionEvent {
  return {
    actionValue: { action: "create_group", taskId: 4339, sessionId: "session_test_card" },
    chatId: "oc_trigger_chat",
    messageId: "om_card_001",
    token: "token",
    ...overrides,
  };
}

/**
 * 把卡片上所有 markdown 段落拼起来（用于断言里程碑历史是否还在）
 *
 * ★ Task #4845：内容收在 collapsible_panel 里，这里递归扫进面板内部。
 */
function allMarkdown(card: any): string {
  const parts: string[] = [];
  const walk = (els: any[]): void => {
    for (const e of els ?? []) {
      if (e?.tag === "markdown" && typeof e.content === "string") {
        parts.push(e.content);
      } else if (e?.tag === "collapsible_panel" && Array.isArray(e.elements)) {
        walk(e.elements);
      }
    }
  };
  walk(card?.body?.elements ?? []);
  return parts.join("\n");
}

/** 卡片顶部按钮 */
function topButton(card: any): any {
  return (card?.body?.elements ?? []).find((e: any) => e.tag === "button");
}

// ============================================================================
// shellQuote（P1-2）
// ============================================================================

describe("shellQuote / Task #4339 P1-2", () => {
  it("普通字符串被单引号包裹", () => {
    expect(shellQuote("Task #4339 - 调研")).toBe("'Task #4339 - 调研'");
  });

  it("单引号被转义成 '\"'（不会提前闭合）", () => {
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it("双引号 / $ / 反引号 / 分号 都被中和（不再能破坏命令）", () => {
    const evil = `a"b$c\`d;e`;
    const quoted = shellQuote(evil);
    expect(quoted.startsWith("'")).toBe(true);
    expect(quoted.endsWith("'")).toBe(true);
    // 关键：内部不含裸的双引号 / $ / 反引号（整段都在单引号里，shell 不会展开）
    expect(quoted.slice(1, -1)).toBe(evil);
    expect(quoted.slice(1, -1)).not.toContain("'");
  });
});

// ============================================================================
// 卡片历史保留（P1-3）
// ============================================================================

describe("卡片重建保留里程碑历史 / Task #4339 P1-3", () => {
  let originalRunLarkCli: any;

  beforeEach(() => {
    // notifier 的 lark-cli 调用全部 mock 掉（我们只关心卡片内容与内部状态）
    originalRunLarkCli = (LarkCardPatchNotifier.prototype as any).runLarkCli;
    (LarkCardPatchNotifier.prototype as any).runLarkCli = mock(async () => {
      return JSON.stringify({ ok: true, data: { message_id: "om_card_001" } });
    });
  });

  afterEach(() => {
    (LarkCardPatchNotifier.prototype as any).runLarkCli = originalRunLarkCli;
  });

  it("updateMetaAndBuildCard 保留已累积的里程碑，并同步 state.meta（后续 updateTask 不会把链接抹掉）", async () => {
    const notifier = new LarkCardPatchNotifier({ pinOnStart: false });
    const { messageId } = await notifier.startTask({ chatId: "oc_chat", meta: makeTask() });

    // 累积两条里程碑
    await notifier.updateTask({
      messageId,
      status: "running",
      chatId: "oc_chat",
      milestones: [
        { title: "里程碑 A", timestamp: "2026-10-19T00:00:00Z" },
        { title: "里程碑 B", timestamp: "2026-10-19T01:00:00Z" },
      ],
    });

    const rebuilt = notifier.updateMetaAndBuildCard(messageId, {
      ...makeTask(),
      perTaskChatId: "oc_new_group",
      perTaskChatName: "Task #4339 - 专属群",
    });

    expect(rebuilt).toBeDefined();
    const md = allMarkdown(rebuilt);
    // ★ 核心断言：历史里程碑还在（旧实现只塞 1 条 "Task 创建"）
    expect(md).toContain("里程碑 A");
    expect(md).toContain("里程碑 B");
    // 按钮翻"解散" + 出现群链接
    expect(topButton(rebuilt).text.content).toBe("解散该群");
    expect(md).toContain("oc_new_group");

    // ★ 关键回归：下一次常规 updateTask（进度更新）不能把群链接抹掉
    const patched: any[] = [];
    (LarkCardPatchNotifier.prototype as any).runLarkCli = mock(async (_argv: string[], op: string) => {
      if (op === "patch") patched.push(_argv);
      return JSON.stringify({ ok: true, data: {} });
    });
    await notifier.updateTask({ messageId, status: "running", chatId: "oc_chat" });

    const lastPatchBody = JSON.parse(patched[patched.length - 1][
      patched[patched.length - 1].indexOf("--data") + 1
    ]);
    const card = JSON.parse(lastPatchBody.content);
    expect(topButton(card).text.content).toBe("解散该群");
    expect(allMarkdown(card)).toContain("oc_new_group");
  });

  it("clearPerTaskChat=true 时把群字段从 state.meta 真的删掉（解散路径）", async () => {
    const notifier = new LarkCardPatchNotifier({ pinOnStart: false });
    const { messageId } = await notifier.startTask({
      chatId: "oc_chat",
      meta: { ...makeTask(), perTaskChatId: "oc_old", perTaskChatName: "旧群" },
    });

    const rebuilt = notifier.updateMetaAndBuildCard(messageId, makeTask(), {
      clearPerTaskChat: true,
    });

    expect(topButton(rebuilt).text.content).toBe("为这个任务建群");
    expect(allMarkdown(rebuilt)).not.toContain("oc_old");
  });

  it("notifier 没有该 messageId 状态时返回 undefined（handler 走 fallback）", () => {
    const notifier = new LarkCardPatchNotifier();
    expect(notifier.updateMetaAndBuildCard("om_unknown", makeTask())).toBeUndefined();
  });

  it("handler 走 notifier 累积状态（端到端：按钮翻转 + 历史保留）", async () => {
    const notifier = new LarkCardPatchNotifier({ pinOnStart: false });
    const { messageId } = await notifier.startTask({ chatId: "oc_chat", meta: makeTask() });
    await notifier.updateTask({
      messageId,
      status: "running",
      chatId: "oc_chat",
      milestones: [{ title: "历史里程碑 X", timestamp: "2026-10-19T00:00:00Z" }],
    });

    const ports: CardActionPorts = {
      getTask: async () => makeTask(),
      updateTaskContext: async () => {},
      createGroupChat: async () => "oc_new_group",
      notifier,
    };

    const r = await handleCardAction(makeEvent({ messageId }), ports);
    expect(r.ok).toBe(true);
    expect(allMarkdown(r.cardUpdate)).toContain("历史里程碑 X");
    expect(topButton(r.cardUpdate).text.content).toBe("解散该群");
  });
});

// ============================================================================
// 飞书硬限制：+chat-create --name ≤ 60 / --description ≤ 100
// ============================================================================

describe("truncateText / Task #4339", () => {
  it("未超长时原样返回", () => {
    expect(truncateText("Task #1 - abc", 60)).toBe("Task #1 - abc");
  });

  it("超长时截断 + \"...\"，总长不超过 maxLen", () => {
    const long = "x".repeat(200);
    const out = truncateText(long, 60);
    expect(out.length).toBe(60);
    expect(out.endsWith("...")).toBe(true);
  });

  it("空串安全", () => {
    expect(truncateText("", 60)).toBe("");
  });

  it("超长任务标题 → createGroupChat 收到的 name ≤ 60 / description ≤ 100", async () => {
    __resetCardActionInflightForTest();
    let received: any;
    const ports: CardActionPorts = {
      getTask: async () => ({
        id: 4339,
        // 中文标题 + emoji，200 字符
        title: "超长标题".repeat(50),
        project_path: "/very/long/project/path/".repeat(10),
        context: "{}",
      }),
      updateTaskContext: async () => {},
      createGroupChat: async (opts) => {
        received = opts;
        return "oc_new";
      },
      notifier: { updateMetaAndBuildCard: () => undefined } as any,
    };

    const r = await handleCardAction(makeEvent(), ports);
    expect(r.ok).toBe(true);
    expect(received.name.length).toBeLessThanOrEqual(60);
    expect(received.description.length).toBeLessThanOrEqual(100);
    expect(received.name).toContain("Task #4339");
  });
});

// ============================================================================
// 双击竞态（P2-1）
// ============================================================================

describe("并发点击去重 / Task #4339 P2-1", () => {
  beforeEach(() => {
    __resetCardActionInflightForTest();
  });

  it("同一 (taskId, action) 的并发调用只建一次群，第二次 ok=false", async () => {
    let createCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });

    const ports: CardActionPorts = {
      getTask: async () => makeTask(),
      updateTaskContext: async () => {},
      createGroupChat: async () => {
        createCalls++;
        await gate; // 卡住第一次建群，模拟慢 IO
        return "oc_new_group";
      },
      notifier: {
        updateMetaAndBuildCard: () => undefined,
      } as any,
    };

    const first = handleCardAction(makeEvent(), ports);
    const second = await handleCardAction(makeEvent(), ports);

    expect(second.ok).toBe(false);
    expect(second.error).toContain("重复点击");

    release();
    const r1 = await first;
    expect(r1.ok).toBe(true);
    expect(createCalls).toBe(1);
  });

  it("不同 action 互不阻塞（create_group 与 disband_group 各自执行）", async () => {
    const created: string[] = [];
    const ports: CardActionPorts = {
      getTask: async () =>
        makeTask({
          context: JSON.stringify({
            larkPerTaskChatId: "oc_existing",
            larkPerTaskChatName: "群",
          }),
        }),
      updateTaskContext: async () => {},
      createGroupChat: async () => {
        created.push("create");
        return "oc_x";
      },
      deleteGroupChat: async () => {
        created.push("delete");
      },
      notifier: { updateMetaAndBuildCard: () => undefined } as any,
    };

    const [a, b] = await Promise.all([
      handleCardAction(makeEvent(), ports),
      handleCardAction(
        makeEvent({ actionValue: { action: "disband_group", taskId: 4339, sessionId: "session_test_card" } }),
        ports
      ),
    ]);

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(created).toEqual(["delete"]); // create 因已有群走幂等分支，不建群
  });

  it("上一次执行结束后，同 key 可以再次执行（in-flight 表被清理）", async () => {
    const ports: CardActionPorts = {
      getTask: async () =>
        makeTask({
          context: JSON.stringify({ larkPerTaskChatId: "oc_existing" }),
        }),
      notifier: { updateMetaAndBuildCard: () => undefined } as any,
    };

    const r1 = await handleCardAction(makeEvent(), ports);
    const r2 = await handleCardAction(makeEvent(), ports);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
  });
});

// ============================================================================
// 幂等命中（P2-2）
// ============================================================================

describe("已有专属群 = 幂等命中 / Task #4339 P2-2", () => {
  beforeEach(() => {
    __resetCardActionInflightForTest();
  });

  it("ok=true 且不重复建群，同时把卡片刷成有群形态", async () => {
    let createCalled = false;
    const ports: CardActionPorts = {
      getTask: async () =>
        makeTask({
          context: JSON.stringify({
            larkPerTaskChatId: "oc_existing",
            larkPerTaskChatName: "Task #4339 - 已有群",
          }),
        }),
      createGroupChat: async () => {
        createCalled = true;
        return "oc_should_not_be_used";
      },
      notifier: { updateMetaAndBuildCard: () => undefined } as any,
    };

    const r = await handleCardAction(makeEvent(), ports);

    expect(r.ok).toBe(true);
    expect(r.newChatId).toBe("oc_existing");
    expect(createCalled).toBe(false);
    expect(topButton(r.cardUpdate).text.content).toBe("解散该群");
    expect(allMarkdown(r.cardUpdate)).toContain("oc_existing");
  });

  it("无专属群时解散仍返回 ok=false（避免误解散）", async () => {
    const ports: CardActionPorts = {
      getTask: async () => makeTask({ context: "{}" }),
      deleteGroupChat: async () => {
        throw new Error("不该被调用");
      },
      notifier: { updateMetaAndBuildCard: () => undefined } as any,
    };

    const r = await handleCardAction(
      makeEvent({ actionValue: { action: "disband_group", taskId: 4339, sessionId: "session_test_card" } }),
      ports
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("无专属群");
  });
});
