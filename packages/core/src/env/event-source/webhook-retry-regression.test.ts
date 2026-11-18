/**
 * @fileoverview Webhook 重投回归测试（Task #4137）
 *
 * 根因（Task #4136 已诊断完成，详见 /tmp/webhook-retry-debug.md）：
 *   P0 出站以 user 身份发送 → 自我回灌
 *   P1 重发无幂等 + json.load PARSE FAIL 假失败
 *   P2 入站去重过窄 + 双 plugin 双发
 *
 * 自回灌的修复策略是**从源头切断**：所有出站一律 `--as bot`
 * （bot 自己发出的消息不会被本 app 的事件订阅回投）。不再记录已发送
 * message_id 做入口兜底（依赖 parse stdout，脆弱且收益低）。
 *
 * 本测试覆盖 3 个层：
 *   (A) P0 prompt 守卫：buildLarkRecommendedAction 必须告诉 LLM 强制 --as bot，
 *       并警告不要走 api POST 路径（默认 identity=user）。
 *   (C) P2 跨实例去重：同一进程内多个 LarkCliInstance 应共享 SHARED_SEEN Map，
 *       重复 event_id 跨实例也应被去重。
 *   (D) P1 prompt 成功判定：buildLarkRecommendedAction 必须显式禁止用
 *       python json.load / json.tool 解析 lark-cli 发送响应；改判 exit code。
 */

import { describe, test, expect, beforeEach } from "bun:test";
import { buildLarkRecommendedAction, LarkCliInstance } from "./event-source-handlers";
import type { EventSourceConfig } from "./types";
import { PerTaskGroupChatPlugin } from "../task/plugins/per-task-group-chat-plugin";
import { LarkCliTaskNotifyHook } from "../task/plugins/lark-cli-task-notify-plugin";
import { LarkCardPatchNotifier } from "../task/plugins/lark-card-patch-notifier";

describe("Webhook 重复通知回归（Task #4137）", () => {
  // ────────────────────────────────────────────────────────────────────
  // P0 — prompt 守卫：必须强制 --as bot，警告不要走 user-identity 路径
  // ────────────────────────────────────────────────────────────────────
  describe("P0 prompt 必须强制 --as bot + 警告 user-identity 回灌", () => {
    test("prompt 出现 '--as bot' 强制指令", () => {
      const { action } = buildLarkRecommendedAction({
        profile: "tongzhuli",
        chatType: "group",
        appId: "cli_aXXXXXXXXXXXXXX",
        chatId: "oc_6bc538acf41894300cf8da037f9f7cd0",
        messageId: "om_x100b63ee7efb8cacb18909655fcba6f",
      });
      expect(action).toContain("--as bot");
      expect(action).toMatch(/必须\s*--as\s*bot|--as\s*bot\s*强制|显式\s*--as\s*bot/);
    });

    test("prompt 警告 'api POST' 是 user-identity 路径，会自我回灌", () => {
      const { action } = buildLarkRecommendedAction({
        profile: "tongzhuli",
        chatType: "group",
        appId: "cli_aXXXXXXXXXXXXXX",
        chatId: "oc_6bc538acf41894300cf8da037f9f7cd0",
        messageId: "om_x100b63ee7efb8cacb18909655fcba6f",
      });
      expect(action).toMatch(/api\s+POST|api\s+POST|open-apis\/im\/v1\/messages/);
      expect(action).toMatch(/identity\s*=\s*user|user-identity|user\s*身份/);
      expect(action).toMatch(/回灌|自我|self.echo|self-echo/);
    });

    test("prompt 必须给出带 --as bot 的完整命令模板（reply + send 两条路径）", () => {
      const { action } = buildLarkRecommendedAction({
        profile: "tongzhuli",
        chatType: "group",
        appId: "cli_aXXXXXXXXXXXXXX",
        chatId: "oc_6bc538acf41894300cf8da037f9f7cd0",
        messageId: "om_x100b63ee7efb8cacb18909655fcba6f",
      });
      // reply 模板必须把 --as bot 写死在命令里
      expect(action).toMatch(/messages-reply[\s\S]*?--as bot/);
      // send 模板同样
      expect(action).toMatch(/messages-send[\s\S]*?--as bot/);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // P2 跨实例去重 — 通过注入多个 LarkCliInstance + 重复 event_id
  // ────────────────────────────────────────────────────────────────────
  describe("P2 跨实例去重", () => {
    let config: EventSourceConfig;
    let dispatched: number[];

    const makeHandler = () => {
      const idx = dispatched.length;
      dispatched.push(0);
      return () => {
        dispatched[idx]++;
      };
    };

    beforeEach(() => {
      dispatched = [];
      config = {
        id: "es-webhook-retry-regression",
        name: "webhook retry regression",
        enabled: true,
        type: "lark-cli",
        command: "lark-cli --profile tongzhuli event consume im.message.receive_v1 --as bot",
      };
      // SHARED_SEEN 是模块级静态状态，测试间必须重置避免污染
      LarkCliInstance.__resetDedupForTest();
    });

    function makeRawData(eventId: string, messageId?: string): string {
      return JSON.stringify({
        type: "im.message.receive_v1",
        event_id: eventId,
        timestamp: "1791854640000",
        message_id: messageId ?? `om_${eventId}`,
        chat_id: "oc_6bc538acf41894300cf8da037f9f7cd0",
        chat_type: "group",
        message_type: "text",
        sender_id: "ou_1759934f98e0677e17f09591389c24f1",
        sender_type: "user",
        content: "调研报告",
      });
    };

    /**
     * 触发 handleEvent 异步；fire-and-forget 后等待 dispatch 完成。
     */
    async function feedEvent(instance: LarkCliInstance, raw: string) {
      await (instance as any).handleEvent(raw);
    }

    test("P2 跨实例去重：同一 event_id 在 instance A 处理过 → instance B 也应抑制", async () => {
      const instanceA = new LarkCliInstance(config);
      const instanceB = new LarkCliInstance(config);
      instanceA.onEvent(makeHandler());
      instanceB.onEvent(makeHandler());

      const raw = makeRawData("evt_shared_dedup_xyz");

      await feedEvent(instanceA, raw);
      await feedEvent(instanceB, raw); // 期望：被去重，dispatched[1] === 0

      expect(dispatched[0]).toBe(1);
      expect(dispatched[1]).toBe(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // P1 — prompt 成功判定：禁止用 python json.load 解析 lark-cli 响应
  // ────────────────────────────────────────────────────────────────────
  describe("P1 prompt 成功判定只看 exit code", () => {
    test("prompt 必须显式禁止 python json.load / json.tool 解析发送响应", () => {
      const { action } = buildLarkRecommendedAction({
        profile: "tongzhuli",
        chatType: "group",
        appId: "cli_aXXXXXXXXXXXXXX",
        chatId: "oc_6bc538acf41894300cf8da037f9f7cd0",
        messageId: "om_x100b63ee7efb8cacb18909655fcba6f",
      });
      // 禁止 json.load
      expect(action).toMatch(/禁止.*json\.load|json\.tool.*禁止/);
      // 必须显式提"exit code"作为成功判定
      expect(action).toMatch(/exit\s*code|退出码/);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Task #4230 — 旧普通消息通知路径已删除；出站只有卡片（patch 天然幂等）
  // ────────────────────────────────────────────────────────────────────
  describe("Task #4230: 旧普通消息通知路径已删除（卡片路径天然幂等）", () => {
    test("PerTaskGroupChatPlugin 不再有 buildSendToChatArgs（普通消息路径已删除）", () => {
      const plugin = new PerTaskGroupChatPlugin();
      expect((plugin as any).buildSendToChatArgs).toBeUndefined();
      expect((plugin as any).sendToChat).toBeUndefined();
      expect((plugin as any).sendToMain).toBeUndefined();
    });

    test("LarkCliTaskNotifyHook 不再有 sendLarkMessage/buildReplyArgs（旧通知路径已删除）", () => {
      const hook = new LarkCliTaskNotifyHook();
      expect((hook as any).sendLarkMessage).toBeUndefined();
      expect((hook as any).buildReplyArgs).toBeUndefined();
      expect((hook as any).sendNotify).toBeUndefined();
    });

    test("卡片 patch 的幂等性来自同一 messageId（不靠 --idempotency-key）", () => {
      const notifier = new LarkCardPatchNotifier();
      const patchArgs = notifier.buildPatchCardArgs({
        messageId: "om_card_001",
        card: {
          schema: "2.0",
          header: {
            title: { tag: "plain_text", content: "t" },
            subtitle: { tag: "plain_text", content: "s" },
            template: "blue",
          },
          body: { elements: [] },
        },
      });
      // 同一 messageId 的重复 patch 是就地覆盖（天然幂等），不需要 idempotency key
      expect(patchArgs).toContain("--message-id");
      expect(patchArgs[patchArgs.indexOf("--message-id") + 1]).toBe("om_card_001");
      expect(patchArgs).not.toContain("--idempotency-key");
    });
  });
});
