/**
 * Test helper: a tiny IPC server mirroring deamon-for-roy's protocol,
 * used only by reset-command tests. Supports optional reply delay
 * (to exercise the client timeout path).
 */
import { createServer, connect, type Socket, type Server } from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export interface TestIpcServer {
  socketPath: string;
  /** last parsed JSON request received from a client */
  lastRequest: Record<string, unknown> | null;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createIpcServer(
  opts: { replyDelayMs?: number } = {}
): TestIpcServer {
  const dir = mkdtempSync(join(tmpdir(), "reset-cmd-"));
  const socketPath = join(dir, "d.sock");
  // The temp dir is removed in stop() so tests don't leak /tmp/reset-cmd-* dirs.
  let server: Server | null = null;
  let lastRequest: Record<string, unknown> | null = null;
  const conns = new Set<Socket>();

  function reply(sock: Socket, line: string): void {
    try {
      lastRequest = JSON.parse(line);
    } catch {
      lastRequest = null;
    }
    const send = () => {
      try {
        sock.write(JSON.stringify({ type: "ack", action: "respawning" }) + "\n");
      } catch { /* gone */ }
    };
    if (opts.replyDelayMs && opts.replyDelayMs > 0) {
      setTimeout(send, opts.replyDelayMs);
    } else {
      send();
    }
  }

  return {
    socketPath,
    get lastRequest() {
      return lastRequest;
    },
    async start() {
      try { rmSync(socketPath, { force: true }); } catch { /* ok */ }
      server = createServer((sock) => {
        conns.add(sock);
        let buf = "";
        sock.on("data", (d: Buffer) => {
          buf += d.toString();
          let idx: number;
          while ((idx = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line) reply(sock, line);
          }
        });
        sock.on("error", () => sock.destroy());
        sock.on("close", () => conns.delete(sock));
      });
      await new Promise<void>((res, rej) => {
        server!.once("error", rej);
        server!.listen(socketPath, () => res());
      });
      // self-check connectable
      await new Promise<void>((res, rej) => {
        const probe = connect(socketPath);
        probe.once("connect", () => { probe.destroy(); res(); });
        probe.once("error", (e) => rej(e));
      });
    },
    async stop() {
      // Cleanup the temp dir FIRST: even if start() failed (server === null),
      // the directory must not leak.
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
      if (!server) return;
      await new Promise<void>((res) => server!.close(() => res()));
      for (const c of conns) c.destroy();
      conns.clear();
      server = null;
    },
  };
}
