import { describe, expect, it } from 'bun:test';
import {
  prescanWorkflow,
  prescanWorkflowFile,
  type PrescanResult,
} from './dependency-prescan';
import type { WorkflowDefinition } from '../types';

describe('dependency-prescan', () => {
  function buildWf(partial: Partial<WorkflowDefinition>): WorkflowDefinition {
    return {
      name: 'test',
      version: '1.0',
      entry: 'start',
      nodes: [],
      edges: [],
      ...partial,
    } as WorkflowDefinition;
  }

  // RED-1: checkDependsOnNodesExist
  it('RED-1: detects missing node in depends_on', () => {
    const wf = buildWf({
      nodes: [
        {
          id: 'A',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo A' } },
          depends_on: ['X'],
        } as any,
      ],
    });
    const result = prescanWorkflow(wf);
    expect(result.ok).toBe(false);
    expect(
      result.findings.some(
        (f) =>
          f.checkName === 'checkDependsOnNodesExist' && f.severity === 'FAIL'
      )
    ).toBe(true);
  });

  // RED-2: checkEdgesNodesExist
  it('RED-2: detects missing node in edges', () => {
    const wf = buildWf({
      nodes: [
        {
          id: 'A',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo A' } },
          depends_on: [],
        } as any,
      ],
      edges: [{ from: 'Y', to: 'A' }],
    });
    const result = prescanWorkflow(wf);
    expect(result.ok).toBe(false);
    expect(
      result.findings.some((f) => f.checkName === 'checkEdgesNodesExist')
    ).toBe(true);
  });

  // RED-3: checkEdgesDependsOnConsistency — fan-out/fan-in 反模式
  it('RED-3: detects edge→downstream without depends_on declaration', () => {
    // start → A → F; F depends_on=[] (edge triggers F but F doesn't declare A)
    const wf = buildWf({
      nodes: [
        {
          id: 'start',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo s' } },
          depends_on: [],
        } as any,
        {
          id: 'A',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo a' } },
          depends_on: ['start'],
        } as any,
        {
          id: 'F',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo f' } },
          depends_on: [],
        } as any,
      ],
      edges: [
        { from: 'start', to: 'A' },
        { from: 'A', to: 'F' },
      ],
    });
    const result = prescanWorkflow(wf);
    expect(result.ok).toBe(false);
    expect(
      result.findings.some(
        (f) =>
          f.checkName === 'checkEdgesDependsOnConsistency' &&
          f.message.includes('F does not declare depends_on including A')
      )
    ).toBe(true);
  });

  // RED-4: checkEntryNodeExists
  it('RED-4: detects missing entry node', () => {
    const wf = buildWf({
      entry: 'X',
      nodes: [
        {
          id: 'A',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo a' } },
          depends_on: [],
        } as any,
      ],
    });
    const result = prescanWorkflow(wf);
    expect(result.ok).toBe(false);
    expect(
      result.findings.some((f) => f.checkName === 'checkEntryNodeExists')
    ).toBe(true);
  });

  // RED-5: happy path — fan-out-fan-in-demo 兼容
  it('RED-5: happy path — fan-out-fan-in-demo passes prescan', () => {
    const wf = buildWf({
      name: 'fan-out-fan-in-demo',
      entry: 'start',
      nodes: [
        {
          id: 'start',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo s' } },
          depends_on: [],
        } as any,
        {
          id: 'A',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo a' } },
          depends_on: ['start'],
        } as any,
        {
          id: 'B',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo b' } },
          depends_on: ['start'],
        } as any,
        {
          id: 'C',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo c' } },
          depends_on: ['start'],
        } as any,
        {
          id: 'D',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo d' } },
          depends_on: ['start'],
        } as any,
        {
          id: 'F',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo f' } },
          depends_on: ['A', 'B', 'C', 'D'],
        } as any,
      ],
      edges: [
        { from: 'start', to: 'A' },
        { from: 'start', to: 'B' },
        { from: 'start', to: 'C' },
        { from: 'start', to: 'D' },
        { from: 'A', to: 'F' },
        { from: 'B', to: 'F' },
        { from: 'C', to: 'F' },
        { from: 'D', to: 'F' },
      ],
    });
    const result = prescanWorkflow(wf);
    expect(result.ok).toBe(true);
    expect(result.findings.filter((f) => f.severity === 'FAIL')).toHaveLength(0);
  });

  // RED-6: nested fan-in 兼容 (C/D depend on [A,B]; F depends on [C,D])
  it('RED-6: happy path — nested fan-in (multi-stage) passes prescan', () => {
    const wf = buildWf({
      name: 'nested-fan-in',
      entry: 'start',
      nodes: [
        {
          id: 'start',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo s' } },
          depends_on: [],
        } as any,
        {
          id: 'A',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo a' } },
          depends_on: ['start'],
        } as any,
        {
          id: 'B',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo b' } },
          depends_on: ['start'],
        } as any,
        {
          id: 'C',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo c' } },
          depends_on: ['A', 'B'],
        } as any,
        {
          id: 'D',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo d' } },
          depends_on: ['A', 'B'],
        } as any,
        {
          id: 'F',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo f' } },
          depends_on: ['C', 'D'],
        } as any,
      ],
      edges: [
        { from: 'start', to: 'A' },
        { from: 'start', to: 'B' },
        { from: 'A', to: 'C' },
        { from: 'B', to: 'C' },
        { from: 'A', to: 'D' },
        { from: 'B', to: 'D' },
        { from: 'C', to: 'F' },
        { from: 'D', to: 'F' },
      ],
    });
    const result = prescanWorkflow(wf);
    expect(result.ok).toBe(true);
  });

  // Verify real workflow YAML file works
  it('loads fan-out-fan-in-demo.yaml from disk via prescanWorkflowFile', () => {
    const path = require('path') as typeof import('path');
    const yamlPath = path.resolve(
      __dirname,
      '..',
      'examples',
      'fan-out-fan-in-demo.yaml'
    );
    const result: PrescanResult = prescanWorkflowFile(yamlPath);
    expect(result.ok).toBe(true);
    expect(result.findings.filter((f) => f.severity === 'FAIL')).toHaveLength(0);
  });

  // Self-loop edge (source == target): intentional retry, MUST NOT require depends_on
  it('self-loop edge (source==target) is allowed without depends_on', () => {
    const wf = buildWf({
      nodes: [
        {
          id: 'A',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo A' } },
        } as any,
      ],
      edges: [{ from: 'A', to: 'A' }], // self-loop retry
    });
    const result = prescanWorkflow(wf);
    const consistencyFail = result.findings.filter(
      (f) =>
        f.checkName === 'checkEdgesDependsOnConsistency' &&
        f.severity === 'FAIL'
    );
    expect(consistencyFail).toHaveLength(0);
  });

  // Back-edge with FAIL/NEEDS_FIX `when` clause: intentional control-flow
  // loop for re-execution, MUST NOT require depends_on.
  it('back-edge (when clause with FAIL) is allowed without depends_on', () => {
    const wf = buildWf({
      nodes: [
        {
          id: 'plan',
          type: 'agent',
          config: {},
          depends_on: [],
        } as any,
        {
          id: 'tdd',
          type: 'agent',
          config: {},
          depends_on: ['plan'],
        } as any,
        {
          id: 'verify',
          type: 'agent',
          config: {},
          depends_on: ['tdd'],
        } as any,
      ],
      edges: [
        { from: 'plan', to: 'tdd' }, // forward
        { from: 'tdd', to: 'verify' }, // forward
        {
          from: 'verify',
          to: 'tdd',
          when: "{{nodes.verify.verify_status}} == 'FAIL'", // back-edge with control-flow when
        },
      ],
    });
    const result = prescanWorkflow(wf);
    const consistencyFail = result.findings.filter(
      (f) =>
        f.checkName === 'checkEdgesDependsOnConsistency' &&
        f.severity === 'FAIL'
    );
    expect(consistencyFail).toHaveLength(0);
  });

  // Forward edge without depends_on declaration: SHOULD still fail
  it('forward edge without depends_on declaration IS flagged', () => {
    const wf = buildWf({
      nodes: [
        {
          id: 'A',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo A' } },
          depends_on: [],
        } as any,
        {
          id: 'B',
          type: 'tool',
          config: { tool: 'bash', input: { command: 'echo B' } },
          depends_on: [], // B does NOT declare depends_on: ['A']
        } as any,
      ],
      edges: [{ from: 'A', to: 'B' }], // forward edge without depends_on
    });
    const result = prescanWorkflow(wf);
    expect(result.ok).toBe(false);
    const consistencyFail = result.findings.filter(
      (f) =>
        f.checkName === 'checkEdgesDependsOnConsistency' &&
        f.severity === 'FAIL'
    );
    expect(consistencyFail.length).toBeGreaterThan(0);
  });

  // Verify the roy-rd-with-trace.workflow.yaml itself passes (it has back-edges
  // with FAIL/NEEDS_FIX `when` clauses that should be exempted)
  it('roy-rd-with-trace.workflow.yaml passes prescan (back-edges exempted)', () => {
    const path = require('path') as typeof import('path');
    // __dirname = packages/core/src/env/workflow/utils/
    // 6 levels up = project root, then into workflows/
    const yamlPath = path.resolve(
      __dirname,
      '..',
      '..',
      '..',
      '..',
      '..',
      '..',
      'workflows',
      'roy-rd-with-trace.workflow.yaml'
    );
    const result: PrescanResult = prescanWorkflowFile(yamlPath);
    if (!result.ok) {
      console.log('Findings:', JSON.stringify(result.findings, null, 2));
      console.log('YAML path:', yamlPath);
      console.log('Exists:', require('fs').existsSync(yamlPath));
    }
    expect(result.ok).toBe(true);
  });
});