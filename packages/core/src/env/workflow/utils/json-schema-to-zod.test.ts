import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { jsonSchemaToZod, validateJsonOutputSchema } from './json-schema-to-zod';

const verifySchema = {
  type: 'object',
  properties: {
    passed: { type: 'boolean', description: 'Whether verification passed' },
    feedback: { type: 'string' },
    score: { type: 'number' },
    rank: { type: 'integer' },
  },
  required: ['passed'],
};

describe('jsonSchemaToZod', () => {
  it('should convert object schema with boolean and string fields', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        passed: { type: 'boolean', description: 'Whether verification passed' },
        feedback: { type: 'string' },
      },
      required: ['passed'],
    });

    expect(schema.parse({ passed: true })).toEqual({ passed: true });
    expect(schema.parse({ passed: false, feedback: 'missing token' })).toEqual({
      passed: false,
      feedback: 'missing token',
    });
    expect(() => schema.parse({ feedback: 'no passed field' })).toThrow();
    expect(() => schema.parse({ passed: 'yes' })).toThrow();
  });

  it('should treat non-required fields as optional', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        passed: { type: 'boolean' },
        feedback: { type: 'string' },
      },
      required: ['passed'],
    });

    expect(schema.parse({ passed: true })).toEqual({ passed: true });
    expect(schema.parse({ passed: false, feedback: 'ok' })).toEqual({
      passed: false,
      feedback: 'ok',
    });
  });

  it('should support number and integer property types', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        score: { type: 'number' },
        rank: { type: 'integer' },
      },
      required: ['score', 'rank'],
    });

    expect(schema.parse({ score: 0.5, rank: 1 })).toEqual({ score: 0.5, rank: 1 });
    expect(() => schema.parse({ score: 'high', rank: 1 })).toThrow();
  });

  it('should map unknown property types to z.unknown()', () => {
    const schema = jsonSchemaToZod({
      type: 'object',
      properties: {
        extra: { type: 'array' },
      },
      required: [],
    });

    expect(schema.parse({ extra: [1, 2] })).toEqual({ extra: [1, 2] });
  });

  it('should reject non-object schemas', () => {
    expect(() => jsonSchemaToZod({ type: 'string' })).toThrow(/object/i);
    expect(() => jsonSchemaToZod({ type: 'object' })).toThrow(/properties/i);
  });

  // ─── New tests ─────────────────────────────────────────────────

  describe('array type with items', () => {
    it('should convert array type with string items', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: {
          tags: { type: 'array', items: { type: 'string' } },
        },
        required: ['tags'],
      });

      expect(schema.parse({ tags: ['a', 'b'] })).toEqual({ tags: ['a', 'b'] });
      expect(() => schema.parse({ tags: ['a', 1] })).toThrow();
    });

    it('should convert array type with number items', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: {
          scores: { type: 'array', items: { type: 'number' } },
        },
        required: ['scores'],
      });

      expect(schema.parse({ scores: [1, 2.5] })).toEqual({ scores: [1, 2.5] });
      expect(() => schema.parse({ scores: ['bad'] })).toThrow();
    });

    it('should convert array type with object items', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { id: { type: 'integer' }, name: { type: 'string' } },
              required: ['id'],
            },
          },
        },
        required: ['items'],
      });

      const result = schema.parse({ items: [{ id: 1, name: 'a' }, { id: 2 }] });
      expect(result).toEqual({ items: [{ id: 1, name: 'a' }, { id: 2 }] });
      expect(() => schema.parse({ items: [{ id: 'not-number' }] })).toThrow();
    });
  });

  describe('nested object type', () => {
    it('should convert nested object with required and optional fields', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: {
          meta: {
            type: 'object',
            properties: {
              count: { type: 'integer' },
              label: { type: 'string' },
            },
            required: ['count'],
          },
        },
        required: ['meta'],
      });

      expect(schema.parse({ meta: { count: 5 } })).toEqual({ meta: { count: 5 } });
      expect(schema.parse({ meta: { count: 5, label: 'test' } })).toEqual({
        meta: { count: 5, label: 'test' },
      });
      expect(() => schema.parse({ meta: { label: 'no-count' } })).toThrow();
    });
  });

  describe('deeply nested (object → array → object)', () => {
    it('should convert deeply nested schema', () => {
      const schema = jsonSchemaToZod({
        type: 'object',
        properties: {
          data: {
            type: 'object',
            properties: {
              rows: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    value: { type: 'string' },
                  },
                  required: ['id'],
                },
              },
            },
            required: ['rows'],
          },
        },
        required: ['data'],
      });

      const valid = schema.parse({
        data: { rows: [{ id: 1, value: 'a' }, { id: 2 }] },
      });
      expect(valid).toEqual({
        data: { rows: [{ id: 1, value: 'a' }, { id: 2 }] },
      });

      expect(() =>
        schema.parse({ data: { rows: [{ id: 'bad' }] } }),
      ).toThrow();
    });
  });
});

describe('validateJsonOutputSchema', () => {
  it('should accept a valid verify-style schema', () => {
    const validated = validateJsonOutputSchema(verifySchema);
    expect(validated).toEqual(verifySchema);
    expect(() => jsonSchemaToZod(validated).parse({ passed: true })).not.toThrow();
  });

  it('should reject non-object root', () => {
    expect(() => validateJsonOutputSchema('string')).toThrow(/JSON object/i);
    expect(() => validateJsonOutputSchema([])).toThrow(/JSON object/i);
  });

  it('should reject wrong type or empty properties', () => {
    expect(() => validateJsonOutputSchema({ type: 'string', properties: {} })).toThrow(
      /type must be "object"/i
    );
    expect(() => validateJsonOutputSchema({ type: 'object', properties: {} })).toThrow(
      /must not be empty/i
    );
  });

  it('should reject invalid required array', () => {
    expect(() =>
      validateJsonOutputSchema({
        type: 'object',
        properties: { passed: { type: 'boolean' } },
        required: 'passed',
      })
    ).toThrow(/required must be an array/i);

    expect(() =>
      validateJsonOutputSchema({
        type: 'object',
        properties: { passed: { type: 'boolean' } },
        required: ['missing'],
      })
    ).toThrow(/unknown property "missing"/i);
  });

  it('should reject unsupported property types at parse time', () => {
    expect(() =>
      validateJsonOutputSchema({
        type: 'object',
        properties: { items: { type: 'null' } },
      })
    ).toThrow(/must be one of/i);
  });

  it('should reject invalid property shape', () => {
    expect(() =>
      validateJsonOutputSchema({
        type: 'object',
        properties: { passed: null },
      })
    ).toThrow(/properties\.passed must be an object/i);
  });
});
