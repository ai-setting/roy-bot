/**
 * @fileoverview Task #2190 — PRE-execution attach + replaceWorkflowRun TDD tests
 *
 * Validates the fix for stop_task not propagating to sub-session-launched
 * workflow_run. Root cause: wrappedExecute (run-workflow.ts:526-555) attaches
 * POST-execute (after `await runner.execute()` returns), leaving the registry
 * empty during the entire workflow lifetime. stop_task fires propagateStop and
 * hits the `set.size === 0` early-return, leaving orphan workflows.
 *
 * Fix:
 *   - AC-1: `attachWorkflowRun(bgTaskId, reservedRunId)` MUST be called BEFORE
 *           `runner.execute(args, ctx)` (pre-execution attach).
 *   - AC-2: When the engine fires `onSessionCreated(realRunId)`, the tool
 *           MUST call `replaceWorkflowRun(bgTaskId, reservedRunId, realRunId)`
 *           so the registry entry gets swapped from placeholder → real id.
 *   - AC-3: A mid-flight `stop_task` (workflow still running) MUST be able to
 *           find the registered runId in the registry and trigger stopRun.
 *           Current code: registry empty during execution → no-op.
 *   - AC-4: Main-session direct invocation (no bgTaskId) MUST skip PRE-attach.
 *
 * Iron Law: NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.
 */

import { describe, test, expect, vi, beforeEach } from "bun:test";

import { runWithBgTaskIdAsync } from "../../task/delegate/bg-task-id-storage";
import {
  createRunWorkflowTool,
  type RunWorkflowLifecycleHooks,
} from "./run-workflow";

type EventName =
  | "attach"
  | "replace"
  | "detach"
  | "runWorkflow:start"
  | "runWorkflow:end"
  | "onSessionCreated";

interface EventLog {
  events: Array<{ name: EventName; at: number }>;
  attachedCalls: Array<{ bgTaskId: string; runId: string }>;
  replacedCalls: Array<{
    bgTaskId: string;
    oldRunId: string;
    newRunId: string;
  }>;
  detachedCalls: Array<{ bgTaskId: string; runId: string }>;
  runWorkflowCalls: Array<{ name: string; input: unknown; options: any }>;
}

function buildEventLog(): EventLog {
  return {
    events: [],
    attachedCalls: [],
    replacedCalls: [],
    detachedCalls: [],
    runWorkflowCalls: [],
  };
}

/**
 * Build hooks that record all calls into the shared log.
 *
 * NOTE: We cast through `any` here because `replaceWorkflowRun` is the new
 * Task #2190 field that does not yet exist on `RunWorkflowLifecycleHooks`.
 * That's the whole point of RED — the test compiles (via cast) but the
 * production hook never fires, so the assertions fail at runtime.
 */
function makeRecordingHooks(
  log: EventLog,
): {
  hooks: RunWorkflowLifecycleHooks;
  registry: Set<string>;
} {
  const registry = new Set<string>();
  const hooks = {
    attachWorkflowRun: (bgTaskId: string, runId: string) => {
      log.events.push({ name: "attach", at: Date.now() });
      log.attachedCalls.push({ bgTaskId, runId });
      registry.add(runId);
    },
    detachWorkflowRun: (bgTaskId: string, runId: string) => {
      log.events.push({ name: "detach", at: Date.now() });
      log.detachedCalls.push({ bgTaskId, runId });
      registry.delete(runId);
    },
    replaceWorkflowRun: (bgTaskId: string, oldRunId: string, newRunId: string) => {
      log.events.push({ name: "replace", at: Date.now() });
      log.replacedCalls.push({ bgTaskId, oldRunId, newRunId });
      registry.delete(oldRunId);
      if (newRunId) registry.add(newRunId);
    },
  };
  return { hooks: hooks as unknown as RunWorkflowLifecycleHooks, registry };
}

describe("workflow_run PRE-execution attach (Task #2190)", () => {
  let log: EventLog;
  let mockWorkflowService: any;

  beforeEach(() => {
    log = buildEventLog();
    // Default mock: returns immediately with `wf_real_456`. Tests that
    // need different behavior (e.g. fire onSessionCreated, block forever)
    // override this in their own setup.
    mockWorkflowService = {
      runWorkflow: vi.fn(async (_name: string, _input: any, _opts: any) => {
        log.events.push({ name: "runWorkflow:start", at: Date.now() });
        log.runWorkflowCalls.push({ name: _name, input: _input, options: _opts });
        // Mimic engine: fire onSessionCreated with the reserved runId
        // (Task #2106 GREEN-B guarantees engine uses the reserved id).
        const sid =
          _opts?.runId ?? `wf_real_${Math.random().toString(36).slice(2, 8)}`;
        if (typeof _opts?.onSessionCreated === "function") {
          _opts.onSessionCreated(sid);
        }
        log.events.push({ name: "onSessionCreated", at: Date.now() });
        const result = {
          runId: sid,
          sessionId: sid,
          status: "completed",
          output: { result: "ok" },
          durationMs: 50,
        };
        log.events.push({ name: "runWorkflow:end", at: Date.now() });
        return result;
      }),
      resumeSession: vi.fn(),
      stopRun: vi.fn(async () => undefined),
    };
  });

  // ---------------------------------------------------------------------
  // AC-1: PRE-execution attach — attachWorkflowRun fires BEFORE runWorkflow
  // ---------------------------------------------------------------------
  test("AC-1: attachWorkflowRun is called BEFORE runner.execute starts (pre-execution attach)", async () => {
    const { hooks } = makeRecordingHooks(log);
    const tool = createRunWorkflowTool(mockWorkflowService, hooks);

    await runWithBgTaskIdAsync("bg_pre_attach", async () => {
      await tool.execute({ workflow_name: "x" } as any, {} as any);
    });

    // runWorkflow must have been called at least once
    expect(log.runWorkflowCalls.length).toBeGreaterThanOrEqual(1);
    // attach must have been called
    expect(log.attachedCalls.length).toBeGreaterThanOrEqual(1);

    // Order check: find indices of the FIRST attach and FIRST runWorkflow:start
    const firstAttachIdx = log.events.findIndex((e) => e.name === "attach");
    const firstRunStartIdx = log.events.findIndex(
      (e) => e.name === "runWorkflow:start",
    );

    expect(firstAttachIdx).toBeGreaterThanOrEqual(0);
    expect(firstRunStartIdx).toBeGreaterThanOrEqual(0);
    // ★ The fix: attach must come BEFORE runWorkflow:start.
    // On current code (POST-attach), firstAttachIdx > firstRunStartIdx,
    // so this assertion FAILS (RED).
    expect(firstAttachIdx).toBeLessThan(firstRunStartIdx);
  });

  // ---------------------------------------------------------------------
  // AC-2: replaceWorkflowRun fires when engine reports real runId
  // ---------------------------------------------------------------------
  test("AC-2: onSessionCreated triggers replaceWorkflowRun(reservedRunId → realRunId)", async () => {
    // Force runWorkflow to fire onSessionCreated with a SPECIFIC, KNOWN id
    // different from the synthesized reservedRunId. This simulates the
    // case where engine does NOT honor the reserved id (legacy engine).
    const KNOWN_REAL_ID = "wf_engine_picks_xyz_999";
    mockWorkflowService.runWorkflow = vi.fn(
      async (_name: string, _input: any, opts: any) => {
        log.events.push({ name: "runWorkflow:start", at: Date.now() });
        log.runWorkflowCalls.push({ name: _name, input: _input, options: opts });
        if (typeof opts?.onSessionCreated === "function") {
          opts.onSessionCreated(KNOWN_REAL_ID);
        }
        log.events.push({ name: "onSessionCreated", at: Date.now() });
        return {
          runId: KNOWN_REAL_ID,
          sessionId: KNOWN_REAL_ID,
          status: "completed",
          output: {},
          durationMs: 10,
        };
      },
    );

    const { hooks } = makeRecordingHooks(log);
    const tool = createRunWorkflowTool(mockWorkflowService, hooks);

    await runWithBgTaskIdAsync("bg_replace_test", async () => {
      await tool.execute({ workflow_name: "y" } as any, {} as any);
    });

    // Pre-condition: PRE-attach fired (covered by AC-1, but sanity check here)
    expect(log.attachedCalls.length).toBe(1);
    const reservedRunId = log.attachedCalls[0].runId;
    expect(reservedRunId).toMatch(/^workflow_/);

    // ★ The fix: replaceWorkflowRun must have fired with the OLD (reserved)
    // runId and the NEW (engine-reported) runId.
    expect(log.replacedCalls.length).toBe(1);
    expect(log.replacedCalls[0]).toEqual({
      bgTaskId: "bg_replace_test",
      oldRunId: reservedRunId,
      newRunId: KNOWN_REAL_ID,
    });
  });

  // ---------------------------------------------------------------------
  // AC-3: Mid-flight stop_task can find the runId in the registry
  // ---------------------------------------------------------------------
  test("AC-3: during a long-running workflow_run, the registry has the runId (mid-flight stop can find it)", async () => {
    // Mock: runWorkflow NEVER resolves (simulates a 30+ min workflow).
    // The engine ALSO fires onSessionCreated immediately so we can later
    // inspect what was attached.
    const REAL_RUN_ID = "wf_long_running_aaa";
    let releasePromise: () => void = () => {};
    mockWorkflowService.runWorkflow = vi.fn(
      async (_name: string, _input: any, opts: any) => {
        log.events.push({ name: "runWorkflow:start", at: Date.now() });
        log.runWorkflowCalls.push({ name: _name, input: _input, options: opts });
        if (typeof opts?.onSessionCreated === "function") {
          opts.onSessionCreated(REAL_RUN_ID);
        }
        log.events.push({ name: "onSessionCreated", at: Date.now() });
        return new Promise<any>((resolve) => {
          const releaser = () =>
            resolve({
              runId: REAL_RUN_ID,
              sessionId: REAL_RUN_ID,
              status: "completed",
              output: {},
              durationMs: 99999,
            });
          releasePromise = releaser;
        });
      },
    );

    const { hooks, registry } = makeRecordingHooks(log);
    const tool = createRunWorkflowTool(mockWorkflowService, hooks);

    // Kick off the long-running workflow in background
    const bgTask = runWithBgTaskIdAsync("bg_midflight", async () => {
      return await tool.execute({ workflow_name: "long" } as any, {} as any);
    });

    // Yield to let PRE-attach + onSessionCreated fire (microtask flush)
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    // ★ MID-FLIGHT: workflow is still running, but the registry MUST
    // already contain a runId. Current bug: registry is empty until
    // workflow completes (POST-attach) → propagateStop can't find anything.
    expect(registry.size).toBeGreaterThan(0);
    expect(registry.has(REAL_RUN_ID)).toBe(true);

    // Now simulate stop_task: should be able to stopRun against REAL_RUN_ID
    await mockWorkflowService.stopRun(REAL_RUN_ID, "test mid-flight stop");
    expect(mockWorkflowService.stopRun).toHaveBeenCalledWith(
      REAL_RUN_ID,
      "test mid-flight stop",
    );

    // Resolve the workflow so the test can clean up
    releasePromise();
    await bgTask;
  });

  // ---------------------------------------------------------------------
  // AC-4: Main-session direct invocation (no bgTaskId) skips PRE-attach
  // ---------------------------------------------------------------------
  test("AC-4: no bgTaskId in ALS → no attach, no replace (main session direct)", async () => {
    const { hooks } = makeRecordingHooks(log);
    const tool = createRunWorkflowTool(mockWorkflowService, hooks);

    // No runWithBgTaskIdAsync — main session direct invocation
    const result = await tool.execute({ workflow_name: "x" } as any, {} as any);

    expect(result.success).toBe(true);
    expect(log.attachedCalls).toHaveLength(0);
    expect(log.replacedCalls).toHaveLength(0);
    expect(log.detachedCalls).toHaveLength(0);
  });
});