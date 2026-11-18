/**
 * @fileoverview Tool-call presentation model (Task #4124).
 *
 * `roy-bot interactive` renders tool activity the way opencode does: every tool
 * invocation becomes a compact, self-contained card with
 *   - an icon + humanised tool name,
 *   - the most relevant argument (command / path / pattern),
 *   - a live status badge (running → ✓ / ✗),
 *   - a bounded preview of the tool output.
 *
 * This module is intentionally **pure** (no React, no Ink) so the
 * formatting rules can be unit-tested directly and reused by both the
 * static transcript rows and the live "running tools" region.
 */

/**
 * Lifecycle of a single tool invocation.
 *   - `running`   — call emitted, result not yet received
 *   - `completed` — result received (success or a non-throwing failure)
 *   - `error`     — tool threw / was not found
 */
export type ToolCallStatus = "running" | "completed" | "error";

/** Everything the UI needs to render one tool card. */
export interface ToolCallInfo {
  /** Raw tool name as emitted by the agent (e.g. "read_file"). */
  name: string;
  /** Arguments the agent passed to the tool. */
  args?: Record<string, unknown>;
  status: ToolCallStatus;
  /** Human-readable (pre-truncated) output preview for completed calls. */
  output?: string;
  /** Error message for failed calls. */
  error?: string;
  /** Wall-clock duration between call and result, in milliseconds. */
  durationMs?: number;
}

/**
 * Normalised stream event for a tool invocation — the contract between
 * `interactive.ts` (which translates `StreamChunkEvent`s) and `RunTui` (which
 * renders the cards). Kept separate from `StreamChunkEvent` so the TUI
 * does not depend on the stream-output service internals.
 */
export type ToolStreamEvent =
  | { kind: "call"; id?: string; name: string; args?: Record<string, unknown> }
  | { kind: "result"; id?: string; name: string; output?: unknown }
  | { kind: "error"; id?: string; name: string; error?: string };

/** Resolved, render-ready description of a tool invocation. */
export interface ToolDescriptor {
  icon: string;
  label: string;
  /** Primary argument rendered under the title (single line, may be ""). */
  detail: string;
}

interface ToolMeta {
  icon: string;
  /** Display label; defaults to `humanizeToolName(name)` when omitted. */
  label?: string;
  /** Argument keys to probe (in priority order) for the detail line. */
  argKeys: string[];
}

/** Per-tool presentation metadata, keyed by canonical tool name. */
const TOOL_META: Record<string, ToolMeta> = {
  bash: { icon: "❯", label: "Bash", argKeys: ["command", "cmd"] },
  shell: { icon: "❯", label: "Bash", argKeys: ["command", "cmd"] },
  echo: { icon: "💬", label: "Echo", argKeys: ["message", "text"] },
  read_file: {
    icon: "📖",
    label: "Read",
    argKeys: ["file_path", "path", "filePath", "filename"],
  },
  write_file: {
    icon: "📝",
    label: "Write",
    argKeys: ["file_path", "path", "filePath", "filename"],
  },
  edit_file: {
    icon: "✏️",
    label: "Edit",
    argKeys: ["file_path", "path", "filePath", "filename"],
  },
  glob: { icon: "🔍", label: "Glob", argKeys: ["pattern"] },
  grep: { icon: "🔎", label: "Grep", argKeys: ["pattern", "query"] },
  query_background_process: {
    icon: "📡",
    label: "Background Process",
    argKeys: ["id", "process_id"],
  },
  understand_image: {
    icon: "🖼️",
    label: "Understand Image",
    argKeys: ["image_path", "path", "url"],
  },
  delegate_task: {
    icon: "🤖",
    label: "Task",
    argKeys: ["description", "prompt"],
  },
  stop_task: { icon: "🛑", label: "Stop Task", argKeys: ["task_id", "id"] },
  task_search: { icon: "🔎", label: "Task Search", argKeys: ["query"] },
  ask_user: { icon: "❓", label: "Ask User", argKeys: ["question"] },
  workflow_run: {
    icon: "🔀",
    label: "Run Workflow",
    argKeys: ["workflow", "name", "path"],
  },
  web_search: { icon: "🌐", label: "Web Search", argKeys: ["query"] },
  webfetch: { icon: "🌐", label: "Fetch", argKeys: ["url"] },
  fetch: { icon: "🌐", label: "Fetch", argKeys: ["url"] },
  skill: { icon: "🎯", label: "Skill", argKeys: ["name"] },
};

/** Alias tool names → canonical key in TOOL_META. */
const TOOL_ALIASES: Record<string, string> = {
  read: "read_file",
  write: "write_file",
  edit: "edit_file",
  search: "grep",
  task: "delegate_task",
  run_terminal_cmd: "bash",
  terminal: "bash",
};

/**
 * Turn a machine tool name into a human label: `read_file` → "Read File",
 * `queryBackgroundProcess` → "Query Background Process".
 */
export function humanizeToolName(name: string): string {
  if (!name) return "Tool";
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** Collapse a value to a single line and clamp it to `max` characters. */
function firstLine(value: string, max = 120): string {
  const line = value.split(/\r?\n/)[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Best-effort scalar summary of an argument bag ("" when nothing usable). */
function summarizeArgs(args: Record<string, unknown>): string {
  for (const value of Object.values(args)) {
    if (typeof value === "string" && value.trim()) return firstLine(value);
    if (typeof value === "number" || typeof value === "boolean") {
      return String(value);
    }
    if (Array.isArray(value) && value.length > 0) {
      return firstLine(value.map((v) => String(v)).join(" "));
    }
  }
  return "";
}

/**
 * Resolve the icon / label / detail for a tool invocation. Unknown tools
 * fall back to a generic `⚙` marker and a capitalised name.
 */
export function describeToolCall(
  name: string,
  args?: Record<string, unknown>
): ToolDescriptor {
  const meta = TOOL_META[name] ?? TOOL_META[TOOL_ALIASES[name] ?? ""];
  const label = meta?.label ?? humanizeToolName(name);
  const icon = meta?.icon ?? "⚙";

  let detail = "";
  if (args && Object.keys(args).length > 0) {
    const keys = meta?.argKeys ?? [];
    for (const key of keys) {
      const value = args[key];
      if (typeof value === "string" && value.trim()) {
        detail = firstLine(value);
        break;
      }
      if (
        value !== undefined &&
        value !== null &&
        typeof value !== "object"
      ) {
        detail = String(value);
        break;
      }
    }
    if (!detail) detail = summarizeArgs(args);
  }

  return { icon, label, detail };
}

/**
 * Coerce a tool result payload into display text. Handles the common
 * shapes: plain strings, the core `{ output }` envelope, and arbitrary
 * JSON (pretty-printed).
 */
export function stringifyToolOutput(output: unknown): string {
  if (output === undefined || output === null) return "";
  if (typeof output === "string") return output;
  if (typeof output === "object") {
    const obj = output as Record<string, unknown>;
    for (const key of ["output", "text", "content", "message"]) {
      if (typeof obj[key] === "string") return obj[key] as string;
    }
    try {
      return JSON.stringify(output, null, 2);
    } catch {
      return String(output);
    }
  }
  return String(output);
}

export interface FormatToolOutputOptions {
  /** Max output lines kept before truncation. Defaults to 12. */
  maxLines?: number;
  /** Max characters per line. Defaults to 200. */
  maxChars?: number;
}

/**
 * Bounded, terminal-friendly preview of a tool result. Truncates on the
 * line *and* character axes and appends a `… (+N more lines)` marker so
 * the caller can tell the preview was clipped.
 */
export function formatToolOutput(
  output: unknown,
  options: FormatToolOutputOptions = {}
): string {
  const { maxLines = 12, maxChars = 200 } = options;
  const text = stringifyToolOutput(output).replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  if (!text) return "";

  const lines = text.split("\n");
  const shown = lines.slice(0, maxLines);
  const hidden = lines.length - shown.length;

  const body = shown.map((line) => firstLine(line, maxChars)).join("\n");
  return hidden > 0 ? `${body}\n… (+${hidden} more lines)` : body;
}

/** Format a duration in ms as a short human string (e.g. "0.3s", "12s"). */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m${rest.toString().padStart(2, "0")}s`;
}
