/**
 * Task #5403 — 关联建群：**独立 session + 1 条 user role event 注入**
 *
 * ## 背景（为什么推翻 #5369/#5397 的 alias 方案）
 *
 * #5369 让群 session 成为原 sub-session 的 alias（消息透传、视图一致）。
 * 用户实测（#5396）后定稿废弃，原因有两条：
 *
 *  1. **LLM prefix cache 失效**：群 session 由 default agent 的 system prompt
 *     驱动，原 sub session 由 sub agent 驱动。复用 history ⇒ prefix 不同 ⇒
 *     全部重新 prefill。
 *  2. **语义污染**：sub agent 的 delegate prompt 里有「不要发飞书消息（回复由
 *     主 agent 负责）」。这些约束在群的历史里被当成**当前生效指令** ⇒ 群里的
 *     agent 真的不回复（#5396 实测 bot 出站 0 条）。
 *
 * ## 新方案（用户原话）
 *
 * > 「其实应该还是不 linkTo，但是如果是关联建群应该默认往新 session 中填充
 * >  一个 event：原 subSession 作为对话基础建了关联群来追踪，可以通过
 * >  `roy-bot sessions messages {subSession}` 来读取最近的消息作为背景。」
 *
 * ## 本文件锁定的契约
 *
 * ### A. 纯函数（内容 / metadata 形状）
 * 1. 注入事件 role = **user**（不是 system / assistant）
 * 2. 内容含原 session id + `roy-bot sessions messages <id>` 命令提示
 * 3. 内容显式声明「历史不在本群上下文中」+ 「任务型约束只对当时那轮生效」
 * 4. metadata 同时含 chatId / type=lark-chat / linkedFromSessionId / groupCreatedAt
 *
 * ### B. SessionComponent.attachGroupSession（真实 store，双后端）
 * 5. 新群 session 只有 **1 条**消息（不复制历史）—— 即使原 session 有 50 条
 * 6. 该消息 role = user
 * 7. metadata 登记 linkedFromSessionId = 原 session
 * 8. **幂等**：重复 attach 不重复注入（injected=false，消息数仍为 1）
 *
 * ### C. 反向查询 findGroupChatForSession（metadata 版）
 * 9. 给定原 sessionId ⇒ 反查到群 chatId
 * 10. 在群 session 自称上调用 ⇒ 也返回同一个群（供「群里点解散」）
 * 11. 未关联的 session ⇒ undefined
 * 12. **解绑后不再命中**（detachGroupSession 打标记）
 *
 * ### D. 回归护栏：alias 能力必须彻底消失
 * 13. `SessionComponent.linkSession` / `unlinkSession` / `resolveSessionId` /
 *     `getAliases` 全都不存在（能力已删，不是隐藏）
 * 14. `Session` 类型不再有 `linkedTo` 字段
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  buildGroupLinkEventMessage,
  buildGroupSessionMetadata,
  isGroupDisbanded,
  isGroupSessionOf,
  GROUP_LINK_METADATA_KEYS,
} from "./group-session-link";
import { SessionComponent } from "./session-component";
import { MemorySessionStore, SQLiteSessionStore } from "./storage";

const ORIGIN = "session_origin_5403";
const CHAT = "oc_group_5403";

// ============================================================================
// A. 纯函数
// ============================================================================
describe("Task #5403 / A. 注入事件与 metadata 形状", () => {
  test("A1. role 是 user（与 notify event / 飞书 event 注入方式一致）", () => {
    const ev = buildGroupLinkEventMessage({ originSessionId: ORIGIN, chatId: CHAT });
    expect(ev.role).toBe("user");
  });

  test("A2. 内容含原 session id + sessions messages 命令提示", () => {
    const ev = buildGroupLinkEventMessage({ originSessionId: ORIGIN, chatId: CHAT });
    expect(ev.content).toContain(ORIGIN);
    expect(ev.content).toContain(`roy-bot sessions messages ${ORIGIN}`);
    // 建议按需读取，不要全量
    expect(ev.content).toContain("-n 50");
  });

  test("A3. 显式声明历史不在上下文 + 任务型约束只对当时那轮生效", () => {
    const ev = buildGroupLinkEventMessage({ originSessionId: ORIGIN });
    expect(ev.content).toContain("不在");
    expect(ev.content).toContain("历史");
    // 防 #5396 污染复发的关键一句
    expect(ev.content).toMatch(/只对当时那一轮生效/);
  });

  test("A4. metadata 四条标记齐备（含 base 合并、不覆盖 chatId）", () => {
    const md = buildGroupSessionMetadata({
      chatId: CHAT,
      originSessionId: ORIGIN,
      base: { chatId: "stale", extra: 1 },
    });
    expect(md.chatId).toBe(CHAT); // 覆盖优先级正确
    expect(md.type).toBe("lark-chat");
    expect(md[GROUP_LINK_METADATA_KEYS.linkedFromSessionId]).toBe(ORIGIN);
    expect(typeof md[GROUP_LINK_METADATA_KEYS.groupCreatedAt]).toBe("string");
    expect(md.extra).toBe(1); // base 其它字段保留
  });

  test("A5. isGroupSessionOf 三条 marker 缺一不认", () => {
    const ok = {
      chatId: CHAT,
      type: "lark-chat",
      linkedFromSessionId: ORIGIN,
    };
    expect(isGroupSessionOf(ok, ORIGIN)).toBe(true);
    expect(isGroupSessionOf(ok, "session_other")).toBe(false);
    expect(isGroupSessionOf({ ...ok, type: "cli-chat" }, ORIGIN)).toBe(false);
    expect(isGroupSessionOf({ ...ok, chatId: "  " }, ORIGIN)).toBe(false);
    expect(isGroupSessionOf({ ...ok, linkedFromSessionId: undefined }, ORIGIN)).toBe(false);
  });

  test("A6. isGroupDisbanded 只在 groupDisbandedAt 非空时为真", () => {
    expect(isGroupDisbanded({})).toBe(false);
    expect(isGroupDisbanded(undefined)).toBe(false);
    expect(isGroupDisbanded({ groupDisbandedAt: " " })).toBe(false);
    expect(isGroupDisbanded({ groupDisbandedAt: "2026-11-12T00:00:00Z" })).toBe(true);
  });
});

// ============================================================================
// B + C. SessionComponent（Memory 与 SQLite 双后端跑同一套断言）
// ============================================================================
type Backend = {
  name: string;
  make: () => Promise<{ component: SessionComponent; cleanup: () => void }>;
};

/**
 * 与 session-component.test.ts 同款装配：直接注入 store（SessionComponent 不在
 * 构造时接受 storage 配置，由 Environment 负责装配）。
 */
function makeBackends(): Backend[] {
  return [
    {
      name: "Memory",
      make: async () => {
        const component = new SessionComponent();
        const store = new MemorySessionStore();
        await store.initialize?.();
        (component as unknown as Record<string, unknown>).store = store;
        (component as unknown as Record<string, unknown>).hooksConfig = {};
        return { component, cleanup: () => {} };
      },
    },
    {
      name: "SQLite",
      make: async () => {
        const tmp = mkdtempSync(path.join(tmpdir(), "s5403-"));
        const component = new SessionComponent();
        const store = new SQLiteSessionStore(path.join(tmp, "sessions.db"));
        await store.initialize();
        (component as unknown as Record<string, unknown>).store = store;
        (component as unknown as Record<string, unknown>).hooksConfig = {};
        return {
          component,
          cleanup: () => rmSync(tmp, { recursive: true, force: true }),
        };
      },
    },
  ];
}

for (const backend of makeBackends()) {
  describe(`Task #5403 / B+C. attachGroupSession + 反查（${backend.name}）`, () => {
    let sc: SessionComponent;
    let cleanup: () => void;

    beforeEach(async () => {
      const made = await backend.make();
      sc = made.component;
      cleanup = made.cleanup;
    });

    afterEach(() => {
      cleanup();
    });

    test("B1. 新群 session 只有 1 条消息（不复制原会话历史）", async () => {
      // 原会话先塞 50 条历史 —— 新方案下这些必须**一条都不出现在群 session**
      const origin = await sc.create({ id: ORIGIN, title: "origin" });
      for (let i = 0; i < 50; i++) {
        await sc.addMessage(origin.id, { role: "user", content: `history-${i}` });
      }
      expect(await sc.getMessageCount(ORIGIN)).toBe(50);

      const r = await sc.attachGroupSession({ chatId: CHAT, originSessionId: ORIGIN });
      expect(r.ok).toBe(true);

      // ⭐ 核心断言：1 条（注入事件），不是 51 条
      expect(await sc.getMessageCount(CHAT)).toBe(1);
      // 原会话不受影响
      expect(await sc.getMessageCount(ORIGIN)).toBe(50);
    });

    test("B2. 注入消息 role = user，且内容指向原 session", async () => {
      await sc.create({ id: ORIGIN, title: "origin" });
      await sc.attachGroupSession({ chatId: CHAT, originSessionId: ORIGIN });

      const msgs = await sc.getMessages(CHAT);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].role).toBe("user");
      expect(msgs[0].content).toContain(ORIGIN);
    });

    test("B3. metadata 登记 linkedFromSessionId + chatId + type", async () => {
      await sc.create({ id: ORIGIN, title: "origin" });
      await sc.attachGroupSession({ chatId: CHAT, originSessionId: ORIGIN });

      const group = await sc.get(CHAT);
      expect(group).toBeDefined();
      const md = group!.metadata as Record<string, unknown>;
      expect(md[GROUP_LINK_METADATA_KEYS.linkedFromSessionId]).toBe(ORIGIN);
      expect(md.chatId).toBe(CHAT);
      expect(md.type).toBe("lark-chat");
    });

    test("B4. 幂等：重复 attach 不重复注入（仍 1 条）", async () => {
      await sc.create({ id: ORIGIN, title: "origin" });
      const r1 = await sc.attachGroupSession({ chatId: CHAT, originSessionId: ORIGIN });
      const r2 = await sc.attachGroupSession({ chatId: CHAT, originSessionId: ORIGIN });

      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect((r1 as { injected: boolean }).injected).toBe(true);
      expect((r2 as { injected: boolean }).injected).toBe(false);
      expect(await sc.getMessageCount(CHAT)).toBe(1);
    });

    test("B5. 已存在的 chat-keyed session（事件层先建过）⇒ 只补 metadata 不重建", async () => {
      await sc.create({ id: ORIGIN, title: "origin" });
      // 模拟 ensureChatSession 先建好群 session（带 chatId/type，无 linkedFrom）
      await sc.create({
        id: CHAT,
        title: "Lark Chat",
        metadata: { chatId: CHAT, type: "lark-chat" },
      });

      const r = await sc.attachGroupSession({ chatId: CHAT, originSessionId: ORIGIN });
      expect(r.ok).toBe(true);

      const group = await sc.get(CHAT);
      const md = group!.metadata as Record<string, unknown>;
      expect(md[GROUP_LINK_METADATA_KEYS.linkedFromSessionId]).toBe(ORIGIN);
      expect(md.chatId).toBe(CHAT); // 未被破坏
      expect(await sc.getMessageCount(CHAT)).toBe(1);
    });

    test("C1. 反查：给定原 sessionId ⇒ 找到群 chatId", async () => {
      await sc.create({ id: ORIGIN, title: "origin" });
      await sc.attachGroupSession({ chatId: CHAT, originSessionId: ORIGIN });

      const r = await sc.findGroupChatForSession(ORIGIN);
      expect(r?.chatId).toBe(CHAT);
    });

    test("C2. 在群 session 自称上调用 ⇒ 也返回同一个群（群里点解散用）", async () => {
      await sc.create({ id: ORIGIN, title: "origin" });
      await sc.attachGroupSession({ chatId: CHAT, originSessionId: ORIGIN });

      const r = await sc.findGroupChatForSession(CHAT);
      expect(r?.chatId).toBe(CHAT);
    });

    test("C3. 未关联的 session ⇒ undefined", async () => {
      await sc.create({ id: "session_plain", title: "plain" });
      expect(await sc.findGroupChatForSession("session_plain")).toBeUndefined();
    });

    test("C4. 解绑后反查不再命中（防幂等命中死群）", async () => {
      await sc.create({ id: ORIGIN, title: "origin" });
      await sc.attachGroupSession({ chatId: CHAT, originSessionId: ORIGIN });
      expect((await sc.findGroupChatForSession(ORIGIN))?.chatId).toBe(CHAT);

      const d = await sc.detachGroupSession(CHAT);
      expect(d.ok).toBe(true);

      expect(await sc.findGroupChatForSession(ORIGIN)).toBeUndefined();
      // 在群自称上也不再命中
      expect(await sc.findGroupChatForSession(CHAT)).toBeUndefined();
    });

    test("C5. detach 幂等（重复解绑不报错）", async () => {
      await sc.create({ id: ORIGIN, title: "origin" });
      await sc.attachGroupSession({ chatId: CHAT, originSessionId: ORIGIN });
      expect((await sc.detachGroupSession(CHAT)).ok).toBe(true);
      expect((await sc.detachGroupSession(CHAT)).ok).toBe(true);
    });
  });
}

// ============================================================================
// D. 回归护栏：alias 能力必须彻底消失
// ============================================================================
describe("Task #5403 / D. alias 能力已整体删除", () => {
  test("D1. SessionComponent 不再暴露 linkSession / unlinkSession / resolveSessionId / getAliases", async () => {
    const sc = new SessionComponent();
    (sc as unknown as Record<string, unknown>).store = new MemorySessionStore();

    const anySc = sc as unknown as Record<string, unknown>;
    expect(anySc.linkSession).toBeUndefined();
    expect(anySc.unlinkSession).toBeUndefined();
    expect(anySc.createLinked).toBeUndefined();
    expect(anySc.resolveSessionId).toBeUndefined();
    expect(anySc.getAliases).toBeUndefined();
  });

  test("D2. Session 对象不再带 linkedTo 字段（新建的 session 上取不到）", async () => {
    const sc = new SessionComponent();
    (sc as unknown as Record<string, unknown>).store = new MemorySessionStore();
    const s = await sc.create({ id: "s_no_link", title: "t" });
    expect((s as unknown as Record<string, unknown>).linkedTo).toBeUndefined();
  });

  test("D3. store 层不再有 excludeAliases / filter.linkedTo 语义（传了也不生效）", async () => {
    const store = new MemorySessionStore();
    await store.create({ id: "x1", title: "a" });
    // 传遗留选项不应改变结果集（类型上已删除，这里强转验证运行时忽略）
    const rows = await store.list({ excludeAliases: true } as never);
    expect(rows.map((s) => s.id)).toEqual(["x1"]);
  });
});
