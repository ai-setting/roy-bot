/**
 * @fileoverview TDD RED→GREEN for Task #4396: the `llm.completed` chunk event
 * must carry the usage payload so the interactive TUI can render a per-message
 * cache/token footer.
 *
 * Root cause this locks down:
 *   `StreamOutputService.handleCompleted()` parsed `metadata.usage` into
 *   `this.usageInfo` but then emitted `{ type: "llm.completed", fullContent }`
 *   WITHOUT the usage — so the Ink REPL had no way to reach it (it only
 *   receives StreamChunkEvents, never the service instance).
 *
 * User requirement (飞书 p2p 2026-10-20):
 *   "在每个Agent消息的后面添加上这个cache和token信息已灰色颜色展示出来"
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
  StreamOutputService,
  resetStreamAbort,
  type StreamChunkEvent,
} from "./stream-output.service";
import type { EnvEvent } from "@ai-setting/roy-bot-core";

const completedEvent = (usage: Record<string, unknown>): EnvEvent => ({
  id: "c1",
  type: "llm.completed",
  timestamp: Date.now(),
  metadata: {},
  payload: {
    content: "hello",
    metadata: { model: "deepseek/deepseek-flash", usage },
  },
});

describe("StreamOutputService llm.completed carries usage (Task #4396)", () => {
  let service: StreamOutputService;
  let events: StreamChunkEvent[];

  beforeEach(() => {
    resetStreamAbort();
    service = new StreamOutputService({ silent: true });
    events = [];
    service.setChunkCallback((e) => events.push(e));
  });

  test("emits the full usage payload on llm.completed", () => {
    service.handleEvent(
      completedEvent({
        promptTokens: 32,
        completionTokens: 8,
        totalTokens: 15120,
        cacheRead: 14976,
        cacheWrite: 0,
        promptTokensTotal: 15008,
      }),
    );

    const completed = events.find((e) => e.type === "llm.completed");
    expect(completed).toBeDefined();
    expect(completed!.usage).toBeDefined();
    expect(completed!.usage!.cacheRead).toBe(14976);
    expect(completed!.usage!.promptTokens).toBe(32);
    expect(completed!.usage!.completionTokens).toBe(8);
    expect(completed!.usage!.promptTokensTotal).toBe(15008);
  });

  test("still emits llm.completed when the provider reports no usage", () => {
    service.handleEvent({
      id: "c2",
      type: "llm.completed",
      timestamp: Date.now(),
      metadata: {},
      payload: { content: "hi", metadata: { model: "x/y" } },
    });

    const completed = events.find((e) => e.type === "llm.completed");
    expect(completed).toBeDefined();
    // No usage reported → undefined (footer renders nothing), not a fake zero.
    expect(completed!.usage).toBeUndefined();
  });

  test("overwrites usage per call so every message gets its own footer", () => {
    service.handleEvent(
      completedEvent({ promptTokens: 1, completionTokens: 1, cacheRead: 111 }),
    );
    service.handleEvent(
      completedEvent({ promptTokens: 2, completionTokens: 2, cacheRead: 222 }),
    );

    const completed = events.filter((e) => e.type === "llm.completed");
    expect(completed).toHaveLength(2);
    expect(completed[0]!.usage!.cacheRead).toBe(111);
    expect(completed[1]!.usage!.cacheRead).toBe(222);
  });
});
