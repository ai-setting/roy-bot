/**
 * Task #5403 — 关联建群全链路端到端（真实 SessionComponent + 真实卡片 handler）
 *
 * ## 为什么需要这条 E2E
 *
 * `group-session-link-5403.test.ts` 验证的是 SessionComponent 的契约，
 * `lark-card-group-session-only-5397.test.ts` 验证的是 handler 调了哪个端口 ——
 * 两边都用 mock 隔开了对方。中间**装配层**（event-source-handlers 把
 * `attachGroupSession` 端口接到 `SessionComponent.attachGroupSession`）没有测试
 * 覆盖。这条 E2E 用**真实** SessionComponent 手工装配同样的端口，跑完整链路：
 *
 *   点建群 → createGroupChat（mock 飞书）→ attachGroupSession（真实）→ 反查
 *
 * ## 锁定的行为（与 #5396 真机 bug 一一对应）
 *
 * 1. 建群后群 session 只有 **1 条** user 消息（#5396 时是 106 条历史 + 污染）
 * 2. 该消息明确指向原 session 并要求「按需读取」
 * 3. 群 session 与原 session **消息不共享**（不再透传）
 * 4. 重复点建群 ⇒ 幂等命中，不新建、不重复注入
 * 5. 解绑后反查不到（下次可以重新建群）
 * 6. 原 session 的消息数不受建群影响
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  handleCardAction,
  __resetCardActionInflightForTest,
  type CardActionEvent,
  type CardActionPorts,
} from "./lark-card-action-handler";
import type { LarkCardPatchNotifier } from "./lark-card-patch-notifier";
import { SessionComponent } from "../../session/session-component";
import { SQLiteSessionStore } from "../../session/storage";

const ORIGIN = "session_origin_e2e";
const noopNotifier = {} as LarkCardPatchNotifier;

let tmpDir: string;
let sc: SessionComponent;

/**
 * 按 event-source-handlers.ts 的**同款装配**注入三个端口
 * （attachGroupSession / findGroupChatForSession / detachGroupSession）。
 */
function wirePorts(extra: Partial<CardActionPorts> = {}): CardActionPorts {
  return {
    notifier: noopNotifier,
    attachGroupSession: async (args) => sc.attachGroupSession(args),
    findGroupChatForSession: async (sid) => sc.findGroupChatForSession(sid),
    detachGroupSession: async (chatId) => sc.detachGroupSession(chatId),
    ...extra,
  } as CardActionPorts;
}

function sessionOnlyEvent(action: "create_group" | "disband_group"): CardActionEvent {
  return {
    operatorId: "ou_e2e",
    messageId: "om_e2e",
    profile: "tongzhuli",
    actionValue: { action, sessionId: ORIGIN },
  } as unknown as CardActionEvent;
}

describe("Task #5403 E2E：建群 → 注入 1 条 event → 反查 → 解绑（真实 SQLite）", () => {
  beforeEach(async () => {
    __resetCardActionInflightForTest();
    tmpDir = mkdtempSync(path.join(tmpdir(), "e2e5403-"));
    sc = new SessionComponent();
    const store = new SQLiteSessionStore(path.join(tmpDir, "sessions.db"));
    await store.initialize();
    (sc as unknown as Record<string, unknown>).store = store;
    (sc as unknown as Record<string, unknown>).hooksConfig = {};

    // 原会话：先塞 30 条历史（建群后这些都不该出现在群 session 里）
    await sc.create({ id: ORIGIN, title: "原始会话" });
    for (let i = 0; i < 30; i++) {
      await sc.addMessage(ORIGIN, { role: i % 2 ? "assistant" : "user", content: `h${i}` });
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("E2E-1. 建群 ⇒ 群 session 只有 1 条 user 消息（不是 30 条历史）", async () => {
    const r = await handleCardAction(
      sessionOnlyEvent("create_group"),
      wirePorts({
        createGroupChat: async () => "oc_e2e_group",
        getSessionTitle: async () => "原始会话",
      })
    );

    expect(r.ok).toBe(true);
    expect(r.newChatId).toBe("oc_e2e_group");

    // ⭐ #5396 的核心回归：不是 30，是 1
    expect(await sc.getMessageCount("oc_e2e_group")).toBe(1);
    const msgs = await sc.getMessages("oc_e2e_group");
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toContain(ORIGIN);
    expect(msgs[0].content).toContain(`roy-bot sessions messages ${ORIGIN}`);

    // 原会话完全不受影响
    expect(await sc.getMessageCount(ORIGIN)).toBe(30);
  });

  test("E2E-2. 群 session 与原会话消息不共享（写入群不污染原会话）", async () => {
    await handleCardAction(
      sessionOnlyEvent("create_group"),
      wirePorts({ createGroupChat: async () => "oc_e2e_group2" })
    );

    await sc.addMessage("oc_e2e_group2", { role: "user", content: "群里问一句" });

    expect(await sc.getMessageCount("oc_e2e_group2")).toBe(2);
    expect(await sc.getMessageCount(ORIGIN)).toBe(30); // 原会话没多出这条
    const originMsgs = await sc.getMessages(ORIGIN);
    expect(originMsgs.some((m) => m.content === "群里问一句")).toBe(false);
  });

  test("E2E-3. 重复建群 ⇒ 幂等命中已有群，不新建、不重复注入", async () => {
    let createCalls = 0;
    const ports = () =>
      wirePorts({
        createGroupChat: async () => {
          createCalls++;
          return "oc_e2e_group3";
        },
      });

    await handleCardAction(sessionOnlyEvent("create_group"), ports());
    const r2 = await handleCardAction(sessionOnlyEvent("create_group"), ports());

    expect(r2.ok).toBe(true);
    expect(r2.newChatId).toBe("oc_e2e_group3");
    expect(createCalls).toBe(1); // 第二次没新建
    expect(await sc.getMessageCount("oc_e2e_group3")).toBe(1); // 也没重复注入
  });

  test("E2E-4. 解绑 ⇒ 反查不再命中，下次可重新建群", async () => {
    let createCalls = 0;
    const ports = () =>
      wirePorts({
        createGroupChat: async () => {
          createCalls++;
          return `oc_e2e_group4_${createCalls}`;
        },
        deleteGroupChat: async () => {},
      });

    await handleCardAction(sessionOnlyEvent("create_group"), ports());
    expect((await sc.findGroupChatForSession(ORIGIN))?.chatId).toBe("oc_e2e_group4_1");

    const d = await handleCardAction(sessionOnlyEvent("disband_group"), ports());
    expect(d.ok).toBe(true);
    expect(await sc.findGroupChatForSession(ORIGIN)).toBeUndefined();

    // 解绑后重新建群 ⇒ 真的新建了一个（不被死的旧群幂等命中）
    const again = await handleCardAction(sessionOnlyEvent("create_group"), ports());
    expect(again.newChatId).toBe("oc_e2e_group4_2");
    expect(createCalls).toBe(2);
  });
});
