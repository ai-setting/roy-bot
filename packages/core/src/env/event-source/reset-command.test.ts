/**
 * Task #4896 — `reset` command tests.
 *
 * The reset command tells the deamon-for-roy daemon (over a Unix socket)
 * to kill & respawn this roy-bot process, so the freshly built binary
 * takes over. Protocol: one JSON line request, one JSON line response.
 *
 * Iron rules verified here:
 * - socket failure / timeout must NOT fail the command (ok:true,
 *   text says daemon did not confirm) — a broken socket must never
 *   leave the user without feedback.
 * - socket path overridable via ROY_DAEMON_SOCKET (tests use a temp socket).
 */
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createIpcServer } from "../../test-utils/ipc-test-server";
import { resetCommand, DEFAULT_SOCKET_PATH, buildResetCard } from "./reset-command";

function ctx(overrides: Partial<{ rawText: string; args: string[] }> = {}) {
  return {
    args: overrides.args ?? [],
    configPath: undefined,
    rawText: overrides.rawText ?? "##command##: reset",
  };
}

describe("reset command", () => {
  test("metadata: name/description/usage present", () => {
    expect(resetCommand.name).toBe("reset");
    expect(resetCommand.description.length).toBeGreaterThan(0);
    expect(resetCommand.usage.length).toBeGreaterThan(0);
  });

  test("default socket path is /tmp/deamon-for-roy.sock", () => {
    expect(DEFAULT_SOCKET_PATH).toBe("/tmp/deamon-for-roy.sock");
  });

  test("execute: daemon ACKs -> ok:true, text mentions restart requested", async () => {
    const server = createIpcServer();
    await server.start();
    try {
      process.env.ROY_DAEMON_SOCKET = server.socketPath;
      const res = await resetCommand.execute(ctx());
      expect(res.ok).toBe(true);
      expect(res.output?.text).toContain("已请求重启");
      expect(res.output?.card).toBeDefined();
    } finally {
      delete process.env.ROY_DAEMON_SOCKET;
      await server.stop();
    }
  });

  test("execute: socket missing -> ok:true, text says restart did NOT take effect", async () => {
    process.env.ROY_DAEMON_SOCKET = "/tmp/no-such-socket-4896.sock";
    try {
      const res = await resetCommand.execute(ctx());
      expect(res.ok).toBe(true);
      expect(res.output?.text).toContain("重启请求未生效");
    } finally {
      delete process.env.ROY_DAEMON_SOCKET;
    }
  });

  test("execute: daemon slow (>3s) -> ok:true, restart did NOT take effect", async () => {
    const server = createIpcServer({ replyDelayMs: 4000 });
    await server.start();
    try {
      process.env.ROY_DAEMON_SOCKET = server.socketPath;
      const res = await resetCommand.execute(ctx());
      expect(res.ok).toBe(true);
      expect(res.output?.text).toContain("重启请求未生效");
    } finally {
      delete process.env.ROY_DAEMON_SOCKET;
      await server.stop();
    }
  }, 10000);

  test("execute: passes reason arg to daemon", async () => {
    const server = createIpcServer();
    await server.start();
    try {
      process.env.ROY_DAEMON_SOCKET = server.socketPath;
      const res = await resetCommand.execute(ctx({ args: ["upgrade"] }));
      expect(res.ok).toBe(true);
      expect(server.lastRequest).toEqual({
        type: "reset",
        reason: "upgrade",
      });
    } finally {
      delete process.env.ROY_DAEMON_SOCKET;
      await server.stop();
    }
  });

  test("buildResetCard: card is a Card 2.0 shell (header + markdown body)", () => {
    const card = buildResetCard("已请求重启，daemon 即将切换到最新版本");
    expect(card.schema).toBe("2.0");
    expect(card.header?.title?.content).toBe("🔄 重启请求");
    const elements = card.body?.elements as unknown[] | undefined;
    expect(Array.isArray(elements)).toBe(true);
    expect(elements?.length).toBeGreaterThan(0);
    expect((elements?.[0] as { tag?: string })?.tag).toBe("markdown");
  });
});
