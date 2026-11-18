import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { LLMComponent } from "./llm";
import { ConfigComponent } from "../../config/config-component";
import type { Environment } from "../interface";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

describe("LLMComponent Config Loading", () => {
  let component: LLMComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let tempDir: string;

  beforeEach(() => {
    component = new LLMComponent();
    configComponent = new ConfigComponent();
    
    // Create temp directory for config files
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "llm-config-test-"));
    
    // Set XDG_DATA_HOME to temp directory so ConfigComponent can find config files
    configComponent.setXdgDataHome(tempDir);
    
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
    vi.restoreAllMocks();
    // Clean up temp directory
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  describe("LLMComponentOptions", () => {
    test("should accept configComponent only", async () => {
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });
      expect(component.getStatus()).toBe("running");
    });

    test("should accept configPath option", async () => {
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        llm: {
          defaultModel: "gpt-4o"
        }
      }), "utf-8");

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent, configPath: "config.jsonc" }
      });
      expect(component.getStatus()).toBe("running");
    });

    test("should accept envPrefix option", async () => {
      process.env.LLM_DEFAULT_MODEL = "claude-3";
      
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent, envPrefix: "LLM" }
      });
      expect(component.getStatus()).toBe("running");
      
      delete process.env.LLM_DEFAULT_MODEL;
    });

    test("should accept config option with direct object", async () => {
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          config: {
            defaultModel: "gpt-4o",
            temperature: 0.5
          }
        }
      });
      expect(component.getStatus()).toBe("running");
    });
  });

  describe("config priority: Object > Env > File", () => {
    test("should Object config override Env config", async () => {
      // Set environment variable (注意: EnvSource 会将 llm.defaultModel 转换为 LLM_DEFAULT_MODEL — Bug #2186 Bug 1 修复后无双 LLM 前缀)
      process.env.LLM_DEFAULT_MODEL = "env-model";

      // Create file config (使用相对路径，XDG_DATA_HOME 已经设置为 tempDir)
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        llm: { defaultModel: "file-model" }
      }), "utf-8");

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: {
          configComponent,
          configPath: "config.jsonc",  // 相对路径，相对于 XDG_DATA_HOME
          envPrefix: "LLM",
          config: { defaultModel: "object-model" }
        }
      });

      // Object config should have highest priority
      expect(configComponent.get("llm.defaultModel")).toBe("object-model");

      delete process.env.LLM_DEFAULT_MODEL;
    });

    test("should Env config override File config", async () => {
      // Set environment variable (Bug #2186 Bug 1 修复后：LLM_TEMPERATURE 而不是 LLM_LLM_TEMPERATURE)
      process.env.LLM_TEMPERATURE = "0.9";

      // Create file config
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        llm: {
          defaultModel: "file-model",
          temperature: 0.1
        }
      }), "utf-8");

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: {
          configComponent,
          configPath: "config.jsonc",
          envPrefix: "LLM"
        }
      });

      // Env should override file
      expect(configComponent.get("llm.temperature")).toBe("0.9");
      // File value should still exist for non-overridden keys
      expect(configComponent.get("llm.defaultModel")).toBe("file-model");

      delete process.env.LLM_TEMPERATURE;
    });

    test("should File config be loaded when present", async () => {
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        llm: { 
          defaultModel: "file-model",
          temperature: 0.7 
        }
      }), "utf-8");

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          configPath: "config.jsonc"
        }
      });
      
      expect(configComponent.get("llm.defaultModel")).toBe("file-model");
      expect(configComponent.get("llm.temperature")).toBe(0.7);
    });

    test("should Env config work without File config", async () => {
      process.env.LLM_DEFAULT_MODEL = "env-model";

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: {
          configComponent,
          envPrefix: "LLM"
        }
      });

      expect(configComponent.get("llm.defaultModel")).toBe("env-model");

      delete process.env.LLM_DEFAULT_MODEL;
    });

    test("should Object config work without Env and File config", async () => {
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          config: { defaultModel: "object-model" }
        }
      });
      
      expect(configComponent.get("llm.defaultModel")).toBe("object-model");
    });

    test("should nested Object config be flattened correctly", async () => {
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          config: { 
            providers: {
              openai: {
                apiKey: "test-key",
                baseURL: "https://api.openai.com"
              }
            }
          }
        }
      });
      
      expect(configComponent.get("llm.providers.openai.apiKey")).toBe("test-key");
      expect(configComponent.get("llm.providers.openai.baseURL")).toBe("https://api.openai.com");
    });
  });

  describe("configPath optional", () => {
    test("should not throw error when configPath file does not exist", async () => {
      const nonExistentPath = path.join(tempDir, "non-existent.jsonc");
      
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          configPath: nonExistentPath
        }
      });
      
      expect(component.getStatus()).toBe("running");
    });
  });

  describe("config loading order", () => {
    test("should load File first, then Env, then Object", async () => {
      // Set environment variable (Bug #2186 Bug 1 修复后：LLM_MAX_TOKENS 而不是 LLM_LLM_MAX_TOKENS)
      process.env.LLM_MAX_TOKENS = "2000";

      // Create file config
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        llm: {
          defaultModel: "file-model",
          maxTokens: 1000
        }
      }), "utf-8");

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: {
          configComponent,
          configPath: "config.jsonc",
          envPrefix: "LLM",
          config: {
            temperature: 0.9,
            topP: 0.95
          }
        }
      });

      // Object config (highest priority)
      expect(configComponent.get("llm.temperature")).toBe(0.9);
      expect(configComponent.get("llm.topP")).toBe(0.95);

      // Env config (medium priority) - overrides file
      expect(configComponent.get("llm.maxTokens")).toBe("2000");

      // File config (lowest priority) - base values
      expect(configComponent.get("llm.defaultModel")).toBe("file-model");

      delete process.env.LLM_MAX_TOKENS;
    });
  });

  describe("nested config - providers", () => {
    test("should load nested providers config from File", async () => {
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        llm: {
          providers: {
            openai: {
              apiKey: "sk-test-openai",
              baseURL: "https://api.openai.com/v1"
            },
            anthropic: {
              apiKey: "sk-ant-test"
            }
          }
        }
      }), "utf-8");

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          configPath: "config.jsonc"
        }
      });
      
      expect(configComponent.get("llm.providers.openai.apiKey")).toBe("sk-test-openai");
      expect(configComponent.get("llm.providers.openai.baseURL")).toBe("https://api.openai.com/v1");
      expect(configComponent.get("llm.providers.anthropic.apiKey")).toBe("sk-ant-test");
    });

    test("should load nested providers config from Object", async () => {
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          config: {
            providers: {
              openai: {
                apiKey: "object-openai-key",
                baseURL: "https://custom.openai.com/v1"
              }
            }
          }
        }
      });
      
      expect(configComponent.get("llm.providers.openai.apiKey")).toBe("object-openai-key");
      expect(configComponent.get("llm.providers.openai.baseURL")).toBe("https://custom.openai.com/v1");
    });

    test("should load nested providers from config object (flat key)", async () => {
      // 直接设置嵌套路径（扁平格式）
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          config: {
            "providers.openai.apiKey": "flat-nested-key",
            "providers.openai.baseURL": "https://flat.example.com"
          }
        }
      });
      
      expect(configComponent.get("llm.providers.openai.apiKey")).toBe("flat-nested-key");
      expect(configComponent.get("llm.providers.openai.baseURL")).toBe("https://flat.example.com");
    });
  });

  describe("camelCase to snake_case conversion", () => {
    test("should convert camelCase keys to SNAKE_CASE env vars", async () => {
      // defaultModel -> DEFAULT_MODEL
      // topP -> TOP_P
      // Bug #2186 Bug 1 修复后：单层 LLM 前缀（LLM_DEFAULT_MODEL / LLM_TOP_P），不再是 LLM_LLM_DEFAULT_MODEL / LLM_LLM_TOP_P
      process.env.LLM_DEFAULT_MODEL = "claude-model";
      process.env.LLM_TOP_P = "0.8";

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: {
          configComponent,
          envPrefix: "LLM"
        }
      });

      expect(configComponent.get("llm.defaultModel")).toBe("claude-model");
      expect(configComponent.get("llm.topP")).toBe("0.8");

      delete process.env.LLM_DEFAULT_MODEL;
      delete process.env.LLM_TOP_P;
    });

    test("should handle custom envPrefix", async () => {
      // 自定义前缀（注意：MY_APP_ 会变成 MY_APP_LLM_DEFAULT_MODEL）
      process.env.MY_APP_LLM_DEFAULT_MODEL = "custom-model";

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          envPrefix: "MY_APP"
        }
      });
      
      expect(configComponent.get("llm.defaultModel")).toBe("custom-model");
      
      delete process.env.MY_APP_LLM_DEFAULT_MODEL;
    });

    test("should load env vars with underscore prefix", async () => {
      // 测试 LLM_DEFAULT_MODEL 直接映射到 llm.defaultModel（Bug #2186 Bug 1 修复后无须双重 LLM 前缀）
      process.env.LLM_DEFAULT_MODEL = "underscore-model";

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: {
          configComponent,
          envPrefix: "LLM"
        }
      });

      // LLM_DEFAULT_MODEL -> llm.defaultModel (camelCase, single LLM prefix)
      expect(configComponent.get("llm.defaultModel")).toBe("underscore-model");

      delete process.env.LLM_DEFAULT_MODEL;
    });
  });

  describe("edge cases", () => {
    test("should handle missing config file gracefully", async () => {
      // 不创建配置文件，直接使用默认前缀
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: {
          configComponent,
          configPath: "non-existent-config.jsonc"
        }
      });

      expect(component.getStatus()).toBe("running");
    });

    test("should handle empty env vars gracefully", async () => {
      // Bug #2186 Bug 1 修复后：单层 LLM 前缀
      process.env.LLM_DEFAULT_MODEL = "";

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: {
          configComponent,
          envPrefix: "LLM"
        }
      });

      // 空字符串是有效值
      expect(configComponent.get("llm.defaultModel")).toBe("");

      delete process.env.LLM_DEFAULT_MODEL;
    });

    test("should load all basic keys from File", async () => {
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        llm: {
          defaultModel: "gpt-4-turbo",
          defaultProvider: "anthropic",
          temperature: 0.3,
          maxTokens: 8192,
          topP: 0.9,
          stream: true
        }
      }), "utf-8");

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          configPath: "config.jsonc"
        }
      });
      
      expect(configComponent.get("llm.defaultModel")).toBe("gpt-4-turbo");
      expect(configComponent.get("llm.defaultProvider")).toBe("anthropic");
      expect(configComponent.get("llm.temperature")).toBe(0.3);
      expect(configComponent.get("llm.maxTokens")).toBe(8192);
      expect(configComponent.get("llm.topP")).toBe(0.9);
      expect(configComponent.get("llm.stream")).toBe(true);
    });
  });

  /**
   * Bug #2186 Bug 3 RED tests: invalid defaultProvider should fail-fast at init
   *
   * Root cause: LLMComponent accepted any defaultProvider string (including typos
   * like 'volcengine2'). The error only surfaced at actual LLM call time
   * (late, in the json-extract sub-agent path, not at startup).
   *
   * Fix direction: After loading all config, validate that defaultProvider
   * (if provided) matches a known provider (key in llm.providers map).
   * Skip validation when llm.providers is empty (back-compat with minimal configs).
   */
  describe("Bug #2186 Bug 3: defaultProvider validation (fail-fast on unknown provider)", () => {
    test("Bug3 RED: invalid defaultProvider should reject init() when providers configured", async () => {
      // Configure a providers map but defaultProvider points to non-existent provider
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        llm: {
          defaultProvider: "volcengine2",  // typo / unknown
          providers: {
            openai: { provider: "openai", apiKey: "sk-test-openai" },
            deepseek: { provider: "deepseek", apiKey: "sk-test-deepseek" },
          },
        },
      }), "utf-8");

      await expect(
        component.init({
          name: "llm",
          version: "1.0.0",
          enabled: true,
          env: mockEnv,
          options: {
            configComponent,
            configPath: "config.jsonc",
          },
        })
      ).rejects.toThrow(/invalid.*defaultProvider|volcengine2/i);
    });

    test("Bug3 RED: valid defaultProvider (matching provider key) should pass", async () => {
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        llm: {
          defaultProvider: "deepseek",  // matches 'deepseek' in providers map below
          providers: {
            openai: { provider: "openai", apiKey: "sk-test-openai" },
            deepseek: { provider: "deepseek", apiKey: "sk-test-deepseek" },
          },
        },
      }), "utf-8");

      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: {
          configComponent,
          configPath: "config.jsonc",
        },
      });

      expect(component.getStatus()).toBe("running");
      expect(configComponent.get("llm.defaultProvider")).toBe("deepseek");
    });

    test("Bug3 RED: back-compat — no llm.providers config allows any defaultProvider", async () => {
      // No providers configured → back-compat: any defaultProvider accepted
      // (caller is using default provider id that the code resolves elsewhere)
      await component.init({
        name: "llm",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: {
          configComponent,
          config: { defaultProvider: "anything-is-fine-here" },
        },
      });

      expect(component.getStatus()).toBe("running");
      expect(configComponent.get("llm.defaultProvider")).toBe("anything-is-fine-here");
    });

    test("Bug3 RED: env var invalid defaultProvider (with non-empty providers) should reject init()", async () => {
      // Bug 1 fix: LLM_DEFAULT_PROVIDER (single prefix)
      process.env.LLM_DEFAULT_PROVIDER = "volcengine2";
      // Configure a providers map so defaultProvider validation kicks in
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        llm: {
          providers: {
            volcengine: { provider: "volcengine", apiKey: "sk-ve" },
            openai: { provider: "openai", apiKey: "sk-oa" },
          },
        },
      }), "utf-8");

      await expect(
        component.init({
          name: "llm",
          version: "1.0.0",
          enabled: true,
          env: mockEnv,
          options: {
            configComponent,
            configPath: "config.jsonc",
            envPrefix: "LLM",
          },
        })
      ).rejects.toThrow(/invalid.*defaultProvider|volcengine2/i);

      delete process.env.LLM_DEFAULT_PROVIDER;
    });
  });
});
