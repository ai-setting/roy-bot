import { describe, it, expect, beforeEach } from "bun:test";
import { BaseComponent, type ComponentConfig } from "./component";

/**
 * 测试用 Component
 */
class TestComponent extends BaseComponent {
  readonly name = "test-component";
  readonly version = "1.0.0";
  protected initialized = false;
  
  getInitialized(): boolean {
    return this.initialized;
  }
  
  protected async onInit(): Promise<void> {
    this.initialized = true;
  }
}

/**
 * Mock Environment（实现 Environment 接口的最小实现）
 */
const createMockEnv = () => ({
  name: "mock-env",
  version: "1.0.0",
  getConfig: () => ({ name: "mock-env", version: "1.0.0", enabled: true, env: null as any }),
  registerComponent: () => {},
  unregisterComponent: () => {},
  getComponent: () => undefined,
  listComponents: () => [],
  handle_query: async () => "",
  handle_action: async () => ({ success: true, output: "" }),
  subscribe: () => () => {},
  subscribeTo: () => () => {},
  subscribeAll: () => () => {},
  pushEnvEvent: () => {},
});

describe("Component env injection", () => {
  describe("init() env validation", () => {
    it("should init successfully without env (env is optional)", async () => {
      const component = new TestComponent();
      
      // env 是可选的，支持组件独立测试场景
      await component.init({
        name: "test",
        version: "1.0.0",
        enabled: true,
      } as ComponentConfig);
      
      expect(component.getStatus()).toBe("running");
      expect(component.getInitialized()).toBe(true);
    });
  });
  
  describe("init() env injection", () => {
    it("should inject env on successful init", async () => {
      const env = createMockEnv();
      const component = new TestComponent();
      
      await component.init({
        name: "test",
        version: "1.0.0",
        enabled: true,
        env,
      });
      
      // 验证状态变为 running
      expect(component.getStatus()).toBe("running");
      // 验证 env 被正确注入（通过 as any 访问 protected 属性）
      expect((component as any).env).toBe(env);
    });
    
    it("should call onInit after env is set", async () => {
      const env = createMockEnv();
      const component = new TestComponent();
      
      await component.init({
        name: "test",
        version: "1.0.0",
        enabled: true,
        env,
      });
      
      expect(component.getInitialized()).toBe(true);
    });
    
    it("should store env in protected property", async () => {
      const env = createMockEnv();
      const component = new TestComponent();
      
      await component.init({
        name: "test",
        version: "1.0.0",
        enabled: true,
        env,
      });
      
      // 通过 getEnv() 方法访问
      expect(component.getEnv()).toBe(env);
    });
    
    it("should allow getting component from env", async () => {
      const mockEnv = createMockEnv();
      const component = new TestComponent();
      
      await component.init({
        name: "test",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
      });
      
      // 验证可以通过 getEnv().getComponent() 获取其他组件
      expect(component.getEnv().getComponent("non-existent")).toBeUndefined();
    });
  });
});
