/**
 * Extract structured JSON output from agent result (tool submission only).
 */

import type { AgentResult } from '../nodes/agent-node';
import { WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME, parseWorkflowJsonOutput } from '../tools/submit-json-output-tool';
import type { JsonSchemaObject } from './json-schema-to-zod';
import { jsonSchemaToZod } from './json-schema-to-zod';

export function extractAgentJsonOutput(
  agentResult: AgentResult,
  schema?: JsonSchemaObject
): Record<string, unknown> | undefined {
  const candidates: Array<Record<string, unknown> | undefined> = [
    agentResult.structuredOutput,
    asRecord(agentResult.output),
    extractFromOutputText(agentResult.output),
    extractFromToolCalls(agentResult),
    extractFromMessages(agentResult.messages),
  ];

  for (const candidate of candidates) {
    const validated = validateAgainstSchema(candidate, schema);
    if (validated) {
      return validated;
    }
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function extractFromOutputText(output: unknown): Record<string, unknown> | undefined {
  if (typeof output !== 'string' || !output.trim()) {
    return undefined;
  }

  const trimmed = output.trim();

  // Try direct JSON parse first
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not direct JSON
  }

  // Look for JSON code block (```json ... ```)
  const jsonBlockMatch = trimmed.match(/```(?:json)?\s*\n?(\{[\s\S]*?\})\n?\s*```/);
  if (jsonBlockMatch) {
    try {
      const parsed = JSON.parse(jsonBlockMatch[1]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // not valid JSON in block
    }
  }

  // Loosely find the first JSON object `{...}` anywhere in text
  // Uses brace-depth tracking to handle nested objects correctly
  for (let i = 0; i < trimmed.length; i++) {
    if (trimmed[i] !== '{') continue;

    let depth = 0;
    let inString = false;
    let escape = false;

    for (let j = i; j < trimmed.length; j++) {
      const ch = trimmed[j];

      if (escape) { escape = false; continue; }
      if (ch === '\\' && inString) { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;

      if (ch === '{') depth++;
      else if (ch === '}') depth--;

      if (depth === 0) {
        // Found a complete JSON object
        const candidate = trimmed.slice(i, j + 1);
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
          }
        } catch {
          // Not valid JSON, continue searching
        }
        break;
      }
    }
  }

  return undefined;
}

function extractFromToolCalls(agentResult: AgentResult): Record<string, unknown> | undefined {
  const toolCalls = agentResult.metadata?.toolCallsDetail as
    | Array<{ name?: string; arguments?: Record<string, unknown> }>
    | undefined;

  if (!toolCalls?.length) {
    return undefined;
  }

  for (let i = toolCalls.length - 1; i >= 0; i--) {
    const tc = toolCalls[i];
    if (tc.name === WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME && tc.arguments) {
      return tc.arguments;
    }
  }

  return undefined;
}

function extractFromMessages(
  messages?: AgentResult['messages']
): Record<string, unknown> | undefined {
  if (!messages?.length) {
    return undefined;
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.toolName !== WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME || !msg.content) {
      continue;
    }

    const fromMarker = parseWorkflowJsonOutput(msg.content);
    if (fromMarker) {
      return fromMarker;
    }

    try {
      const parsed = JSON.parse(msg.content);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // ignore
    }
  }

  return undefined;
}

function validateAgainstSchema(
  data: Record<string, unknown> | undefined,
  schema?: JsonSchemaObject
): Record<string, unknown> | undefined {
  if (!data) {
    return undefined;
  }

  if (!schema) {
    return data;
  }

  try {
    return jsonSchemaToZod(schema).parse(data) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
