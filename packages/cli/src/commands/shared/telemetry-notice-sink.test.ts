/**
 * @fileoverview Task #4568 — `targetFromEventMetadata()` 必须读出 `params.sink`
 *
 * ## 为什么这个文件单独存在
 *
 * 探针 D（设计文档 §5.5）实测发现：`targetFromEventMetadata()` 只取
 * `replyChannel.chatId` / `replyChannel.profile`，**把整个 `params` 丢掉**。
 *
 * 后果链：
 *   `replyChannel.params.sink = 'stdout'`
 *     → `captureReplyChannelSnapshot()` **保留** params（实测通过）
 *     → `task.replyChannel.params.sink = 'stdout'`
 *     → `publishBackgroundEvent()` 写进 `event.metadata.replyChannel.params.sink`
 *     → `targetFromEventMetadata()` **丢失 params**
 *     → `EventHandler.telemetrySender` 不知道要走 stdout
 *     → 仍然去 spawn lark-cli（发到 `cli:xxx` 这种假 chatId）→ 失败 → 静默
 *
 * ⇒ 这是**必做项，不是优化**（用户 2026-10-27 任务书明确要求）。
 *
 * ## 兼容性契约（最重要）
 *
 * `sink` 缺省时**必须返回 undefined**，让 `EventHandler` 继续走
 * `sendLarkChatMarkdown` —— 现有 1206 行 telemetry/rule-notice 测试
 * 一行都不能改。本文件最后一组专门锁这条。
 */

import { describe, expect, test } from "bun:test";

import { targetFromEventMetadata } from "./telemetry-notice";

describe("targetFromEventMetadata —— params.sink（Task #4568 必做项）", () => {
  test("从 replyChannel.params.sink 读出 'stdout'", () => {
    const target = targetFromEventMetadata({
      replyChannel: {
        type: "cli-command",
        chatId: "cli:sess-1",
        params: { sink: "stdout", cliSessionId: "sess-1" },
      },
    });
    expect(target).toBeDefined();
    expect(target!.chatId).toBe("cli:sess-1");
    expect((target as any).sink).toBe("stdout");
  });

  test("从 metadata.sink 顶层兜底（triggerEvent 反查路径可能只有顶层）", () => {
    const target = targetFromEventMetadata({
      chatId: "cli:sess-2",
      sink: "stdout",
    });
    expect(target).toBeDefined();
    expect((target as any).sink).toBe("stdout");
  });

  test("sink='lark' 显式值也能读出", () => {
    const target = targetFromEventMetadata({
      replyChannel: { chatId: "oc_x", params: { sink: "lark" } },
    });
    expect((target as any).sink).toBe("lark");
  });

  test("未知 sink 值 → 不透出（不猜）", () => {
    const target = targetFromEventMetadata({
      replyChannel: { chatId: "oc_x", params: { sink: "carrier-pigeon" } },
    });
    expect((target as any).sink).toBeUndefined();
  });
});

describe("targetFromEventMetadata —— 向后兼容（sink 缺省）", () => {
  test("★ 无 sink → 返回对象上 sink 为 undefined（现有 lark 行为零变化）", () => {
    const target = targetFromEventMetadata({
      replyChannel: { type: "lark-cli", chatId: "oc_8904", messageId: "om_x", profile: "tongzhuli" },
    });
    expect(target).toEqual({ chatId: "oc_8904", profile: "tongzhuli" });
    expect("sink" in (target as object)).toBe(false);
  });

  test("★ 无 sink + 无 profile → 仍然只有 chatId", () => {
    const target = targetFromEventMetadata({ replyChannel: { chatId: "oc_A" } });
    expect(target).toEqual({ chatId: "oc_A" });
    expect((target as any).sink).toBeUndefined();
  });

  test("无 replyChannel / 无 chatId → 仍然 undefined（不因新增 sink 而复活）", () => {
    expect(targetFromEventMetadata({ source: "task.background" })).toBeUndefined();
    expect(targetFromEventMetadata({ replyChannel: { type: "cli" } })).toBeUndefined();
    expect(targetFromEventMetadata({ sink: "stdout" })).toBeUndefined();
    expect(targetFromEventMetadata(undefined)).toBeUndefined();
  });

  test("params 存在但无 sink → 不透出 sink", () => {
    const target = targetFromEventMetadata({
      replyChannel: { chatId: "oc_A", params: { userId: "ou_x" } },
    });
    expect(target).toEqual({ chatId: "oc_A" });
  });
});
