/**
 * @fileoverview PromptComponent Tests
 * 
 * TDD: Write tests first, then implement
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PromptComponent } from "./prompt-component";
import { ConfigComponent } from "../../config/config-component";
import { writeFile, rm, mkdir } from "fs/promises";
import { join } from "path";
import { vi } from "bun:test";
import { globalHookManager } from "../hook/global-hook-manager";

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

// 创建临时目录用于测试
const testDir = join(process.cwd(), "test-prompts-temp");

async function setupTestDir() {
  await mkdir(testDir, { recursive: true });
  await mkdir(join(testDir, "subdir"), { recursive: true });
}

async function cleanupTestDir() {
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {}
}

describe("PromptComponent", () => {
  let component: PromptComponent;
  let mockEnv: ReturnType<typeof createMockEnv>;
  let configComponent: ConfigComponent;

  beforeEach(async () => {
    component = new PromptComponent();
    configComponent = new ConfigComponent();
    mockEnv = createMockEnv(configComponent);
  });

  afterEach(async () => {
    if (component) {
      await component.stop();
    }
  });

  // ============================================================================
  // Component basics
  // ============================================================================
  describe("Component basics", () => {
    test("should have correct name", () => {
      expect(component.name).toBe("prompt");
    });

    test("should have version", () => {
      expect(component.version).toBe("1.0.0");
    });

    test("should start with created status", () => {
      expect(component.getStatus()).toBe("created");
    });
  });

  // ============================================================================
  // init
  // ============================================================================
  describe("init", () => {
    test("should initialize with defaults", async () => {
      await component.init({ name: "prompt", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent } });
      expect(component.getStatus()).toBe("running");
    });

    test("should initialize with config options", async () => {
      await component.init({
        name: "prompt",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: {
          configComponent,
          defaultName: "custom-default",
          variablePrefix: "[[",
          variableSuffix: "]]",
          strictMode: false,
        },
      });
      expect(component.getStatus()).toBe("running");
    });

    test("should load built-in prompts if prompts dir exists", async () => {
      await component.init({ name: "prompt", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent } });
      // 应该加载内置的 default prompt
      expect(component.has("default")).toBe(true);
    });

    test("should throw error if ConfigComponent is missing", async () => {
      const badEnv = createMockEnv(undefined);
      const badComponent = new PromptComponent();
      await expect(
        badComponent.init({ name: "prompt", version: "1.0.0", enabled: true, env: badEnv, options: {} })
      ).rejects.toThrow("ConfigComponent is required");
    });
  });

  // ============================================================================
  // add
  // ============================================================================
  describe("add", () => {
    beforeEach(async () => {
      await component.init({ name: "prompt", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent } });
    });

    test("should add a prompt with name and content", () => {
      component.add("test", "Hello {{name}}!");
      
      expect(component.has("test")).toBe(true);
      expect(component.get("test")).toBe("Hello {{name}}!");
    });

    test("should add multiple prompts", () => {
      component.add("prompt1", "Content 1");
      component.add("prompt2", "Content 2");
      component.add("prompt3", "Content 3");
      
      expect(component.size()).toBeGreaterThanOrEqual(3);
      expect(component.list()).toContain("prompt1");
      expect(component.list()).toContain("prompt2");
      expect(component.list()).toContain("prompt3");
    });

    test("should update existing prompt content", () => {
      component.add("test", "Original");
      component.add("test", "Updated");
      
      expect(component.get("test")).toBe("Updated");
    });
  });

  // ============================================================================
  // get
  // ============================================================================
  describe("get", () => {
    beforeEach(async () => {
      await component.init({ name: "prompt", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent } });
    });

    test("should return undefined for non-existent prompt", () => {
      expect(component.get("non-existent")).toBeUndefined();
    });

    test("should return content for existing prompt", () => {
      component.add("test", "Test content");
      expect(component.get("test")).toBe("Test content");
    });
  });

  // ============================================================================
  // has / delete
  // ============================================================================
  describe("has / delete", () => {
    beforeEach(async () => {
      await component.init({ name: "prompt", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent } });
    });

    test("should return true for existing prompt", () => {
      component.add("test", "Content");
      expect(component.has("test")).toBe(true);
    });

    test("should return false for non-existent prompt", () => {
      expect(component.has("non-existent")).toBe(false);
    });

    test("should delete existing prompt", () => {
      component.add("test", "Content");
      expect(component.delete("test")).toBe(true);
      expect(component.has("test")).toBe(false);
    });

    test("should return false when deleting non-existent prompt", () => {
      expect(component.delete("non-existent")).toBe(false);
    });
  });

  // ============================================================================
  // list / size
  // ============================================================================
  describe("list / size", () => {
    beforeEach(async () => {
      await component.init({ name: "prompt", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent } });
    });

    test("should list all prompt names", () => {
      component.add("a", "Content A");
      component.add("b", "Content B");
      
      const list = component.list();
      expect(list).toContain("a");
      expect(list).toContain("b");
    });

    test("should return correct size", () => {
      const initialSize = component.size();
      component.add("new1", "Content");
      component.add("new2", "Content");
      
      expect(component.size()).toBe(initialSize + 2);
    });

    test("listEntries should include source metadata", () => {
      component.add("inline-one", "Inline content", "inline");
      const entries = component.listEntries();
      const inline = entries.find((entry) => entry.name === "inline-one");
      expect(inline?.source).toBe("inline");
      expect(inline?.content).toBe("Inline content");
    });
  });

  describe("savePrompt persistence", () => {
    let tempPromptDir: string;

    beforeEach(async () => {
      tempPromptDir = join(testDir, "user-prompts");
      await mkdir(tempPromptDir, { recursive: true });
      await configComponent.set("prompt.configDir", tempPromptDir);
      await component.init({
        name: "prompt",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent },
      });
    });

    test("savePrompt should write file and reload on new component instance", async () => {
      await component.savePrompt("subagent/explore", "Persisted explore prompt");

      const filePath = join(tempPromptDir, "subagent", "explore.md");
      const { readFile } = await import("fs/promises");
      expect(await readFile(filePath, "utf-8")).toBe("Persisted explore prompt");

      const component2 = new PromptComponent();
      await component2.init({
        name: "prompt",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: { configComponent },
      });

      expect(component2.get("subagent/explore")).toBe("Persisted explore prompt");
      await component2.stop();
    });
  });

  // ============================================================================
  // getPrompt (render)
  // ============================================================================
  describe("getPrompt", () => {
    beforeEach(async () => {
      await component.init({ name: "prompt", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent } });
    });

    test("should get prompt by name", async () => {
      component.add("test", "Hello World");
      const content = await component.getPrompt("test");
      expect(content).toBe("Hello World");
    });

    test("should render variables in prompt", async () => {
      component.add("greeting", "Hello {{name}}!");
      const content = await component.getPrompt("greeting", { name: "Alice" });
      expect(content).toBe("Hello Alice!");
    });

    test("should render multiple variables", async () => {
      component.add("template", "{{greeting}}, {{name}}! Today is {{date}}.");
      const content = await component.getPrompt("template", {
        greeting: "Hello",
        name: "Bob",
        date: "2026-03-27",
      });
      expect(content).toBe("Hello, Bob! Today is 2026-03-27.");
    });

    test("should keep undefined variables as-is", async () => {
      component.add("template", "Hello {{name}}, your email is {{email}}");
      const content = await component.getPrompt("template", { name: "Alice" });
      expect(content).toBe("Hello Alice, your email is {{email}}");
    });

    test("should fallback to default when prompt not found", async () => {
      // 默认的 "default" prompt 已加载，所以会返回 default 的内容
      // 这个测试验证当请求不存在的 prompt 时，会使用 default
      const defaultContent = await component.getPrompt("default");
      const fallbackContent = await component.getPrompt("non-existent");
      
      // 由于 default 已加载，fallback 应该返回 default 的内容
      expect(fallbackContent).toBe(defaultContent);
    });
  });

  // ============================================================================
  // render
  // ============================================================================
  describe("render", () => {
    beforeEach(async () => {
      await component.init({ name: "prompt", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent } });
    });

    test("should render template with variables", async () => {
      const result = await component.render("Hello {{name}}!", { name: "World" });
      expect(result).toBe("Hello World!");
    });

    test("should handle empty variables", async () => {
      const result = await component.render("Hello {{name}}!", {});
      expect(result).toBe("Hello {{name}}!");
    });

    test("should handle custom variable delimiters", async () => {
      await component.init({
        name: "prompt",
        version: "1.0.0",
        enabled: true,
        env: mockEnv,
        options: {
          configComponent,
          variablePrefix: "[[",
          variableSuffix: "]]",
        },
      });
      
      const result = await component.render("Hello [[name]]!", { name: "World" });
      expect(result).toBe("Hello World!");
    });
  });

  // ============================================================================
  // loadFromFile
  // ============================================================================
  describe("loadFromFile", () => {
    beforeEach(async () => {
      await setupTestDir();
      await component.init({ name: "prompt", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent } });
    });

    afterEach(async () => {
      await cleanupTestDir();
    });

    test("should load prompt from file", async () => {
      const filePath = join(testDir, "test.md");
      await writeFile(filePath, "Content from file");
      
      const result = await component.loadFromFile(filePath);
      expect(result).toBe(true);
      expect(component.has("test")).toBe(true);
      expect(component.get("test")).toBe("Content from file");
    });

    test("should use filename as prompt name by default", async () => {
      const filePath = join(testDir, "my-prompt.md");
      await writeFile(filePath, "My prompt content");
      
      await component.loadFromFile(filePath);
      expect(component.has("my-prompt")).toBe(true);
    });

    test("should use custom name when provided", async () => {
      const filePath = join(testDir, "test.md");
      await writeFile(filePath, "Content");
      
      await component.loadFromFile(filePath, "custom-name");
      expect(component.has("custom-name")).toBe(true);
    });

    test("should return false when file not found", async () => {
      const result = await component.loadFromFile("/non/existent/file.md");
      expect(result).toBe(false);
    });
  });

  // ============================================================================
  // loadFromDirectory
  // ============================================================================
  describe("loadFromDirectory", () => {
    beforeEach(async () => {
      await setupTestDir();
      await component.init({ name: "prompt", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent } });
    });

    afterEach(async () => {
      await cleanupTestDir();
    });

    test("should load all .md files from directory", async () => {
      await writeFile(join(testDir, "prompt1.md"), "Content 1");
      await writeFile(join(testDir, "prompt2.md"), "Content 2");
      
      const count = await component.loadFromDirectory(testDir);
      expect(count).toBeGreaterThanOrEqual(2);
      expect(component.has("prompt1")).toBe(true);
      expect(component.has("prompt2")).toBe(true);
    });

    test("should load from subdirectory with recursive", async () => {
      await writeFile(join(testDir, "subdir", "nested.md"), "Nested content");
      
      const count = await component.loadFromDirectory(testDir, ".md", true);
      expect(component.has("subdir-nested")).toBe(true);
    });

    test("should not load from subdirectory without recursive", async () => {
      await writeFile(join(testDir, "subdir", "nested.md"), "Nested content");
      
      await component.loadFromDirectory(testDir, ".md", false);
      expect(component.has("nested")).toBe(false);
    });

    test("should filter by extension", async () => {
      await writeFile(join(testDir, "valid.txt"), "Should not load");
      await writeFile(join(testDir, "valid.md"), "Should load");
      
      const count = await component.loadFromDirectory(testDir, ".md", false);
      expect(component.has("valid")).toBe(true);
    });
  });

  // ============================================================================
  // Hooks (使用 globalHookManager)
  // ============================================================================
  describe("Hooks", () => {
    beforeEach(async () => {
      await component.init({ name: "prompt", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent } });
      // 清理之前的 hooks
      globalHookManager.unregisterAll("prompt.before-render");
      globalHookManager.unregisterAll("prompt.after-render");
    });

    afterEach(async () => {
      // 清理 hooks
      globalHookManager.unregisterAll("prompt.before-render");
      globalHookManager.unregisterAll("prompt.after-render");
    });

    test("should execute before.render hook via globalHookManager", async () => {
      let hookCalled = false;
      
      globalHookManager.register("prompt.before-render", {
        name: "test-before",
        execute: async (ctx) => {
          hookCalled = true;
          const data = ctx.data as { name: string; originalContent: string };
          expect(data.name).toBe("test");
          expect(data.originalContent).toBe("Original");
        },
      });

      component.add("test", "Original");
      await component.getPrompt("test");
      
      expect(hookCalled).toBe(true);
    });

    test("should execute after.render hook via globalHookManager", async () => {
      let hookCalled = false;
      
      globalHookManager.register("prompt.after-render", {
        name: "test-after",
        execute: async (ctx) => {
          hookCalled = true;
          const data = ctx.data as { name: string };
          expect(data.name).toBe("test");
        },
      });

      component.add("test", "Original");
      await component.getPrompt("test", { name: "Alice" });
      
      expect(hookCalled).toBe(true);
    });

    test("should allow hook to modify rendered content via globalHookManager", async () => {
      globalHookManager.register("prompt.after-render", {
        name: "modifier",
        execute: async (ctx) => {
          const data = ctx.data as { renderedContent: string };
          data.renderedContent = data.renderedContent + " [modified]";
        },
      });

      component.add("test", "Hello");
      const content = await component.getPrompt("test");
      
      expect(content).toBe("Hello [modified]");
    });
  });

  // ============================================================================
  // extractVariables
  // ============================================================================
  describe("extractVariables", () => {
    beforeEach(async () => {
      await component.init({ name: "prompt", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent } });
    });

    test("should extract variable names from template", () => {
      const vars = component.extractVariables("Hello {{name}}, today is {{date}}!");
      expect(vars).toContain("name");
      expect(vars).toContain("date");
    });

    test("should return unique variable names", () => {
      const vars = component.extractVariables("{{a}} {{b}} {{a}}");
      expect(vars).toEqual(["a", "b"]);
    });

    test("should return empty array for template without variables", () => {
      const vars = component.extractVariables("No variables here");
      expect(vars).toEqual([]);
    });
  });

  // ============================================================================
  // External globalHookManager Integration
  // ============================================================================
  describe("External globalHookManager Integration", () => {
    beforeEach(async () => {
      await component.init({ name: "prompt", version: "1.0.0", enabled: true, env: mockEnv, options: { configComponent } });
      // 清理之前的 hooks
      globalHookManager.unregisterAll("prompt.before-render");
      globalHookManager.unregisterAll("prompt.after-render");
    });

    afterEach(async () => {
      // 清理 hooks
      globalHookManager.unregisterAll("prompt.before-render");
      globalHookManager.unregisterAll("prompt.after-render");
    });

    test("should allow external projects to register prompt hooks via globalHookManager", async () => {
      // 模拟外部项目（如 bounty）注册 hook
      globalHookManager.register("prompt:after-render", {
        name: "bounty-prompt-hook",
        priority: 100,
        execute: async (ctx) => {
          const data = ctx.data as { renderedContent: string };
          if (data.renderedContent === "Hello") {
            data.renderedContent = data.renderedContent + " [from bounty]";
          }
        },
      });

      component.add("test", "Hello");
      const content = await component.getPrompt("test");
      
      expect(content).toBe("Hello [from bounty]");
    });

    test("should support priority ordering in globalHookManager", async () => {
      const callOrder: string[] = [];

      // 先注册低优先级 hook
      globalHookManager.register("prompt:after-render", {
        name: "low-priority",
        priority: 10,
        execute: async (ctx) => {
          callOrder.push("low");
          const data = ctx.data as { renderedContent: string };
          data.renderedContent += " [low]";
        },
      });

      // 后注册高优先级 hook（应该先执行）
      globalHookManager.register("prompt:after-render", {
        name: "high-priority",
        priority: 1,
        execute: async (ctx) => {
          callOrder.push("high");
          const data = ctx.data as { renderedContent: string };
          data.renderedContent += " [high]";
        },
      });

      component.add("test", "Hello");
      await component.getPrompt("test");
      
      // 高优先级应该先执行
      expect(callOrder).toEqual(["high", "low"]);
      expect(await component.getPrompt("test")).toBe("Hello [high] [low]");
    });
  });
});
