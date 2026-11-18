import { describe, it, expect } from 'vitest';
import {
  describeOutputSchema,
  buildJsonOutputNudgeMessage,
  buildJsonOutputRerunHint,
} from './output-schema-hint';

const verifySchema = {
  type: 'object',
  properties: {
    passed: { type: 'boolean', description: 'true if verification passed' },
    feedback: { type: 'string' },
  },
  required: ['passed'],
};

const customSchema = {
  type: 'object',
  properties: {
    score: { type: 'number', description: 'quality score 0-100' },
    tags: { type: 'string' },
  },
  required: ['score'],
};

describe('output-schema-hint', () => {
  it('should describe fields from schema generically', () => {
    expect(describeOutputSchema(verifySchema)).toContain('passed: boolean (required)');
    expect(describeOutputSchema(verifySchema)).toContain('feedback: string (optional)');
    expect(describeOutputSchema(customSchema)).toContain('score: number (required)');
    expect(describeOutputSchema(undefined)).toMatch(/configured output schema/i);
  });

  it('should build nudge message without hardcoded field names', () => {
    const msg = buildJsonOutputNudgeMessage(customSchema);
    expect(msg).toContain('workflow_submit_output');
    expect(msg).toContain('score: number (required)');
    expect(msg).not.toContain('passed');
  });

  it('should build rerun hint from schema', () => {
    const hint = buildJsonOutputRerunHint(customSchema);
    expect(hint).toContain('[Re-run]');
    expect(hint).toContain('score: number (required)');
    expect(hint).not.toContain('boolean passed');
  });
});
