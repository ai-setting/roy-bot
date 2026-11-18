import { describe, it, expect } from 'vitest';
import { extractAgentJsonOutput } from './extract-agent-json-output';
import type { AgentResult } from '../nodes/agent-node';

const verifySchema = {
  type: 'object' as const,
  properties: {
    passed: { type: 'boolean' as const },
    feedback: { type: 'string' as const },
  },
  required: ['passed'],
};

describe('extractAgentJsonOutput', () => {
  it('should prefer structuredOutput with boolean passed', () => {
    const agentResult: AgentResult = {
      output: 'ignored',
      structuredOutput: { passed: false, feedback: 'x' },
    };
    expect(extractAgentJsonOutput(agentResult, verifySchema)).toEqual({
      passed: false,
      feedback: 'x',
    });
    expect(typeof extractAgentJsonOutput(agentResult, verifySchema)!.passed).toBe('boolean');
  });

  it('should extract boolean passed from workflow_submit_output tool call args', () => {
    const agentResult: AgentResult = {
      output: 'plain text verdict',
      metadata: {
        toolCallsDetail: [
          { name: 'workflow_submit_output', arguments: { passed: true } },
        ],
      },
    };
    expect(extractAgentJsonOutput(agentResult, verifySchema)).toEqual({ passed: true });
  });

  it('should NOT treat PASSED/FAILED plain text as structured output', () => {
    expect(extractAgentJsonOutput({ output: 'FAILED' }, verifySchema)).toBeUndefined();
    expect(extractAgentJsonOutput({ output: 'PASSED' }, verifySchema)).toBeUndefined();
    expect(
      extractAgentJsonOutput(
        { output: '**Verdict: FAILED** token missing' },
        verifySchema
      )
    ).toBeUndefined();
  });

  it('should extract from workflow_submit_output tool message in this run', () => {
    const agentResult: AgentResult = {
      output: undefined,
      messages: [
        {
          role: 'tool',
          toolName: 'workflow_submit_output',
          content: '__WORKFLOW_JSON_OUTPUT__:{"passed":false,"feedback":"missing"}',
        },
      ],
    };
    expect(extractAgentJsonOutput(agentResult, verifySchema)).toEqual({
      passed: false,
      feedback: 'missing',
    });
  });

  it('should use the latest workflow_submit_output tool call in this run', () => {
    const agentResult: AgentResult = {
      output: undefined,
      metadata: {
        toolCallsDetail: [
          { name: 'workflow_submit_output', arguments: { passed: false } },
          { name: 'workflow_submit_output', arguments: { passed: true } },
        ],
      },
    };
    expect(extractAgentJsonOutput(agentResult, verifySchema)).toEqual({ passed: true });
  });

  // ─── extractFromOutputText tests ──────────────────────────────────

  it('should extract JSON from plain text output (direct JSON)', () => {
    const agentResult: AgentResult = {
      output: '{"passed":true,"feedback":"all good"}',
    };
    expect(extractAgentJsonOutput(agentResult, verifySchema)).toEqual({
      passed: true,
      feedback: 'all good',
    });
  });

  it('should extract JSON from ```json code block', () => {
    const agentResult: AgentResult = {
      output: 'Some text before\n```json\n{"passed":false,"feedback":"missing file"}\n```\nSome text after',
    };
    expect(extractAgentJsonOutput(agentResult, verifySchema)).toEqual({
      passed: false,
      feedback: 'missing file',
    });
  });

  it('should extract JSON from ``` code block (no language)', () => {
    const agentResult: AgentResult = {
      output: 'Here is my verdict:\n```\n{"passed":true,"feedback":"looks good"}\n```',
    };
    expect(extractAgentJsonOutput(agentResult, verifySchema)).toEqual({
      passed: true,
      feedback: 'looks good',
    });
  });

  it('should extract first JSON object from text with brace-depth tracking', () => {
    const agentResult: AgentResult = {
      output: 'Summary: {"passed":true,"nested":{"a":1}} and done.',
    };
    const result = extractAgentJsonOutput(agentResult, verifySchema);
    expect(result?.passed).toBe(true);
    expect(typeof result?.passed).toBe('boolean');
  });

  it('should return undefined for text without any JSON object', () => {
    const agentResult: AgentResult = {
      output: 'This is just a plain text response without any JSON.',
    };
    expect(extractAgentJsonOutput(agentResult, verifySchema)).toBeUndefined();
  });

  // ─── New tests ─────────────────────────────────────────────────

  describe('schema validation failure', () => {
    it('should return undefined when data does not match schema', () => {
      const agentResult: AgentResult = {
        output: undefined,
        structuredOutput: { passed: 'not-a-boolean' },
      };
      expect(extractAgentJsonOutput(agentResult, verifySchema)).toBeUndefined();
    });

    it('should return undefined when structuredOutput has wrong type for field', () => {
      const agentResult: AgentResult = {
        output: undefined,
        structuredOutput: { passed: true, feedback: 123 },
      };
      // feedback should be string, but it's number
      expect(extractAgentJsonOutput(agentResult, verifySchema)).toBeUndefined();
    });

    it('should return undefined when required field is missing', () => {
      const agentResult: AgentResult = {
        output: undefined,
        structuredOutput: { feedback: 'missing passed' },
      };
      expect(extractAgentJsonOutput(agentResult, verifySchema)).toBeUndefined();
    });
  });

  describe('priority order', () => {
    it('should prefer structuredOutput over output', () => {
      const agentResult: AgentResult = {
        output: '{"passed":false,"feedback":"from output"}',
        structuredOutput: { passed: true, feedback: 'from structured' },
      };
      const result = extractAgentJsonOutput(agentResult, verifySchema);
      expect(result).toEqual({ passed: true, feedback: 'from structured' });
    });

    it('should prefer output over toolCalls', () => {
      const agentResult: AgentResult = {
        output: '{"passed":true,"feedback":"from output"}',
        metadata: {
          toolCallsDetail: [
            { name: 'workflow_submit_output', arguments: { passed: false, feedback: 'from tool' } },
          ],
        },
      };
      const result = extractAgentJsonOutput(agentResult, verifySchema);
      expect(result).toEqual({ passed: true, feedback: 'from output' });
    });

    it('should prefer toolCalls over messages', () => {
      const agentResult: AgentResult = {
        output: undefined,
        metadata: {
          toolCallsDetail: [
            { name: 'workflow_submit_output', arguments: { passed: true, feedback: 'from toolCalls' } },
          ],
        },
        messages: [
          {
            role: 'tool',
            toolName: 'workflow_submit_output',
            content: '__WORKFLOW_JSON_OUTPUT__:{"passed":false,"feedback":"from messages"}',
          },
        ],
      };
      const result = extractAgentJsonOutput(agentResult, verifySchema);
      expect(result).toEqual({ passed: true, feedback: 'from toolCalls' });
    });
  });

  describe('empty/null/undefined input', () => {
    it('should return undefined for empty result', () => {
      expect(extractAgentJsonOutput({ output: undefined } as AgentResult, verifySchema)).toBeUndefined();
    });

    it('should return undefined for null output', () => {
      expect(extractAgentJsonOutput({ output: null }, verifySchema)).toBeUndefined();
    });

    it('should return undefined for undefined output', () => {
      expect(extractAgentJsonOutput({ output: undefined }, verifySchema)).toBeUndefined();
    });

    it('should return undefined for empty output string', () => {
      expect(extractAgentJsonOutput({ output: '' }, verifySchema)).toBeUndefined();
    });

    it('should return undefined for whitespace-only output', () => {
      expect(extractAgentJsonOutput({ output: '   ' }, verifySchema)).toBeUndefined();
    });
  });
});
