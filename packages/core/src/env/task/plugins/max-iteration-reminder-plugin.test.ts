/**
 * @fileoverview MaxIterationReminderPlugin RED tests — round 2 (same meta-protocol as AutoTaskPlugin)
 *
 * Task #2580 (continuation round 2) — the plugin MUST use the EXACT same
 * meta-protocol as `AutoTaskPlugin`: subscribe `agent:after.tool`, write
 * `ctx.toolResult.result.metadata.toAddFakeUserMessage` via shared helper.
 * AgentComponent's existing `consumeMetaProtocolUserMessage` +
 * `flushPendingFakeUserMessage` consumes the field at the right boundary.
 *
 * ## Off-by-one (round 2)
 * - Trigger: `iteration === maxIterations - 1` (NOT === maxIterations)
 * - Reason: reminder must reach the LAST allowed LLM call (iter === maxIter)
 *   - The plugin fires on after.tool at iter === maxIter - 1
 *   - AgentComponent's react loop captures the metadata, holds it in
 *     `pendingFakeUserMessage`, and flushes AFTER all tool_results of that
 *     iteration
 *   - Next iteration (iter === maxIter, the last allowed LLM call) sees the
 *     reminder in messages via buildMessages
 *
 * ## No side-channels
 * - Plugin MUST NOT mutate `ctx.messages` directly
 * - Plugin MUST NOT touch `ctx.pendingFakeUserMessage` (round 1 field,
 *   REMOVED in round 2)
 * - Plugin MUST NOT add any new field to HookContext / AgentContext
 * - Plugin MUST NOT introduce a second metadata field
 * - Plugin DOES write to `ctx.toolResult.result.metadata.toAddFakeUserMessage`
 *   (the EXISTING field, same as AutoTaskPlugin)
 *
 * ## maxIterations <= 1 defensive skip
 * - For `maxIterations <= 1` (compact/compact-hint one-shot agents), the
 *   plugin MUST skip silently. There is no "prior tool call → last LLM
 *   boundary" to anchor on, and the plugin MUST NOT fabricate a toolResult.
 *
 * ## Conflict with AutoTaskPlugin
 * - When `threshold === maxIter - 1`, both plugins fire in the same
 *   `agent:after.tool` invocation on the same `ctx.toolResult.result.metadata`
 * - The shared helper `enqueueToAddFakeUserMessage` merges them
 *   deterministically (delegate first, max-iter last)
 * - Both reminders are preserved (no silent overwrite)
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  createMaxIterationReminderPlugin,
  MaxIterationReminderPlugin,
} from "./max-iteration-reminder-plugin";
import { createAutoTaskPlugin } from "./auto-task-plugin";
import { enqueueToAddFakeUserMessage } from "./fake-user-message-helper";
import type { HookContext, AgentContext, Plugin } from "../../agent/types";
import type { ModelMessage } from "ai";

// ============================================================================
// Test helpers
// ============================================================================

/**
 * Build a HookContext that mimics what agent-component.ts feeds to an
 * `agent:after.tool` plugin handler. The plugin needs `toolResult` to
 * write the meta-protocol; we provide a fresh one by default.
 */
function makeAfterToolHookCtx(opts: {
  iteration: number;
  maxIterations: number;
  agentName?: string;
  messages?: any[];
  traceId?: string;
  toolResult?: any;
}): HookContext {
  const messages = opts.messages ?? [
    { role: "user" as const, content: "initial user query" },
  ];
  const toolResult = opts.toolResult ?? {
    id: "tc1",
    name: "bash",
    success: true,
    result: { success: true, output: "tool result", metadata: {} },
  };
  return {
    agent: { name: opts.agentName ?? "default" } as any,
    iteration: opts.iteration,
    maxIterations: opts.maxIterations,
    messages,
    tools: [],
    systemPrompt: "You are a helpful assistant.",
    context: { traceId: opts.traceId ?? `q-${Math.random()}` } as unknown as AgentContext,
    toolResult,
  } as unknown as HookContext;
}

/**
 * Extract the toAddFakeUserMessage set by the plugin (or undefined).
 */
function peekMeta(ctx: HookContext): ModelMessage | undefined {
  return (ctx.toolResult as any)?.result?.metadata?.toAddFakeUserMessage;
}

// ============================================================================
// Tests
// ============================================================================

describe("MaxIterationReminderPlugin — same meta-protocol as AutoTaskPlugin (RED round 2)", () => {
  let plugin: Plugin;

  beforeEach(() => {
    plugin = createMaxIterationReminderPlugin();
  });

  // --------------------------------------------------------------------------
  // RED-A / off-by-one lower bound: iteration < maxIter-1 → no signal
  // --------------------------------------------------------------------------
  it("RED-A: iteration < maxIterations - 1 → does NOT signal (saves useful iterations)", async () => {
    const ctx = makeAfterToolHookCtx({
      iteration: 5,
      maxIterations: 10,
      agentName: "default",
    });

    await plugin.execute(ctx);

    expect(peekMeta(ctx)).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // RED-B / off-by-one exact: iteration === maxIterations - 1 → signal
  //   (so that iter === maxIterations's LLM call sees the reminder)
  // --------------------------------------------------------------------------
  it("RED-B: iteration === maxIterations - 1 → signals via toolResult.result.metadata.toAddFakeUserMessage", async () => {
    const ctx = makeAfterToolHookCtx({
      iteration: 9, // maxIter=10, so iter=9 === maxIter-1
      maxIterations: 10,
      agentName: "roy",
    });

    await plugin.execute(ctx);

    const meta = peekMeta(ctx);
    expect(meta).toBeDefined();
    expect(meta!.role).toBe("user");
    const content = meta!.content as string;
    // Reminder content includes maxIterations number, "不要再调用任何工具", "总结"
    expect(content).toContain("10");
    expect(content).toContain("不要再调用任何工具");
    expect(content).toContain("总结");
  });

  // --------------------------------------------------------------------------
  // RED-C / off-by-one upper bound: iteration === maxIterations → no signal
  //   (it would be too late; the LAST LLM call already passed)
  // --------------------------------------------------------------------------
  it("RED-C: iteration === maxIterations → does NOT signal (too late; last LLM call already passed)", async () => {
    const ctx = makeAfterToolHookCtx({
      iteration: 10, // === maxIter; plugin MUST NOT fire
      maxIterations: 10,
      agentName: "workflow-runner",
    });

    await plugin.execute(ctx);

    expect(peekMeta(ctx)).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // RED-D / maxIterations <= 1 defensive skip
  //   (compact/compact-hint one-shot agents: no prior tool call boundary)
  // --------------------------------------------------------------------------
  it("RED-D: maxIterations === 1 (compact/compact-hint) → defensive skip (no fake toolResult)", async () => {
    const ctx = makeAfterToolHookCtx({
      iteration: 0, // would be maxIter-1=0 if not skipped
      maxIterations: 1,
      agentName: "compact",
    });

    await plugin.execute(ctx);

    // MUST NOT write to metadata (no fake toolResult)
    expect(peekMeta(ctx)).toBeUndefined();
  });

  it("RED-D2: maxIterations === 0 (degenerate) → defensive skip", async () => {
    const ctx = makeAfterToolHookCtx({
      iteration: -1,
      maxIterations: 0,
      agentName: "compact",
    });

    await plugin.execute(ctx);

    expect(peekMeta(ctx)).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // RED-E / no toolResult: defensive skip (no fabrication)
  // --------------------------------------------------------------------------
  it("RED-E: toolResult missing → defensive skip (no fabrication)", async () => {
    // Build context WITHOUT the default toolResult (force undefined)
    const ctx: HookContext = {
      agent: { name: "default" } as any,
      iteration: 9,
      maxIterations: 10,
      messages: [{ role: "user", content: "q" }],
      tools: [],
      systemPrompt: "x",
      context: { traceId: "trace-no-toolresult-1" } as unknown as AgentContext,
      toolResult: undefined, // explicit
    } as unknown as HookContext;

    await plugin.execute(ctx);

    expect((ctx as any).toolResult).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // RED-F / idempotency: per-traceId dedup
  // --------------------------------------------------------------------------
  it("RED-F: per-traceId idempotency — multiple invocations at iter=maxIter-1 produce only ONE signal per traceId", async () => {
    const ctx = makeAfterToolHookCtx({
      iteration: 9,
      maxIterations: 10,
      agentName: "json-extract",
      traceId: "trace-stable-1",
    });

    await plugin.execute(ctx);
    expect(peekMeta(ctx)).toBeDefined();

    // Simulate AgentComponent flushing (consumeMetaProtocolUserMessage deletes field)
    delete (ctx.toolResult as any).result.metadata.toAddFakeUserMessage;

    await plugin.execute(ctx);
    expect(peekMeta(ctx)).toBeUndefined(); // dedup: traceId already processed
  });

  // --------------------------------------------------------------------------
  // RED-G / all-agents scope: no agentName filter
  // --------------------------------------------------------------------------
  it("RED-G: applies to ANY agent name (no agentName filter)", async () => {
    const agentNames = ["default", "roy", "explore", "general-purpose", "workflow-runner", "custom-user-agent"];
    for (const name of agentNames) {
      const ctx = makeAfterToolHookCtx({
        iteration: 2, // === maxIter-1
        maxIterations: 3,
        agentName: name,
        traceId: `trace-${name}-${Math.random()}`,
      });
      await plugin.execute(ctx);
      const meta = peekMeta(ctx);
      if (!meta) {
        throw new Error(`expected meta-protocol signal for agent "${name}"`);
      }
    }
  });

  // --------------------------------------------------------------------------
  // RED-H / custom messageTemplate
  // --------------------------------------------------------------------------
  it("RED-H: supports custom messageTemplate (maxIterations placeholder substituted)", async () => {
    const custom = createMaxIterationReminderPlugin({
      messageTemplate: "Custom reminder: {maxIterations} iters reached. STOP & SUMMARIZE.",
    });
    const ctx = makeAfterToolHookCtx({
      iteration: 6, // === maxIter-1=6
      maxIterations: 7,
      agentName: "default",
      traceId: "trace-custom-1",
    });

    await custom.execute(ctx);

    const meta = peekMeta(ctx);
    expect(meta).toBeDefined();
    expect(meta!.content).toBe("Custom reminder: 7 iters reached. STOP & SUMMARIZE.");
  });

  // --------------------------------------------------------------------------
  // RED-I / no side-channel: plugin does NOT mutate ctx.messages or
  //   ctx.pendingFakeUserMessage (round 1 field, REMOVED in round 2)
  // --------------------------------------------------------------------------
  it("RED-I: does NOT mutate ctx.messages or ctx.pendingFakeUserMessage (no side-channel)", async () => {
    const ctx = makeAfterToolHookCtx({
      iteration: 9,
      maxIterations: 10,
      agentName: "default",
      traceId: "trace-no-side-1",
    });
    const initialSnapshot = JSON.stringify(ctx.messages);
    // round 1 field — even if it accidentally exists, MUST NOT be set
    (ctx as any).pendingFakeUserMessage = undefined;
    const initialPending = (ctx as any).pendingFakeUserMessage;

    await plugin.execute(ctx);

    // ctx.messages MUST NOT be mutated by the plugin
    expect(JSON.stringify(ctx.messages)).toBe(initialSnapshot);
    // ctx.pendingFakeUserMessage (if it exists) MUST NOT be set
    expect((ctx as any).pendingFakeUserMessage).toBe(initialPending);
  });

  // --------------------------------------------------------------------------
  // RED-J / uses EXACT same meta-protocol field as AutoTaskPlugin
  // --------------------------------------------------------------------------
  it("RED-J: writes to the EXACT same toolResult.result.metadata.toAddFakeUserMessage field as AutoTaskPlugin", async () => {
    const ctx = makeAfterToolHookCtx({
      iteration: 9,
      maxIterations: 10,
      agentName: "default",
      traceId: "trace-same-field-1",
    });

    await plugin.execute(ctx);

    const meta = peekMeta(ctx);
    expect(meta).toBeDefined();
    expect(meta!.role).toBe("user");
    // The field is the SAME as AutoTaskPlugin (not a new side-channel)
    const innerResult = (ctx.toolResult as any).result;
    expect(innerResult.metadata.toAddFakeUserMessage).toBeDefined();
  });

  // --------------------------------------------------------------------------
  // RED-K / uses the shared helper (not its own copy of the protocol)
  //   When AutoTaskPlugin also fires in the same iter, both messages
  //   are merged into ONE (no silent overwrite).
  // --------------------------------------------------------------------------
  it("RED-K: uses shared helper — merge with AutoTaskPlugin on same iter (delegate + max-iter in one message)", async () => {
    // Configure with threshold=9 === maxIter-1=9 so both fire
    const autoTask = createAutoTaskPlugin({ threshold: 9, agentName: "default" });
    const maxIter = createMaxIterationReminderPlugin();

    const ctx = makeAfterToolHookCtx({
      iteration: 9, // both fire here
      maxIterations: 10, // so iter=9 === maxIter-1
      agentName: "default",
      traceId: "trace-merge-1",
    });

    // AutoTaskPlugin fires first (priority 50; same as MaxIterReminder,
    // but execution order within same priority is registration order)
    await autoTask.execute(ctx);
    // Then MaxIterReminderPlugin
    await maxIter.execute(ctx);

    const meta = peekMeta(ctx);
    expect(meta).toBeDefined();
    const content = meta!.content as string;
    // Both reminders are preserved
    expect(content).toContain("delegate_task");
    expect(content).toContain("roy");
    // max-iter "不要再调用任何工具" is at the END (final instruction)
    const maxIterIdx = content.indexOf("不要再调用任何工具");
    const delegateIdx = content.indexOf("delegate_task");
    expect(maxIterIdx).toBeGreaterThan(delegateIdx);
  });

  // --------------------------------------------------------------------------
  // RED-L / plugin metadata: hook, name, version
  // --------------------------------------------------------------------------
  it("RED-L: plugin declares agent:after.tool hook (NOT before.llm); name + version", () => {
    expect(plugin.name).toBe("MaxIterationReminderPlugin");
    expect(plugin.version).toMatch(/^3\./);
    // Hook declared: agent:after.tool (NOT before.llm, NOT any other)
    expect(plugin.hooks?.some((h: any) => h.point === "agent:after.tool")).toBe(true);
    expect(plugin.hooks?.some((h: any) => h.point === "agent:before.llm")).toBe(false);
  });

  // --------------------------------------------------------------------------
  // RED-M / class export
  // --------------------------------------------------------------------------
  it("RED-M: MaxIterationReminderPlugin class is exported and instantiable", () => {
    const inst = new MaxIterationReminderPlugin();
    expect(inst.name).toBe("MaxIterationReminderPlugin");
    expect(typeof inst.execute).toBe("function");
  });

  // --------------------------------------------------------------------------
  // RED-N / shared helper is reusable (not just internal to the plugin)
  // --------------------------------------------------------------------------
  it("RED-N: shared helper `enqueueToAddFakeUserMessage` is exported and works with both kinds", () => {
    const toolResult: any = { id: "tc1", result: { metadata: {} } };

    // First write: delegate
    enqueueToAddFakeUserMessage(
      toolResult,
      { role: "user", content: "DELEGATE_HINT" } as ModelMessage,
      "delegate",
    );
    expect(toolResult.result.metadata.toAddFakeUserMessage.content).toBe("DELEGATE_HINT");

    // Second write: max-iter — should be merged at the END
    enqueueToAddFakeUserMessage(
      toolResult,
      { role: "user", content: "MAX_ITER_HINT" } as ModelMessage,
      "max-iter",
    );
    expect(toolResult.result.metadata.toAddFakeUserMessage.content).toBe(
      "DELEGATE_HINT\n\nMAX_ITER_HINT",
    );

    // Order check: max-iter at the end (final instruction)
    const content = toolResult.result.metadata.toAddFakeUserMessage.content;
    expect(content.indexOf("MAX_ITER_HINT")).toBeGreaterThan(content.indexOf("DELEGATE_HINT"));
  });
});
