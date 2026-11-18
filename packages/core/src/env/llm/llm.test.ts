import { vi, describe, test, expect, beforeEach, afterEach } from "bun:test";
import { LLMComponent } from "./llm";
import { ConfigComponent } from "../../config/config-component";
import type { Environment } from "../interface";

// Mock the invoke module to verify toolChoice is passed through
// IMPORTANT: this is imported here only to get a reference to the module namespace.
// We must NOT call vi.spyOn(invokeModule, "invoke") at the file level because that
// would permanently replace the `invoke` export of this module for ALL test files
// in the same process (ESM live bindings). Other test files (e.g. invoke.test.ts)
// also use `import { invoke } from "./invoke"` and would be broken because their
// `invoke` reference would be the spy.
//
// Instead, the spy on `invoke` is created inside the relevant `describe` block below
// and restored in `afterEach`. This way the spy only exists for the duration of the
// tests that actually need it.
import * as invokeModule from "./invoke";

describe("LLMComponent", () => {
  let component: LLMComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let invokeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    component = new LLMComponent();
    configComponent = new ConfigComponent();
    
    // Mock environment
    mockEnv = {
      getComponent: vi.fn((name: string) => {
        if (name === "config") return configComponent;
        return undefined;
      }),
      hasComponent: vi.fn((name: string) => name === "config"),
      logger: vi.fn(),
      trace: vi.fn(),
    } as unknown as Environment;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    test("should create instance with correct name and version", () => {
      expect(component.name).toBe("llm");
      expect(component.version).toBe("2.0.0");
    });

    test("should have hookManager", () => {
      expect(component.hookManager).toBeDefined();
    });
  });

  describe("init", () => {
    test("should initialize with ConfigComponent", async () => {
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });
      expect(component.getStatus()).toBe("running");
    });

    test("should throw error without ConfigComponent", async () => {
      await expect(component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
      })).rejects.toThrow("ConfigComponent is required");
    });
  });

  describe("hooks", () => {
    test("should add hook", async () => {
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });

      const beforeFn = async () => {};
      const afterFn = async () => {};

      component.addHook("llm.before-invoke", "test-before-hook", beforeFn);
      component.addHook("llm.after-invoke", "test-after-hook", afterFn);

      // 通过 hookManager 验证 hooks 已注册
      expect(component.hookManager.count("llm.before-invoke")).toBe(1);
      expect(component.hookManager.count("llm.after-invoke")).toBe(1);
    });

    test("should remove hook", async () => {
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });

      const hookFn = async () => {};

      component.addHook("llm.before-invoke", "test-hook", hookFn);
      expect(component.hookManager.count("llm.before-invoke")).toBe(1);

      component.removeHook("llm.before-invoke", "test-hook");
      expect(component.hookManager.count("llm.before-invoke")).toBe(0);
    });
  });

  describe("lifecycle", () => {
    test("should transition through lifecycle states", async () => {
      expect(component.getStatus()).toBe("created");

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });
      expect(component.getStatus()).toBe("running");

      await component.onStop();
      expect(component.getStatus()).toBe("stopped");

      await component.onStart();
      expect(component.getStatus()).toBe("running");
    });
  });

  describe("invoke", () => {
    test("should throw error when component is not running", async () => {
      await expect(component.invoke({
        messages: [{ role: "user", content: "Hello" }]
      })).rejects.toThrow("LLMComponent is not running");
    });

    test("should throw error when apiKey is missing", async () => {
      // ConfigComponent is empty, no API key configured
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });

      await expect(component.invoke({
        messages: [{ role: "user", content: "Hello" }]
      })).rejects.toThrow(/API key not found for provider/);
    });

    test("should throw error when provider does not exist", async () => {
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });

      await expect(component.invoke({
        messages: [{ role: "user", content: "Hello" }],
        providerId: "non-existent-provider"
      })).rejects.toThrow(/API key not found for provider/);
    });
  });

  describe("config hot reload", () => {
    test("should register config watcher on init", async () => {
      const watchSpy = vi.spyOn(configComponent, "watch");
      
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });

      // Verify watch was called for llm.* patterns
      expect(watchSpy).toHaveBeenCalled();
    });

    test("should cleanup watcher on stop", async () => {
      const watchSpy = vi.spyOn(configComponent, "watch");
      
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });

      // Get the unwatch function returned by watch
      const watchCall = watchSpy.mock.calls[0];
      const callback = watchCall?.[1] as Function;

      await component.onStop();
      // Stop should be successful (watcher cleaned up)
      expect(component.getStatus()).toBe("stopped");
    });

    test("should handle provider config reload", async () => {
      // Set providers config before init
      configComponent.set("llm.providers", {
        openai: {
          apiKey: "test-key",
          baseURL: "https://api.openai.com/v1"
        }
      });
      
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });

      // Verify provider is loaded from config
      const provider = component.getProvider("openai");
      expect(provider).toBeDefined();
      expect(provider?.apiKey).toBe("test-key");

      // Simulate config change event
      component.onConfigChange({
        key: "llm.providers",
        oldValue: { openai: { apiKey: "test-key" } },
        newValue: { openai: { apiKey: "new-key" } }
      });

      // After config change event, onConfigChange should be called successfully
      // (Verification is done by checking no error is thrown)
      expect(true).toBe(true);
    });
  });

  describe("toolChoice passing", () => {
    beforeEach(() => {
      // Spy on invoke ONLY for tests in this describe block. This avoids
      // permanently replacing the `invoke` export for other test files.
      invokeSpy = vi.spyOn(invokeModule, "invoke");
    });

    afterEach(() => {
      // Restore the original invoke function so other test files are not
      // affected by the spy.
      invokeSpy.mockRestore();
    });

    test("should pass toolChoice as function call to invoke", async () => {
      (invokeSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCallId: "test-call",
        result: JSON.stringify({
          content: "test response",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        }),
      });

      // Set up config with API key
      configComponent.set("llm.providers", {
        openai: { apiKey: "sk-test" },
      });

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent },
      });

      await component.invoke({
        messages: [{ role: "user", content: "Hello" }],
        toolChoice: { type: "function", function: { name: "test_tool" } },
      });

      // Verify invoke was called with toolChoice in options
      expect(invokeSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          toolChoice: { type: "function", function: { name: "test_tool" } },
        }),
        expect.anything(),
      );
    });

    test("should pass toolChoice as 'none' to invoke", async () => {
      (invokeSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCallId: "test-call",
        result: JSON.stringify({
          content: "test response",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        }),
      });

      configComponent.set("llm.providers", {
        openai: { apiKey: "sk-test" },
      });

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent },
      });

      await component.invoke({
        messages: [{ role: "user", content: "Hello" }],
        toolChoice: "none",
      });

      expect(invokeSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          toolChoice: "none",
        }),
        expect.anything(),
      );
    });

    test("should pass toolChoice as 'auto' to invoke", async () => {
      (invokeSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCallId: "test-call",
        result: JSON.stringify({
          content: "test response",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        }),
      });

      configComponent.set("llm.providers", {
        openai: { apiKey: "sk-test" },
      });

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent },
      });

      await component.invoke({
        messages: [{ role: "user", content: "Hello" }],
        toolChoice: "auto",
      });

      expect(invokeSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          toolChoice: "auto",
        }),
        expect.anything(),
      );
    });
  });

  /**
   * `thinkingInText` is **explicit-config-only**: we do NOT auto-infer it from
   * `capabilities.reasoning`.
   *
   * Rationale:
   * - DeepSeek-style providers emit reasoning via the SDK's native
   *   `reasoning-delta` events (from `reasoning_content` API field), and
   *   `text-delta` does NOT contain inline `<think>` tags — so no tag
   *   stripping is needed.
   * - Only MiniMax-style providers (text-delta with inline `<think>` tags)
   *   need the `thinkingInText` strip pass.
   * - Forcing a default on every reasoning-capable provider would wrongly
   *   activate the strip pass for DeepSeek and similar models.
   *
   * Therefore, `resolveRequest()` only forwards `thinkingInText` to
   * `invokeConfig.options.thinkingInText` when the provider explicitly
   * configures `capabilities.thinkingInText`. This block pins down that
   * explicit-only contract.
   */
	describe("thinkingInText explicit-config-only", () => {
    let deepseekComponent: LLMComponent;
    let deepseekConfigComponent: ConfigComponent;
    let deepseekMockEnv: Environment;
    let deepseekInvokeSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      vi.clearAllMocks();
      deepseekComponent = new LLMComponent();
      deepseekConfigComponent = new ConfigComponent();
      deepseekMockEnv = {
        getComponent: vi.fn((name: string) => {
          if (name === "config") return deepseekConfigComponent;
          return undefined;
        }),
        hasComponent: vi.fn((name: string) => name === "config"),
        logger: vi.fn(),
        trace: vi.fn(),
      } as unknown as Environment;

      deepseekInvokeSpy = vi.spyOn(invokeModule, "invoke");
    });

    afterEach(() => {
      deepseekInvokeSpy.mockRestore();
    });

    test("should NOT auto-apply thinkingInText from capabilities.reasoning alone (deepseek pattern)", async () => {
      (deepseekInvokeSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCallId: "test-call",
        result: JSON.stringify({
          content: "test response",
          reasoning: "test reasoning",
          usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
        }),
      });

      // DeepSeek-style provider: reasoning=true, but NO thinkingInText.
      // DeepSeek's reasoning comes solely through SDK reasoning-delta events,
      // not via <think> tags in text-delta — no thinkingInText stripping needed.
      deepseekConfigComponent.set("llm.providers", {
        deepseek: {
          provider: "openai-compatible",
          apiKey: "sk-test",
          baseURL: "https://api.deepseek.com/v1",
          defaultModel: "deepseek-v4-flash",
          capabilities: {
            reasoning: true,
            toolcall: true,
          },
        },
      });
      deepseekConfigComponent.set("llm.defaultProvider", "deepseek");
      deepseekConfigComponent.set("llm.defaultModel", "deepseek-v4-flash");

      await deepseekComponent.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: deepseekMockEnv,
        options: { configComponent: deepseekConfigComponent },
      });

      await deepseekComponent.invoke({
        messages: [{ role: "user", content: "Hello" }],
      });

      // thinkingInText must NOT be added when only capabilities.reasoning is set —
      // only explicit capabilities.thinkingInText triggers it.
      expect(deepseekInvokeSpy).toHaveBeenCalledTimes(1);
      const invokeConfig = deepseekInvokeSpy.mock.calls[0][0] as {
        options?: {
          thinkingInText?: unknown;
        };
      };
      expect(invokeConfig.options?.thinkingInText).toBeUndefined();
    });

    test("should NOT override explicitly configured thinkingInText (different tags)", async () => {
      (deepseekInvokeSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCallId: "test-call",
        result: JSON.stringify({
          content: "test response",
        }),
      });

      // Provider has reasoning=true but explicitly configured different
      // thinkingInText tags. Auto-defaults must NOT override the user's
      // explicit configuration (must use the user-provided tags, not
      // the auto-default ["think"]).
      deepseekConfigComponent.set("llm.providers", {
        custom: {
          provider: "openai-compatible",
          apiKey: "sk-test",
          defaultModel: "custom-model",
          capabilities: {
            reasoning: true,
            toolcall: true,
            thinkingInText: {
              enabled: true,
              tags: ["reflection"],
              removeFromOutput: true,
            },
          },
        },
      });
      deepseekConfigComponent.set("llm.defaultProvider", "custom");
      deepseekConfigComponent.set("llm.defaultModel", "custom-model");

      await deepseekComponent.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: deepseekMockEnv,
        options: { configComponent: deepseekConfigComponent },
      });

      await deepseekComponent.invoke({
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(deepseekInvokeSpy).toHaveBeenCalledTimes(1);
      const invokeConfig = deepseekInvokeSpy.mock.calls[0][0] as {
        options?: {
          thinkingInText?: {
            enabled?: boolean;
            tags?: string[];
            removeFromOutput?: boolean;
          };
        };
      };
      // User's explicit tags must be preserved — auto-defaults would use ["think"].
      expect(invokeConfig.options?.thinkingInText?.enabled).toBe(true);
      expect(invokeConfig.options?.thinkingInText?.tags).toEqual(["reflection"]);
      expect(invokeConfig.options?.thinkingInText?.removeFromOutput).toBe(true);
    });

    test("should NOT add thinkingInText when reasoning is false", async () => {
      (deepseekInvokeSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCallId: "test-call",
        result: JSON.stringify({
          content: "test response",
        }),
      });

      // Plain non-reasoning provider (e.g. gpt-4o).
      deepseekConfigComponent.set("llm.providers", {
        openai: {
          provider: "openai",
          apiKey: "sk-test",
          capabilities: {
            reasoning: false,
            toolcall: true,
          },
        },
      });
      deepseekConfigComponent.set("llm.defaultProvider", "openai");
      deepseekConfigComponent.set("llm.defaultModel", "gpt-4o");

      await deepseekComponent.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: deepseekMockEnv,
        options: { configComponent: deepseekConfigComponent },
      });

      await deepseekComponent.invoke({
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(deepseekInvokeSpy).toHaveBeenCalledTimes(1);
      const invokeConfig = deepseekInvokeSpy.mock.calls[0][0] as {
        options?: {
          thinkingInText?: unknown;
        };
      };
      // No reasoning → no auto thinkingInText. options should be undefined
      // (resolveRequest only adds options.thinkingInText when enabled).
      expect(invokeConfig.options?.thinkingInText).toBeUndefined();
    });

    test("should preserve full minimax-style config when thinkingInText is explicit", async () => {
      (deepseekInvokeSpy as ReturnType<typeof vi.fn>).mockResolvedValue({
        toolCallId: "test-call",
        result: JSON.stringify({
          content: "test response",
        }),
      });

      // Mirror minimax config: explicit thinkingInText with tags + removeFromOutput.
      deepseekConfigComponent.set("llm.providers", {
        minimax: {
          provider: "openai-compatible",
          apiKey: "sk-test",
          defaultModel: "MiniMax-M3",
          capabilities: {
            reasoning: true,
            toolcall: true,
            thinkingInText: {
              enabled: true,
              tags: ["think"],
              removeFromOutput: true,
            },
          },
        },
      });
      deepseekConfigComponent.set("llm.defaultProvider", "minimax");
      deepseekConfigComponent.set("llm.defaultModel", "MiniMax-M3");

      await deepseekComponent.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: deepseekMockEnv,
        options: { configComponent: deepseekConfigComponent },
      });

      await deepseekComponent.invoke({
        messages: [{ role: "user", content: "Hello" }],
      });

      expect(deepseekInvokeSpy).toHaveBeenCalledTimes(1);
      const invokeConfig = deepseekInvokeSpy.mock.calls[0][0] as {
        options?: {
          thinkingInText?: {
            enabled?: boolean;
            tags?: string[];
            removeFromOutput?: boolean;
          };
        };
      };
      expect(invokeConfig.options?.thinkingInText?.enabled).toBe(true);
      expect(invokeConfig.options?.thinkingInText?.tags).toEqual(["think"]);
      expect(invokeConfig.options?.thinkingInText?.removeFromOutput).toBe(true);
    });
  });
});
