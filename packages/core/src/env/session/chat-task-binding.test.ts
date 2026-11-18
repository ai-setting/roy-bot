/**
 * @fileoverview SessionComponent Chat-Task Binding Tests
 *
 * Task #4023: 在 SessionComponent 上新增 upsertChatTaskBinding / getChatTaskBinding
 * 方法，让 chat_id 维度的 session metadata 携带 task_id（反向绑定）。
 *
 * 单元测试覆盖：
 * 1. 首次绑定 → 新建 session + larkChat 元数据
 * 2. 二次绑定同一 chat → upsert + status 更新
 * 3. 绑定不同 task → rebindCount 递增 + warn（不覆盖）
 * 4. getChatTaskBinding 未绑定返回 null
 * 5. failed 状态可被 rebind 覆盖（标记 retry）
 * 6. 绑定失败时不抛错（用户态感知）
 */

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { SessionComponent } from "./session-component";
import { MemorySessionStore } from "./storage/memory";
import type { ChatTaskBinding, UpsertChatTaskBindingOptions } from "./types";

describe("SessionComponent chat-task binding (Task #4023)", () => {
  let component: SessionComponent;
  let store: MemorySessionStore;

  beforeEach(() => {
    component = new SessionComponent();
    store = new MemorySessionStore();
    (component as any).store = store;
    (component as any).hooksConfig = {};
  });

  describe("upsertChatTaskBinding", () => {
    it("首次绑定：新建 session 并写入 larkChat 元数据", async () => {
      const opts: UpsertChatTaskBindingOptions = {
        chatId: "oc_first_chat",
        taskId: 100,
        profile: "default",
      };

      const binding = await component.upsertChatTaskBinding(opts);

      expect(binding.chatId).toBe("oc_first_chat");
      expect(binding.taskId).toBe(100);
      expect(binding.profile).toBe("default");
      expect(binding.status).toBe("ready");
      expect(binding.rebindCount).toBe(0);
      expect(binding.boundAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // session 应已创建
      const session = await component.get("oc_first_chat");
      expect(session).toBeDefined();
      expect(session!.metadata?.larkChat).toBeDefined();
    });

    it("二次绑定同一 chat：upsert 更新 status & boundAt，不重复创建 session", async () => {
      await component.upsertChatTaskBinding({
        chatId: "oc_second_chat",
        taskId: 200,
        profile: "default",
      });
      const firstBoundAt = (await component.getChatTaskBinding("oc_second_chat"))!.boundAt;

      // sleep 5ms 确保 timestamp 不同
      await new Promise((r) => setTimeout(r, 5));

      const updated = await component.upsertChatTaskBinding({
        chatId: "oc_second_chat",
        taskId: 200,
        profile: "default",
        status: "ready",
      });

      expect(updated.taskId).toBe(200);
      expect(updated.status).toBe("ready");
      expect(updated.rebindCount).toBe(0);
      // boundAt 应该是新的（被覆盖）
      expect(updated.boundAt).not.toBe(firstBoundAt);
    });

    it("绑定不同 taskId：rebindCount++ 并记录，但不覆盖 taskId（防数据丢失）", async () => {
      await component.upsertChatTaskBinding({
        chatId: "oc_rebind_chat",
        taskId: 300,
        profile: "default",
      });

      const rebinding = await component.upsertChatTaskBinding({
        chatId: "oc_rebind_chat",
        taskId: 999, // 不同 taskId
        profile: "default",
      });

      // 仍保留原 taskId（防误覆盖）
      expect(rebinding.taskId).toBe(300);
      // 但 rebindCount 应增加
      expect(rebinding.rebindCount).toBe(1);

      // 内部状态应标记
      expect(rebinding.status).toBe("ready");
    });

    it("failed 状态可被同 taskId 的新一次 ready 覆盖（视为重试成功）", async () => {
      await component.upsertChatTaskBinding({
        chatId: "oc_retry_chat",
        taskId: 400,
        profile: "default",
        status: "failed",
        errorMessage: "lark-cli timeout",
      });

      const retried = await component.upsertChatTaskBinding({
        chatId: "oc_retry_chat",
        taskId: 400, // 相同 taskId → 视为重试
        profile: "default",
        status: "ready",
      });

      expect(retried.status).toBe("ready");
      expect(retried.taskId).toBe(400);
    });

    it("并发绑定同一 chatId：串行化，不丢 rebind（TOCTOU 修复）", async () => {
      const [first, second] = await Promise.all([
        component.upsertChatTaskBinding({ chatId: "oc_race", taskId: 100 }),
        component.upsertChatTaskBinding({ chatId: "oc_race", taskId: 200 }),
      ]);

      // 先获得锁的 taskId=100 保留；后者触发 rebind，不覆盖 taskId
      expect(first.taskId).toBe(100);
      expect(first.rebindCount).toBe(0);
      expect(second.taskId).toBe(100);
      expect(second.rebindCount).toBe(1);

      const stored = await component.getChatTaskBinding("oc_race");
      expect(stored!.taskId).toBe(100);
      expect(stored!.rebindCount).toBe(1);
    });

    it("空 chatId：抛错", async () => {
      await expect(
        component.upsertChatTaskBinding({
          chatId: "",
          taskId: 500,
        })
      ).rejects.toThrow(/chatId/);
    });

    it("taskId 非正整数：抛错", async () => {
      await expect(
        component.upsertChatTaskBinding({
          chatId: "oc_bad",
          taskId: 0,
        })
      ).rejects.toThrow(/taskId/);

      await expect(
        component.upsertChatTaskBinding({
          chatId: "oc_bad",
          taskId: -1,
        })
      ).rejects.toThrow(/taskId/);
    });
  });

  describe("getChatTaskBinding", () => {
    it("未绑定：返回 null", async () => {
      const binding = await component.getChatTaskBinding("oc_nonexistent");
      expect(binding).toBeNull();
    });

    it("已绑定：返回 ChatTaskBinding 对象", async () => {
      await component.upsertChatTaskBinding({
        chatId: "oc_lookup",
        taskId: 600,
        profile: "default",
      });

      const binding = await component.getChatTaskBinding("oc_lookup");
      expect(binding).not.toBeNull();
      expect(binding!.taskId).toBe(600);
      expect(binding!.status).toBe("ready");
    });

    it("session 存在但 metadata.larkChat 不存在：返回 null（向后兼容）", async () => {
      // 手动建一个不含 larkChat 的 session
      await component.create({
        id: "oc_legacy",
        title: "Legacy session",
        metadata: { messageCount: 0 },
      });

      const binding = await component.getChatTaskBinding("oc_legacy");
      expect(binding).toBeNull();
    });
  });

  describe("缓存行为", () => {
    it("upsert 后 60s 内 getChatTaskBinding 不重复打 DB（缓存命中）", async () => {
      let getCalls = 0;
      const realGet = store.get.bind(store);
      store.get = mock(async (id: string) => {
        getCalls++;
        return realGet(id);
      });
      (component as any).store = store;

      await component.upsertChatTaskBinding({
        chatId: "oc_cache",
        taskId: 700,
        profile: "default",
      });

      // 重置 mock 让后续 get 调用被计数
      getCalls = 0;

      // 多次读应命中缓存
      for (let i = 0; i < 5; i++) {
        await component.getChatTaskBinding("oc_cache");
      }

      // 缓存命中应 < 5 次（理想 1 次回源 + 4 次缓存）
      expect(getCalls).toBeLessThanOrEqual(2);
    });
  });
});