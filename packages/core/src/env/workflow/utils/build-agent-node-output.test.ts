import { describe, it, expect } from 'vitest';
import { buildAgentNodeOutput } from './build-agent-node-output';
import type { AgentResult } from '../nodes/agent-node';

describe('buildAgentNodeOutput', () => {
  it('should flatten json fields for template access', () => {
    const agentResult: AgentResult = {
      output: { passed: false, feedback: 'missing token' },
      structuredOutput: { passed: false, feedback: 'missing token' },
      metadata: { duration: 100 },
      messages: [],
    };

    const output = buildAgentNodeOutput(agentResult, {
      mode: 'json',
      schema: {
        type: 'object',
        properties: {
          passed: { type: 'boolean' },
          feedback: { type: 'string' },
        },
        required: ['passed'],
      },
    });

    expect(output.result).toEqual({ passed: false, feedback: 'missing token' });
    expect(output.passed).toBe(false);
    expect(output.feedback).toBe('missing token');
    expect(output.metadata).toMatchObject({ outputMode: 'json', duration: 100 });
  });

  it('should preserve string mode output shape', () => {
    const agentResult: AgentResult = {
      output: 'PASSED',
      metadata: { duration: 50 },
    };

    const output = buildAgentNodeOutput(agentResult, { mode: 'string' });

    expect(output.result).toBe('PASSED');
    expect(output.metadata).toEqual({ duration: 50 });
    expect(output).not.toHaveProperty('passed');
  });

  it('should surface raw output on JSON extraction failure instead of faking defaults', () => {
    // Issue #1694 update: instead of returning raw string (which breaks
    // downstream {{nodes.X.result.field}} template rendering), return a
    // structured placeholder object so the workflow can still proceed
    // gracefully when one expert fails.
    const agentResult: AgentResult = { output: 'plain text only' };
    const output = buildAgentNodeOutput(agentResult, {
      mode: 'json',
      schema: {
        type: 'object',
        properties: {
          passed: { type: 'boolean' },
          feedback: { type: 'string' },
        },
        required: ['passed', 'feedback'],
      },
    });

    // result 是对象（不再是 string），下游模板可安全访问 .field
    expect(typeof output.result).toBe('object');
    const result = output.result as Record<string, unknown>;
    expect(result._extraction_failed).toBe(true);
    expect(result._raw_output).toBe('plain text only');
    expect(result.passed).toBe(''); // placeholder default
    expect(result.feedback).toBe(''); // placeholder default

    expect(output.metadata).toMatchObject({ outputMode: 'json_error' });
    // 警告字段仍然存在，供调试
    expect((output.metadata as any)?._extractionWarning).toBeDefined();
  });

  // ─── Issue #1694: downstream safety when JSON extraction fails ───────────
  // 用户的实际痛点（Task #1694）：
  //   - 中间 expert agent 没有输出 JSON
  //   - meta-reviewer 用 {{nodes.X.result}} 拿不到结构化 JSON
  //   - 整个 workflow 因为单 expert 失败而中断
  //
  // 当 JSON extraction 真正失败时，透传原始字符串会让下游模板
  // （如 {{nodes.X.result.dimension}}）因 '.' 解析失败而抛错。
  // 修复策略：即使提取失败，result 仍应是结构化对象，确保下游
  // 模板至少能 inspect 错误，而不是冒泡到 workflow engine。
  it('should expose structured error object when JSON extraction fails (downstream safety)', () => {
    const agentResult: AgentResult = {
      output: 'I cannot proceed because pre-check output was empty.',
      metadata: { duration: 100 },
    };
    const output = buildAgentNodeOutput(agentResult, {
      mode: 'json',
      schema: {
        type: 'object',
        properties: {
          dimension: { type: 'string' },
          score: { type: 'number' },
          findings: { type: 'array' },
          summary: { type: 'string' },
        },
        required: ['dimension', 'score', 'findings', 'summary'],
      },
    });

    // result 必须是对象（不是 string），下游模板 {{nodes.X.result.dimension}} 才不会抛错
    expect(typeof output.result).toBe('object');
    expect(output.result).not.toBeNull();

    const result = output.result as Record<string, unknown>;
    expect(result._extraction_failed).toBe(true);
    // 通过 defaultValueForField 占位的字段名
    expect(result.dimension).toBe('unknown');
    expect(result.findings).toEqual([]);
    expect(result.summary).toBe('');

    // 原始 agent 响应应该保留以供调试
    expect(result._raw_output).toBe(
      'I cannot proceed because pre-check output was empty.'
    );

    // 元数据保留警告
    expect(output.metadata).toMatchObject({ outputMode: 'json_error' });
    expect((output.metadata as any)?._extractionWarning).toBeDefined();
  });

  it('should preserve all extra metadata in error fallback', () => {
    const agentResult: AgentResult = {
      output: 'plain text only',
      metadata: { duration: 50, iterations: 2, agentSessionId: 'agent_x_123' },
    };
    const output = buildAgentNodeOutput(agentResult, {
      mode: 'json',
      schema: {
        type: 'object',
        properties: { passed: { type: 'boolean' } },
        required: ['passed'],
      },
    });

    expect(output.metadata).toMatchObject({
      outputMode: 'json_error',
      duration: 50,
      iterations: 2,
      agentSessionId: 'agent_x_123',
    });
  });

  // ─── Issue #1694: extract structured JSON from agent's finalText fallback ──
  it('should extract JSON from finalText that contains it after prose and code blocks', () => {
    const agentResult: AgentResult = {
      output:
        'I reviewed the changes and found the following:\n\n```json\n' +
        '{"passed":false,"feedback":"missing token at line 42"}\n```\n\nDone.',
    };
    const output = buildAgentNodeOutput(agentResult, {
      mode: 'json',
      schema: {
        type: 'object',
        properties: {
          passed: { type: 'boolean' },
          feedback: { type: 'string' },
        },
        required: ['passed', 'feedback'],
      },
    });

    expect(output.result).toEqual({ passed: false, feedback: 'missing token at line 42' });
    expect(output.passed).toBe(false);
    expect(output.feedback).toBe('missing token at line 42');
  });

  // ─── Task #2164 fallback session: empty-output diagnostics ─────────────
  // 第二次 tdd-implement 失败的症状：_raw_output === '{}' (json-extract 子
  // agent 返回空对象 — 典型原因是 prompt 缺失或 abort)。
  // 当前的 _extraction_reason 是通用文本，无法直接定位"missing prompt/abort"。
  // 期望：当 raw_output === '{}' 或空字符串时，reason 应包含 empty/missing/abort
  // 关键词，便于 operator 直接判断 prompt registry 是否损坏。
  it('should produce self-diagnostic reason when raw output is empty object (json-extract missing prompt / aborted)', () => {
    const agentResult: AgentResult = {
      output: '{}',
      metadata: { duration: 100 },
    };
    const output = buildAgentNodeOutput(agentResult, {
      mode: 'json',
      schema: {
        type: 'object',
        properties: {
          tdd_status: { type: 'string' },
          test_count_added: { type: 'integer' },
          files_modified: { type: 'array', items: { type: 'string' } },
        },
        required: ['tdd_status', 'test_count_added', 'files_modified'],
      },
    });
    const result = output.result as Record<string, unknown>;
    expect(result._extraction_failed).toBe(true);
    expect(result._raw_output).toBe('{}');
    expect(result._extraction_reason).toMatch(/empty|missing prompt|abort/i);
  });

  it('should produce self-diagnostic reason when raw output is empty string', () => {
    const agentResult: AgentResult = {
      output: '',
      metadata: { duration: 50 },
    };
    const output = buildAgentNodeOutput(agentResult, {
      mode: 'json',
      schema: {
        type: 'object',
        properties: {
          passed: { type: 'boolean' },
        },
        required: ['passed'],
      },
    });
    const result = output.result as Record<string, unknown>;
    expect(result._extraction_failed).toBe(true);
    expect(result._extraction_reason).toMatch(/empty|missing prompt|abort/i);
  });
});
