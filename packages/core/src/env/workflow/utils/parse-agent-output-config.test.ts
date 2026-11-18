import { describe, it, expect } from 'vitest';
import { parseAgentOutputConfig } from './parse-agent-output-config';

describe('parseAgentOutputConfig', () => {
  it('should default to string mode when output is absent', () => {
    expect(parseAgentOutputConfig({ agent_type: 'general' })).toEqual({ mode: 'string' });
  });

  it('should parse json mode with validated schema', () => {
    const schema = {
      type: 'object',
      properties: { passed: { type: 'boolean' } },
      required: ['passed'],
    };
    expect(parseAgentOutputConfig({ output: { mode: 'json', schema } })).toEqual({
      mode: 'json',
      schema,
    });
  });

  it('should throw when json mode lacks schema', () => {
    expect(() => parseAgentOutputConfig({ output: { mode: 'json' } })).toThrow(/schema/i);
  });

  it('should throw when yaml schema is invalid before runtime', () => {
    expect(() =>
      parseAgentOutputConfig({
        output: {
          mode: 'json',
          schema: {
            type: 'object',
            properties: { passed: { type: 'null' } },
          },
        },
      })
    ).toThrow(/must be one of/i);
  });

  it('should throw when required references unknown field', () => {
    expect(() =>
      parseAgentOutputConfig({
        output: {
          mode: 'json',
          schema: {
            type: 'object',
            properties: { passed: { type: 'boolean' } },
            required: ['feedback'],
          },
        },
      })
    ).toThrow(/unknown property "feedback"/i);
  });
});
