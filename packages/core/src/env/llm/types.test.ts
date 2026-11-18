import { describe, test, expect } from "bun:test";
import { z } from "zod";
import type {
  LLMMessage,
  LLMOutput,
  UsageInfo,
  ToolCall,
  ToolResult,
  LLMConfig,
} from "./types";
import { LLMConfigSchema } from "./types";

describe("LLMConfigSchema", () => {
  test("should validate valid config with required fields", () => {
    const config = {
      providers: {
        openai: {
          provider: "openai",
          apiKey: "sk-test",
          baseURL: "https://api.openai.com/v1",
          models: ["gpt-4", "gpt-4-turbo"],
        },
      },
      defaultProvider: "openai",
      defaultModel: "gpt-4",
    };

    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultProvider).toBe("openai");
      expect(result.data.defaultModel).toBe("gpt-4");
    }
  });

  test("should validate config with optional fields", () => {
    const config = {
      providers: {
        openai: {
          provider: "openai",
          apiKey: "sk-test",
        },
      },
      defaultProvider: "openai",
      defaultModel: "gpt-4",
      temperature: 0.7,
      maxTokens: 4096,
      topP: 0.9,
      stream: true,
    };

    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.temperature).toBe(0.7);
      expect(result.data.maxTokens).toBe(4096);
    }
  });

  test("should fail validation for missing providers", () => {
    const config = {
      defaultProvider: "openai",
      defaultModel: "gpt-4",
    };

    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("should fail validation for missing defaultProvider", () => {
    const config = {
      providers: {
        openai: {
          provider: "openai",
          apiKey: "sk-test",
        },
      },
      defaultModel: "gpt-4",
    };

    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  test("should apply default values", () => {
    const config = {
      providers: {
        openai: {
          provider: "openai",
          apiKey: "sk-test",
        },
      },
      defaultProvider: "openai",
      defaultModel: "gpt-4",
    };

    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.stream).toBe(true); // default: true
      // Task #4946 review MINOR-4：schema 不再注入 .default(0.7) ——
      // 「未配置」必须保持 undefined，否则全局默认值会掩盖
      // provider 级 temperature（死锁复活）。兜底值由
      // temperature-policy.resolveTemperature() 统一负责。
      expect(result.data.temperature).toBeUndefined();
    }
  });
});

describe("LLMMessage type", () => {
  test("should accept user message", () => {
    const msg: LLMMessage = {
      role: "user",
      content: "Hello, world!",
    };
    expect(msg.role).toBe("user");
    expect(msg.content).toBe("Hello, world!");
  });

  test("should accept assistant message with content", () => {
    const msg: LLMMessage = {
      role: "assistant",
      content: "Hello!",
    };
    expect(msg.role).toBe("assistant");
  });

  test("should accept assistant message with tool calls", () => {
    const msg: LLMMessage = {
      role: "assistant",
      content: "Let me search for that.",
      toolCalls: [
        {
          id: "call_1",
          name: "search",
          arguments: '{"query":"weather"}',
        },
      ],
    };
    expect(msg.toolCalls).toHaveLength(1);
    expect(msg.toolCalls?.[0].name).toBe("search");
  });

  test("should accept system message", () => {
    const msg: LLMMessage = {
      role: "system",
      content: "You are a helpful assistant.",
    };
    expect(msg.role).toBe("system");
  });

  test("should accept tool message", () => {
    const msg: LLMMessage = {
      role: "tool",
      content: "The weather is sunny.",
      toolCallId: "call_1",
    };
    expect(msg.role).toBe("tool");
    expect(msg.toolCallId).toBe("call_1");
  });
});

describe("LLMOutput type", () => {
  test("should accept output with content", () => {
    const output: LLMOutput = {
      content: "The answer is 42.",
      finishReason: "stop",
    };
    expect(output.content).toBe("The answer is 42.");
    expect(output.finishReason).toBe("stop");
  });

  test("should accept output with tool calls", () => {
    const output: LLMOutput = {
      content: "Let me get that information.",
      finishReason: "tool-calls",
      toolCalls: [
        {
          id: "call_1",
          name: "search",
          arguments: '{"query":"weather"}',
        },
      ],
    };
    expect(output.toolCalls).toHaveLength(1);
  });

  test("should accept output with usage info", () => {
    const output: LLMOutput = {
      content: "Hello!",
      finishReason: "stop",
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      },
    };
    expect(output.usage?.promptTokens).toBe(10);
    expect(output.usage?.completionTokens).toBe(5);
  });
});

describe("ToolCall type", () => {
  test("should accept valid tool call", () => {
    const toolCall: ToolCall = {
      id: "call_abc123",
      name: "getWeather",
      arguments: '{"location":"Beijing","unit":"celsius"}',
    };
    expect(toolCall.id).toBe("call_abc123");
    expect(toolCall.name).toBe("getWeather");
    expect(toolCall.arguments).toBe('{"location":"Beijing","unit":"celsius"}');
  });
});

describe("ToolResult type", () => {
  test("should accept tool result", () => {
    const result: ToolResult = {
      toolCallId: "call_abc123",
      result: "Sunny, 25°C",
    };
    expect(result.toolCallId).toBe("call_abc123");
    expect(result.result).toBe("Sunny, 25°C");
  });

  test("should accept tool result with error", () => {
    const result: ToolResult = {
      toolCallId: "call_abc123",
      result: "Error: API rate limited",
      isError: true,
    };
    expect(result.isError).toBe(true);
  });
});

describe("UsageInfo type", () => {
  test("should accept usage info", () => {
    const usage: UsageInfo = {
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
    };
    expect(usage.promptTokens).toBe(100);
    expect(usage.completionTokens).toBe(50);
    expect(usage.totalTokens).toBe(150);
  });
});

describe("ProviderCapabilitiesSchema", () => {
  test("should validate empty capabilities", () => {
    const { ProviderCapabilitiesSchema } = require("./types");
    const result = ProviderCapabilitiesSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("should validate capabilities with reasoning", () => {
    const { ProviderCapabilitiesSchema } = require("./types");
    const result = ProviderCapabilitiesSchema.safeParse({
      reasoning: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.reasoning).toBe(true);
    }
  });

  test("should validate capabilities with toolcall", () => {
    const { ProviderCapabilitiesSchema } = require("./types");
    const result = ProviderCapabilitiesSchema.safeParse({
      toolcall: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.toolcall).toBe(true);
    }
  });

  test("should validate capabilities with thinkingInText", () => {
    const { ProviderCapabilitiesSchema } = require("./types");
    const result = ProviderCapabilitiesSchema.safeParse({
      thinkingInText: {
        enabled: true,
        tags: ["<think>", "</think>"],
        removeFromOutput: true,
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.thinkingInText?.enabled).toBe(true);
      expect(result.data.thinkingInText?.tags).toEqual(["<think>", "</think>"]);
    }
  });

  test("should validate capabilities with interleaved", () => {
    const { ProviderCapabilitiesSchema } = require("./types");
    const result = ProviderCapabilitiesSchema.safeParse({
      interleaved: {
        field: "thinking",
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.interleaved?.field).toBe("thinking");
    }
  });

  test("should validate full capabilities", () => {
    const { ProviderCapabilitiesSchema } = require("./types");
    const result = ProviderCapabilitiesSchema.safeParse({
      reasoning: true,
      toolcall: true,
      interleaved: { field: "thinking" },
      thinkingInText: {
        enabled: true,
        tags: ["<think>"],
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("ModelLimitsSchema", () => {
  test("should validate valid limits", () => {
    const { ModelLimitsSchema } = require("./types");
    const result = ModelLimitsSchema.safeParse({
      contextWindow: 128000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.contextWindow).toBe(128000);
    }
  });

  test("should validate limits with optional fields", () => {
    const { ModelLimitsSchema } = require("./types");
    const result = ModelLimitsSchema.safeParse({
      contextWindow: 128000,
      compactionThreshold: 0.8,
      maxOutputTokens: 4096,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.compactionThreshold).toBe(0.8);
      expect(result.data.maxOutputTokens).toBe(4096);
    }
  });

  test("should fail for missing contextWindow", () => {
    const { ModelLimitsSchema } = require("./types");
    const result = ModelLimitsSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  test("should fail for negative contextWindow", () => {
    const { ModelLimitsSchema } = require("./types");
    const result = ModelLimitsSchema.safeParse({
      contextWindow: -1000,
    });
    expect(result.success).toBe(false);
  });

  test("should fail for compactionThreshold out of range", () => {
    const { ModelLimitsSchema } = require("./types");
    const result = ModelLimitsSchema.safeParse({
      contextWindow: 128000,
      compactionThreshold: 1.5,
    });
    expect(result.success).toBe(false);
  });
});

describe("ProviderConfigSchema", () => {
  test("should validate minimal provider config", () => {
    const { ProviderConfigSchema } = require("./types");
    const result = ProviderConfigSchema.safeParse({
      provider: "openai",
      apiKey: "sk-test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.provider).toBe("openai");
      expect(result.data.apiKey).toBe("sk-test");
    }
  });

  test("should validate full provider config", () => {
    const { ProviderConfigSchema } = require("./types");
    const result = ProviderConfigSchema.safeParse({
      provider: "openai",
      name: "OpenAI Provider",
      description: "OpenAI API provider",
      apiKey: "sk-test",
      baseURL: "https://api.openai.com/v1",
      models: ["gpt-4o", "gpt-4o-mini"],
      defaultModel: "gpt-4o",
      temperature: 0.7,
      maxTokens: 4096,
      capabilities: {
        reasoning: true,
        toolcall: true,
      },
      limits: {
        "gpt-4o": {
          contextWindow: 128000,
          maxOutputTokens: 4096,
        },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.models).toHaveLength(2);
      expect(result.data.capabilities?.reasoning).toBe(true);
    }
  });

  test("should fail for missing apiKey", () => {
    const { ProviderConfigSchema } = require("./types");
    const result = ProviderConfigSchema.safeParse({
      provider: "openai",
    });
    expect(result.success).toBe(false);
  });

  test("should validate with providerOptions", () => {
    const { ProviderConfigSchema } = require("./types");
    const result = ProviderConfigSchema.safeParse({
      provider: "openai",
      apiKey: "sk-test",
      providerOptions: {
        __dangerous__: {
          allowBrowser: true,
        },
      },
    });
    expect(result.success).toBe(true);
  });
});

describe("LLMDefaultConfigSchema", () => {
  test("should validate empty default config", () => {
    const { LLMDefaultConfigSchema } = require("./types");
    const result = LLMDefaultConfigSchema.safeParse({});
    expect(result.success).toBe(true);
  });

  test("should validate with temperature", () => {
    const { LLMDefaultConfigSchema } = require("./types");
    const result = LLMDefaultConfigSchema.safeParse({
      temperature: 0.5,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.temperature).toBe(0.5);
    }
  });

  test("should validate with maxTokens", () => {
    const { LLMDefaultConfigSchema } = require("./types");
    const result = LLMDefaultConfigSchema.safeParse({
      maxTokens: 2048,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxTokens).toBe(2048);
    }
  });

  test("should fail for temperature out of range", () => {
    const { LLMDefaultConfigSchema } = require("./types");
    const result = LLMDefaultConfigSchema.safeParse({
      temperature: 3.0,
    });
    expect(result.success).toBe(false);
  });

  test("should fail for negative maxTokens", () => {
    const { LLMDefaultConfigSchema } = require("./types");
    const result = LLMDefaultConfigSchema.safeParse({
      maxTokens: -100,
    });
    expect(result.success).toBe(false);
  });
});

describe("LLMConfigSchema full validation", () => {
  test("should validate minimal config", () => {
    const config = {
      providers: {
        openai: {
          provider: "openai",
          apiKey: "sk-test",
        },
      },
      defaultProvider: "openai",
    };

    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultProvider).toBe("openai");
      expect(result.data.stream).toBe(true); // default
      // Task #4946 review MINOR-4：未配置的 temperature 保持 undefined
      expect(result.data.temperature).toBeUndefined();
    }
  });

  test("should validate config with multiple providers", () => {
    const config = {
      providers: {
        openai: {
          provider: "openai",
          apiKey: "sk-openai",
        },
        anthropic: {
          provider: "anthropic",
          apiKey: "sk-antropic",
        },
        google: {
          provider: "google",
          apiKey: "sk-google",
          baseURL: "https://generativelanguage.googleapis.com",
        },
      },
      defaultProvider: "openai",
      defaultModel: "gpt-4o",
      temperature: 0.8,
      stream: false,
    };

    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data.providers)).toHaveLength(3);
    }
  });

  test("should validate config with default section", () => {
    const config = {
      providers: {
        openai: {
          provider: "openai",
          apiKey: "sk-test",
        },
      },
      defaultProvider: "openai",
      default: {
        temperature: 0.5,
        maxTokens: 2048,
      },
    };

    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.default?.temperature).toBe(0.5);
    }
  });

  test("should allow empty providers (config can be extended later)", () => {
    const config = {
      providers: {},
      defaultProvider: "openai",
    };

    // Empty providers is valid - config can be extended later
    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  test("should fail for topP out of range", () => {
    const config = {
      providers: {
        openai: {
          provider: "openai",
          apiKey: "sk-test",
        },
      },
      defaultProvider: "openai",
      topP: 1.5,
    };

    const result = LLMConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });
});
