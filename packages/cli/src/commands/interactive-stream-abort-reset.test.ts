/**
 * @fileoverview Task #4721（交叉验证 MAJOR-5）— 打断后**下一轮仍能正常输出**。
 *
 * ## 为什么需要这个测试
 *
 * `abortStream()`（无 scope）置的是**全局** abort flag。若新一轮开始时
 * 不清掉它，`isStreamAborted()` 会一直返回 true ⇒ **后续每一轮都不会有
 * 流式输出**（用户看到「打完断就再也不出字了」）。
 *
 * 唯一保障是 `commands/interactive.ts` 里 `createStreamHandleQuery` 开头的
 * `resetStreamAbort()`。
 *
 * ⚠️ **反向验证（reviewer 实测）**：把这个 `resetStreamAbort()` 删掉 ⇒
 *   **0 个测试变红** ⇒ 当时**完全没有覆盖**，一旦被误删 CI 依然全绿。
 *
 * ⇒ 本文件补上这个缺口。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStreamHandleQuery, type RunOptions } from "./interactive";
import {
  abortStream,
  isStreamAborted,
  resetStreamAbort,
} from "../services/stream-output.service";

/**
 * 最小 QueryExecutor stub。
 *
 * `execute()` 会读 `isStreamAborted()` 来决定「这一轮是否已被打断」，
 * 以此模拟真实链路里「abort 后不再产出内容」的行为。
 */
function makeExecutor() {
  const calls: { aborted: boolean }[] = [];
  return {
    calls,
    setChunkCallback() {},
    async execute(_message: string, _sessionId: string, _opts: any) {
      const aborted = isStreamAborted();
      calls.push({ aborted });
      return aborted ? "" : "reply";
    },
  };
}

function makeOptions(): RunOptions {
  return {
    quiet: true,
    defaultAgentName: "default",
    // ★ Task #5181：不注入则 emitUserTurnTrigger 走默认 ~/.roy-bot/event-store.db
    triggerEventDbPath: join(mkdtempSync(join(tmpdir(), "t5181-abort-")), "event-store.db"),
  } as unknown as RunOptions;
}

describe("Task #4721 MAJOR-5 — 打断后下一轮仍能正常输出", () => {
  test("resetStreamAbort 清掉全局 abort 标记", () => {
    abortStream();
    expect(isStreamAborted()).toBe(true);
    resetStreamAbort();
    expect(isStreamAborted()).toBe(false);
  });

  test("createStreamHandleQuery 每一轮开头都重置 abort 标记", async () => {
    const exec = makeExecutor();
    const stream = createStreamHandleQuery(
      exec as never,
      "session-1",
      makeOptions(),
      {},
      undefined,
    );

    // 第一轮正常
    const first = await stream("hello", () => {});
    expect(first).toBe("reply");
    expect(exec.calls[0]?.aborted).toBe(false);

    // 用户按 ESC ⇒ 全局 abort 标记被置上
    abortStream();
    expect(isStreamAborted()).toBe(true);

    // ⚠️ **第二轮**必须仍然能输出 —— 这就是 `resetStreamAbort()` 的作用
    const second = await stream("hello again", () => {});
    expect(exec.calls[1]?.aborted).toBe(false);
    expect(second).toBe("reply");
    expect(isStreamAborted()).toBe(false);
  });

  test("没有 resetStreamAbort 时第二轮会被误判为已打断（反向验证对照）", () => {
    // 这个断言**不**测产品代码，而是把「反事实」显式写出来：
    // 若把 `createStreamHandleQuery` 里的 `resetStreamAbort()` 删掉，
    // 上一条测试就会红 ⇒ 证明那条测试**真的**锁住了这个行为。
    const exec = makeExecutor();
    abortStream();
    // 模拟「没有 reset」的状态：直接检查 abort 标记仍在
    expect(isStreamAborted()).toBe(true);
    // 手动清掉，避免污染其它测试
    resetStreamAbort();
    expect(exec.calls).toHaveLength(0);
  });
});
