/**
 * Task #5417 — 建群时同步卡片到新群（方案 A）
 *
 * ## 设计（用户定稿）
 *
 * - **方案 A**：新群 session 建自己的卡（session_id = 群 session id = chatId，
 *   符合 #5364 单卡规格：每 session 每 chat 一张卡）。
 *   不复制原卡（方案 B 会造成多卡同 session，违反单卡规格）。
 * - **双向同步**：原 sub-session 的进展事件 patch 时，通过
 *   `findGroupChatForSession`（metadata.linkedFromSessionId 反查）找到
 *   群 session，对新群卡再 upsert 一次（新群卡 state 独立累积）。
 *
 * ## 锁定的行为
 *
 * 1. session-only 建群成功 ⇒ 新群出现一张卡（sessionId = chatId）
 * 2. 原 session 进度事件（upsertSessionCard sessionId=原session）⇒
 *    新群卡也被 patch（双写，不重复发卡）
 * 3. 原卡语义不回归（原 session 卡仍只有一张）
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
import { __resetSharedLarkSessionCardStoreForTest } from "./lark-card-state-store";
import { SessionComponent } from "../../session/session-component";
import { SQLiteSessionStore } from "../../session/storage";

const ORIGIN = "session_5417_origin";
const CHAT = "oc_5417_group";

let tmpDir: string;
let sc: SessionComponent;

function sessionOnlyEvent(action: "create_group" | "disband_group"): CardActionEvent {
  return {
    operatorId: "ou_5417",
    messageId: "om_5417",
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

/** 记录 send/patch 调用（不真发 lark-cli） */
function attachRecorder(n: LarkCardPatchNotifier) {
  const sends: string[] = [];
  const patches: string[] = [];
  n.testRunner = async (argv, op) => {
    if (op === "send") {
      sends.push(argv.join(" "));
      return JSON.stringify({ ok: true, data: { message_id: `om_${sends.length}` } });
    }
    if (op === "patch") patches.push(argv.join(" "));
    return JSON.stringify({ ok: true });
  };
  return { sends, patches };
}

/** 从 send argv 里抠出 chatId（argv 是数组 join 的，--chat-id 后跟值） */
function chatIdOf(sendArgv: string): string | undefined {
  const m = sendArgv.match(/--chat-id (\S+)/);
  return m?.[1];
}

describe("Task #5417：建群 → 新群有自己的卡（方案 A）", () => {
  beforeEach(async () => {
    __resetCardActionInflightForTest();
    // ★ Task #5591：notifier 构造即回灌 session store ⇒ 共享内存
    //   store 也要一并重置（否则 T1 落库的新群卡被 T2 构造回灌，
    //   T2 建群 upsert 命中旧卡不再 send → 误红）。
    __resetSharedLarkSessionCardStoreForTest();
    tmpDir = mkdtempSync(path.join(tmpdir(), "e2e5417-"));
    sc = new SessionComponent();
    const store = new SQLiteSessionStore(path.join(tmpDir, "sessions.db"));
    await store.initialize();
    (sc as unknown as Record<string, unknown>).store = store;
    (sc as unknown as Record<string, unknown>).hooksConfig = {};
    await sc.create({ id: ORIGIN, title: "5417 原始会话" });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("T1. session-only 建群成功 ⇒ 新群出现一张卡（sessionId=chatId）", async () => {
    const notifier = new LarkCardPatchNotifier();
    const rec = attachRecorder(notifier);

    const r = await handleCardAction(
      sessionOnlyEvent("create_group"),
      wirePorts({ notifier, createGroupChat: async () => CHAT })
    );

    expect(r.ok).toBe(true);
    expect(r.newChatId).toBe(CHAT);
    // 新群恰好一张卡，发到新群 chat
    expect(rec.sends.length).toBe(1);
    expect(chatIdOf(rec.sends[0]!)).toBe(CHAT);
    // 卡的主键是群 session（= chatId），不是原 session
    expect(notifier.getSessionCardMessageId(CHAT)).toBe("om_1");
    // 原 session 不因此多卡
    expect(notifier.getSessionCardMessageId(ORIGIN)).toBeUndefined();
    // 卡上带群链接（#5414 语义不回归）
    expect(JSON.stringify(r.cardUpdate)).toContain("进入专属群");
  });

  test("T2. 原 session 进度事件 ⇒ 新群卡被 patch（双写，不重复发卡）", async () => {
    const notifier = new LarkCardPatchNotifier();
    const rec = attachRecorder(notifier);

    await handleCardAction(
      sessionOnlyEvent("create_group"),
      wirePorts({ notifier, createGroupChat: async () => CHAT })
    );
    expect(rec.sends.length).toBe(1);

    // 原 session 的进展事件（生命周期链真实形状）
    const patched = await notifier.upsertSessionCard({
      chatId: "oc_origin_chat",
      sessionId: ORIGIN,
      lifecycle: "running",
      milestones: [{ title: "进展更新", timestamp: new Date().toISOString() }],
    });
    expect(patched.created).toBe(true); // 原 session 自己的首卡

    // 双写：新群卡被 patch（不 send 第二张）
    await notifier.syncGroupCardFromOrigin(
      ORIGIN,
      {
        lifecycle: "running",
        milestones: [{ title: "进展更新", timestamp: new Date().toISOString() }],
      },
      async (sid) => sc.findGroupChatForSession(sid),
    );

    expect(rec.sends.length).toBe(2); // 新群首卡 + 原卡，共 2 张
    expect(rec.patches.length).toBeGreaterThanOrEqual(1); // 新群卡被 patch
    // patch 的目标 messageId = 新群卡的 messageId
    expect(rec.patches.some((p) => p.includes("om_1"))).toBe(true);
  });

  test("T3. 无关联群的原 session ⇒ 双写是 no-op（不报错）", async () => {
    const notifier = new LarkCardPatchNotifier();
    const rec = attachRecorder(notifier);
    // 不建群：直接双写
    await notifier.syncGroupCardFromOrigin(ORIGIN, { lifecycle: "running" });
    expect(rec.sends.length).toBe(0);
    expect(rec.patches.length).toBe(0);
  });

  test("T4. 注入的 user event 说明卡片同步语义", async () => {
    const { buildGroupLinkEventMessage } = await import("../../session/group-session-link");
    const ev = buildGroupLinkEventMessage({ originSessionId: ORIGIN, chatId: CHAT });
    expect(ev.role).toBe("user");
    expect(ev.content).toContain("卡片");
  });
});
