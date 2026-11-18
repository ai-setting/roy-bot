/**
 * Task #4896 — `reset` command.
 *
 * User sends `##command##: reset` (optionally `reset <reason>`)
 * to the roy-bot es frontend. This command notifies the
 * deamon-for-roy daemon over a Unix socket (JSON line protocol):
 *
 *   -> {"type":"reset","reason":"..."}
 *   <- {"type":"ack","action":"respawning"}
 *
 * The daemon then SIGTERMs this process and respawns the
 * (possibly rebuilt) binary — hot version swap.
 *
 * ## Iron rule: the command must NEVER fail
 *
 * If the socket is missing / connect fails / daemon doesn't
 * answer within 3s, we still return ok:true with text telling
 * the user the daemon did NOT confirm. A broken IPC must not
 * leave the user without any feedback (the es frontend renders
 * CommandResult to a feishu card).
 *
 * ## Socket path resolution
 *
 * 1. env ROY_DAEMON_SOCKET (tests / ops override)
 * 2. default /tmp/deamon-for-roy.sock
 */

import { connect, type Socket } from "net";
import type {
  CommandContext,
  CommandDefinition,
  CommandResult,
} from "./command-registry";
import { renderTextCard, type LarkCard } from "./command-cards";

/** Default IPC socket path of deamon-for-roy. */
export const DEFAULT_SOCKET_PATH = "/tmp/deamon-for-roy.sock";

/** How long to wait for the daemon ACK before giving up (ms). */
export const RESET_ACK_TIMEOUT_MS = 3000;

export function resolveSocketPath(): string {
  return process.env.ROY_DAEMON_SOCKET || DEFAULT_SOCKET_PATH;
}

interface DaemonAck {
  type: string;
  action?: string;
}

/**
 * Send the reset request and await the ACK.
 * Resolves {confirmed:true} on ACK; {confirmed:false, reason}
 * on any failure (connect error / timeout / bad reply).
 */
async function requestReset(
  socketPath: string,
  reason?: string
): Promise<{ confirmed: boolean; reason: string }> {
  return new Promise((resolve) => {
    let sock: Socket;
    try {
      sock = connect(socketPath);
    } catch (e) {
      resolve({ confirmed: false, reason: (e as Error).message });
      return;
    }
    let settled = false;
    const finish = (confirmed: boolean, why: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ confirmed, reason: why });
    };
    const timer = setTimeout(
      () => finish(false, `daemon 未在 ${RESET_ACK_TIMEOUT_MS}ms 内确认`),
      RESET_ACK_TIMEOUT_MS
    );
    sock.once("connect", () => {
      sock.write(JSON.stringify({ type: "reset", reason }) + "\n");
    });
    let buf = "";
    sock.on("data", (d: Buffer) => {
      buf += d.toString();
      const idx = buf.indexOf("\n");
      if (idx < 0) return;
      try {
        const ack = JSON.parse(buf.slice(0, idx)) as DaemonAck;
        if (ack.type === "ack" && ack.action === "respawning") {
          finish(true, "daemon 已确认");
        } else {
          finish(false, `daemon 回复异常: ${buf.slice(0, idx)}`);
        }
      } catch (e) {
        finish(false, `daemon 回复解析失败: ${(e as Error).message}`);
      }
    });
    sock.once("error", (e) => finish(false, `连接 daemon 失败: ${e.message}`));
  });
}

/**
 * Build the feishu interactive card for the reset result.
 *
 * Uses the repo's Card 2.0 convention (renderTextCard) so the reset card
 * looks the same as the other command cards (header + markdown body).
 */
export function buildResetCard(text: string): LarkCard {
  return renderTextCard("🔄 重启请求", text);
}

export const resetCommand: CommandDefinition = {
  name: "reset",
  description:
    "请求 deamon-for-roy 重启本进程（SIGTERM 后用最新构建的 roy-bot-local 重新拉起）",
  usage: "##command##: reset [reason]",

  async execute(ctx: CommandContext): Promise<CommandResult> {
    const reason = ctx.args.join(" ") || undefined;
    const socketPath = resolveSocketPath();
    const { confirmed, reason: why } = await requestReset(socketPath, reason);

    if (confirmed) {
      const text =
        "✅ 已请求重启：daemon 将停止本进程并用最新版本重新拉起，请稍候片刻。";
      return {
        ok: true,
        output: { text, card: buildResetCard(text), kind: "card" },
      };
    }
    const text =
      `⚠️ 未能联系 daemon，重启请求未生效（${why}）。\n` +
      `socket: ${socketPath}\n` +
      `请检查 deamon-for-roy 是否在运行；本进程将继续工作，不会中断。`;
    return {
      ok: true,
      output: { text, card: buildResetCard(text), kind: "card" },
    };
  },
};
