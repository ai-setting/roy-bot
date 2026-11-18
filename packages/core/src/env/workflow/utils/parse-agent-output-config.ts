/**
 * Parse AgentNode output configuration from workflow node config.
 */

import { validateJsonOutputSchema } from './json-schema-to-zod';

export type AgentOutputMode = 'string' | 'json';

export interface AgentOutputConfig {
  mode: AgentOutputMode;
  schema?: Record<string, unknown>;
}

export function parseAgentOutputConfig(
  config: Record<string, unknown>
): AgentOutputConfig {
  const output = config.output as Record<string, unknown> | undefined;
  if (!output) {
    return { mode: 'string' };
  }

  const mode: AgentOutputMode = output.mode === 'json' ? 'json' : 'string';

  if (mode === 'json') {
    if (output.schema === undefined) {
      throw new Error('AgentNode output.mode=json requires output.schema');
    }
    const schema = validateJsonOutputSchema(output.schema);
    // AgentOutputConfig.schema 类型是 Record<string, unknown>，但实际承载
    // JsonSchemaObject（包含 type/properties/required 等子字段）。二者形状
    // 不同（缺少字符串索引签名），这里用 unknown 双向 cast 保持类型兼容。
    return { mode, schema: schema as unknown as Record<string, unknown> };
  }

  return { mode: 'string' };
}
