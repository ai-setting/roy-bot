/**
 * @fileoverview Real LLM Integration Test for toolChoice + workflow_submit_output
 *
 * 真正调用 LLM API 验证：
 * 1. toolChoice 设置为 workflow_submit_output 时，LLM 能正确返回 tool call
 * 2. 返回的 tool call 参数符合 schema 定义
 * 3. 完整链路：invoke() → streamText() → LLM → tool call → 参数解析
 *
 * 运行方式：
 *   bun test packages/core/src/env/llm/invoke.real-integration.test.ts
 *
 * 注意：需要有效的 API Key（从 ~/.roy-bot/auth.json 读取）
 */

import { describe, test, expect, beforeAll } from "bun:test";

const isParallelRun = "BUN_TEST_WORKER_ID" in process.env;

import { invoke } from "./invoke";
import type { InvokeConfig, InvokeOptions } from "./invoke";
import type { ToolInfo } from "../../tool/types";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";

// ============================================================================
// 读取真实 API Key
// ============================================================================

interface AuthConfig {
  providers?: Record<string, { apiKey?: string; baseURL?: string }>;
}

interface ProviderInfo {
  apiKey: string;
  baseURL: string;
  provider: string;
  model: string;
}

function loadProviders(): ProviderInfo[] {
  const results: ProviderInfo[] = [];
  try {
    const authPath = path.join(process.env.HOME || "~", ".roy-bot", "auth.json");
    const raw = fs.readFileSync(authPath, "utf-8");
    const auth: AuthConfig = JSON.parse(raw);

    const ds = auth.providers?.deepseek;
    if (ds?.apiKey) {
      results.push({
        apiKey: ds.apiKey,
        baseURL: ds.baseURL || "https://api.deepseek.com",
        provider: "deepseek",
        model: "deepseek-v4-flash",
      });
    }

    const mm = auth.providers?.minimax;
    if (mm?.apiKey && mm.apiKey !== "sk-your-openai-api-key-here") {
      results.push({
        apiKey: mm.apiKey,
        baseURL: mm.baseURL || "https://api.minimax.chat/v1",
        provider: "minimax",
        model: "MiniMax-Text-01",
      });
    }

    const volc = auth.providers?.volcengine;
    if (volc?.apiKey && volc.baseURL) {
      results.push({
        apiKey: volc.apiKey,
        baseURL: volc.baseURL,
        provider: "volcengine",
        model: "deepseek-v4-flash",
      });
    }

    return results;
  } catch {
    return [];
  }
}

// ============================================================================
// 集成测试
// ============================================================================

const providers = loadProviders();

for (const p of providers) {
  describe.skipIf(isParallelRun)(`Real LLM [${p.provider}/${p.model}]: toolChoice for workflow_submit_output`, () => {
    const config: InvokeConfig = {
      model: `openai-compatible/${p.model}`,
      apiKey: p.apiKey,
      baseURL: p.baseURL,
    };

    console.log(`\n🔍 Testing provider: ${p.provider}, model: ${p.model}, baseURL: ${p.baseURL}`);

    test("LLM should call workflow_submit_output when toolChoice is forced", async () => {
      const tool: ToolInfo = {
        name: "workflow_submit_output",
        description:
          "Submit the final structured JSON result. " +
          "You MUST call this tool once with your final answer.",
        parameters: z.object({
          passed: z.boolean().describe("true if verification passed"),
          feedback: z.string().optional().describe("detailed feedback"),
        }),
        async execute(args) {
          return { success: true, output: `__WORKFLOW_JSON_OUTPUT__:${JSON.stringify(args)}` };
        },
        metadata: { category: "workflow", tags: ["structured-output"], version: "1.0.0" },
      };

      const options: InvokeOptions = {
        messages: [
          {
            role: "system",
            content:
              "You are a verification agent. Your ONLY job is to call workflow_submit_output with your verdict. " +
              "You must call the tool — do NOT reply with plain text.",
          },
          {
            role: "user",
            content: "Verify this task: check if the server is responding on port 8080.",
          },
        ],
        tools: [tool],
        toolChoice: { type: "function", function: { name: "workflow_submit_output" } },
        temperature: 0.1,
        maxTokens: 500,
      };

      const result = await invoke(config, options, { abort: undefined });

      const parsed = JSON.parse(result.result);
      console.log(`[${p.provider}] Test 1 response:`, JSON.stringify(parsed, null, 2));

      expect(parsed.tool_calls).toBeDefined();
      expect(parsed.tool_calls.length).toBeGreaterThan(0);

      const toolCall = parsed.tool_calls[0];
      expect(toolCall.function.name).toBe("workflow_submit_output");

      const args = JSON.parse(toolCall.function.arguments);
      console.log(`[${p.provider}] Test 1 args:`, JSON.stringify(args, null, 2));
      expect(args).toHaveProperty("passed");
      expect(typeof args.passed).toBe("boolean");
    });

    test("LLM should respect complex schema with array and object fields", async () => {
      const tool: ToolInfo = {
        name: "workflow_submit_output",
        description:
          "Submit the final structured JSON result. " +
          "You MUST call this tool with your complete analysis.",
        parameters: z.object({
          summary: z.string().describe("Overall summary"),
          passed: z.boolean().describe("Whether all checks passed"),
          issues: z
            .array(
              z.object({
                severity: z.enum(["low", "medium", "high"]),
                description: z.string(),
              })
            )
            .describe("List of issues found"),
          metadata: z
            .object({
              duration_ms: z.number().optional(),
              checked_by: z.string().optional(),
            })
            .optional(),
        }),
        async execute(args) {
          return { success: true, output: `__WORKFLOW_JSON_OUTPUT__:${JSON.stringify(args)}` };
        },
        metadata: { category: "workflow", tags: ["structured-output"], version: "1.0.0" },
      };

      const options: InvokeOptions = {
        messages: [
          {
            role: "system",
            content:
              "You are a code review agent. Analyze the code and call workflow_submit_output with your findings. " +
              "Include issues array with severity and description for each problem found.",
          },
          {
            role: "user",
            content:
              "Review this code:\n```\nfunction add(a,b) {\n  return a + b;\n}\n```\n" +
              "Check for: potential bugs, style issues, security concerns.",
          },
        ],
        tools: [tool],
        toolChoice: { type: "function", function: { name: "workflow_submit_output" } },
        temperature: 0.1,
        maxTokens: 1000,
      };

      const result = await invoke(config, options, { abort: undefined });

      const parsed = JSON.parse(result.result);
      console.log(`[${p.provider}] Test 2 response:`, JSON.stringify(parsed, null, 2));

      expect(parsed.tool_calls).toBeDefined();
      expect(parsed.tool_calls.length).toBeGreaterThan(0);

      const toolCall = parsed.tool_calls[0];
      expect(toolCall.function.name).toBe("workflow_submit_output");

      const args = JSON.parse(toolCall.function.arguments);
      console.log(`[${p.provider}] Test 2 args:`, JSON.stringify(args, null, 2));

      expect(args).toHaveProperty("summary");
      expect(typeof args.summary).toBe("string");
      expect(args).toHaveProperty("passed");
      expect(typeof args.passed).toBe("boolean");
      expect(args).toHaveProperty("issues");
      expect(Array.isArray(args.issues)).toBe(true);
    });
  });
}

// ============================================================================
// 专项测试：DeepSeek v4 + thinking disabled + toolChoice
// 使用 AI SDK 直接调用，验证 thinking disabled 后 toolChoice 正常工作
// ============================================================================

describe.skipIf(isParallelRun)("DeepSeek v4: thinking disabled + toolChoice", () => {
  let auth: { apiKey: string; baseURL: string } | null = null;

  beforeAll(() => {
    try {
      const authPath = path.join(process.env.HOME || "~", ".roy-bot", "auth.json");
      const raw = fs.readFileSync(authPath, "utf-8");
      const parsed: AuthConfig = JSON.parse(raw);

      const volc = parsed.providers?.volcengine;
      if (volc?.apiKey && volc.baseURL) {
        auth = { apiKey: volc.apiKey, baseURL: volc.baseURL };
        console.log(`\n🔍 DeepSeek v4 thinking disabled test via volcengine: ${volc.baseURL}`);
        return;
      }

      const ds = parsed.providers?.deepseek;
      if (ds?.apiKey) {
        auth = { apiKey: ds.apiKey, baseURL: ds.baseURL || "https://api.deepseek.com" };
        console.log(`\n🔍 DeepSeek v4 thinking disabled test via deepseek: ${ds.baseURL}`);
      }
    } catch {}
  });

  test("DeepSeek v4 flash with thinking disabled should call workflow_submit_output", async () => {
    if (!auth) return;

    const { streamText } = await import("ai");
    const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");

    const provider = createOpenAICompatible({
      name: "deepseek-test",
      apiKey: auth.apiKey,
      baseURL: auth.baseURL,
    });

    const tool = {
      workflow_submit_output: {
        description:
          "Submit the final structured JSON result. " +
          "You MUST call this tool once with your final answer.",
        parameters: z.object({
          passed: z.boolean().describe("true if verification passed"),
          feedback: z.string().optional().describe("detailed feedback"),
        }),
      },
    };

    const result = await streamText({
      model: provider.languageModel("deepseek-v4-flash"),
      messages: [
        {
          role: "system",
          content:
            "You are a verification agent. Your ONLY job is to call workflow_submit_output with your verdict. " +
            "You must call the tool — do NOT reply with plain text.",
        },
        {
          role: "user",
          content: "Verify this task: check if the server is responding on port 8080.",
        },
      ],
      tools: tool,
      toolChoice: { type: "tool", toolName: "workflow_submit_output" },
      temperature: 0.1,
      maxTokens: 500,
      // ⭐ 关键：禁用 thinking mode，使 toolChoice 生效
      providerOptions: {
        deepseek: {
          thinking: { type: "disabled" },
        },
      },
    });

    // 收集完整的 tool calls
    let finishReason = "";
    const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

    for await (const part of result.fullStream) {
      if (part.type === "tool-call") {
        toolCalls.push({
          name: part.toolName,
          args: part.args as Record<string, unknown>,
        });
      }
      if (part.type === "finish") {
        finishReason = part.finishReason;
      }
    }

    console.log(`[deepseek-thinking-disabled] finishReason: ${finishReason}`);
    console.log(`[deepseek-thinking-disabled] toolCalls:`, JSON.stringify(toolCalls, null, 2));

    // 验证
    expect(finishReason).toBe("tool-calls");
    expect(toolCalls.length).toBeGreaterThan(0);
    expect(toolCalls[0].name).toBe("workflow_submit_output");

    const args = toolCalls[0].args;
    console.log(`[deepseek-thinking-disabled] args:`, JSON.stringify(args, null, 2));
    expect(args).toHaveProperty("passed");
    expect(typeof args.passed).toBe("boolean");
  });
});
