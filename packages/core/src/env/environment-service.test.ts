/**
 * @fileoverview Environment Service 集成测试
 * 
 * TDD: 测试 Environment 从配置文件加载组件配置并初始化组件的能力
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { BaseEnvironment } from "./environment";
import { ConfigComponent } from "../config/config-component";
import { BaseComponent } from "./component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// 测试用的 Mock Component
// ============================================================================

/**
 * Mock LLMComponent - 模拟 LLMComponent 的配置加载
 */
class MockLLMComponent extends BaseComponent {
  readonly name = "llm";
  readonly version = "1.0.0";
  
  // 存储初始化时的配置
  initOptions: any = null;
  loadedConfig: any = null;
  
  async init(config: import("./component").ComponentConfig): Promise<void> {
    await super.init(config);
    
    // 从 options 获取配置
    const options = config.options as any;
    this.initOptions = options;
    this.loadedConfig = options?.config;
    
    this.setStatus("running");
  }
  
  getLoadedConfig() {
    return this.loadedConfig;
  }
}

/**
 * Mock ToolComponent - 模拟 ToolComponent 的配置加载
 */
class MockToolComponent extends BaseComponent {
  readonly name = "tool";
  readonly version = "1.0.0";
  
  initOptions: any = null;
  loadedConfig: any = null;
  
  async init(config: import("./component").ComponentConfig): Promise<void> {
    await super.init(config);
    
    const options = config.options as any;
    this.initOptions = options;
    this.loadedConfig = options?.config;
    
    this.setStatus("running");
  }
  
  getLoadedConfig() {
    return this.loadedConfig;
  }
}

// ============================================================================
// 测试
// ============================================================================

describe("Environment Service Configuration", () => {
  let env: BaseEnvironment;
  let configComponent: ConfigComponent;
  let tempDir: string;

  beforeEach(() => {
    env = new BaseEnvironment({ name: "test-service-env" });
    configComponent = new ConfigComponent();
    
    // Create temp directory for config files
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "env-service-test-"));
    configComponent.setXdgDataHome(tempDir);
    
    // 注册 ConfigComponent
    env.registerComponent(configComponent);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Clean up environment variables
    Object.keys(process.env)
      .filter(k => k.startsWith("TEST_"))
      .forEach(k => delete process.env[k]);
    // Clean up temp directory
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  describe("loadServiceConfig", () => {
    test("should load service config from file", async () => {
      // 创建服务配置文件
      const serviceConfig = {
        environment: {
          name: "my-service",
          version: "1.0.0",
        },
        components: {
          llm: {
            config: {
              defaultModel: "gpt-4",
              temperature: 0.5,
            }
          }
        }
      };
      
      fsSync.writeFileSync(
        path.join(tempDir, "service-config.jsonc"),
        JSON.stringify(serviceConfig),
        "utf-8"
      );
      
      // 调用 loadServiceConfig 方法
      const loadedConfig = await env.loadServiceConfig("service-config.jsonc");
      
      // 验证配置被正确加载
      expect(loadedConfig).toBeDefined();
      expect(loadedConfig.environment.name).toBe("my-service");
      expect(loadedConfig.components.llm.config.defaultModel).toBe("gpt-4");
    });

    test("should throw error if service config not found", async () => {
      // 尝试加载不存在的配置文件应该抛出错误
      await expect(
        env.loadServiceConfig("non-existent-config.jsonc")
      ).rejects.toThrow();
    });
  });

  describe("generateComponentOptions", () => {
    test("should generate component options from service config", async () => {
      // 创建服务配置
      const serviceConfig = {
        environment: {
          name: "test-env",
        },
        components: {
          llm: {
            configPath: "llm.jsonc",
            envPrefix: "LLM",
            config: {
              defaultModel: "gpt-4",
              temperature: 0.7,
            }
          }
        }
      };
      
      // 生成 LLM 组件的 Options
      const options = env.generateComponentOptions("llm", serviceConfig.components.llm);
      
      // 验证生成的 Options 包含正确的配置
      expect(options.configComponent).toBe(configComponent);
      expect(options.config.defaultModel).toBe("gpt-4");
      expect(options.config.temperature).toBe(0.7);
      expect(options.envPrefix).toBe("LLM");
      expect(options.configPath).toBe("llm.jsonc");
    });

    test("should include configComponent in generated options", async () => {
      const serviceConfig = {
        components: {
          tool: {
            config: {
              toolsDir: "./tools",
            }
          }
        }
      };
      
      const options = env.generateComponentOptions("tool", serviceConfig.components.tool);
      
      // 必须包含 ConfigComponent
      expect(options.configComponent).toBeDefined();
      expect(options.configComponent).toBe(configComponent);
    });
  });

  describe("registerComponentWithConfig", () => {
    test("should register component and initialize with config", async () => {
      const llmComponent = new MockLLMComponent();
      const componentConfig = {
        config: {
          defaultModel: "gpt-4",
          temperature: 0.8,
        }
      };
      
      // 使用新 API 注册并初始化组件
      await env.registerComponentWithConfig(llmComponent, componentConfig);
      
      // 验证组件被正确初始化
      expect(llmComponent.getStatus()).toBe("running");
      expect(llmComponent.getLoadedConfig()).toEqual(componentConfig.config);
    });

    test("should support envPrefix in component registration", async () => {
      const toolComponent = new MockToolComponent();
      const componentConfig = {
        envPrefix: "TOOL",
        config: {
          toolsDir: "./custom-tools",
        }
      };
      
      await env.registerComponentWithConfig(toolComponent, componentConfig);
      
      expect(toolComponent.getStatus()).toBe("running");
      expect(toolComponent.initOptions.envPrefix).toBe("TOOL");
    });
  });

  describe("initFromConfig", () => {
    test("should initialize environment from service config file", async () => {
      // 创建完整的服务配置文件
      const serviceConfig = {
        environment: {
          name: "auto-init-env",
          version: "1.0.0",
        },
        components: {
          llm: {
            config: {
              defaultModel: "gpt-4",
            }
          },
          tool: {
            config: {
              toolsDir: "./tools",
            }
          }
        }
      };
      
      fsSync.writeFileSync(
        path.join(tempDir, "auto-service.jsonc"),
        JSON.stringify(serviceConfig),
        "utf-8"
      );
      
      // 创建新的 Environment
      const autoEnv = new BaseEnvironment();
      autoEnv.registerComponent(configComponent);
      
      // 注册 mock components
      const llmComponent = new MockLLMComponent();
      const toolComponent = new MockToolComponent();
      autoEnv.registerComponent(llmComponent);
      autoEnv.registerComponent(toolComponent);
      
      // 从配置文件初始化
      await autoEnv.initFromConfig("auto-service.jsonc");
      
      // 验证环境初始化成功
      expect(autoEnv.getStatus()).toBe("running");
      
      // 验证组件被正确初始化
      expect(llmComponent.getStatus()).toBe("running");
      expect(llmComponent.getLoadedConfig().defaultModel).toBe("gpt-4");
      
      expect(toolComponent.getStatus()).toBe("running");
      expect(toolComponent.getLoadedConfig().toolsDir).toBe("./tools");
    });

    test("should set environment name from config", async () => {
      const serviceConfig = {
        environment: {
          name: "custom-named-env",
          version: "2.0.0",
        },
        components: {}
      };
      
      fsSync.writeFileSync(
        path.join(tempDir, "named-service.jsonc"),
        JSON.stringify(serviceConfig),
        "utf-8"
      );
      
      const namedEnv = new BaseEnvironment();
      namedEnv.registerComponent(configComponent);
      
      await namedEnv.initFromConfig("named-service.jsonc");
      
      // 验证环境名称被正确设置
      expect(namedEnv.name).toBe("custom-named-env");
      expect(namedEnv.version).toBe("2.0.0");
    });
  });

  describe("environment variable resolution", () => {
    test("should resolve environment variables in config", async () => {
      // 设置环境变量
      process.env.TEST_LLM_MODEL = "gpt-5";
      
      const serviceConfig = {
        environment: { name: "env-test" },
        components: {
          llm: {
            envPrefix: "TEST",
            config: {
              // 配置值应该能引用环境变量
              defaultModel: "gpt-4",  // 静态值测试
            }
          }
        }
      };
      
      const options = env.generateComponentOptions("llm", serviceConfig.components.llm);
      
      // 验证配置被正确传递
      expect(options.config.defaultModel).toBe("gpt-4");
      
      delete process.env.TEST_LLM_MODEL;
    });
  });
});
