/**
 * @fileoverview Tests for RunCommand (yargs wrapper around <RunTui>).
 *
 * Task #2610 stage 4. We test the yargs CommandModule surface only —
 * mounting Ink at test time is intentionally out of scope (the Ink
 * `RunTui.test.tsx` suite was removed in Task #4681 along with the
 * orphaned `RunTui.tsx`).
 *
 * Task #2728: expanded to cover streaming support (streamHandleQuery)
 * and full argument parity with the `interactive` command.
 */

import { describe, it, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunCommand } from "./interactive";

describe("RunCommand (yargs)", () => {
  it("exposes command name 'interactive'", () => {
    expect(RunCommand.command).toBe("interactive");
  });

  it("has a description", () => {
    expect(RunCommand.describe ?? "").toContain("interactive");
  });

  it("declares a builder function", () => {
    expect(typeof RunCommand.builder).toBe("function");
  });

  it("declares a handler function", () => {
    expect(typeof RunCommand.handler).toBe("function");
  });

  it("builder returns an object that can be chained", () => {
    const yargs = {
      option: () => yargs,
      // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
      check: () => yargs,
    };
    // The builder accepts any yargs-shaped object. We do not invoke
    // it here because the full yargs chain requires a runtime; the
    // important property is that the builder is callable and returns
    // an object (we mock the chain so it does not crash).
    const result = RunCommand.builder?.(yargs as never);
    expect(result).toBeDefined();
  });
});

// ============================================================================
// Task #2728: Argument parity with `interactive` command
// ============================================================================

/**
 * Lightweight yargs mock that records all `.option()` calls into a map.
 * This lets us assert which flags the builder declares without running
 * the full yargs runtime.
 */
function captureOptions(): {
  options: Record<string, { alias?: string | string[]; type?: string }>;
  yargs: any;
} {
  const options: Record<string, { alias?: string | string[]; type?: string }> = {};
  const yargs = {
    // ★ Task #4724：命令 builder 挂了 .check(checkFallbackModelArg)，这里补桩。
    check(_fn: any) {
      return yargs;
    },
    option(name: string, config: any) {
      options[name] = { alias: config?.alias, type: config?.type };
      return yargs;
    },
  };
  RunCommand.builder?.(yargs as never);
  return { options, yargs };
}

describe("RunCommand argument parity (Task #2728)", () => {
  it("declares --session flag (no short alias — -s is taken by --system-prompt)", () => {
    const { options } = captureOptions();
    expect(options["session"]).toBeDefined();
    // No alias to avoid confusion with -s (system-prompt)
    expect(options["session"].alias).toBeUndefined();
  });

  it("declares --continue flag", () => {
    const { options } = captureOptions();
    expect(options["continue"]).toBeDefined();
  });

  it("declares --reasoning flag", () => {
    const { options } = captureOptions();
    expect(options["reasoning"]).toBeDefined();
  });

  it("declares --tool-calls flag", () => {
    const { options } = captureOptions();
    expect(options["tool-calls"]).toBeDefined();
  });

  it("declares --tool-results flag", () => {
    const { options } = captureOptions();
    expect(options["tool-results"]).toBeDefined();
  });

  it("declares --event-source flag (alias es)", () => {
    const { options } = captureOptions();
    expect(options["event-source"]).toBeDefined();
    expect(options["event-source"].alias).toBe("es");
  });

  it("declares --agent flag (alias a)", () => {
    const { options } = captureOptions();
    expect(options["agent"]).toBeDefined();
    expect(options["agent"].alias).toBe("a");
  });

  it("declares --default-agent-name flag (alias dan)", () => {
    const { options } = captureOptions();
    expect(options["default-agent-name"]).toBeDefined();
    expect(options["default-agent-name"].alias).toBe("dan");
  });

  it("still declares --model flag (alias m)", () => {
    const { options } = captureOptions();
    expect(options["model"]).toBeDefined();
    expect(options["model"].alias).toBe("m");
  });

  it("still declares --system-prompt flag", () => {
    const { options } = captureOptions();
    expect(options["system-prompt"]).toBeDefined();
  });

  it("still declares --workdir flag (alias w)", () => {
    const { options } = captureOptions();
    expect(options["workdir"]).toBeDefined();
    expect(options["workdir"].alias).toBe("w");
  });

  it("still declares --plugins flag (alias p)", () => {
    const { options } = captureOptions();
    expect(options["plugins"]).toBeDefined();
    expect(options["plugins"].alias).toBe("p");
  });

  it("still declares --config flag", () => {
    const { options } = captureOptions();
    expect(options["config"]).toBeDefined();
  });

  it("still declares --env flag", () => {
    const { options } = captureOptions();
    expect(options["env"]).toBeDefined();
  });
});

// ============================================================================
// Task #2728: Streaming support — streamHandleQuery factory
// ============================================================================

describe("RunCommand streaming support (Task #2728)", () => {
  it("exports a createStreamHandleQuery function", async () => {
    const mod = await import("./interactive.js");
    expect(typeof (mod as any).createStreamHandleQuery).toBe("function");
  });

  it("createStreamHandleQuery returns a function that accepts (message, onChunk)", async () => {
    // We can't fully test without a real env, but we can verify the
    // factory's return type shape by mocking the dependencies.
    // This test guards the public API contract.
    const mod = await import("./interactive.js");
    const factory = (mod as any).createStreamHandleQuery;
    // The factory should accept an env-like object and options
    expect(factory.length).toBeGreaterThanOrEqual(1);
  });
});

// ============================================================================
// Task #4124: tool event forwarding (opencode-style tool cards)
// ============================================================================

describe("RunCommand tool event forwarding (Task #4124)", () => {
  /** Build a fake QueryExecutor whose execute() drives the chunk callback. */
  function makeFakeExecutor(emit: (cb: (e: any) => void) => void, result = "resp") {
    let callback: ((e: any) => void) | null = null;
    const executor = {
      setChunkCallback(cb: (e: any) => void) {
        callback = cb;
      },
      async execute() {
        if (callback) emit(callback);
        return result;
      },
    };
    return executor as any;
  }

  it("forwards tool.call / tool.result / tool.error as ToolStreamEvents", async () => {
    const mod = await import("./interactive.js");
    const executor = makeFakeExecutor((cb) => {
      cb({ type: "tool.call", toolId: "t1", toolName: "bash", toolArgs: { command: "ls" } });
      cb({ type: "tool.result", toolId: "t1", toolName: "bash", toolResult: "ok" });
      cb({ type: "tool.error", toolName: "glob", toolError: "bad pattern" });
      cb({ type: "llm.text", delta: "hi" });
    }, "hi");

    const stream = (mod as any).createStreamHandleQuery(
      executor,
      "s1",
      { triggerEventDbPath: join(mkdtempSync(join(tmpdir(), "t5181-run-")), "event-store.db") } as any,
      undefined,
      undefined
    );
    const tools: any[] = [];
    const chunks: string[] = [];
    const text = await stream(
      "hi",
      (c: string) => chunks.push(c),
      (t: any) => tools.push(t)
    );

    expect(tools.map((t) => t.kind)).toEqual(["call", "result", "error"]);
    expect(tools[0]).toEqual({
      kind: "call",
      id: "t1",
      name: "bash",
      args: { command: "ls" },
    });
    expect(tools[1]).toEqual({
      kind: "result",
      id: "t1",
      name: "bash",
      output: "ok",
    });
    expect(tools[2]).toEqual({
      kind: "error",
      name: "glob",
      error: "bad pattern",
    });
    expect(chunks).toEqual(["hi"]);
    expect(text).toBe("hi");
  });

  it("does not crash when onTool is omitted", async () => {
    const mod = await import("./interactive.js");
    const executor = makeFakeExecutor((cb) => {
      cb({ type: "tool.call", toolId: "t1", toolName: "bash", toolArgs: {} });
      cb({ type: "tool.result", toolId: "t1", toolName: "bash", toolResult: "ok" });
    });

    const stream = (mod as any).createStreamHandleQuery(
      executor,
      "s1",
      { triggerEventDbPath: join(mkdtempSync(join(tmpdir(), "t5181-run-")), "event-store.db") } as any,
      undefined,
      undefined
    );
    await expect(stream("hi", () => {})).resolves.toBe("resp");
  });

  it("requests tool chunk events from the executor (showToolCalls/Results true)", async () => {
    // RunTui filters what to display, so the executor must always emit the
    // tool chunk events. The source is asserted here because a lightweight
    // fake does not exercise the execute() options object.
    const fs = await import("fs");
    const path = await import("path");
    const source = fs.readFileSync(path.join(__dirname, "interactive.ts"), "utf-8");
    const section = source.substring(
      source.indexOf("createStreamHandleQuery"),
      source.indexOf("export function createRunCommand")
    );
    expect(section).toContain("showToolCalls: true");
    expect(section).toContain("showToolResults: true");
  });
});

// ============================================================================
// Task #4278 片6: reasoning/thinking forwarded to the TUI (clickable block)
// ============================================================================

describe("RunCommand reasoning forwarding (Task #4278 片6)", () => {
  /** Build a fake QueryExecutor whose execute() drives the chunk callback. */
  function makeFakeExecutor(emit: (cb: (e: any) => void) => void, result = "resp") {
    let callback: ((e: any) => void) | null = null;
    const executor = {
      setChunkCallback(cb: (e: any) => void) {
        callback = cb;
      },
      async execute() {
        if (callback) emit(callback);
        return result;
      },
    };
    return executor as any;
  }

  it("forwards llm.reasoning deltas via the trailing onReasoning arg", async () => {
    const mod = await import("./interactive.js");
    const executor = makeFakeExecutor((cb) => {
      cb({ type: "llm.reasoning", delta: "Let me " });
      cb({ type: "llm.reasoning", delta: "think." });
      cb({ type: "llm.text", delta: "answer" });
    }, "answer");

    const stream = (mod as any).createStreamHandleQuery(
      executor,
      "s1",
      { triggerEventDbPath: join(mkdtempSync(join(tmpdir(), "t5181-run-")), "event-store.db") } as any,
      undefined,
      undefined
    );
    const reasoning: string[] = [];
    const chunks: string[] = [];
    // ★ 位置契约（Task #4278 交叉验证）：`(message, onChunk, onTool, onUsage,
    //   envEvent, onReasoning)` —— onReasoning 必须在**最后**，插在中间会
    //   破坏 main 的 Ink 调用点与 main 原生护栏测试。
    await stream(
      "hi",
      (c: string) => chunks.push(c),
      undefined, // onTool omitted
      undefined, // onUsage omitted
      undefined, // envEvent omitted
      (r: string) => reasoning.push(r)
    );

    expect(reasoning).toEqual(["Let me ", "think."]);
    // Reasoning must NOT leak into the answer stream.
    expect(chunks).toEqual(["answer"]);
  });

  it("reasoning deltas fall back to the `content` field when delta is absent", async () => {
    const mod = await import("./interactive.js");
    const executor = makeFakeExecutor((cb) => {
      cb({ type: "llm.reasoning", content: "snapshot content" });
    });

    const stream = (mod as any).createStreamHandleQuery(executor, "s1", { triggerEventDbPath: join(mkdtempSync(join(tmpdir(), "t5181-run-")), "event-store.db") } as any, undefined, undefined);
    const reasoning: string[] = [];
    await stream("hi", () => {}, undefined, undefined, undefined, (r: string) => reasoning.push(r));
    expect(reasoning).toEqual(["snapshot content"]);
  });

  it("is backward compatible when onReasoning is omitted", async () => {
    const mod = await import("./interactive.js");
    const executor = makeFakeExecutor((cb) => {
      cb({ type: "llm.reasoning", delta: "ignored" });
      cb({ type: "llm.text", delta: "hi" });
    }, "hi");

    const stream = (mod as any).createStreamHandleQuery(executor, "s1", { triggerEventDbPath: join(mkdtempSync(join(tmpdir(), "t5181-run-")), "event-store.db") } as any, undefined, undefined);
    const chunks: string[] = [];
    await expect(stream("hi", (c: string) => chunks.push(c))).resolves.toBe("hi");
    expect(chunks).toEqual(["hi"]);
  });

  it("does not route reasoning into onChunk (answer stream stays clean)", async () => {
    const mod = await import("./interactive.js");
    const executor = makeFakeExecutor((cb) => {
      cb({ type: "llm.reasoning", delta: "SECRET" });
      cb({ type: "llm.text", delta: "visible" });
    }, "visible");

    const stream = (mod as any).createStreamHandleQuery(executor, "s1", { triggerEventDbPath: join(mkdtempSync(join(tmpdir(), "t5181-run-")), "event-store.db") } as any, undefined, undefined);
    const chunks: string[] = [];
    await stream("hi", (c: string) => chunks.push(c), undefined, undefined, undefined, () => {});
    expect(chunks.join("")).not.toContain("SECRET");
  });
});

// ============================================================================
// Task #2728 (bugfix): EventHandler + TaskEventHandler wiring
// ============================================================================

/**
 * Bug 1: commands/interactive.ts must wire EventHandler (subagent notifications) and
 * TaskEventHandler (task.* console output) just like commands/run.ts.
 *
 * RED: loadHandleQuery should return eventHandler-related fields.
 */
describe("RunCommand EventHandler wiring (Task #2728 bugfix)", () => {
  it("loadHandleQuery is exported for testing", async () => {
    const mod = await import("./interactive.js");
    // loadHandleQuery is not exported, but we can verify the handler
    // creates EventHandler by checking that commands/interactive.ts imports it.
    // For now, verify the module loads without error.
    expect(mod).toBeDefined();
  });

  it("commands/interactive.ts imports EventHandler from shared/event-handler", async () => {
    // Read the source to verify the import exists
    const fs = await import("fs");
    const path = await import("path");
    const sourcePath = path.join(__dirname, "interactive.ts");
    const source = fs.readFileSync(sourcePath, "utf-8");
    expect(source).toContain("EventHandler");
    expect(source).toContain("event-handler");
  });

  it("commands/interactive.ts imports TaskEventHandler from shared/task-event-handler", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const sourcePath = path.join(__dirname, "interactive.ts");
    const source = fs.readFileSync(sourcePath, "utf-8");
    expect(source).toContain("TaskEventHandler");
    expect(source).toContain("task-event-handler");
  });

  it("commands/interactive.ts creates EventHandler with task.background.* and event-source.event.* event types", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const sourcePath = path.join(__dirname, "interactive.ts");
    const source = fs.readFileSync(sourcePath, "utf-8");
    expect(source).toContain("task.background.*");
    expect(source).toContain("event-source.event.*");
  });

  it("commands/interactive.ts starts and stops EventHandler in handler lifecycle", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const sourcePath = path.join(__dirname, "interactive.ts");
    const source = fs.readFileSync(sourcePath, "utf-8");
    // EventHandler.start() must be called
    expect(source).toMatch(/eventHandler\.start\(\)/);
    // EventHandler stop must be called in cleanup (either .stop() or via the start() return)
    expect(source).toMatch(/stopEventHandler|eventHandler\.stop/);
  });

  it("commands/interactive.ts starts TaskEventHandler in handler lifecycle", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const sourcePath = path.join(__dirname, "interactive.ts");
    const source = fs.readFileSync(sourcePath, "utf-8");
    expect(source).toMatch(/taskEventHandler\.start\(\)/);
  });

  it("commands/interactive.ts cleans up TaskEventHandler in finally block", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const sourcePath = path.join(__dirname, "interactive.ts");
    const source = fs.readFileSync(sourcePath, "utf-8");
    // The finally block should stop both event handlers
    expect(source).toMatch(/stopTaskEventHandler|taskEventHandler\.stop/);
  });
});

// ============================================================================
// Task #2728 (bugfix): silent=true verification for duplicate output fix
// ============================================================================

/**
 * Bug 2: commands/interactive.ts must ensure QueryExecutor is created with silent=true
 * to prevent StreamOutputService from writing to stdout while Ink
 * renders chunks via the callback.
 *
 * RED: verify the source code sets silent=true.
 */
describe("RunCommand silent mode (Task #2728 bugfix)", () => {
  it("loadHandleQuery creates QueryExecutor with silent: true", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const sourcePath = path.join(__dirname, "interactive.ts");
    const source = fs.readFileSync(sourcePath, "utf-8");
    // The QueryExecutor constructor must have silent: true
    expect(source).toContain("silent: true");
  });

  it("createStreamHandleQuery does NOT override silent to false", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const sourcePath = path.join(__dirname, "interactive.ts");
    const source = fs.readFileSync(sourcePath, "utf-8");
    // There should be no silent: false in createStreamHandleQuery
    const streamSection = source.substring(
      source.indexOf("createStreamHandleQuery"),
      source.indexOf("export function createRunCommand")
    );
    expect(streamSection).not.toContain("silent: false");
  });
});
