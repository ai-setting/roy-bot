import { beforeEach, describe, expect, it } from 'vitest';
import { WorkflowEngine } from './engine';
import { NodeRegistry } from './node-registry';
import type { NodeDefinition, WorkflowDefinition } from '../types';

function createLoopbackWorkflow(): WorkflowDefinition {
  return {
    name: 'loopback-template',
    version: '1.0',
    entry: 'a',
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
        id: 'a',
        type: 'mock-agent',
        config: { prompt: 'a={{nodes.b.severity.blocking}}' },
      },
      {
        id: 'b',
        type: 'mock-agent',
        depends_on: ['a'],
        config: { prompt: 'b={{nodes.a.value}}' },
      },
      {
        id: 'c',
        type: 'mock-agent',
        depends_on: ['b'],
        config: { prompt: 'c={{nodes.a.value}}/{{nodes.b.severity.blocking}}' },
      },
    ],
    edges: [
      { from: 'a', to: 'b', when: "{{nodes.a.status}} == 'PASS'" },
      { from: 'b', to: 'a', when: "{{nodes.b.status}} == 'FAIL'" },
      { from: 'b', to: 'c', when: "{{nodes.b.status}} == 'PASS'" },
    ],
    inputs: {},
    outputs: [],
    metadata: { tags: [] },
  };
}

describe('WorkflowEngine back-edge standard nodes template resolution', () => {
  let aAttempts: number;
  let bAttempts: number;
  let aPrompts: string[];
  let bPrompts: string[];
  let cPrompts: string[];

  beforeEach(() => {
    aAttempts = 0;
    bAttempts = 0;
    aPrompts = [];
    bPrompts = [];
    cPrompts = [];
  });

  it('preserves back-edge source output for nodes.* templates after re-entry', async () => {
    const registry = new NodeRegistry();
    registry.register('mock-agent', (definition: NodeDefinition) => ({
      id: definition.id,
      type: definition.type,
      execute: async (ctx: any) => {
        const prompt = String(ctx.resolvedConfig?.prompt ?? '');
        if (definition.id === 'a') {
          aAttempts += 1;
          aPrompts.push(prompt);
          return { output: { status: 'PASS', value: aAttempts === 1 ? 'X' : 'Y' } };
        }
        if (definition.id === 'b') {
          bAttempts += 1;
          bPrompts.push(prompt);
          if (bAttempts === 1) {
            return {
              output: {
                status: 'FAIL',
                severity: { blocking: ['fix X'] },
              },
            };
          }
          return {
            output: {
              status: 'PASS',
              // A passing review still reports the finding it evaluated. This
              // lets c assert standard nodes.* resolution, while a's second
              // prompt proves the first source output survived re-entry.
              severity: { blocking: ['fix X'] },
            },
          };
        }

        cPrompts.push(prompt);
        return { output: { status: 'PASS' } };
      },
    }));

    const engine = new WorkflowEngine(registry);
    const result = await engine.runWorkflow(createLoopbackWorkflow());

    expect(result.status).toBe('completed');
    expect(aAttempts).toBe(2);
    expect(bAttempts).toBe(2);
    expect(cPrompts).toEqual(['c=Y/["fix X"]']);

    // On re-entry, a executes before b has produced its second output. The
    // first b output must therefore remain in the standard node output map.
    expect(aPrompts[1]).toBe('a=["fix X"]');
    expect(bPrompts).toEqual(['b=X', 'b=Y']);
  });
});
