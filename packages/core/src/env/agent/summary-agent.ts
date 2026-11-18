/**
 * @fileoverview Summary Agent
 * 
 * 两阶段 session 压缩中的 Phase 1：生成场景化压缩提示 (Compact Hint)
 * 
 * Phase 1: 分析会话历史 → 生成指导 Phase 2 的场景化提示
 * Phase 2: 由内置 compact agent 处理（SessionComponent.compact 中调用 AgentComponent.run）
 */

import type { 
  SummaryAgentConfig, 
} from "./types";
import type { LLMComponent } from "../llm/llm";

/**
 * Summary Agent
 * 
 * @deprecated Phase 1 compact hint generation has been migrated to
 * SessionComponent.generateCompactHint() using AgentComponent.run("compact-hint", ...).
 * 
 * This class is retained for backward compatibility with existing tests
 * (see invoke-threshold-check.test.ts). It no longer contains any active logic.
 *
 * Note: its former `parseCompactJsonResponse()` helper and the
 * `SummaryAgentResult` type were removed in Task #4933 — they encoded the
 * five-field JSON checkpoint extraction that was explicitly rejected; the
 * checkpoint is now a single natural-language `content` string.
 */
export class SummaryAgent {
  private llmComponent: LLMComponent;
  private config: SummaryAgentConfig;

  constructor(
    _promptComponent: unknown,
    llmComponent: LLMComponent,
    config?: Partial<SummaryAgentConfig>
  ) {
    this.llmComponent = llmComponent;
    
    this.config = {
      type: "summary",
      promptName: "session/compact",
      maxIterations: 1,
      model: undefined,
      ...config,
    } as SummaryAgentConfig;
  }
}

// ============================================================================
// 导出用于测试的纯函数
// ============================================================================

/**
 * 解析 Compact Hint 响应
 * 
 * 纯函数，可独立测试
 */
export function parseCompactHintResponse(content: string): string {
  // 1. 尝试提取 JSON 并解析 guidance_prompt
  const jsonResult = extractGuidanceFromJson(content);
  if (jsonResult !== null) {
    const trimmed = jsonResult.trim();
    if (!trimmed) {
      return "[Hint extraction failed]";
    }
    if (trimmed.length > 500) {
      return trimmed.substring(0, 500) + "...";
    }
    return trimmed;
  }
  
  // 2. 降级处理：提取纯文本
  let text = content
    .replace(/```json\s*([\s\S]*?)\s*```/g, "$1")
    .replace(/```markdown\s*([\s\S]*?)\s*```/g, "$1")
    .replace(/```\s*([\s\S]*?)\s*```/g, "$1")
    .trim();
  
  if (!text) {
    return "[Hint extraction failed]";
  }
  
  if (text.length > 500) {
    return text.substring(0, 500) + "...";
  }
  
  return text;
}

/**
 * 从 LLM 输出中提取 JSON 并解析 guidance_prompt
 */
function extractGuidanceFromJson(content: string): string | null {
  const jsonBlockMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
  if (jsonBlockMatch) {
    const parsed = tryParseJson(jsonBlockMatch[1]);
    const guidancePrompt = parsed?.guidance_prompt;
    if (typeof guidancePrompt === "string") {
      return guidancePrompt.length === 0 ? "" : guidancePrompt;
    }
  }

  const jsonObjectMatch = content.match(/\{[\s\S]*"guidance_prompt"[\s\S]*\}/);
  if (jsonObjectMatch) {
    const parsed = tryParseJson(jsonObjectMatch[0]);
    const guidancePrompt = parsed?.guidance_prompt;
    if (typeof guidancePrompt === "string") {
      return guidancePrompt.length === 0 ? "" : guidancePrompt;
    }
  }

  return null;
}

/**
 * 安全解析 JSON
 */
function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text.trim());
  } catch {
    const fixed = text
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]")
      .replace(/'/g, '"')
      .trim();
    try {
      return JSON.parse(fixed);
    } catch {
      return null;
    }
  }
}
