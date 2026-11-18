import { describe, it, expect, beforeEach } from "bun:test";
import { BaseEnvironment, type BaseEnvironmentConfig } from "./environment";
import { BaseComponent } from "./component";

// 全局初始化计数器，用于跟踪初始化顺序
let initCounter = 0;

/**
 * 测试用 ConfigComponent
 */
class TestConfigComponent extends BaseComponent {
  readonly name = "config";
  readonly version = "1.0.0";
  protected initOrder = 0;
  
  getInitOrder(): number {
    return this.initOrder;
  }
  
  protected async onInit(): Promise<void> {
    this.initOrder = ++initCounter;
  }
}

/**
 * 测试用 ToolComponent
 */
class TestToolComponent extends BaseComponent {
  readonly name = "tool";
  readonly version = "1.0.0";
  protected initOrder = 0;
  
  getInitOrder(): number {
    return this.initOrder;
  }
  
  protected async onInit(): Promise<void> {
    this.initOrder = ++initCounter;
  }
}

/**
 * 测试用 PromptComponent
 */
class TestPromptComponent extends BaseComponent {
  readonly name = "prompt";
  readonly version = "1.0.0";
  protected initOrder = 0;
  
  getInitOrder(): number {
    return this.initOrder;
  }
  
  protected async onInit(): Promise<void> {
    this.initOrder = ++initCounter;
  }
}

describe("Environment component initialization", () => {
  let env: BaseEnvironment;
  
  beforeEach(() => {
    env = new BaseEnvironment({ name: "test-env", version: "1.0.0" });
  });

  describe("分阶段初始化", () => {
    it("should init ConfigComponent first", async () => {
      const configComp = new TestConfigComponent();
      const toolComp = new TestToolComponent();
      
      // 故意先注册 tool，再注册 config
      env.registerComponent(toolComp);
      env.registerComponent(configComp);
      
      await env.init();
      
      // ConfigComponent 应该先于 ToolComponent 完成初始化
      expect(configComp.getStatus()).toBe("running");
      expect(toolComp.getStatus()).toBe("running");
      expect(configComp.getInitOrder()).toBeLessThan(toolComp.getInitOrder());
    });
    
    it("should pass env to all components", async () => {
      const toolComp = new TestToolComponent();
      env.registerComponent(toolComp);
      
      await env.init();
      
      // 验证 env 被正确注入
      expect((toolComp as any).env).toBe(env);
    });
    
    it("should not re-init already initialized components", async () => {
      const configComp = new TestConfigComponent();
      env.registerComponent(configComp);
      
      // 手动初始化
      await configComp.init({
        name: "config",
        version: "1.0.0",
        enabled: true,
        env,
      });
      
      const firstInitTime = configComp.getInitOrder();
      
      // 调用环境初始化
      await env.init();
      
      // initOrder 不应该改变（因为已经初始化过了）
      expect(configComp.getInitOrder()).toBe(firstInitTime);
    });
    
    it("should init multiple components in correct order", async () => {
      const configComp = new TestConfigComponent();
      const toolComp = new TestToolComponent();
      const promptComp = new TestPromptComponent();
      
      // 以任意顺序注册
      env.registerComponent(promptComp);
      env.registerComponent(toolComp);
      env.registerComponent(configComp);
      
      await env.init();
      
      // 验证初始化顺序
      expect(configComp.getInitOrder()).toBeLessThan(toolComp.getInitOrder());
      expect(configComp.getInitOrder()).toBeLessThan(promptComp.getInitOrder());
      
      // 验证所有组件都正确初始化
      expect(configComp.getStatus()).toBe("running");
      expect(toolComp.getStatus()).toBe("running");
      expect(promptComp.getStatus()).toBe("running");
    });
    
    it("should handle environment without ConfigComponent", async () => {
      const toolComp = new TestToolComponent();
      const promptComp = new TestPromptComponent();
      
      env.registerComponent(toolComp);
      env.registerComponent(promptComp);
      
      await env.init();
      
      // 没有 ConfigComponent 时，其他组件也应该正常初始化
      expect(toolComp.getStatus()).toBe("running");
      expect(promptComp.getStatus()).toBe("running");
    });
    
    it("should set env property on Environment itself", async () => {
      await env.init();
      
      // Environment 自身也应该有 env 属性（自引用）
      expect((env as any).env).toBe(env);
    });
  });
  
  describe("getEnv() access", () => {
    it("should allow components to access env via getEnv()", async () => {
      const toolComp = new TestToolComponent();
      env.registerComponent(toolComp);
      
      await env.init();
      
      // 组件应该能通过 getEnv() 访问 Environment
      expect(toolComp.getEnv()).toBe(env);
    });
    
    it("should allow components to get other components", async () => {
      const configComp = new TestConfigComponent();
      const toolComp = new TestToolComponent();
      
      env.registerComponent(configComp);
      env.registerComponent(toolComp);
      
      await env.init();
      
      // 组件应该能通过 env.getComponent() 获取其他组件
      const retrieved = toolComp.getEnv().getComponent("config");
      expect(retrieved).toBe(configComp);
    });
  });
});
