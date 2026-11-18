/**
 * @fileoverview REAL LLM integration test for json-extract sub-agent.
 *
 * Tests that when the json-extract sub-agent receives:
 *   1. A single user message containing pre-extracted JSON
 *   2. Only workflow_submit_output as a tool
 *   3. toolChoice = "required"
 *
 * …the LLM actually calls workflow_submit_output with the correct JSON.
 *
 * This is the gold-standard verification that the v3 clean-extraction
 * architecture works end-to-end with a real LLM provider.
 *
 * Run:
 *   bun test packages/core/src/env/agent/json-extract-agent.real-integration.test.ts
 */

import { describe, test, expect } from "bun:test";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;
import { invoke } from "../llm/invoke";
import type { InvokeConfig, InvokeOptions } from "../llm/invoke";
import { z } from "zod";
import { jsonSchemaToZod } from "../workflow/utils/json-schema-to-zod";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// Load API keys from auth.json (same pattern as invoke.real-integration.test.ts)
// ============================================================================

interface AuthConfig {
  providers?: Record<string, { apiKey?: string; baseURL?: string }>;
}
interface ProviderInfo {
  apiKey: string; baseURL: string; provider: string; model: string;
}

function loadProviders(): ProviderInfo[] {
  const results: ProviderInfo[] = [];
  try {
    const authPath = path.join(process.env.HOME || "~", ".roy-bot", "auth.json");
    if (!fs.existsSync(authPath)) return results;
    const auth: AuthConfig = JSON.parse(fs.readFileSync(authPath, "utf-8"));

    // MiniMax M3 (our primary model)
    const mm = auth.providers?.minimax;
    if (mm?.apiKey) {
      results.push({
        apiKey: mm.apiKey,
        baseURL: mm.baseURL || "https://api.minimax.chat/v1",
        provider: "minimax",
        model: "MiniMax-M3",
      });
    }

    // DeepSeek as fallback
    const ds = auth.providers?.deepseek;
    if (ds?.apiKey) {
      results.push({
        apiKey: ds.apiKey,
        baseURL: ds.baseURL || "https://api.deepseek.com",
        provider: "deepseek",
        model: "deepseek-chat",
      });
    }
  } catch { /* ignore */ }
  return results;
}

// ============================================================================
// Dynamically build zod schema (mirrors what workflow does)
// ============================================================================

const SIMPLE_JSON_SCHEMA = {
  type: "object" as const,
  properties: {
    char_count: { type: "integer" as const },
    summary: { type: "string" as const },
  },
  required: ["char_count", "summary"],
};

// ============================================================================
// Build the exact same user query that the plugin constructs
// ============================================================================
function buildUserQuery(json: Record<string, unknown>): string {
  return [
    "Submit the following JSON via the workflow_submit_output tool.",
    "",
    "JSON to submit:",
    "```json",
    JSON.stringify(json, null, 2),
    "```",
    "",
    "Call workflow_submit_output with the JSON object above as your argument.",
    "Do not output any text — just call the tool.",
  ].join("\n");
}

// ============================================================================
// TESTS
// ============================================================================

loadProviders().forEach((p) => {
  describe.skipIf(isParallelRun)(`Real LLM [${p.provider}/${p.model}]: json-extract sub-agent pattern`, () => {
    const config: InvokeConfig = {
      model: `openai-compatible/${p.model}`,
      apiKey: p.apiKey,
      baseURL: p.baseURL,
    };

    // ── Test 1: happy path — pre-extracted JSON → workflow_submit_output ──
    test("1. should call workflow_submit_output with correct JSON when given pre-extracted data + toolChoice=required", async () => {
      const schema = jsonSchemaToZod(SIMPLE_JSON_SCHEMA);

      const options: InvokeOptions = {
        messages: [
          {
            role: "system",
            content:
              "# JSON Extract Agent\n\n" +
              "你是一个 JSON 提取子智能体。唯一职责：通过 workflow_submit_output 工具提交结构化 JSON。\n\n" +
              "你只有一个工具：workflow_submit_output。\n\n" +
              "必须调用该工具 — 不要输出任何文本。",
          },
          {
            role: "user",
            content: buildUserQuery({ char_count: 13, summary: "A simple greeting to the world." }),
          },
        ],
        tools: [
          {
            name: "workflow_submit_output",
            description:
              "Submit the final structured JSON result. " +
              "You MUST call this tool once with your final answer.",
            parameters: schema,
            execute: async (args) => {
              return { success: true, output: `__WORKFLOW_JSON_OUTPUT__:${JSON.stringify(args)}` };
            },
          },
        ],
        toolChoice: "required",
        temperature: 0.1,
        maxTokens: 500,
      };

      const result = await invoke(config, options, { abort: undefined });

      const parsed = JSON.parse(result.result);
      console.log(`[${p.provider}] Test 1 response:`, JSON.stringify(parsed, null, 2));

      // Must have tool calls
      expect(parsed.tool_calls).toBeDefined();
      expect(parsed.tool_calls.length).toBe(1);

      const toolCall = parsed.tool_calls[0];
      expect(toolCall.function?.name || toolCall.name).toBe("workflow_submit_output");

      // Parse arguments
      const args = JSON.parse(toolCall.function?.arguments || toolCall.arguments || "{}");
      expect(args.char_count).toBe(13);
      expect(args.summary).toBeDefined();
      expect(typeof args.summary).toBe("string");
      expect(args.summary.length).toBeGreaterThan(3);
    });

    // ── Test 2: complex schema (code-review style: multiple fields) ──
    test("2. should call workflow_submit_output with complex schema (passed, feedback, check_items, task_id)", async () => {
      const complexSchema = jsonSchemaToZod({
        type: "object",
        properties: {
          passed: { type: "boolean" },
          feedback: { type: "string" },
          check_items: { type: "string" },
          task_id: { type: "integer" },
        },
        required: ["passed", "check_items"],
      });

      const options: InvokeOptions = {
        messages: [
          {
            role: "system",
            content:
              "# JSON Extract Agent\n\n" +
              "唯一职责：通过 workflow_submit_output 工具提交结构化 JSON。\n\n" +
              "必须调用工具 — 不要输出任何文本。",
          },
          {
            role: "user",
            content: buildUserQuery({
              passed: true,
              feedback: "All goals met. Tests pass, build succeeds.",
              check_items: "goals-verified, evidence-collected, build-tests-pass",
              task_id: 1703,
            }),
          },
        ],
        tools: [
          {
            name: "workflow_submit_output",
            description: "Submit the final structured JSON result.",
            parameters: complexSchema,
            execute: async (args) => {
              return { success: true, output: `__WORKFLOW_JSON_OUTPUT__:${JSON.stringify(args)}` };
            },
          },
        ],
        toolChoice: "required",
        temperature: 0.1,
        maxTokens: 500,
      };

      const result = await invoke(config, options, { abort: undefined });
      const parsed = JSON.parse(result.result);
      console.log(`[${p.provider}] Test 2 response:`, JSON.stringify(parsed, null, 2));

      expect(parsed.tool_calls).toBeDefined();
      expect(parsed.tool_calls.length).toBe(1);

      const toolCall = parsed.tool_calls[0];
      expect(toolCall.function?.name || toolCall.name).toBe("workflow_submit_output");

      const args = JSON.parse(toolCall.function?.arguments || toolCall.arguments || "{}");
      expect(args.passed).toBe(true);
      expect(args.task_id).toBe(1703);
      expect(args.check_items).toBeDefined();
      expect(args.feedback).toBeDefined();
    });

    // ── Test 3: toolChoice=required prevents finishing without tool call ──
    test("3. toolChoice=required should prevent finishReason=stop (no text-only response)", async () => {
      // Larger timeout — MiniMax M3 reasoning models can take >5s for first token
      const schema = jsonSchemaToZod(SIMPLE_JSON_SCHEMA);

      const options: InvokeOptions = {
        messages: [
          {
            role: "system",
            content: "你只有一个工具：workflow_submit_output。必须调用它，不要输出文本。",
          },
          {
            role: "user",
            content: buildUserQuery({ char_count: 2, summary: "Hi" }),
          },
        ],
        tools: [
          {
            name: "workflow_submit_output",
            description: "Submit structured JSON. You MUST call this tool.",
            parameters: schema,
            execute: async (args) => ({ success: true, output: JSON.stringify(args) }),
          },
        ],
        toolChoice: "required",
        temperature: 0.1,
        maxTokens: 500,
      };

      const result = await invoke(config, options, { abort: undefined });
      const parsed = JSON.parse(result.result);

      const finishReason = parsed.finish_reason || parsed.finishReason || parsed.choices?.[0]?.finish_reason;
      console.log(`[${p.provider}] Test 3 finishReason:`, finishReason, JSON.stringify(parsed, null, 2));

      // Should be "tool_calls" or "tool-calls" or "function_call" — NOT "stop"
      const hasToolCalls = parsed.tool_calls?.length > 0 || parsed.tool_calls?.length > 0;
      expect(hasToolCalls).toBe(true);
    });
  });
});
