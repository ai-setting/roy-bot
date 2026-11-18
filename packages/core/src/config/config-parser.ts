/**
 * Configuration Parser
 * 
 * Provides JSONC parsing and environment/protocol variable substitution
 */
import { parse as parseJSONCInternal, ParseErrorCode } from "jsonc-parser";
import { ProtocolResolver } from "./protocol-resolver";

/**
 * Parse JSONC (JSON with Comments) content
 * Supports single-line comments (//) and multi-line comments
 * 
 * @param content - JSONC content string
 * @returns Parsed JSON object
 */
export function parseJSONC(content: string): Record<string, unknown> {
  const errors: any[] = [];
  const result = parseJSONCInternal(content, errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  
  if (errors.length > 0) {
    // 过滤掉"没有值"的警告（文件只有注释时会出现）
    // 只有当 result 是 undefined 且只有一个 ValueExpected 错误时才忽略
    const hasOnlyValueExpected = 
      result === undefined && 
      errors.length === 1 && 
      errors[0].error === ParseErrorCode.ValueExpected;
    
    if (!hasOnlyValueExpected) {
      const error = errors[0];
      const offset = error.offset;
      const lines = content.substring(0, offset).split("\n");
      const line = lines.length;
      const col = lines[lines.length - 1].length + 1;
      
      const errorMessages: Record<number, string> = {
        [ParseErrorCode.UnexpectedEndOfString]: "Unexpected end of string",
        [ParseErrorCode.InvalidCharacter]: "Invalid character",
        [ParseErrorCode.PropertyNameExpected]: "Property name expected",
        [ParseErrorCode.ValueExpected]: "Value expected",
        [ParseErrorCode.ColonExpected]: "Colon expected",
        [ParseErrorCode.CommaExpected]: "Comma expected",
        [ParseErrorCode.CloseBraceExpected]: "Close brace expected",
        [ParseErrorCode.CloseBracketExpected]: "Close bracket expected",
        [ParseErrorCode.EndOfFileExpected]: "Unexpected end of input",
        [ParseErrorCode.InvalidSymbol]: "Invalid symbol",
      };
      
      throw new Error(
        `JSONC parse error at line ${line}, col ${col}: ${errorMessages[error.error] || "Unknown error"}`
      );
    }
  }
  
  // 处理空内容（只有注释的情况）
  if (result === undefined || result === null) {
    return {};
  }
  
  return result as Record<string, unknown>;
}

/**
 * Substitute environment variables in a value
 * Supports ${VAR} and ${VAR:-default} syntax
 * 
 * @param value - Value to substitute (string, object, array, or primitive)
 * @returns Value with environment variables substituted
 */
export function substituteEnvVars(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (match, varExpr) => {
      const [varName, defaultValue] = varExpr.split(":-");
      const envValue = process.env[varName.trim()];
      if (envValue !== undefined) {
        return envValue;
      }
      if (defaultValue !== undefined) {
        return defaultValue;
      }
      return "";
    });
  }
  
  if (Array.isArray(value)) {
    return value.map(item => substituteEnvVars(item));
  }
  
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = substituteEnvVars(val);
    }
    return result;
  }
  
  return value;
}

/**
 * Parse JSONC content and substitute environment variables
 * 
 * @param content - JSONC content string
 * @returns Parsed JSON object with env vars substituted
 */
export function parseJSONCWithEnv(content: string): Record<string, unknown> {
  const parsed = parseJSONC(content);
  return substituteEnvVars(parsed) as Record<string, unknown>;
}

/**
 * Protocol reference pattern - 支持带默认值的协议引用
 * 格式: ${protocol://path#key:-default} 或 ${protocol://path:-default}
 */
const PROTOCOL_REF_PATTERN = /^\$\{([^:]+):\/\/[^}]+\}$/;

/**
 * Protocol reference with default value pattern
 * 格式: ${protocol://path#key:-default}
 */
const PROTOCOL_REF_WITH_DEFAULT_PATTERN = /^\$\{([^:]+):\/\/([^:#]+)(?:#([^:-]+))?(?::-(.*))?\}$/;

/**
 * Check if a string is a protocol reference
 */
function isProtocolRefString(value: string): boolean {
  return PROTOCOL_REF_PATTERN.test(value);
}

/**
 * Extract default value from protocol reference string
 */
function extractDefaultValue(ref: string): string | undefined {
  const match = ref.match(PROTOCOL_REF_WITH_DEFAULT_PATTERN);
  return match ? match[4] : undefined;
}

/**
 * Substitute protocol references in a value using the provided resolver
 * 
 * Supports:
 * - ${file://path#key} - Read from file
 * - ${env://varName} - Read from environment variable
 * - All above with default values: ${protocol://...:-default}
 * 
 * @param value - Value to substitute (string, object, array, or primitive)
 * @param resolver - ProtocolResolver instance
 * @returns Value with protocol references substituted
 */
export function substituteProtocolRefs(
  value: unknown,
  resolver: ProtocolResolver
): unknown {
  if (typeof value === "string") {
    // 如果整个字符串就是协议引用，尝试解析
    if (isProtocolRefString(value)) {
      const result = resolver.resolve(value);
      if (result !== null) {
        return result.value;
      }
      // 解析失败，检查是否有默认值
      const defaultValue = extractDefaultValue(value);
      if (defaultValue !== undefined) {
        return defaultValue;
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(item => substituteProtocolRefs(item, resolver));
  }

  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = substituteProtocolRefs(val, resolver);
    }
    return result;
  }

  return value;
}

/**
 * Parse JSONC content and substitute protocol references
 * 
 * @param content - JSONC content string
 * @param resolver - ProtocolResolver instance
 * @returns Parsed JSON object with protocol refs substituted
 */
export function parseJSONCWithProtocols(
  content: string,
  resolver: ProtocolResolver
): Record<string, unknown> {
  const parsed = parseJSONC(content);
  // 先解析协议引用（保护协议引用不被环境变量替换破坏）
  const withProtocols = substituteProtocolRefs(parsed, resolver) as Record<string, unknown>;
  // 再解析环境变量（只处理非协议引用的字符串）
  return substituteEnvVars(withProtocols) as Record<string, unknown>;
}
