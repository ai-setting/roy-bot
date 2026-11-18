/**
 * @fileoverview Tests for the **片6** reasoning accumulator extension.
 *
 * Task #4278 片6 (thinking block clickable) needs the accumulator to buffer the
 * streamed reasoning/thinking text (previously only `status` was tracked), so
 * the CLI can render it inside an expand-on-click region.
 *
 * These are pure-logic assertions (no JSX / no renderer), so they run under
 * plain `bun test` without the Solid JSX transform.
 */

import { describe, expect, test } from "bun:test";
import { useStreamingAccumulator } from "./use-streaming-accumulator.js";

describe("片6: useStreamingAccumulator reasoning buffer", () => {
  test("thinkingText() starts empty", () => {
    const acc = useStreamingAccumulator();
    expect(acc.thinkingText()).toBe("");
  });

  test("appendReasoning() accumulates deltas in order (append semantics)", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.appendReasoning("Let me ");
    acc.appendReasoning("think ");
    acc.appendReasoning("about this.");
    expect(acc.thinkingText()).toBe("Let me think about this.");
  });

  test("appendReasoning() does NOT change status (reasoning precedes text)", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    expect(acc.status()).toBe("thinking");
    acc.appendReasoning("hmm");
    // Still "thinking" — reasoning must not be mistaken for the answer stream.
    expect(acc.status()).toBe("thinking");
    expect(acc.streamingText()).toBe("");
  });

  test("appendReasoning() does not pollute streamingText()", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.appendReasoning("secret reasoning");
    acc.append("actual answer");
    expect(acc.thinkingText()).toBe("secret reasoning");
    expect(acc.streamingText()).toBe("actual answer");
    expect(acc.status()).toBe("streaming");
  });

  test("start() clears the previous turn's reasoning", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.appendReasoning("turn one reasoning");
    expect(acc.thinkingText()).toBe("turn one reasoning");
    acc.start();
    expect(acc.thinkingText()).toBe("");
  });

  test("finish() keeps thinkingText (the turn's reasoning stays readable)", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.appendReasoning("reasoning stays");
    acc.append("answer");
    acc.finish("answer");
    expect(acc.status()).toBe("idle");
    expect(acc.thinkingText()).toBe("reasoning stays");
  });

  test("fail() keeps thinkingText for post-mortem display", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.appendReasoning("partial reasoning");
    acc.fail(new Error("boom"));
    expect(acc.thinkingText()).toBe("partial reasoning");
  });

  test("interleaved reasoning/text still tracks both independently", () => {
    const acc = useStreamingAccumulator();
    acc.start();
    acc.appendReasoning("r1");
    acc.append("t1");
    acc.appendReasoning("r2");
    acc.append("t2");
    expect(acc.thinkingText()).toBe("r1r2");
    expect(acc.streamingText()).toBe("t1t2");
  });
});
