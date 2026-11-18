/**
 * @fileoverview MCP Tool 适配器
 *
 * 将 MCP 工具转换为 Environment Tool
 * 完整保留参数描述等信息，供 LLM 正确调用
 */

import { z, ZodType, ZodTypeDef } from "zod";
import type { Tool as McpTool, CallToolResult as McpCallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ToolInfo, ToolContext, ToolResult } from "../../tool/types";
import { createLogger } from "../../log-trace/logger";

const logger = createLogger("mcp-adapter");

/**
 * 扩展的 JSON Schema 定义
 */
interface JSONSchema7 {
  type?: string;
  types?: string[]; // MCP 可能使用 types 代替 type
  properties?: Record<string, JSONSchema7>;
  required?: string[];
  items?: JSONSchema7;
  additionalProperties?: boolean | JSONSchema7;
  description?: string;
  title?: string;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  anyOf?: JSONSchema7[];
  oneOf?: JSONSchema7[];
  allOf?: JSONSchema7[];
  const?: unknown;
  nullable?: boolean;
  examples?: unknown[];
}

/**
 * 增强的 Zod 类型定义，支持描述
 */
interface ZodTypeWithDescription {
  schema: z.ZodType;
  description?: string;
}

/**
 * 参数验证结果
 */
interface ParamValidationResult {
  valid: boolean;
  missing: string[];
  error?: string;
}

/**
 * 验证必需参数
 *
 * 在调用 MCP tool 前检查所有必需参数是否存在
 */
function validateRequiredParams(
  inputSchema: McpTool["inputSchema"],
  args: Record<string, unknown>
): ParamValidationResult {
  if (!inputSchema) {
    return { valid: true, missing: [] };
  }

  const schema = inputSchema as JSONSchema7;
  const required = schema.required ?? [];

  if (required.length === 0) {
    return { valid: true, missing: [] };
  }

  const missing: string[] = [];
  for (const param of required) {
    const value = args[param];
    if (value === undefined || value === null) {
      missing.push(param);
    }
  }

  if (missing.length > 0) {
    return {
      valid: false,
      missing,
      error: `Missing required parameter${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}`,
    };
  }

  return { valid: true, missing: [] };
}

/**
 * 将 MCP 工具转换为 Environment Tool
 *
 * 命名策略: mcp_{serverName}_{toolName}
 */
export function adaptMcpTool(
  mcpTool: McpTool,
  mcpClient: Client,
  serverName: string
): ToolInfo {
  const toolName = `mcp_${serverName}_${mcpTool.name}`;
  const description = `MCP tool [${serverName}/${mcpTool.name}]: ${mcpTool.description ?? ""}`;

  // 转换参数 schema（包含描述信息）
  const paramsSchema = convertInputSchemaToZod(mcpTool.inputSchema);

  return {
    name: toolName,
    description,
    parameters: paramsSchema,
    execute: async (args: unknown, _ctx: ToolContext): Promise<ToolResult> => {
      const toolArgs = (args as Record<string, unknown>) ?? {};

      // Bug 1 Fix: 验证必需参数
      const validation = validateRequiredParams(mcpTool.inputSchema, toolArgs);
      if (!validation.valid) {
        logger.warn(`[McpAdapter] Tool call skipped: ${toolName}`, {
          reason: "missing_required_params",
          missing: validation.missing,
        });
        return {
          success: false,
          output: "",
          error: validation.error!,
        };
      }

      try {
        const result = await mcpClient.callTool({
          name: mcpTool.name,
          arguments: toolArgs,
        });

        // 转换结果
        return convertMcpCallResult(result as unknown as McpCallToolResult);
      } catch (error) {
        // 记录详细错误信息
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorCode = (error as any)?.code;

        logger.error(`[McpAdapter] Tool call failed: ${toolName}`, {
          error: errorMessage,
          errorCode,
          receivedArgs: toolArgs,
        });

        // 处理 JSON-RPC 错误码
        let userMessage = errorMessage;
        if (errorCode === -32602) {
          userMessage = `Invalid parameters for tool "${mcpTool.name}": ${errorMessage}`;
        }

        return {
          success: false,
          output: "",
          error: userMessage,
        };
      }
    },
    metadata: {
      category: "mcp",
      tags: ["mcp", serverName],
      // 保留原始 MCP 工具信息，供 LLM 使用
      mcpTool: {
        originalName: mcpTool.name,
        originalDescription: mcpTool.description || "",
        inputSchema: mcpTool.inputSchema,
      },
    },
  };
}

/**
 * 转换 MCP inputSchema 为 Zod schema
 *
 * 关键：保留参数描述，让 LLM 知道每个参数的用途
 */
export function convertInputSchemaToZod(inputSchema: McpTool["inputSchema"]): z.ZodType<unknown> {
  if (!inputSchema) {
    return z.unknown();
  }

  const schema = inputSchema as JSONSchema7;
  const properties = schema.properties ?? {};
  const required = schema.required ?? [];

  // 检查是否有 anyOf/oneOf - 表示联合类型
  if (schema.anyOf || schema.oneOf) {
    const unions = schema.anyOf || schema.oneOf || [];
    const zodUnions = unions.map((s) => jsonSchemaToZod(s, false)).filter((t) => t);
    if (zodUnions.length > 0) {
      // 使用 any 避免复杂的类型问题
      return z.union(zodUnions as any);
    }
  }

  // 处理 anyOf/oneOf 作为联合类型
  if (schema.allOf) {
    // allOf 表示组合多个 schema
    const schemas: z.ZodTypeAny[] = [];
    for (const subSchema of schema.allOf) {
      const sub = jsonSchemaToZod(subSchema, false);
      schemas.push(sub);
    }
    if (schemas.length === 1) {
      return schemas[0];
    }
    // 使用 intersect 替代 merge
    let combined: z.ZodTypeAny = schemas[0];
    for (let i = 1; i < schemas.length; i++) {
      combined = z.intersection(combined as z.ZodType<unknown>, schemas[i] as z.ZodType<unknown>);
    }
    return combined;
  }

  // 构建对象 schema
  const zodFields: Record<string, z.ZodType> = {};
  const fieldDescriptions: Record<string, string> = {};

  for (const [key, prop] of Object.entries(properties)) {
    const isRequired = required.includes(key);
    const fieldResult = jsonSchemaToZod(prop as JSONSchema7, !isRequired);

    // 保留参数描述
    const propSchema = prop as JSONSchema7;
    if (propSchema.description) {
      fieldDescriptions[key] = propSchema.description;
    }

    // 如果不是 required，添加 optional
    if (!isRequired) {
      zodFields[key] = fieldResult.optional();
    } else {
      zodFields[key] = fieldResult;
    }
  }

  // 使用 describe 构建 schema
  if (Object.keys(zodFields).length === 0) {
    return schema.description ? z.unknown().describe(schema.description) : z.unknown();
  }

  // 构建带描述的 Zod schema
  const result = z.object(zodFields);

  // 添加 schema 级别的描述
  if (schema.description) {
    return result.describe(schema.description);
  }

  return result;
}

/**
 * JSON Schema 属性转 Zod 类型
 *
 * 保留描述信息
 */
function jsonSchemaToZod(prop: JSONSchema7, isOptional: boolean): z.ZodTypeAny {
  const description = prop.description;
  let baseType: z.ZodType;

  // 处理 nullable
  if (prop.nullable === true) {
    const innerType = jsonSchemaToZod({ ...prop, nullable: undefined }, isOptional);
    baseType = z.union([innerType, z.null()]);
    if (description) {
      return baseType.describe(description);
    }
    return baseType;
  }

  // 处理 anyOf/oneOf
  if (prop.anyOf || prop.oneOf) {
    const unions = prop.anyOf || prop.oneOf || [];
    const zodUnions = unions
      .map((s) => jsonSchemaToZod(s, false))
      .filter((t) => t);
    if (zodUnions.length > 0) {
      baseType = z.union(zodUnions as any);
      if (description) {
        return baseType.describe(description);
      }
      return baseType;
    }
  }

  // 处理 allOf
  if (prop.allOf) {
    const schemas: z.ZodTypeAny[] = [];
    for (const subSchema of prop.allOf) {
      const sub = jsonSchemaToZod(subSchema, false);
      schemas.push(sub);
    }
    if (schemas.length === 1) {
      baseType = schemas[0];
    } else {
      // 使用 intersect 组合
      baseType = z.intersection(schemas[0] as z.ZodType<unknown>, schemas[1] as z.ZodType<unknown>);
      for (let i = 2; i < schemas.length; i++) {
        baseType = z.intersection(baseType, schemas[i] as z.ZodType<unknown>);
      }
    }
    if (description) {
      return baseType.describe(description);
    }
    return baseType;
  }

  // 获取类型（支持 type 或 types）
  const types = prop.types || (prop.type ? [prop.type] : []);

  // 处理多个类型
  if (types.length > 1) {
    const zodTypes = types
      .map((t) => getZodTypeForBasicType(t, prop))
      .filter((t) => t);
    if (zodTypes.length > 0) {
      baseType = z.union(zodTypes as any);
      if (description) {
        return baseType.describe(description);
      }
      return baseType;
    }
  }

  // 单类型处理
  const type = types[0];
  if (!type) {
    // 没有类型但有 enum
    if (prop.enum) {
      // handleEnum 内部会处理描述
      return handleEnum(prop, description);
    }
    // 没有类型也没有 enum，返回 unknown
    baseType = z.unknown();
    if (description) {
      return baseType.describe(description);
    }
    return baseType;
  }

  baseType = getZodTypeForBasicType(type, prop);

  // 添加描述（但保留 handleEnum 已经添加的有效值描述）
  if (description) {
    // 检查 schema 是否有描述（来自 handleEnum）
    const schemaDescription = (baseType as any)._def?.description;
    if (schemaDescription) {
      // 如果 schema 已有描述，说明是 enum，追加而不是覆盖
      return baseType.describe(`${schemaDescription}. ${description}`);
    }
    return baseType.describe(description);
  }

  return baseType;
}

/**
 * 根据基本类型获取 Zod 类型
 * 注意：不处理描述，描述由调用方统一处理
 */
function getZodTypeForBasicType(type: string, prop: JSONSchema7): z.ZodType {
  switch (type) {
    case "string": {
      // 优先处理 enum - 使用 handleEnum 来确保添加有效值描述
      if (prop.enum && prop.enum.length > 0 && prop.enum.every((v) => typeof v === "string")) {
        // handleEnum 会自动添加有效值列表到描述
        return handleEnum(prop, prop.description);
      }

      let schema = z.string();

      // 处理 minLength
      if (typeof prop.minLength === "number") {
        schema = schema.min(prop.minLength);
      }

      // 处理 maxLength
      if (typeof prop.maxLength === "number") {
        schema = schema.max(prop.maxLength);
      }

      // 处理 pattern (正则)
      if (prop.pattern) {
        try {
          schema = schema.regex(new RegExp(prop.pattern));
        } catch {
          // 无效的正则，忽略
        }
      }

      // 处理 format - 添加到 schema 描述
      if (prop.format) {
        schema = schema.describe(`Format: ${prop.format}`);
      }

      // 处理 default
      if (prop.default !== undefined) {
        schema = schema.default(prop.default as string) as any;
      }

      return schema;
    }

    case "number":
    case "integer": {
      let schema = type === "integer" ? z.number().int() : z.number();

      // 处理 minimum
      if (typeof prop.minimum === "number") {
        schema = schema.min(prop.minimum);
      }

      // 处理 maximum
      if (typeof prop.maximum === "number") {
        schema = schema.max(prop.maximum);
      }

      // 处理 default
      if (prop.default !== undefined) {
        schema = schema.default(prop.default as number) as any;
      }

      return schema;
    }

    case "boolean": {
      let schema = z.boolean();
      if (prop.default !== undefined) {
        schema = schema.default(prop.default as boolean) as any;
      }
      return schema;
    }

    case "array": {
      let itemSchema: z.ZodType = z.unknown();

      if (prop.items) {
        itemSchema = jsonSchemaToZod(prop.items as JSONSchema7, false);
      }

      let schema = z.array(itemSchema);

      // 处理 additionalProperties 作为数组成员类型
      if (prop.additionalProperties && typeof prop.additionalProperties !== "boolean") {
        const additionalItems = jsonSchemaToZod(prop.additionalProperties, false);
        // 混合数组
        schema = z.array(z.union([itemSchema, additionalItems]) as any);
      }

      return schema;
    }

    case "object": {
      if (prop.properties) {
        const fields: Record<string, z.ZodType> = {};
        const required = prop.required ?? [];

        for (const [key, value] of Object.entries(prop.properties)) {
          const isRequired = required.includes(key);
          fields[key] = isRequired
            ? jsonSchemaToZod(value as JSONSchema7, false)
            : jsonSchemaToZod(value as JSONSchema7, true).optional();
        }

        return z.object(fields);
      }

      // 没有 properties，检查 additionalProperties
      if (prop.additionalProperties) {
        if (typeof prop.additionalProperties === "boolean") {
          return z.record(z.string(), z.unknown());
        }
        return z.record(z.string(), jsonSchemaToZod(prop.additionalProperties, false));
      }

      return z.record(z.string(), z.unknown());
    }

    case "null":
      return z.null();

    case "null | string":
    case "string | null":
      return z.union([z.string(), z.null()]);

    case "null | number":
    case "number | null":
      return z.union([z.number(), z.null()]);

    default:
      // 处理 enum
      if (prop.enum) {
        return handleEnum(prop);
      }
      return z.unknown();
  }
}

/**
 * 处理 enum 类型
 * 
 * 关键改进：自动在描述中添加有效值列表，帮助 LLM 正确理解参数值
 * 例如：enum: ["24h", "week", "month"] -> 描述变为 "Valid values: 24h, week, month"
 */
function handleEnum(prop: JSONSchema7, existingDescription?: string): z.ZodType {
  if (!prop.enum || prop.enum.length === 0) {
    return z.unknown();
  }

  // 检查是否是字符串枚举
  const stringValues = prop.enum.filter((v) => typeof v === "string") as string[];
  if (stringValues.length === 0) {
    return z.any();
  }

  let schema: z.ZodType;
  if (stringValues.length === 1) {
    schema = z.literal(stringValues[0]);
  } else {
    schema = z.enum([stringValues[0], ...stringValues.slice(1)]);
  }

  // 构建有效值描述
  const valuesList = stringValues.map((v) => `"${v}"`).join(", ");
  const valuesDescription = `Valid values: ${valuesList}`;
  
  // 组合描述：如果有原始描述，追加有效值；如果没有，直接使用有效值
  if (existingDescription) {
    return schema.describe(`${existingDescription}. ${valuesDescription}`);
  }
  return schema.describe(valuesDescription);
}

/**
 * 转换 MCP 调用结果为 ToolResult
 */
function convertMcpCallResult(result: McpCallToolResult): ToolResult {
  const content = result.content;
  const textContent = content
    ?.filter((c) => c.type === "text")
    ?.map((c) => c.text)
    ?.join("") ?? "";

  return {
    success: !result.isError,
    output: textContent,
    error: result.isError ? textContent : undefined,
  };
}

/**
 * 创建 MCP 工具描述
 */
export function createMcpToolsDescription(tools: ToolInfo[]): string {
  if (tools.length === 0) {
    return "  No MCP tools currently available.";
  }

  return tools
    .map((t) => `  - ${t.name}: ${t.description}`)
    .join("\n");
}

/**
 * 获取工具的完整参数描述（供 LLM 使用）
 *
 * 从 Zod schema 中提取参数描述
 */
export function getToolParamDescriptions(tool: ToolInfo): Record<string, string> {
  const descriptions: Record<string, string> = {};

  // 从 metadata 中获取原始 schema
  const mcpMeta = tool.metadata?.mcpTool as {
    inputSchema?: JSONSchema7;
  } | undefined;

  if (mcpMeta?.inputSchema?.properties) {
    for (const [key, prop] of Object.entries(mcpMeta.inputSchema.properties)) {
      const propSchema = prop as JSONSchema7;
      if (propSchema.description) {
        descriptions[key] = propSchema.description;
      }
    }
  }

  return descriptions;
}
