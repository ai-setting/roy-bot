/**
 * @fileoverview Task #4568 — CLI 入口 emit trigger event（TDD RED→GREEN）
 *
 * ## 本文件锁定的契约
 *
 * 1. `emitCliTriggerEvent()` 返回 `{ triggerEventId, replyChannel }`，
 *    且 replyChannel 的 chatId 非空（否则 notify 链路整份作废）。
 * 2. 落库失败时**返回 null 且不抛** —— CLI 主流程绝不能因为可观测性挂掉。
 * 3. `--no-quiet` 时回显 `[Trigger] evt_...`，quiet 时不回显。
 *    （用户 2026-10-27 拍板 ④）
 * 4. `toCliEnvEvent()` 产出的 EnvEvent 形状必须能被
 *    `deriveTriggerEventIdFromEnvContext()` 识别（断点 C 的修复点）。
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveTriggerEventIdFromEnvContext } from "@ai-setting/roy-bot-core/env/task/delegate/delegate-tool";
import { runWithEnvContext } from "@ai-setting/roy-bot-core/env/context";
import { EventStoreImpl } from "@ai-setting/roy-bot-core/env/event-source/event-store";

import {
  emitCliTriggerEvent,
  toCliEnvEvent,
  formatTriggerEcho,
  CLI_TRIGGER_ECHO_PREFIX,
} from "./cli-trigger-event";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cli-trigger-"));
  dbPath = join(tmpDir, "events.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ============================================================================
// 组 1：emitCliTriggerEvent 基本契约
// ============================================================================

describe("emitCliTriggerEvent", () => {
  test("返回 { triggerEventId, replyChannel }，且落盘可反查", async () => {
    const result = await emitCliTriggerEvent({
      command: "run",
      query: "帮我 delegate 一个任务",
      sessionId: "sess-abc",
      cwd: "/tmp/work",
      argv: ["run"],
      dbPath,
    });

    expect(result).not.toBeNull();
    expect(result!.triggerEventId.startsWith("evt_")).toBe(true);
    expect(result!.replyChannel.chatId).toBe("cli:sess-abc");

    // 真的落盘：反查得到，且 esType 正确
    const store = new EventStoreImpl({ dbPath });
    const persisted = await store.getEventById(result!.triggerEventId);
    expect(persisted).not.toBeNull();
    expect(persisted!.esType).toBe("cli-command");
    store.close();
  });

  test("落库失败 → 返回 null 且不抛（CLI 主流程绝不因可观测性挂掉）", async () => {
    const result = await emitCliTriggerEvent({
      command: "run",
      query: "q",
      sessionId: "s",
      dbPath: "/nonexistent-dir-xyz/deep/path/events.db",
    });
    expect(result).toBeNull();
  });

  test("metadata 里 chatId / replyChannel / sessionId 三者一致", async () => {
    const result = await emitCliTriggerEvent({
      command: "interactive",
      query: "q2",
      sessionId: "sess-xyz",
      dbPath,
    });
    const store = new EventStoreImpl({ dbPath });
    const persisted = await store.getEventById(result!.triggerEventId);
    const meta = persisted!.metadata as Record<string, any>;

    expect(meta.sessionId).toBe("sess-xyz");
    expect(meta.chatId).toBe("cli:sess-xyz");
    expect(meta.replyChannel.chatId).toBe("cli:sess-xyz");
    expect(meta.replyChannel.params.sink).toBe("stdout");
    expect(meta.eventType).toBe("cli.query");
    store.close();
  });

  test("query 太长时截断落库（防止 event_store 爆）", async () => {
    const huge = "x".repeat(20000);
    const result = await emitCliTriggerEvent({
      command: "run",
      query: huge,
      sessionId: "s",
      dbPath,
    });
    const store = new EventStoreImpl({ dbPath });
    const persisted = await store.getEventById(result!.triggerEventId);
    expect((persisted!.text ?? "").length).toBeLessThanOrEqual(4000);
    store.close();
  });
});

// ============================================================================
// 组 2：toCliEnvEvent —— 断点 C 的修复点
// ============================================================================

describe("toCliEnvEvent", () => {
  test("产出的 EnvEvent 能被 deriveTriggerEventIdFromEnvContext() 识别 ★ 核心", async () => {
    const result = await emitCliTriggerEvent({
      command: "run",
      query: "q",
      sessionId: "sess-abc",
      dbPath,
    });

    const envEvent = toCliEnvEvent(result!, "q");

    // 模拟 agent-component 的 EnvContext（replyChannel 从 envEvent.metadata 取）
    const envCtx: any = {
      envEvent,
      replyChannel: envEvent.metadata.replyChannel,
      sourceId: "cli",
      sourceType: "cli-command",
      userId: "cli:user",
    };

    const derived = runWithEnvContext(envCtx, () => deriveTriggerEventIdFromEnvContext());
    expect(derived).toBe(result!.triggerEventId);
  });

  test("EnvEvent 的 metadata.replyChannel.chatId 非空（否则快照丢弃）", async () => {
    const result = await emitCliTriggerEvent({
      command: "run", query: "q", sessionId: "sess-abc", dbPath,
    });
    const envEvent = toCliEnvEvent(result!, "q");
    const rc = (envEvent.metadata as any).replyChannel;
    expect(typeof rc.chatId).toBe("string");
    expect(rc.chatId.length).toBeGreaterThan(0);
    expect(rc.params.sink).toBe("stdout");
  });

  test("EnvEvent.type / source / sourceType 正确（便于 trace 与 plugin 识别）", async () => {
    const result = await emitCliTriggerEvent({
      command: "interactive", query: "q", sessionId: "s", dbPath,
    });
    const envEvent = toCliEnvEvent(result!, "q");
    expect(envEvent.type).toBe("event-source.event.cli");
    expect((envEvent.metadata as any).source).toBe("cli-command");
    expect((envEvent.metadata as any).sourceType).toBe("cli-command");
  });
});

// ============================================================================
// 组 3：triggerEventId 回显（用户拍板 ④）
// ============================================================================

describe("formatTriggerEcho", () => {
  test("quiet=true → 不回显（返回 null）", () => {
    expect(formatTriggerEcho("evt_123", { quiet: true })).toBeNull();
  });

  test("quiet=false → 回显含 [Trigger] 前缀与 ID", () => {
    const line = formatTriggerEcho("evt_123", { quiet: false });
    expect(line).not.toBeNull();
    expect(line!).toContain(CLI_TRIGGER_ECHO_PREFIX);
    expect(line!).toContain("evt_123");
  });

  test("triggerEventId 为空 → 不回显（不打印空标签）", () => {
    expect(formatTriggerEcho("", { quiet: false })).toBeNull();
  });
});
