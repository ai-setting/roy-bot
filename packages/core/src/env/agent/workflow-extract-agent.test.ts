/**
 * @fileoverview Tests for workflow-extract built-in agent
 *
 * Verifies:
 * - The 'workflow-extract' prompt exists in prompts-index.ts
 * - registerWorkflowExtractAgent() registers an agent with correct configuration
 * - Allowed tools cover the workflow CRUD + validation workflow
 */

import { describe, it, expect } from 'bun:test';
import { getBuiltInPrompt, builtInPrompts } from '../prompt/prompts-index';
import { AgentRegistry } from './agent-registry';

describe('workflow-extract built-in agent', () => {
  describe('prompts-index.ts', () => {
    it('should export "workflow-extract" prompt', () => {
      expect(builtInPrompts['workflow-extract']).toBeDefined();
      expect(typeof builtInPrompts['workflow-extract']).toBe('string');
    });

    it('should mention workflow_get tool', () => {
      const prompt = builtInPrompts['workflow-extract'];
      expect(prompt).toContain('workflow_get');
    });

    it('should mention workflow_validate tool', () => {
      const prompt = builtInPrompts['workflow-extract'];
      expect(prompt).toContain('workflow_validate');
    });

    it('should mention workflow_add tool', () => {
      const prompt = builtInPrompts['workflow-extract'];
      expect(prompt).toContain('workflow_add');
    });

    it('should describe the iterative validate-add loop', () => {
      const prompt = builtInPrompts['workflow-extract'];
      // Must instruct agent to validate before adding
      expect(prompt.toLowerCase()).toMatch(/validate.*add|add.*validate|iterative|迭代/);
    });

    it('should be accessible via getBuiltInPrompt("workflow-extract")', () => {
      const prompt = getBuiltInPrompt('workflow-extract');
      expect(prompt).toBeDefined();
      expect(prompt).toBe(builtInPrompts['workflow-extract']);
    });
  });

  describe('registerWorkflowExtractAgent()', () => {
    it('should register "workflow-extract" agent with correct configuration', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });

      registry.registerWorkflowExtractAgent();

      const agent = registry.get('workflow-extract');
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('workflow-extract');
      expect(agent?.type).toBe('sub');
      expect(agent?.systemPromptRef).toBe('workflow-extract');
    });

    it('should restrict allowedTools to workflow tools only', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });

      registry.registerWorkflowExtractAgent();

      const agent = registry.get('workflow-extract');
      expect(agent?.allowedTools).toEqual([
        'workflow_get',
        'workflow_list',
        'workflow_add',
        'workflow_validate',
      ]);
    });

    it('should have maxIterations=10 for generate-validate-fix loop', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });

      registry.registerWorkflowExtractAgent();

      const agent = registry.get('workflow-extract');
      expect(agent?.maxIterations).toBe(10);
    });

    it('should have filterHistory=false to read parent session', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });

      registry.registerWorkflowExtractAgent();

      const agent = registry.get('workflow-extract');
      expect(agent?.filterHistory).toBe(false);
    });

    it('should be idempotent (no-op on double registration)', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });

      registry.registerWorkflowExtractAgent();
      registry.registerWorkflowExtractAgent();

      const agents = registry.list();
      const extractAgents = agents.filter((a) => a.name === 'workflow-extract');
      expect(extractAgents).toHaveLength(1);
    });
  });
});
