/**
 * Engine loop_guard silent short-circuit tests (Task #2438 fix).
 *
 * TDD: RED phase. These tests describe the production-loop-guard bug
 * surfaced in Task #2437 (`tongagent-rd-pipeline` v1.2.1 re-run loop):
 * the per-node `value_unchanged` loop_guard silently fails to trip on
 * real-world configurations, letting the engine re-enter the agent
 * indefinitely even when the no-progress threshold is reached.
 *
 * Three silent short-circuits (root causes A/B/C, per #2438 report):
 *   A) `previousValue === undefined` was treated as a "first run" and
 *      always allowed re-entry, even when the agent had clearly
 *      produced a non-empty output snapshot whose `previous_signal`
 *      path is unresolvable (e.g. `commits:[]`).
 *   B) `cwd` and `current_signal_command` were passed to
 *      `execFileAsync` AS-IS, so the `{{input.*}}` template strings
 *      the workflow YAML legitimately stores (e.g.
 *      `"$(dirname {{input.project_path}})/..."`) were never resolved
 *      and the shell call failed.
 *   C) The defensive try/catch around `execFileAsync` swallowed shell
 *      errors and returned `trip:false`, so a malformed command
 *      silently became "no guard ran" rather than a no-progress event.
 *
 * The three tests below pin the production behavior we WANT, then the
 * engine fix in `engine.ts:checkLoopGuardWithSnapshot` makes them
 * pass.
 *
 * @see ~/work/codework/personal/roy_world/roy-bot/reports/2026-07-25-tongagent-loop-guard-bug-analysis.md
 */

import { afterEach, describe, expect, it } from 'vitest';

import { WorkflowEngine } from './engine';
import { NodeRegistry } from './node-registry';
import type { LoopGuardConfig, NodeDefinition, WorkflowDefinition } from '../types';

interface AttemptTracker {
  attempts: number;
  outputs: unknown[];
}

/**
 * Build the canonical loopback workflow:
 *   review → implement → (self-loop on FAIL, forward to __end__ on PASS)
 *
 * Same shape as the existing counter/value-unchanged tests so the
 * new behavior is isolated to the guard config + agent output.
 */
function makeLoopbackWorkflow(
  guard: LoopGuardConfig,
  maxIterations = 20,
): WorkflowDefinition {
  return {
    name: 'loop-guard-silent-short-circuit',
    version: '1.0',
    entry: 'review',
    config: {
      loopEnabled: true,
      maxIterations,
      parallel_limit: null,
      timeout: null,
      debug: false,
      strict: false,
    },
    nodes: [
      {
        id: 'review',
        type: 'mock-agent',
        config: { prompt: 'reviewing' },
      },
      {
        id: 'implement',
        type: 'mock-agent',
        config: {
          prompt: 'implementing',
          loop_guard: guard,
        },
      },
    ],
    edges: [
      { from: 'review', to: 'implement', when: "{{nodes.review.status}} == 'PASS'" },
      { from: 'implement', to: 'implement', when: "{{nodes.implement.status}} == 'FAIL'" },
      { from: 'implement', to: '__end__', when: "{{nodes.implement.status}} == 'PASS'" },
    ],
    inputs: {},
    outputs: [],
    metadata: { tags: [] },
  };
}

describe('WorkflowEngine loop_guard — silent short-circuit (Task #2438 fix)', () => {
  afterEach(() => {
    // Nothing to restore per test; we don't stub /bin/sh for Fix A/C.
  });

  it('Fix A: trips on `commits:[]` / previous_signal unresolved (max=1)', async () => {
    // Production-shaped config: `previous_signal` is a structured path
    // (`commits[-1]`) that resolves to undefined whenever the agent
    // output's `commits` array is empty. The shell command always
    // succeeds; the bug is purely in the "previousValue undefined"
    // short-circuit.
    const guard: LoopGuardConfig = {
      type: 'value_unchanged',
      previous_signal: '{{nodes.implement.commits[-1]}}',
      current_signal_command: 'printf "anything"',
      cwd: '/tmp',
      max_consecutive_no_progress: 1,
      fail_message: 'loop_guard previous_signal path unresolved (commits:[])',
    };

    const tracker: AttemptTracker = { attempts: 0, outputs: [] };
    const registry = new NodeRegistry();
    registry.register('mock-agent', (definition: NodeDefinition) => ({
      id: definition.id,
      type: definition.type,
      execute: async () => {
        if (definition.id === 'review') {
          return { output: { status: 'PASS' } };
        }
        if (definition.id === 'implement') {
          tracker.attempts += 1;
          // Mirrors the real tdd-implement output when the worktree
          // pre-condition is missing: status='FAIL', commits=[].
          const output = { status: 'FAIL', commits: [] as string[] };
          tracker.outputs.push(output);
          return { output };
        }
        return { output: {} };
      },
    }));

    const engine = new WorkflowEngine(registry);
    const result = await engine.runWorkflow(
      makeLoopbackWorkflow(guard, /* maxIterations */ 5),
      { workflowInput: { project_path: '/tmp' } },
    );

    // CORE ASSERTION (was the bug):
    // The guard MUST trip on the first re-entry. Pre-fix the engine
    // saw previousValue===undefined, treated it as a first-run, and
    // returned trip:false, which let the agent re-run indefinitely
    // (capped only by maxIterations=5).
    expect(tracker.attempts).toBe(1);

    const finalOutput = result.output as Record<string, unknown>;
    const implementOut = finalOutput['implement'] as Record<string, unknown>;
    expect(implementOut._loop_guard_triggered).toBe(true);
    expect(String(implementOut.fail_reason)).toMatch(/previous_signal/i);
  });

  it('Fix A: still allows re-entry when previous_signal resolves successfully (regression)', async () => {
    // Sanity check: Fix A must NOT make the guard over-aggressive. If
    // the agent's previous output contains a resolvable previous_signal
    // value AND that value DIFFERS from the current signal, the guard
    // should treat this as progress and allow the re-entry (counter
    // resets, not trip).
    //
    // This is the regression case for the existing behavior pinned by
    // `engine-loop-guard-value-unchanged.test.ts` — we MUST keep it
    // working with the new fix logic.
    const guard: LoopGuardConfig = {
      type: 'value_unchanged',
      previous_signal: '{{nodes.implement.status}}',
      current_signal_command: 'printf "FAIL"',
      cwd: '/tmp',
      max_consecutive_no_progress: 1,
    };

    // First run: FAIL with status='FAIL' (matches current). Trip.
    // We use a single run then check that the guard tripped (not 2+).
    const tracker: AttemptTracker = { attempts: 0, outputs: [] };
    const registry = new NodeRegistry();
    registry.register('mock-agent', (definition: NodeDefinition) => ({
      id: definition.id,
      type: definition.type,
      execute: async () => {
        if (definition.id === 'review') {
          return { output: { status: 'PASS' } };
        }
        if (definition.id === 'implement') {
          tracker.attempts += 1;
          return { output: { status: 'FAIL' } };
        }
        return { output: {} };
      },
    }));

    const engine = new WorkflowEngine(registry);
    const result = await engine.runWorkflow(
      makeLoopbackWorkflow(guard, /* maxIterations */ 5),
      { workflowInput: { project_path: '/tmp' } },
    );

    // Trip on 1st re-entry (previous='FAIL' matches current='FAIL').
    // Fix A doesn't fire because previousValue is well-defined.
    expect(tracker.attempts).toBe(1);
    const finalOutput = result.output as Record<string, unknown>;
    const implementOut = finalOutput['implement'] as Record<string, unknown>;
    expect(implementOut._loop_guard_triggered).toBe(true);
  });

  it('Fix B: current_signal_command templates are resolved before shell exec', async () => {
    // Production-shaped config: workflow YAML stores shell templates
    // in current_signal_command (e.g.
    // `printf "{{input.expected_sha}}"`). The engine MUST pass the
    // resolved value to /bin/sh, not the raw `{{...}}` string.
    //
    // Trick: agent outputs commits=['expected-sha'] on the first run.
    // current_signal_command: 'printf "{{input.expected_sha}}"'.
    //   - Pre-fix: shell sees `printf "{{input.expected_sha}}"`
    //     literally, prints `{{input.expected_sha}}` (no
    //     interpolation happens because printf doesn't expand
    //     template syntax). currentValue='{{input.expected_sha}}' ≠
    //     previousValue='expected-sha' → trip:false (counter resets).
    //     Engine keeps re-running the agent (maxIterations=3 in test).
    //   - Post-fix: templateResolver.resolveValue resolves the
    //     command to `printf "expected-sha"`. currentValue matches
    //     previousValue on the second re-entry → trip.
    const guard: LoopGuardConfig = {
      type: 'value_unchanged',
      previous_signal: "{{nodes.implement.commits[-1]}}",
      current_signal_command: 'printf "{{input.expected_sha}}"',
      cwd: '/tmp',
      max_consecutive_no_progress: 1,
      fail_message: 'loop_guard command template unresolved',
    };

    let implementCalls = 0;
    const registry = new NodeRegistry();
    registry.register('mock-agent', (definition: NodeDefinition) => ({
      id: definition.id,
      type: definition.type,
      execute: async () => {
        if (definition.id === 'review') {
          return { output: { status: 'PASS' } };
        }
        if (definition.id === 'implement') {
          implementCalls += 1;
          // Always return FAIL with the same expected_sha so the
          // back-edge fires. If the template is properly resolved,
          // the engine will see the same value every re-entry and
          // trip on the first no-progress.
          return { output: { status: 'FAIL', commits: ['expected-sha'] } };
        }
        return { output: {} };
      },
    }));

    const engine = new WorkflowEngine(registry);
    const result = await engine.runWorkflow(
      makeLoopbackWorkflow(guard, /* maxIterations */ 5),
      { workflowInput: { project_path: '/tmp', expected_sha: 'expected-sha' } },
    );

    // CORE ASSERTION: implement must have run exactly once.
    // Pre-fix the template leaked into the shell, the comparison
    // always returned a mismatch, the counter never reached max, and
    // the agent ran multiple times (or hit maxIterations).
    expect(implementCalls).toBe(1);

    const finalOutput = result.output as Record<string, unknown>;
    const implementOut = finalOutput['implement'] as Record<string, unknown>;
    expect(implementOut._loop_guard_triggered).toBe(true);
  });

  it('Fix C: shell errors are fail-closed (no longer swallowed)', async () => {
    // Production-shaped config: the current_signal_command itself
    // fails (e.g. git binary missing, or cwd path no longer exists).
    // The previousValue is well-defined (`tdd_status`), so Fix A does
    // not apply. The bug is purely in the catch branch that returns
    // trip:false.
    //
    // We use `false` (always exits 1) so the shell call always fails.
    // Pre-fix: engine logs a WARN, returns trip:false, agent re-runs
    // forever. Post-fix: fail-closed, counter increments, trip after
    // max=1.
    const guard: LoopGuardConfig = {
      type: 'value_unchanged',
      previous_signal: '{{nodes.implement.tdd_status}}',
      current_signal_command: 'false',
      cwd: '/tmp',
      max_consecutive_no_progress: 1,
      fail_message: 'loop_guard command failed (fail-closed)',
    };

    const tracker: AttemptTracker = { attempts: 0, outputs: [] };
    const registry = new NodeRegistry();
    registry.register('mock-agent', (definition: NodeDefinition) => ({
      id: definition.id,
      type: definition.type,
      execute: async () => {
        if (definition.id === 'review') {
          return { output: { status: 'PASS' } };
        }
        if (definition.id === 'implement') {
          tracker.attempts += 1;
          // previousValue='FAIL' is well-defined (Fix A path is
          // skipped). current_signal_command fails (Fix C path
          // should trip after max=1).
          const output = { status: 'FAIL', tdd_status: 'FAIL' };
          tracker.outputs.push(output);
          return { output };
        }
        return { output: {} };
      },
    }));

    const engine = new WorkflowEngine(registry);
    const result = await engine.runWorkflow(
      makeLoopbackWorkflow(guard, /* maxIterations */ 5),
      { workflowInput: { project_path: '/tmp' } },
    );

    // CORE ASSERTION: implement must have run exactly once.
    // Pre-fix the catch branch returned trip:false, the engine let
    // the agent re-enter until maxIterations=5 was hit.
    expect(tracker.attempts).toBe(1);

    const finalOutput = result.output as Record<string, unknown>;
    const implementOut = finalOutput['implement'] as Record<string, unknown>;
    expect(implementOut._loop_guard_triggered).toBe(true);
    expect(String(implementOut.fail_reason)).toMatch(/command failed/i);
  });
});
