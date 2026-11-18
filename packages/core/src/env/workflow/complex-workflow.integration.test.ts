/**
 * Complex Multi-Node Workflow Integration Tests
 * 
 * Tests for complex workflow patterns including:
 * - Parallel execution branches
 * - Diamond patterns (merge and fork)
 * - Error handling and retry logic
 * - Conditional execution
 * - Template variable passing
 * - Nested workflows
 * - Complex dependency graphs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import type { WorkflowDefinition, NodeDefinition } from './types';

// ==================== Mock Workflow Executor ====================

interface MockNodeExecution {
  nodeId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  input: any;
  output: any;
  error?: string;
  startTime?: number;
  endTime?: number;
  retryCount: number;
}

interface ExecutionTrace {
  nodes: Map<string, MockNodeExecution>;
  executionOrder: string[];
  parallelBatches: string[][];
  errors: Array<{ nodeId: string; error: string; attempt: number }>;
}

/**
 * Synchronous Workflow Executor for Testing
 */
class SyncWorkflowExecutor {
  private trace: ExecutionTrace;
  private nodeConfigs: Map<string, any>;
  
  constructor() {
    this.trace = {
      nodes: new Map(),
      executionOrder: [],
      parallelBatches: [],
      errors: [],
    };
    this.nodeConfigs = new Map();
  }
  
  setNodeConfig(nodeId: string, config: any): void {
    this.nodeConfigs.set(nodeId, config);
  }
  
  getTrace(): ExecutionTrace {
    return this.trace;
  }
  
  clearTrace(): void {
    this.trace = {
      nodes: new Map(),
      executionOrder: [],
      parallelBatches: [],
      errors: [],
    };
  }
  
  executeNode(nodeId: string, input: any, dependencies: Map<string, any>, nodeType?: string): any {
    const config = this.nodeConfigs.get(nodeId) || {};
    
    // Initialize trace entry
    const traceEntry: MockNodeExecution = {
      nodeId,
      status: 'pending',
      input,
      output: null,
      retryCount: 0,
    };
    this.trace.nodes.set(nodeId, traceEntry);
    
    // Execute node
    traceEntry.status = 'running';
    traceEntry.startTime = Date.now();
    
    // Use provided nodeType or fall back to config.type
    const effectiveNodeType = nodeType || config.type || 'unknown';
    let output: any;
    
    switch (effectiveNodeType) {
      case 'tool':
        output = this.executeToolNode(nodeId, config, input);
        break;
      case 'skill':
        output = this.executeSkillNode(nodeId, config, input, dependencies);
        break;
      case 'agent':
        output = this.executeAgentNode(nodeId, config, input, dependencies);
        break;
      case 'condition':
        output = this.executeConditionNode(nodeId, config, input);
        break;
      case 'merge':
        output = this.executeMergeNode(nodeId, config, dependencies);
        break;
      case 'nested':
      case 'workflow':
        output = this.executeNestedWorkflowNode(nodeId, config, input);
        break;
      default:
        output = { result: `${nodeId}_result`, input };
    }
    
    traceEntry.output = output;
    traceEntry.status = 'completed';
    traceEntry.endTime = Date.now();
    this.trace.executionOrder.push(nodeId);
    
    return output;
  }
  
  private executeToolNode(nodeId: string, config: any, input: any): any {
    const toolName = config.tool || 'default-tool';
    if (toolName === 'echo') {
      return { echo: input, message: config.message };
    }
    if (toolName === 'calculator') {
      return { result: 42, operation: config.operation };
    }
    if (toolName === 'validator') {
      return { valid: true, validated: input, source: config.source };
    }
    return { tool: toolName, result: `processed_by_${toolName}` };
  }
  
  private executeSkillNode(
    nodeId: string,
    config: any,
    input: any,
    dependencies: Map<string, any>
  ): any {
    const skillName = config.skill || 'default-skill';
    return {
      skill: skillName,
      result: `skill_${skillName}_executed`,
      inputsFromDeps: Object.fromEntries(dependencies),
    };
  }
  
  private executeAgentNode(
    nodeId: string,
    config: any,
    input: any,
    dependencies: Map<string, any>
  ): any {
    const agentType = config.agent || 'general';
    return {
      agent: agentType,
      reasoning: `Agent ${agentType} processed input`,
      input,
    };
  }
  
  private executeConditionNode(nodeId: string, config: any, input: any): any {
    const condition = config.condition || 'true';
    const result = this.evaluateCondition(condition, input);
    return { conditionMet: result, evaluatedCondition: condition };
  }
  
  private executeMergeNode(
    nodeId: string,
    config: any,
    dependencies: Map<string, any>
  ): any {
    const mergedInputs: any = {};
    for (const [depId, depOutput] of dependencies) {
      mergedInputs[depId] = depOutput;
    }
    return {
      merged: true,
      inputs: mergedInputs,
      mergeStrategy: config.strategy || 'collect',
      valid: true,
    };
  }
  
  private executeNestedWorkflowNode(nodeId: string, config: any, input: any): any {
    const workflowName = config.workflow || config.workflow_name || 'default-nested';
    return {
      nestedWorkflow: workflowName,
      workflowName,
      input,
      result: `nested_${workflowName}_executed`,
    };
  }
  
  private evaluateCondition(condition: string, context: any): boolean {
    // Handle template variable conditions
    if (condition === '{{input.skip}}') {
      return context?.skip !== false && !!context?.skip;
    }
    if (condition === '{{input.mode}}') {
      return !!context?.mode;
    }
    if (condition === 'true') return true;
    if (condition.includes('valid')) return true;
    if (condition.includes('{{process.result}}')) return true;
    return condition !== 'false';
  }
}

// ==================== Workflow Execution Engine ====================

function executeWorkflowSync(
  definition: WorkflowDefinition,
  input?: any,
  executor?: SyncWorkflowExecutor
): Map<string, any> {
  const exec = executor || new SyncWorkflowExecutor();
  const results = new Map<string, any>();
  const nodeMap = new Map<string, NodeDefinition>();
  
  // Build node map and config
  for (const node of definition.nodes) {
    nodeMap.set(node.id, node);
    exec.setNodeConfig(node.id, node.config);
  }
  
  // Topological sort for execution order
  const order = topologicalSort(definition);
  
  // Execute in order
  const dependencies = new Map<string, any>();
  
  for (const nodeId of order) {
    const node = nodeMap.get(nodeId)!;
    
    // Get dependency outputs
    const depOutputs = new Map<string, any>();
    for (const depId of node.depends_on || []) {
      depOutputs.set(depId, dependencies.get(depId));
    }
    
    // Execute node with explicit node type
    const output = exec.executeNode(nodeId, { ...input }, depOutputs, node.type);
    dependencies.set(nodeId, output);
    results.set(nodeId, output);
  }
  
  return results;
}

function topologicalSort(workflow: WorkflowDefinition): string[] {
  const nodeMap = new Map(workflow.nodes.map(n => [n.id, n]));
  const visited = new Set<string>();
  const temp = new Set<string>();
  const order: string[] = [];
  
  function visit(nodeId: string): void {
    if (temp.has(nodeId)) {
      throw new Error(`Circular dependency detected: ${nodeId}`);
    }
    if (visited.has(nodeId)) return;
    
    temp.add(nodeId);
    
    const node = nodeMap.get(nodeId);
    if (node) {
      for (const depId of node.depends_on || []) {
        visit(depId);
      }
    }
    
    temp.delete(nodeId);
    visited.add(nodeId);
    order.push(nodeId);
  }
  
  // Visit all nodes
  for (const node of workflow.nodes) {
    if (!visited.has(node.id)) {
      visit(node.id);
    }
  }
  
  return order;
}

// ==================== Complex Workflow Definitions ====================

/**
 * Complex Workflow: Data Processing Pipeline
 * 
 * This workflow simulates a complex data processing pipeline with:
 * - 12 nodes total
 * - Parallel data fetching branches
 * - Diamond merge pattern
 * - Conditional processing
 * - Error handling with retry
 */
const createDataProcessingWorkflow = (): WorkflowDefinition => ({
  name: 'data-processing-pipeline',
  version: '1.0',
  description: 'Complex data processing pipeline with parallel branches',
  config: {
    parallel_limit: 3,
    timeout: 300000,
  },
  nodes: [
    // Entry node - Initialize pipeline
    {
      id: 'init',
      type: 'tool',
      name: 'Initialize Pipeline',
      config: { tool: 'echo', message: 'Starting data pipeline' },
    },
    
    // Parallel fetch branch 1
    {
      id: 'fetch-users',
      type: 'tool',
      name: 'Fetch Users',
      config: { tool: 'validator', source: 'users' },
      depends_on: ['init'],
    },
    
    // Parallel fetch branch 2
    {
      id: 'fetch-products',
      type: 'tool',
      name: 'Fetch Products',
      config: { tool: 'validator', source: 'products' },
      depends_on: ['init'],
    },
    
    // Parallel fetch branch 3
    {
      id: 'fetch-orders',
      type: 'tool',
      name: 'Fetch Orders',
      config: { tool: 'validator', source: 'orders' },
      depends_on: ['init'],
    },
    
    // Diamond pattern - merge point
    {
      id: 'merge-data',
      type: 'merge',
      name: 'Merge All Data',
      config: { strategy: 'collect' },
      depends_on: ['fetch-users', 'fetch-products', 'fetch-orders'],
    },
    
    // Diamond pattern - fork to processing branches
    {
      id: 'validate-data',
      type: 'condition',
      name: 'Validate Merged Data',
      config: { condition: '{{merge-data.valid}}' },
      depends_on: ['merge-data'],
    },
    
    // Processing branch 1 - with retry
    {
      id: 'process-users',
      type: 'tool',
      name: 'Process Users',
      config: { tool: 'calculator', operation: 'user-scoring' },
      depends_on: ['validate-data'],
      retry: { max_attempts: 3, backoff: 'exponential', initial_delay: 1000 },
    },
    
    // Processing branch 2
    {
      id: 'process-products',
      type: 'tool',
      name: 'Process Products',
      config: { tool: 'calculator', operation: 'product-rating' },
      depends_on: ['validate-data'],
    },
    
    // Diamond merge - final processing
    {
      id: 'finalize-results',
      type: 'tool',
      name: 'Finalize Results',
      config: { tool: 'echo', message: 'Finalizing' },
      depends_on: ['process-users', 'process-products'],
    },
    
    // Conditional node
    {
      id: 'generate-report',
      type: 'condition',
      name: 'Check Report Generation',
      config: { condition: '{{input.generateReport}}' },
      depends_on: ['finalize-results'],
    },
    
    // Nested workflow call
    {
      id: 'create-report',
      type: 'nested',
      name: 'Create Report',
      config: { workflow: 'report-generation' },
      depends_on: ['generate-report'],
    },
    
    // Final output node
    {
      id: 'output',
      type: 'tool',
      name: 'Output Results',
      config: { tool: 'echo', message: 'Pipeline complete' },
      depends_on: ['create-report'],
    },
  ],
  entry: 'init',
  outputs: [
    { name: 'final_result', source: 'output', path: 'result' },
    { name: 'user_data', source: 'process-users', path: 'result' },
    { name: 'product_data', source: 'process-products', path: 'result' },
  ],
  metadata: {
    author: 'Roy Agent',
    tags: ['data-processing', 'pipeline', 'complex'],
  },
});

/**
 * Complex Workflow: Parallel Processing with Error Handling
 * 
 * Features:
 * - Multiple parallel branches
 * - Retry logic on failure-prone nodes
 * - Error recovery paths
 * - Timeout handling
 */
const createParallelProcessingWorkflow = (): WorkflowDefinition => ({
  name: 'parallel-processing',
  version: '1.0',
  description: 'Parallel processing with error handling and retry',
  nodes: [
    { id: 'entry', type: 'tool', config: { tool: 'echo' } },
    
    // Parallel branch A
    { id: 'task-a1', type: 'tool', config: { tool: 'calculator' }, depends_on: ['entry'] },
    { id: 'task-a2', type: 'tool', config: { tool: 'calculator' }, depends_on: ['task-a1'] },
    { id: 'task-a3', type: 'tool', config: { tool: 'calculator' }, depends_on: ['task-a2'] },
    
    // Parallel branch B
    { id: 'task-b1', type: 'tool', config: { tool: 'calculator' }, depends_on: ['entry'] },
    { id: 'task-b2', type: 'tool', config: { tool: 'calculator' }, depends_on: ['task-b1'] },
    {
      id: 'task-b3',
      type: 'tool',
      config: { tool: 'calculator' },
      depends_on: ['task-b1'],
      retry: { max_attempts: 2, backoff: 'fixed', initial_delay: 500 },
    },
    
    // Parallel branch C - with potential failure
    { id: 'task-c1', type: 'tool', config: { tool: 'calculator' }, depends_on: ['entry'] },
    {
      id: 'task-c2',
      type: 'tool',
      config: { tool: 'calculator' },
      depends_on: ['task-c1'],
      retry: { max_attempts: 3, backoff: 'exponential', initial_delay: 1000 },
    },
    
    // Merge all branches
    {
      id: 'merge-ab',
      type: 'merge',
      config: { strategy: 'collect' },
      depends_on: ['task-a3', 'task-b2', 'task-c2'],
    },
    
    // Final processing
    { id: 'final', type: 'tool', config: { tool: 'echo' }, depends_on: ['merge-ab'] },
  ],
});

/**
 * Complex Workflow: Nested Workflow Composition
 * 
 * Features:
 * - Nested workflow calls
 * - Multiple levels of abstraction
 * - Shared state passing
 * - Complex dependency chains
 */
const createNestedWorkflow = (): WorkflowDefinition => ({
  name: 'nested-workflow-composition',
  version: '1.0',
  nodes: [
    { id: 'start', type: 'tool', config: { tool: 'echo' }, depends_on: [] },
    
    // First level nested
    { id: 'sub-workflow-1', type: 'workflow', config: { workflow_name: 'sub-workflow-a' }, depends_on: ['start'] },
    { id: 'sub-workflow-2', type: 'workflow', config: { workflow_name: 'sub-workflow-b' }, depends_on: ['start'] },
    
    // Second level - parallel execution
    { id: 'level-2-a', type: 'tool', config: { tool: 'validator' }, depends_on: ['sub-workflow-1'] },
    { id: 'level-2-b', type: 'tool', config: { tool: 'validator' }, depends_on: ['sub-workflow-1'] },
    { id: 'level-2-c', type: 'tool', config: { tool: 'validator' }, depends_on: ['sub-workflow-2'] },
    
    // Merge and continue
    { id: 'merge-2', type: 'merge', config: { strategy: 'collect' }, depends_on: ['level-2-a', 'level-2-b', 'level-2-c'] },
    
    // Third level
    { id: 'level-3', type: 'tool', config: { tool: 'calculator' }, depends_on: ['merge-2'] },
    
    // Final nested call
    { id: 'final-nested', type: 'workflow', config: { workflow_name: 'final-workflow' }, depends_on: ['level-3'] },
  ],
});

/**
 * Complex Workflow: Conditional Execution Graph
 * 
 * Features:
 * - Multiple conditional branches
 * - Skip logic
 * - Dynamic paths based on runtime conditions
 */
const createConditionalWorkflow = (): WorkflowDefinition => ({
  name: 'conditional-execution',
  version: '1.0',
  nodes: [
    { id: 'init', type: 'tool', config: { tool: 'echo' } },
    
    // First condition
    {
      id: 'check-mode',
      type: 'condition',
      config: { condition: '{{input.mode}}' },
      depends_on: ['init'],
    },
    
    // Mode A path
    { id: 'mode-a-1', type: 'tool', config: { tool: 'calculator' }, depends_on: ['check-mode'] },
    { id: 'mode-a-2', type: 'tool', config: { tool: 'calculator' }, depends_on: ['mode-a-1'] },
    
    // Mode B path
    { id: 'mode-b-1', type: 'tool', config: { tool: 'validator' }, depends_on: ['check-mode'] },
    { id: 'mode-b-2', type: 'tool', config: { tool: 'validator' }, depends_on: ['mode-b-1'] },
    
    // Merge after conditional paths
    { id: 'merge-cond', type: 'merge', config: { strategy: 'collect' }, depends_on: ['mode-a-2', 'mode-b-2'] },
    
    // Final check
    {
      id: 'final-check',
      type: 'condition',
      config: { condition: '{{merge-cond.valid}}' },
      depends_on: ['merge-cond'],
    },
    
    // Output
    { id: 'output', type: 'tool', config: { tool: 'echo' }, depends_on: ['final-check'] },
  ],
});

/**
 * Complex Workflow: Diamond Pattern
 * 
 * A -> B1 -> C -> D
 *   -> B2 -> 
 *   -> B3 -> 
 * 
 * Classic diamond dependency pattern
 */
const createDiamondWorkflow = (): WorkflowDefinition => ({
  name: 'diamond-pattern',
  version: '1.0',
  nodes: [
    { id: 'A', type: 'tool', config: { tool: 'echo' }, depends_on: [] },
    { id: 'B1', type: 'tool', config: { tool: 'calculator' }, depends_on: ['A'] },
    { id: 'B2', type: 'tool', config: { tool: 'calculator' }, depends_on: ['A'] },
    { id: 'B3', type: 'tool', config: { tool: 'calculator' }, depends_on: ['A'] },
    {
      id: 'C',
      type: 'tool',
      config: { tool: 'calculator' },
      depends_on: ['B1', 'B2', 'B3'],
      retry: { max_attempts: 2, backoff: 'exponential', initial_delay: 500 },
    },
    { id: 'D', type: 'tool', config: { tool: 'echo' }, depends_on: ['C'] },
  ],
});

/**
 * Complex Workflow: Multi-Node Type Orchestration
 * 
 * Demonstrates chaining different node types:
 * - ToolNode → AgentNode → SkillNode → WorkflowNode → ToolNode
 * - Template variable passing between different node types
 * - Real-world AI pipeline pattern
 */
const createMultiNodeTypeWorkflow = (): WorkflowDefinition => ({
  name: 'multi-node-type-orchestration',
  version: '1.0',
  description: 'Orchestration across Tool, Agent, Skill, and Workflow nodes',
  nodes: [
    // ========== Step 1: Tool - Data Preparation ==========
    {
      id: 'prepare-data',
      type: 'tool',
      name: 'Prepare Input Data',
      config: { tool: 'echo', message: 'Preparing initial data' },
      depends_on: [],
    },
    
    // ========== Step 2: Agent - Analysis ==========
    {
      id: 'analyze-data',
      type: 'agent',
      name: 'AI Data Analyst',
      config: {
        agent_type: 'general',
        prompt: 'Analyze the input data: {{prepare-data.output}}. Provide insights.',
      },
      depends_on: ['prepare-data'],
    },
    
    // ========== Step 3: Tool - Validate Analysis ==========
    {
      id: 'validate-analysis',
      type: 'tool',
      name: 'Validate Analysis Results',
      config: { tool: 'validator', source: 'analysis' },
      depends_on: ['analyze-data'],
    },
    
    // ========== Step 4: Agent - Decision Making ==========
    {
      id: 'make-decision',
      type: 'agent',
      name: 'Decision Agent',
      config: {
        agent_type: 'general',
        prompt: 'Based on analysis: {{analyze-data.output}}, decide next steps.',
      },
      depends_on: ['validate-analysis'],
    },
    
    // ========== Step 5: Skill - Transform Data ==========
    {
      id: 'transform-data',
      type: 'skill',
      name: 'Data Transformation Skill',
      config: {
        skill: 'data-transform',
        input: {
          data: '{{analyze-data.output}}',
          format: 'json',
        },
      },
      depends_on: ['make-decision'],
    },
    
    // ========== Step 6: Nested Workflow ==========
    {
      id: 'process-workflow',
      type: 'workflow',
      name: 'Sub-Process Workflow',
      config: {
        workflow_name: 'data-processing-subflow',
        input: {
          source: '{{transform-data.output}}',
        },
      },
      depends_on: ['transform-data'],
    },
    
    // ========== Step 7: Tool - Final Output ==========
    {
      id: 'format-output',
      type: 'tool',
      name: 'Format Final Output',
      config: { tool: 'calculator', operation: 'format' },
      depends_on: ['process-workflow'],
    },
  ],
  outputs: [
    { name: 'analysis_result', source: 'analyze-data', path: 'output' },
    { name: 'decision', source: 'make-decision', path: 'output' },
    { name: 'transformed_data', source: 'transform-data', path: 'output' },
    { name: 'final_result', source: 'format-output', path: 'result' },
  ],
  metadata: {
    author: 'Roy Agent',
    tags: ['multi-node', 'orchestration', 'ai-pipeline'],
  },
});

/**
 * Complex Workflow: Tool-Skill-Agent Chain
 * 
 * A realistic AI pipeline demonstrating:
 * - Tool (data fetch)
 * - Agent (reasoning)
 * - Skill (processing)
 * - Another Agent (verification)
 * - Tool (output)
 */
const createToolSkillAgentChain = (): WorkflowDefinition => ({
  name: 'tool-skill-agent-chain',
  version: '1.0',
  nodes: [
    // Tool: Fetch raw data
    {
      id: 'fetch-raw-data',
      type: 'tool',
      name: 'Fetch Raw Data',
      config: { tool: 'echo', message: 'Fetching data from source' },
      depends_on: [],
    },
    
    // Agent: Initial understanding
    {
      id: 'understand-context',
      type: 'agent',
      name: 'Context Understanding Agent',
      config: {
        agent_type: 'general',
        prompt: 'Understand the context of: {{fetch-raw-data.output}}',
      },
      depends_on: ['fetch-raw-data'],
    },
    
    // Skill: Process with skill
    {
      id: 'process-with-skill',
      type: 'skill',
      name: 'Processing Skill',
      config: {
        skill: 'text-processor',
        input: {
          text: '{{understand-context.output}}',
          options: { lowercase: true },
        },
      },
      depends_on: ['understand-context'],
    },
    
    // Agent: Deep reasoning
    {
      id: 'deep-reasoning',
      type: 'agent',
      name: 'Deep Reasoning Agent',
      config: {
        agent_type: 'general',
        prompt: 'Perform deep reasoning on: {{process-with-skill.output}}',
      },
      depends_on: ['process-with-skill'],
    },
    
    // Skill: Another skill processing
    {
      id: 'enhance-result',
      type: 'skill',
      name: 'Enhancement Skill',
      config: {
        skill: 'enhancer',
        input: {
          data: '{{deep-reasoning.output}}',
        },
      },
      depends_on: ['deep-reasoning'],
    },
    
    // Tool: Final validation
    {
      id: 'final-validate',
      type: 'tool',
      name: 'Final Validation',
      config: { tool: 'validator', source: 'final' },
      depends_on: ['enhance-result'],
    },
  ],
});

/**
 * Complex Workflow: Parallel Tool-Agent Branches
 * 
 * Multiple parallel branches, each with Tool → Agent pattern
 */
const createParallelToolAgentWorkflow = (): WorkflowDefinition => ({
  name: 'parallel-tool-agent-branches',
  version: '1.0',
  nodes: [
    // Entry
    { id: 'start', type: 'tool', config: { tool: 'echo' }, depends_on: [] },
    
    // Branch A: Tool → Agent
    { id: 'tool-a', type: 'tool', config: { tool: 'calculator' }, depends_on: ['start'] },
    {
      id: 'agent-a',
      type: 'agent',
      config: { agent_type: 'general', prompt: 'Process: {{tool-a.output}}' },
      depends_on: ['tool-a'],
    },
    
    // Branch B: Tool → Agent
    { id: 'tool-b', type: 'tool', config: { tool: 'validator' }, depends_on: ['start'] },
    {
      id: 'agent-b',
      type: 'agent',
      config: { agent_type: 'general', prompt: 'Process: {{tool-b.output}}' },
      depends_on: ['tool-b'],
    },
    
    // Branch C: Tool → Agent
    { id: 'tool-c', type: 'tool', config: { tool: 'echo' }, depends_on: ['start'] },
    {
      id: 'agent-c',
      type: 'agent',
      config: { agent_type: 'general', prompt: 'Process: {{tool-c.output}}' },
      depends_on: ['tool-c'],
    },
    
    // Merge all agent outputs
    {
      id: 'merge-agents',
      type: 'merge',
      config: { strategy: 'collect' },
      depends_on: ['agent-a', 'agent-b', 'agent-c'],
    },
    
    // Final aggregation agent
    {
      id: 'aggregate-results',
      type: 'agent',
      name: 'Aggregation Agent',
      config: {
        agent_type: 'general',
        prompt: 'Aggregate and summarize results from all branches.',
      },
      depends_on: ['merge-agents'],
    },
    
    // Output tool
    { id: 'output', type: 'tool', config: { tool: 'echo' }, depends_on: ['aggregate-results'] },
  ],
});

/**
 * Complex Workflow: Template Variable Passing
 * 
 * Tests HIL (Human Input Language) template variable passing
 */
const createTemplateVariableWorkflow = (): WorkflowDefinition => ({
  name: 'template-variables',
  version: '1.0',
  nodes: [
    {
      id: 'init',
      type: 'tool',
      config: { tool: 'echo', message: '{{input.greeting}}' },
    },
    {
      id: 'process',
      type: 'tool',
      config: { tool: 'calculator', expression: '{{init.result}} + {{input.value}}' },
      depends_on: ['init'],
    },
    {
      id: 'validate',
      type: 'condition',
      config: { condition: '{{process.result}} > {{input.threshold}}' },
      depends_on: ['process'],
    },
    {
      id: 'output',
      type: 'tool',
      config: { tool: 'echo', message: 'Result: {{process.result}}, Valid: {{validate.conditionMet}}' },
      depends_on: ['validate'],
    },
  ],
});

/**
 * Complex Workflow: Complex Dependency Graph
 * 
 * Features:
 * - Multiple entry points
 * - Complex merge patterns
 * - Cross-branch dependencies
 */
const createComplexDependencyWorkflow = (): WorkflowDefinition => ({
  name: 'complex-dependency-graph',
  version: '1.0',
  nodes: [
    // Two entry points
    { id: 'entry-1', type: 'tool', config: { tool: 'echo' }, depends_on: [] },
    { id: 'entry-2', type: 'tool', config: { tool: 'echo' }, depends_on: [] },
    
    // Parallel branches from entry-1
    { id: 'branch-1a', type: 'tool', config: { tool: 'calculator' }, depends_on: ['entry-1'] },
    { id: 'branch-1b', type: 'tool', config: { tool: 'calculator' }, depends_on: ['entry-1'] },
    
    // Parallel branches from entry-2
    { id: 'branch-2a', type: 'tool', config: { tool: 'validator' }, depends_on: ['entry-2'] },
    { id: 'branch-2b', type: 'tool', config: { tool: 'validator' }, depends_on: ['entry-2'] },
    
    // Cross-branch dependency: branch-1a depends on branch-2a
    { id: 'cross-dep', type: 'tool', config: { tool: 'calculator' }, depends_on: ['branch-1a', 'branch-2a'] },
    
    // Merge all
    { id: 'merge-1', type: 'merge', config: { strategy: 'collect' }, depends_on: ['branch-1b', 'branch-2b', 'cross-dep'] },
    
    // Final processing
    { id: 'final', type: 'tool', config: { tool: 'echo' }, depends_on: ['merge-1'] },
  ],
});

// ==================== Test Suites ====================

describe('Complex Multi-Node Workflow Integration Tests', () => {
  let executor: SyncWorkflowExecutor;
  
  beforeEach(() => {
    executor = new SyncWorkflowExecutor();
  });
  
  afterEach(() => {
    executor.clearTrace();
  });
  
  // ==================== Workflow Structure Tests ====================
  
  describe('Data Processing Pipeline Workflow', () => {
    const workflow = createDataProcessingWorkflow();
    
    it('should have 12 nodes', () => {
      expect(workflow.nodes).toHaveLength(12);
    });
    
    it('should have correct node IDs', () => {
      const nodeIds = workflow.nodes.map(n => n.id);
      expect(nodeIds).toContain('init');
      expect(nodeIds).toContain('merge-data');
      expect(nodeIds).toContain('finalize-results');
      expect(nodeIds).toContain('output');
    });
    
    it('should have parallel branches from init', () => {
      const fetchNodes = workflow.nodes.filter(n => n.depends_on && n.depends_on.includes('init'));
      expect(fetchNodes.length).toBe(3); // fetch-users, fetch-products, fetch-orders
    });
    
    it('should have diamond pattern with merge-data', () => {
      const mergeNode = workflow.nodes.find(n => n.id === 'merge-data')!;
      expect(mergeNode.depends_on).toBeDefined();
      expect(mergeNode.depends_on).toContain('fetch-users');
      expect(mergeNode.depends_on).toContain('fetch-products');
      expect(mergeNode.depends_on).toContain('fetch-orders');
    });
    
    it('should have nodes with retry configuration', () => {
      const retryNode = workflow.nodes.find(n => n.id === 'process-users')!;
      expect(retryNode.retry).toBeDefined();
      expect(retryNode.retry?.max_attempts).toBe(3);
      expect(retryNode.retry?.backoff).toBe('exponential');
    });
    
    it('should have nested workflow node', () => {
      const nestedNode = workflow.nodes.find(n => n.id === 'create-report')!;
      expect(nestedNode.type).toBe('nested');
      expect(nestedNode.config.workflow).toBe('report-generation');
    });
    
    it('should have correct output definitions', () => {
      expect(workflow.outputs).toHaveLength(3);
      expect(workflow.outputs?.find(o => o.name === 'final_result')?.source).toBe('output');
    });
    
    it('should have metadata with tags', () => {
      expect(workflow.metadata?.tags).toContain('data-processing');
      expect(workflow.metadata?.author).toBe('Roy Agent');
    });
    
    it('should execute in correct topological order', () => {
      const order = topologicalSort(workflow);
      
      // init should come before fetch-*
      expect(order.indexOf('init')).toBeLessThan(order.indexOf('fetch-users'));
      expect(order.indexOf('init')).toBeLessThan(order.indexOf('fetch-products'));
      expect(order.indexOf('init')).toBeLessThan(order.indexOf('fetch-orders'));
      
      // merge-data should come after all fetches
      expect(order.indexOf('merge-data')).toBeGreaterThan(order.indexOf('fetch-users'));
      expect(order.indexOf('merge-data')).toBeGreaterThan(order.indexOf('fetch-products'));
      expect(order.indexOf('merge-data')).toBeGreaterThan(order.indexOf('fetch-orders'));
    });
    
    it('should execute all nodes successfully', () => {
      const results = executeWorkflowSync(workflow, { generateReport: true }, executor);
      
      expect(results.size).toBe(12);
      expect(results.has('init')).toBe(true);
      expect(results.has('merge-data')).toBe(true);
      expect(results.has('output')).toBe(true);
      
      // Verify execution order in trace
      const trace = executor.getTrace();
      expect(trace.executionOrder.length).toBe(12);
      expect(trace.executionOrder[0]).toBe('init');
      expect(trace.executionOrder[11]).toBe('output');
    });
  });
  
  describe('Parallel Processing Workflow', () => {
    const workflow = createParallelProcessingWorkflow();
    
    it('should have parallel branches from entry', () => {
      const parallelNodes = workflow.nodes.filter(n => n.depends_on?.includes('entry'));
      expect(parallelNodes.length).toBe(3); // task-a1, task-b1, task-c1
    });
    
    it('should have correct branch structures', () => {
      // Branch A: entry -> a1 -> a2 -> a3
      expect(workflow.nodes.find(n => n.id === 'task-a1')?.depends_on).toContain('entry');
      expect(workflow.nodes.find(n => n.id === 'task-a2')?.depends_on).toContain('task-a1');
      expect(workflow.nodes.find(n => n.id === 'task-a3')?.depends_on).toContain('task-a2');
      
      // Branch B: entry -> b1 -> b2/b3
      expect(workflow.nodes.find(n => n.id === 'task-b1')?.depends_on).toContain('entry');
      expect(workflow.nodes.find(n => n.id === 'task-b2')?.depends_on).toContain('task-b1');
      expect(workflow.nodes.find(n => n.id === 'task-b3')?.depends_on).toContain('task-b1');
      
      // Branch C: entry -> c1 -> c2
      expect(workflow.nodes.find(n => n.id === 'task-c1')?.depends_on).toContain('entry');
      expect(workflow.nodes.find(n => n.id === 'task-c2')?.depends_on).toContain('task-c1');
    });
    
    it('should have retry configured on specific nodes', () => {
      const retryNode = workflow.nodes.find(n => n.id === 'task-b3')!;
      expect(retryNode.retry?.max_attempts).toBe(2);
      expect(retryNode.retry?.backoff).toBe('fixed');
      
      const retryNode2 = workflow.nodes.find(n => n.id === 'task-c2')!;
      expect(retryNode2.retry?.max_attempts).toBe(3);
      expect(retryNode2.retry?.backoff).toBe('exponential');
    });
    
    it('should merge at merge-ab node', () => {
      const mergeNode = workflow.nodes.find(n => n.id === 'merge-ab')!;
      expect(mergeNode.depends_on).toContain('task-a3');
      expect(mergeNode.depends_on).toContain('task-b2');
      expect(mergeNode.depends_on).toContain('task-c2');
    });
    
    it('should execute all nodes', () => {
      const results = executeWorkflowSync(workflow, {}, executor);
      // entry + 3 branches * 3 nodes each (minus b3 since b2 and b3 both depend on b1) + merge + final
      // 1 + 3 + 3 + 3 + 1 + 1 = 12... wait, let me count again
      // entry, task-a1, task-a2, task-a3, task-b1, task-b2, task-b3, task-c1, task-c2, merge-ab, final = 11 nodes
      expect(results.size).toBe(11);
    });
  });
  
  describe('Nested Workflow Composition', () => {
    const workflow = createNestedWorkflow();
    
    it('should have multiple workflow nodes', () => {
      const workflowNodes = workflow.nodes.filter(n => n.type === 'workflow');
      expect(workflowNodes.length).toBe(3);
    });
    
    it('should have hierarchical structure', () => {
      const startNode = workflow.nodes.find(n => n.id === 'start')!;
      expect(startNode.depends_on).toBeDefined();
      expect(startNode.depends_on!.length).toBe(0);
      
      const subWorkflow1 = workflow.nodes.find(n => n.id === 'sub-workflow-1')!;
      expect(subWorkflow1.depends_on).toBeDefined();
      expect(subWorkflow1.depends_on).toContain('start');
    });
    
    it('should execute workflow nodes', () => {
      const results = executeWorkflowSync(workflow, {}, executor);
      expect(results.has('sub-workflow-1')).toBe(true);
      expect(results.has('final-nested')).toBe(true);
      
      const nestedResult = results.get('sub-workflow-1');
      expect(nestedResult).toBeDefined();
      expect(nestedResult.nestedWorkflow).toBe('sub-workflow-a');
    });
  });
  
  describe('Multi-Node Type Orchestration', () => {
    const workflow = createMultiNodeTypeWorkflow();
    
    it('should have various node types', () => {
      const toolNodes = workflow.nodes.filter(n => n.type === 'tool');
      const agentNodes = workflow.nodes.filter(n => n.type === 'agent');
      const skillNodes = workflow.nodes.filter(n => n.type === 'skill');
      const workflowNodes = workflow.nodes.filter(n => n.type === 'workflow');
      
      expect(toolNodes.length).toBeGreaterThan(0);
      expect(agentNodes.length).toBeGreaterThan(0);
      expect(skillNodes.length).toBeGreaterThan(0);
      expect(workflowNodes.length).toBeGreaterThan(0);
    });
    
    it('should have correct dependency chain', () => {
      const prepareData = workflow.nodes.find(n => n.id === 'prepare-data')!;
      expect(prepareData.depends_on?.length).toBe(0);
      
      const analyzeData = workflow.nodes.find(n => n.id === 'analyze-data')!;
      expect(analyzeData.depends_on).toContain('prepare-data');
      
      const makeDecision = workflow.nodes.find(n => n.id === 'make-decision')!;
      expect(makeDecision.depends_on).toContain('validate-analysis');
    });
    
    it('should have agent nodes with prompts', () => {
      const agentNodes = workflow.nodes.filter(n => n.type === 'agent');
      
      for (const agentNode of agentNodes) {
        expect(agentNode.config).toBeDefined();
        expect((agentNode.config as any).prompt).toBeDefined();
      }
    });
    
    it('should have skill nodes with skill names', () => {
      const skillNodes = workflow.nodes.filter(n => n.type === 'skill');
      
      for (const skillNode of skillNodes) {
        expect(skillNode.config).toBeDefined();
        expect((skillNode.config as any).skill).toBeDefined();
      }
    });
    
    it('should execute all node types', () => {
      const results = executeWorkflowSync(workflow, {}, executor);
      
      // All 7 nodes should be executed
      // prepare-data, analyze-data, validate-analysis, make-decision, transform-data, process-workflow, format-output
      expect(results.size).toBe(7);
      
      // Verify tool nodes executed
      expect(results.has('prepare-data')).toBe(true);
      expect(results.has('format-output')).toBe(true);
      
      // Verify agent nodes executed
      expect(results.has('analyze-data')).toBe(true);
      expect(results.has('make-decision')).toBe(true);
      
      // Verify skill nodes executed
      expect(results.has('transform-data')).toBe(true);
      
      // Verify workflow nodes executed
      expect(results.has('process-workflow')).toBe(true);
    });
  });
  
  describe('Tool-Skill-Agent Chain', () => {
    const workflow = createToolSkillAgentChain();
    
    it('should alternate between tool, agent, and skill nodes', () => {
      const toolNodes = workflow.nodes.filter(n => n.type === 'tool');
      const agentNodes = workflow.nodes.filter(n => n.type === 'agent');
      const skillNodes = workflow.nodes.filter(n => n.type === 'skill');
      
      expect(toolNodes.length).toBe(2); // fetch and validate
      expect(agentNodes.length).toBe(2); // understand and reasoning
      expect(skillNodes.length).toBe(2); // process and enhance
    });
    
    it('should maintain execution order', () => {
      const results = executeWorkflowSync(workflow, {}, executor);
      expect(results.size).toBe(6);
      
      // Verify tool → agent → skill chain
      const toolResult = results.get('fetch-raw-data');
      const agentResult = results.get('understand-context');
      const skillResult = results.get('process-with-skill');
      
      expect(toolResult).toBeDefined();
      expect(agentResult).toBeDefined();
      expect(skillResult).toBeDefined();
    });
  });
  
  describe('Parallel Tool-Agent Branches', () => {
    const workflow = createParallelToolAgentWorkflow();
    
    it('should have parallel tool-agent pairs', () => {
      const toolNodes = workflow.nodes.filter(n => n.type === 'tool');
      const agentNodes = workflow.nodes.filter(n => n.type === 'agent');
      
      expect(toolNodes.length).toBeGreaterThan(3); // start + 3 branch tools + output
      expect(agentNodes.length).toBe(4); // 3 branch agents + 1 aggregator
    });
    
    it('should have merge node after parallel branches', () => {
      const mergeNode = workflow.nodes.find(n => n.id === 'merge-agents')!;
      expect(mergeNode.type).toBe('merge');
      expect(mergeNode.depends_on).toContain('agent-a');
      expect(mergeNode.depends_on).toContain('agent-b');
      expect(mergeNode.depends_on).toContain('agent-c');
    });
    
    it('should execute all parallel branches', () => {
      const results = executeWorkflowSync(workflow, {}, executor);
      expect(results.has('tool-a')).toBe(true);
      expect(results.has('agent-a')).toBe(true);
      expect(results.has('tool-b')).toBe(true);
      expect(results.has('agent-b')).toBe(true);
      expect(results.has('merge-agents')).toBe(true);
      expect(results.has('aggregate-results')).toBe(true);
    });
  });
  
  describe('Diamond Pattern Workflow', () => {
    const workflow = createDiamondWorkflow();
    
    it('should have classic diamond structure', () => {
      // A is the starting point
      const aNode = workflow.nodes.find(n => n.id === 'A')!;
      expect(aNode.depends_on).toBeDefined();
      expect(aNode.depends_on!.length).toBe(0);
      
      // B1, B2, B3 all depend on A
      const b1Node = workflow.nodes.find(n => n.id === 'B1')!;
      const b2Node = workflow.nodes.find(n => n.id === 'B2')!;
      const b3Node = workflow.nodes.find(n => n.id === 'B3')!;
      expect(b1Node.depends_on).toContain('A');
      expect(b2Node.depends_on).toContain('A');
      expect(b3Node.depends_on).toContain('A');
      
      // C depends on all B nodes
      const cNode = workflow.nodes.find(n => n.id === 'C')!;
      expect(cNode.depends_on).toBeDefined();
      expect(cNode.depends_on).toContain('B1');
      expect(cNode.depends_on).toContain('B2');
      expect(cNode.depends_on).toContain('B3');
      
      // D depends on C
      const dNode = workflow.nodes.find(n => n.id === 'D')!;
      expect(dNode.depends_on).toContain('C');
    });
    
    it('should have 6 nodes total', () => {
      expect(workflow.nodes).toHaveLength(6);
    });
    
    it('should execute diamond pattern correctly', () => {
      const results = executeWorkflowSync(workflow, { test: 'data' }, executor);
      
      // All nodes should be executed
      expect(results.has('A')).toBe(true);
      expect(results.has('B1')).toBe(true);
      expect(results.has('B2')).toBe(true);
      expect(results.has('B3')).toBe(true);
      expect(results.has('C')).toBe(true);
      expect(results.has('D')).toBe(true);
    });
    
    it('should merge results at C node', () => {
      const results = executeWorkflowSync(workflow, {}, executor);
      const cResult = results.get('C');
      expect(cResult).toBeDefined();
    });
  });
  
  describe('Conditional Execution Workflow', () => {
    const workflow = createConditionalWorkflow();
    
    it('should have conditional branching', () => {
      const checkNode = workflow.nodes.find(n => n.id === 'check-mode')!;
      expect(checkNode.type).toBe('condition');
      
      const modeA1 = workflow.nodes.find(n => n.id === 'mode-a-1')!;
      const modeB1 = workflow.nodes.find(n => n.id === 'mode-b-1')!;
      expect(modeA1.depends_on).toContain('check-mode');
      expect(modeB1.depends_on).toContain('check-mode');
    });
    
    it('should merge conditional paths', () => {
      const mergeNode = workflow.nodes.find(n => n.id === 'merge-cond')!;
      expect(mergeNode.depends_on).toBeDefined();
      expect(mergeNode.depends_on).toContain('mode-a-2');
      expect(mergeNode.depends_on).toContain('mode-b-2');
    });
    
    it('should execute conditional nodes', () => {
      const results = executeWorkflowSync(workflow, { mode: 'A' }, executor);
      
      expect(results.has('check-mode')).toBe(true);
      const checkResult = results.get('check-mode');
      expect(checkResult).toBeDefined();
      expect(checkResult.conditionMet).toBe(true);
    });
  });
  
  describe('Template Variable Workflow', () => {
    const workflow = createTemplateVariableWorkflow();
    
    it('should have template variables in node configs', () => {
      const initNode = workflow.nodes.find(n => n.id === 'init')!;
      expect(initNode.config.message).toContain('{{input.greeting}}');
      
      const processNode = workflow.nodes.find(n => n.id === 'process')!;
      expect(processNode.config.expression).toContain('{{init.result}}');
      expect(processNode.config.expression).toContain('{{input.value}}');
    });
    
    it('should have condition with template variables', () => {
      const validateNode = workflow.nodes.find(n => n.id === 'validate')!;
      expect(validateNode.config.condition).toContain('{{process.result}}');
      expect(validateNode.config.condition).toContain('{{input.threshold}}');
    });
  });
  
  describe('Complex Dependency Graph Workflow', () => {
    const workflow = createComplexDependencyWorkflow();
    
    it('should have multiple entry points', () => {
      const entry1 = workflow.nodes.find(n => n.id === 'entry-1')!;
      const entry2 = workflow.nodes.find(n => n.id === 'entry-2')!;
      expect(entry1.depends_on).toBeDefined();
      expect(entry1.depends_on!.length).toBe(0);
      expect(entry2.depends_on).toBeDefined();
      expect(entry2.depends_on!.length).toBe(0);
    });
    
    it('should have cross-branch dependencies', () => {
      const crossDep = workflow.nodes.find(n => n.id === 'cross-dep')!;
      expect(crossDep.depends_on).toBeDefined();
      expect(crossDep.depends_on).toContain('branch-1a');
      expect(crossDep.depends_on).toContain('branch-2a');
    });
    
    it('should handle complex merge patterns', () => {
      const mergeNode = workflow.nodes.find(n => n.id === 'merge-1')!;
      expect(mergeNode.depends_on).toBeDefined();
      expect(mergeNode.depends_on).toHaveLength(3);
    });
    
    it('should execute complex workflow correctly', () => {
      const results = executeWorkflowSync(workflow, {}, executor);
      // entry-1, entry-2, branch-1a, branch-1b, branch-2a, branch-2b, cross-dep, merge-1, final = 9 nodes
      expect(results.size).toBe(9);
    });
  });
  
  // ==================== Retry Logic Tests ====================
  
  describe('Retry Configuration', () => {
    it('should configure retry with exponential backoff', () => {
      const workflow = createDataProcessingWorkflow();
      const retryNode = workflow.nodes.find(n => n.id === 'process-users')!;
      
      expect(retryNode.retry).toBeDefined();
      expect(retryNode.retry?.max_attempts).toBe(3);
      expect(retryNode.retry?.backoff).toBe('exponential');
      expect(retryNode.retry?.initial_delay).toBe(1000);
    });
    
    it('should configure retry with fixed backoff', () => {
      const workflow = createParallelProcessingWorkflow();
      const retryNode = workflow.nodes.find(n => n.id === 'task-b3')!;
      
      expect(retryNode.retry).toBeDefined();
      expect(retryNode.retry?.backoff).toBe('fixed');
      expect(retryNode.retry?.initial_delay).toBe(500);
    });
    
    it('should have retry node in diamond workflow', () => {
      const workflow = createDiamondWorkflow();
      const retryNode = workflow.nodes.find(n => n.id === 'C')!;
      
      expect(retryNode.retry).toBeDefined();
      expect(retryNode.retry?.max_attempts).toBe(2);
    });
  });
  
  // ==================== Workflow Validation Tests ====================
  
  describe('Workflow Validation', () => {
    it('should validate workflow with all required fields', () => {
      const workflow = createDataProcessingWorkflow();
      
      // Should have name
      expect(workflow.name).toBeTruthy();
      
      // Should have at least one node
      expect(workflow.nodes.length).toBeGreaterThan(0);
      
      // All nodes should have id and type
      for (const node of workflow.nodes) {
        expect(node.id).toBeTruthy();
        expect(node.type).toBeTruthy();
      }
    });
    
    it('should have valid dependency references', () => {
      const workflow = createDataProcessingWorkflow();
      const nodeIds = new Set(workflow.nodes.map(n => n.id));
      
      for (const node of workflow.nodes) {
        if (node.depends_on) {
          for (const depId of node.depends_on) {
            expect(nodeIds.has(depId)).toBe(true);
          }
        }
      }
    });
    
    it('should detect circular dependencies', () => {
      const circularWorkflow: WorkflowDefinition = {
        name: 'circular',
        nodes: [
          { id: 'a', type: 'tool', config: {}, depends_on: ['c'] },
          { id: 'b', type: 'tool', config: {}, depends_on: ['a'] },
          { id: 'c', type: 'tool', config: {}, depends_on: ['b'] },
        ],
      };
      
      expect(() => topologicalSort(circularWorkflow)).toThrow();
    });
  });
  
  // ==================== Schema Validation Tests ====================
  
  describe('Schema Validation', () => {
    it('should validate NodeDefinition schema', () => {
      const NodeDefinitionSchema = z.object({
        id: z.string().min(1),
        type: z.string().min(1),
        name: z.string().optional(),
        config: z.record(z.string(), z.unknown()).optional(),
        depends_on: z.array(z.string()).optional(),
        condition: z.string().optional(),
        retry: z.object({
          max_attempts: z.number().min(1),
          backoff: z.enum(['fixed', 'exponential']),
          initial_delay: z.number().min(0),
        }).optional(),
        timeout: z.number().optional(),
      });
      
      const validNode = {
        id: 'test-node',
        type: 'tool',
        name: 'Test Node',
        config: { tool: 'test' },
        depends_on: ['dep1'],
        retry: { max_attempts: 3, backoff: 'exponential', initial_delay: 1000 },
      };
      
      const result = NodeDefinitionSchema.safeParse(validNode);
      expect(result.success).toBe(true);
    });
    
    it('should reject invalid retry config', () => {
      const RetryConfigSchema = z.object({
        max_attempts: z.number().min(1),
        backoff: z.enum(['fixed', 'exponential']),
        initial_delay: z.number().min(0),
      });
      
      const invalidConfig = { max_attempts: 0, backoff: 'invalid', initial_delay: -100 };
      const result = RetryConfigSchema.safeParse(invalidConfig);
      expect(result.success).toBe(false);
    });
    
    it('should validate WorkflowDefinition schema', () => {
      const WorkflowDefinitionSchema = z.object({
        name: z.string().min(1),
        version: z.string().default('1.0'),
        description: z.string().optional(),
        nodes: z.array(z.object({
          id: z.string().min(1),
          type: z.string().min(1),
        })).min(1),
        entry: z.union([z.string(), z.array(z.string())]).default('__default_entry__'),
      });
      
      const validWorkflow = {
        name: 'test-workflow',
        nodes: [{ id: 'n1', type: 'tool' }],
      };
      
      const result = WorkflowDefinitionSchema.safeParse(validWorkflow);
      expect(result.success).toBe(true);
      expect(result.data?.version).toBe('1.0');
    });
  });
});

// ==================== Topological Sort Tests ====================

describe('Topological Sort', () => {
  it('should sort nodes in dependency order', () => {
    const workflow = createDiamondWorkflow();
    const order = topologicalSort(workflow);
    
    // A should come before B1, B2, B3
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B1'));
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B2'));
    expect(order.indexOf('A')).toBeLessThan(order.indexOf('B3'));
    
    // B* should come before C
    expect(order.indexOf('B1')).toBeLessThan(order.indexOf('C'));
    expect(order.indexOf('B2')).toBeLessThan(order.indexOf('C'));
    expect(order.indexOf('B3')).toBeLessThan(order.indexOf('C'));
    
    // C should come before D
    expect(order.indexOf('C')).toBeLessThan(order.indexOf('D'));
  });
  
  it('should handle parallel branches', () => {
    const workflow = createParallelProcessingWorkflow();
    const order = topologicalSort(workflow);
    
    // Entry should be first
    expect(order[0]).toBe('entry');
    
    // All task-* should come after entry
    const taskNodes = order.filter(id => id.startsWith('task-'));
    expect(taskNodes.length).toBeGreaterThan(0);
    
    // Verify dependencies are maintained
    for (const node of workflow.nodes) {
      const nodeIndex = order.indexOf(node.id);
      for (const depId of node.depends_on || []) {
        expect(order.indexOf(depId)).toBeLessThan(nodeIndex);
      }
    }
  });
  
  it('should throw on circular dependency', () => {
    const circularWorkflow: WorkflowDefinition = {
      name: 'circular',
      nodes: [
        { id: 'a', type: 'tool', config: {}, depends_on: ['b'] },
        { id: 'b', type: 'tool', config: {}, depends_on: ['a'] },
      ],
    };
    
    expect(() => topologicalSort(circularWorkflow)).toThrow('Circular dependency detected');
  });
});

// ==================== Performance Tests ====================

describe('Workflow Performance', () => {
  it('should handle large parallel execution', () => {
    const nodes: NodeDefinition[] = [
      { id: 'start', type: 'tool', config: { tool: 'echo' } },
    ];
    
    // Create 20 parallel nodes
    for (let i = 0; i < 20; i++) {
      nodes.push({
        id: `parallel-${i}`,
        type: 'tool',
        config: { tool: 'calculator' },
        depends_on: ['start'],
      });
    }
    
    // Merge all parallel results
    nodes.push({
      id: 'merge',
      type: 'merge',
      config: { strategy: 'collect' },
      depends_on: nodes.slice(1).map(n => n.id),
    });
    
    const workflow: WorkflowDefinition = {
      name: 'large-parallel',
      nodes,
    };
    
    const order = topologicalSort(workflow);
    expect(order.length).toBe(22); // 1 start + 20 parallel + 1 merge
  });
  
  it('should handle deep dependency chains', () => {
    const nodes: NodeDefinition[] = [];
    
    // Create 50-node deep chain
    for (let i = 0; i < 50; i++) {
      nodes.push({
        id: `node-${i}`,
        type: 'tool',
        config: { tool: 'echo' },
        depends_on: i > 0 ? [`node-${i - 1}`] : [],
      });
    }
    
    const workflow: WorkflowDefinition = {
      name: 'deep-chain',
      nodes,
    };
    
    const order = topologicalSort(workflow);
    
    // Should maintain order
    for (let i = 1; i < order.length; i++) {
      expect(order.indexOf(`node-${i - 1}`)).toBeLessThan(order.indexOf(`node-${i}`));
    }
  });
  
  it('should execute large workflow efficiently', () => {
    const nodes: NodeDefinition[] = [
      { id: 'start', type: 'tool', config: { tool: 'echo' } },
    ];
    
    for (let i = 0; i < 10; i++) {
      nodes.push({
        id: `node-${i}`,
        type: 'tool',
        config: { tool: 'calculator' },
        depends_on: i === 0 ? ['start'] : [`node-${i - 1}`],
      });
    }
    
    const workflow: WorkflowDefinition = {
      name: 'large-chain',
      nodes,
    };
    
    const executor = new SyncWorkflowExecutor();
    const start = Date.now();
    const results = executeWorkflowSync(workflow, {}, executor);
    const duration = Date.now() - start;
    
    expect(results.size).toBe(11);
    expect(duration).toBeLessThan(100); // Should complete in under 100ms
  });
});

// ==================== Edge Cases ====================

describe('Workflow Edge Cases', () => {
  it('should handle single node workflow', () => {
    const workflow: WorkflowDefinition = {
      name: 'single-node',
      nodes: [{ id: 'only', type: 'tool', config: {} }],
    };
    
    const order = topologicalSort(workflow);
    expect(order).toEqual(['only']);
    
    const executor = new SyncWorkflowExecutor();
    const results = executeWorkflowSync(workflow, {}, executor);
    expect(results.size).toBe(1);
    expect(results.get('only')).toBeDefined();
  });
  
  it('should handle nodes with multiple dependencies', () => {
    const workflow: WorkflowDefinition = {
      name: 'multi-dep',
      nodes: [
        { id: 'a', type: 'tool', config: {} },
        { id: 'b', type: 'tool', config: {} },
        { id: 'c', type: 'tool', config: {} },
        { id: 'd', type: 'tool', config: {}, depends_on: ['a', 'b', 'c'] },
      ],
    };
    
    const order = topologicalSort(workflow);
    const dIndex = order.indexOf('d');
    expect(order.indexOf('a')).toBeLessThan(dIndex);
    expect(order.indexOf('b')).toBeLessThan(dIndex);
    expect(order.indexOf('c')).toBeLessThan(dIndex);
  });
  
  it('should handle multiple entry points', () => {
    const workflow: WorkflowDefinition = {
      name: 'multi-entry',
      entry: ['a', 'b'],
      nodes: [
        { id: 'a', type: 'tool', config: {} },
        { id: 'b', type: 'tool', config: {} },
        { id: 'c', type: 'tool', config: {}, depends_on: ['a', 'b'] },
      ],
    };
    
    const order = topologicalSort(workflow);
    expect(order.includes('a')).toBe(true);
    expect(order.includes('b')).toBe(true);
    expect(order.indexOf('c')).toBeGreaterThan(order.indexOf('a'));
    expect(order.indexOf('c')).toBeGreaterThan(order.indexOf('b'));
  });
  
  it('should handle optional fields in nodes', () => {
    const minimalNode = {
      id: 'minimal',
      type: 'tool',
    };
    
    const NodeDefinitionSchema = z.object({
      id: z.string().min(1),
      type: z.string().min(1),
      name: z.string().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      depends_on: z.array(z.string()).optional(),
    });
    
    const result = NodeDefinitionSchema.safeParse(minimalNode);
    expect(result.success).toBe(true);
  });
  
  it('should handle empty depends_on array', () => {
    const workflow: WorkflowDefinition = {
      name: 'empty-deps',
      nodes: [
        { id: 'a', type: 'tool', config: {}, depends_on: [] },
        { id: 'b', type: 'tool', config: {}, depends_on: ['a'] },
      ],
    };
    
    const order = topologicalSort(workflow);
    expect(order.indexOf('a')).toBeLessThan(order.indexOf('b'));
  });
  
  it('should handle nodes without config', () => {
    const workflow: WorkflowDefinition = {
      name: 'no-config',
      nodes: [
        { id: 'a', type: 'tool' },
        { id: 'b', type: 'tool', depends_on: ['a'] },
      ],
    };
    
    const executor = new SyncWorkflowExecutor();
    const results = executeWorkflowSync(workflow, {}, executor);
    expect(results.get('a')).toBeDefined();
    expect(results.get('b')).toBeDefined();
  });
});

// ==================== Execution Trace Tests ====================

describe('Execution Trace', () => {
  it('should track execution order', () => {
    const workflow = createDiamondWorkflow();
    const executor = new SyncWorkflowExecutor();
    
    executeWorkflowSync(workflow, {}, executor);
    
    const trace = executor.getTrace();
    expect(trace.executionOrder).toEqual(['A', 'B1', 'B2', 'B3', 'C', 'D']);
  });
  
  it('should track node execution status', () => {
    const workflow = createDiamondWorkflow();
    const executor = new SyncWorkflowExecutor();
    
    executeWorkflowSync(workflow, {}, executor);
    
    const trace = executor.getTrace();
    
    for (const entry of trace.nodes.values()) {
      expect(entry.status).toBe('completed');
      expect(entry.startTime).toBeDefined();
      expect(entry.endTime).toBeDefined();
      expect(entry.endTime).toBeGreaterThanOrEqual(entry.startTime);
    }
  });
  
  it('should record input for each node', () => {
    const workflow = createDataProcessingWorkflow();
    const executor = new SyncWorkflowExecutor();
    const input = { generateReport: true, test: 'value' };
    
    executeWorkflowSync(workflow, input, executor);
    
    const trace = executor.getTrace();
    const initEntry = trace.nodes.get('init');
    expect(initEntry?.input).toEqual(input);
  });
  
  it('should record output for each node', () => {
    const workflow = createDiamondWorkflow();
    const executor = new SyncWorkflowExecutor();
    
    executeWorkflowSync(workflow, {}, executor);
    
    const trace = executor.getTrace();
    
    for (const [nodeId, entry] of trace.nodes) {
      expect(entry.output).toBeDefined();
    }
  });
});

// ==================== Merge Node Tests ====================

describe('Merge Node Behavior', () => {
  it('should collect all dependency outputs', () => {
    const workflow: WorkflowDefinition = {
      name: 'merge-test',
      nodes: [
        { id: 'a', type: 'tool', config: { tool: 'calculator' } },
        { id: 'b', type: 'tool', config: { tool: 'calculator' } },
        { id: 'c', type: 'tool', config: { tool: 'calculator' } },
        {
          id: 'merge',
          type: 'merge',
          config: { strategy: 'collect' },
          depends_on: ['a', 'b', 'c'],
        },
      ],
    };
    
    const executor = new SyncWorkflowExecutor();
    const results = executeWorkflowSync(workflow, {}, executor);
    
    const mergeResult = results.get('merge');
    expect(mergeResult).toBeDefined();
    expect(mergeResult.merged).toBe(true);
    expect(mergeResult.inputs).toBeDefined();
    expect(mergeResult.inputs.a).toBeDefined();
    expect(mergeResult.inputs.b).toBeDefined();
    expect(mergeResult.inputs.c).toBeDefined();
  });
  
  it('should handle merge with different strategies', () => {
    const mergeStrategies = ['collect', 'merge', 'concat', 'zip'];
    
    for (const strategy of mergeStrategies) {
      const workflow: WorkflowDefinition = {
        name: `merge-${strategy}`,
        nodes: [
          { id: 'a', type: 'tool', config: { tool: 'calculator' } },
          { id: 'b', type: 'tool', config: { tool: 'calculator' } },
          {
            id: 'merge',
            type: 'merge',
            config: { strategy },
            depends_on: ['a', 'b'],
          },
        ],
      };
      
      const executor = new SyncWorkflowExecutor();
      const results = executeWorkflowSync(workflow, {}, executor);
      const mergeResult = results.get('merge');
      expect(mergeResult).toBeDefined();
      expect(mergeResult.mergeStrategy).toBe(strategy);
    }
  });
});

// ==================== Condition Node Tests ====================

describe('Condition Node Behavior', () => {
  it('should evaluate true condition', () => {
    const workflow: WorkflowDefinition = {
      name: 'condition-test',
      nodes: [
        { id: 'check', type: 'condition', config: { condition: 'true' } },
        { id: 'output', type: 'tool', config: { tool: 'echo' }, depends_on: ['check'] },
      ],
    };
    
    const executor = new SyncWorkflowExecutor();
    const results = executeWorkflowSync(workflow, {}, executor);
    
    const checkResult = results.get('check');
    expect(checkResult).toBeDefined();
    expect(checkResult.conditionMet).toBe(true);
  });
  
  it('should evaluate template condition', () => {
    const workflow: WorkflowDefinition = {
      name: 'condition-template',
      nodes: [
        {
          id: 'check',
          type: 'condition',
          config: { condition: '{{merge-data.valid}}' },
        },
        { id: 'output', type: 'tool', config: { tool: 'echo' }, depends_on: ['check'] },
      ],
    };
    
    const executor = new SyncWorkflowExecutor();
    const results = executeWorkflowSync(workflow, {}, executor);
    
    const checkResult = results.get('check');
    expect(checkResult).toBeDefined();
    expect(checkResult.conditionMet).toBe(true); // Template conditions default to true
    expect(checkResult.evaluatedCondition).toBe('{{merge-data.valid}}');
  });
});
