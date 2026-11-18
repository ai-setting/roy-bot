import { z, ZodType, ZodTypeDef } from "zod";
import type { LLMMessage, ToolInfo, ToolResult } from "./types";

/**
 * LLM 消息转换工具
 */
export class LLMTransform {
  /**
   * 标准化消息格式
   * 根据不同 Provider 调整消息格式
   */
  normalizeMessages(messages: LLMMessage[], providerType: string): LLMMessage[] {
    return messages.map((msg) => {
      // 根据 Provider 类型进行转换
      switch (providerType) {
        case "anthropic":
          return this.normalizeForAnthropic(msg);
        case "openai":
        case "openai-compatible":
        default:
          return this.normalizeForOpenAI(msg);
      }
    });
  }

  /**
   * 标准化为 OpenAI 格式
   */
  private normalizeForOpenAI(msg: LLMMessage): LLMMessage {
    return {
      role: msg.role,
      content: msg.content,
      toolCalls: msg.toolCalls,
      toolCallId: msg.toolCallId,
    };
  }

  /**
   * 标准化为 Anthropic 格式
   */
  private normalizeForAnthropic(msg: LLMMessage): LLMMessage {
    // Anthropic 使用不同的 tool 消息格式
    if (msg.role === "tool") {
      return {
        role: "user" as const, // Anthropic 使用 user role 传递 tool 结果
        content: msg.content,
        toolCallId: msg.toolCallId,
      };
    }
    return msg;
  }

  /**
   * 从 ToolInfo 提取 JSON Schema
   */
  extractToolSchema(tool: ToolInfo): {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  } {
    return {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    };
  }

  /**
   * 将 Zod Schema 转换为 JSON Schema
   * 兼容 Zod v3 和 v4
   */
  zodToJsonSchema(schema: any): Record<string, unknown> {
    return this.extractZodSchema(schema);
  }

  /**
   * 提取 Zod Schema 的结构
   * 兼容 Zod v3 和 v4
   * 
   * Zod v3: schema._def.typeName === "ZodObject"
   * Zod v4: schema._def.type === "object"
   */
  private extractZodSchema(schema: any): Record<string, unknown> {
    // Zod v4 使用不同的内部结构
    // schema._def 包含类型的定义
    const def = schema._def;
    if (!def) return {};

    // 获取类型标识符
    // Zod v3: def.typeName === "ZodObject", "ZodString", etc.
    // Zod v4: def.type === "object", "string", etc.
    const typeName = (def.typeName as string) || "";
    const type = (def.type as string) || "";

    // 判断是 Zod v3 还是 v4
    const isV3 = typeName.startsWith("Zod");
    const isV4 = !isV3 && type !== "";

    // 处理 ZodEffects (z.preprocess() / .transform())
    // Zod v3: def.typeName === "ZodEffects", def.schema 是被包裹的 schema
    // Zod v4: def.type === "pipe" / "transform"，同样有 inner schema
    //
    // Task #4619 (cross-validation m-1): without this branch a preprocess
    // schema fell through to the final `return {}` and silently produced an
    // **empty** schema — the model would have been told the tool takes no
    // parameters. The task tool schemas (`task_get` / `task_update` /
    // `task_complete`) are ZodEffects since the legacy-alias work, so this
    // is a live path, not a theoretical one.
    if (typeName === "ZodEffects" || type === "pipe" || type === "transform") {
      const inner = (def as { schema?: unknown }).schema;
      if (inner) return this.extractZodSchema(inner);
      return {};
    }

    // 处理 ZodObject (z.object())
    // Zod v3: def.typeName === "ZodObject", def.shape 是函数
    // Zod v4: def.type === "object", def.shape 是对象
    if ((isV3 && typeName === "ZodObject") || (isV4 && type === "object")) {
      // 获取 shape - Zod v3 是函数，Zod v4 是对象
      let shape: Record<string, unknown> | undefined;
      if (isV3) {
        // Zod v3: shape() 返回实际的对象
        const shapeFn = def.shape as unknown as () => Record<string, ZodType<unknown>>;
        shape = shapeFn ? shapeFn() : undefined;
      } else {
        // Zod v4: shape 直接是对象
        shape = def.shape as Record<string, unknown> | undefined;
      }
      
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      if (shape) {
        for (const [key, value] of Object.entries(shape)) {
          // 递归处理内部类型
          properties[key] = this.extractZodSchema(value as unknown as ZodType<unknown>);
          
          // 检查是否为可选字段
          // Zod v3: 使用 isOptional() 方法
          // Zod v4: 使用 _def.defaultValue !== undefined
          let isOptional = false;
          if (isV3) {
            const zodType = value as ZodType<unknown>;
            isOptional = typeof zodType.isOptional === 'function' ? zodType.isOptional() : false;
          } else {
            // Zod v4: 检查 _def.defaultValue
            const innerDef = (value as unknown as { _def?: Record<string, unknown> })._def;
            isOptional = innerDef?.defaultValue !== undefined;
          }
          
          if (!isOptional) {
            required.push(key);
          }
        }
      }

      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }

    // 处理 ZodEnum (z.enum())
    // Zod v3: def.typeName === "ZodEnum", def.values 是数组
    // Zod v4: def.type === "enum", def.entries 是 { value: value } 对象
    if ((isV3 && typeName === "ZodEnum") || (isV4 && type === "enum")) {
      // Zod v3: values 是数组
      const zodV3Enum = def as { values?: string[] };
      // Zod v4: entries 是对象
      const zodV4Enum = def as { entries?: Record<string, string> };
      
      const values = zodV3Enum.values || Object.values(zodV4Enum.entries || {});
      return {
        enum: values,
      };
    }

    // 处理 ZodNativeEnum (z.nativeEnum())
    if (isV3 && typeName === "ZodNativeEnum") {
      const enumDef = def as { values?: Record<string, string | number> };
      const values = Object.values(enumDef.values || {});
      return {
        enum: values,
      };
    }

    // 处理基本类型
    // Zod v3: typeName === "ZodString", etc.
    // Zod v4: type === "string", etc.
    if ((isV3 && typeName === "ZodString") || (isV4 && type === "string")) {
      return { type: "string" };
    }
    if ((isV3 && (typeName === "ZodNumber" || typeName === "ZodBigInt")) || (isV4 && (type === "number" || type === "bigint"))) {
      return { type: "number" };
    }
    if ((isV3 && typeName === "ZodBoolean") || (isV4 && type === "boolean")) {
      return { type: "boolean" };
    }

    // 处理 ZodArray (z.array())
    // Zod v3: def.type === ZodType (items)
    // Zod v4: def.type === "array", def.shape 包含 items
    if ((isV3 && typeName === "ZodArray") || (isV4 && type === "array")) {
      // Zod v3: def.type 是 items 类型
      if (isV3) {
        const itemsType = def.type as ZodType<unknown>;
        if (itemsType) {
          return {
            type: "array",
            items: this.extractZodSchema(itemsType),
          };
        }
      }
      // Zod v4: items 在 shape 属性中
      const shape = def.shape as Record<string, unknown> | undefined;
      if (shape) {
        const itemKey = Object.keys(shape)[0];
        const items = this.extractZodSchema(shape[itemKey] as unknown as ZodType<unknown>);
        return {
          type: "array",
          items,
        };
      }
      return {
        type: "array",
        items: {},
      };
    }

    // 处理 ZodOptional (z.optional())
    // Zod v3: def.innerType 是内部类型
    // Zod v4: def.type === "optional", def.shape 包含 innerType
    if ((isV3 && typeName === "ZodOptional") || (isV4 && type === "optional")) {
      // Zod v3: innerType 是内部类型
      if (isV3) {
        const innerType = (def as { innerType?: ZodType<unknown> }).innerType;
        if (innerType) {
          return this.extractZodSchema(innerType);
        }
      }
      // Zod v4: shape 包含 innerType
      const shape = def.shape as Record<string, unknown> | undefined;
      if (shape) {
        const innerKey = Object.keys(shape).find(k => k !== "undefinedType"); // Zod v4 的可选字段使用 undefinedType
        if (innerKey) {
          return this.extractZodSchema(shape[innerKey] as unknown as ZodType<unknown>);
        }
      }
      return {};
    }

    // 处理 ZodNullable (z.nullable())
    if (isV3 && typeName === "ZodNullable") {
      const innerType = (def as { innerType?: ZodType<unknown> }).innerType;
      if (innerType) {
        return this.extractZodSchema(innerType);
      }
    }

    return {};
  }

  /**
   * 格式化工具结果
   */
  formatToolResult(result: ToolResult): {
    role: "tool";
    tool_call_id: string;
    content: string;
    isError?: boolean;
  } {
    return {
      role: "tool",
      tool_call_id: result.toolCallId,
      content: result.result,
      ...(result.isError ? { isError: true } : {}),
    };
  }

  /**
   * 解析工具参数
   */
  parseToolArguments(args: string): Record<string, unknown> {
    if (!args || args.trim() === "") {
      return {};
    }

    try {
      return JSON.parse(args);
    } catch {
      return {};
    }
  }

  /**
   * 序列化工具参数为 JSON 字符串
   */
  serializeToolArguments(args: Record<string, unknown>): string {
    return JSON.stringify(args);
  }
}
