/**
 * @fileoverview Tool call arguments parser - handles double-stringified JSON.
 *
 * LLMs sometimes double-stringify JSON arguments (a JSON string containing
 * another JSON string). This module provides a safe parser that recursively
 * attempts to parse until a real object is obtained, without leaking internal
 * mechanisms like `_raw` into the conversation history.
 *
 * Features:
 * - Recursive parsing for double/multi-stringified JSON
 * - Debug logging when recursion is detected (alerts developers to LLM anomalies)
 * - Maximum recursion depth protection (default: 5) to prevent infinite loops
 */

import { createLogger } from "../log-trace/logger";

const logger = createLogger("llm:tool-args-parser");

// ============================================================================
// Task #4231: 上游模型把「文本工具调用标记」混进结构化 arguments 的抢救
// ============================================================================
//
// 真实故障（2026-10-15，provider=tong / GLM-5.3-W4A8）：
//   模型在结构化 `function.arguments` 流里混入了它**原生文本工具调用模板**：
//     sub_session_id":"</arg_key><arg_value>"
//     ... "sub-session-_id</arg_key><arg_value>"
//   并伴随重复字（"后台台任务"、"调研研"）与全角括号乱码。
//
// ★ 证据：`arg_key` / `arg_value` / `<tool_call>` 这些字面量在 roy-bot 仓库
//   与 @earendil-works/pi-ai 里**一次都没出现**（grep 全仓 + vendor 均为 0），
//   所以它们只可能来自上游模型/网关的输出流 —— 属上游退化，不是拼接 bug。
//
// 我们能做的：① 尽量把这种 marker 抢救回合法 JSON；② 抢救不了就**明确报错给模型**，
// 绝不静默当 `{}` 去执行（否则会执行出一条乱码命令，还会让模型盲目重试）。
// ============================================================================

/** GLM/GLM-like 文本工具调用标记 */
const ARG_KEY_RE = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;

/**
 * 尝试把「文本工具调用标记」形式的参数抢救成 JSON 对象
 *
 * 输入形如：`<arg_key>command</arg_key><arg_value>ls -la</arg_value>`
 * 或散落在一段乱码 JSON 里的若干组标记。
 *
 * @returns 抢救成功返回对象；失败返回 undefined
 */
export function salvageTextualToolArgs(raw: string): Record<string, unknown> | undefined {
  if (!raw.includes("<arg_key>")) return undefined;
  const out: Record<string, unknown> = {};
  let matched = false;
  ARG_KEY_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ARG_KEY_RE.exec(raw)) !== null) {
    const key = m[1].trim();
    if (!key) continue;
    const value = m[2];
    // 值本身可能是 JSON（对象/数组/数字/bool），也可能就是字符串
    try {
      out[key] = JSON.parse(value);
    } catch {
      out[key] = value;
    }
    matched = true;
  }
  return matched ? out : undefined;
}

/** 剥掉文本工具调用标记（用于把"值里混进 marker"的脏 JSON 尽量救回来） */
export function stripTextualToolArgsMarkers(raw: string): string {
  return raw
    .replace(/<\/?arg_key>/g, "")
    .replace(/<\/?arg_value>/g, "")
    .replace(/<\/?tool_call>/g, "");
}

/** 参数解析结果（严格模式） */
export interface StrictToolArgsResult {
  ok: boolean;
  args: Record<string, unknown>;
  /** 失败原因（ok=false 时给人/模型看） */
  error?: string;
  /** 是否经过抢救（marker 剥离 / 文本标记重建） */
  salvaged?: boolean;
}

/**
 * 严格解析 tool 参数（Task #4231）
 *
 * 与 `safeParseToolArgs` 的差别：
 * - 失败时**不返回空对象**，而是 `{ok:false, error}` —— 调用方必须把错误回给模型，
 *   不能拿 `{}` 去执行工具（否则会执行乱码命令 / 默认参数造成误操作）。
 * - 会先尝试抢救上游退化格式（GLM 文本工具调用标记）。
 */
export function parseToolArgsStrict(args: unknown): StrictToolArgsResult {
  // 已经是对象：直接可用
  if (args && typeof args === "object" && !Array.isArray(args)) {
    return { ok: true, args: args as Record<string, unknown> };
  }

  if (typeof args !== "string") {
    return {
      ok: false,
      args: {},
      error: `tool arguments must be a JSON object, got ${args === null ? "null" : typeof args}`,
    };
  }

  const raw = args.trim();
  if (raw.length === 0) {
    // 空参数是合法的（无参工具）
    return { ok: true, args: {} };
  }

  // ① 直接 parse
  const direct = tryParseObject(raw);
  if (direct.ok) {
    // 值里可能混了 marker（JSON 仍合法，但值是脏的）→ 清洗值并标记 salvaged
    if (raw.includes("<arg_key>") || raw.includes("<arg_value>") || raw.includes("<tool_call>")) {
      logger.warn(
        "[parseToolArgsStrict] arguments 里出现上游文本工具调用标记，已清洗值中的 marker"
      );
      return { ok: true, args: sanitizeArgValues(direct.args), salvaged: true };
    }
    return { ok: true, args: direct.args };
  }

  // ② 抢救：值里混入 marker → 剥掉 marker 再 parse
  if (raw.includes("<arg_key>") || raw.includes("<arg_value>")) {
    const stripped = stripTextualToolArgsMarkers(raw);
    const afterStrip = tryParseObject(stripped);
    if (afterStrip.ok) {
      logger.warn(
        "[parseToolArgsStrict] 上游把文本工具调用标记混进了 arguments，已剥离 marker 后恢复"
      );
      return { ok: true, args: afterStrip.args, salvaged: true };
    }
    // ③ 抢救：整段是 `<arg_key>k</arg_key><arg_value>v</arg_value>` 形式 → 重建 JSON
    const salvaged = salvageTextualToolArgs(raw);
    if (salvaged) {
      logger.warn(
        "[parseToolArgsStrict] 上游输出的是文本工具调用格式，已按 <arg_key>/<arg_value> 重建参数",
        { keys: Object.keys(salvaged).join(",") }
      );
      return { ok: true, args: salvaged, salvaged: true };
    }
  }

  // ④ 双层 stringify 兼容（保留旧行为）
  const nested = tryParseObject(raw);
  if (!nested.ok && raw.length > 1) {
    const rec = safeParseToolArgs(raw);
    if (Object.keys(rec).length > 0) {
      return { ok: true, args: rec, salvaged: true };
    }
  }

  return {
    ok: false,
    args: {},
    error:
      "tool arguments 不是合法 JSON（上游模型输出可能已损坏）。请重新调用该工具，确保 arguments 是合法 JSON 对象。" +
      ` 原始片段：${raw.slice(0, 200)}`,
  };
}

/**
 * 递归清洗参数值里混入的上游文本工具调用标记（Task #4231）
 *
 * 只动字符串值，不改变结构；marker 被削掉后若变成空串则保留空串（不删 key，
 * 避免工具因缺字段报"缺参数"）。
 */
export function sanitizeArgValues(
  args: Record<string, unknown>
): Record<string, unknown> {
  const clean = (v: unknown): unknown => {
    if (typeof v === "string") return stripTextualToolArgsMarkers(v);
    if (Array.isArray(v)) return v.map(clean);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = clean(val);
      }
      return out;
    }
    return v;
  };
  return clean(args) as Record<string, unknown>;
}

/** 内部：parse 成对象（非对象/失败都算不 ok） */
function tryParseObject(raw: string): { ok: true; args: Record<string, unknown> } | { ok: false } {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { ok: true, args: parsed as Record<string, unknown> };
    }
    // 双层 stringify
    if (typeof parsed === "string") {
      const twice = JSON.parse(parsed);
      if (twice && typeof twice === "object" && !Array.isArray(twice)) {
        return { ok: true, args: twice as Record<string, unknown> };
      }
    }
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

/** Maximum safe recursion depth for parsing double-stringified JSON */
const MAX_SAFE_DEPTH = 5;

/**
 * Safely parse tool call arguments, handling double-stringified JSON.
 *
 * LLMs sometimes double-stringify JSON arguments (a JSON string containing
 * another JSON string). This function recursively attempts to parse until
 * a real object is obtained.
 *
 * @param args - The arguments value (string, object, or double-stringified string)
 * @param depth - Current recursion depth (internal use, default 0)
 * @returns Parsed object, or empty object if parsing fails entirely
 *
 * @example
 * // Normal object - returned as-is
 * safeParseToolArgs({ key: "value" }) // => { key: "value" }
 *
 * @example
 * // Normal JSON string - parsed
 * safeParseToolArgs('{"key": "value"}') // => { key: "value" }
 *
 * @example
 * // Double-stringified JSON - recursively parsed
 * safeParseToolArgs('"{\\"key\\": \\"value\\"}"') // => { key: "value" }
 *
 * @example
 * // Invalid JSON - returns empty object (no _raw leak)
 * safeParseToolArgs("{invalid}") // => {}
 */
export function safeParseToolArgs(
  args: unknown,
  depth: number = 0,
): Record<string, unknown> {
  // Guard: max recursion depth exceeded
  if (depth >= MAX_SAFE_DEPTH) {
    logger.warn(
      `[safeParseToolArgs] Max recursion depth (${MAX_SAFE_DEPTH}) exceeded at depth ${depth}. ` +
        "Input may be malicious or abnormally deeply nested. Returning empty object.",
      { depth, argsType: typeof args },
    );
    return {};
  }

  // If already an object (and not null, not an array), return directly
  // Arrays are excluded because tool arguments must be key-value objects
  if (typeof args === "object" && args !== null && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  
  // If it's an array, return empty object
  if (Array.isArray(args)) {
    logger.debug(
      `[safeParseToolArgs] Input is an array. Tool arguments should be objects. Returning empty object.`,
      { depth, arrayLength: args.length },
    );
    return {};
  }

  // If it's a string, try to JSON.parse it
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      // If parsed result is still a string (double stringify), recurse
      if (typeof parsed === "string") {
        logger.debug(
          `[safeParseToolArgs] Detected double/multi-stringified JSON at depth ${depth}. ` +
            "LLM may be double-stringifying tool arguments. Parsing recursively.",
          { depth, parsedLength: parsed.length },
        );
        return safeParseToolArgs(parsed, depth + 1);
      }
      // If parsed result is an object (but NOT an array), return it
      // Arrays are excluded because tool arguments must be key-value objects
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      
      // If parsed result is an array, return empty object
      // Tool arguments should always be objects, not arrays
      if (Array.isArray(parsed)) {
        logger.debug(
          `[safeParseToolArgs] Parsed result is an array at depth ${depth}. ` +
            "Tool arguments should be objects, not arrays. Returning empty object.",
          { depth, parsedLength: parsed.length },
        );
        return {};
      }
      // Parsed result is a primitive (number, boolean, etc.) - wrap it
      return { value: parsed };
    } catch (e) {
      // P1-5: Log parse failure with input length for traceability
      logger.warn(`[safeParseToolArgs] JSON.parse failed at depth ${depth}`, {
        parse_failed: true,
        input_length: args.length,
        depth,
        error: (e as Error).message,
      });
      // JSON parse failed, return empty object (no _raw leak)
      return {};
    }
  }

  // For any other type (number, boolean, undefined, etc.), return empty
  return {};
}
