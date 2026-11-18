/**
 * Task #5035 — RED test: the goal-check (`LayaCompletionPlugin`) must be a
 * **first-class public API** for external hosts.
 *
 * ## Why
 *
 * The MCP task server (`@ai-setting/roy-bot-core/env/task/mcp`) binds tools
 * to a `TaskBackend` (`TaskStoreBackend`), **not** a `TaskComponent`. That
 * backend has no hook chain, so `task:after.complete` never fires and the
 * completion judgement (`LayaCompletionPlugin`) — which roy-bot registers
 * inside its own process via `registerLayaCompletionTaskHook` — never runs.
 *
 * Result (measured): when an MCP-driven agent calls its own `task_complete`
 * tool, **nothing verifies the goal vs. the deliverables**. The plugin had to
 * reach for a file path (`env/task/plugins/laya-completion-plugin`) that the
 * package `exports` map does not publish, so it could never resolve.
 *
 * ## What this test pins
 *
 * The plugins barrel must re-export the completion-judgement surface so a
 * host can:
 *
 *   1. construct the plugin / hook (`createLayaCompletionPlugin`,
 *      `registerLayaCompletionTaskHook`, `LayaCompletionPlugin`);
 *   2. inject its own `DecisionPort` (test seam + auth reuse);
 *   3. render the hint anchor (`TASK_COMPLETION_HINT_ANCHOR`,
 *      `buildCompletionHint`) so the FAIL branch can be surfaced to the agent.
 *
 * ⚠️ Adding exports must be **zero behaviour change** — this test only
 * asserts reachability, never semantics.
 */

import { describe, expect, test } from "bun:test";

// Direct module import (the barrel) — this is the surface external hosts use.
import * as pluginsBarrel from "./index";

/** The symbols an external host needs to run the goal check. */
const REQUIRED_RUNTIME_EXPORTS = [
  "LayaCompletionPlugin",
  "createLayaCompletionPlugin",
  "registerLayaCompletionTaskHook",
  "buildCompletionHint",
  "LAYA_COMPLETION_THRESHOLD",
  "TASK_COMPLETION_HINT_ANCHOR",
] as const;

/** Types are erased at runtime, so they are checked via `.d.ts` compile only. */
const REQUIRED_TYPE_EXPORTS = [
  "LayaCompletionPluginOptions",
] as const;

describe("Task #5035 — plugins barrel exposes the goal-check surface", () => {
  for (const name of REQUIRED_RUNTIME_EXPORTS) {
    test(`barrel exports runtime symbol: ${name}`, () => {
      const value = (pluginsBarrel as unknown as Record<string, unknown>)[name];
      expect(value).toBeDefined();
    });
  }

  test("LayaCompletionPlugin is constructible from the barrel export", () => {
    const { LayaCompletionPlugin } = pluginsBarrel;
    const plugin = new LayaCompletionPlugin({ decisionPort: undefined });
    expect(plugin.name).toBe("laya-completion");
  });

  test("registerLayaCompletionTaskHook fails open without a component", () => {
    const { registerLayaCompletionTaskHook } = pluginsBarrel;
    // No TaskComponent in an MCP host → must return false, never throw.
    expect(registerLayaCompletionTaskHook(undefined)).toBe(false);
  });

  test("createLayaCompletionPlugin returns the hook shape (name + priority + execute)", async () => {
    const { createLayaCompletionPlugin } = pluginsBarrel;
    const hook = createLayaCompletionPlugin({
      // No port → the plugin fail-opens; the hook shape is what matters here.
      decisionPort: undefined,
    });
    expect(hook.name).toBe("laya-completion");
    expect(hook.priority).toBe(20);
    expect(typeof hook.execute).toBe("function");
    // Executing without an injected TaskComponent must not throw.
    await expect(hook.execute({ data: {} })).resolves.toBeUndefined();
  });

  test("TASK_COMPLETION_HINT_ANCHOR is the raw token used by complete-tool copy", () => {
    const { TASK_COMPLETION_HINT_ANCHOR } = pluginsBarrel;
    expect(TASK_COMPLETION_HINT_ANCHOR).toBe("TASK_COMPLETION_HINT");
  });

  test("buildCompletionHint renders a bracketed anchor the agent can see", () => {
    const { buildCompletionHint, TASK_COMPLETION_HINT_ANCHOR } = pluginsBarrel;
    const hint = buildCompletionHint(
      {
        id: 42,
        title: "t",
        type: "normal",
        status: "completed",
      } as never,
      0.97,
    );
    expect(hint).toContain(`[${TASK_COMPLETION_HINT_ANCHOR}]`);
    expect(hint).toContain("#42");
  });

  test("type exports are declared (compile-time contract)", () => {
    // A type-only import that fails to resolve breaks the build, so this
    // statement is the assertion. Runtime is a no-op by design.
    type Opts = pluginsBarrel.LayaCompletionPluginOptions;
    const _opts: Opts = {};
    expect(_opts).toBeDefined();
    expect(REQUIRED_TYPE_EXPORTS.length).toBe(1);
  });
});
