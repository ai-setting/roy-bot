/**
 * @fileoverview useStreamingAccumulator tests — **opentui/solid** edition
 * (Task #4679 片5).
 *
 * 1:1 port of the 17 assertions (38 `expect`s) of
 * `tui/use-streaming-accumulator.test.tsx`. The Ink file is **untouched** —
 * it still guards the live Ink chain (`ChatTui.tsx` / `RunTui.tsx` →
 * `tui/use-streaming-accumulator.ts`).
 *
 * ## No JSX needed — and no repaint needed
 *
 * The Ink suite renders a tiny React harness component to reach the hook and
 * then reads its state imperatively. The Solid accumulator is a **plain
 * factory function** (`useStreamingAccumulator(options)` returns an object
 * of closures), so it can be called directly — no renderer, no frame, no
 * repaint. That makes this the one port in the batch that is immune to both
 * measured blockers.
 *
 * The only API difference is that the Solid version exposes the reactive
 * fields as **getters** (`status()` / `streamingText()`) rather than plain
 * properties, so the reads are adjusted accordingly:
 *
 *   Ink            →  h.getStatus()          Solid →  acc.status()
 *   Ink            →  h.getText()            Solid →  acc.streamingText()
 *   Ink            →  h.drainStable()        Solid →  acc.drainStable()
 *   Ink            →  h.flushPending()       Solid →  acc.flushPending()
 *   Ink            →  h.finish([text])       Solid →  acc.finish([text])
 *   Ink            →  h.fail(err)            Solid →  acc.fail(err)
 *
 * Every `expect` from the Ink suite is reproduced with the **same matcher
 * and the same expected value** — exact equality (`toBe`) is kept
 * everywhere the Ink suite used it; nothing was relaxed to `toContain`.
 *
 * The pre-existing `tui-solid/use-streaming-accumulator.test.ts` (Task #4278
 * 片6) covers the reasoning buffer; this file covers the **streaming state
 * machine** and is the counterpart of the Ink suite.
 */

import { describe, it, expect } from "bun:test";
import { useStreamingAccumulator } from "./use-streaming-accumulator.js";

describe("useStreamingAccumulator hook (opentui/solid)", () => {
  it("initial state: idle / empty text", () => {
    const acc = useStreamingAccumulator();
    expect(acc.status()).toBe("idle");
    expect(acc.streamingText()).toBe("");
  });

  it("start() → status='thinking', text cleared", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    expect(acc.status()).toBe("thinking");
    expect(acc.streamingText()).toBe("");
  });

  it("append(chunk) → status='streaming', text accumulates", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.append("Hello");
    expect(acc.status()).toBe("streaming");
    expect(acc.streamingText()).toBe("Hello");
    acc.append(", ");
    acc.append("world");
    expect(acc.streamingText()).toBe("Hello, world");
  });

  it("finish() → status='idle', returns final text", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.append("a");
    acc.append("b");
    const returned = acc.finish();
    expect(acc.status()).toBe("idle");
    expect(returned).toBe("ab");
  });

  it("fail(err) → status='idle', returns current text", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.append("partial");
    const returned = acc.fail(new Error("boom"));
    expect(acc.status()).toBe("idle");
    expect(returned).toBe("partial");
  });

  // Task #2728 bugfix: finish() must clear streamingText to prevent
  // duplicate rendering (streaming region + history item showing same text).
  it("finish() → clears streamingText (Bug 2: duplicate output fix)", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.append("hello");
    acc.append(" world");
    const returned = acc.finish();
    expect(returned).toBe("hello world");
    expect(acc.status()).toBe("idle");
    // Bug 2 fix: streamingText must be cleared after finish
    expect(acc.streamingText()).toBe("");
  });

  it("fail() → clears streamingText (consistent with finish)", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.append("partial");
    acc.fail(new Error("boom"));
    expect(acc.status()).toBe("idle");
    expect(acc.streamingText()).toBe("");
  });

  // Task #4103: progressive scrollback commit.
  it("drainStable() returns '' while nothing is stable", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.append("no blank line yet");
    expect(acc.drainStable()).toBe("");
    expect(acc.streamingText()).toBe("no blank line yet");
  });

  it("drainStable() releases stable blocks and keeps the tail live", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.append("para1\n\npara2");
    expect(acc.drainStable()).toBe("para1\n\n");
    expect(acc.streamingText()).toBe("para2");
  });

  it("finish() returns only the un-committed tail after a drain", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.append("a\n\nb");
    acc.drainStable(); // commits "a\n\n"
    expect(acc.finish()).toBe("b");
    expect(acc.streamingText()).toBe("");
  });

  // Task #4103: finish(finalText) reconciles the handler's authoritative
  // return value against the already-committed prefix. Covers handlers that
  // stream chunks (emittedRef = committed prefix) and handlers that only
  // return the full text without emitting chunks (emittedRef = "").
  it("finish(finalText) returns the missing tail after a partial drain", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.append("a\n\nb");
    acc.drainStable(); // commits "a\n\n", emittedRef="a\n\n"
    // Handler's authoritative return value: "a\n\nb"
    expect(acc.finish("a\n\nb")).toBe("b");
    expect(acc.streamingText()).toBe("");
  });

  it("finish(finalText) returns the full text when no chunks were emitted", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    // No onChunk called, no drainStable called — handler only returns text.
    expect(acc.finish("The notification was handled successfully.")).toBe(
      "The notification was handled successfully.",
    );
    expect(acc.streamingText()).toBe("");
    expect(acc.status()).toBe("idle");
  });

  it("finish(finalText) discards the pending tail and emits the suffix", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.append("a\n\nbc"); // pending tail = "a\n\nbc"
    acc.drainStable(); // commits "a\n\n", emittedRef="a\n\n", pending="bc"
    // Handler says the authoritative text is "a\n\nbcd" (suffix "d" added)
    // → emittedRef="a\n\n" is a prefix of finalText → return finalText.slice(5) = "bcd"
    expect(acc.finish("a\n\nbcd")).toBe("bcd");
    expect(acc.streamingText()).toBe("");
  });

  // Task #4123 (footer height budget): a small maxTailLines forces a commit
  // so the live tail can never exceed the reserved terminal rows.
  it("honours a small maxTailLines by force-committing the overflow", () => {
    const acc = useStreamingAccumulator({ maxTailLines: 2 });
    acc.start();
    acc.append("l1\nl2\nl3\nl4"); // no blank line → safety valve
    expect(acc.drainStable()).toBe("l1\nl2\nl3\n");
    expect(acc.streamingText()).toBe("l4");
  });

  // Task #4124: flushPending() releases *all* buffered text so an
  // out-of-band event (a tool card) can be committed in order.
  it("flushPending() returns and clears the whole buffer", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.append("partial sentence");
    expect(acc.flushPending()).toBe("partial sentence");
    expect(acc.streamingText()).toBe("");
    expect(acc.drainStable()).toBe("");
    expect(acc.finish()).toBe("");
  });

  it("flushPending() returns '' when the buffer is empty", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    expect(acc.flushPending()).toBe("");
  });

  it("flushPending() then finish(finalText) reconciles the committed prefix", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.append("before tool");
    expect(acc.flushPending()).toBe("before tool");
    expect(acc.finish("before toolafter tool")).toBe("after tool");
    expect(acc.streamingText()).toBe("");
  });
});
