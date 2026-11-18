/**
 * REAL LLM test: exercises the EXACT workflow plugin pipeline.
 *
 *   runWorkflowJsonOutputExtraction(hookCtx)
 *     → extractLastAssistantText(messages)    ← takes raw assistant text
 *     → build user query with the text        ← no pre-parsing
 *     → agentComponent.run("json-extract", ...) ← sub-agent LLM reads text
 *     → LLM calls workflow_submit_output        ← tool writes structuredOutput
 *
 * Verifies: hookCtx.structuredOutputExtracted contains the correct JSON.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { LLMComponent } from "../llm/llm";
import { AgentComponent } from "./agent-component";
import { ConfigComponent } from "../../config/config-component";
import { SessionComponent } from "../session/session-component";
import { ToolComponent } from "../tool/tool-component";
import { PromptComponent } from "../prompt/prompt-component";
import {
  runWorkflowJsonOutputExtraction,
  __setPluginAgentComponentForTest,
} from "../workflow/plugins/workflow-json-output-plugin";

import { readFileSync } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";

// ---- helpers ----
function loadAuth() {
  try {
    const raw = readFileSync(resolve(process.env.HOME!, ".roy-bot/auth.json"), "utf-8");
    return (JSON.parse(raw) as any)?.providers ?? {};
  } catch { return {}; }
}

let agentComponent: AgentComponent;
let cleanup: () => void;

beforeAll(async () => {
  const auth = loadAuth();
  const providerKey = auth.deepseek ? "deepseek" : Object.keys(auth)[0];
  const creds = auth[providerKey];
  if (!creds?.apiKey) throw new Error("No auth in ~/.roy-bot/auth.json");

  const dir = `${tmpdir()}/je-real-test-${Date.now()}`;
  require("fs").mkdirSync(dir, { recursive: true });

  const config = new ConfigComponent();
  config.setXdgDataHome(dir);
  await config.set("llm.defaultProvider", providerKey);
  await config.set("llm.defaultModel", providerKey === "deepseek" ? "deepseek-chat" : "MiniMax-M3");
  await config.set("llm.temperature", 0.1);
  await config.set("llm.maxTokens", 500);
  await config.set("llm.stream", false);
  await config.set("llm.providers", {
    [providerKey]: {
      provider: "openai-compatible", name: providerKey,
      apiKey: creds.apiKey, baseURL: creds.baseURL,
      models: [providerKey === "deepseek" ? "deepseek-chat" : "MiniMax-M3"],
      defaultModel: providerKey === "deepseek" ? "deepseek-chat" : "MiniMax-M3",
    },
  });

  const llm = new LLMComponent();
  await llm.init({ env: { name: "t", version: "1" } as any, options: { configComponent: config } });
  const session = new SessionComponent();
  await session.init({ env: { name: "t", version: "1" } as any, options: { configComponent: config } });
  const tool = new ToolComponent();
  await tool.init({ env: { name: "t", version: "1" } as any, options: { configComponent: config } });
  const prompt = new PromptComponent();
  await prompt.init({ env: { name: "t", version: "1" } as any, options: { configComponent: config } });

  const env = {
    name: "t", version: "1",
    getComponent: (n: string) => ({ llm, session, tool, prompt, config } as any)[n],
    hasComponent: (n: string) => ["llm","session","tool","prompt","config"].includes(n),
    getConfig: () => ({ name: "t", version: "1", enabled: true }),
    registerComponent: () => {}, unregisterComponent: () => {},
    listComponents: () => ["llm","session","tool","prompt","config"],
    handle_query: () => {}, handle_action: () => {},
    subscribe: () => () => {}, subscribeTo: () => () => {},
    subscribeAll: () => () => {}, pushEnvEvent: () => {},
  };

  agentComponent = new AgentComponent();
  await agentComponent.init({ env: env as any, options: { configComponent: config } });
  cleanup = () => require("fs").rmSync(dir, { recursive: true });
});

afterAll(() => cleanup?.());

// ============================================================================

describe("json-extract via REAL plugin pipeline", () => {
  test("should populate structuredOutputExtracted from raw assistant text (real LLM)", async () => {
    // Register agentComponent so plugin can use it
    __setPluginAgentComponentForTest(agentComponent as any);

    // Simulated main agent output — markdown code block with JSON
    // (the previously-failing pattern where pre-parsing was needed)
    const assistantText = [
      '<think>The user wants JSON analysis of "Hello, world!"</think>',
      '',
      '```json',
      '{',
      '  "char_count": 13,',
      '  "summary": "A simple greeting to the world."',
      '}',
      '```',
      '',
      'Analysis complete.',
    ].join('\n');

    const hookCtx: any = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: assistantText }] },
      ],
      context: {
        sessionId: `plugin-real-${Date.now()}`,
        metadata: {
          outputSchema: {
            type: "object",
            properties: {
              char_count: { type: "integer" },
              summary: { type: "string" },
            },
            required: ["char_count", "summary"],
          },
        },
        pluginEnabled: { "workflow:json-output": true },
        abort: new AbortController().signal,
      },
      structuredOutputExtracted: undefined,
      error: undefined,
      iteration: 1, maxIterations: 1,
      tools: [], systemPrompt: "",
      agent: { name: "test", config: {}, status: "running", plugins: {} },
    };

    // ── Execute the REAL plugin pipeline ──
    await runWorkflowJsonOutputExtraction(hookCtx);

    // ── Verify: hookCtx.structuredOutputExtracted was populated ──
    const json = hookCtx.structuredOutputExtracted as Record<string, unknown>;
    console.log("structuredOutputExtracted:", JSON.stringify(json, null, 2));

    expect(json).toBeDefined();
    expect(typeof json).toBe("object");
    expect(Array.isArray(json)).toBe(false);
    expect(json.char_count).toBe(13);
    expect(typeof json.summary).toBe("string");
    expect(json.summary.length).toBeGreaterThan(3);
    expect(Object.keys(json).sort()).toEqual(["char_count", "summary"]);

    __setPluginAgentComponentForTest(null);
  }, 60000);

  test("should handle plain JSON (not code block)", async () => {
    __setPluginAgentComponentForTest(agentComponent as any);

    const assistantText = '{"char_count": 7, "summary": "testing"}';

    const hookCtx: any = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: assistantText }] },
      ],
      context: {
        sessionId: `plugin-real-${Date.now()}`,
        metadata: {
          outputSchema: {
            type: "object",
            properties: {
              char_count: { type: "integer" },
              summary: { type: "string" },
            },
            required: ["char_count", "summary"],
          },
        },
        pluginEnabled: { "workflow:json-output": true },
        abort: new AbortController().signal,
      },
      structuredOutputExtracted: undefined,
      error: undefined,
      iteration: 1, maxIterations: 1,
      tools: [], systemPrompt: "",
      agent: { name: "test", config: {}, status: "running", plugins: {} },
    };

    await runWorkflowJsonOutputExtraction(hookCtx);

    const json = hookCtx.structuredOutputExtracted as Record<string, unknown>;
    console.log("plain JSON result:", JSON.stringify(json));

    expect(json).toBeDefined();
    expect(json.char_count).toBe(7);
    expect(json.summary).toBe("testing");

    __setPluginAgentComponentForTest(null);
  }, 60000);
});
