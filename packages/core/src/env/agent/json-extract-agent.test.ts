/**
 * @fileoverview Tests for json-extract built-in agent
 *
 * Verifies:
 * - The 'json-extract' prompt exists in prompts-index.ts and contains the right keywords
 * - registerJsonExtractAgent() registers an agent with the correct configuration
 * - The agent's systemPromptRef resolves to the json-extract prompt
 */

import { describe, it, expect } from 'bun:test';
import { getBuiltInPrompt, builtInPrompts } from '../prompt/prompts-index';
import { AgentRegistry } from './agent-registry';

describe('json-extract built-in agent', () => {
  describe('prompts-index.ts', () => {
    it('should export "json-extract" prompt', () => {
      expect(builtInPrompts['json-extract']).toBeDefined();
      expect(typeof builtInPrompts['json-extract']).toBe('string');
    });

    it('should mention the workflow_submit_output tool', () => {
      const prompt = builtInPrompts['json-extract'];
      expect(prompt).toContain('workflow_submit_output');
    });

    it('should mention sessionId / session history', () => {
      const prompt = builtInPrompts['json-extract'];
      expect(prompt.toLowerCase()).toMatch(/session/);
    });

    it('should prohibit JSON code blocks (```)', () => {
      const prompt = builtInPrompts['json-extract'];
      // The prompt should explicitly say not to use ```json blocks
      expect(prompt).toMatch(/json.*代码块|```json|code block/i);
    });

    it('should prohibit plain text responses', () => {
      const prompt = builtInPrompts['json-extract'];
      expect(prompt.toLowerCase()).toMatch(/普通文本|plain text|不要.*回答/);
    });

    it('should be accessible via getBuiltInPrompt("json-extract")', () => {
      const prompt = getBuiltInPrompt('json-extract');
      expect(prompt).toBeDefined();
      expect(prompt).toBe(builtInPrompts['json-extract']);
    });
  });

  describe('registerJsonExtractAgent()', () => {
    it('should register "json-extract" agent with correct configuration', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });

      registry.registerJsonExtractAgent();

      const agent = registry.get('json-extract');
      expect(agent).toBeDefined();
      expect(agent?.name).toBe('json-extract');
      expect(agent?.type).toBe('sub');
      expect(agent?.systemPromptRef).toBe('json-extract');
      expect(agent?.maxIterations).toBe(5);
      expect(agent?.filterHistory).toBe(false);
    });

    it('should restrict allowedTools to workflow_submit_output only', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });

      registry.registerJsonExtractAgent();

      const agent = registry.get('json-extract');
      expect(agent?.allowedTools).toEqual(['workflow_submit_output']);
    });

    it('should be idempotent (no-op on double registration)', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });

      registry.registerJsonExtractAgent();
      registry.registerJsonExtractAgent();

      // Should still have exactly one entry
      const agents = registry.list();
      const extractAgents = agents.filter((a) => a.name === 'json-extract');
      expect(extractAgents).toHaveLength(1);
    });

    it('should resolve systemPrompt from builtInPrompts', () => {
      const registry = new AgentRegistry({
        configComponent: null,
        promptComponent: null,
      });

      registry.registerJsonExtractAgent();

      // Manually resolve the system prompt via the built-in
      const builtIn = getBuiltInPrompt('json-extract');
      expect(builtIn).toBeDefined();

      // The agent's systemPromptRef should be 'json-extract'
      const agent = registry.get('json-extract');
      expect(agent?.systemPromptRef).toBe('json-extract');
    });
  });
});
