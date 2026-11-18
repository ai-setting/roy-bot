import { describe, it, expect, beforeEach } from 'vitest';
import { Scheduler, SchedulerOptions, SchedulerState } from './scheduler';
import { DAGManager } from './dag-manager';
import type { WorkflowDefinition, NodeDefinition } from '../types';
import type { EdgeDefinition } from '../types/edge';
import { TemplateResolver } from '../utils/template-resolver';

// Helper to create a basic workflow definition
function createWorkflow(nodes: NodeDefinition[], config?: { parallel_limit?: number | null }): WorkflowDefinition {
  return {
    name: 'test-workflow',
    version: '1.0',
    nodes,
    entry: '__default_entry__',
    config: config ? { parallel_limit: config.parallel_limit } : undefined,
  };
}

// Helper to create a node definition
function createNode(id: string, dependsOn: string[] = []): NodeDefinition {
  return {
    id,
    type: 'test',
    depends_on: dependsOn,
  };
}

describe('Scheduler', () => {
  describe('constructor', () => {
    it('should create a Scheduler instance with DAGManager', () => {
      const workflow = createWorkflow([createNode('A')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      expect(scheduler).toBeInstanceOf(Scheduler);
    });

    it('should create scheduler with default options', () => {
      const workflow = createWorkflow([createNode('A')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      expect(scheduler).toBeDefined();
    });

    it('should create scheduler with custom parallel limit', () => {
      const workflow = createWorkflow([createNode('A')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager, { parallelLimit: 2 });
      
      expect(scheduler).toBeInstanceOf(Scheduler);
    });

    it('should support unlimited parallel (null limit)', () => {
      const workflow = createWorkflow([createNode('A')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager, { parallelLimit: null });
      
      expect(scheduler).toBeInstanceOf(Scheduler);
    });
  });

  describe('getReadyNodes()', () => {
    it('should return entry nodes when nothing is completed', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['B']),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      const ready = scheduler.getReadyNodes(new Set());
      expect(ready).toEqual(['A']);
    });

    it('should return next nodes when dependencies are met', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['B']),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      const ready = scheduler.getReadyNodes(new Set(['A']));
      expect(ready).toEqual(['B']);
    });

    it('should return multiple nodes for parallel workflow', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B'),
        createNode('C'),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      const ready = scheduler.getReadyNodes(new Set());
      expect(ready).toHaveLength(3);
      expect(ready).toContain('A');
      expect(ready).toContain('B');
      expect(ready).toContain('C');
    });

    it('should return multiple nodes for diamond workflow after entry completes', () => {
      // Diamond: A -> B -> D, A -> C -> D
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['A']),
        createNode('D', ['B', 'C']),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      // After A is done, B and C should be ready
      const readyAfterA = scheduler.getReadyNodes(new Set(['A']));
      expect(readyAfterA).toContain('B');
      expect(readyAfterA).toContain('C');
    });

    it('should return empty array when all nodes are completed', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      const ready = scheduler.getReadyNodes(new Set(['A', 'B']));
      expect(ready).toEqual([]);
    });

    it('should not return already running nodes', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B'),
        createNode('C'),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      // Mark A as running
      scheduler.markStarted('A');
      
      const ready = scheduler.getReadyNodes(new Set());
      expect(ready).not.toContain('A');
      expect(ready).toContain('B');
      expect(ready).toContain('C');
    });

    it('should not return completed nodes', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B'),
        createNode('C'),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      // Mark A as completed
      scheduler.markCompleted('A');
      
      const ready = scheduler.getReadyNodes(new Set());
      expect(ready).not.toContain('A');
      expect(ready).toContain('B');
      expect(ready).toContain('C');
    });
  });

  describe('getRunningCount()', () => {
    it('should return 0 initially', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      expect(scheduler.getRunningCount()).toBe(0);
    });

    it('should return correct count after marking nodes as started', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B'), createNode('C')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      scheduler.markStarted('A');
      expect(scheduler.getRunningCount()).toBe(1);
      
      scheduler.markStarted('B');
      expect(scheduler.getRunningCount()).toBe(2);
    });

    it('should return correct count after completing nodes', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      scheduler.markStarted('A');
      scheduler.markStarted('B');
      expect(scheduler.getRunningCount()).toBe(2);
      
      scheduler.markCompleted('A');
      expect(scheduler.getRunningCount()).toBe(1);
    });
  });

  describe('canStartMore()', () => {
    it('should return true when under parallel limit', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager, { parallelLimit: 3 });
      
      scheduler.markStarted('A');
      scheduler.markStarted('B');
      
      expect(scheduler.canStartMore()).toBe(true);
    });

    it('should return false when at parallel limit', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B'), createNode('C')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager, { parallelLimit: 2 });
      
      scheduler.markStarted('A');
      scheduler.markStarted('B');
      
      expect(scheduler.canStartMore()).toBe(false);
    });

    it('should return true when parallel limit is null (unlimited)', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B'),
        createNode('C'),
        createNode('D'),
        createNode('E'),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager, { parallelLimit: null });
      
      // Start many nodes
      scheduler.markStarted('A');
      scheduler.markStarted('B');
      scheduler.markStarted('C');
      scheduler.markStarted('D');
      scheduler.markStarted('E');
      
      expect(scheduler.canStartMore()).toBe(true);
    });

    it('should return true when single-threaded and no nodes running', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager, { parallelLimit: 1 });
      
      expect(scheduler.canStartMore()).toBe(true);
    });

    it('should return false when single-threaded and one node running', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager, { parallelLimit: 1 });
      
      scheduler.markStarted('A');
      
      expect(scheduler.canStartMore()).toBe(false);
    });
  });

  describe('markStarted()', () => {
    it('should track running node', () => {
      const workflow = createWorkflow([createNode('A')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      scheduler.markStarted('A');
      
      expect(scheduler.getRunningCount()).toBe(1);
      expect(scheduler.canStartMore()).toBe(false);
    });

    it('should allow starting more when under limit', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B'), createNode('C')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager, { parallelLimit: 3 });
      
      scheduler.markStarted('A');
      scheduler.markStarted('B');
      
      expect(scheduler.canStartMore()).toBe(true);
    });
  });

  describe('markCompleted()', () => {
    it('should remove node from running set', () => {
      const workflow = createWorkflow([createNode('A')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      scheduler.markStarted('A');
      expect(scheduler.getRunningCount()).toBe(1);
      
      scheduler.markCompleted('A');
      expect(scheduler.getRunningCount()).toBe(0);
    });

    it('should allow starting more after completion', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B'), createNode('C')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager, { parallelLimit: 2 });
      
      scheduler.markStarted('A');
      scheduler.markStarted('B');
      expect(scheduler.canStartMore()).toBe(false);
      
      scheduler.markCompleted('A');
      expect(scheduler.canStartMore()).toBe(true);
    });

    it('should handle completing a node that was not started', () => {
      const workflow = createWorkflow([createNode('A')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      // Should not throw
      scheduler.markCompleted('A');
      expect(scheduler.getRunningCount()).toBe(0);
    });
  });

  describe('markFailed()', () => {
    it('should remove node from running set on failure', () => {
      const workflow = createWorkflow([createNode('A')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      scheduler.markStarted('A');
      expect(scheduler.getRunningCount()).toBe(1);
      
      scheduler.markFailed('A');
      expect(scheduler.getRunningCount()).toBe(0);
    });

    it('should track failed nodes in state', () => {
      const workflow = createWorkflow([createNode('A')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      scheduler.markFailed('A');
      
      const state = scheduler.getState();
      expect(state.failed).toContain('A');
    });

    it('should not return failed node in ready nodes', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B', ['A'])]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      scheduler.markFailed('A');
      
      // A should not be ready since it failed
      const ready = scheduler.getReadyNodes(new Set());
      expect(ready).not.toContain('A');
    });
  });

  describe('reset()', () => {
    it('should clear all running, completed, and failed states', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B'), createNode('C')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      // Set up some state
      scheduler.markStarted('A');
      scheduler.markStarted('B');
      scheduler.markCompleted('A');
      scheduler.markFailed('C');
      
      // Reset
      scheduler.reset();
      
      expect(scheduler.getRunningCount()).toBe(0);
      
      const state = scheduler.getState();
      expect(state.running).toHaveLength(0);
      expect(state.completed).toHaveLength(0);
      expect(state.failed).toHaveLength(0);
    });

    it('should allow starting fresh after reset', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager, { parallelLimit: 1 });
      
      scheduler.markStarted('A');
      scheduler.markCompleted('A');
      scheduler.reset();
      
      // Should be able to start again
      scheduler.markStarted('A');
      expect(scheduler.getRunningCount()).toBe(1);
    });
  });

  describe('getState()', () => {
    it('should return current scheduler state', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['A']),
        createNode('D', ['B', 'C']),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      const state = scheduler.getState();
      
      expect(state).toHaveProperty('pending');
      expect(state).toHaveProperty('ready');
      expect(state).toHaveProperty('running');
      expect(state).toHaveProperty('completed');
      expect(state).toHaveProperty('failed');
      expect(state).toHaveProperty('skipped');
    });

    it('should track pending nodes correctly', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B'), createNode('C')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      const state = scheduler.getState();
      
      // All nodes should be pending initially
      expect(state.pending).toHaveLength(3);
      expect(state.pending).toContain('A');
      expect(state.pending).toContain('B');
      expect(state.pending).toContain('C');
    });

    it('should track ready nodes correctly', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B', ['A'])]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      const state = scheduler.getState();
      
      // A should be ready (entry node)
      expect(state.ready).toContain('A');
      // B should not be ready yet (depends on A)
      expect(state.ready).not.toContain('B');
    });

    it('should reflect state changes after operations', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      scheduler.markStarted('A');
      scheduler.markCompleted('A');
      scheduler.markStarted('B');
      
      const state = scheduler.getState();
      
      expect(state.running).toContain('B');
      expect(state.completed).toContain('A');
      expect(state.pending).not.toContain('A');
      expect(state.pending).not.toContain('B');
    });
  });

  describe('parallel execution scenarios', () => {
    it('should respect parallel limit of 2', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B'),
        createNode('C'),
        createNode('D'),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager, { parallelLimit: 2 });
      
      // Start first two nodes
      scheduler.markStarted('A');
      scheduler.markStarted('B');
      
      expect(scheduler.canStartMore()).toBe(false);
      
      // Complete one
      scheduler.markCompleted('A');
      
      expect(scheduler.canStartMore()).toBe(true);
      
      // Start third
      scheduler.markStarted('C');
      expect(scheduler.canStartMore()).toBe(false);
    });

    it('should handle single-threaded execution', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['B']),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager, { parallelLimit: 1 });
      
      // Initially only A is ready
      let ready = scheduler.getReadyNodes(new Set());
      expect(ready).toEqual(['A']);
      
      // Start A
      scheduler.markStarted('A');
      
      // B should not be in ready (A not completed)
      ready = scheduler.getReadyNodes(new Set());
      expect(ready).not.toContain('B');
      
      // Complete A
      scheduler.markCompleted('A');
      
      // Now B should be ready
      ready = scheduler.getReadyNodes(new Set(['A']));
      expect(ready).toEqual(['B']);
      
      scheduler.markStarted('B');
      scheduler.markCompleted('B');
      
      // Now C should be ready
      ready = scheduler.getReadyNodes(new Set(['A', 'B']));
      expect(ready).toEqual(['C']);
    });

    it('should allow unlimited parallel execution', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B'),
        createNode('C'),
        createNode('D'),
        createNode('E'),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager, { parallelLimit: null });
      
      // Start all nodes
      scheduler.markStarted('A');
      scheduler.markStarted('B');
      scheduler.markStarted('C');
      scheduler.markStarted('D');
      scheduler.markStarted('E');
      
      expect(scheduler.canStartMore()).toBe(true);
      expect(scheduler.getRunningCount()).toBe(5);
    });
  });

  describe('complex DAG scenarios', () => {
    it('should handle diamond DAG correctly', () => {
      // Diamond: A -> B -> D, A -> C -> D
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['A']),
        createNode('D', ['B', 'C']),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      // Initially only A is ready
      let ready = scheduler.getReadyNodes(new Set());
      expect(ready).toEqual(['A']);
      
      // Complete A, B and C should be ready
      scheduler.markStarted('A');
      scheduler.markCompleted('A');
      
      ready = scheduler.getReadyNodes(new Set(['A']));
      expect(ready).toContain('B');
      expect(ready).toContain('C');
      
      // Complete B and C, D should be ready
      scheduler.markStarted('B');
      scheduler.markCompleted('B');
      scheduler.markStarted('C');
      scheduler.markCompleted('C');
      
      ready = scheduler.getReadyNodes(new Set(['A', 'B', 'C']));
      expect(ready).toEqual(['D']);
    });

    it('should handle complex DAG with multiple paths', () => {
      // Complex workflow:
      // A -> B -> D
      // A -> C -> E
      // D -> F
      // E -> F
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['A']),
        createNode('D', ['B']),
        createNode('E', ['C']),
        createNode('F', ['D', 'E']),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      // A is ready first
      let ready = scheduler.getReadyNodes(new Set());
      expect(ready).toEqual(['A']);
      
      // Complete A, B and C should be ready
      scheduler.markStarted('A');
      scheduler.markCompleted('A');
      
      ready = scheduler.getReadyNodes(new Set(['A']));
      expect(ready).toContain('B');
      expect(ready).toContain('C');
      
      // Complete B and C
      scheduler.markStarted('B');
      scheduler.markCompleted('B');
      scheduler.markStarted('C');
      scheduler.markCompleted('C');
      
      // D and E should be ready
      ready = scheduler.getReadyNodes(new Set(['A', 'B', 'C']));
      expect(ready).toContain('D');
      expect(ready).toContain('E');
      
      // Complete D and E
      scheduler.markStarted('D');
      scheduler.markCompleted('D');
      scheduler.markStarted('E');
      scheduler.markCompleted('E');
      
      // F should be ready
      ready = scheduler.getReadyNodes(new Set(['A', 'B', 'C', 'D', 'E']));
      expect(ready).toEqual(['F']);
    });

    it('should handle multiple entry nodes', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B'),
        createNode('C', ['A', 'B']),
      ]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      // A and B should be ready
      let ready = scheduler.getReadyNodes(new Set());
      expect(ready).toContain('A');
      expect(ready).toContain('B');
      
      // Complete A only, C should not be ready
      scheduler.markStarted('A');
      scheduler.markCompleted('A');
      
      ready = scheduler.getReadyNodes(new Set(['A']));
      expect(ready).not.toContain('C');
      
      // Complete B, C should now be ready
      scheduler.markStarted('B');
      scheduler.markCompleted('B');
      
      ready = scheduler.getReadyNodes(new Set(['A', 'B']));
      expect(ready).toEqual(['C']);
    });
  });

  describe('edge cases', () => {
    it('should handle single node workflow', () => {
      const workflow = createWorkflow([createNode('A')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      const ready = scheduler.getReadyNodes(new Set());
      expect(ready).toEqual(['A']);
      
      scheduler.markStarted('A');
      expect(scheduler.getRunningCount()).toBe(1);
      
      scheduler.markCompleted('A');
      expect(scheduler.getRunningCount()).toBe(0);
      
      const finalReady = scheduler.getReadyNodes(new Set(['A']));
      expect(finalReady).toEqual([]);
    });

    it('should handle node marked as started multiple times', () => {
      const workflow = createWorkflow([createNode('A')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      // Mark as started multiple times
      scheduler.markStarted('A');
      scheduler.markStarted('A');
      scheduler.markStarted('A');
      
      // Should only count as one
      expect(scheduler.getRunningCount()).toBe(1);
    });

    it('should handle node completion after failure', () => {
      const workflow = createWorkflow([createNode('A')]);
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);
      
      scheduler.markFailed('A');
      scheduler.markCompleted('A');
      
      // Should not throw, running count should be 0
      expect(scheduler.getRunningCount()).toBe(0);
    });
  });

  describe('processEdgesAfterCompletion fan-out/fan-in', () => {
    /**
     * Helper: build a workflow with explicit edges and `depends_on` so the
     * pattern is `{parallel N} → F` with F explicitly listing all parallel
     * upstream nodes in `depends_on`. Mirrors the real bug pattern where
     * edges + depends_on co-exist.
     */
    function buildFanOutFanInWorkflow(
      parallelNodes: string[],
      downstreamId: string,
      upstreamId: string | null = null
    ): WorkflowDefinition {
      const allNodes: NodeDefinition[] = [];
      const edges: EdgeDefinition[] = [];

      if (upstreamId) {
        allNodes.push({ id: upstreamId, type: 'test' });
        for (const n of parallelNodes) {
          allNodes.push({ id: n, type: 'test', depends_on: [upstreamId] });
          edges.push({ from: upstreamId, to: n });
        }
      } else {
        for (const n of parallelNodes) {
          allNodes.push({ id: n, type: 'test' });
        }
      }

      allNodes.push({
        id: downstreamId,
        type: 'test',
        depends_on: [...parallelNodes],
      });

      for (const n of parallelNodes) {
        edges.push({ from: n, to: downstreamId });
      }

      return {
        name: 'fan-out-fan-in-test',
        version: '1.0',
        nodes: allNodes,
        entry: upstreamId || parallelNodes[0],
        edges,
      };
    }

    function makeResolver(): TemplateResolver {
      return new TemplateResolver({ input: {}, previousOutputs: new Map() });
    }

    it('RED-1: 3-parallel fan-in: downstream F must NOT start when only A completes', () => {
      // Pattern: start → {A, B, C} → F (F.depends_on=[A,B,C], edges A→F, B→F, C→F)
      const workflow = buildFanOutFanInWorkflow(['A', 'B', 'C'], 'F');
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);

      // All parallel nodes started, only A has completed
      for (const id of ['A', 'B', 'C']) scheduler.markStarted(id);
      scheduler.markCompleted('A');

      const result = scheduler.processEdgesAfterCompletion(
        'A',
        workflow.edges!,
        makeResolver()
      );

      // F must NOT be in toStart yet — B/C still running
      expect(result.toStart).not.toContain('F');
    });

    it('RED-2: 4-parallel fan-in: downstream F only starts after LAST upstream completes', () => {
      // Pattern: start → {A, B, C, D} → F
      const workflow = buildFanOutFanInWorkflow(['A', 'B', 'C', 'D'], 'F');
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);

      for (const id of ['A', 'B', 'C', 'D']) scheduler.markStarted(id);

      // First three complete — F still not ready
      scheduler.markCompleted('A');
      let result = scheduler.processEdgesAfterCompletion('A', workflow.edges!, makeResolver());
      expect(result.toStart).not.toContain('F');

      scheduler.markCompleted('B');
      result = scheduler.processEdgesAfterCompletion('B', workflow.edges!, makeResolver());
      expect(result.toStart).not.toContain('F');

      scheduler.markCompleted('C');
      result = scheduler.processEdgesAfterCompletion('C', workflow.edges!, makeResolver());
      expect(result.toStart).not.toContain('F');

      // Last one completes — NOW F is ready
      scheduler.markCompleted('D');
      result = scheduler.processEdgesAfterCompletion('D', workflow.edges!, makeResolver());
      expect(result.toStart).toEqual(['F']);
    });

    it('RED-3: nested fan-in: downstream F waits for downstream C+D (both fed by parallel A+B)', () => {
      // Pattern: start → {A, B} → {C, D} → F
      //   F.depends_on = [C, D]
      //   C.depends_on = [A, B];  D.depends_on = [A, B]
      //   edges: A→C, B→C, A→D, B→D, C→F, D→F
      const workflow: WorkflowDefinition = {
        name: 'nested-fan-in-test',
        version: '1.0',
        nodes: [
          { id: 'A', type: 'test' },
          { id: 'B', type: 'test' },
          { id: 'C', type: 'test', depends_on: ['A', 'B'] },
          { id: 'D', type: 'test', depends_on: ['A', 'B'] },
          { id: 'F', type: 'test', depends_on: ['C', 'D'] },
        ],
        entry: 'A',
        edges: [
          { from: 'A', to: 'C' },
          { from: 'B', to: 'C' },
          { from: 'A', to: 'D' },
          { from: 'B', to: 'D' },
          { from: 'C', to: 'F' },
          { from: 'D', to: 'F' },
        ],
      };
      const dagManager = new DAGManager(workflow);
      const scheduler = new Scheduler(dagManager);

      // Start A, B; they complete; C starts; C completes before D.
      scheduler.markStarted('A');
      scheduler.markStarted('B');
      scheduler.markCompleted('A');
      scheduler.markCompleted('B');
      scheduler.markStarted('C');
      scheduler.markStarted('D');

      // C completes first — F still waiting on D
      scheduler.markCompleted('C');
      let result = scheduler.processEdgesAfterCompletion(
        'C',
        workflow.edges!,
        makeResolver()
      );
      expect(result.toStart).not.toContain('F');

      // D completes — now F ready
      scheduler.markCompleted('D');
      result = scheduler.processEdgesAfterCompletion(
        'D',
        workflow.edges!,
        makeResolver()
      );
      expect(result.toStart).toEqual(['F']);
    });
  });
});
