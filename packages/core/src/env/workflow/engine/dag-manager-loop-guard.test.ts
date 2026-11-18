/**
 * DAGManager.getLoopGuard() tests.
 *
 * TDD: RED phase for Step 2 of the loop_guard engine feature (Task #2283).
 * Verifies that DAGManager exposes a typed accessor for the (optional)
 * loop_guard block on a node's config, returning the parsed/normalized
 * LoopGuardConfig (defaults applied) when present, or undefined when not.
 *
 * @see /tmp/loop-guard-engine-design.md
 */

import { describe, expect, it } from 'vitest';

import { DAGManager } from './dag-manager';
import type { LoopGuardConfig, WorkflowDefinition } from '../types';

function buildWorkflow(nodes: Array<{ id: string; loop_guard?: LoopGuardConfig }>): WorkflowDefinition {
  return {
    name: 'loop-guard-dag-test',
    version: '1.0',
    entry: nodes[0]?.id ?? 'start',
    config: {
      loopEnabled: true,
      maxIterations: 5,
      parallel_limit: null,
      timeout: null,
      debug: false,
      strict: false,
    },
    nodes: nodes.map((n) => ({
      id: n.id,
      type: 'agent',
      config: n.loop_guard ? { loop_guard: n.loop_guard } : {},
    })),
    edges: [],
    inputs: {},
    outputs: [],
    metadata: { tags: [] },
  };
}

describe('DAGManager.getLoopGuard', () => {
  it('returns undefined when the node has no loop_guard', () => {
    const wf = buildWorkflow([{ id: 'plain' }, { id: 'guarded' }]);
    const dag = new DAGManager(wf, { allowCycles: true });

    expect(dag.getLoopGuard('plain')).toBeUndefined();
    expect(dag.getLoopGuard('guarded')).toBeUndefined();
  });

  it('returns the parsed LoopGuardConfig when the node has one', () => {
    const wf = buildWorkflow([
      {
        id: 'tdd',
        loop_guard: {
          type: 'value_unchanged',
          previous_signal: '{{nodes.tdd.commits[-1]}}',
          current_signal_command: 'git rev-parse HEAD',
          cwd: '/repo',
          max_consecutive_no_progress: 3,
          fail_message: 'HEAD unchanged',
        },
      },
    ]);
    const dag = new DAGManager(wf, { allowCycles: true });

    const guard = dag.getLoopGuard('tdd');
    expect(guard).toBeDefined();
    expect(guard?.type).toBe('value_unchanged');
    expect(guard?.previous_signal).toBe('{{nodes.tdd.commits[-1]}}');
    expect(guard?.current_signal_command).toBe('git rev-parse HEAD');
    expect(guard?.cwd).toBe('/repo');
    expect(guard?.max_consecutive_no_progress).toBe(3);
    expect(guard?.fail_message).toBe('HEAD unchanged');
  });

  it('applies default max_consecutive_no_progress=1 when omitted on the node', () => {
    const wf = buildWorkflow([
      {
        id: 'tdd',
        loop_guard: {
          type: 'value_unchanged',
          previous_signal: '{{nodes.tdd.commits[-1]}}',
          current_signal_command: 'git rev-parse HEAD',
        },
      },
    ]);
    const dag = new DAGManager(wf, { allowCycles: true });

    const guard = dag.getLoopGuard('tdd');
    expect(guard?.max_consecutive_no_progress).toBe(1);
  });

  it('returns undefined for an unknown node ID', () => {
    const wf = buildWorkflow([{ id: 'known' }]);
    const dag = new DAGManager(wf, { allowCycles: true });

    expect(dag.getLoopGuard('does-not-exist')).toBeUndefined();
  });

  it('returns undefined when loop_guard is the literal null (defensive)', () => {
    // Construct manually to bypass schema validation; the runtime contract
    // is "missing or malformed → undefined" rather than a thrown error.
    const wf: WorkflowDefinition = {
      name: 'edge-case',
      version: '1.0',
      entry: 'x',
      config: {
        loopEnabled: true,
        maxIterations: 5,
        parallel_limit: null,
        timeout: null,
        debug: false,
        strict: false,
      },
      nodes: [
        { id: 'x', type: 'agent', config: { loop_guard: null as unknown as LoopGuardConfig } },
      ],
      edges: [],
      inputs: {},
      outputs: [],
      metadata: { tags: [] },
    };
    const dag = new DAGManager(wf, { allowCycles: true });

    expect(dag.getLoopGuard('x')).toBeUndefined();
  });
});
