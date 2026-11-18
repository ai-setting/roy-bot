/**
 * @fileoverview Task #2280: startInk() 真实路径 smoke test
 *
 * 不通过 cli bundler (避免 pre-existing 编译问题),
 * 直接 import source 验证 startInk 入口的最小行为。
 *
 * 这里只验证:
 * 1. useInk=false → this.rl 不是 null (readline 路径)
 * 2. useInk=true → this.rl 是 null (ink 路径避免冲突)
 * 3. shutdown() 在 useInk=true 时不 crash (this.rl === null)
 * 4. 字段默认值正确
 */

import { test, expect, describe, vi } from "bun:test";
import { REPL } from "./run";

describe("Task #2280: startInk() / startReadline() 路径 smoke", () => {
  test("useInk=false → this.rl 不是 null (readline 路径)", async () => {
    const repl = new REPL({
      sessionId: "test",
      sessionTitle: "Test",
      onExecute: vi.fn().mockResolvedValue("ok"),
      onStatus: vi.fn().mockReturnValue({
        sessionId: "test",
        sessionTitle: "Test",
        messageCount: 0,
        tokenCount: 0,
      }),
      onSwitchSession: vi.fn(),
      onCompact: vi.fn(),
      onShutdown: vi.fn().mockResolvedValue(undefined),
    } as any);

    // 验证 this.rl 不是 null (readline 路径)
    expect(repl["rl"]).not.toBeNull();

    // 验证 useInk 字段默认为 undefined
    expect(repl["options"].useInk).toBeUndefined();

    // 验证 inkApi 字段为 null
    expect(repl.inkApi).toBeNull();

    // 验证 inkChunkCallback 字段为 null
    expect(repl.inkChunkCallback).toBeNull();

    // 验证 _queryExecutor 字段为 null
    expect(repl["_queryExecutor"]).toBeNull();

    await repl.shutdown();
  });

  test("useInk=true → this.rl 是 null (避免 readline + ink 冲突)", async () => {
    const repl = new REPL({
      sessionId: "test",
      sessionTitle: "Test",
      useInk: true,
      onExecute: vi.fn().mockResolvedValue("ok"),
      onStatus: vi.fn().mockReturnValue({
        sessionId: "test",
        sessionTitle: "Test",
        messageCount: 0,
        tokenCount: 0,
      }),
      onSwitchSession: vi.fn(),
      onCompact: vi.fn(),
      onShutdown: vi.fn().mockResolvedValue(undefined),
    } as any);

    // this.rl 应该是 null (ink 路径不创建 readline)
    expect(repl["rl"]).toBeNull();

    // inkApi 字段存在（即使还没 start）
    expect(repl.inkApi).toBeNull();

    await repl.shutdown();
  });

  test("shutdown() 在 ink 路径不 crash (this.rl === null)", async () => {
    const repl = new REPL({
      sessionId: "test",
      sessionTitle: "Test",
      useInk: true,
      onExecute: vi.fn().mockResolvedValue("ok"),
      onStatus: vi.fn().mockReturnValue({
        sessionId: "test",
        sessionTitle: "Test",
        messageCount: 0,
        tokenCount: 0,
      }),
      onSwitchSession: vi.fn(),
      onCompact: vi.fn(),
      onShutdown: vi.fn().mockResolvedValue(undefined),
    } as any);

    // shutdown 应该是幂等的
    await repl.shutdown();
    // 二次 shutdown 不应抛错
    await repl.shutdown();
  });
});
