/**
 * @fileoverview Loose JSON extraction helpers
 *
 * LLM 经常把「本该结构化」的结果当纯文本吐出来，格式五花八门：
 *   1. 纯 JSON
 *   2. Markdown ```json ... ``` 代码块
 *   3. 夹在解释文字中的第一个 `{...}`
 *
 * 这些 helper 从任意文本里尽力抠出 JSON 对象，返回 null 表示没找到。
 *
 * 原实现内联在 `env/workflow/plugins/workflow-json-output-plugin.ts`，
 * 2026-10-16 抽到 utils 以便 session 压缩的 checkpoint 降级路径复用
 * （避免 session → workflow/plugins 的反向耦合）。
 */

/**
 * Helper: try to parse a string as a JSON object.
 * Returns the parsed object (excluding arrays/primitives), or null.
 */
export function tryParseJsonString(s: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(s);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Extract a JSON object from arbitrary LLM text.
 *
 * Tries (in order):
 *   1. Whole text is JSON
 *   2. Markdown ```json ... ``` code block
 *   3. First {...} substring
 *
 * Returns null if no valid JSON object is found.
 */
export function tryParseJsonFromText(text: string): Record<string, unknown> | null {
  if (!text || typeof text !== "string") return null;

  // 1. Direct parse
  const direct = tryParseJsonString(text.trim());
  if (direct) return direct;

  // 2. Markdown code block ```json ... ```
  const codeBlock = text.match(/```(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlock) {
    const parsed = tryParseJsonString(codeBlock[1].trim());
    if (parsed) return parsed;
  }

  // 3. First { ... } substring (greedy across lines)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    const parsed = tryParseJsonString(jsonMatch[0]);
    if (parsed) return parsed;
  }

  return null;
}
