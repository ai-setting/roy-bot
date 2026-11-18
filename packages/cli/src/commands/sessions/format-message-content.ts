/**
 * @fileoverview Format message content for messages command
 *
 * 纯函数：从 SessionMessage 输出可读的 string[] 列表
 * - 当 detail=false 时，对长内容进行截断（向后兼容）
 * - 当 detail=true 时，跳过截断，输出完整内容
 *
 * 设计选择：
 * - 函数输出**纯字符串**（不带 chalk 颜色）。颜色染色由 messages.ts 层负责。
 *   这让函数更易测试（测试不需要 chalk 副作用）。
 * - messages.ts 在使用本函数时，调用方负责把每个 line 加上 `│ ` 前缀和 chalk 颜色。
 */

import type { SessionMessage } from "@ai-setting/roy-bot-core";

export interface FormatMessageContentOptions {
  /** 跳过截断，输出完整内容 */
  detail?: boolean;
}

/**
 * Truncation limits
 */
const TEXT_MAX_CHARS = 300;
const TOOL_ARGS_MAX_CHARS = 200;
const TOOL_RESULT_MAX_CHARS = 200;
const LEGACY_CONTENT_MAX_CHARS = 200;
const REASONING_MAX_LINES = 5;
const CHECKPOINT_MAX_LINES = 10;
const INPUT_VALUE_MAX_CHARS = 50;
const WORKFLOW_RESULT_MAX_CHARS = 200;
const WORKFLOW_RESULT_MAX_LINES = 5;
const WORKFLOW_END_MAX_CHARS = 300;
const WORKFLOW_END_MAX_LINES = 6;
const ELLIPSIS = "...";

/**
 * 截断字符串（如果超过 max 字符，添加省略号）
 */
function truncateChars(s: string, max: number): string {
  if (s.length > max) {
    return s.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
  }
  return s;
}

/**
 * 格式化 checkpoint 消息的样式
 */
export function formatCheckpointContent(
  content: string,
  opts: FormatMessageContentOptions = {}
): string {
  const detail = opts.detail ?? false;
  const lines = content.split("\n");
  if (detail) {
    return lines.join("\n");
  }
  return (
    lines.slice(0, CHECKPOINT_MAX_LINES).join("\n") +
    (lines.length > CHECKPOINT_MAX_LINES ? "\n" + ELLIPSIS : "")
  );
}

/**
 * 格式化消息内容
 *
 * - opts.detail = true: 不截断
 * - opts.detail = false (默认): 按各种限制截断
 */
export function formatMessageContent(
  m: SessionMessage,
  opts: FormatMessageContentOptions = {}
): string[] {
  const detail = opts.detail ?? false;
  const lines: string[] = [];

  // 处理 parts（结构化内容）
  if (m.parts && m.parts.length > 0) {
    for (const part of m.parts as any[]) {
      if (part.type === "text") {
        const raw = part.content || "";
        const text = detail ? raw : truncateChars(raw, TEXT_MAX_CHARS);
        lines.push(...text.split("\n").map((l: string) => l || " "));
      } else if (part.type === "tool-call") {
        lines.push(`[Tool Call] ${part.toolName}`);
        const argsStr =
          typeof part.arguments === "string"
            ? part.arguments
            : JSON.stringify(part.arguments ?? null, null, 2);
        if (argsStr) {
          const final = detail ? argsStr : truncateChars(argsStr, TOOL_ARGS_MAX_CHARS);
          lines.push(...final.split("\n"));
        }
      } else if (part.type === "tool-result") {
        lines.push(`[Tool Result] ${part.toolName}`);
        const raw = part.output || "No output";
        const output = detail ? raw : truncateChars(raw, TOOL_RESULT_MAX_CHARS);
        lines.push(...output.split("\n"));
      } else if (part.type === "reasoning") {
        lines.push(`[Reasoning]`);
        const content = part.content || "";
        if (detail) {
          lines.push(...content.split("\n"));
        } else {
          lines.push(...content.split("\n").slice(0, REASONING_MAX_LINES));
        }
      } else if (part.type === "checkpoint") {
        lines.push(`[Checkpoint]`);
      }
      // ==================== Workflow Node Types ====================
      else if (part.type === "workflow-node-call") {
        lines.push(`[Node Call] ${part.nodeType}: ${part.nodeId}`);
        if (part.input && Object.keys(part.input).length > 0) {
          const entries = Object.entries(part.input).slice(0, 3);
          const inputSummary = entries
            .map(([k, v]) => {
              const vStr = JSON.stringify(v);
              const final = detail ? vStr : vStr.slice(0, INPUT_VALUE_MAX_CHARS);
              return `${k}: ${final}`;
            })
            .join(", ");
          lines.push(...inputSummary.split("\n").map((l: string) => `  ${l}`));
        }
        if (part.agentSessionId) {
          lines.push(`  agentSessionId: ${part.agentSessionId}`);
        }
      } else if (part.type === "workflow-node-interrupt") {
        lines.push(`[Node Interrupt] ${part.nodeType}: ${part.nodeId}`);
        lines.push(`  Query: ${part.query}`);
        if (part.options && part.options.length > 0) {
          lines.push(`  Options: ${part.options.join(", ")}`);
        }
        if (part.agentSessionId) {
          lines.push(`  agentSessionId: ${part.agentSessionId}`);
        }
      } else if (part.type === "workflow-node-result") {
        const status = part.error ? "❌" : "✅";
        lines.push(`${status} [Node Result] ${part.nodeType}: ${part.nodeId}`);
        if (part.output) {
          let outputStr =
            typeof part.output === "string"
              ? part.output
              : JSON.stringify(part.output);
          if (!detail) {
            outputStr = outputStr.slice(0, WORKFLOW_RESULT_MAX_CHARS);
          }
          const outputLines = outputStr.split("\n");
          const slicedLines = detail
            ? outputLines
            : outputLines.slice(0, WORKFLOW_RESULT_MAX_LINES);
          lines.push(...slicedLines.map((l: string) => `  ${l}`));
        }
        if (part.error) {
          lines.push(`  Error: ${part.error}`);
        }
        if (part.durationMs !== undefined) {
          lines.push(`  Duration: ${part.durationMs}ms`);
        }
      } else if (part.type === "workflow-node-resume") {
        lines.push(`[Node Resume] Response: ${part.response}`);
      } else if (part.type === "workflow-node-start") {
        lines.push(`[Node Start] ${part.nodeId}`);
      } else if (part.type === "workflow-node-end") {
        const status = part.error ? "❌" : "✅";
        lines.push(`${status} [Node End] ${part.nodeId}`);
        if (part.output) {
          let outputStr =
            typeof part.output === "string"
              ? part.output
              : JSON.stringify(part.output, null, 2);
          if (!detail) {
            outputStr = outputStr.slice(0, WORKFLOW_END_MAX_CHARS);
          }
          const outputLines = outputStr.split("\n");
          const slicedLines = detail
            ? outputLines
            : outputLines.slice(0, WORKFLOW_END_MAX_LINES);
          lines.push(...slicedLines.map((l: string) => `  ${l}`));
        }
        if (part.error) {
          lines.push(`  Error: ${part.error}`);
        }
        if (part.durationMs !== undefined) {
          lines.push(`  Duration: ${part.durationMs}ms`);
        }
      }
    }
  } else if (m.content) {
    // 纯文本内容（兼容旧格式）
    const content = detail
      ? m.content
      : truncateChars(m.content, LEGACY_CONTENT_MAX_CHARS);
    lines.push(...content.split("\n").map(l => l || " "));
  }

  return lines.length > 0 ? lines : ["(empty)"];
}
