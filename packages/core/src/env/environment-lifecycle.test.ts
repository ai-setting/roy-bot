/**
 * @fileoverview Environment Lifecycle Integration Tests
 * 
 * 测试 Environment 生命周期中组件 start() 方法的正确调用
 * 
 * 背景：依赖 start() 生命周期钩子的组件（如 TaskComponent, MemoryComponent）
 * 需要在 start() 中注册工具到 ToolComponent
 * 
 * 验收标准：
 * 1. env.start() 必须在 env.init() 之后被调用
 * 2. TaskComponent.start() 必须被调用并注册 task tools
 * 3. MemoryComponent.start() 必须被调用并注册 memory tools
 * 4. AgentComponent 能从 ToolComponent 获取到这些工具
 */

import { describe, it, expect, vi, beforeEach, afterEach, test } from "vitest";
import { BaseEnvironment } from "./environment";
import { BaseComponent } from "./component";
import type { Tool } from "../tool/types";

// ============================================================================
// Mock ToolComponent
// ============================================================================

interface RegisteredTool {
  name: string;
  description?: string;
  execute: Function;
}

class MockToolComponent extends BaseComponent {
  name = "tool";
  version = "1.0.0";
  
  private tools = new Map<string, RegisteredTool>();
  
  // Track calls for verification
  calls = {
    init: 0,
    start: 0,
    stop: 0,
    register: [] as string[],
    unregister: [] as string[],
  };
  
  async onInit(): Promise<void> {
    this.calls.init++;
  }
  
  async onStart(): Promise<void> {
    this.calls.start++;
  }
  
  async onStop(): Promise<void> {
    this.calls.stop++;
  }
  
  register(tool: Tool): void {
    this.tools.set(tool.name, tool as RegisteredTool);
    this.calls.register.push(tool.name);
  }
  
  unregister(name: string): void {
    this.tools.delete(name);
    this.calls.unregister.push(name);
  }
  
  getTool(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }
  
  listTools(): RegisteredTool[] {
    return Array.from(this.tools.values());
  }
  
  getToolCount(): number {
    return this.tools.size;
  }
}

// ============================================================================
// Mock TaskComponent (依赖 start() 注册工具)
// ============================================================================

class MockTaskComponent extends BaseComponent {
  name = "task";
  version = "1.0.0";
  
  private toolComponent?: MockToolComponent;
  
  // Track lifecycle
  calls = {
    init: 0,
    start: 0,
    stop: 0,
    registerTools: 0,
  };
  
  // Expected tools that should be registered
  static readonly EXPECTED_TOOLS = [
    "task_create",
    "task_get", 
    "task_list",
    "task_update",
    "task_delete",
    "task_complete",
    "operation_create",
    "operation_get",
    "operation_list",
    "operation_update",
    "operation_delete",
    "task_delegate",
    "task_stop",
  ];
  
  async onInit(): Promise<void> {
    this.calls.init++;
  }
  
  async onStart(): Promise<void> {
    this.calls.start++;
    
    // 获取 ToolComponent（必须在 start() 中获取，因为此时其他组件已初始化）
    if (this.env) {
      this.toolComponent = this.env.getComponent("tool") as unknown as MockToolComponent;
    }
    
    if (this.toolComponent) {
      await this.registerTools();
    }
  }
  
  async onStop(): Promise<void> {
    this.calls.stop++;
  }
  
  private async registerTools(): Promise<void> {
    if (!this.toolComponent) return;
    
    this.calls.registerTools++;
    
    // 注册所有 task tools
    for (const toolName of MockTaskComponent.EXPECTED_TOOLS) {
      this.toolComponent.register({
        name: toolName,
        description: `Task tool: ${toolName}`,
        execute: vi.fn(),
      });
    }
  }
}

// ============================================================================
// Mock MemoryComponent (依赖 start() 注册工具)
// ============================================================================

class MockMemoryComponent extends BaseComponent {
  name = "memory";
  version = "1.0.0";
  
  private toolComponent?: MockToolComponent;
  
  // Track lifecycle
  calls = {
    init: 0,
    start: 0,
    stop: 0,
    registerTools: 0,
  };
  
  // Expected tools that should be registered
  static readonly EXPECTED_TOOLS = [
    "record_memory",
    "recall_memory",
  ];
  
  async onInit(): Promise<void> {
    this.calls.init++;
  }
  
  async onStart(): Promise<void> {
    this.calls.start++;
    
    // 获取 ToolComponent
    if (this.env) {
      this.toolComponent = this.env.getComponent("tool") as unknown as MockToolComponent;
    }
    
    if (this.toolComponent) {
      await this.registerTools();
    }
  }
  
  async onStop(): Promise<void> {
    this.calls.stop++;
  }
  
  private async registerTools(): Promise<void> {
    if (!this.toolComponent) return;
    
    this.calls.registerTools++;
    
    // 注册所有 memory tools
    for (const toolName of MockMemoryComponent.EXPECTED_TOOLS) {
      this.toolComponent.register({
        name: toolName,
        description: `Memory tool: ${toolName}`,
        execute: vi.fn(),
      });
    }
  }
}

// ============================================================================
// Mock AgentComponent (用于验证工具可用性)
// ============================================================================

class MockAgentComponent extends BaseComponent {
  name = "agent";
  version = "1.0.0";
  
  private toolComponent?: MockToolComponent;
  private llmComponent?: any;
  
  async onInit(): Promise<void> {
    // AgentComponent 的初始化逻辑
  }
  
  refreshDependencies(): void {
    if (this.env) {
      this.toolComponent = this.env.getComponent("tool") as unknown as MockToolComponent;
      this.llmComponent = this.env.getComponent("llm");
    }
  }
  
  getAvailableTools(): Tool[] {
    if (!this.toolComponent) return [];
    return this.toolComponent.listTools() as unknown as Tool[];
  }
}

// ============================================================================
// Mock ConfigComponent
// ============================================================================

class MockConfigComponent extends BaseComponent {
  name = "config";
  version = "1.0.0";
  
  async onInit(): Promise<void> {
    // ConfigComponent 初始化
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("Environment Lifecycle - Component start() invocation", () => {
  
  describe("Complete lifecycle: init() + start()", () => {
    
    it("should call start() to register tools from TaskComponent and MemoryComponent", async () => {
      // 创建环境
      const env = new BaseEnvironment({ name: "test-env" });
      
      // 创建并注册 mock components
      const toolComponent = new MockToolComponent();
      const taskComponent = new MockTaskComponent();
      const memoryComponent = new MockMemoryComponent();
      const agentComponent = new MockAgentComponent();
      
      env.registerComponent(toolComponent);
      env.registerComponent(taskComponent);
      env.registerComponent(memoryComponent);
      env.registerComponent(agentComponent);
      
      // 调用完整的生命周期：init() + start()
      await env.init();
      await env.start();
      
      // 验证：init() 和 start() 都被调用
      expect(taskComponent.calls.init).toBe(1);
      expect(taskComponent.calls.start).toBe(1);
      expect(memoryComponent.calls.init).toBe(1);
      expect(memoryComponent.calls.start).toBe(1);
      
      // 验证：工具被注册
      expect(taskComponent.calls.registerTools).toBe(1);
      expect(memoryComponent.calls.registerTools).toBe(1);
      
      // 验证：ToolComponent 收到注册
      const expectedToolCount = MockTaskComponent.EXPECTED_TOOLS.length + MockMemoryComponent.EXPECTED_TOOLS.length;
      expect(toolComponent.calls.register).toHaveLength(expectedToolCount);
      
      // 验证：AgentComponent 能获取到工具
      agentComponent.refreshDependencies();
      const availableTools = agentComponent.getAvailableTools();
      
      expect(availableTools.length).toBe(expectedToolCount);
      
      // 验证：包含所有 task tools
      for (const toolName of MockTaskComponent.EXPECTED_TOOLS) {
        expect(availableTools.find(t => t.name === toolName)).toBeDefined();
      }
      
      // 验证：包含所有 memory tools
      for (const toolName of MockMemoryComponent.EXPECTED_TOOLS) {
        expect(availableTools.find(t => t.name === toolName)).toBeDefined();
      }
      
      // 清理
      await env.stop();
    });
    
  });
  
  describe("Component initialization order", () => {
    
    it("should initialize ConfigComponent first, then other components", async () => {
      const env = new BaseEnvironment({ name: "test-env" });
      
      const initOrder: string[] = [];
      
      class TrackedComponent extends BaseComponent {
        name: string;
        
        constructor(name: string) {
          super();
          this.name = name;
        }
        
        async onInit(): Promise<void> {
          initOrder.push(`init:${this.name}`);
        }
        
        async onStart(): Promise<void> {
          initOrder.push(`start:${this.name}`);
        }
      }
      
      // 注册顺序不重要，重要的是 ConfigComponent 应该在 init 阶段最先初始化
      env.registerComponent(new TrackedComponent("tool"));
      env.registerComponent(new TrackedComponent("agent"));
      env.registerComponent(new TrackedComponent("config"));
      env.registerComponent(new TrackedComponent("task"));
      env.registerComponent(new TrackedComponent("memory"));
      
      await env.init();
      await env.start();
      
      // 验证：init 阶段 ConfigComponent 最先
      expect(initOrder[0]).toBe("init:config");
      
      // 验证：start 阶段顺序按注册顺序
      const startOrder = initOrder.filter(s => s.startsWith("start:"));
      // ConfigComponent 应该在 start 阶段也有记录
      expect(startOrder.length).toBeGreaterThan(0);
      
      await env.stop();
    });
    
  });
  
  describe("Tool availability after complete lifecycle", () => {
    
    it("should provide complete tool set to AgentComponent after init() + start()", async () => {
      // 模拟真实的 Environment 创建流程
      const env = new BaseEnvironment({ name: "test-env" });
      
      // 创建 components
      const configComponent = new MockConfigComponent();
      const toolComponent = new MockToolComponent();
      const taskComponent = new MockTaskComponent();
      const memoryComponent = new MockMemoryComponent();
      const agentComponent = new MockAgentComponent();
      
      // 注册
      env.registerComponent(configComponent);
      env.registerComponent(toolComponent);
      env.registerComponent(taskComponent);
      env.registerComponent(memoryComponent);
      env.registerComponent(agentComponent);
      
      // 完整的生命周期
      await env.init();
      await env.start();
      
      // 刷新 AgentComponent 的依赖
      agentComponent.refreshDependencies();
      
      // 获取可用工具
      const availableTools = agentComponent.getAvailableTools();
      
      // 验证：工具总数
      const expectedCount = MockTaskComponent.EXPECTED_TOOLS.length + MockMemoryComponent.EXPECTED_TOOLS.length;
      expect(availableTools.length).toBe(expectedCount);
      
      // 验证：task tools 都存在
      for (const toolName of MockTaskComponent.EXPECTED_TOOLS) {
        expect(availableTools.some(t => t.name === toolName)).toBe(true);
      }
      
      // 验证：memory tools 都存在
      for (const toolName of MockMemoryComponent.EXPECTED_TOOLS) {
        expect(availableTools.some(t => t.name === toolName)).toBe(true);
      }
      
      // 清理
      await env.stop();
    });
    
  });
  
});

// ============================================================================
// Regression Tests: Prevent future regressions
// ============================================================================

describe("Environment lifecycle regression prevention", () => {
  
  it("should ensure start() is called for all registered components", async () => {
    const env = new BaseEnvironment({ name: "regression-test" });
    
    const components: BaseComponent[] = [];
    const startCalls: string[] = [];
    
    // 创建 5 个组件
    for (let i = 0; i < 5; i++) {
      class TrackedComp extends BaseComponent {
        name = `component_${i}`;
        
        async onInit(): Promise<void> {
          this.setStatus("running");
        }
        
        async onStart(): Promise<void> {
          startCalls.push(this.name);
        }
      }
      
      const comp = new TrackedComp();
      components.push(comp);
      env.registerComponent(comp);
    }
    
    // 初始化并启动
    await env.init();
    await env.start();
    
    // 验证：所有组件的 start() 都被调用
    expect(startCalls).toHaveLength(5);
    expect(startCalls).toContain("component_0");
    expect(startCalls).toContain("component_1");
    expect(startCalls).toContain("component_2");
    expect(startCalls).toContain("component_3");
    expect(startCalls).toContain("component_4");
    
    await env.stop();
  });
  
  it("should prevent duplicate start() calls", async () => {
    const env = new BaseEnvironment({ name: "duplicate-test" });
    
    let startCount = 0;
    
    class CountingComponent extends BaseComponent {
      name = "counting";
      
      async onInit(): Promise<void> {
        this.setStatus("running");
      }
      
      async onStart(): Promise<void> {
        startCount++;
      }
    }
    
    env.registerComponent(new CountingComponent());
    
    await env.init();
    await env.start();
    await env.start(); // 重复调用
    
    // BaseEnvironment.start() 内部应该有防重复机制
    expect(startCount).toBe(1);
    
    await env.stop();
  });
  
  it("should have env reference available in component's onStart()", async () => {
    const env = new BaseEnvironment({ name: "env-ref-test" });
    
    let envRefInStart: any = null;
    
    class TestComponent extends BaseComponent {
      name = "test";
      
      async onStart(): Promise<void> {
        envRefInStart = this.env;
      }
    }
    
    env.registerComponent(new TestComponent());
    
    await env.init();
    await env.start();
    
    // 验证：onStart() 中可以访问 env
    expect(envRefInStart).toBe(env);
    
    await env.stop();
  });
  
});
