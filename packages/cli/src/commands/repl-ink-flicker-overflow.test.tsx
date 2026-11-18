/**
 * @fileoverview Task #2657 continuation — high-volume Ink flicker RED tests.
 *
 * Goal: prove that current REPLInk + Static + React.memo design still
 * writes `clearTerminal + fullStaticOutput + output` when the dynamic
 * region grows past the available terminal height, so every plain key
 * press / Backspace / new message / streaming delta repaints the
 * whole screen and replays all stable history.
 *
 * These tests run ink in *production* mode (debug=false) with a fake
 * 80x24 TTY. We assert on the bytes written to stdout, which is the
 * only user-visible signal of flicker.
 *
 * The fixture focuses on:
 *   - completed long-tail last message + plain input
 *   - completed long-tail + Backspace
 *   - appending a new long message
 *   - streaming a long delta, then finishing, then inputting
 *
 * All four cases are expected to FAIL before the architectural fix
 * lands (clearTerminal>0, fullStaticOutput replay, dynamic tail bytes
 * dominating the write).
 *
 * ----- Bun / parallel-runner caveat (Task #2657 R2 v2) -----
 * ink@5.2.1 + yoga-layout@3.2.1 uses a top-level `await loadYoga()`
 * to load the WASM binary. When bun's parallel test runner starts a
 * worker that touches ink, the WASM init races against the first
 * `new Ink()` call and trips "Cannot access 'Yoga' before
 * initialization". This is a known bun-specific hazard (not a fix
 * bug). Running tests in serial mode (`bun test` without
 * `--parallel`) avoids the race because all tests share the same
 * module cache. To verify these tests, run:
 *
 *     bun test packages/cli/src/commands/repl-ink-flicker-overflow.test.tsx
 *
 * Running with `--parallel=N` for N >= 1 will trigger the race and
 * all five tests will fail with Yoga TDZ errors before reaching the
 * assertions.
 */
import { test, expect, describe } from "bun:test";
import { EventEmitter } from "node:events";
import * as React from "react";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no types for the bundled ink build, but that's fine in tests
import { render as inkRender } from "ink";
// @ts-ignore — REPLInk is React JSX/TS; we import the TS file directly via bun
import { REPLInk, type REPLInkApi } from "./repl-ink";

const CLEAR = "\u001b[2J\u001b[3J\u001b[H";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class CaptureStdout extends EventEmitter {
  public columns = 80;
  public rows = 24;
  public isTTY = true;
  public writes: string[] = [];
  write = (data: unknown): boolean => {
    this.writes.push(typeof data === "string" ? data : String(data));
    return true;
  };
  reset(): void { this.writes.length = 0; }
}
class CaptureStderr extends EventEmitter {
  write = (): boolean => true;
}
class CaptureStdin extends EventEmitter {
  public isTTY = true;
  public data: string | null = null;
  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}
  read = (): string | null => {
    const d = this.data;
    this.data = null;
    return d;
  };
  send(chunk: string): void {
    this.data = chunk;
    this.emit("readable");
    this.emit("data", chunk);
  }
}

interface MountHandle {
  stdout: CaptureStdout;
  stderr: CaptureStderr;
  stdin: CaptureStdin;
  api: REPLInkApi;
  unmount(): void;
}

async function mountREPLInk(
  initialMessages: Array<{ role: "user" | "assistant" | "system" | "tool" | "tool_result" | "reasoning"; content: string; kind?: "welcome"; streaming?: boolean }>,
): Promise<MountHandle> {
  const stdout = new CaptureStdout();
  const stderr = new CaptureStderr();
  const stdin = new CaptureStdin();
  let api: REPLInkApi | null = null;
  const tree = React.createElement(REPLInk, {
    initialContext: {
      model: "M3",
      cwd: "/tmp",
      version: "1.0",
      sessionTitle: "flicker-fixture",
    },
    initialMessages,
    onSubmit: () => {},
    onReady: (a: REPLInkApi) => { api = a; },
  });
  const inst = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: false,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await wait(180);
  if (!api) throw new Error("REPLInk did not expose api in time");
  return {
    stdout,
    stderr,
    stdin,
    api,
    unmount: () => inst.unmount(),
  };
}

const LONG_TAIL = Array.from({ length: 36 }, (_, i) => `LONG-TAIL-${String(i).padStart(2, "0")}`).join("\n");
const STABLE = Array.from({ length: 30 }, (_, i) => ({
  role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
  content: `HIST-${String(i).padStart(2, "0")}`,
}));

describe("Task #2657 (continuation) — Ink high-volume flicker RED", () => {
  test("RED-1: completed long tail + plain 'a' must NOT clearTerminal nor replay stable history", async () => {
    const h = await mountREPLInk([...STABLE, { role: "assistant", content: LONG_TAIL }]);
    h.stdout.reset();
    h.stdin.send("a");
    await wait(120);
    const joined = h.stdout.writes.join("");
    // user-visible flicker evidence: both metrics must be exactly zero.
    expect(joined.split(CLEAR).length - 1).toBe(0);
    expect(joined.split("HIST-00").length - 1).toBe(0);
    h.unmount();
  });

  test("RED-2: completed long tail + Backspace must NOT clearTerminal nor replay stable history", async () => {
    const h = await mountREPLInk([...STABLE, { role: "assistant", content: LONG_TAIL }]);
    h.stdout.reset();
    h.stdin.send("\u007f");
    await wait(120);
    const joined = h.stdout.writes.join("");
    expect(joined.split(CLEAR).length - 1).toBe(0);
    expect(joined.split("HIST-00").length - 1).toBe(0);
    h.unmount();
  });

  test("RED-3: appending a new long message must NOT full-clear or replay the whole stable history", async () => {
    const h = await mountREPLInk(STABLE);
    h.stdout.reset();
    h.api.appendMessage({ role: "assistant", content: LONG_TAIL });
    await wait(180);
    const joined = h.stdout.writes.join("");
    expect(joined.split(CLEAR).length - 1).toBe(0);
    expect(joined.split("HIST-00").length - 1).toBe(0);
    h.unmount();
  });

  test("RED-4: streaming a long delta must NOT clear/replay the stable history", async () => {
    const h = await mountREPLInk([...STABLE, { role: "assistant", content: "short-tail" }]);
    h.stdout.reset();
    for (let i = 0; i < 36; i += 1) {
      h.api.appendAssistantDelta(`STREAM-${String(i).padStart(2, "0")}\n`);
      await wait(58);
    }
    h.api.finishAssistantStream();
    await wait(160);
    const joined = h.stdout.writes.join("");
    // streaming tail must be bounded: each new frame may redraw the
    // bounded tail, but it must never repaint the entire stable
    // history and must never trigger the clearTerminal overflow path.
    const clearCount = joined.split(CLEAR).length - 1;
    const stableReplay = joined.split("HIST-00").length - 1;
    expect(clearCount).toBe(0);
    expect(stableReplay).toBe(0);
    h.unmount();
  });

  test("RED-5: input after finished long stream must NOT replay stable history", async () => {
    const h = await mountREPLInk(STABLE);
    for (let i = 0; i < 36; i += 1) {
      h.api.appendAssistantDelta(`STREAM-${String(i).padStart(2, "0")}\n`);
      await wait(58);
    }
    h.api.finishAssistantStream();
    await wait(160);
    h.stdout.reset();
    h.stdin.send("a");
    await wait(120);
    const joined = h.stdout.writes.join("");
    expect(joined.split(CLEAR).length - 1).toBe(0);
    expect(joined.split("HIST-00").length - 1).toBe(0);
    h.unmount();
  });
});
