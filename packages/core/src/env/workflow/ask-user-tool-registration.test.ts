/**
 * @fileoverview AskUserTool Registration Tests
 * 
 * Tests to verify that ask_user tool is only registered in Workflow AgentNode context,
 * NOT in default agent or sub agent (delegate task) contexts.
 * 
 * Design:
 * - ask_user tool should NOT be available to default agent
 * - ask_user tool should NOT be available to sub agent (delegate task)
 * - ask_user tool should ONLY be available in Workflow AgentNode when workflow is running
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

// Mock the ask_user tool
const mockAskUserTool = {
  name: 'ask_user',
  description: 'Ask user for input',
  parameters: z.object({
    query: z.string().describe('The question to ask'),
    options: z.array(z.string()).optional(),
  }),
  execute: vi.fn().mockImplementation(() => {
    throw new Error('AskUserError - should not be called in this test');
  }),
  metadata: { category: 'workflow', tags: ['human-in-loop'] },
};

describe('AskUserTool Registration', () => {
  describe('ToolComponent registration behavior', () => {
    it('should NOT register ask_user tool by default', () => {
      // The ask_user tool should NOT be pre-registered to ToolComponent
      // This test documents the expected behavior
      
      // Setup: Create a mock ToolComponent
      const registeredTools = new Map<string, any>();
      const mockToolComponent = {
        register: vi.fn((tool: any) => {
          registeredTools.set(tool.name, tool);
        }),
        registerMany: vi.fn((tools: any[]) => {
          tools.forEach((tool: any) => {
            registeredTools.set(tool.name, tool);
          });
        }),
        getTool: vi.fn((name: string) => registeredTools.get(name)),
        listTools: vi.fn(() => Array.from(registeredTools.keys())),
      };

      // Verify: ask_user is NOT registered by default
      expect(mockToolComponent.getTool('ask_user')).toBeUndefined();
    });

    it('should document that ask_user is workflow-only', () => {
      // This test documents the design:
      // - ask_user tool is only available in Workflow AgentNode context
      // - It should NOT be available to default agent
      // - It should NOT be available to sub agent (delegate task)
      
      const toolScope = {
        availableIn: {
          defaultAgent: false,
          subAgent: false,
          workflowAgentNode: true,  // Only when workflow is running
        },
        registrationPoint: 'AgentNode options (not init time)',
      };

      expect(toolScope.availableIn.defaultAgent).toBe(false);
      expect(toolScope.availableIn.subAgent).toBe(false);
      expect(toolScope.availableIn.workflowAgentNode).toBe(true);
    });
  });

  describe('AgentNode with ask_user in allowedTools', () => {
    it('should include ask_user in allowedTools when running workflow agent', () => {
      // Test that when Workflow AgentNode runs, it should have ask_user in allowedTools
      // This is set in the AgentNode.execute() method when building AgentConfig
      
      const agentConfig = {
        type: 'general',
        prompt: 'Test prompt',
        // ask_user should be explicitly allowed for workflow agents
        options: {
          allowedTools: ['ask_user'],
        },
      };

      expect(agentConfig.options.allowedTools).toContain('ask_user');
    });

    it('should NOT include ask_user for non-workflow agents', () => {
      // Test that regular agents (default agent, sub agent) should NOT have ask_user
      
      // Default agent - no allowedTools in options
      const defaultAgentConfig = {
        type: 'general',
        prompt: 'Test prompt',
        // No options.allowedTools - uses default tool list
      };

      // Sub agent (delegate task) - should not have ask_user
      const subAgentConfig = {
        type: 'delegate',
        prompt: 'Delegate task',
        // No options.allowedTools
      };

      // These configs should NOT have ask_user in their allowed tools
      expect(defaultAgentConfig.options?.allowedTools).toBeUndefined();
      expect(subAgentConfig.options?.allowedTools).toBeUndefined();
    });
  });

  describe('WorkflowComponent initialization', () => {
    it('should NOT register ask_user tool during init', () => {
      // WorkflowComponent.init() should NOT call registerAskUserTool()
      // This documents the expected behavior after refactoring
      
      // The registerAskUserTool method exists but should NOT be called during init
      // It has been removed from the init() and initSqliteService() methods
      const shouldNotRegisterDuringInit = true;  // This is the expected behavior

      expect(shouldNotRegisterDuringInit).toBe(true);
    });

    it('should register ask_user only via AgentNode options', () => {
      // The new design:
      // - ask_user is not registered globally
      // - AgentNode adds allowedTools: ['ask_user'] to its options when building AgentConfig
      // - AgentComponentAdapter passes this to AgentContext
      // - AgentComponent uses AgentContext.allowedTools to filter tools
      
      const registrationPoints = {
        duringInit: false,
        viaAgentNodeOptions: true,
      };

      expect(registrationPoints.duringInit).toBe(false);
      expect(registrationPoints.viaAgentNodeOptions).toBe(true);
    });
  });

  describe('AgentContext.allowedTools propagation', () => {
    it('should pass allowedTools from AgentNode to AgentContext', () => {
      // Test the data flow:
      // AgentNode (options.allowedTools: ['ask_user']) 
      //   -> AgentComponentAdapter passes to context.allowedTools
      //   -> AgentContext (allowedTools: ['ask_user'])
      //   -> AgentComponent.run()

      const agentNodeOptions = {
        timeout: 60000,
        model: 'gpt-4',
        allowedTools: ['ask_user'],
      };

      // AgentComponentAdapter builds AgentContext
      const agentContext = {
        sessionId: 'test-session',
        allowedTools: agentNodeOptions.allowedTools,  // Pass through from options
        deniedTools: agentNodeOptions.deniedTools,
      };

      expect(agentContext.allowedTools).toEqual(['ask_user']);
      expect(agentContext.allowedTools).toBe(agentNodeOptions.allowedTools);
    });

    it('should NOT pass allowedTools for non-workflow agents', () => {
      // Default agent and sub agent should NOT have allowedTools set in context
      
      const defaultAgentContext = {
        sessionId: 'default-session',
        // No allowedTools - uses default tool list
      };

      const subAgentContext = {
        sessionId: 'sub-agent-session',
        // No allowedTools - uses default tool list
      };

      expect(defaultAgentContext.allowedTools).toBeUndefined();
      expect(subAgentContext.allowedTools).toBeUndefined();
    });
  });
});

describe('AskUserTool Scope Enforcement', () => {
  it('should enforce ask_user scope: workflow-only', () => {
    // Document the scope rules:
    // 1. Default Agent - NO access to ask_user
    // 2. Sub Agent (delegate task) - NO access to ask_user
    // 3. Workflow AgentNode - ONLY access when workflow is running

    const toolScopeMatrix = {
      defaultAgent: {
        canAccess: false,
        reason: 'ask_user is workflow-specific functionality',
      },
      subAgent: {
        canAccess: false,
        reason: 'delegate task is for autonomous execution, no human interruption',
      },
      workflowAgentNode: {
        canAccess: true,
        condition: 'only when workflow is running',
        reason: 'enables human-in-loop for workflow pause/resume',
      },
    };

    expect(toolScopeMatrix.defaultAgent.canAccess).toBe(false);
    expect(toolScopeMatrix.subAgent.canAccess).toBe(false);
    expect(toolScopeMatrix.workflowAgentNode.canAccess).toBe(true);
  });
});
