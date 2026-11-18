/**
 * @fileoverview LarkCliNotificationChannel Tests (TDD)
 *
 * Legacy NotificationChannel（@deprecated）—— 通过 spawn lark-cli 子进程
 * 直接发飞书消息。新代码请用 EventBusNotificationChannel + env-level event subscriber。
 *
 * 关键行为：
 * - canRoute 基于 replyChannel 路由：必须有 chatId 或 messageId，且 type 含 'lark'
 * - send 通过 spawn lark-cli 子进程
 * - profile 注入：replyChannel.profile 不为 undefined 时插入 --profile <name>
 * - messageId 走 im +messages-reply，chatId 走 im +messages-send
 * - spawn 抛错 / exit code != 0 → swallow（不污染 Plugin 主流程）
 */

import { describe, test, expect, vi, beforeEach, afterEach } from "bun:test";
import { createChildProcessMockModule } from "../../test-utils/child-process-mock";
import { LarkCliNotificationChannel } from "./lark-cli-notification-channel";
import type {
  NotificationOptions,
  NotificationSendExtras,
  EnvContextLike,
} from "./notification-channel";

// Mock child_process.spawn
const mockSpawn = vi.fn();
// ⚠️ vi.mock factory 必须返回**完整导出面**（Bun 走 ESM exports 语义），否则任何
// 静态 import 其他导出（exec / spawnSync…）的模块都会在加载期 SyntaxError。
// 用共享 factory 自省派生导出面，见 packages/core/src/test-utils/child-process-mock.ts
vi.mock("node:child_process", () =>
  createChildProcessMockModule({
    spawn: (...args: any[]) => mockSpawn(...args),
  }),
);

// Helper: build a fake ChildProcess-like object that emits events
function buildFakeProc(opts: { exitCode?: number; stdout?: string; stderr?: string; error?: Error }) {
  const proc: any = {
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
  };

  // Capture registered handlers so we can emit close/error after assertions
  const handlers: Record<string, (arg: any) => void> = {};
  proc.on = vi.fn((event: string, handler: (arg: any) => void) => {
    handlers[event] = handler;
    return proc;
  });

  // Schedule async emit (next microtask) so awaited promise has time to attach
  queueMicrotask(() => {
    // Write stdout/stderr handlers
    const stdoutHandlers = (proc.stdout.on as any).mock.calls;
    const stderrHandlers = (proc.stderr.on as any).mock.calls;
    if (opts.stdout) {
      stdoutHandlers.forEach(([_evt, h]: any) => h(Buffer.from(opts.stdout)));
    }
    if (opts.stderr) {
      stderrHandlers.forEach(([_evt, h]: any) => h(Buffer.from(opts.stderr)));
    }
    if (opts.error) {
      handlers.error?.(opts.error);
    } else {
      handlers.close?.(opts.exitCode ?? 0);
    }
  });

  return proc;
}

describe("LarkCliNotificationChannel", () => {
  let channel: LarkCliNotificationChannel;

  const baseOptions: NotificationOptions = {
    type: "visualization_ready",
    title: "Viz Ready",
    content: "Chart rendered successfully",
  };

  const baseExtras: NotificationSendExtras = {
    pluginName: "task-show",
  };

  beforeEach(() => {
    channel = new LarkCliNotificationChannel();
    mockSpawn.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ========================================================================
  // Channel Identity & Deprecation
  // ========================================================================

  test("channel.name should be 'lark-cli'", () => {
    expect(channel.name).toBe("lark-cli");
  });

  test("channel file should carry @deprecated JSDoc tag", async () => {
    // Import the source file as text to confirm the @deprecated marker
    const fs = await import("node:fs");
    const path = await import("node:path");
    const filePath = path.join(
      import.meta.dir,
      "lark-cli-notification-channel.ts"
    );
    const text = fs.readFileSync(filePath, "utf-8");
    expect(text).toMatch(/@deprecated/);
  });

  // ========================================================================
  // canRoute
  // ========================================================================

  describe("canRoute", () => {
    test("should return false when envContext has no replyChannel", () => {
      expect(channel.canRoute(baseOptions, baseExtras, {})).toBe(false);
    });

    test("should return false when replyChannel has neither chatId nor messageId", () => {
      const ctx: EnvContextLike = {
        replyChannel: { type: "lark-cli" },
      };
      expect(channel.canRoute(baseOptions, baseExtras, ctx)).toBe(false);
    });

    test("should return false when replyChannel.type does not include 'lark'", () => {
      const ctx: EnvContextLike = {
        replyChannel: { type: "bounty-im", chatId: "oc_xxx" },
      };
      expect(channel.canRoute(baseOptions, baseExtras, ctx)).toBe(false);
    });

    test("should return true when replyChannel has messageId and type includes lark", () => {
      const ctx: EnvContextLike = {
        replyChannel: { type: "lark-cli", messageId: "om_xxx" },
      };
      expect(channel.canRoute(baseOptions, baseExtras, ctx)).toBe(true);
    });

    test("should return true when replyChannel has chatId and type includes lark", () => {
      const ctx: EnvContextLike = {
        replyChannel: { type: "lark-cli", chatId: "oc_xxx" },
      };
      expect(channel.canRoute(baseOptions, baseExtras, ctx)).toBe(true);
    });

    test("should accept any type string containing 'lark' (case-insensitive)", () => {
      const ctx1: EnvContextLike = { replyChannel: { type: "lark", chatId: "oc_1" } };
      const ctx2: EnvContextLike = { replyChannel: { type: "LARK-CLI", chatId: "oc_2" } };
      expect(channel.canRoute(baseOptions, baseExtras, ctx1)).toBe(true);
      expect(channel.canRoute(baseOptions, baseExtras, ctx2)).toBe(true);
    });
  });

  // ========================================================================
  // send - happy path
  // ========================================================================

  describe("send - happy path", () => {
    test("should use messages-reply when messageId is provided", async () => {
      const ctx: EnvContextLike = {
        replyChannel: { type: "lark-cli", messageId: "om_test_001" },
      };

      const proc = buildFakeProc({ exitCode: 0 });
      mockSpawn.mockReturnValue(proc);

      await channel.send(baseOptions, baseExtras, ctx);

      expect(mockSpawn).toHaveBeenCalledTimes(1);
      const [cmd, args] = mockSpawn.mock.calls[0]!;
      expect(cmd).toBe("lark-cli");
      expect(args).toContain("im");
      expect(args).toContain("+messages-reply");
      expect(args).toContain("--message-id");
      expect(args).toContain("om_test_001");
      expect(args).toContain("--markdown");
      // ★ RED-4（回归护栏）：reply 分支本来就有 --as bot，本次不得回退
      expect(args).toContain("--as");
      expect(args[args.indexOf("--as") + 1]).toBe("bot");
    });

    test("should use messages-send when only chatId is provided", async () => {
      const ctx: EnvContextLike = {
        replyChannel: { type: "lark-cli", chatId: "oc_test_chat" },
      };

      const proc = buildFakeProc({ exitCode: 0 });
      mockSpawn.mockReturnValue(proc);

      await channel.send(baseOptions, baseExtras, ctx);

      const [_cmd, args] = mockSpawn.mock.calls[0]!;
      expect(args).toContain("im");
      expect(args).toContain("+messages-send");
      expect(args).toContain("--chat-id");
      expect(args).toContain("oc_test_chat");
      expect(args).toContain("--markdown");

      // ★ RED-2（Task #4557）：chatId 分支必须显式 --as bot。
      //
      // 同 `error-reply.ts` 的 bug 类：不带 flag → 默认 user 身份 → 被
      // `lark-cli event consume im.message.receive_v1` 回灌成「用户消息」
      // → 又跑一次完整 agent run（Task #4552 实测回灌率 45%）。
      // 本 channel 已 @deprecated，但 opt-in 仍可启用，所以同样要修。
      expect(
        args.indexOf("--as"),
        "chatId 分支必须带 --as bot，否则插件通知会以 user 身份发出并被自我回灌",
      ).toBeGreaterThanOrEqual(0);
      expect(args[args.indexOf("--as") + 1]).toBe("bot");
      expect(args.filter((a: string) => a === "--as").length).toBe(1);
    });

    test("RED-2b：--as bot 与 --profile 共存，--profile 仍在最前（两个修复不互相挤掉）", async () => {
      const ctx: EnvContextLike = {
        replyChannel: { type: "lark-cli", chatId: "oc_test_chat", profile: "tongzhuli" },
      };

      const proc = buildFakeProc({ exitCode: 0 });
      mockSpawn.mockReturnValue(proc);

      await channel.send(baseOptions, baseExtras, ctx);

      const [_cmd, args] = mockSpawn.mock.calls[0]!;
      expect(args[0]).toBe("--profile");
      expect(args[1]).toBe("tongzhuli");
      expect(args).toContain("--as");
      expect(args[args.indexOf("--as") + 1]).toBe("bot");
    });

    test("should put the markdown content (title + content) into --markdown arg", async () => {
      const ctx: EnvContextLike = {
        replyChannel: { type: "lark-cli", chatId: "oc_chat_xyz" },
      };

      const proc = buildFakeProc({ exitCode: 0 });
      mockSpawn.mockReturnValue(proc);

      await channel.send(baseOptions, baseExtras, ctx);

      const [_cmd, args] = mockSpawn.mock.calls[0]!;
      const mdIdx = args.indexOf("--markdown");
      expect(mdIdx).toBeGreaterThan(-1);
      const mdContent = args[mdIdx + 1];
      expect(mdContent).toContain("Viz Ready");
      expect(mdContent).toContain("Chart rendered successfully");
    });

    test("should prepend --profile when replyChannel.profile is set", async () => {
      const ctx: EnvContextLike = {
        replyChannel: {
          type: "lark-cli",
          messageId: "om_p_001",
          profile: "myapp",
        },
      };

      const proc = buildFakeProc({ exitCode: 0 });
      mockSpawn.mockReturnValue(proc);

      await channel.send(baseOptions, baseExtras, ctx);

      const [_cmd, args] = mockSpawn.mock.calls[0]!;
      // profile should be the first two args
      expect(args[0]).toBe("--profile");
      expect(args[1]).toBe("myapp");
    });

    test("should NOT add --profile when replyChannel.profile is undefined", async () => {
      const ctx: EnvContextLike = {
        replyChannel: { type: "lark-cli", chatId: "oc_no_prof" },
      };

      const proc = buildFakeProc({ exitCode: 0 });
      mockSpawn.mockReturnValue(proc);

      await channel.send(baseOptions, baseExtras, ctx);

      const [_cmd, args] = mockSpawn.mock.calls[0]!;
      expect(args).not.toContain("--profile");
    });
  });

  // ========================================================================
  // send - error handling
  // ========================================================================

  describe("send - error handling", () => {
    test("should resolve (not reject) when lark-cli exits non-zero", async () => {
      const ctx: EnvContextLike = {
        replyChannel: { type: "lark-cli", chatId: "oc_fail" },
      };

      const proc = buildFakeProc({
        exitCode: 1,
        stderr: "lark-cli auth failed",
      });
      mockSpawn.mockReturnValue(proc);

      await expect(
        channel.send(baseOptions, baseExtras, ctx)
      ).resolves.toBeUndefined();
    });

    test("should resolve when spawn emits 'error' event", async () => {
      const ctx: EnvContextLike = {
        replyChannel: { type: "lark-cli", chatId: "oc_err" },
      };

      const proc = buildFakeProc({
        error: new Error("lark-cli not found"),
      });
      mockSpawn.mockReturnValue(proc);

      await expect(
        channel.send(baseOptions, baseExtras, ctx)
      ).resolves.toBeUndefined();
    });

    test("should resolve (not throw) when canRoute returns false", async () => {
      // No replyChannel → canRoute = false → send should silently noop
      await expect(
        channel.send(baseOptions, baseExtras, {})
      ).resolves.toBeUndefined();
      expect(mockSpawn).not.toHaveBeenCalled();
    });
  });
});
