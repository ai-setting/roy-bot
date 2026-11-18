/**
 * Human-readable hints derived from AgentNode output JSON schema.
 */

import type { JsonSchemaObject } from './json-schema-to-zod';

export function describeOutputSchema(
  schema: JsonSchemaObject | Record<string, unknown> | undefined
): string {
  if (!schema || typeof schema !== 'object') {
    return 'Submit a JSON object matching the configured output schema';
  }

  const obj = schema as JsonSchemaObject;
  if (!obj.properties || Object.keys(obj.properties).length === 0) {
    return 'Submit a JSON object matching the configured output schema';
  }

  const required = new Set(obj.required ?? []);
  const fields = Object.entries(obj.properties).map(([name, prop]) => {
    const type = prop.type ?? 'unknown';
    const req = required.has(name) ? 'required' : 'optional';
    const desc = prop.description ? ` — ${prop.description}` : '';
    return `${name}: ${type} (${req})${desc}`;
  });

  return `Expected fields: ${fields.join('; ')}`;
}

export function buildJsonOutputNudgeMessage(
  schema?: JsonSchemaObject | Record<string, unknown>
): string {
  return (
    'You must call the workflow_submit_output tool with your structured JSON result. ' +
    `${describeOutputSchema(schema)}. Plain text replies are not accepted.`
  );
}

export function buildJsonOutputRerunHint(
  schema?: JsonSchemaObject | Record<string, unknown>
): string {
  return (
    '\n\n[Re-run] Call workflow_submit_output again with a fresh result for this run. ' +
    `${describeOutputSchema(schema)}.`
  );
}
