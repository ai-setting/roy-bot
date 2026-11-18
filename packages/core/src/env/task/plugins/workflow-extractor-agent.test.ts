/**
 * @fileoverview Workflow Extractor Agent Tests (TDD)
 *
 * RED Phase: Tests for workflow-extractor-agent prompt content
 * These tests verify the prompt includes the required validation reminder.
 *
 * 升级说明（v2）：
 * - prompt 内容已迁移到 prompts-index.ts 的 builtInPrompts['workflow-extract']
 * - WORKFLOW_EXTRACTOR_PROMPT 保留为 alias（向后兼容）
 * - createWorkflowExtractorAgent 函数已删除（由 AgentRegistry.registerWorkflowExtractAgent 替代）
 */

import { describe, it, expect } from 'bun:test';
import { WORKFLOW_EXTRACTOR_PROMPT } from './workflow-extractor-agent';
import { WORKFLOW_EXTRACT_PROMPT, builtInPrompts } from '../../prompt/prompts-index';

describe('Workflow Extractor Agent Prompt', () => {
  describe('validation reminder', () => {
    it('should include workflow_validate tool reference in prompt', () => {
      expect(WORKFLOW_EXTRACTOR_PROMPT).toContain('workflow_validate');
    });

    it('should include validation check instructions', () => {
      expect(WORKFLOW_EXTRACTOR_PROMPT).toContain('验证');
    });

    it('should instruct to use validate before adding', () => {
      expect(WORKFLOW_EXTRACTOR_PROMPT).toContain('workflow_add');
    });

    it('should include build workflow flow', () => {
      expect(WORKFLOW_EXTRACTOR_PROMPT).toContain('构建');
    });

    it('should include node type information', () => {
      expect(WORKFLOW_EXTRACTOR_PROMPT).toContain('type: tool|skill|agent');
    });

    it('should include workflow examples command', () => {
      expect(WORKFLOW_EXTRACTOR_PROMPT).toContain('workflow_list');
    });

    it('should include workflow get command', () => {
      expect(WORKFLOW_EXTRACTOR_PROMPT).toContain('workflow_get');
    });
  });

  describe('prompt structure', () => {
    it('should have extraction principles section', () => {
      expect(WORKFLOW_EXTRACTOR_PROMPT).toContain('构建原则');
    });

    it('should have output requirements section', () => {
      expect(WORKFLOW_EXTRACTOR_PROMPT).toContain('YAML');
    });

    it('should have limitations section', () => {
      expect(WORKFLOW_EXTRACTOR_PROMPT).toContain('禁止');
    });

    it('should mention YAML output format', () => {
      expect(WORKFLOW_EXTRACTOR_PROMPT).toContain('yaml');
    });

    it('should mention validation is required before output', () => {
      expect(WORKFLOW_EXTRACTOR_PROMPT).toContain('workflow_validate');
    });
  });
});

describe('WorkflowExtractorAgent backward compat', () => {
  it('should re-export WORKFLOW_EXTRACTOR_PROMPT from prompts-index', async () => {
    const { WORKFLOW_EXTRACTOR_PROMPT } = await import('./workflow-extractor-agent');
    expect(WORKFLOW_EXTRACTOR_PROMPT).toBeDefined();
    expect(WORKFLOW_EXTRACTOR_PROMPT).toBe(WORKFLOW_EXTRACT_PROMPT);
    expect(WORKFLOW_EXTRACTOR_PROMPT).toBe(builtInPrompts['workflow-extract']);
  });

  it('should NOT export createWorkflowExtractorAgent (removed in v2)', async () => {
    const mod = await import('./workflow-extractor-agent') as Record<string, unknown>;
    expect(mod.createWorkflowExtractorAgent).toBeUndefined();
  });
});
