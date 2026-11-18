/**
 * @fileoverview Tests for useStreamingAccumulator hook.
 *
 * Task #2657 Round 2 (T-A): verify the streaming state machine:
 *   - start(): clears text + status="thinking"
 *   - append(chunk): status="streaming", text += chunk
 *   - finish(): status="idle", returns final text
 *   - fail(err): status="idle", returns text + err ignored
 *
 * Test renders a tiny harness component that calls the hook and
 * exposes its API + state via a ref so we can assert outside React.
 */

import { describe, it, expect } from "bun:test";
import { isParallelRun } from "../test-utils/parallel-guard";
import { render } from "ink-testing-library";
import React, { useEffect } from "react";
import { useStreamingAccumulator } from "./use-streaming-accumulator.js";

interface Harness {
  start: () => void;
  append: (chunk: string) => void;
  drainStable: () => string;
  flushPending: () => string;
  finish: (finalText?: string) => string;
  fail: (e: Error) => string;
  getStatus: () => string;
  getText: () => string;
}

/**
 * Test harness — renders the hook and exposes its API via ref-like getters.
 * React doesn't allow reading state imperatively without a ref, so we
 * capture the latest state in a mutable wrapper.
 */
function Harness({
  onReady,
  maxTailLines,
}: {
  onReady: (h: Harness) => void;
  maxTailLines?: number;
}) {
  const acc = useStreamingAccumulator(
    maxTailLines === undefined ? {} : { maxTailLines },
  );
  const statusRef = React.useRef(acc.status);
  const textRef = React.useRef(acc.streamingText);
  statusRef.current = acc.status;
  textRef.current = acc.streamingText;

  useEffect(() => {
    onReady({
      start: () => acc.start(),
      append: (c) => acc.append(c),
      drainStable: () => acc.drainStable(),
      flushPending: () => acc.flushPending(),
      finish: (finalText?: string) => acc.finish(finalText),
      fail: (e) => acc.fail(e),
      getStatus: () => statusRef.current,
      getText: () => textRef.current,
    });
    // Run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

async function makeHarness(maxTailLines?: number): Promise<Harness> {
  return new Promise<Harness>((resolve) => {
    const { rerender } = render(
      <Harness onReady={resolve} maxTailLines={maxTailLines} />,
    );
    // rerender is needed because onReady fires inside useEffect which
    // runs after the initial render commit; the test harness above
    // already triggers the callback synchronously after mount.
    void rerender;
  });
}

describe.skipIf(isParallelRun)("useStreamingAccumulator hook", () => {
  it("initial state: idle / empty text", async () => {
    const h = await makeHarness();
    expect(h.getStatus()).toBe("idle");
    expect(h.getText()).toBe("");
  });

  it("start() → status='thinking', text cleared", async () => {
    const h = await makeHarness();
    h.start();
    expect(h.getStatus()).toBe("thinking");
    expect(h.getText()).toBe("");
  });

  it("append(chunk) → status='streaming', text accumulates", async () => {
    const h = await makeHarness();
    h.start();
    h.append("Hello");
    expect(h.getStatus()).toBe("streaming");
    expect(h.getText()).toBe("Hello");
    h.append(", ");
    h.append("world");
    expect(h.getText()).toBe("Hello, world");
  });

  it("finish() → status='idle', returns final text", async () => {
    const h = await makeHarness();
    h.start();
    h.append("a");
    h.append("b");
    const returned = h.finish();
    expect(h.getStatus()).toBe("idle");
    expect(returned).toBe("ab");
  });

  it("fail(err) → status='idle', returns current text", async () => {
    const h = await makeHarness();
    h.start();
    h.append("partial");
    const returned = h.fail(new Error("boom"));
    expect(h.getStatus()).toBe("idle");
    expect(returned).toBe("partial");
  });

  // Task #2728 bugfix: finish() must clear streamingText to prevent
  // duplicate rendering (streaming region + history item showing same text).
  it("finish() → clears streamingText (Bug 2: duplicate output fix)", async () => {
    const h = await makeHarness();
    h.start();
    h.append("hello");
    h.append(" world");
    const returned = h.finish();
    expect(returned).toBe("hello world");
    expect(h.getStatus()).toBe("idle");
    // Bug 2 fix: streamingText must be cleared after finish
    expect(h.getText()).toBe("");
  });

  it("fail() → clears streamingText (consistent with finish)", async () => {
    const h = await makeHarness();
    h.start();
    h.append("partial");
    h.fail(new Error("boom"));
    expect(h.getStatus()).toBe("idle");
    expect(h.getText()).toBe("");
  });

  // Task #4103: progressive scrollback commit.
  it("drainStable() returns '' while nothing is stable", async () => {
    const h = await makeHarness();
    h.start();
    h.append("no blank line yet");
    expect(h.drainStable()).toBe("");
    expect(h.getText()).toBe("no blank line yet");
  });

  it("drainStable() releases stable blocks and keeps the tail live", async () => {
    const h = await makeHarness();
    h.start();
    h.append("para1\n\npara2");
    expect(h.drainStable()).toBe("para1\n\n");
    expect(h.getText()).toBe("para2");
  });

  it("finish() returns only the un-committed tail after a drain", async () => {
    const h = await makeHarness();
    h.start();
    h.append("a\n\nb");
    h.drainStable(); // commits "a\n\n"
    expect(h.finish()).toBe("b");
    expect(h.getText()).toBe("");
  });

  // Task #4103: finish(finalText) reconciles the handler's authoritative
  // return value against the already-committed prefix. Covers handlers that
  // stream chunks (emittedRef = committed prefix) and handlers that only
  // return the full text without emitting chunks (emittedRef = "").
  it("finish(finalText) returns the missing tail after a partial drain", async () => {
    const h = await makeHarness();
    h.start();
    h.append("a\n\nb");
    h.drainStable(); // commits "a\n\n", emittedRef="a\n\n"
    // Handler's authoritative return value: "a\n\nb"
    expect(h.finish("a\n\nb")).toBe("b");
    expect(h.getText()).toBe("");
  });

  it("finish(finalText) returns the full text when no chunks were emitted", async () => {
    const h = await makeHarness();
    h.start();
    // No onChunk called, no drainStable called — handler only returns text.
    expect(h.finish("The notification was handled successfully.")).toBe(
      "The notification was handled successfully."
    );
    expect(h.getText()).toBe("");
    expect(h.getStatus()).toBe("idle");
  });

  it("finish(finalText) discards the pending tail and emits the suffix", async () => {
    const h = await makeHarness();
    h.start();
    h.append("a\n\nbc"); // pending tail = "a\n\nbc"
    h.drainStable(); // commits "a\n\n", emittedRef="a\n\n", pending="bc"
    // Handler says the authoritative text is "a\n\nbcd" (suffix "d" added)
    // → emittedRef="a\n\n" is a prefix of finalText → return finalText.slice(5) = "bcd"
    expect(h.finish("a\n\nbcd")).toBe("bcd");
    expect(h.getText()).toBe("");
  });

  // Task #4123 (footer height budget): a small maxTailLines forces a commit
  // so the live tail can never exceed the reserved terminal rows.
  it("honours a small maxTailLines by force-committing the overflow", async () => {
    const h = await makeHarness(2);
    h.start();
    h.append("l1\nl2\nl3\nl4"); // no blank line → safety valve
    expect(h.drainStable()).toBe("l1\nl2\nl3\n");
    expect(h.getText()).toBe("l4");
  });

  // Task #4124: flushPending() releases *all* buffered text so an
  // out-of-band event (a tool card) can be committed in order.
  it("flushPending() returns and clears the whole buffer", async () => {
    const h = await makeHarness();
    h.start();
    h.append("partial sentence");
    expect(h.flushPending()).toBe("partial sentence");
    expect(h.getText()).toBe("");
    // Nothing left to drain/finish
    expect(h.drainStable()).toBe("");
    expect(h.finish()).toBe("");
  });

  it("flushPending() returns '' when the buffer is empty", async () => {
    const h = await makeHarness();
    h.start();
    expect(h.flushPending()).toBe("");
  });

  it("flushPending() then finish(finalText) reconciles the committed prefix", async () => {
    const h = await makeHarness();
    h.start();
    h.append("before tool");
    expect(h.flushPending()).toBe("before tool");
    h.append("after tool");
    // Authoritative text: "before toolafter tool" → emittedRef was
    // "before tool", so only the suffix is returned.
    expect(h.finish("before toolafter tool")).toBe("after tool");
  });
});
