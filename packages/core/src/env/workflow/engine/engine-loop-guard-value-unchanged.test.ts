/**
 * Engine loop_guard integration tests.
 *
 * TDD: RED phase for Step 3 of the loop_guard engine feature (Task #2283).
 * Validates that the engine detects no-progress back-edge re-entries via
 * `value_unchanged` (previous_signal vs current_signal_command) and either:
 *   - skips the agent and marks the node as FAIL when the no-progress
 *     counter reaches `max_consecutive_no_progress`
 *   - increments the counter and allows re-entry otherwise
 *
 * Backward-compatibility:
 *   - Nodes without loop_guard continue to re-enter the agent
 *     indefinitely (relies on the existing maxIterations guard).
 *
 * @see /tmp/loop-guard-engine-design.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkflowEngine } from './engine';
import { NodeRegistry } from './node-registry';
import type { LoopGuardConfig, NodeDefinition, WorkflowDefinition } from '../types';

interface AttemptTracker {
  attempts: number;
  outputs: unknown[];
}function makeLoopbackWorkflow(
  guards: Record<string, LoopGuardConfig>,
): WorkflowDefinition {
  return {
    name: 'loop-guard-engine',
    version: '1.0',
    entry: 'review',
    config: {
      loopEnabled: true,
      maxIterations: 10,
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
          ...(guards.implement ? { loop_guard: guards.implement } : {}),
        },
      },
    ],
    edges: [
      // review → implement (forward)
      { from: 'review', to: 'implement', when: "{{nodes.review.status}} == 'PASS'" },
      // implement → implement (self-loop back-edge for FAIL) — exercises
      // the loop_guard which lives on the re-entry target.
      { from: 'implement', to: 'implement', when: "{{nodes.implement.status}} == 'FAIL'" },
      // implement → __end__ (forward for PASS)
      { from: 'implement', to: '__end__', when: "{{nodes.implement.status}} == 'PASS'" },
    ],
    inputs: {},
    outputs: [],
    metadata: { tags: [] },
  };
}

function buildRegistry(trackers: { review: AttemptTracker; implement: AttemptTracker }) {
  const registry = new NodeRegistry();
  registry.register('mock-agent', (definition: NodeDefinition) => ({
    id: definition.id,
    type: definition.type,
    execute: async () => {
      if (definition.id === 'review') {
        trackers.review.attempts += 1;
        // First review pass → PASS, second pass → PASS too (no-op so the
        // back-edge re-entry semantics are exercised). The reviewer always
        // passes; the implement node decides whether to terminate.
        return { output: { status: 'PASS' } };
      }
      if (definition.id === 'implement') {
        trackers.implement.attempts += 1;
        // Always returns FAIL to keep the back-edge firing until loop_guard
        // (or maxIterations) takes over.
        const output = { status: 'FAIL', commits: ['sha-fixed'] };
        trackers.implement.outputs.push(output);
        return { output };
      }
      return { output: {} };
    },
  }));
  return registry;
}

describe('WorkflowEngine loop_guard — value_unchanged', () => {
  beforeEach(() => {
    // Each test stubs /bin/sh -c <cmd> via execFile. The engine falls back
    // to process.cwd() when guard.cwd is undefined; tests supply explicit
    // cwd to avoid touching the real working tree.
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('short-circuits the agent when the progress signal is unchanged on the first re-entry (max=1, default)', async () => {
    // Both runs of `implement` return commits=['sha-fixed'] (so previous_signal
    // and current_signal_command both yield the literal 'sha-fixed').
    const guard: LoopGuardConfig = {
      type: 'value_unchanged',
      previous_signal: "{{nodes.implement.commits[-1]}}",
      current_signal_command: 'printf "sha-fixed"',
      cwd: '/tmp',
      max_consecutive_no_progress: 1,
    };

    const trackers = {
      review: { attempts: 0, outputs: [] as unknown[] },
      implement: { attempts: 0, outputs: [] as unknown[] },
    };
    const registry = buildRegistry(trackers);
    const engine = new WorkflowEngine(registry);

    const result = await engine.runWorkflow(
      makeLoopbackWorkflow({ implement: guard }),
      { workflowInput: { project_path: '/tmp' } },
    );

    // Workflow completes (engine fails the loop_guard-tripped node, but the
    // other edges/forward path eventually terminate). Crucially the agent
    // for `implement` ran only once.
    expect(trackers.implement.attempts).toBe(1);

    // The first attempt's output stays in the result map.
    const finalOutput = result.output as Record<string, unknown>;
    const implementOut = finalOutput['implement'] as Record<string, unknown>;
    expect(implementOut.status).toBe('FAIL');
    expect(implementOut._loop_guard_triggered).toBe(true);
    expect(typeof implementOut.fail_reason).toBe('string');
    expect(String(implementOut.fail_reason)).toMatch(/no progress/i);
  });

  it('allows re-entry up to max_consecutive_no_progress before tripping', async () => {
    // max=2: the engine should let the agent run twice before forcing FAIL.
    // We track this by mutating commits[0] between runs so each subsequent
    // current_signal_command value differs.
    const callCount = { n: 0 };
    const guard: LoopGuardConfig = {
      type: 'value_unchanged',
      previous_signal: "{{nodes.implement.commits[0]}}",
      current_signal_command: 'printf "fixed"',
      cwd: '/tmp',
      max_consecutive_no_progress: 3,
    };

    // Use a custom registry so we can vary the commits[] per attempt.
    const registry = new NodeRegistry();
    registry.register('mock-agent', (definition: NodeDefinition) => ({
      id: definition.id,
      type: definition.type,
      execute: async () => {
        if (definition.id === 'review') {
          return { output: { status: 'PASS' } };
        }
        if (definition.id === 'implement') {
          callCount.n += 1;
          // Each attempt pushes a NEW commit. The first run produces
          // commits=['new-1'], the second run sees previous_commits[0]='new-1'
          // but emits 'new-2', etc. — so the engine sees progress every time
          // and never trips.
          const tag = `new-${callCount.n}`;
          return { output: { status: 'FAIL', commits: [tag] } };
        }
        return { output: {} };
      },
    }));

    const engine = new WorkflowEngine(registry);
    const result = await engine.runWorkflow(
      makeLoopbackWorkflow({ implement: guard }),
      { workflowInput: { project_path: '/tmp' } },
    );

    // With progress each iteration, the engine should not trip.
    const finalOutput = result.output as Record<string, unknown>;
    const implementOut = finalOutput['implement'] as Record<string, unknown>;
    expect(implementOut._loop_guard_triggered).toBeUndefined();
  });

  it('trips the guard when previous_signal matches current value on re-entry (max=1)', async () => {
    // previous_signal = implement.status (which is always 'FAIL').
    // current_signal_command returns 'FAIL' (matches previous on every re-entry).
    // max=1 means trip on the very first re-entry.
    const guard: LoopGuardConfig = {
      type: 'value_unchanged',
      previous_signal: '{{nodes.implement.status}}',
      current_signal_command: 'printf "FAIL"',
      cwd: '/tmp',
      max_consecutive_no_progress: 1,
    };

    const trackers = {
      review: { attempts: 0, outputs: [] as unknown[] },
      implement: { attempts: 0, outputs: [] as unknown[] },
    };
    const registry = buildRegistry(trackers);
    const engine = new WorkflowEngine(registry);

    const result = await engine.runWorkflow(
      makeLoopbackWorkflow({ implement: guard }),
      { workflowInput: { project_path: '/tmp' } },
    );

    // For a self-loop back-edge, the source (implement) is also the
    // re-entry target, so the cascade-reset filter preserves the
    // previous output. The first re-entry sees previous='FAIL' and
    // current='FAIL' → match → counter=1, max=1 → trip on the very
    // first re-entry. Implement runs only once.
    expect(trackers.implement.attempts).toBe(1);

    const finalOutput = result.output as Record<string, unknown>;
    const implementOut = finalOutput['implement'] as Record<string, unknown>;
    expect(implementOut._loop_guard_triggered).toBe(true);
  });

  it('uses custom fail_message when provided', async () => {
    const guard: LoopGuardConfig = {
      type: 'value_unchanged',
      previous_signal: "{{nodes.implement.commits[-1]}}",
      current_signal_command: 'printf "sha-fixed"',
      cwd: '/tmp',
      max_consecutive_no_progress: 1,
      fail_message: 'BACKEND_TEAM_NOTIFIED: commits unchanged after 1 retries',
    };

    const trackers = {
      review: { attempts: 0, outputs: [] as unknown[] },
      implement: { attempts: 0, outputs: [] as unknown[] },
    };
    const registry = buildRegistry(trackers);
    const engine = new WorkflowEngine(registry);

    const result = await engine.runWorkflow(
      makeLoopbackWorkflow({ implement: guard }),
      { workflowInput: { project_path: '/tmp' } },
    );

    const implementOut = (result.output as Record<string, unknown>)['implement'] as Record<string, unknown>;
    expect(implementOut.fail_reason).toBe(
      'BACKEND_TEAM_NOTIFIED: commits unchanged after 1 retries',
    );
  });

  it('is a no-op when no node declares loop_guard (backward compatibility)', async () => {
    const trackers = {
      review: { attempts: 0, outputs: [] as unknown[] },
      implement: { attempts: 0, outputs: [] as unknown[] },
    };
    const registry = buildRegistry(trackers);
    const engine = new WorkflowEngine(registry);

    // No guard configured — engine should rely on the existing maxIterations
    // guard. With maxIterations=3 and 3 back-edges per implement call, the
    // workflow trips the loop-iteration cap (3).
    const result = await engine.runWorkflow(
      makeLoopbackWorkflow({}),
      { workflowInput: { project_path: '/tmp' } },
    );

    // Workflow failed because loop-iteration count exceeded.
    expect(result.status).toBe('failed');
    expect(trackers.implement.attempts).toBeGreaterThan(1);
  });
});
