/**
 * Build AgentNode execution output, flattening JSON fields for template access.
 *
 * When output.mode=json, the structured JSON is extracted from agentResult.structuredOutput
 * (populated by workflow-json-output-plugin via json-extract sub-agent tool call).
 * Individual JSON fields are spread so downstream nodes can reference them directly:
 *   {{nodes.foo.output.field}} rather than {{nodes.foo.output.result.field}}
 */

import type { AgentResult } from '../nodes/agent-node';
import type { AgentOutputConfig } from './parse-agent-output-config';
import { extractAgentJsonOutput } from './extract-agent-json-output';
import type { JsonSchemaObject } from './json-schema-to-zod';

/**
 * Issue #1694: when JSON extraction fails, downstream templates need a
 * structured placeholder instead of a raw string. We extract the top-level
 * field names from the JSON Schema so the placeholder has the right shape.
 *
 * Common JSON-Schema keywords we care about:
 *   - `properties`: object field definitions
 *   - `required`: which fields are mandatory (helps prioritize fills)
 */
function extractSchemaFieldNames(schema?: JsonSchemaObject): string[] {
  if (!schema) return [];
  const props = schema.properties;
  if (!props || typeof props !== 'object') return [];
  return Object.keys(props);
}

/**
 * Pick a sane placeholder value for a schema field by name, so the
 * downstream template (`{{nodes.X.result.field}}`) doesn't trip on
 * undefined. Field-name heuristics handle the common cases; otherwise
 * an empty string is returned (safe for most template access patterns).
 */
function defaultValueForField(fieldName: string): unknown {
  const lower = fieldName.toLowerCase();
  if (lower === 'score' || lower.endsWith('_score')) return 0;
  if (lower === 'findings' || lower.endsWith('_list') || lower.endsWith('s')) return [];
  if (lower.includes('count') || lower.includes('total')) return 0;
  if (lower === 'dimension') return 'unknown';
  if (lower === 'verdict') return 'unknown';
  if (lower.includes('summary') || lower.includes('description') || lower.includes('report')) return '';
  if (lower.includes('markdown')) return '';
  return '';
}

export function buildAgentNodeOutput(
  agentResult: AgentResult,
  outputConfig: AgentOutputConfig
): Record<string, unknown> {
  if (outputConfig.mode === 'json') {
    const schema = outputConfig.schema as JsonSchemaObject | undefined;
    const jsonData = extractAgentJsonOutput(agentResult, schema);

    // JSON 提取成功：展开字段供下游节点使用
    if (jsonData) {
      return {
        result: jsonData,
        ...jsonData,
        metadata: {
          ...agentResult.metadata,
          outputMode: 'json',
        },
        workflowHistory: agentResult.messages,
      };
    }

    // JSON 提取失败：返回结构化错误对象，下游模板 {{nodes.X.result.field}}
    // 仍能 introspect 而不会因字符串的 '.' 解析抛错。
    // Issue #1694 (downstream safety)：透传原始字符串会让 meta-reviewer
    // 的模板渲染崩掉，所以 fallback 到 schema-shape placeholder。
    const rawText = typeof agentResult.output === 'string'
      ? agentResult.output
      : JSON.stringify(agentResult.output ?? {});

    // 尝试从 schema 中提取顶层字段名（用于 placeholder object）
    const schemaFields = extractSchemaFieldNames(schema);

    // Task #2164 fallback session: differentiate the empty-output root cause.
    // When raw is '{}', empty, null, or undefined, the json-extract sub-agent
    // may have been skipped because its prompt was missing or aborted before
    // calling workflow_submit_output. Point operators at that likely cause
    // instead of returning the generic extraction failure reason.
    const trimmedRaw = rawText.trim();
    const isEmptyOutput =
      trimmedRaw === '' ||
      trimmedRaw === '{}' ||
      trimmedRaw === 'null' ||
      trimmedRaw === 'undefined';
    const extractionReason = isEmptyOutput
      ? `json-extract sub-agent returned empty output (raw='${trimmedRaw}') — ` +
        `verify builtInPrompts['json-extract'] is defined and the sub-agent ran ` +
        'to completion (not aborted before calling workflow_submit_output)'
      : 'JSON extraction failed (json-extract sub-agent did not call workflow_submit_output)';

    const placeholderResult: Record<string, unknown> = {
      _extraction_failed: true,
      _raw_output: rawText,
      _extraction_reason: extractionReason,
    };

    // 用 schema 字段名填补 placeholder，让下游模板见到合理的默认值
    for (const fieldName of schemaFields) {
      if (!(fieldName in placeholderResult)) {
        placeholderResult[fieldName] = defaultValueForField(fieldName);
      }
    }

    return {
      result: placeholderResult,
      ...placeholderResult,
      metadata: {
        ...agentResult.metadata,
        outputMode: 'json_error',
        _extractionWarning: 'JSON extraction failed — placeholder returned for downstream safety',
      },
      workflowHistory: agentResult.messages,
    };
  }

  return {
    result: agentResult.output,
    metadata: agentResult.metadata,
    workflowHistory: agentResult.messages,
  };
}