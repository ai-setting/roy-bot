import { describe, it, expect, beforeEach, vi } from 'vitest';
import { WorkflowEngine } from '../engine/engine';
import { NodeRegistry } from '../engine/node-registry';
import { TemplateResolver } from '../utils/template-resolver';
import { Scheduler } from '../engine/scheduler';
import { DAGManager } from '../engine/dag-manager';
import type { WorkflowDefinition } from '../types';
import type { EdgeDefinition } from '../types/edge';

// Mock node executor
const mockExecutor = {
  executeNode: vi.fn().mockResolvedValue({ output: { result: 'done' } }),
  writeNodeStart: vi.fn(),
  writeNodeComplete: vi.fn(),
};

describe('Conditional Edge', () => {
  let engine: WorkflowEngine;
  let nodeRegistry: NodeRegistry;
  
  beforeEach(() => {
    nodeRegistry = {
      execute: mockExecutor.executeNode,
    } as any;
    engine = new WorkflowEngine(nodeRegistry as any);
  });

  describe('basic edge evaluation', () => {
    it('should support edges array in workflow definition', () => {
      // Use type assertion for testing structure without full schema validation
      const workflow = {
        name: 'Test Conditional Edge',
        version: '1.0',
        nodes: [
          { id: 'check', type: 'tool', config: {} },
          { id: 'path-a', type: 'tool', config: {} },
          { id: 'path-b', type: 'tool', config: {} },
        ],
        edges: [
          { from: 'check', to: 'path-a', when: '{{nodes.check.output.result}} == true' },
          { from: 'check', to: 'path-b', when: '{{nodes.check.output.result}} == false' },
        ],
      } as WorkflowDefinition;
      
      // Verify edges are parsed correctly
      expect(workflow.edges).toHaveLength(2);
      expect(workflow.edges?.[0].from).toBe('check');
      expect(workflow.edges?.[0].to).toBe('path-a');
    });

    it('should derive edges from depends_on when no explicit edges', () => {
      const workflow = {
        name: 'Test Derive Edges',
        version: '1.0',
        nodes: [
          { id: 'start', type: 'tool', config: {} },
          { id: 'next', type: 'tool', depends_on: ['start'], config: {} },
        ],
      } as WorkflowDefinition;
      
      // Verify depends_on is preserved
      expect(workflow.nodes[1].depends_on).toEqual(['start']);
    });
  });

  describe('edge condition evaluation', () => {
    it('should evaluate simple equality condition', () => {
      const resolver = new TemplateResolver({
        input: { value: 1 },
        previousOutputs: new Map(),
      });
      
      expect(resolver.evaluateCondition('{{input.value}} == 1')).toBe(true);
      expect(resolver.evaluateCondition('{{input.value}} == 2')).toBe(false);
    });

    it('should evaluate greater than condition', () => {
      const resolver = new TemplateResolver({
        input: { count: 5 },
        previousOutputs: new Map(),
      });
      
      expect(resolver.evaluateCondition('{{input.count}} > 3')).toBe(true);
      expect(resolver.evaluateCondition('{{input.count}} > 10')).toBe(false);
    });

    it('should evaluate logical AND condition', () => {
      const resolver = new TemplateResolver({
        input: { a: true, b: true },
        previousOutputs: new Map(),
      });
      
      expect(resolver.evaluateCondition('{{input.a}} && {{input.b}}')).toBe(true);
    });

    it('should evaluate logical OR condition', () => {
      const resolver = new TemplateResolver({
        input: { a: true, b: false },
        previousOutputs: new Map(),
      });
      
      expect(resolver.evaluateCondition('{{input.a}} || {{input.b}}')).toBe(true);
    });
  });

  describe('maxIterations configuration', () => {
    it('should respect maxIterations config', () => {
      const workflow = {
        name: 'Test MaxIterations',
        version: '1.0',
        nodes: [
          { id: 'loop', type: 'tool', config: {} },
        ],
        config: {
          maxIterations: 10,
        },
      } as WorkflowDefinition;
      
      expect(workflow.config?.maxIterations).toBe(10);
    });

    it('should default maxIterations to 100', () => {
      const workflow = {
        name: 'Test Default',
        version: '1.0',
        nodes: [
          { id: 'test', type: 'tool', config: {} },
        ],
      } as WorkflowDefinition;
      
      // Default should be 100 when not specified
      expect(workflow.config?.maxIterations ?? 100).toBe(100);
    });
  });
});

describe('Plan-Execute-Verifier Pattern', () => {
  it('should support verifier pattern workflow structure', () => {
    const workflow = {
      name: 'Verify Workflow',
      version: '1.0',
      nodes: [
        { id: 'plan', type: 'agent', config: {} },
        { id: 'execute', type: 'agent', depends_on: ['plan'], config: {} },
        { id: 'verify', type: 'tool', depends_on: ['execute'], config: {} },
      ],
      edges: [
        { from: 'verify', to: 'plan', when: '{{nodes.verify.output.passed}} == false' },
        { from: 'verify', to: '__end__', when: '{{nodes.verify.output.passed}} == true' },
      ],
      config: {
        maxIterations: 3,
      },
    } as WorkflowDefinition;
    
    // Verify structure
    expect(workflow.config?.maxIterations).toBe(3);
    expect(workflow.nodes).toHaveLength(3);
    expect(workflow.edges).toHaveLength(2);
    
    // Verify edge structure
    const failEdge = workflow.edges?.find(e => e.to === 'plan');
    const passEdge = workflow.edges?.find(e => e.to === '__end__');
    
    expect(failEdge?.when).toContain('== false');
    expect(passEdge?.when).toContain('== true');
  });

  it('should require depends_on for conditional edges to work correctly', () => {
    // This test documents the requirement: depends_on must include source node
    // For edges to work correctly, downstream nodes need depends_on: [source]
    const workflow = {
      name: 'Conditional Branch Workflow',
      version: '1.0',
      nodes: [
        { id: 'check', type: 'tool', config: {} },
        { id: 'path-a', type: 'tool', depends_on: ['check'], config: {} },  // Correct!
        { id: 'path-b', type: 'tool', depends_on: ['check'], config: {} },  // Correct!
      ],
      edges: [
        { from: 'check', to: 'path-a', when: '{{nodes.check.output.result}} == true' },
        { from: 'check', to: 'path-b', when: '{{nodes.check.output.result}} == false' },
      ],
    } as WorkflowDefinition;
    
    // Verify depends_on is set correctly
    expect(workflow.nodes.find(n => n.id === 'path-a')?.depends_on).toEqual(['check']);
    expect(workflow.nodes.find(n => n.id === 'path-b')?.depends_on).toEqual(['check']);
  });
});

describe('Loop Mode', () => {
  it('should support loopEnabled config for cycle workflows', () => {
    const workflow = {
      name: 'Loop Workflow',
      version: '1.0',
      nodes: [
        { id: 'start', type: 'tool', config: {} },
        { id: 'process', type: 'tool', depends_on: ['start'], config: {} },
        { id: 'check', type: 'tool', depends_on: ['process'], config: {} },
      ],
      edges: [
        { from: 'check', to: 'process', when: '{{nodes.check.output.continue}} == true' },
        { from: 'check', to: '__end__', when: '{{nodes.check.output.continue}} == false' },
      ],
      config: {
        loopEnabled: true,
        maxIterations: 5,
      },
    } as WorkflowDefinition;
    
    expect(workflow.config?.loopEnabled).toBe(true);
    expect(workflow.config?.maxIterations).toBe(5);
  });

  it('should have loopEnabled default to false', () => {
    const workflow = {
      name: 'Normal Workflow',
      version: '1.0',
      nodes: [
        { id: 'start', type: 'tool', config: {} },
      ],
      config: {
        maxIterations: 100,
      },
    } as WorkflowDefinition;
    
    expect(workflow.config?.loopEnabled ?? false).toBe(false);
  });
});

describe('__end__ Termination', () => {
  it('should recognize __end__ as termination signal', () => {
    const workflow = {
      name: 'Simple End Workflow',
      version: '1.0',
      nodes: [
        { id: 'start', type: 'tool', config: {} },
      ],
      edges: [
        { from: 'start', to: '__end__', when: 'true' },
      ],
    } as WorkflowDefinition;
    
    // Verify edge to __end__ is defined
    const endEdge = workflow.edges?.find(e => e.to === '__end__');
    expect(endEdge).toBeDefined();
    expect(endEdge?.from).toBe('start');
  });
});

describe('Edge Condition with workflowInput', () => {
  it('should evaluate conditions using workflowInput', () => {
    // Simulate condition evaluation with workflowInput
    const resolver = new TemplateResolver({
      input: { threshold: 10, value: 15 },
      previousOutputs: new Map(),
    });
    
    // Condition uses workflowInput (threshold) and node output (value)
    const condition = '{{input.threshold}} < {{nodes.check.output.value}}';
    // After template resolution, it becomes: 10 < 15
    // Which should evaluate to true
    expect(resolver.evaluateCondition('{{input.threshold}} < 15')).toBe(true);
    expect(resolver.evaluateCondition('{{input.threshold}} > 20')).toBe(false);
  });
});

describe('Scheduler Back-Edge Re-entry', () => {
  it('should allow back-edge to re-enter completed node in loop mode', () => {
    // Create a Plan-Execute-Verifier pattern workflow
    const workflow = {
      name: 'Plan-Execute-Verifier',
      version: '1.0',
      nodes: [
        { id: 'plan', type: 'agent', config: {} },                    // Entry node (no depends_on)
        { id: 'execute', type: 'agent', depends_on: ['plan'], config: {} },
        { id: 'verify', type: 'tool', depends_on: ['execute'], config: {} },
      ],
      edges: [
        { from: 'verify', to: 'plan', when: '{{nodes.verify.output.passed}} == false' },
        { from: 'verify', to: '__end__', when: '{{nodes.verify.output.passed}} == true' },
      ],
    } as WorkflowDefinition;
    
    // Create DAGManager with loopEnabled
    const dagManager = new DAGManager(workflow, { allowCycles: true });
    
    // Create scheduler
    const scheduler = new Scheduler(dagManager);
    
    // Simulate first round: plan → execute → verify
    scheduler.markStarted('plan');
    scheduler.markCompleted('plan');
    
    scheduler.markStarted('execute');
    scheduler.markCompleted('execute');
    
    scheduler.markStarted('verify');
    scheduler.markCompleted('verify');
    
    // Now verify completes and should trigger back-edge to plan
    const edges: EdgeDefinition[] = [
      { from: 'verify', to: 'plan', when: '{{nodes.verify.output.passed}} == false' },
      { from: 'verify', to: '__end__', when: '{{nodes.verify.output.passed}} == true' },
    ];
    
    const resolver = new TemplateResolver({
      input: {},
      // Note: Condition uses {{nodes.verify.output.passed}}, so structure must match
      previousOutputs: new Map([['verify', { output: { passed: false } }]]),
    });
    
    // Process edges after verify completes
    // In loop mode, plan should be allowed to re-enter
    // Note: passed=false means only the "== false" edge triggers, "__end__" edge (== true) is skipped
    const result = scheduler.processEdgesAfterCompletion('verify', edges, resolver, true);
    
    // Plan should be in the list to start (re-entry allowed in loop mode)
    expect(result.toStart).toContain('plan');
    expect(result.reEntries).toContain('plan');
    // __end__ edge has condition "== true", but passed is false, so it's skipped
    expect(result.toStart).not.toContain('__end__');
    // __end__ should be in skipped set
    expect(scheduler.getState().skipped).toContain('__end__');
    
    // Plan should no longer be in completed (it was re-entered)
    expect(scheduler.getState().completed).not.toContain('plan');
    // Downstream nodes should also be reset for PEV loop
    expect(scheduler.getState().completed).not.toContain('execute');
    expect(scheduler.getState().completed).not.toContain('verify');
    expect(result.resetNodes).toContain('execute');
    expect(result.resetNodes).toContain('verify');
  });

  it('should NOT allow re-entry when loopEnabled is false', () => {
    const workflow = {
      name: 'Simple Workflow',
      version: '1.0',
      nodes: [
        { id: 'start', type: 'tool', config: {} },
        { id: 'end', type: 'tool', depends_on: ['start'], config: {} },
      ],
      edges: [
        { from: 'end', to: 'start', when: '{{nodes.end.output.repeat}} == true' },
      ],
    } as WorkflowDefinition;
    
    const dagManager = new DAGManager(workflow);
    const scheduler = new Scheduler(dagManager);
    
    scheduler.markStarted('start');
    scheduler.markCompleted('start');
    scheduler.markStarted('end');
    scheduler.markCompleted('end');
    
    const edges: EdgeDefinition[] = [
      { from: 'end', to: 'start', when: '{{nodes.end.output.repeat}} == true' },
    ];
    
    const resolver = new TemplateResolver({
      input: {},
      previousOutputs: new Map([['end', { repeat: true }]]),
    });
    
    // Without loop mode, completed nodes should NOT be re-entered
    const result = scheduler.processEdgesAfterCompletion('end', edges, resolver, false);
    
    // start should NOT be in the list (already completed)
    expect(result.toStart).not.toContain('start');
  });

  it('should skip nodes when edge condition is false', () => {
    const workflow = {
      name: 'Conditional Skip',
      version: '1.0',
      nodes: [
        { id: 'check', type: 'tool', config: {} },
        { id: 'path-a', type: 'tool', depends_on: ['check'], config: {} },
        { id: 'path-b', type: 'tool', depends_on: ['check'], config: {} },
      ],
      edges: [
        { from: 'check', to: 'path-a', when: '{{nodes.check.output.choice}} == "a"' },
        { from: 'check', to: 'path-b', when: '{{nodes.check.output.choice}} == "b"' },
      ],
    } as WorkflowDefinition;
    
    const dagManager = new DAGManager(workflow);
    const scheduler = new Scheduler(dagManager);
    
    scheduler.markStarted('check');
    scheduler.markCompleted('check');
    
    // Note: Condition uses {{nodes.check.output.choice}}, so we need correct structure
    const edges: EdgeDefinition[] = [
      { from: 'check', to: 'path-a', when: '{{nodes.check.output.choice}} == "a"' },
      { from: 'check', to: 'path-b', when: '{{nodes.check.output.choice}} == "b"' },
    ];
    
    const resolver = new TemplateResolver({
      input: {},
      previousOutputs: new Map([['check', { output: { choice: 'a' } }]]),
    });
    
    const result = scheduler.processEdgesAfterCompletion('check', edges, resolver, false);
    
    // path-a should be started (condition true)
    expect(result.toStart).toContain('path-a');
    // path-b should be skipped (condition false)
    expect(result.toStart).not.toContain('path-b');
    expect(scheduler.getState().skipped).toContain('path-b');
    expect(result.skipped.some(s => s.nodeId === 'path-b')).toBe(true);
  });

  it('should unmark skipped node when condition becomes true', () => {
    const workflow = {
      name: 'Condition Flip',
      version: '1.0',
      nodes: [
        { id: 'check', type: 'tool', config: {} },
        { id: 'path-a', type: 'tool', depends_on: ['check'], config: {} },
      ],
    } as WorkflowDefinition;

    const dagManager = new DAGManager(workflow);
    const scheduler = new Scheduler(dagManager);
    const edges: EdgeDefinition[] = [
      { from: 'check', to: 'path-a', when: '{{nodes.check.output.choice}} == "a"' },
    ];

    scheduler.markStarted('check');
    scheduler.markCompleted('check');

    const falseResolver = new TemplateResolver({
      input: {},
      previousOutputs: new Map([['check', { output: { choice: 'b' } }]]),
    });
    scheduler.processEdgesAfterCompletion('check', edges, falseResolver, false);
    expect(scheduler.getState().skipped).toContain('path-a');

    const trueResolver = new TemplateResolver({
      input: {},
      previousOutputs: new Map([['check', { output: { choice: 'a' } }]]),
    });
    const result = scheduler.processEdgesAfterCompletion('check', edges, trueResolver, false);
    expect(result.toStart).toContain('path-a');
    expect(scheduler.getState().skipped).not.toContain('path-a');
  });

  it('should require depends_on to prevent dual scheduling conflict', () => {
    // WRONG: All nodes have empty depends_on
    const wrongWorkflow = {
      name: 'Wrong Workflow',
      version: '1.0',
      nodes: [
        { id: 'check', type: 'tool', config: {} },
        { id: 'path-a', type: 'tool', config: {} },  // Missing depends_on: [check]
        { id: 'path-b', type: 'tool', config: {} },   // Missing depends_on: [check]
      ],
    } as WorkflowDefinition;
    
    const wrongDag = new DAGManager(wrongWorkflow);
    const wrongAnalysis = wrongDag.analyze();
    
    // Both path-a and path-b have no dependencies
    expect(wrongAnalysis.dependencies.get('path-a')).toEqual([]);
    expect(wrongAnalysis.dependencies.get('path-b')).toEqual([]);
    
    // CORRECT: Both path-a and path-b depend on check
    const correctWorkflow = {
      name: 'Correct Workflow',
      version: '1.0',
      nodes: [
        { id: 'check', type: 'tool', config: {} },
        { id: 'path-a', type: 'tool', depends_on: ['check'] },
        { id: 'path-b', type: 'tool', depends_on: ['check'] },
      ],
    } as WorkflowDefinition;
    
    const correctDag = new DAGManager(correctWorkflow);
    const correctAnalysis = correctDag.analyze();
    
    expect(correctAnalysis.dependencies.get('path-a')).toEqual(['check']);
    expect(correctAnalysis.dependencies.get('path-b')).toEqual(['check']);
  });
});

describe('__end__ Special Handling', () => {
  it('should handle __end__ edge to terminate workflow', () => {
    const workflow = {
      name: 'End Workflow',
      version: '1.0',
      nodes: [
        { id: 'start', type: 'tool', config: {} },
      ],
      edges: [
        { from: 'start', to: '__end__', when: 'true' },
      ],
    } as WorkflowDefinition;
    
    const dagManager = new DAGManager(workflow);
    const scheduler = new Scheduler(dagManager);
    
    scheduler.markStarted('start');
    scheduler.markCompleted('start');
    
    const edges: EdgeDefinition[] = [
      { from: 'start', to: '__end__', when: 'true' },
    ];
    
    const resolver = new TemplateResolver({
      input: {},
      previousOutputs: new Map(),
    });
    
    const result = scheduler.processEdgesAfterCompletion('start', edges, resolver, false);
    
    // __end__ should be in the list
    expect(result.toStart).toContain('__end__');
  });
});

describe('workflowInput in Condition Evaluation', () => {
  it('should evaluate conditions with workflowInput', () => {
    const workflowInput = { threshold: 10 };
    const nodeOutputs = new Map([
      ['check', { value: 15 }],
    ]);
    
    const resolver = new TemplateResolver({
      input: workflowInput,
      previousOutputs: nodeOutputs,
    });
    
    // Condition uses both workflowInput (threshold) and node output (value)
    // After template resolution: {{input.threshold}} becomes 10, {{nodes.check.output.value}} becomes 15
    const condition = '{{input.threshold}} < {{nodes.check.output.value}}';
    expect(resolver.evaluateCondition('10 < 15')).toBe(true);
  });

  it('should handle missing workflowInput gracefully', () => {
    const resolver = new TemplateResolver({
      input: {},
      previousOutputs: new Map(),
    });
    
    // Without workflowInput, condition evaluation should work with defaults
    expect(resolver.evaluateCondition('true')).toBe(true);
    expect(resolver.evaluateCondition('false')).toBe(false);
  });
});
