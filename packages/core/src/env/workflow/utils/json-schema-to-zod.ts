/**
 * Minimal JSON Schema → Zod converter for workflow agent output schemas.
 * Supports object types with boolean, string, number, and integer properties.
 */

import { z } from 'zod';

export interface JsonSchemaObject {
  type?: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

export interface JsonSchemaProperty {
  type?: string;
  description?: string;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

const SUPPORTED_PROPERTY_TYPES = new Set(['boolean', 'string', 'number', 'integer', 'array', 'object']);

/**
 * Validate workflow AgentNode output.schema at config parse time (YAML load path).
 * Only supports the minimal JSON Schema subset used by jsonSchemaToZod.
 */
export function validateJsonOutputSchema(schema: unknown): JsonSchemaObject {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) {
    throw new Error('output.schema must be a JSON object');
  }

  const record = schema as Record<string, unknown>;

  if (record.type !== 'object') {
    throw new Error('output.schema.type must be "object"');
  }

  const properties = record.properties;
  if (!properties || typeof properties !== 'object' || Array.isArray(properties)) {
    throw new Error('output.schema.properties must be an object');
  }

  const propertyEntries = Object.entries(properties as Record<string, unknown>);
  if (propertyEntries.length === 0) {
    throw new Error('output.schema.properties must not be empty');
  }

  const required = record.required;
  if (required !== undefined) {
    if (!Array.isArray(required)) {
      throw new Error('output.schema.required must be an array of property names');
    }
    for (const key of required) {
      if (typeof key !== 'string') {
        throw new Error('output.schema.required entries must be strings');
      }
      if (!(key in (properties as Record<string, unknown>))) {
        throw new Error(`output.schema.required references unknown property "${key}"`);
      }
    }
  }

  for (const [name, prop] of propertyEntries) {
    if (!prop || typeof prop !== 'object' || Array.isArray(prop)) {
      throw new Error(`output.schema.properties.${name} must be an object`);
    }
    const propRecord = prop as Record<string, unknown>;
    const type = propRecord.type;
    if (typeof type !== 'string' || !SUPPORTED_PROPERTY_TYPES.has(type)) {
      throw new Error(
        `output.schema.properties.${name}.type must be one of: ${[...SUPPORTED_PROPERTY_TYPES].join(', ')}`
      );
    }
    if (propRecord.description !== undefined && typeof propRecord.description !== 'string') {
      throw new Error(`output.schema.properties.${name}.description must be a string`);
    }
  }

  // Ensure the schema is convertible (catches internal inconsistencies early)
  jsonSchemaToZod(record as JsonSchemaObject);

  return record as JsonSchemaObject;
}

export function jsonSchemaToZod(schema: JsonSchemaObject): z.ZodObject<z.ZodRawShape> {
  if (schema.type !== 'object' || !schema.properties) {
    throw new Error('Agent output schema must be a JSON object with properties');
  }

  const required = new Set(schema.required ?? []);
  const shape: z.ZodRawShape = {};

  for (const [key, prop] of Object.entries(schema.properties)) {
    let field = propertyToZod(prop);
    if (prop.description) {
      field = field.describe(prop.description);
    }
    if (!required.has(key)) {
      field = field.optional();
    }
    shape[key] = field;
  }

  return z.object(shape);
}

function propertyToZod(prop: JsonSchemaProperty): z.ZodTypeAny {
  switch (prop.type) {
    case 'boolean':
      return z.boolean();
    case 'string':
      return z.string();
    case 'number':
    case 'integer':
      return z.number();
    case 'array':
      if (prop.items) {
        return z.array(propertyToZod(prop.items));
      }
      return z.array(z.unknown());
    case 'object':
      if (prop.properties) {
        const required = new Set(prop.required ?? []);
        const shape: z.ZodRawShape = {};
        for (const [key, subProp] of Object.entries(prop.properties)) {
          let field = propertyToZod(subProp);
          if (subProp.description) {
            field = field.describe(subProp.description);
          }
          if (!required.has(key)) {
            field = field.optional();
          }
          shape[key] = field;
        }
        return z.object(shape);
      }
      return z.record(z.unknown());
    default:
      return z.unknown();
  }
}
