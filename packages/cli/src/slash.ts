/**
 * @fileoverview Slash command dispatcher for the run REPL.
 *
 * Task #2610 stage 3: implements the prototype slash.ts from
 * refs/imported/ink-tui-overhaul. Pure-function dispatcher — no I/O,
 * no React — so it can be tested deterministically.
 *
 * Slash commands are local shortcuts that do not contact the LLM. They
 * take the form `/command [args...]` and are routed through
 * `dispatchSlashCommand()` before any chat message is sent.
 *
 * Supported commands:
 *   /help     — show available slash commands
 *   /clear    — clear conversation history
 *   /exit     — exit the REPL (handled by the TUI layer, not here)
 *   /quit     — alias for /exit
 *   /model    — show the current model identifier
 *   /history  — show how many user/assistant turns have occurred
 *   /workdir  — show the current working directory
 *   /max-lines <N>  — change the truncation limit (live, takes effect
 *                     on the next response)
 *
 * Each handler returns a SlashResult describing what to do next:
 *   - { kind: "handled", message }  → display message in REPL, stay
 *   - { kind: "exit" }              → exit the REPL
 *   - { kind: "pass" }              → not a slash command, send as chat
 *   - { kind: "unknown", message }  → display error, stay
 *   - { kind: "set-max-lines", value }  → change max-lines setting
 */

export interface SlashContext {
  /** Current model identifier (or undefined for default). */
  model?: string;
  /** Current working directory. */
  workdir?: string;
  /** Current max-lines setting (mutable; commands can update it). */
  maxLines: number;
  /** Number of user turns so far. */
  userTurnCount: number;
  /** Number of assistant turns so far. */
  assistantTurnCount: number;
}

export type SlashResult =
  | { kind: "handled"; message: string }
  | { kind: "exit" }
  | { kind: "pass" }
  | { kind: "unknown"; message: string }
  | { kind: "set-max-lines"; value: number };

/**
 * Sentinel message for /clear: the caller detects this exact string and
 * wipes history (without showing it in the REPL). Defined here so the
 * dispatcher's contract stays in one file.
 */
export const CLEAR_SENTINEL = "__CLEAR__";

export function dispatchSlashCommand(
  raw: string,
  ctx: SlashContext
): SlashResult {
  const text = raw.trim();
  if (!text.startsWith("/")) {
    return { kind: "pass" };
  }

  // Strip the leading slash and split into tokens
  const withoutSlash = text.slice(1);
  const spaceIdx = withoutSlash.search(/\s/);
  const command = (
    spaceIdx === -1 ? withoutSlash : withoutSlash.slice(0, spaceIdx)
  ).toLowerCase();
  const args = spaceIdx === -1 ? "" : withoutSlash.slice(spaceIdx + 1).trim();

  switch (command) {
    case "help": {
      return {
        kind: "handled",
        message: [
          "Available slash commands:",
          "  /help          Show this help",
          "  /clear         Clear conversation history",
          "  /exit          Exit the REPL",
          "  /quit          Alias for /exit",
          "  /model         Show the current model",
          "  /history       Show turn counts",
          "  /workdir       Show working directory",
          "  /max-lines N   Set truncation limit (0 = unlimited)",
        ].join("\n"),
      };
    }
    case "clear": {
      return { kind: "handled", message: CLEAR_SENTINEL };
    }
    case "exit":
    case "quit": {
      return { kind: "exit" };
    }
    case "model": {
      return {
        kind: "handled",
        message: `Current model: ${ctx.model || "(default)"}`,
      };
    }
    case "history": {
      return {
        kind: "handled",
        message: `Turns so far — user: ${ctx.userTurnCount}, assistant: ${ctx.assistantTurnCount}`,
      };
    }
    case "workdir": {
      return {
        kind: "handled",
        message: `Working directory: ${ctx.workdir || process.cwd()}`,
      };
    }
    case "max-lines": {
      const n = Number.parseInt(args, 10);
      if (Number.isNaN(n) || n < 0) {
        return {
          kind: "unknown",
          message: `Usage: /max-lines N  (N >= 0, 0 = unlimited)`,
        };
      }
      return { kind: "set-max-lines", value: n };
    }
    default:
      return {
        kind: "unknown",
        message: `Unknown command: /${command}. Type /help for the list.`,
      };
  }
}