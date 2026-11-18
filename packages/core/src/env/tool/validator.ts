import { ZodError } from "zod";
import type { Tool, ValidationResult } from "./types";

/**
 * 逃生开关：tool.reason.required（Task #5422）
 *
 * 默认 true —— 所有工具调用必须携带非空字符串 reason。
 * 设为 false 时：
 * - ToolValidator 跳过 reason 前置校验；
 * - toolParametersToJsonSchema() 同步跳过 reason 注入
 *   （两处共用本状态，语义一致）。
 *
 * 运行时优先读 ConfigComponent（tool.reason.required，支持热更新），
 * 未接线时回退到模块级开关（测试 / 独立进程场景）。
 */

const REASON_REQUIRED_CONFIG_KEY = "tool.reason.required";

let moduleLevelReasonRequired = true;

let configComponentRef: { get(key: string): unknown } | null = null;

/** 接线 ConfigComponent（由 ToolComponent.init 调用，支持热更新） */
export function setToolReasonConfigComponent(
  component: { get(key: string): unknown } | null
): void {
  configComponentRef = component;
}

/** 测试 / 无 ConfigComponent 场景的模块级开关 */
export function setToolReasonRequired(required: boolean): void {
  moduleLevelReasonRequired = required;
}

/** 当前是否要求 reason（逃生开关读取，实时） */
export function isToolReasonRequired(): boolean {
  if (configComponentRef) {
    const v = configComponentRef.get(REASON_REQUIRED_CONFIG_KEY);
    if (typeof v === "boolean") return v;
    if (typeof v === "string") return v !== "false";
  }
  return moduleLevelReasonRequired;
}

/**
 * 工具参数验证器
 */
export class ToolValidator {
  /**
   * 验证参数
   */
  async validate(tool: Tool, args: Record<string, unknown>): Promise<ValidationResult> {
    // ★ Task #5422：reason 前置校验（B+C 方案的 C 半边）
    // 在 zod parse 之前检查，避免各工具 schema 逐个声明 reason。
    // 校验失败信息会作为 tool result 回给模型，模型自愈重填。
    if (isToolReasonRequired()) {
      const reason = args?.["reason"];
      if (typeof reason !== "string" || reason.trim() === "") {
        return {
          success: false,
          error:
            `Missing or empty required parameter 'reason' for tool '${tool.name}': ` +
            `provide a one-sentence explanation of why you are calling this tool.`,
        };
      }
    }

    try {
      // 使用 Zod 验证参数
      const parsed = await tool.parameters.parseAsync(args);
      return {
        success: true,
        data: parsed as Record<string, unknown>,
      };
    } catch (error) {
      if (error instanceof ZodError) {
        const errorMessage = tool.formatValidationError
          ? tool.formatValidationError(error)
          : this.formatError(error);
        return {
          success: false,
          error: `Invalid arguments for tool '${tool.name}': ${errorMessage}`,
        };
      }
      return {
        success: false,
        error: `Validation error: ${error}`,
      };
    }
  }

  /**
   * 格式化 Zod 错误
   */
  private formatError(error: ZodError): string {
    return error.errors
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join("; ");
  }
}
