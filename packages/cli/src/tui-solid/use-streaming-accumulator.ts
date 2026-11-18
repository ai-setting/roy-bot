/**
 * @fileoverview useStreamingAccumulator — **Solid** fork of the streaming hook.
 *
 * Forked from `tui/use-streaming-accumulator.ts` (React) for the
 * `roy-bot interactive` chain (Task #4278, 片1).
 *
 * The accumulation *policy* (stable-prefix split, tail bound, finish
 * reconciliation) is unchanged — `splitStable` is re-used from the shared
 * Ink-side `tui/scrollback.ts` (pure, no JSX).
 *
 * Port notes (React → Solid):
 *   useState  → createSignal (getter functions, no stale closures)
 *   useRef    → plain closure variables backed by a small mutable object
 *   useCallback → plain functions (Solid has no re-render identity problem)
 *
 * Public API shape differs slightly: React returned `{ status, streamingText,
 * … }` where `streamingText` was a string. Solid returns accessors
 * (`status()`, `streamingText()`) so reactivity is preserved.
 *
 * 片6 (Task #4278) — thinking block clickable:
 *   The accumulator now also buffers the model's **reasoning** text
 *   (`appendReasoning()` / `thinkingText()`), so the TUI can show it inside an
 *   expand-on-click region under the "Agent is thinking…" row. Reasoning is
 *   kept strictly separate from `streamingText` (the answer) — appending it
 *   must not flip `status` to "streaming" nor appear in the reply.
 */

import { createSignal } from "solid-js";
import type { AppStatus } from "./App.js";
import { splitStable } from "../tui/scrollback.js";

const DEFAULT_MAX_TAIL_LINES = 24;

export interface StreamingAccumulatorOptions {
  /** Bound on the un-committed tail, in lines (derived from terminal height). */
  maxTailLines?: number;
}

export interface StreamingAccumulator {
  /** Current status — "idle" / "thinking" / "streaming". */
  status: () => AppStatus;
  /** Volatile tail only (not yet committed to the transcript). */
  streamingText: () => string;
  /**
   * Task #4278 片6 — accumulated model reasoning / thinking text for the
   * current turn. Rendered inside the click-to-expand "Agent is thinking…"
   * region. Kept separate from `streamingText` so reasoning never pollutes
   * the assistant answer.
   */
  thinkingText: () => string;
  /** Begin a new stream — clears buffers, sets status="thinking". */
  start: () => void;
  /** Append a delta — sets status="streaming", buffers the chunk. */
  append: (chunk: string) => void;
  /**
   * Task #4278 片6 — append a reasoning delta. Deliberately does **not**
   * touch `status` / `streamingText`: reasoning arrives *before* the answer,
   * so the spinner must stay in "thinking" while thinking text accumulates.
   */
  appendReasoning: (chunk: string) => void;
  /** Release the stable markdown-block prefix so the caller can commit it. */
  drainStable: () => string;
  /** Release *all* buffered text (stable + volatile tail). */
  flushPending: () => string;
  /** Finish — status="idle"; returns text to commit. */
  finish: (finalText?: string) => string;
  /** Mark stream as failed — status="idle", returns remaining tail. */
  fail: (err: Error) => string;
}

export function useStreamingAccumulator(
  options: StreamingAccumulatorOptions = {},
): StreamingAccumulator {
  const maxTailLines = options.maxTailLines ?? DEFAULT_MAX_TAIL_LINES;
  const [status, setStatus] = createSignal<AppStatus>("idle");
  const [streamingText, setStreamingText] = createSignal<string>("");
  // 片6: reasoning buffer (separate signal so it repaints independently).
  const [thinkingText, setThinkingText] = createSignal<string>("");

  // Full buffer for the current stream (committed prefix already removed).
  // A mutable box keeps multi-chunk bursts correct regardless of render timing.
  const refs = { pending: "", emitted: "" };

  const start = () => {
    refs.pending = "";
    refs.emitted = "";
    setStreamingText("");
    setThinkingText("");
    setStatus("thinking");
  };

  const append = (chunk: string) => {
    refs.pending += chunk;
    setStreamingText(refs.pending);
    setStatus("streaming");
  };

  // 片6: reasoning is append-only and side-effect free w.r.t. the answer
  // stream — it must not set status="streaming" nor clear the spinner.
  const appendReasoning = (chunk: string) => {
    if (!chunk) return;
    setThinkingText((prev) => prev + chunk);
  };

  const drainStable = (): string => {
    const { stable, tail } = splitStable(refs.pending, { maxTailLines });
    if (!stable) return "";
    refs.pending = tail;
    refs.emitted += stable;
    setStreamingText(tail);
    return stable;
  };

  const flushPending = (): string => {
    const pending = refs.pending;
    if (!pending) return "";
    refs.pending = "";
    refs.emitted += pending;
    setStreamingText("");
    return pending;
  };

  const finish = (finalText?: string): string => {
    const pending = refs.pending;
    refs.pending = "";
    setStreamingText("");
    setStatus("idle");
    // 片6: thinkingText intentionally survives finish() so the completed turn's
    // reasoning stays readable until the next start() clears it.
    if (finalText === undefined) {
      refs.emitted += pending;
      return pending;
    }
    if (finalText.startsWith(refs.emitted)) {
      const suffix = finalText.slice(refs.emitted.length);
      refs.emitted = finalText;
      return suffix;
    }
    // Mismatch (handler rewrote earlier text) — fall back to common prefix.
    const emitted = refs.emitted;
    let i = 0;
    const max = Math.min(emitted.length, finalText.length);
    while (i < max && emitted.charCodeAt(i) === finalText.charCodeAt(i)) i++;
    const suffix = finalText.slice(i);
    refs.emitted = finalText;
    return suffix;
  };

  const fail = (err: Error): string => {
    void err;
    const pending = refs.pending;
    refs.pending = "";
    setStreamingText("");
    setStatus("idle");
    refs.emitted += pending;
    return pending;
  };

  return {
    status,
    streamingText,
    thinkingText,
    start,
    append,
    appendReasoning,
    drainStable,
    flushPending,
    finish,
    fail,
  };
}
