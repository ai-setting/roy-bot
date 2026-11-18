/**
 * Task #5414 — session-only 建群后卡片必须带「📨 进入专属群」applink
 *
 * ## 背景（用户 2026-11-12 22:16 反馈）
 *
 * 「建群后没有将群链接放到卡片上可以点击跳转到群里」。
 * 上轮定位结论：代码链路完整（#5403 没删渲染逻辑），盲区在 patch
 * 执行环节无观测。本测试锁定**渲染产物**这一环：
 *
 *   handleGroupActionSessionOnly → buildCardAfterSessionGroupChange
 *   → 产物 elements 必须含 `[📨 进入专属群](applink...chat_id=<chatId>)`
 *
 * 覆盖两个分支：
 *  - A. notifier 命中（applySessionGroupChange 返回保留状态的卡）
 *  - B. notifier 不认卡（fallback buildSessionCard 最小重建）
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
import { LarkCardPatchNotifier } from "./lark-card-patch-notifier";
import { SessionComponent } from "../../session/session-component";
import { SQLiteSessionStore } from "../../session/storage";

const ORIGIN = "session_5414_origin";
const CHAT = "oc_5414_group";

let tmpDir: string;
let sc: SessionComponent;

function sessionOnlyEvent(action: "create_group" | "disband_group"): CardActionEvent {
  return {
    operatorId: "ou_5414",
    messageId: "om_5414",
    profile: "tongzhuli",
    actionValue: { action, sessionId: ORIGIN },
  } as unknown as CardActionEvent;
}

function wirePorts(extra: Partial<CardActionPorts> = {}): CardActionPorts {
  return {
    attachGroupSession: async (args) => sc.attachGroupSession(args),
    findGroupChatForSession: async (sid) => sc.findGroupChatForSession(sid),
    detachGroupSession: async (chatId) => sc.detachGroupSession(chatId),
    ...extra,
  } as CardActionPorts;
}

/** 在卡片 payload 的 elements 里找「进入专属群」markdown 节点 */
function findGroupLink(card: { body?: { elements?: unknown[] } } | undefined) {
  const elements = card?.body?.elements ?? [];
  const flat = JSON.stringify(elements);
  const hit = /进入专属群/.test(flat);
  const applink = flat.match(/applink[^"]*openChatId=([^"&\\)]+)/);
  return { hit, chatId: applink?.[1] };
}

describe("Task #5414：建群后卡片渲染「进入专属群」applink", () => {
  beforeEach(async () => {
    __resetCardActionInflightForTest();
    tmpDir = mkdtempSync(path.join(tmpdir(), "e2e5414-"));
    sc = new SessionComponent();
    const store = new SQLiteSessionStore(path.join(tmpDir, "sessions.db"));
    await store.initialize();
    (sc as unknown as Record<string, unknown>).store = store;
    (sc as unknown as Record<string, unknown>).hooksConfig = {};
    await sc.create({ id: ORIGIN, title: "5414 原始会话" });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("A. notifier 命中分支：建群后卡上有「进入专属群」且指向新群", async () => {
    // 真实 notifier：先发一张 session 卡（让 notifier 记住 om_5414 的状态）
    const notifier = new LarkCardPatchNotifier();
    notifier.rememberSessionCard?.("om_5414", {
      sessionId: ORIGIN,
      title: "5414 原始会话",
    });

    const r = await handleCardAction(
      sessionOnlyEvent("create_group"),
      wirePorts({
        notifier,
        createGroupChat: async () => CHAT,
      })
    );

    expect(r.ok).toBe(true);
    expect(r.newChatId).toBe(CHAT);
    const link = findGroupLink(r.cardUpdate);
    expect(link.hit).toBe(true);
    expect(link.chatId).toBe(CHAT);
  });

  test("B. fallback 分支（notifier 不认卡）：产物同样带 applink", async () => {
    const r = await handleCardAction(
      sessionOnlyEvent("create_group"),
      wirePorts({
        notifier: {} as LarkCardPatchNotifier, // applySessionGroupChange 缺失 ⇒ fallback
        createGroupChat: async () => CHAT,
      })
    );

    expect(r.ok).toBe(true);
    const link = findGroupLink(r.cardUpdate);
    expect(link.hit).toBe(true);
    expect(link.chatId).toBe(CHAT);
  });

  test("C. 重复建群（幂等命中）返回的卡同样带 applink", async () => {
    let createCalls = 0;
    const ports = () =>
      wirePorts({
        notifier: {} as LarkCardPatchNotifier,
        createGroupChat: async () => {
          createCalls++;
          return CHAT;
        },
      });

    await handleCardAction(sessionOnlyEvent("create_group"), ports());
    const r2 = await handleCardAction(sessionOnlyEvent("create_group"), ports());
    expect(createCalls).toBe(1);
    const link = findGroupLink(r2.cardUpdate);
    expect(link.hit).toBe(true);
    expect(link.chatId).toBe(CHAT);
  });

  test("D. 解绑后产物不含「进入专属群」链接", async () => {
    const ports = () =>
      wirePorts({
        notifier: {} as LarkCardPatchNotifier,
        createGroupChat: async () => CHAT,
        deleteGroupChat: async () => {},
      });

    await handleCardAction(sessionOnlyEvent("create_group"), ports());
    const d = await handleCardAction(sessionOnlyEvent("disband_group"), ports());
    expect(d.ok).toBe(true);
    const flat = JSON.stringify(d.cardUpdate);
    expect(/进入专属群/.test(flat)).toBe(false);
    expect(await sc.findGroupChatForSession(ORIGIN)).toBeUndefined();
  });
});
