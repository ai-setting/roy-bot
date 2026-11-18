/**
 * @fileoverview Schema Helper
 * 
 * 提供 Zod schema 解析和工具函数，用于从 tool 的参数 schema
 * 提取参数信息、验证必需参数、生成 yargs 选项等。
 */

import { z, ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * 参数信息
 */
export interface ParameterInfo {
  /** 参数名称 */
  name: string;
  /** 参数类型 */
  type: string;
  /** 参数描述 */
  description: string;
  /** 是否必需 */
  required: boolean;
  /** 默认值 */
  default?: unknown;
}

/**
 * 验证结果
 */
export interface ValidateResult {
  /** 是否有效 */
  valid: boolean;
  /** 缺少的必需参数 */
  missing: string[];
}

/**
 * 从 Zod schema 提取参数信息
 * 
 * @param schema - Zod schema
 * @returns 参数信息数组
 */
export function extractParameters(schema: any): ParameterInfo[] {
  const jsonSchema = zodToJsonSchema(schema) as Record<string, unknown>;
  const properties = (jsonSchema.properties || {}) as Record<string, unknown>;
  const required = ((jsonSchema.required as string[]) || []);

  return Object.entries(properties).map(([name, prop]) => ({
    name,
    type: (prop as any).type || "any",
    description: (prop as any).description || "",
    required: required.includes(name),
    default: (prop as any).default,
  }));
}

/**
 * 检查参数是否完整
 * 
 * @param params - 参数信息数组
 * @param args - 用户提供的参数
 * @returns 验证结果
 */
export function validateRequiredParams(
  params: ParameterInfo[],
  args: Record<string, unknown>
): ValidateResult {
  const missing = params
    .filter((p) => p.required)
    .filter((p) => args[p.name] === undefined)
    .map((p) => p.name);

  return {
    valid: missing.length === 0,
    missing,
  };
}

/**
 * 格式化参数为 yargs 选项
 * 
 * @param params - 参数信息数组
 * @returns yargs 选项配置
 */
export function formatYargsOptions(params: ParameterInfo[]): Record<string, any> {
  const options: Record<string, any> = {};

  for (const param of params) {
    // 映射类型到 yargs 类型
    let yargsType: "string" | "number" | "boolean";
    if (param.type === "number" || param.type === "integer") {
      yargsType = "number";
    } else if (param.type === "boolean") {
      yargsType = "boolean";
    } else {
      yargsType = "string";
    }

    options[param.name] = {
      type: yargsType,
      description: param.description || param.name,
      demandOption: param.required,
    };

    if (param.default !== undefined) {
      options[param.name].default = param.default;
    }
  }

  return options;
}
