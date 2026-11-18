/**
 * Task #2175 — Provider compatibility RED tests for json-extract toolChoice.
 *
 * Background: user noted that "other providers like deepseek are incompatible
 * with toolChoice configuration when thinking mode is enabled." After commit
 * 2c428554 restored `toolChoice: "required"` unconditionally for the json-extract
 * sub-agent, providers with thinking/reasoning modes may silently drop the
 * requirement. This test pins the provider-compat matrix:
 *
 *   - openai          + reasoning=true → "required"  (first-party, supports toolChoice=required)
 *   - anthropic       + reasoning=true → "required"  (first-party)
 *   - google          + reasoning=true → "required"  (first-party)
 *   - deepseek        + reasoning=true → "auto"      (reasoning mode)
 *   - volcengine      + reasoning=true → "auto"      (OpenAI-compatible, thinking mode)
 *   - <unknown>       + no capabilities → "required" (back-compat default)
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  __setPluginAgentComponentForTest,
  resolveProviderToolChoice,
  runWorkflowJsonOutputExtraction,
  type ProviderConfigSource,
} from "./workflow-json-output-plugin";
import { WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME } from "../tools/submit-json-output-tool";

/**
 * Build a mock agentComponent whose `.run()` captures the toolChoice that
 * was actually passed, and whose `configComponent.get(key)` returns the
 * LLM provider config map.
 */
function buildMockAgentComponent(providerId: string | undefined, capabilities: { reasoning?: boolean } | undefined) {
  let capturedContext: any = null;

  const config: Record<string, unknown> = {
    "llm.defaultProvider": providerId,
  };
  if (providerId && capabilities !== undefined) {
    config[`llm.providers.${providerId}.capabilities`] = capabilities;
  }

  const mockAgentComponent: any = {
    configComponent: {
      get: (key: string) => config[key],
    },
    run: vi.fn(async (_name: string, _query: string, ctx: any) => {
      capturedContext = ctx;
      const submitTool = ctx.extraTools?.find((t: any) => t.name === WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME);
      if (submitTool) {
        await submitTool.execute({ char_count: 13, summary: "A simple greeting" });
      }
      return {
        iterations: 1,
        toolCalls: [{ name: WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME }],
        error: undefined,
      };
    }),
    getCapturedContext: () => capturedContext,
  };

  return mockAgentComponent;
}

function buildHookCtx() {
  return {
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: '{"char_count": 13, "summary": "A simple greeting"}',
          },
        ],
      },
    ],
    llmOutput: {
      content: '{"char_count": 13, "summary": "A simple greeting"}',
      toolCalls: [],
      finishReason: "stop",
    },
    context: {
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
      abort: new AbortController().signal,
    },
    iteration: 1,
    maxIterations: 1,
    tools: [],
    systemPrompt: "",
    agent: { name: "test", config: {}, status: "running", plugins: {} },
  } as any;
}

describe("json-extract sub-agent toolChoice — provider compatibility (Task #2175)", () => {
  afterEach(() => {
    __setPluginAgentComponentForTest(null);
  });

  it("RED-1: deepseek + reasoning=true → toolChoice='auto' (NOT 'required')", async () => {
    const mock = buildMockAgentComponent("deepseek", { reasoning: true });
    __setPluginAgentComponentForTest(mock);

    await runWorkflowJsonOutputExtraction(buildHookCtx());

    expect(mock.run).toHaveBeenCalledTimes(1);
    const captured = mock.getCapturedContext();
    expect(captured.toolChoice).toBe("auto");
  });

  it("RED-2: openai → toolChoice MUST remain 'required' (preserves commit 2c428554 fix)", async () => {
    const mock = buildMockAgentComponent("openai", undefined);
    __setPluginAgentComponentForTest(mock);

    await runWorkflowJsonOutputExtraction(buildHookCtx());

    const captured = mock.getCapturedContext();
    expect(captured.toolChoice).toBe("required");
  });

  it("RED-3: anthropic + reasoning=true → toolChoice='required' (first-party reasoning is fine)", async () => {
    const mock = buildMockAgentComponent("anthropic", { reasoning: true });
    __setPluginAgentComponentForTest(mock);

    await runWorkflowJsonOutputExtraction(buildHookCtx());

    const captured = mock.getCapturedContext();
    expect(captured.toolChoice).toBe("required");
  });

  it("RED-4: volcengine + reasoning=true → toolChoice='auto' (OpenAI-compatible thinking mode)", async () => {
    const mock = buildMockAgentComponent("volcengine", { reasoning: true });
    __setPluginAgentComponentForTest(mock);

    await runWorkflowJsonOutputExtraction(buildHookCtx());

    const captured = mock.getCapturedContext();
    expect(captured.toolChoice).toBe("auto");
  });

  it("RED-5: openai-compatible 'qwen-thinking' + reasoning=true → toolChoice='auto'", async () => {
    const mock = buildMockAgentComponent("qwen-thinking", { reasoning: true });
    __setPluginAgentComponentForTest(mock);

    await runWorkflowJsonOutputExtraction(buildHookCtx());

    const captured = mock.getCapturedContext();
    expect(captured.toolChoice).toBe("auto");
  });

  it("EDGE-1: no provider configured → defaults to 'required' (back-compat)", async () => {
    // No configComponent at all — fallback path
    const mock = buildMockAgentComponent(undefined, undefined);
    mock.configComponent = undefined; // force the no-config path
    __setPluginAgentComponentForTest(mock);

    await runWorkflowJsonOutputExtraction(buildHookCtx());

    const captured = mock.getCapturedContext();
    expect(captured.toolChoice).toBe("required");
  });

  it("EDGE-2: configComponent.get throws ConfigValidationError → defaults to 'required' (back-compat, never bubble)", async () => {
    // If configComponent.get() throws a ConfigValidationError (corrupted user
    // config), the plugin must NOT propagate the throw to the caller — it must
    // default to 'required' (back-compat) and continue. A throw here would break
    // workflow extraction entirely.
    //
    // Updated in Task #2181 finding #2: catch is now SELECTIVE. Only
    // ConfigValidationError (corrupted config) is silently recovered; programmer
    // errors (TypeError / ReferenceError) MUST bubble up. See NEW-EDGE-SELECTIVE-CATCH.
    let capturedContext: any = null;
    const mock: any = {
      configComponent: {
        get: () => {
          const e = new Error("Configuration validation failed for key: llm.defaultProvider");
          e.name = "ConfigValidationError";
          throw e;
        },
      },
      run: vi.fn(async (_name: string, _query: string, ctx: any) => {
        capturedContext = ctx;
        const submitTool = ctx.extraTools?.find((t: any) => t.name === WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME);
        if (submitTool) {
          await submitTool.execute({ char_count: 13, summary: "A simple greeting" });
        }
        return {
          iterations: 1,
          toolCalls: [{ name: WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME }],
          error: undefined,
        };
      }),
    };
    __setPluginAgentComponentForTest(mock);

    // Must NOT throw — if it throws, the test fails naturally.
    await runWorkflowJsonOutputExtraction(buildHookCtx());

    expect(mock.run).toHaveBeenCalledTimes(1);
    expect(capturedContext.toolChoice).toBe("required");
  });

  it("NEW-EDGE-SELECTIVE-CATCH: configComponent.get throws TypeError (programmer error) → bubbles up, NOT silently swallowed", () => {
    // Task #2181 finding #2: the previous readProviderReasoning used broad
    // catch {} which silently swallowed ALL errors including programmer errors
    // (typos in key names, accessing undefined properties). This hid bugs behind
    // a silent toolChoice decision. The selective catch must:
    //   - ConfigValidationError (corrupted user config) → silent recovery
    //   - TypeError / ReferenceError / programmer bugs → BUBBLE UP
    const throwingSource: ProviderConfigSource = {
      configComponent: {
        get: (_key: string) => {
          throw new TypeError("Cannot read properties of undefined (reading 'foo')");
        },
      },
    };

    expect(() => resolveProviderToolChoice(throwingSource)).toThrow(TypeError);
  });

  it("NEW-EDGE-SELECTIVE-CATCH-2: ReferenceError (programmer error) also bubbles up", () => {
    // Same rationale as NEW-EDGE-SELECTIVE-CATCH but with ReferenceError to
    // confirm the selective catch catches the general "programmer error" class,
    // not just TypeError specifically.
    const throwingSource: ProviderConfigSource = {
      configComponent: {
        get: (_key: string) => {
          throw new ReferenceError("x is not defined");
        },
      },
    };

    expect(() => resolveProviderToolChoice(throwingSource)).toThrow(ReferenceError);
  });

  it("EDGE-3: documents that session-level provider override is NOT consulted (limitation)", async () => {
    // Global default = openai (first-party → 'required')
    // Session metadata.llmProvider = deepseek (would force 'auto' if consulted)
    //
    // CURRENT BEHAVIOR (Task #2177 review B-3): plugin only reads the global
    // `llm.defaultProvider` config key, NOT session-level overrides. This test
    // pins the limitation so a future contributor who adds session-override
    // support must update this test AND document the override precedence rules.
    let capturedContext: any = null;
    const mock: any = {
      configComponent: {
        get: (key: string) => {
          if (key === "llm.defaultProvider") return "openai";
          if (key === "llm.providers.openai.capabilities") return undefined;
          return undefined;
        },
      },
      run: vi.fn(async (_name: string, _query: string, ctx: any) => {
        capturedContext = ctx;
        const submitTool = ctx.extraTools?.find((t: any) => t.name === WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME);
        if (submitTool) {
          await submitTool.execute({ char_count: 13, summary: "A simple greeting" });
        }
        return {
          iterations: 1,
          toolCalls: [{ name: WORKFLOW_SUBMIT_OUTPUT_TOOL_NAME }],
          error: undefined,
        };
      }),
    };
    __setPluginAgentComponentForTest(mock);

    const hookCtx = buildHookCtx();
    // Inject session-level override (would force 'auto' if consulted)
    (hookCtx.context as any).metadata = {
      ...hookCtx.context.metadata,
      llmProvider: "deepseek",
    };

    await runWorkflowJsonOutputExtraction(hookCtx);

    // Pin current behavior: global openai wins → 'required'.
    expect(capturedContext.toolChoice).toBe("required");
  });

  // ============================================================================
  // Task #2177 review findings — narrow interface contract
  // ============================================================================

  it("INTF-1: resolveProviderToolChoice accepts ProviderConfigSource | null | undefined", () => {
    // Compile-time + runtime contract: a narrow interface replaces `any`.
    // The function must accept objects that satisfy ProviderConfigSource.
    const a: ProviderConfigSource = {
      configComponent: {
        get: (key: string) => {
          if (key === "llm.defaultProvider") return "openai";
          if (key === "llm.providers.openai.capabilities") return { reasoning: false };
          return undefined;
        },
      },
    };
    expect(resolveProviderToolChoice(a)).toBe("required");
    expect(resolveProviderToolChoice(null)).toBe("required");
    expect(resolveProviderToolChoice(undefined)).toBe("required");

    const b: ProviderConfigSource = {
      configComponent: {
        get: (key: string) => {
          if (key === "llm.defaultProvider") return "deepseek";
          if (key === "llm.providers.deepseek.capabilities") return { reasoning: true };
          return undefined;
        },
      },
    };
    expect(resolveProviderToolChoice(b)).toBe("auto");

    // @ts-expect-error — raw number is not a ProviderConfigSource
    expect(resolveProviderToolChoice(42)).toBe("required");
  });
});
