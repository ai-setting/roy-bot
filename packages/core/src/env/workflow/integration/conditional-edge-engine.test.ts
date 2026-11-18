/**
 * WorkflowEngine E2E tests for conditional edges and loop mode
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WorkflowEngine } from '../engine/engine';
import { NodeRegistry } from '../engine/node-registry';
import type { NodeDefinition, WorkflowDefinition } from '../types';

function createPeVWorkflow(): WorkflowDefinition {
  return {
    name: 'pev-loop',
    version: '1.0',
    entry: 'plan',
    config: {
      loopEnabled: true,
      maxIterations: 5,
      parallel_limit: null,
    },
    nodes: [
      { id: 'plan', type: 'mock', config: {} },
      { id: 'execute', type: 'mock', depends_on: ['plan'], config: {} },
      { id: 'verify', type: 'mock', depends_on: ['execute'], config: {} },
    ],
    edges: [
      { from: 'verify', to: 'plan', when: '{{nodes.verify.passed}} == false' },
      { from: 'verify', to: '__end__', when: '{{nodes.verify.passed}} == true' },
    ],
  };
}

function createBranchWorkflow(): WorkflowDefinition {
  return {
    name: 'conditional-branch',
    version: '1.0',
    entry: 'check',
    config: {
      parallel_limit: null,
    },
    nodes: [
      { id: 'check', type: 'mock', config: {} },
      { id: 'path-a', type: 'mock', depends_on: ['check'], config: {} },
      { id: 'path-b', type: 'mock', depends_on: ['check'], config: {} },
    ],
    edges: [
      { from: 'check', to: 'path-a', when: '{{nodes.check.choice}} == "a"' },
      { from: 'check', to: 'path-b', when: '{{nodes.check.choice}} == "b"' },
    ],
  };
}

describe('WorkflowEngine Conditional Edge E2E', () => {
  let engine: WorkflowEngine;
  let executionCounts: Map<string, number>;
  let verifyAttempts: number;

  beforeEach(() => {
    executionCounts = new Map();
    verifyAttempts = 0;

    const registry = new NodeRegistry();
    registry.register('mock', (definition: NodeDefinition) => ({
      id: definition.id,
      type: definition.type,
      execute: async () => {
        executionCounts.set(definition.id, (executionCounts.get(definition.id) || 0) + 1);

        if (definition.id === 'check') {
          return { output: { choice: 'a' } };
        }

        if (definition.id === 'verify') {
          verifyAttempts++;
          const passed = verifyAttempts >= 2;
          return { output: { passed } };
        }

        return { output: { ok: true } };
      },
    }));

    engine = new WorkflowEngine(registry);
  });

  afterEach(() => {
    executionCounts.clear();
  });

  it('should run conditional branch and skip false path', async () => {
    const result = await engine.runWorkflow(createBranchWorkflow(), {
      input: { mode: 'test' },
    });

    expect(result.status).toBe('completed');
    expect(executionCounts.get('check')).toBe(1);
    expect(executionCounts.get('path-a')).toBe(1);
    expect(executionCounts.get('path-b')).toBeUndefined();
  });

  it('should enforce maxIterations when verify never passes', async () => {
    const alwaysFailWorkflow: WorkflowDefinition = {
      ...createPeVWorkflow(),
      config: {
        loopEnabled: true,
        maxIterations: 3,
        parallel_limit: null,
      },
    };

    const registry = new NodeRegistry();
    registry.register('mock', (definition: NodeDefinition) => ({
      id: definition.id,
      type: definition.type,
      execute: async () => {
        executionCounts.set(definition.id, (executionCounts.get(definition.id) || 0) + 1);
        if (definition.id === 'verify') {
          return { output: { passed: false } };
        }
        return { output: { ok: true } };
      },
    }));
    engine = new WorkflowEngine(registry);

    const result = await engine.runWorkflow(alwaysFailWorkflow);

    expect(result.status).toBe('failed');
    // 1 initial run + maxIterations re-entries
    expect(executionCounts.get('plan')).toBe(4);
    expect(executionCounts.get('verify')).toBe(4);
  });

  it('should complete PEV loop and terminate via __end__', async () => {
    const result = await engine.runWorkflow(createPeVWorkflow());

    expect(result.status).toBe('completed');
    expect(executionCounts.get('plan')).toBe(2);
    expect(executionCounts.get('execute')).toBe(2);
    expect(executionCounts.get('verify')).toBe(2);
    expect(verifyAttempts).toBe(2);
  });

  it('should wire workflowInput into edge condition evaluation', async () => {
    const workflow: WorkflowDefinition = {
      name: 'input-branch',
      version: '1.0',
      entry: 'check',
      config: { parallel_limit: null },
      nodes: [
        { id: 'check', type: 'mock', config: {} },
        { id: 'high', type: 'mock', depends_on: ['check'], config: {} },
        { id: 'low', type: 'mock', depends_on: ['check'], config: {} },
      ],
      edges: [
        { from: 'check', to: 'high', when: '{{input.threshold}} > 5' },
        { from: 'check', to: 'low', when: '{{input.threshold}} <= 5' },
      ],
    };

    const registry = new NodeRegistry();
    registry.register('mock', (definition: NodeDefinition) => ({
      id: definition.id,
      execute: async () => {
        executionCounts.set(definition.id, (executionCounts.get(definition.id) || 0) + 1);
        return { output: {} };
      },
    }));
    engine = new WorkflowEngine(registry);

    const result = await engine.runWorkflow(workflow, {
      input: { threshold: 10 },
    });

    expect(result.status).toBe('completed');
    expect(executionCounts.get('high')).toBe(1);
    expect(executionCounts.get('low')).toBeUndefined();
  });
});
