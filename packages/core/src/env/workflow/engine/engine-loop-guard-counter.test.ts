/**
 * Engine loop_guard counter persistence tests.
 *
 * TDD: RED phase for the Task #2286 follow-up bug fix.
 *
 * Bug: `max_consecutive_no_progress >= 2` never trips because the
 * counter was stored in `sessionState.nodeOutputs[reEntryId][counterKey]`,
 * but the next agent run overwrites that whole map entry via
 * `sessionState.nodeOutputs.set(nodeId, result.output)`. So the
 * counter is reset to 0 on every back-edge re-entry, and the guard
 * can never reach `max`.
 *
 * Fix: persist counters in a dedicated `sessionState.loopGuardCounters`
 * map (separate from nodeOutputs) so the agent's output write never
 * collides with the guard's state.
 *
 * @see /tmp/loop-guard-engine-design.md (Bug: counter persistence)
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
 * Build the minimal loopback workflow used by all three tests:
 *   review → implement → (self-loop on FAIL, forward to __end__ on PASS)
 */
function makeLoopbackWorkflow(
  guards: Record<string, LoopGuardConfig>,
  maxIterations = 20,
): WorkflowDefinition {
  return {
    name: 'loop-guard-counter-persistence',
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
          // Deliberately DO NOT echo `_loop_guard_consecutive_*` in the
          // agent's output — that's exactly what real agents do, and it
          // is what causes the original bug.
          ...(guards.implement ? { loop_guard: guards.implement } : {}),
        },
      },
    ],
    edges: [
      // review → implement (forward)
      { from: 'review', to: 'implement', when: "{{nodes.review.status}} == 'PASS'" },
      // implement → implement (self-loop on FAIL — exercises loop_guard)
      { from: 'implement', to: 'implement', when: "{{nodes.implement.status}} == 'FAIL'" },
      // implement → __end__ (forward on PASS)
      { from: 'implement', to: '__end__', when: "{{nodes.implement.status}} == 'PASS'" },
    ],
    inputs: {},
    outputs: [],
    metadata: { tags: [] },
  };
}

/**
 * Build a registry where the `implement` agent always returns a
 * payload that does NOT include the `_loop_guard_consecutive_*`
 * counter key. This mirrors the real-world TDD-implement
 * agent output and is what triggers the original bug.
 */
function buildRegistryWithoutCounter(tracker: AttemptTracker): NodeRegistry {
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
        // Agent emits only the domain fields — no counter.
        const output = {
          status: 'FAIL',
          tdd_status: 'FAIL',
          attempt: tracker.attempts,
        };
        tracker.outputs.push(output);
        return { output };
      }
      return { output: {} };
    },
  }));
  return registry;
}

describe('WorkflowEngine loop_guard — counter persistence (Task #2286 fix)', () => {
  afterEach(() => {
    // Nothing to restore — vi.restoreAllMocks() is called per test in
    // the value_unchanged suite; this test does not stub /bin/sh.
  });

  it('counter survives agent output overwrites (max=2, all-no-progress)', async () => {
    // Guard reads implement.status (always 'FAIL') and the current
    // signal command always returns 'FAIL'. So every back-edge sees
    // unchanged = no progress. With max=2 we expect the loop_guard
    // to trip on the 2nd back-edge.
    const guard: LoopGuardConfig = {
      type: 'value_unchanged',
      previous_signal: '{{nodes.implement.status}}',
      current_signal_command: 'printf "FAIL"',
      cwd: '/tmp',
      max_consecutive_no_progress: 2,
    };

    const tracker: AttemptTracker = { attempts: 0, outputs: [] };
    const registry = buildRegistryWithoutCounter(tracker);
    const engine = new WorkflowEngine(registry);

    const result = await engine.runWorkflow(
      makeLoopbackWorkflow({ implement: guard }),
      { workflowInput: { project_path: '/tmp' } },
    );

    const finalOutput = result.output as Record<string, unknown>;
    const implementOut = finalOutput['implement'] as Record<string, unknown>;

    // CORE ASSERTION (was the bug):
    // The guard must trip on the 2nd no-progress re-entry, so the
    // agent runs exactly twice. Pre-fix, the counter was reset on
    // every agent run, the guard never tripped, and the workflow
    // would only stop at maxIterations.
    expect(implementOut._loop_guard_triggered).toBe(true);
    expect(tracker.attempts).toBe(2);

    // Counter snapshot on the failed node should equal max (2).
    expect(implementOut._loop_guard_consecutive_implement).toBe(2);

    // The fail message must be present.
    expect(typeof implementOut.fail_reason).toBe('string');
    expect(String(implementOut.fail_reason)).toMatch(/no progress/i);
  });

  it('counter resets to 0 when the previous_signal differs (no false trip)', async () => {
    // Guard reads implement.attempt (changes per call) vs a static
    // command output. The signal changes every re-entry, so the
    // guard should NEVER trip — the workflow runs until maxIterations.
    const guard: LoopGuardConfig = {
      type: 'value_unchanged',
      previous_signal: '{{nodes.implement.attempt}}',
      current_signal_command: 'printf "1"',  // never matches the incrementing attempt
      cwd: '/tmp',
      max_consecutive_no_progress: 2,
    };

    const tracker: AttemptTracker = { attempts: 0, outputs: [] };
    const registry = buildRegistryWithoutCounter(tracker);
    const engine = new WorkflowEngine(registry);

    const result = await engine.runWorkflow(
      // Tight maxIterations so the loop terminates deterministically.
      makeLoopbackWorkflow({ implement: guard }, /* maxIterations */ 5),
      { workflowInput: { project_path: '/tmp' } },
    );

    const finalOutput = result.output as Record<string, unknown>;
    const implementOut = finalOutput['implement'] as Record<string, unknown>;

    // The guard should NOT have tripped.
    expect(implementOut._loop_guard_triggered).toBeUndefined();

    // The workflow should have hit the maxIterations cap.
    expect(result.status).toBe('failed');
    expect(String(result.error ?? '')).toMatch(/maximum loop iterations/i);
  });

  it('counter accumulates across back-edge re-entries (max=3)', async () => {
    // Stricter test: max=3, all-no-progress. The agent must run exactly
    // 3 times and trip on the 3rd re-entry. This pins the counter
    // behavior over multiple re-entries, not just the first.
    const guard: LoopGuardConfig = {
      type: 'value_unchanged',
      previous_signal: '{{nodes.implement.tdd_status}}',
      current_signal_command: 'printf "FAIL"',
      cwd: '/tmp',
      max_consecutive_no_progress: 3,
    };

    const tracker: AttemptTracker = { attempts: 0, outputs: [] };
    const registry = buildRegistryWithoutCounter(tracker);
    const engine = new WorkflowEngine(registry);

    const result = await engine.runWorkflow(
      makeLoopbackWorkflow({ implement: guard }, /* maxIterations */ 50),
      { workflowInput: { project_path: '/tmp' } },
    );

    const finalOutput = result.output as Record<string, unknown>;
    const implementOut = finalOutput['implement'] as Record<string, unknown>;

    // Trip on the 3rd no-progress re-entry.
    expect(implementOut._loop_guard_triggered).toBe(true);
    expect(tracker.attempts).toBe(3);
    expect(implementOut._loop_guard_consecutive_implement).toBe(3);
    expect(String(implementOut.fail_reason)).toMatch(/no progress/i);
  });
});