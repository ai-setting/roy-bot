/**
 * @fileoverview Workflow Decorator Integration Tests
 */

import { describe, test, expect } from 'bun:test';
import 'reflect-metadata';
import { Workflow, NodeAs, Edge, WorkflowEdges } from './index';
import { WorkflowConverter } from '../extractor/workflow-converter';
import { createWorkflowFromClass } from '../utils/create-workflow';
import { getWorkflowMetadata, getNodeMetadatas, getEdgeMetadatas } from './index';

describe('Workflow Decorators', () => {
  
  // ============ Test Workflow Class ============
  
  @Workflow({
    name: 'test-workflow',
    version: '1.0',
    description: 'Test workflow for decorator functionality',
    entry: 'step1',
    config: { parallel_limit: 3 }
  })
  @WorkflowEdges([
    { from: 'step2', to: 'step3' },
    { from: 'step3', to: 'step4' }
  ])
  class TestWorkflow {
    @NodeAs({ nodeId: 'step1', nodeType: 'tool' })
    async step1(input: { message: string }) {
      return { result: `Step1: ${input.message}` };
    }

    @NodeAs({ nodeId: 'step2', dependsOn: 'step1' })
    async step2(input: { step1: any }) {
      return { result: `Step2: ${input.step1.result}` };
    }

    @NodeAs({ nodeId: 'step3', dependsOn: 'step1' })
    async step3(input: { step1: any }) {
      return { result: `Step3: ${input.step1.result}` };
    }

    @NodeAs({ nodeId: 'step4', dependsOn: ['step2', 'step3'] })
    async step4(input: { step2: any; step3: any }) {
      return { 
        result: `Step4: ${input.step2.result} & ${input.step3.result}` 
      };
    }
  }

  // ============ Tests ============

  test('should extract workflow metadata', () => {
    const metadata = getWorkflowMetadata(TestWorkflow);
    
    expect(metadata).toBeDefined();
    expect(metadata?.name).toBe('test-workflow');
    expect(metadata?.version).toBe('1.0');
    expect(metadata?.description).toBe('Test workflow for decorator functionality');
    expect(metadata?.entry).toBe('step1');
  });

  test('should extract node metadatas', () => {
    const nodes = getNodeMetadatas(TestWorkflow.prototype);
    
    expect(nodes).toHaveLength(4);
    
    // Check step1
    const step1 = nodes.find(n => n.nodeId === 'step1');
    expect(step1).toBeDefined();
    expect(step1?.nodeType).toBe('tool');
    expect(step1?.dependsOn).toEqual([]);
    expect(step1?.methodName).toBe('step1');
    
    // Check step2 (depends on step1)
    const step2 = nodes.find(n => n.nodeId === 'step2');
    expect(step2).toBeDefined();
    expect(step2?.dependsOn).toEqual(['step1']);
    
    // Check step4 (depends on step2 and step3)
    const step4 = nodes.find(n => n.nodeId === 'step4');
    expect(step4).toBeDefined();
    expect(step4?.dependsOn).toEqual(['step2', 'step3']);
  });

  test('should extract edge metadatas', () => {
    const edges = getEdgeMetadatas(TestWorkflow);
    
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({ from: 'step2', to: 'step3' });
    expect(edges).toContainEqual({ from: 'step3', to: 'step4' });
  });

  test('should validate workflow class', () => {
    const result = WorkflowConverter.validateWorkflowClass(TestWorkflow);
    
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('should convert to WorkflowDefinition', () => {
    const workflow = createWorkflowFromClass(TestWorkflow);
    
    expect(workflow.name).toBe('test-workflow');
    expect(workflow.version).toBe('1.0');
    expect(workflow.nodes).toHaveLength(4);
    
    // Check nodes
    const step1Node = workflow.nodes.find(n => n.id === 'step1');
    expect(step1Node).toBeDefined();
    expect(step1Node?.type).toBe('tool');
    expect(step1Node?.depends_on).toEqual([]);
    
    const step4Node = workflow.nodes.find(n => n.id === 'step4');
    expect(step4Node).toBeDefined();
    expect(step4Node?.depends_on).toContain('step2');
    expect(step4Node?.depends_on).toContain('step3');
  });

  test('should convert conditional edges to edges.when', () => {
    @Workflow({ name: 'conditional-workflow', entry: 'check' })
    @WorkflowEdges([
      { from: 'check', to: 'path-a', condition: '{{nodes.check.output.ok}} == true' },
      { from: 'check', to: 'path-b', condition: '{{nodes.check.output.ok}} == false' },
    ])
    class ConditionalWorkflow {
      @NodeAs({ nodeId: 'check' })
      async check() { return { ok: true }; }

      @NodeAs({ nodeId: 'path-a', dependsOn: 'check' })
      async pathA() { return {}; }

      @NodeAs({ nodeId: 'path-b', dependsOn: 'check' })
      async pathB() { return {}; }
    }

    const workflow = createWorkflowFromClass(ConditionalWorkflow);

    expect(workflow.edges).toHaveLength(2);
    expect(workflow.edges?.[0]).toEqual({
      from: 'check',
      to: 'path-a',
      when: '{{nodes.check.output.ok}} == true',
    });
    expect(workflow.nodes.find(n => n.id === 'path-a')?.condition).toBeUndefined();
  });

  test('should validate missing entry node', () => {
    @Workflow({ name: 'broken-workflow', entry: 'nonexistent' })
    class BrokenWorkflow {
      @NodeAs({ nodeId: 'step1' })
      async step1() { return {}; }
    }

    const result = WorkflowConverter.validateWorkflowClass(BrokenWorkflow);
    
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("Entry node 'nonexistent' not found"))).toBe(true);
  });

  test('should validate missing dependency', () => {
    @Workflow({ name: 'broken-workflow-2' })
    class BrokenWorkflow2 {
      @NodeAs({ nodeId: 'step1', dependsOn: 'nonexistent' })
      async step1() { return {}; }
    }

    const result = WorkflowConverter.validateWorkflowClass(BrokenWorkflow2);
    
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes("depends on non-existent node"))).toBe(true);
  });

  test('should validate cycle detection', () => {
    @Workflow({ name: 'cyclic-workflow' })
    class CyclicWorkflow {
      @NodeAs({ nodeId: 'a', dependsOn: 'c' })
      async a() { return {}; }
      
      @NodeAs({ nodeId: 'b', dependsOn: 'a' })
      async b() { return {}; }
      
      @NodeAs({ nodeId: 'c', dependsOn: 'b' })
      async c() { return {}; }
    }

    const result = WorkflowConverter.validateWorkflowClass(CyclicWorkflow);
    
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('cycle'))).toBe(true);
  });

  test('should execute decorator node method', async () => {
    const workflow = createWorkflowFromClass(TestWorkflow);
    const step1Node = workflow.nodes.find(n => n.id === 'step1')!;
    
    const result = await WorkflowConverter.executeNode(
      step1Node,
      { input: { message: 'hello' }, previousOutputs: new Map() }
    );
    
    expect(result.output).toEqual({ result: 'Step1: hello' });
    expect(result.error).toBeUndefined();
  });

  test('should handle node execution with dependencies', async () => {
    const workflow = createWorkflowFromClass(TestWorkflow);
    const step4Node = workflow.nodes.find(n => n.id === 'step4')!;
    
    const previousOutputs = new Map([
      ['step2', { result: 'Step2: data2' }],
      ['step3', { result: 'Step3: data3' }]
    ]);
    
    const result = await WorkflowConverter.executeNode(
      step4Node,
      { input: {}, previousOutputs }
    );
    
    expect(result.output).toEqual({ 
      result: 'Step4: Step2: data2 & Step3: data3' 
    });
  });
});
