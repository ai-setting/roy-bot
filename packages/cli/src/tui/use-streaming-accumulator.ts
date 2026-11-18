/**
 * @fileoverview useStreamingAccumulator hook — testable streaming state.
 *
 * Task #2657 Round 2 (T-A): extract streaming accumulation as a pure
 * (testable) hook. RunTui / ChatTui call this hook to manage
 * streamingText + status transitions while a stream is in flight.
 *
 * Task #4103 (opencode-style scrollback): the accumulator now separates the
 * **stable prefix** of the stream (safe to commit to the transcript) from
 * the **volatile tail** (kept in the live frame). Callers commit the result
 * of `drainStable()` and render only `streamingText`.
 *
 * Public API:
 *   const { status, streamingText, start, append, drainStable, finish, fail }
 *     = useStreamingAccumulator();
 *
 * Behavior:
 *   - start(): status → "thinking"
 *   - append(chunk): status → "streaming", buffers the chunk
 *   - drainStable(): returns the stable markdown-block prefix and removes it
 *     from the buffer; "" when nothing is stable yet
 *   - finish(): status → "idle", returns the remaining (un-committed) tail
 *   - fail(err): status → "idle", returns the remaining tail
 */

import { useCallback, useRef, useState } from "react";
import type { AppStatus } from "./App.js";
import { splitStable } from "./scrollback.js";

/**
 * Max lines kept live before the safety valve in splitStable force-commits
 * all but the last line — keeps the live frame bounded even for one huge
 * paragraph (opencode caps its footer region the same way).
 */
const DEFAULT_MAX_TAIL_LINES = 24;

export interface StreamingAccumulatorOptions {
  /**
   * Task #4123: bound on the un-committed tail, in lines. RunTui derives it
   * from the terminal height (rows − header/status/prompt) so the live frame
   * never exceeds the screen. Falls back to a sane constant.
   */
  maxTailLines?: number;
}

export interface StreamingAccumulator {
  /** Current status — "idle" / "thinking" / "streaming". */
  status: AppStatus;
  /** Volatile tail only (not yet committed to the transcript). */
  streamingText: string;
  /** Begin a new stream — clears buffers, sets status="thinking". */
  start: () => void;
  /** Append a delta — sets status="streaming", buffers the chunk. */
  append: (chunk: string) => void;
  /**
   * Release the stable markdown-block prefix (Task #4103) so the caller can
   * commit it to the transcript. Returns "" when nothing is stable yet.
   */
  drainStable: () => string;
  /**
   * Task #4124: release *all* buffered text (stable + volatile tail) so the
   * caller can commit it *before* an out-of-band event (a tool card) — this
   * keeps the transcript in emission order. Returns "" when empty.
   */
  flushPending: () => string;
  /** Finish — status="idle"; returns text to commit.
   *
   * If `finalText` is given (the handler's authoritative return value) the
   * already-emitted prefix is subtracted so only the missing suffix is
   * returned — this covers handlers that stream chunks *and* handlers that
   * only return the full text (no chunks emitted). */
  finish: (finalText?: string) => string;
  /** Mark stream as failed — status="idle", returns remaining tail. */
  fail: (err: Error) => string;
}

export function useStreamingAccumulator(
  options: StreamingAccumulatorOptions = {},
): StreamingAccumulator {
  const maxTailLines = options.maxTailLines ?? DEFAULT_MAX_TAIL_LINES;
  const [status, setStatus] = useState<AppStatus>("idle");
  const [streamingText, setStreamingText] = useState<string>("");
  // Full buffer for the current stream (committed prefix already removed).
  // A ref keeps multi-chunk bursts correct regardless of render timing.
  const pendingRef = useRef<string>("");
  // Total text already committed to the transcript by drainStable() across
  // the current stream. finish(finalText) reconciles this against the
  // handler's authoritative return value.
  const emittedRef = useRef<string>("");

  const start = useCallback(() => {
    pendingRef.current = "";
    emittedRef.current = "";
    setStreamingText("");
    setStatus("thinking");
  }, []);

  const append = useCallback((chunk: string) => {
    pendingRef.current += chunk;
    setStreamingText(pendingRef.current);
    setStatus("streaming");
  }, []);

  const drainStable = useCallback((): string => {
    const { stable, tail } = splitStable(pendingRef.current, {
      maxTailLines,
    });
    if (!stable) return "";
    pendingRef.current = tail;
    emittedRef.current += stable;
    setStreamingText(tail);
    return stable;
  }, [maxTailLines]);

  const flushPending = useCallback((): string => {
    const pending = pendingRef.current;
    if (!pending) return "";
    pendingRef.current = "";
    emittedRef.current += pending;
    setStreamingText("");
    return pending;
  }, []);

  const finish = useCallback((finalText?: string): string => {
    // Reconcile against the handler's authoritative return value (when
    // given). `emittedRef` is the total text already committed to the
    // transcript by previous drainStable() calls; pendingRef holds the
    // volatile tail still in the live frame. The committed result is
    // whichever of {pending tail, suffix of finalText, finalText} is
    // missing from `emittedRef` — so handlers that stream chunks and
    // handlers that only return the full text both work.
    const pending = pendingRef.current;
    pendingRef.current = "";
    setStreamingText("");
    setStatus("idle");
    if (finalText === undefined) {
      emittedRef.current += pending;
      return pending;
    }
    if (finalText.startsWith(emittedRef.current)) {
      const suffix = finalText.slice(emittedRef.current.length);
      emittedRef.current = finalText;
      return suffix;
    }
    // Mismatch (handler rewrote earlier text) — fall back to common prefix.
    const emitted = emittedRef.current;
    let i = 0;
    const max = Math.min(emitted.length, finalText.length);
    while (i < max && emitted.charCodeAt(i) === finalText.charCodeAt(i)) {
      i++;
    }
    emittedRef.current = finalText;
    return finalText.slice(i);
  }, []);

  const fail = useCallback((_err: Error) => {
    const rest = pendingRef.current;
    pendingRef.current = "";
    setStreamingText("");
    setStatus("idle");
    return rest;
  }, []);

  return { status, streamingText, start, append, drainStable, flushPending, finish, fail };
}
