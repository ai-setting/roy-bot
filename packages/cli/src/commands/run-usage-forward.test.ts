/**
 * @fileoverview Task #4396: `interactive` (commands/interactive.ts → RunTui) must be
 * able to receive the per-call LLM usage.
 *
 * User requirement (飞书 p2p 2026-10-20):
 *   "在每个Agent消息的后面添加上这个cache和token信息已灰色颜色展示出来"
 *
 * `renderTui` path:  commands/interactive.ts  →  <RunTui>  →  <App>  →  <UsageFooter>
 * `renderTui` chain: createStreamHandleQuery(...) translates StreamChunkEvents
 *                    into string deltas; it must ALSO forward the `usage` that
 *                    rides on the `llm.completed` event.
 */

import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStreamHandleQuery, type RunOptions } from "./interactive";

// ★ Task #5181 (DS review M1)：每文件独立 mkdtemp，防并行 worker 竞态
const TEST_DB_DIR = mkdtempSync(join(tmpdir(), "t5181-usage-fwd-"));

/** Minimal QueryExecutor stub that lets us drive the chunk callback. */
function makeExecutor() {
  let cb: ((event: any) => void) | undefined;
  return {
    setChunkCallback(fn: any) {
      cb = fn;
    },
    emit(event: any) {
      cb?.(event);
    },
    async execute() {
      return "reply";
    },
  };
}

const OPTIONS = {
  model: "deepseek-v4.1-flash",
  reasoning: false,
  // ★ Task #5181：不注入则 emitUserTurnTrigger 走默认 ~/.roy-bot/event-store.db
  triggerEventDbPath: join(TEST_DB_DIR, "event-store.db"),
} as unknown as RunOptions;

describe("createStreamHandleQuery forwards usage (Task #4396)", () => {
  test("invokes onUsage when llm.completed carries usage", async () => {
    const exec = makeExecutor();
    const query = createStreamHandleQuery(
      exec as any,
      "session-x",
      OPTIONS,
      undefined,
      undefined,
    );

    const usages: any[] = [];
    const promise = query(
      "hi",
      () => {},
      undefined,
      (u) => usages.push(u),
    );

    // Drive the events that StreamOutputService would emit.
    exec.emit({
      type: "llm.completed",
      fullContent: "reply",
      usage: {
        promptTokens: 32,
        completionTokens: 8,
        cacheRead: 14976,
        cacheWrite: 0,
        promptTokensTotal: 15008,
      },
    });
    await promise;

    expect(usages).toHaveLength(1);
    expect(usages[0].cacheRead).toBe(14976);
    expect(usages[0].promptTokensTotal).toBe(15008);
  });

  test("does not invoke onUsage when usage is absent", async () => {
    const exec = makeExecutor();
    const query = createStreamHandleQuery(
      exec as any,
      "session-x",
      OPTIONS,
      undefined,
      undefined,
    );

    const usages: any[] = [];
    const promise = query("hi", () => {}, undefined, (u) => usages.push(u));
    exec.emit({ type: "llm.completed", fullContent: "reply" });
    await promise;

    expect(usages).toHaveLength(0);
  });

  test("is backward compatible with the 3-argument call shape", async () => {
    const exec = makeExecutor();
    const query = createStreamHandleQuery(
      exec as any,
      "session-x",
      OPTIONS,
      undefined,
      undefined,
    );

    // Old callers pass only (message, onChunk, onTool).
    const promise = query("hi", () => {});
    expect(() =>
      exec.emit({
        type: "llm.completed",
        usage: { promptTokens: 1, completionTokens: 1, cacheRead: 1 },
      }),
    ).not.toThrow();
    await promise;
  });
});
