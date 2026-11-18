/**
 * Task #4604 — D3: `parseNodeOutputs` must pair node.start/end messages by the
 * END message's own node id, not by a single global "last started node" slot.
 *
 * Real-world failure (Task #4599 §5.4, session
 * `workflow_1793160196641_fallback_ba1m78`):
 *
 *   The workflow fans out 4 build nodes in parallel, so 4 `workflow.node.start`
 *   messages appear back-to-back and the 4 `workflow.node.end` messages arrive
 *   later, in completion order. The old implementation kept ONE
 *   `lastStartNodeId` scalar, which the last start overwrote:
 *
 *     #2 start build-ta-cp312        -> lastStart = build-ta-cp312
 *     #3 start build-ta-cp313        -> lastStart = build-ta-cp313
 *     #4 start build-ontology-cp312  -> lastStart = build-ontology-cp312
 *     #5 start build-ontology-cp313  -> lastStart = build-ontology-cp313
 *     #6 end   build-ontology-cp312  -> outputs[build-ontology-cp313] = ...  WRONG
 *     #7 end   build-ta-cp312        -> lastStart is null -> DROPPED
 *     #8 end   build-ontology-cp313  -> lastStart is null -> DROPPED
 *
 *   => nodeOutputs = { init-folder, build-ontology-cp313 }
 *   => on `--session` resume, 3 finished builds were NOT marked completed
 *      (build-ta-cp312 / build-ta-cp313 / build-ontology-cp312) and were
 *      re-executed: 40+ minutes of wasted rebuilds plus overwritten wheels.
 *
 * Contract after the fix:
 *   - an end/result message contributes the output for ITS OWN node id;
 *   - interleaved concurrent start/end messages all pair correctly;
 *   - a start with no matching end still yields no output (node stays pending);
 *   - an end with no observed start still yields an output (the node is done!).
 */

import { describe, it, expect } from 'bun:test';
import { parseNodeOutputs } from './session-recovery';

interface MockMessage {
  role: string;
  content: string;
  metadata: Record<string, unknown>;
}

function msg(
  type: string,
  nodeId: string,
  content: string,
  extra: Record<string, unknown> = {}
): MockMessage {
  return {
    role: type,
    content,
    metadata: { type, nodeId, workflowNodeId: nodeId, ...extra },
  };
}

describe('Task #4604 D3 — parseNodeOutputs pairs by the END message node id', () => {
  it('RED-D3-1: concurrent starts then interleaved ends all pair correctly', () => {
    // Exact shape of the real 4-way fan-out from the failing session.
    const messages: MockMessage[] = [
      msg('workflow.node.start', 'init-folder', ''),
      msg('workflow.node.end', 'init-folder', '{"ok":"init"}'),
      msg('workflow.node.start', 'build-ta-cp312', ''),
      msg('workflow.node.start', 'build-ta-cp313', ''),
      msg('workflow.node.start', 'build-ontology-cp312', ''),
      msg('workflow.node.start', 'build-ontology-cp313', ''),
      // completion order differs from start order (real docker builds)
      msg('workflow.node.end', 'build-ontology-cp312', '{"ok":"ont312"}'),
      msg('workflow.node.end', 'build-ta-cp312', '{"ok":"ta312"}'),
      msg('workflow.node.end', 'build-ontology-cp313', '{"ok":"ont313"}'),
      msg('workflow.node.end', 'build-ta-cp313', '{"ok":"ta313"}'),
    ];

    const result = parseNodeOutputs(messages as any);

    // EVERY completed node must be present — this is what makes resume correct.
    expect(result.get('init-folder')).toEqual({ ok: 'init' });
    expect(result.get('build-ontology-cp312')).toEqual({ ok: 'ont312' });
    expect(result.get('build-ta-cp312')).toEqual({ ok: 'ta312' });
    expect(result.get('build-ontology-cp313')).toEqual({ ok: 'ont313' });
    expect(result.get('build-ta-cp313')).toEqual({ ok: 'ta313' });
    expect(result.size).toBe(5);
  });

  it('RED-D3-2: no output is attributed to a node that did not end', () => {
    // build-ta-cp313 started but never ended (killed by the 30-min timeout).
    const messages: MockMessage[] = [
      msg('workflow.node.start', 'build-ta-cp312', ''),
      msg('workflow.node.start', 'build-ta-cp313', ''),
      msg('workflow.node.end', 'build-ta-cp312', '{"ok":"ta312"}'),
    ];

    const result = parseNodeOutputs(messages as any);

    expect(result.get('build-ta-cp312')).toEqual({ ok: 'ta312' });
    // Must NOT be marked completed — it never finished.
    expect(result.has('build-ta-cp313')).toBe(false);
    expect(result.size).toBe(1);
  });

  it('RED-D3-3: an end without an observed start still counts (node IS done)', () => {
    // Truncated/compacted session: only the end survives.
    const messages: MockMessage[] = [
      msg('workflow.node.end', 'collect-wheels', '{"collected":6}'),
    ];

    const result = parseNodeOutputs(messages as any);

    expect(result.get('collect-wheels')).toEqual({ collected: 6 });
  });

  it('RED-D3-4: a node that runs, fails, and is retried records the LAST end', () => {
    const messages: MockMessage[] = [
      msg('workflow.node.start', 'flaky', ''),
      msg('workflow.node.end', 'flaky', '{"attempt":1}', { success: false }),
      msg('workflow.node.start', 'flaky', ''),
      msg('workflow.node.end', 'flaky', '{"attempt":2}', { success: true }),
    ];

    const result = parseNodeOutputs(messages as any);

    expect(result.get('flaky')).toEqual({ attempt: 2 });
    expect(result.size).toBe(1);
  });

  it('RED-D3-5: legacy call/result pairing still works (backward compatible)', () => {
    const messages: MockMessage[] = [
      msg('workflow.node.call', 'node_A', '{}'),
      msg('workflow.node.result', 'node_A', '{"output":"result_A"}'),
      msg('workflow.node.call', 'node_B', '{}'),
      msg('workflow.node.result', 'node_B', '{"output":"result_B"}'),
    ];

    const result = parseNodeOutputs(messages as any);

    expect(result.get('node_A')).toEqual({ output: 'result_A' });
    expect(result.get('node_B')).toEqual({ output: 'result_B' });
  });

  it('RED-D3-6: interleaved call/result for different nodes do not cross-pair', () => {
    const messages: MockMessage[] = [
      msg('workflow.node.call', 'A', '{}'),
      msg('workflow.node.call', 'B', '{}'),
      msg('workflow.node.result', 'A', '{"v":"a"}'),
      msg('workflow.node.result', 'B', '{"v":"b"}'),
    ];

    const result = parseNodeOutputs(messages as any);

    expect(result.get('A')).toEqual({ v: 'a' });
    expect(result.get('B')).toEqual({ v: 'b' });
  });

  it('RED-D3-7: non-JSON content is preserved verbatim', () => {
    const messages: MockMessage[] = [
      msg('workflow.node.start', 'node_A', ''),
      msg('workflow.node.end', 'node_A', 'not json'),
    ];

    const result = parseNodeOutputs(messages as any);

    expect(result.get('node_A')).toBe('not json');
  });

  it('RED-D3-8: messages without a node id are ignored, not merged', () => {
    const messages: MockMessage[] = [
      { role: 'user', content: 'hello', metadata: {} },
      msg('workflow.node.start', 'node_A', ''),
      msg('workflow.node.end', 'node_A', '{"ok":1}'),
    ];

    const result = parseNodeOutputs(messages as any);

    expect(result.size).toBe(1);
    expect(result.get('node_A')).toEqual({ ok: 1 });
  });
});
