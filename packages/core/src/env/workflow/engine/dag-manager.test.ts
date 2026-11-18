import { describe, it, expect, beforeEach } from 'vitest';
import { DAGManager, DAGAnalysis } from './dag-manager';
import type { WorkflowDefinition, NodeDefinition } from '../types';

// Helper to create a basic workflow definition
function createWorkflow(nodes: NodeDefinition[], name = 'test-workflow'): WorkflowDefinition {
  return {
    name,
    version: '1.0',
    nodes,
    entry: '__default_entry__',
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

describe('DAGManager', () => {
  describe('constructor', () => {
    it('should create a DAGManager instance', () => {
      const workflow = createWorkflow([createNode('A')]);
      const manager = new DAGManager(workflow);
      expect(manager).toBeInstanceOf(DAGManager);
    });

    it('should throw error for empty workflow', () => {
      const workflow = createWorkflow([]);
      expect(() => new DAGManager(workflow)).toThrow('At least one node is required');
    });
  });

  describe('getExtendedDefinition()', () => {
    it('should return extended definition with computed entry nodes', () => {
      const workflow = createWorkflow([createNode('A'), createNode('B', ['A'])]);
      const manager = new DAGManager(workflow);
      const extended = manager.getExtendedDefinition();
      
      expect(extended.computedEntry).toContain('A');
      expect(extended.nodeMap.has('A')).toBe(true);
      expect(extended.nodeMap.has('B')).toBe(true);
    });

    it('should compute entry nodes as nodes without dependencies', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B'),
        createNode('C', ['A']),
      ]);
      const manager = new DAGManager(workflow);
      const extended = manager.getExtendedDefinition();
      
      // A and B are entry nodes (no dependencies)
      expect(extended.computedEntry).toHaveLength(2);
      expect(extended.computedEntry).toContain('A');
      expect(extended.computedEntry).toContain('B');
    });

    it('should include topological order in extended definition', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['B']),
      ]);
      const manager = new DAGManager(workflow);
      const extended = manager.getExtendedDefinition();
      
      expect(extended.topologicalOrder).toHaveLength(3);
      // A should come before B, B should come before C
      const aIdx = extended.topologicalOrder.indexOf('A');
      const bIdx = extended.topologicalOrder.indexOf('B');
      const cIdx = extended.topologicalOrder.indexOf('C');
      expect(aIdx).toBeLessThan(bIdx);
      expect(bIdx).toBeLessThan(cIdx);
    });
  });

  describe('analyze()', () => {
    it('should analyze linear workflow correctly', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['B']),
      ]);
      const manager = new DAGManager(workflow);
      const analysis = manager.analyze();
      
      // Entry nodes: A (no dependencies)
      expect(analysis.entryNodes).toEqual(['A']);
      
      // Exit nodes: C (no dependents)
      expect(analysis.exitNodes).toEqual(['C']);
      
      // Levels: A at level 0, B at level 1, C at level 2
      expect(analysis.levels).toHaveLength(3);
      expect(analysis.levels[0]).toContain('A');
      expect(analysis.levels[1]).toContain('B');
      expect(analysis.levels[2]).toContain('C');
      
      // Dependencies
      expect(analysis.dependencies.get('A')).toEqual([]);
      expect(analysis.dependencies.get('B')).toEqual(['A']);
      expect(analysis.dependencies.get('C')).toEqual(['B']);
      
      // Dependents
      expect(analysis.dependents.get('A')).toContain('B');
      expect(analysis.dependents.get('B')).toContain('C');
      expect(analysis.dependents.get('C')).toEqual([]);
    });

    it('should analyze parallel workflow correctly', () => {
      // A, B, C all start at the same time (no dependencies)
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B'),
        createNode('C'),
      ]);
      const manager = new DAGManager(workflow);
      const analysis = manager.analyze();
      
      // All are entry nodes
      expect(analysis.entryNodes).toHaveLength(3);
      
      // All are exit nodes (no dependents)
      expect(analysis.exitNodes).toHaveLength(3);
      
      // All at level 0 (can execute in parallel)
      expect(analysis.levels).toHaveLength(1);
      expect(analysis.levels[0]).toContain('A');
      expect(analysis.levels[0]).toContain('B');
      expect(analysis.levels[0]).toContain('C');
    });

    it('should analyze diamond workflow correctly', () => {
      // Diamond: A -> B -> D, A -> C -> D
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['A']),
        createNode('D', ['B', 'C']),
      ]);
      const manager = new DAGManager(workflow);
      const analysis = manager.analyze();
      
      // Entry: A
      expect(analysis.entryNodes).toEqual(['A']);
      
      // Exit: D
      expect(analysis.exitNodes).toEqual(['D']);
      
      // Levels: A at 0, B and C at 1, D at 2
      expect(analysis.levels).toHaveLength(3);
      expect(analysis.levels[0]).toContain('A');
      expect(analysis.levels[1]).toContain('B');
      expect(analysis.levels[1]).toContain('C');
      expect(analysis.levels[2]).toContain('D');
      
      // D depends on both B and C
      expect(analysis.dependencies.get('D')).toEqual(['B', 'C']);
      
      // B and C depend on A
      expect(analysis.dependents.get('A')).toContain('B');
      expect(analysis.dependents.get('A')).toContain('C');
    });

    it('should analyze complex workflow correctly', () => {
      // Complex: 
      // A -> B -> D
      // A -> C -> E
      // B -> F
      // C -> F
      // D -> G
      // E -> G
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['A']),
        createNode('D', ['B']),
        createNode('E', ['C']),
        createNode('F', ['B', 'C']),
        createNode('G', ['D', 'E']),
      ]);
      const manager = new DAGManager(workflow);
      const analysis = manager.analyze();
      
      // Entry: A
      expect(analysis.entryNodes).toEqual(['A']);
      
      // Exit: F, G
      expect(analysis.exitNodes).toContain('F');
      expect(analysis.exitNodes).toContain('G');
      
      // Levels should be computed
      expect(analysis.levels[0]).toContain('A');
    });

    it('should identify critical path', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['B']),
      ]);
      const manager = new DAGManager(workflow);
      const analysis = manager.analyze();
      
      expect(analysis.criticalPath).toBeDefined();
      expect(analysis.criticalPath.length).toBeGreaterThan(0);
    });
  });

  describe('getTopologicalOrder()', () => {
    it('should return nodes in topological order for linear workflow', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['B']),
      ]);
      const manager = new DAGManager(workflow);
      const order = manager.getTopologicalOrder();
      
      expect(order).toHaveLength(3);
      const aIdx = order.indexOf('A');
      const bIdx = order.indexOf('B');
      const cIdx = order.indexOf('C');
      expect(aIdx).toBeLessThan(bIdx);
      expect(bIdx).toBeLessThan(cIdx);
    });

    it('should handle parallel nodes in topological order', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B'),
        createNode('C'),
      ]);
      const manager = new DAGManager(workflow);
      const order = manager.getTopologicalOrder();
      
      expect(order).toHaveLength(3);
      expect(order).toContain('A');
      expect(order).toContain('B');
      expect(order).toContain('C');
    });

    it('should handle diamond shape in topological order', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['A']),
        createNode('D', ['B', 'C']),
      ]);
      const manager = new DAGManager(workflow);
      const order = manager.getTopologicalOrder();
      
      expect(order).toHaveLength(4);
      const aIdx = order.indexOf('A');
      const bIdx = order.indexOf('B');
      const cIdx = order.indexOf('C');
      const dIdx = order.indexOf('D');
      
      // A should be before B, C
      expect(aIdx).toBeLessThan(bIdx);
      expect(aIdx).toBeLessThan(cIdx);
      // B and C should be before D
      expect(bIdx).toBeLessThan(dIdx);
      expect(cIdx).toBeLessThan(dIdx);
    });
  });

  describe('getReadyNodes()', () => {
    it('should return entry nodes when nothing is completed', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['B']),
      ]);
      const manager = new DAGManager(workflow);
      const ready = manager.getReadyNodes(new Set());
      
      expect(ready).toEqual(['A']);
    });

    it('should return next nodes when dependencies are met', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['B']),
      ]);
      const manager = new DAGManager(workflow);
      const ready = manager.getReadyNodes(new Set(['A']));
      
      expect(ready).toEqual(['B']);
    });

    it('should return multiple nodes when parallel dependencies are met', () => {
      // Diamond: A -> B -> D, A -> C -> D
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['A']),
        createNode('D', ['B', 'C']),
      ]);
      const manager = new DAGManager(workflow);
      
      // After A is done, B and C should be ready
      const readyAfterA = manager.getReadyNodes(new Set(['A']));
      expect(readyAfterA).toContain('B');
      expect(readyAfterA).toContain('C');
      
      // After B and C are done, D should be ready
      const readyAfterBC = manager.getReadyNodes(new Set(['A', 'B', 'C']));
      expect(readyAfterBC).toEqual(['D']);
    });

    it('should return empty array when workflow is complete', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
      ]);
      const manager = new DAGManager(workflow);
      const ready = manager.getReadyNodes(new Set(['A', 'B']));
      
      expect(ready).toEqual([]);
    });

    it('should return all ready nodes for parallel workflow', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B'),
        createNode('C'),
      ]);
      const manager = new DAGManager(workflow);
      const ready = manager.getReadyNodes(new Set());
      
      expect(ready).toHaveLength(3);
      expect(ready).toContain('A');
      expect(ready).toContain('B');
      expect(ready).toContain('C');
    });
  });

  describe('areDependenciesMet()', () => {
    it('should return true when node has no dependencies', () => {
      const workflow = createWorkflow([createNode('A')]);
      const manager = new DAGManager(workflow);
      
      expect(manager.areDependenciesMet('A', new Set())).toBe(true);
    });

    it('should return true when all dependencies are completed', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
      ]);
      const manager = new DAGManager(workflow);
      
      expect(manager.areDependenciesMet('B', new Set(['A']))).toBe(true);
    });

    it('should return false when some dependencies are not completed', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['A']),
      ]);
      const manager = new DAGManager(workflow);
      
      expect(manager.areDependenciesMet('C', new Set(['B']))).toBe(false);
    });

    it('should handle multiple dependencies', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['A']),
        createNode('D', ['B', 'C']),
      ]);
      const manager = new DAGManager(workflow);
      
      expect(manager.areDependenciesMet('D', new Set(['A', 'B']))).toBe(false);
      expect(manager.areDependenciesMet('D', new Set(['A', 'B', 'C']))).toBe(true);
    });
  });

  describe('isCyclic()', () => {
    it('should return false for linear workflow', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['B']),
      ]);
      const manager = new DAGManager(workflow);
      
      expect(manager.isCyclic()).toBe(false);
    });

    it('should return false for diamond workflow', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['A']),
        createNode('D', ['B', 'C']),
      ]);
      const manager = new DAGManager(workflow);
      
      expect(manager.isCyclic()).toBe(false);
    });

    it('should return true when cycle exists (A -> B -> C -> A)', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['B']),
        // Add a dependency that creates a cycle (C -> A)
      ], 'cycle-workflow');
      
      // Create a custom workflow with cycle for testing
      const cycleWorkflow: WorkflowDefinition = {
        name: 'cycle-workflow',
        version: '1.0',
        nodes: [
          { id: 'A', type: 'test', depends_on: ['C'] }, // C -> A
          { id: 'B', type: 'test', depends_on: ['A'] }, // A -> B
          { id: 'C', type: 'test', depends_on: ['B'] }, // B -> C
        ],
      };
      const manager = new DAGManager(cycleWorkflow);
      
      expect(manager.isCyclic()).toBe(true);
    });

    it('should return true for self-referencing node', () => {
      const workflow: WorkflowDefinition = {
        name: 'self-ref',
        version: '1.0',
        nodes: [
          { id: 'A', type: 'test', depends_on: ['A'] },
        ],
      };
      const manager = new DAGManager(workflow);
      
      expect(manager.isCyclic()).toBe(true);
    });
  });

  describe('validate()', () => {
    it('should return valid for correct workflow', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B', ['A']),
        createNode('C', ['B']),
      ]);
      const manager = new DAGManager(workflow);
      const result = manager.validate();
      
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing dependency reference', () => {
      const workflow: WorkflowDefinition = {
        name: 'invalid',
        version: '1.0',
        nodes: [
          { id: 'A', type: 'test' },
          { id: 'B', type: 'test', depends_on: ['nonexistent'] },
        ],
      };
      const manager = new DAGManager(workflow);
      const result = manager.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('nonexistent'))).toBe(true);
    });

    it('should detect cycle in workflow', () => {
      const workflow: WorkflowDefinition = {
        name: 'cycle',
        version: '1.0',
        nodes: [
          { id: 'A', type: 'test', depends_on: ['C'] },
          { id: 'B', type: 'test', depends_on: ['A'] },
          { id: 'C', type: 'test', depends_on: ['B'] },
        ],
      };
      const manager = new DAGManager(workflow);
      const result = manager.validate();
      
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.toLowerCase().includes('cycle'))).toBe(true);
    });

    it('should detect duplicate node IDs', () => {
      const workflow: WorkflowDefinition = {
        name: 'duplicate',
        version: '1.0',
        nodes: [
          { id: 'A', type: 'test' },
          { id: 'A', type: 'test' }, // duplicate
        ],
      };
      // Constructor should throw for duplicate IDs
      expect(() => new DAGManager(workflow)).toThrow('Duplicate node ID');
    });

    it('should detect empty node ID', () => {
      const workflow: WorkflowDefinition = {
        name: 'empty-id',
        version: '1.0',
        nodes: [
          { id: '', type: 'test' },
        ],
      };
      
      // Constructor should throw for empty node ID
      expect(() => new DAGManager(workflow)).toThrow('Node ID cannot be empty');
    });
  });

  describe('edge cases', () => {
    it('should handle single node workflow', () => {
      const workflow = createWorkflow([createNode('A')]);
      const manager = new DAGManager(workflow);
      
      expect(manager.analyze().entryNodes).toEqual(['A']);
      expect(manager.analyze().exitNodes).toEqual(['A']);
      expect(manager.analyze().levels).toHaveLength(1);
      expect(manager.getTopologicalOrder()).toEqual(['A']);
      expect(manager.getReadyNodes(new Set())).toEqual(['A']);
      expect(manager.getReadyNodes(new Set(['A']))).toEqual([]);
    });

    it('should handle workflow with multiple entry nodes', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B'),
        createNode('C', ['A', 'B']),
      ]);
      const manager = new DAGManager(workflow);
      const analysis = manager.analyze();
      
      expect(analysis.entryNodes).toContain('A');
      expect(analysis.entryNodes).toContain('B');
      expect(analysis.exitNodes).toContain('C');
    });

    it('should handle nodes with many dependencies', () => {
      const workflow = createWorkflow([
        createNode('A'),
        createNode('B'),
        createNode('C'),
        createNode('D'),
        createNode('E', ['A', 'B', 'C', 'D']),
      ]);
      const manager = new DAGManager(workflow);
      const analysis = manager.analyze();
      
      expect(analysis.dependencies.get('E')).toEqual(['A', 'B', 'C', 'D']);
      expect(analysis.levels[0]).toContain('A');
      expect(analysis.levels[0]).toContain('B');
      expect(analysis.levels[0]).toContain('C');
      expect(analysis.levels[0]).toContain('D');
      expect(analysis.levels[1]).toContain('E');
    });
  });
});
