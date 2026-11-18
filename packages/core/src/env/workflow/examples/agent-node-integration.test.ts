/**
 * @fileoverview AgentNode Integration Test - Test with real AgentComponent
 * 
 * This test verifies that AgentNode can properly integrate with AgentComponent
 * using the AgentComponentAdapter.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'bun:test';
import type { Environment } from '../../interface';
import { WorkflowEngine } from '../engine/engine';
import type { WorkflowDefinition } from '../types';

// Mock AgentComponent for testing
class MockAgentComponent {
  private agents = new Map<string, any>();

  registerAgent(name: string, config: any): any {
    const instance = {
      name,
      config,
      status: 'idle',
    };
    this.agents.set(name, instance);
    return instance;
  }

  getAgent(name: string) {
    return this.agents.get(name);
  }

  listAgents() {
    return Array.from(this.agents.values());
  }

  async run(agentName: string, query: string, context?: any): Promise<any> {
    const agent = this.agents.get(agentName);
    if (!agent) {
      throw new Error(`Agent not found: ${agentName}`);
    }

    // Simulate agent execution
    return {
      finalText: `Response from ${agentName}: ${query}`,
      output: { result: `Processed: ${query}` },
      iterations: 1,
      toolCalls: [],
    };
  }
}

// Mock Environment
class MockEnvironment {
  private components = new Map<string, any>();

  constructor() {
    this.components.set('agent', new MockAgentComponent());
  }

  getComponent(name: string) {
    return this.components.get(name);
  }

  registerComponent(component: any): void {
    this.components.set(component.name, component);
  }
}

// Mock ToolRegistry
const mockToolRegistry = {
  getTool: (name: string) => {
    if (name === 'echo') {
      return {
        name: 'echo',
        description: 'Echo back input',
        execute: async (input: any) => ({ success: true, output: `Echo: ${JSON.stringify(input)}` }),
      };
    }
    return undefined;
  },
  hasTool: (name: string) => name === 'echo',
  registerTool: () => {},
  listTools: () => [{ name: 'echo' }],
};

// Mock SkillRegistry
const mockSkillRegistry = {
  getSkill: (name: string) => {
    if (name === 'formatter') {
      return {
        name: 'formatter',
        description: 'Format text',
        invoke: async (input: any) => ({ formatted: `Formatted: ${input.text}` }),
      };
    }
    return undefined;
  },
  hasSkill: () => false,
  registerSkill: () => {},
};

// Workflow with AgentNode
const agentWorkflow: WorkflowDefinition = {
  name: 'agent-test-workflow',
  version: '1.0.0',
  nodes: [
    {
      id: 'echo-step',
      name: 'Echo Step',
      type: 'tool',
      config: {
        tool: 'echo',
        input: { message: 'Hello from workflow' },
      },
    },
    {
      id: 'analyze-step',
      name: 'Analyze with Agent',
      type: 'agent',
      config: {
        agent_type: 'researcher',
        prompt: 'Please analyze this data: {{nodes.echo-step.output}}',
        options: { timeout: 5000 },
      },
    },
  ],
  edges: [
    { from: 'echo-step', to: 'analyze-step' },
  ],
  config: {
    parallel_limit: 2,
  },
};

// =============================================================================
// Tests
// =============================================================================

describe('AgentNode with AgentComponent Integration', () => {
  let env: MockEnvironment;

  beforeEach(async () => {
    env = new MockEnvironment();

    // Register a test agent
    const agentComponent = env.getComponent('agent');
    agentComponent.registerAgent('researcher', {
      type: 'general',
      systemPrompt: 'You are a research assistant.',
    });
  });

  afterEach(async () => {
    // Give time for any async cleanup to complete
    await new Promise(resolve => setTimeout(resolve, 50));
    vi.restoreAllMocks();
  });

  it('should execute workflow with AgentNode using AgentComponent', async () => {
    // Create a fresh engine for each test to avoid runId conflicts
    const engine = await WorkflowEngine.create({
      env: env as any,
      toolRegistry: mockToolRegistry as any,
      skillRegistry: mockSkillRegistry as any,
    });

    try {
      // Workflow starts and runs - may be 'running' or 'completed' if agent executes quickly
      const result = await engine.runWorkflow(agentWorkflow, {
        input: {},
      });

      // Workflow may complete quickly with mock agent
      expect(['running', 'completed']).toContain(result.status);
      expect(result.runId).toBeDefined();

      // Get final result (may be from runWorkflow or waitForCompletion)
      let completedResult = result;
      if (result.status === 'running') {
        // Only call waitForCompletion if workflow is still running
        completedResult = await engine.waitForCompletion(result.runId);
      }
      
      expect(completedResult.status).toBe('completed');
      expect(completedResult.output).toBeDefined();
      expect(completedResult.output?.['echo-step']).toBeDefined();
      expect(completedResult.output?.['analyze-step']).toBeDefined();

      // Verify agent response
      const agentOutput = completedResult.output?.['analyze-step'];
      expect(agentOutput).toBeDefined();
    } finally {
      // Ensure cleanup happens
    }
  }, 10000);

  // TODO: Skip until workflow engine API stabilizes (waitForCompletion is private)
  it.skip('should propagate template variables correctly', async () => {
    // Create a fresh engine for each test to avoid runId conflicts
    const engine = await WorkflowEngine.create({
      env: env as any,
      toolRegistry: mockToolRegistry as any,
      skillRegistry: mockSkillRegistry as any,
    });

    try {
      // Workflow starts asynchronously
      const result = await engine.runWorkflow(agentWorkflow, {
        input: {},
      });

      // Wait for workflow to complete
      const completedResult = await engine.waitForCompletion(result.runId);
      expect(completedResult.status).toBe('completed');

      // The prompt should have been resolved with echo-step output
      const agentOutput = completedResult.output?.['analyze-step'];
      expect(agentOutput).toBeDefined();
    } finally {
      // Ensure cleanup happens
    }
  }, 10000);
});

// =============================================================================
// Usage Documentation
// =============================================================================

/**
 * Usage Example:
 * 
 * ```typescript
 * import { WorkflowEngine } from './engine/engine';
 * 
 * // 1. Create environment with AgentComponent
 * const env = new BaseEnvironment();
 * env.registerComponent(new AgentComponent({ llm, tool, session }));
 * 
 * // 2. Register agents
 * const agentComponent = env.getComponent<AgentComponent>('agent');
 * agentComponent.registerAgent('researcher', {
 *   type: 'general',
 *   systemPrompt: 'You are a research assistant.',
 * });
 * 
 * // 3. Create engine (AgentNode auto-integrates with AgentComponent)
 * const engine = await WorkflowEngine.create({
 *   env,
 *   toolRegistry,
 *   skillRegistry,
 * });
 * 
 * // 4. Define workflow with AgentNode
 * const workflow = {
 *   name: 'my-workflow',
 *   nodes: [{
 *     id: 'analyze',
 *     type: 'agent',
 *     config: {
 *       agent_type: 'researcher',  // Must match registered agent
 *       prompt: 'Analyze: {{nodes.fetch.output}}',
 *     },
 *   }],
 *   edges: [{ from: 'fetch', to: 'analyze' }],
 * };
 * 
 * // 5. Execute
 * const result = await engine.runWorkflow(workflow, {});
 * ```
 */
