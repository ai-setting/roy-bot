/**
 * @fileoverview workflow_submit_output - Tool for AgentNode JSON structured output
 *
 * Design (tool self-recording pattern):
 * - This tool receives the `HookContext` from the plugin at construction time.
 * - When `execute(args)` is called by the json-extract sub-agent, the tool:
 *   1. Validates `args` against the dynamic zod schema derived from `outputSchema`.
 *   2. Writes the parsed JSON directly to `hookCtx.structuredOutputExtracted`.
 *   3. Returns a marker-prefixed string output for compatibility.
 *
 * As a result, the plugin no longer needs to inspect `result.toolCalls` and
 * re-validate; it just reads `hookCtx.structuredOutputExtracted` after the
 * json-extract sub-agent finishes.
 */

import { z } from 'zod';
import type { ToolInfo } from '../../tool/types';
import type { HookContext as AgentHookContext } from '../../agent/types';
import { jsonSchemaToZod, type JsonSchemaObject } from '../utils/json-schema-to-zod';

export const WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME = 'workflow_submit_output';

export const WorkflowJsonOutputMarker = '__WORKFLOW_JSON_OUTPUT__';

/**
 * Create a `workflow_submit_output` tool bound to a specific hook context.
 *
 * @param schema - The JSON schema describing the expected structured output.
 * @param hookCtx - The agent hook context. The tool writes the validated
 *                  structured JSON to `hookCtx.structuredOutputExtracted`
 *                  so the calling plugin can pick it up without needing to
 *                  re-inspect tool call history.
 */
export function createSubmitJsonOutputTool(
  schema: JsonSchemaObject,
  hookCtx: AgentHookContext,
): ToolInfo<z.ZodObject<z.ZodRawShape>> {
  const parameters = jsonSchemaToZod(schema);

  return {
    name: WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME,
    description:
      'Submit the final structured JSON result for this workflow agent step. ' +
      'You MUST call this tool once with your final answer — do not reply with plain text only.',
    parameters,
    async execute(args) {
      // 1. Validate args against the dynamic zod schema (zod throws on failure)
      const parsed = parameters.parse(args);
      // 2. Self-record into hookCtx so the plugin can read it directly
      hookCtx.structuredOutputExtracted = parsed as Record<string, unknown>;
      // 3. Return marker output (kept for backward compatibility / debugging)
      return {
        success: true,
        output: `${WorkflowJsonOutputMarker}:${JSON.stringify(parsed)}`,
      };
    },
    metadata: {
      category: 'workflow',
      tags: ['structured-output'],
      version: '1.1.0',
    },
  };
}

/**
 * Parse a marker-prefixed output string back into a typed JSON object.
 *
 * Kept for callers that still scan session history (e.g.
 * `utils/extract-agent-json-output.ts`). The new self-recording flow
 * does not need this, but we keep it as a public utility.
 */
export function parseWorkflowJsonOutput(output: unknown): Record<string, unknown> | undefined {
  if (typeof output !== 'string') {
    return undefined;
  }
  if (!output.startsWith(`${WorkflowJsonOutputMarker}:`)) {
    return undefined;
  }
  try {
    const data = JSON.parse(output.slice(WorkflowJsonOutputMarker.length + 1));
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return data as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
