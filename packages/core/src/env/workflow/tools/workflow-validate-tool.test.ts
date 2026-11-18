/**
 * @fileoverview Tests for workflow_validate tool
 *
 * TDD: Tests for the new workflow_validate tool that wraps DAGManager.validate()
 * Used by the built-in 'workflow-extract' agent (and task-tag-plugin pre-flight check)
 * to validate workflow YAML before adding.
 */

import { describe, it, expect, beforeEach, vi } from 'bun:test';
import { createWorkflowValidateTool } from './workflow-validate-tool';

vi.mock('../../log-trace/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

describe('workflow_validate tool', () => {
  let tool: ReturnType<typeof createWorkflowValidateTool>;

  beforeEach(() => {
    // The tool doesn't actually use the service; it parses YAML and runs DAGManager.validate
    tool = createWorkflowValidateTool({} as any);
  });

  it('should have name "workflow_validate"', () => {
    expect(tool.name).toBe('workflow_validate');
  });

  it('should have description mentioning DAG validation', () => {
    expect(tool.description).toContain('Validate');
    // Should mention at least one of: DAG, dependency, cycle
    const desc = tool.description.toLowerCase();
    expect(
      desc.includes('dag') || desc.includes('depend') || desc.includes('cycle')
    ).toBe(true);
  });

  it('should accept yaml string input', () => {
    expect(tool.parameters).toBeDefined();
  });

  describe('valid workflow', () => {
    it('should return success=true for valid 2-node linear workflow', async () => {
      const yaml = `
name: valid-test-workflow
version: "1.0"
description: A valid test workflow
nodes:
  - id: node-1
    type: tool
    name: Step 1
    config:
      toolName: read_file
    depends_on: []
  - id: node-2
    type: tool
    name: Step 2
    config:
      toolName: write_file
    depends_on: [node-1]
`;
      const result = await tool.execute({ yaml }, { component: { name: 'test' } } as any);
      expect(result.success).toBe(true);
      expect(result.error).toBeFalsy();
    });
  });

  describe('invalid workflow', () => {
    it('should return success=false for duplicate node IDs', async () => {
      const yaml = `
name: invalid-workflow
version: "1.0"
nodes:
  - id: node-1
    type: tool
    name: A
    config:
      toolName: bash
  - id: node-1
    type: tool
    name: B
    config:
      toolName: bash
    depends_on: []
`;
      const result = await tool.execute({ yaml }, { component: { name: 'test' } } as any);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Duplicate');
    });

    it('should return success=false for missing dependency', async () => {
      const yaml = `
name: missing-dep-workflow
version: "1.0"
nodes:
  - id: node-1
    type: tool
    name: Step
    config:
      toolName: bash
    depends_on: [non-existent-node]
`;
      const result = await tool.execute({ yaml }, { component: { name: 'test' } } as any);
      expect(result.success).toBe(false);
      expect(result.error).toContain('non-existent');
    });

    it('should return success=false for cycles', async () => {
      const yaml = `
name: cyclic-workflow
version: "1.0"
nodes:
  - id: node-1
    type: tool
    name: A
    config:
      toolName: bash
    depends_on: [node-2]
  - id: node-2
    type: tool
    name: B
    config:
      toolName: bash
    depends_on: [node-1]
`;
      const result = await tool.execute({ yaml }, { component: { name: 'test' } } as any);
      expect(result.success).toBe(false);
      // Either cycle error or duplicate detection
      expect(result.error).toBeDefined();
    });

    it('should return success=false for empty node ID', async () => {
      const yaml = `
name: empty-id-workflow
version: "1.0"
nodes:
  - id: ""
    type: tool
    name: Step
    config:
      toolName: bash
    depends_on: []
`;
      const result = await tool.execute({ yaml }, { component: { name: 'test' } } as any);
      expect(result.success).toBe(false);
    });
  });

  // ==========================================================================
  // Task #4298 — template-reference contract checks surfaced through the tool
  // ==========================================================================
  describe('template-reference contracts (Task #4298)', () => {
    it('should FAIL when an agent prompt reads .result off a tool node, with a suggested fix', async () => {
      const yaml = `
name: wheels-like
version: "1.0"
nodes:
  - id: run-validation-tests
    type: tool
    config:
      tool: bash
      command: echo ok
  - id: report-results
    type: agent
    depends_on: [run-validation-tests]
    config:
      prompt: "tests: {{nodes.run-validation-tests.result}}"
`;
      const result = await tool.execute({ yaml }, { component: { name: 'test' } } as any);
      expect(result.success).toBe(false);
      expect(result.error).toContain('R2-result-on-non-agent');
      expect(result.error).toContain('{{nodes.run-validation-tests.output}}');
      const parsed = JSON.parse(result.output);
      expect(parsed.valid).toBe(false);
      expect(parsed.errorCount).toBe(1);
    });

    it('should PASS when the same prompt uses .output', async () => {
      const yaml = `
name: fixed
version: "1.0"
nodes:
  - id: run-validation-tests
    type: tool
    config:
      tool: bash
      command: echo ok
  - id: report-results
    type: agent
    depends_on: [run-validation-tests]
    config:
      prompt: "tests: {{nodes.run-validation-tests.output}}"
`;
      const result = await tool.execute({ yaml }, { component: { name: 'test' } } as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.valid).toBe(true);
      expect(parsed.warningCount).toBe(0);
    });

    it('should expose warnings/infos in the output JSON without failing the run', async () => {
      const yaml = `
name: advisory
version: "1.0"
nodes:
  - id: judge
    type: agent
    config:
      prompt: hi
      output:
        mode: json
        schema:
          type: object
          properties:
            verdict: { type: string }
  - id: use
    type: agent
    depends_on: [judge]
    config:
      prompt: "{{nodes.judge.nope}}"
`;
      const result = await tool.execute({ yaml }, { component: { name: 'test' } } as any);
      expect(result.success).toBe(true);
      const parsed = JSON.parse(result.output);
      expect(parsed.valid).toBe(true);
      expect(parsed.warningCount).toBe(1);
      expect(parsed.warnings[0]).toContain('R5-agent-schema-field');
    });

    it('should describe the contract checks in its description', () => {
      expect(tool.description).toContain('.result');
      expect(tool.description).toContain('.output');
    });
  });

  describe('malformed input', () => {
    it('should return success=false for invalid YAML', async () => {
      const result = await tool.execute({ yaml: 'this is not: valid: yaml: [' }, { component: { name: 'test' } } as any);
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should return success=false for missing nodes field', async () => {
      const yaml = `
name: no-nodes-workflow
version: "1.0"
`;
      const result = await tool.execute({ yaml }, { component: { name: 'test' } } as any);
      expect(result.success).toBe(false);
    });

    it('should return success=false for non-string yaml', async () => {
      const result = await tool.execute({ yaml: 123 }, { component: { name: 'test' } } as any);
      expect(result.success).toBe(false);
    });
  });
});
