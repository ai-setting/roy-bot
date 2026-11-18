import { describe, test, expect, beforeEach } from "bun:test";
import type { LLMConfig, ProviderConfig } from "./types";
import { ProviderManager } from "./provider";

describe("ProviderManager", () => {
  let manager: ProviderManager;

  beforeEach(() => {
    manager = new ProviderManager();
  });

  describe("initialize", () => {
    test("should create providers from config", async () => {
      const config: LLMConfig = {
        providers: {
          openai: {
            provider: "openai",
            apiKey: "sk-test-key",
            baseURL: "https://api.openai.com/v1",
            models: ["gpt-4", "gpt-4-turbo"],
          },
        },
        defaultProvider: "openai",
        defaultModel: "gpt-4",
      };

      await manager.initialize(config);

      const provider = manager.getProvider("openai");
      expect(provider).toBeDefined();
      expect(provider?.id).toBe("openai");
    });

    test("should create multiple providers", async () => {
      const config: LLMConfig = {
        providers: {
          openai: {
            provider: "openai",
            apiKey: "sk-test-openai",
          },
          anthropic: {
            provider: "anthropic",
            apiKey: "sk-ant-test",
          },
        },
        defaultProvider: "openai",
        defaultModel: "gpt-4",
      };

      await manager.initialize(config);

      const providers = manager.listProviders();
      expect(providers).toHaveLength(2);
      expect(providers.map((p) => p.id).sort()).toEqual(["anthropic", "openai"]);
    });

    test("should resolve environment variables", async () => {
      // Set environment variable
      process.env.TEST_OPENAI_KEY = "sk-env-test-key";

      const config: LLMConfig = {
        providers: {
          openai: {
            provider: "openai",
            apiKey: "${TEST_OPENAI_KEY}",
          },
        },
        defaultProvider: "openai",
        defaultModel: "gpt-4",
      };

      await manager.initialize(config);

      const provider = manager.getProvider("openai");
      expect(provider).toBeDefined();

      // Clean up
      delete process.env.TEST_OPENAI_KEY;
    });

    test("should throw error for missing required env var", async () => {
      const config: LLMConfig = {
        providers: {
          openai: {
            provider: "openai",
            apiKey: "${MISSING_VAR_12345}",
          },
        },
        defaultProvider: "openai",
        defaultModel: "gpt-4",
      };

      await expect(manager.initialize(config)).rejects.toThrow();
    });
  });

  describe("getProvider", () => {
    test("should return undefined for non-existent provider", () => {
      const provider = manager.getProvider("non-existent");
      expect(provider).toBeUndefined();
    });

    test("should return provider after initialization", async () => {
      const config: LLMConfig = {
        providers: {
          openai: {
            provider: "openai",
            apiKey: "sk-test",
            models: ["gpt-4"],
          },
        },
        defaultProvider: "openai",
        defaultModel: "gpt-4",
      };

      await manager.initialize(config);

      const provider = manager.getProvider("openai");
      expect(provider).toBeDefined();
      expect(provider?.id).toBe("openai");
      expect(provider?.models).toContain("gpt-4");
    });
  });

  describe("listProviders", () => {
    test("should return empty array before initialization", () => {
      const providers = manager.listProviders();
      expect(providers).toEqual([]);
    });

    test("should return all providers after initialization", async () => {
      const config: LLMConfig = {
        providers: {
          openai: { provider: "openai", apiKey: "sk-openai" },
          anthropic: { provider: "anthropic", apiKey: "sk-ant" },
          google: { provider: "google", apiKey: "sk-google" },
        },
        defaultProvider: "openai",
        defaultModel: "gpt-4",
      };

      await manager.initialize(config);

      const providers = manager.listProviders();
      expect(providers).toHaveLength(3);
    });
  });

  describe("resolveEnvVar", () => {
    test("should resolve simple environment variable", async () => {
      process.env.TEST_VAR = "test-value";
      const result = await manager.resolveEnvVar("${TEST_VAR}");
      expect(result).toBe("test-value");
      delete process.env.TEST_VAR;
    });

    test("should return original string if no env var pattern", async () => {
      const result = await manager.resolveEnvVar("plain-string");
      expect(result).toBe("plain-string");
    });

    test("should handle nested braces", async () => {
      process.env.OUTER_INNER = "nested-value";
      const result = await manager.resolveEnvVar("${OUTER_INNER}");
      expect(result).toBe("nested-value");
      delete process.env.OUTER_INNER;
    });

    test("should throw error for missing environment variable", async () => {
      await expect(
        manager.resolveEnvVar("${DEFINITELY_NOT_A_REAL_VAR_123}")
      ).rejects.toThrow();
    });

    test("should handle mixed content with env var", async () => {
      process.env.API_KEY = "secret-key";
      const result = await manager.resolveEnvVar("Bearer ${API_KEY}");
      expect(result).toBe("Bearer secret-key");
      delete process.env.API_KEY;
    });
  });
});
