/**
 * Task #4604 (F1) — RED tests: `parseNodeOutputs` must restore the REAL node
 * output, not the human-readable display summary.
 *
 * `Executor.writeNodeEnd()` writes TWO things per terminal message:
 *   - `content`  : `summarizeResult(...)` — a summary for display,
 *                  e.g. `"✅ build-ta-cp312: wheel_path, tag, build_id (812345ms)"`
 *   - `parts[0]` : a `workflow-node-end` part carrying the real `output`.
 *
 * Restoring `content` means downstream `{{nodes.X.output.field}}` templates
 * resolve to `undefined` (object outputs degrade to just a key list, long
 * strings get truncated with `...`) — i.e. a resumed run silently loses data.
 *
 * Pre-existing defect (identical on main), but D3-a makes MORE nodes take this
 * path, so it must be fixed for `--session` resume to be trustworthy end-to-end.
 */
import { describe, test, expect } from 'bun:test';
import { parseNodeOutputs } from './session-recovery';
import type { SessionMessage } from '../../session/types';

/** Build a workflow.node.end message shaped exactly like Executor.writeNodeEnd. */
function endMessage(
  nodeId: string,
  output: unknown,
  opts: { content?: string; withPart?: boolean } = {}
): SessionMessage {
  const { content, withPart = true } = opts;
  return {
    id: `m-${nodeId}`,
    sessionID: 's1',
    role: 'workflow.node.end' as SessionMessage['role'],
    content: content ?? `✅ ${nodeId}: summary-only (100ms)`,
    timestamp: Date.now(),
    parts: withPart
      ? ([
          {
            type: 'workflow-node-end',
            nodeId,
            nodeType: 'tool',
            output,
            durationMs: 100,
          },
        ] as unknown as SessionMessage['parts'])
      : undefined,
    metadata: {
      type: 'workflow.node.end',
      workflowNodeId: nodeId,
      nodeId,
      success: true,
    } as SessionMessage['metadata'],
  } as SessionMessage;
}

function startMessage(nodeId: string): SessionMessage {
  return {
    id: `m-${nodeId}-start`,
    sessionID: 's1',
    role: 'workflow.node.start' as SessionMessage['role'],
    content: '',
    timestamp: Date.now(),
    metadata: {
      type: 'workflow.node.start',
      workflowNodeId: nodeId,
      nodeId,
    } as SessionMessage['metadata'],
  } as SessionMessage;
}

describe('Task #4604 F1 — parseNodeOutputs restores the REAL output, not the display summary', () => {
  test('RED-F1-1: object output is restored from parts, not degraded to a key list', () => {
    const real = { wheel_path: '/x/example-2.7.55-cp312.whl', tag: 'cp312', build_id: 812345 };
    const outputs = parseNodeOutputs([
      startMessage('build-ta-cp312'),
      endMessage('build-ta-cp312', real),
    ]);

    const got = outputs.get('build-ta-cp312');
    // Must be the real object, NOT "✅ build-ta-cp312: wheel_path, tag, build_id (100ms)"
    expect(typeof got).toBe('object');
    expect(got).toEqual(real);
    expect((got as Record<string, unknown>).wheel_path).toBe('/x/example-2.7.55-cp312.whl');
  });

  test('RED-F1-2: long string output is NOT truncated with an ellipsis', () => {
    const real = 'A'.repeat(500);
    const outputs = parseNodeOutputs([startMessage('n'), endMessage('n', real)]);
    const got = outputs.get('n');
    expect(got).toBe(real);
    expect(String(got)).not.toContain('...');
  });

  test('RED-F1-3: a structured object survives a resume round-trip (downstream template can read a field)', () => {
    const real = { outer: { inner: [1, 2, 3] } };
    const outputs = parseNodeOutputs([startMessage('n'), endMessage('n', real)]);
    const got = outputs.get('n') as { outer: { inner: number[] } };
    expect(got.outer.inner).toEqual([1, 2, 3]);
  });

  test('RED-F1-4: falls back to legacy JSON.parse(content) when no parts are present', () => {
    // Older sessions may have no `parts` — the legacy contract must still work.
    const json = '{"a":1}';
    const outputs = parseNodeOutputs([
      startMessage('legacy'),
      endMessage('legacy', undefined, { content: json, withPart: false }),
    ]);
    expect(outputs.get('legacy')).toEqual({ a: 1 });
  });

  test('RED-F1-5: falls back to the raw content string when parts are absent and content is not JSON', () => {
    const outputs = parseNodeOutputs([
      startMessage('legacy2'),
      endMessage('legacy2', undefined, { content: 'plain text result', withPart: false }),
    ]);
    expect(outputs.get('legacy2')).toBe('plain text result');
  });

  test('RED-F1-6: an explicitly undefined part.output falls back to content (no data loss)', () => {
    const outputs = parseNodeOutputs([
      startMessage('n'),
      endMessage('n', undefined, { content: '{"fallback":true}' }),
    ]);
    expect(outputs.get('n')).toEqual({ fallback: true });
  });

  test('RED-F1-7: parts-based restore also works for concurrent fan-out nodes', () => {
    const outputs = parseNodeOutputs([
      startMessage('a'),
      startMessage('b'),
      startMessage('c'),
      endMessage('b', { who: 'b' }),
      endMessage('a', { who: 'a' }),
      endMessage('c', { who: 'c' }),
    ]);
    expect((outputs.get('a') as Record<string, unknown>).who).toBe('a');
    expect((outputs.get('b') as Record<string, unknown>).who).toBe('b');
    expect((outputs.get('c') as Record<string, unknown>).who).toBe('c');
  });

  test('RED-F1-8: legacy call/result shape still restores from parts when available', () => {
    const callMsg = {
      id: 'c1', sessionID: 's1', role: 'workflow.node.call' as SessionMessage['role'],
      content: '', timestamp: Date.now(),
      metadata: { type: 'workflow.node.call', workflowNodeId: 'lc', nodeId: 'lc' } as SessionMessage['metadata'],
    } as SessionMessage;
    const resultMsg = {
      id: 'r1', sessionID: 's1', role: 'workflow.node.result' as SessionMessage['role'],
      content: 'summary',
      timestamp: Date.now(),
      parts: [{ type: 'workflow-node-end', nodeId: 'lc', output: { kept: true } }] as unknown as SessionMessage['parts'],
      metadata: { type: 'workflow.node.result', workflowNodeId: 'lc', nodeId: 'lc' } as SessionMessage['metadata'],
    } as SessionMessage;

    const outputs = parseNodeOutputs([callMsg, resultMsg]);
    expect(outputs.get('lc')).toEqual({ kept: true });
  });
});
