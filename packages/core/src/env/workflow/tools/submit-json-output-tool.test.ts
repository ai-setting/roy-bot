import { describe, it, expect } from 'vitest';
import {
  createSubmitJsonOutputTool,
  parseWorkflowJsonOutput,
  WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME,
  WorkflowJsonOutputMarker,
} from './submit-json-output-tool';
import type { HookContext as AgentHookContext } from '../../agent/types';

const verifySchema = {
  type: 'object' as const,
  properties: {
    passed: { type: 'boolean' as const, description: 'true if verification passed' },
    feedback: { type: 'string' as const },
  },
  required: ['passed'],
};

const nestedSchema = {
  type: 'object' as const,
  properties: {
    items: { type: 'array' as const, items: { type: 'string' as const } },
    summary: {
      type: 'object' as const,
      properties: {
        count: { type: 'integer' as const },
        ok: { type: 'boolean' as const },
      },
      required: ['count'],
    },
  },
  required: ['items', 'summary'],
};

/** Create a fresh mock hook context for each test. */
function makeMockHookCtx(): AgentHookContext {
  return {} as AgentHookContext;
}

describe('submit-json-output-tool', () => {
  it('should use fixed tool name workflow_submit_output', () => {
    const tool = createSubmitJsonOutputTool(verifySchema, makeMockHookCtx());
    expect(tool.name).toBe(WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME);
  });

  it('should validate args against schema and return marked output', async () => {
    const mockHookCtx = makeMockHookCtx();
    const tool = createSubmitJsonOutputTool(verifySchema, mockHookCtx);
    const result = await tool.execute({ passed: false, feedback: 'missing token' }, {} as any);

    expect(result.success).toBe(true);
    expect(result.output).toBe(
      `${WorkflowJsonOutputMarker}:${JSON.stringify({ passed: false, feedback: 'missing token' })}`
    );
  });

  it('should reject invalid args', async () => {
    const mockHookCtx = makeMockHookCtx();
    const tool = createSubmitJsonOutputTool(verifySchema, mockHookCtx);
    await expect(tool.execute({ passed: 'no' }, {} as any)).rejects.toThrow();
    // hookCtx should NOT be mutated on validation failure
    expect(mockHookCtx.structuredOutputExtracted).toBeUndefined();
  });

  it('should parse marked output back to object', () => {
    const marked = `${WorkflowJsonOutputMarker}:${JSON.stringify({ passed: true })}`;
    expect(parseWorkflowJsonOutput(marked)).toEqual({ passed: true });
    expect(parseWorkflowJsonOutput('not marked')).toBeUndefined();
  });

  // ─── New tests: self-recording into hookCtx ─────────────────

  describe('tool self-records into hookCtx', () => {
    it('should write parsed JSON to hookCtx.structuredOutputExtracted on success', async () => {
      const mockHookCtx = makeMockHookCtx();
      const tool = createSubmitJsonOutputTool(verifySchema, mockHookCtx);

      expect(mockHookCtx.structuredOutputExtracted).toBeUndefined();
      await tool.execute({ passed: true, feedback: 'all good' }, {} as any);

      expect(mockHookCtx.structuredOutputExtracted).toEqual({
        passed: true,
        feedback: 'all good',
      });
    });

    it('should write parsed JSON to hookCtx even when only required fields are present', async () => {
      const mockHookCtx = makeMockHookCtx();
      const tool = createSubmitJsonOutputTool(verifySchema, mockHookCtx);

      await tool.execute({ passed: false }, {} as any);

      expect(mockHookCtx.structuredOutputExtracted).toEqual({ passed: false });
    });

    it('should NOT modify hookCtx when zod validation fails', async () => {
      const mockHookCtx = makeMockHookCtx();
      const tool = createSubmitJsonOutputTool(verifySchema, mockHookCtx);

      // 'passed' should be boolean, not string
      await expect(
        tool.execute({ passed: 'yes' }, {} as any),
      ).rejects.toThrow();
      expect(mockHookCtx.structuredOutputExtracted).toBeUndefined();
    });

    it('should NOT modify hookCtx when required field is missing', async () => {
      const mockHookCtx = makeMockHookCtx();
      const tool = createSubmitJsonOutputTool(verifySchema, mockHookCtx);

      // 'passed' is required
      await expect(
        tool.execute({ feedback: 'no passed' }, {} as any),
      ).rejects.toThrow();
      expect(mockHookCtx.structuredOutputExtracted).toBeUndefined();
    });

    it('should allow multiple tools bound to the same hookCtx (only last write wins)', async () => {
      const mockHookCtx = makeMockHookCtx();
      const toolA = createSubmitJsonOutputTool(verifySchema, mockHookCtx);
      const toolB = createSubmitJsonOutputTool(verifySchema, mockHookCtx);

      await toolA.execute({ passed: false, feedback: 'first' }, {} as any);
      expect(mockHookCtx.structuredOutputExtracted).toEqual({
        passed: false,
        feedback: 'first',
      });

      await toolB.execute({ passed: true, feedback: 'second' }, {} as any);
      expect(mockHookCtx.structuredOutputExtracted).toEqual({
        passed: true,
        feedback: 'second',
      });
    });

    it('should support nested arrays/objects in hookCtx', async () => {
      const mockHookCtx = makeMockHookCtx();
      const tool = createSubmitJsonOutputTool(nestedSchema, mockHookCtx);

      await tool.execute(
        { items: ['x', 'y'], summary: { count: 2, ok: true } },
        {} as any,
      );

      expect(mockHookCtx.structuredOutputExtracted).toEqual({
        items: ['x', 'y'],
        summary: { count: 2, ok: true },
      });
    });

    it('should return marker output in the same shape as before', async () => {
      const mockHookCtx = makeMockHookCtx();
      const tool = createSubmitJsonOutputTool(verifySchema, mockHookCtx);

      const result = await tool.execute({ passed: true, feedback: 'ok' }, {} as any);
      expect(result.success).toBe(true);
      expect(typeof result.output).toBe('string');
      expect((result.output as string).startsWith(`${WorkflowJsonOutputMarker}:`)).toBe(true);
      const parsed = parseWorkflowJsonOutput(result.output);
      expect(parsed).toEqual({ passed: true, feedback: 'ok' });
    });
  });

  // ─── parseWorkflowJsonOutput tests (preserved) ─────────────

  describe('parseWorkflowJsonOutput', () => {
    it('should return undefined for format error (marker followed by non-JSON)', () => {
      const result = parseWorkflowJsonOutput(`${WorkflowJsonOutputMarker}:not-json`);
      expect(result).toBeUndefined();
    });

    it('should return undefined for non-object JSON (array)', () => {
      const result = parseWorkflowJsonOutput(`${WorkflowJsonOutputMarker}:[1,2,3]`);
      expect(result).toBeUndefined();
    });

    it('should return undefined for empty string', () => {
      expect(parseWorkflowJsonOutput('')).toBeUndefined();
    });

    it('should return undefined for non-string input', () => {
      expect(parseWorkflowJsonOutput(null)).toBeUndefined();
      expect(parseWorkflowJsonOutput(undefined)).toBeUndefined();
      expect(parseWorkflowJsonOutput(123)).toBeUndefined();
      expect(parseWorkflowJsonOutput({})).toBeUndefined();
    });
  });

  describe('nested schema tool', () => {
    it('should create and execute tool with array + object nested schema', async () => {
      const mockHookCtx = makeMockHookCtx();
      const tool = createSubmitJsonOutputTool(nestedSchema, mockHookCtx);
      const result = await tool.execute(
        { items: ['a', 'b', 'c'], summary: { count: 3, ok: true } },
        {} as any,
      );

      expect(result.success).toBe(true);
      expect(result.output).toBe(
        `${WorkflowJsonOutputMarker}:${JSON.stringify({ items: ['a', 'b', 'c'], summary: { count: 3, ok: true } })}`
      );
      expect(mockHookCtx.structuredOutputExtracted).toEqual({
        items: ['a', 'b', 'c'],
        summary: { count: 3, ok: true },
      });
    });

    it('should reject invalid nested data', async () => {
      const mockHookCtx = makeMockHookCtx();
      const tool = createSubmitJsonOutputTool(nestedSchema, mockHookCtx);
      // summary.count should be integer, not string
      await expect(
        tool.execute({ items: ['a'], summary: { count: 'three', ok: true } }, {} as any),
      ).rejects.toThrow();
      expect(mockHookCtx.structuredOutputExtracted).toBeUndefined();
    });

    it('should reject missing required nested field', async () => {
      const mockHookCtx = makeMockHookCtx();
      const tool = createSubmitJsonOutputTool(nestedSchema, mockHookCtx);
      // summary.count is required
      await expect(
        tool.execute({ items: ['a'], summary: { ok: true } }, {} as any),
      ).rejects.toThrow();
      expect(mockHookCtx.structuredOutputExtracted).toBeUndefined();
    });
  });
});
