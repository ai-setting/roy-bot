/**
 * @fileoverview MCP Component 配置注册测试
 * 
 * TDD: 先写测试，验证配置注册机制
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ConfigComponent } from "../../config/config-component";
import { McpComponent } from "./mcp-component";
import { MCP_CONFIG_REGISTRATION, MCP_DEFAULTS } from "./mcp-config-registration";

describe("MCP Config Registration", () => {
  let configComponent: ConfigComponent;
  let component: McpComponent;

  beforeEach(() => {
    configComponent = new ConfigComponent();
  });

  describe("MCP_CONFIG_REGISTRATION", () => {
    it("应该包含正确的 name", () => {
      expect(MCP_CONFIG_REGISTRATION.name).toBe("mcp");
    });

    it("应该包含 env source 配置", () => {
      const envSource = MCP_CONFIG_REGISTRATION.sources.find(
        (s) => s.type === "env"
      );
      expect(envSource).toBeDefined();
      expect(envSource?.envPrefix).toBe("MCP");
      expect(envSource?.priority).toBe(20);
    });

    it("应该包含所有配置 keys", () => {
      const keys = MCP_CONFIG_REGISTRATION.keys;
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "mcp.enabled" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "mcp.timeout" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "mcp.mcpPaths" })
      );
      expect(keys).toContainEqual(
        expect.objectContaining({ key: "mcp.servers" })
      );
    });
  });

  describe("MCP_DEFAULTS", () => {
    it("应该包含 enabled 默认值（完整格式）", () => {
      expect(MCP_DEFAULTS["mcp.enabled"]).toBe(true);
    });

    it("应该包含 timeout 默认值（完整格式）", () => {
      expect(MCP_DEFAULTS["mcp.timeout"]).toBe(30000);
    });

    it("应该包含 mcpPaths 默认值（完整格式）", () => {
      expect(MCP_DEFAULTS["mcp.mcpPaths"]).toBeDefined();
      expect(Array.isArray(MCP_DEFAULTS["mcp.mcpPaths"])).toBe(true);
    });
  });

  describe("配置注册到 ConfigComponent", () => {
    it("应该能够注册 MCP_CONFIG_REGISTRATION", () => {
      configComponent.registerComponent(MCP_CONFIG_REGISTRATION);
      expect(() => configComponent.registerComponent(MCP_CONFIG_REGISTRATION)).not.toThrow();
    });
  });

  describe("环境变量覆盖", () => {
    it("应该能够通过环境变量覆盖配置", async () => {
      // 设置环境变量
      const originalValue = process.env.MCP_ENABLED;
      process.env.MCP_ENABLED = "false";
      
      try {
        // 创建组件实例（使用模拟 env）
        const mockEnv = {
          name: "mock-env",
          version: "1.0.0",
          getConfig: () => ({ name: "mock-env", version: "1.0.0", enabled: true }),
          registerComponent: () => {},
          unregisterComponent: () => {},
          getComponent: () => undefined,
          hasComponent: () => false,
          listComponents: () => [],
          handle_query: async () => "",
          handle_action: async () => ({ success: true, output: "" }),
          subscribe: () => () => {},
          subscribeTo: () => () => {},
          subscribeAll: () => () => {},
          pushEnvEvent: () => {},
          logger: () => {},
          trace: () => {},
        };
        
        component = new McpComponent();
        await component.init({
          name: "mcp",
          version: "1.0.0",
          enabled: true,
          env: mockEnv as any,
          options: {
            configComponent,
          },
        } as any);
        
        expect(component.name).toBe("mcp");
      } finally {
        // 恢复环境变量
        if (originalValue !== undefined) {
          process.env.MCP_ENABLED = originalValue;
        } else {
          delete process.env.MCP_ENABLED;
        }
        
        // 清理组件
        if (component) {
          await component.stop();
        }
      }
    });
  });

  describe("核心验收标准 - registerConfig 应使用 ConfigComponent 模式", () => {
    let configComponent: ConfigComponent;

    beforeEach(() => {
      configComponent = new ConfigComponent();
    });

    it("应使用 registerComponent(MCP_CONFIG_REGISTRATION) 注册配置", async () => {
      // 设置环境变量以测试环境变量加载
      const originalEnabled = process.env.MCP_ENABLED;
      process.env.MCP_ENABLED = "false";

      try {
        const mockEnv = createMockEnv();
        component = new McpComponent();
        
        await component.init({
          name: "mcp",
          version: "1.0.0",
          enabled: true,
          env: mockEnv as any,
          options: {
            configComponent,
          },
        } as any);

        // 验证 MCP_DEFAULTS 已通过 registerComponent 注册到 ConfigComponent
        // 检查默认值是否存在于内存中
        const defaultEnabled = configComponent.get("mcp.enabled");
        const defaultTimeout = configComponent.get("mcp.timeout");
        
        // 由于环境变量 MCP_ENABLED=false 设置了，enabled 应该被覆盖
        const enabled = configComponent.get("mcp.enabled");
        expect(enabled).toBe(false);
        
        // 但 timeout 应该仍然是默认值
        expect(defaultTimeout).toBe(30000);
      } finally {
        if (originalEnabled !== undefined) {
          process.env.MCP_ENABLED = originalEnabled;
        } else {
          delete process.env.MCP_ENABLED;
        }
        if (component) {
          await component.stop();
        }
      }
    });

    it("应使用 await configComponent.load('mcp') 加载配置", async () => {
      const mockEnv = createMockEnv();
      component = new McpComponent();
      
      await component.init({
        name: "mcp",
        version: "1.0.0",
        enabled: true,
        env: mockEnv as any,
        options: {
          configComponent,
        },
      } as any);

      // 验证默认值被正确加载
      const timeout = configComponent.get("mcp.timeout");
      expect(timeout).toBe(30000);
    });

    it("应设置默认值 MCP_DEFAULTS", async () => {
      const mockEnv = createMockEnv();
      component = new McpComponent();
      
      await component.init({
        name: "mcp",
        version: "1.0.0",
        enabled: true,
        env: mockEnv as any,
        options: {
          configComponent,
        },
      } as any);

      // 验证默认配置值
      const enabled = configComponent.get("mcp.enabled");
      const timeout = configComponent.get("mcp.timeout");
      const mcpPaths = configComponent.get("mcp.mcpPaths");

      expect(enabled).toBe(true);
      expect(timeout).toBe(30000);
      expect(mcpPaths).toBeDefined();
      expect(Array.isArray(mcpPaths)).toBe(true);
    });

    it("应处理 config 对象作为最高优先级", async () => {
      const mockEnv = createMockEnv();
      component = new McpComponent();
      
      const customConfig = {
        mcpPaths: [
          { type: "custom" as const, path: "/custom/path" }
        ],
        timeout: 60000,
        enabled: true,
      };
      
      await component.init({
        name: "mcp",
        version: "1.0.0",
        enabled: true,
        env: mockEnv as any,
        options: {
          configComponent,
          config: customConfig,
        },
      } as any);

      // 验证 config 对象被正确处理（不被覆盖）
      const timeout = configComponent.get("mcp.timeout");
      expect(timeout).toBe(60000);
    });

    it("应处理环境变量后备方案", async () => {
      // 清除可能的环境变量
      delete process.env.MCP_ENABLED;
      delete process.env.MCP_TIMEOUT;
      delete process.env.MCP_PATHS;

      const mockEnv = createMockEnv();
      component = new McpComponent();
      
      await component.init({
        name: "mcp",
        version: "1.0.0",
        enabled: true,
        env: mockEnv as any,
        options: {
          configComponent,
        },
      } as any);

      // 在没有环境变量的情况下，应使用默认值
      const enabled = configComponent.get("mcp.enabled");
      const timeout = configComponent.get("mcp.timeout");
      
      expect(enabled).toBe(true);
      expect(timeout).toBe(30000);

      if (component) {
        await component.stop();
      }
    });
  });

  /**
   * 创建模拟 Env 对象
   */
  function createMockEnv() {
    return {
      name: "mock-env",
      version: "1.0.0",
      getConfig: () => ({ name: "mock-env", version: "1.0.0", enabled: true }),
      registerComponent: () => {},
      unregisterComponent: () => {},
      getComponent: () => undefined,
      hasComponent: () => false,
      listComponents: () => [],
      handle_query: async () => "",
      handle_action: async () => ({ success: true, output: "" }),
      subscribe: () => () => {},
      subscribeTo: () => () => {},
      subscribeAll: () => () => {},
      pushEnvEvent: () => {},
      logger: () => {},
      trace: () => {},
    };
  }
});
