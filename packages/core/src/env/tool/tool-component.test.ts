import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { z } from "zod";
import { ToolComponent } from "./tool-component";
import type { Tool, ToolResult, ToolExecuteRequest, ToolContext } from "./types";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import type { Environment } from "../interface";

// Mock Environment
const createMockEnv = (configComponent?: ConfigComponent) => ({
  name: "mock-env",
  version: "1.0.0",
  getConfig: () => ({ name: "mock-env", version: "1.0.0", enabled: true, env: null as any }),
  registerComponent: () => {},
  unregisterComponent: () => {},
  getComponent: (name: string) => name === "config" ? configComponent : undefined,
  hasComponent: (name: string) => name === "config" && !!configComponent,
  listComponents: () => [],
  handle_query: async () => "",
  handle_action: async () => ({ success: true, output: "" }),
  subscribe: () => () => {},
  subscribeTo: () => () => {},
  subscribeAll: () => () => {},
  pushEnvEvent: () => {},
  logger: vi.fn(),
  trace: vi.fn(),
});

describe("ToolComponent", () => {
  let component: ToolComponent;
  let mockEnv: ReturnType<typeof createMockEnv>;
  let configComponent: ConfigComponent;

  // Helper to create a mock tool
  const createMockTool = (
    name: string,
    executeFn?: (args: any, ctx: ToolContext) => Promise<ToolResult>
  ): Tool => ({
    name,
    description: `Description for ${name}`,
    parameters: z.object({
      input: z.string().describe("Test input"),
    }),
    execute: executeFn || (async () => ({
      success: true,
      output: "ok",
      metadata: { execution_time_ms: 0 },
    })),
  });

  beforeEach(() => {
    component = new ToolComponent();
    configComponent = new ConfigComponent();
    mockEnv = createMockEnv(configComponent);
  });

  describe("Component lifecycle", () => {
    test("should have correct name and version", () => {
      expect(component.name).toBe("tool");
      expect(component.version).toBe("1.0.0");
    });

    test("should start with created status", () => {
      expect(component.getStatus()).toBe("created");
    });

    test("should initialize with tools", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });
      expect(component.getStatus()).toBe("running");
    });
  });

  describe("register", () => {
    test("should register a tool", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });
      const tool = createMockTool("test-tool");

      component.register(tool, "built-in");

      expect(component.hasTool("test-tool")).toBe(true);
      expect(component.getTool("test-tool")?.name).toBe("test-tool");
    });

    test("should register multiple tools", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });
      const tool1 = createMockTool("tool1");
      const tool2 = createMockTool("tool2");

      component.registerMany([tool1, tool2], "built-in");

      expect(component.getToolCount()).toBe(2);
    });

    test("should overwrite existing tool", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });
      const tool1 = createMockTool("test-tool");
      const tool2 = createMockTool("test-tool");

      component.register(tool1, "built-in");
      component.register(tool2, "dynamic");

      expect(component.getTool("test-tool")?.name).toBe("test-tool");
    });
  });

  describe("unregister", () => {
    test("should unregister a tool", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });
      const tool = createMockTool("test-tool");
      component.register(tool, "built-in");

      expect(component.unregister("test-tool")).toBe(true);
      expect(component.hasTool("test-tool")).toBe(false);
    });

    test("should return false when unregistering non-existent tool", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });

      expect(component.unregister("non-existent")).toBe(false);
    });
  });

  describe("execute", () => {
    test("should execute a tool", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });
      const tool = createMockTool("test-tool");
      component.register(tool, "built-in");

      const request: ToolExecuteRequest = {
        name: "test-tool",
        args: { input: "hello", reason: "test" },
        context: {},
      };

      const result = await component.execute(request);

      expect(result.success).toBe(true);
      expect(result.output).toBe("ok");
    });

    test("should return error for non-existent tool", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });

      const request: ToolExecuteRequest = {
        name: "non-existent",
        args: {},
        context: {},
      };

      const result = await component.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    test("should validate arguments before execution", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });
      const tool = createMockTool("test-tool");
      component.register(tool, "built-in");

      const request: ToolExecuteRequest = {
        name: "test-tool",
        args: { input: 123, reason: "test" }, // Should be string
        context: {},
      };

      const result = await component.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Invalid arguments");
    });

    test("should pass context to tool", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });
      let receivedCtx: ToolContext | undefined;

      const tool = createMockTool("test-tool", async (_, ctx) => {
        receivedCtx = ctx;
        return { success: true, output: "ok" };
      });
      component.register(tool, "built-in");

      const request: ToolExecuteRequest = {
        name: "test-tool",
        args: { input: "test", reason: "test" },
        context: { workdir: "/tmp", session_id: "test-session" },
      };

      await component.execute(request);

      expect(receivedCtx?.workdir).toBe("/tmp");
      expect(receivedCtx?.session_id).toBe("test-session");
    });

    test("should handle tool execution errors", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });
      const tool: Tool = {
        name: "error-tool",
        description: "Tool that throws error",
        parameters: z.object({}),
        execute: async () => {
          throw new Error("Execution failed");
        },
      };
      component.register(tool, "built-in");

      const request: ToolExecuteRequest = {
        name: "error-tool",
        args: { reason: "test" },
        context: {},
      };

      const result = await component.execute(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain("Execution failed");
    });
  });

  describe("listTools", () => {
    test("should list all registered tools", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });
      component.register(createMockTool("tool1"), "built-in");
      component.register(createMockTool("tool2"), "built-in");

      const tools = component.listTools();

      expect(tools).toHaveLength(2);
    });

    test("should filter tools by category", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });
      const tool1 = createMockTool("tool1");
      tool1.metadata = { category: "system" };
      const tool2 = createMockTool("tool2");
      tool2.metadata = { category: "file" };
      component.register(tool1, "built-in");
      component.register(tool2, "built-in");

      const tools = component.listTools({ category: "system" });

      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("tool1");
    });
  });

  describe("hooks", () => {
    test("should call before.execute hooks", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });
      let hookCalled = false;
      
      // 使用 globalHookManager 注册 hook（ToolComponent.execute() 调用 globalHookManager）
      const { globalHookManager } = await import("../hook/global-hook-manager");
      globalHookManager.register("tool:before.execute", {
        name: "test-before-hook",
        priority: 0,
        execute: async (ctx) => {
          hookCalled = true;
        },
      });

      const tool = createMockTool("test-tool");
      component.register(tool, "built-in");

      await component.execute({
        name: "test-tool",
        args: { input: "test", reason: "test" },
        context: {},
      });

      expect(hookCalled).toBe(true);
      
      // 清理
      globalHookManager.unregister("tool:before.execute", "test-before-hook");
    });

    test("should call after.execute hooks", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });
      let hookCalled = false;
      
      // 使用 globalHookManager 注册 hook
      const { globalHookManager } = await import("../hook/global-hook-manager");
      globalHookManager.register("tool:after.execute", {
        name: "test-after-hook",
        priority: 0,
        execute: async (ctx) => {
          hookCalled = true;
        },
      });

      const tool = createMockTool("test-tool");
      component.register(tool, "built-in");

      await component.execute({
        name: "test-tool",
        args: { input: "test", reason: "test" },
        context: {},
      });

      expect(hookCalled).toBe(true);
      
      // 清理
      globalHookManager.unregister("tool:after.execute", "test-after-hook");
    });

    test("should skip hooks when skipHooks is true", async () => {
      await component.init({ name: "tool", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent, config: { builtInTools: { enabled: false } } } });
      let hookCalled = false;
      
      // 使用 globalHookManager 注册 hook
      const { globalHookManager } = await import("../hook/global-hook-manager");
      globalHookManager.register("tool:before.execute", {
        name: "test-before-hook",
        priority: 0,
        execute: async (ctx) => {
          hookCalled = true;
        },
      });

      const tool = createMockTool("test-tool");
      component.register(tool, "built-in");

      await component.execute({
        name: "test-tool",
        args: { input: "test", reason: "test" },
        context: {},
        skipHooks: true,
      });

      expect(hookCalled).toBe(false);
      
      // 清理
      globalHookManager.unregister("tool:before.execute", "test-before-hook");
    });
  });
});

// ============================================================================
// ToolComponent Config Loading Tests (TDD)
// ============================================================================

describe("ToolComponent Config Loading", () => {
  let component: ToolComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let tempDir: string;

  beforeEach(() => {
    component = new ToolComponent();
    configComponent = new ConfigComponent();
    
    // Create temp directory for config files
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "tool-config-test-"));
    
    // Set XDG_DATA_HOME to temp directory so ConfigComponent can find config files
    configComponent.setXdgDataHome(tempDir);
    
    // Mock environment
    mockEnv = {
      name: "test-env",
      version: "1.0.0",
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
    // Clean up environment variables
    delete process.env.TOOL_EXECUTION_TIMEOUT;
    delete process.env.TOOL_EXECUTION_TIMEOUT;
    // Clean up temp directory
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  describe("ToolComponentOptions", () => {
    test("should accept configComponent only", async () => {
      await component.init({
        name: "tool",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });
      expect(component.getStatus()).toBe("running");
    });

    test("should accept configPath option", async () => {
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        tool: {
          execution: {
            timeout: 30000
          }
        }
      }), "utf-8");

      await component.init({
        name: "tool",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent, configPath: "config.jsonc" }
      });
      expect(component.getStatus()).toBe("running");
    });

    test("should accept envPrefix option", async () => {
      process.env.TOOL_EXECUTION_TIMEOUT = "45000";
      
      await component.init({
        name: "tool",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent, envPrefix: "TOOL" }
      });
      expect(component.getStatus()).toBe("running");
      
      delete process.env.TOOL_EXECUTION_TIMEOUT;
    });

    test("should accept config option with direct object", async () => {
      await component.init({
        name: "tool",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          config: {
            execution: {
              timeout: 15000
            }
          }
        }
      });
      expect(component.getStatus()).toBe("running");
    });
  });

  describe("config priority: Object > Env > File", () => {
    test("should Object config override Env config", async () => {
      // Set environment variable
      process.env.TOOL_EXECUTION_TIMEOUT = "50000";
      
      // Create file config
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        tool: { execution: { timeout: 100000 } }
      }), "utf-8");

      await component.init({
        name: "tool",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          configPath: "config.jsonc",
          envPrefix: "TOOL",
          config: { execution: { timeout: 25000 } }  // Object has highest priority
        }
      });
      
      // Object config should have highest priority
      expect(configComponent.get("tool.execution.timeout")).toBe(25000);
      
      delete process.env.TOOL_EXECUTION_TIMEOUT;
    });

    test("should Env config override File config", async () => {
      // Set environment variable
      process.env.TOOL_EXECUTION_TIMEOUT = "50000";
      
      // Create file config
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        tool: { execution: { timeout: 100000 } }
      }), "utf-8");

      await component.init({
        name: "tool",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          configPath: "config.jsonc",
          envPrefix: "TOOL"
        }
      });
      
      // Env should override file
      expect(configComponent.get("tool.execution.timeout")).toBe("50000");
    });

    test("should File config be loaded when present", async () => {
      fsSync.writeFileSync(path.join(tempDir, "config.jsonc"), JSON.stringify({
        tool: { 
          execution: { 
            timeout: 100000,
            maxConcurrency: 8 
          }
        }
      }), "utf-8");

      await component.init({
        name: "tool",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { 
          configComponent, 
          configPath: "config.jsonc"
        }
      });
      
      expect(configComponent.get("tool.execution.timeout")).toBe(100000);
      expect(configComponent.get("tool.execution.maxConcurrency")).toBe(8);
    });

    test("should use default values when no config provided", async () => {
      await component.init({
        name: "tool",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });
      
      // Default values should be set in ConfigComponent (新机制会设置默认值)
      expect(configComponent.get("tool.execution.timeout")).toBe(30000);
    });
  });

  describe("config hot reload", () => {
    test("should register config watcher for hot reload", async () => {
      const watcherFn = vi.fn();
      vi.spyOn(configComponent, "watch").mockReturnValue(watcherFn);
      
      await component.init({
        name: "tool",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent }
      });
      
      expect(configComponent.watch).toHaveBeenCalledWith("tool.*", expect.any(Function));
    });
  });
});
