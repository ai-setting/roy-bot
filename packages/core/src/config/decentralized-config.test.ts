/**
 * 去中心化配置注册机制测试
 * 
 * 测试流程：
 * 1. Component.init() 调用 ConfigComponent.registerSource() 注册 Source
 * 2. 调用 ConfigComponent.registerKeys() 注册需要监听的配置 Key
 * 3. 调用 ConfigComponent.load() 按需加载配置
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ConfigComponent,
  MemorySource,
  type ConfigSource,
  type SourceRegistration,
  type KeyRegistration,
  type ComponentRegistration,
  FileSource,
  EnvSource,
} from "./config-component";
import * as fsSync from "fs";
import path from "path";
import os from "os";

// Helper: 清理临时目录
function createTempDir(): string {
  const tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
  return tempDir;
}

function cleanupTempDir(tempDir: string): void {
  if (fsSync.existsSync(tempDir)) {
    fsSync.rmSync(tempDir, { recursive: true });
  }
}

describe("去中心化配置注册机制", () => {
  describe("接口定义", () => {
    test("SourceRegistration 接口包含必要字段", () => {
      const sourceReg: SourceRegistration = {
        type: "file",
        relativePath: "test-config.jsonc",
      };

      expect(sourceReg.type).toBe("file");
      expect(sourceReg.relativePath).toBe("test-config.jsonc");
    });

    test("SourceRegistration 支持可选配置", () => {
      const sourceReg: SourceRegistration = {
        type: "env",
        envPrefix: "LLM",
        priority: 20,
      };

      expect(sourceReg.type).toBe("env");
      expect(sourceReg.envPrefix).toBe("LLM");
      expect(sourceReg.priority).toBe(20);
    });

    test("KeyRegistration 接口包含必要字段", () => {
      const keyReg: KeyRegistration = {
        key: "llm.provider",
        sources: ["file", "memory"],
      };

      expect(keyReg.key).toBe("llm.provider");
      expect(keyReg.sources).toEqual(["file", "memory"]);
    });

    test("KeyRegistration 支持自定义优先级", () => {
      const keyReg: KeyRegistration = {
        key: "llm.model",
        sources: ["file", "env"],
        priority: 5,
      };

      expect(keyReg.key).toBe("llm.model");
      expect(keyReg.sources).toEqual(["file", "env"]);
      expect(keyReg.priority).toBe(5);
    });

    test("ComponentRegistration 接口包含必要字段", () => {
      const compReg: ComponentRegistration = {
        name: "llm",
        sources: [
          { type: "file", relativePath: "llm-config.jsonc" },
          { type: "env", envPrefix: "LLM" },
        ],
        keys: [
          { key: "llm.provider", sources: ["file", "env", "memory"] },
          { key: "llm.model", sources: ["file", "memory"] },
        ],
      };

      expect(compReg.name).toBe("llm");
      expect(compReg.sources).toHaveLength(2);
      expect(compReg.keys).toHaveLength(2);
    });
  });

  describe("registerSource 注册 Source", () => {
    let config: ConfigComponent;
    let tempDir: string;

    beforeEach(() => {
      config = new ConfigComponent();
      tempDir = createTempDir();
      (config as any).setXdgDataHome(tempDir);
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    test("注册 file Source", async () => {
      // 先创建配置文件
      fsSync.writeFileSync(
        path.join(tempDir, "test-config.jsonc"),
        JSON.stringify({})
      );

      config.registerSource({
        type: "file",
        relativePath: "test-config.jsonc",
      });

      // load 后验证 Source 已被创建
      await config.load();
      
      const sources = (config as any).sources;
      expect(sources.some((s: ConfigSource) => s.name === "file")).toBe(true);
    });

    test("注册 env Source", async () => {
      config.registerSource({
        type: "env",
        envPrefix: "LLM",
      });

      await config.load();
      
      const sources = (config as any).sources;
      expect(sources.some((s: ConfigSource) => s.name === "env")).toBe(true);
    });

    test("注册多个 Source", async () => {
      // 先创建配置文件
      fsSync.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({})
      );

      config.registerSource({ type: "file", relativePath: "config.json" });
      config.registerSource({ type: "env", envPrefix: "APP" });

      await config.load();
      
      const sources = (config as any).sources;
      expect(sources.filter((s: ConfigSource) => s.name === "file")).toHaveLength(1);
      expect(sources.filter((s: ConfigSource) => s.name === "env")).toHaveLength(1);
    });

    test("相同 relativePath 的 Source 不会重复注册", async () => {
      // 先创建配置文件
      fsSync.writeFileSync(
        path.join(tempDir, "config.json"),
        JSON.stringify({})
      );

      config.registerSource({ type: "file", relativePath: "config.json" });
      config.registerSource({ type: "file", relativePath: "config.json" });

      await config.load();
      
      const sources = (config as any).sources;
      expect(sources.filter((s: ConfigSource) => s.name === "file")).toHaveLength(1);
    });
  });

  describe("registerKeys 注册配置 Key", () => {
    let config: ConfigComponent;

    beforeEach(() => {
      config = new ConfigComponent();
    });

    test("注册单个 Key", () => {
      config.registerKeys([
        { key: "llm.provider", sources: ["file", "memory"] },
      ]);

      const keyRegistry = (config as any).keyRegistry;
      expect(keyRegistry.has("llm.provider")).toBe(true);
      expect(keyRegistry.get("llm.provider").sources).toEqual(["file", "memory"]);
    });

    test("注册多个 Key", () => {
      config.registerKeys([
        { key: "llm.provider", sources: ["file", "memory"] },
        { key: "llm.model", sources: ["file"] },
      ]);

      const keyRegistry = (config as any).keyRegistry;
      expect(keyRegistry.size).toBe(2);
      expect(keyRegistry.has("llm.provider")).toBe(true);
      expect(keyRegistry.has("llm.model")).toBe(true);
    });

    test("相同 Key 不会重复注册", () => {
      config.registerKeys([
        { key: "llm.provider", sources: ["file"] },
      ]);
      config.registerKeys([
        { key: "llm.provider", sources: ["env"] },
      ]);

      const keyRegistry = (config as any).keyRegistry;
      expect(keyRegistry.size).toBe(1);
      // 应该保留原有的 sources 配置
      expect(keyRegistry.get("llm.provider").sources).toEqual(["file"]);
    });
  });

  describe("load 按需加载配置", () => {
    let config: ConfigComponent;
    let tempDir: string;

    beforeEach(() => {
      config = new ConfigComponent();
      tempDir = createTempDir();
      (config as any).setXdgDataHome(tempDir);
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    test("load 加载 file Source 的配置", async () => {
      // 准备配置文件
      const configPath = path.join(tempDir, "test-config.jsonc");
      fsSync.writeFileSync(configPath, JSON.stringify({
        llm: { provider: "openai", model: "gpt-4" }
      }));

      // 注册 Source 和 Keys
      config.registerSource({ type: "file", relativePath: "test-config.jsonc" });
      config.registerKeys([
        { key: "llm.provider", sources: ["file"] },
        { key: "llm.model", sources: ["file"] },
      ]);

      // 加载配置
      await config.load();

      // 验证配置已加载
      expect(config.get("llm.provider")).toBe("openai");
      expect(config.get("llm.model")).toBe("gpt-4");
    });

    test("load 加载 env Source 的配置", async () => {
      // 保存原始环境变量
      const originalProvider = process.env.LLM_PROVIDER;
      const originalModel = process.env.LLM_MODEL;

      try {
        // 设置环境变量（Bug #2186 Bug 1 修复后：单层 LLM 前缀 → LLM_PROVIDER / LLM_MODEL）
        // key "llm.provider" -> 转换为 "LLM_PROVIDER"（无双 LLM 前缀）
        process.env.LLM_PROVIDER = "anthropic";
        process.env.LLM_MODEL = "claude-3";

        // 注册 Source 和 Keys
        config.registerSource({ type: "env", envPrefix: "LLM" });
        config.registerKeys([
          { key: "llm.provider", sources: ["env"] },
          { key: "llm.model", sources: ["env"] },
        ]);

        // 加载配置
        await config.load();

        // 验证配置已加载到内存
        expect(config.get("llm.provider")).toBe("anthropic");
        expect(config.get("llm.model")).toBe("claude-3");
      } finally {
        // 恢复环境变量
        if (originalProvider !== undefined) {
          process.env.LLM_PROVIDER = originalProvider;
        } else {
          delete process.env.LLM_PROVIDER;
        }
        if (originalModel !== undefined) {
          process.env.LLM_MODEL = originalModel;
        } else {
          delete process.env.LLM_MODEL;
        }
      }
    });

    test("load 按优先级加载（内存 > 文件 > 环境变量）", async () => {
      // 准备配置文件
      const configPath = path.join(tempDir, "test-config.jsonc");
      fsSync.writeFileSync(configPath, JSON.stringify({
        llm: { provider: "openai", model: "gpt-4" }
      }));

      // 保存原始环境变量
      const originalProvider = process.env.LLM_PROVIDER;
      const originalModel = process.env.LLM_MODEL;

      try {
        // 设置环境变量
        process.env.LLM_PROVIDER = "anthropic";
        process.env.LLM_MODEL = "claude-3";

        // 注册 Source（memory 内置，file 优先级 10，env 优先级 20）
        config.registerSource({ type: "file", relativePath: "test-config.jsonc" });
        config.registerSource({ type: "env", envPrefix: "LLM" });
        config.registerKeys([
          { key: "llm.provider", sources: ["memory", "file", "env"] },
          { key: "llm.model", sources: ["memory", "file", "env"] },
        ]);

        // 加载配置
        await config.load();

        // 由于内存中没有值，应该使用文件中的值
        expect(config.get("llm.provider")).toBe("openai");
        expect(config.get("llm.model")).toBe("gpt-4");
      } finally {
        // 恢复环境变量
        if (originalProvider !== undefined) {
          process.env.LLM_PROVIDER = originalProvider;
        } else {
          delete process.env.LLM_PROVIDER;
        }
        if (originalModel !== undefined) {
          process.env.LLM_MODEL = originalModel;
        } else {
          delete process.env.LLM_MODEL;
        }
      }
    });

    test("load 只加载已注册的 Keys", async () => {
      // 准备配置文件（包含多个配置项）
      const configPath = path.join(tempDir, "test-config.jsonc");
      fsSync.writeFileSync(configPath, JSON.stringify({
        llm: { provider: "openai", model: "gpt-4", temperature: 0.7 }
      }));

      config.registerSource({ type: "file", relativePath: "test-config.jsonc" });
      // 只注册部分 Keys
      config.registerKeys([
        { key: "llm.provider", sources: ["file"] },
      ]);

      await config.load();

      // 只加载了 provider，model 应该未定义
      expect(config.get("llm.provider")).toBe("openai");
      expect(config.get("llm.model")).toBeUndefined();
    });

    test("load 支持只加载指定 Component", async () => {
      // 准备配置文件
      const configPath = path.join(tempDir, "test-config.jsonc");
      fsSync.writeFileSync(configPath, JSON.stringify({
        llm: { provider: "openai" }
      }));

      // 注册 Component
      config.registerComponent({
        name: "llm",
        sources: [{ type: "file", relativePath: "test-config.jsonc" }],
        keys: [{ key: "llm.provider", sources: ["file"] }],
      });

      // 只加载 llm Component
      await config.load("llm");

      // 验证配置已加载
      expect(config.get("llm.provider")).toBe("openai");
    });
  });

  describe("registerComponent 一次性注册 Component", () => {
    let config: ConfigComponent;
    let tempDir: string;

    beforeEach(() => {
      config = new ConfigComponent();
      tempDir = createTempDir();
      (config as any).setXdgDataHome(tempDir);
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    test("registerComponent 同时注册 Source 和 Keys", async () => {
      // 先创建配置文件
      fsSync.writeFileSync(
        path.join(tempDir, "llm-config.jsonc"),
        JSON.stringify({})
      );

      config.registerComponent({
        name: "llm",
        sources: [
          { type: "file", relativePath: "llm-config.jsonc" },
          { type: "env", envPrefix: "LLM" },
        ],
        keys: [
          { key: "llm.provider", sources: ["file", "env", "memory"] },
        ],
      });

      await config.load();

      const sources = (config as any).sources;
      const keyRegistry = (config as any).keyRegistry;

      expect(sources.some((s: ConfigSource) => s.name === "file")).toBe(true);
      expect(sources.some((s: ConfigSource) => s.name === "env")).toBe(true);
      expect(keyRegistry.has("llm.provider")).toBe(true);
    });
  });

  describe("FileSource 相对路径支持", () => {
    test("相对路径基于 XDG_DATA_HOME 解析", async () => {
      const tempDir2 = createTempDir();
      
      try {
        // 准备配置文件
        const configPath = path.join(tempDir2, "llm-config.jsonc");
        fsSync.writeFileSync(configPath, JSON.stringify({
          llm: { provider: "openai" }
        }));

        const config = new ConfigComponent();
        (config as any).setXdgDataHome(tempDir2);
        config.registerSource({ type: "file", relativePath: "llm-config.jsonc" });
        config.registerKeys([
          { key: "llm.provider", sources: ["file"] },
        ]);

        await config.load();

        expect(config.get("llm.provider")).toBe("openai");
      } finally {
        cleanupTempDir(tempDir2);
      }
    });

    test("相对路径基于 XDG_DATA_HOME 解析", async () => {
      const tempDir2 = createTempDir();
      
      try {
        // 准备配置文件在 XDG_DATA_HOME 下
        const configPath = path.join(tempDir2, "app-config.jsonc");
        fsSync.writeFileSync(configPath, JSON.stringify({
          app: { name: "test-app" }
        }));

        const config = new ConfigComponent();
        (config as any).setXdgDataHome(tempDir2);
        config.registerSource({ type: "file", relativePath: "app-config.jsonc" });
        config.registerKeys([
          { key: "app.name", sources: ["file"] },
        ]);

        await config.load();

        expect(config.get("app.name")).toBe("test-app");
      } finally {
        cleanupTempDir(tempDir2);
      }
    });

    test("可选文件不存在时不报错", async () => {
      const tempDir2 = createTempDir();
      
      try {
        const config = new ConfigComponent();
        (config as any).setXdgDataHome(tempDir2);
        config.registerSource({ 
          type: "file", 
          relativePath: "non-existent.jsonc",
          optional: true 
        });
        config.registerKeys([
          { key: "test.value", sources: ["file"] },
        ]);

        // 应该不抛出异常
        let error: unknown;
        try {
          await config.load();
        } catch (e) {
          error = e;
        }
        expect(error).toBeUndefined();
        expect(config.get("test.value")).toBeUndefined();
      } finally {
        cleanupTempDir(tempDir2);
      }
    });

    test("必需文件不存在时抛出错误", async () => {
      const tempDir2 = createTempDir();
      
      try {
        const config = new ConfigComponent();
        (config as any).setXdgDataHome(tempDir2);
        config.registerSource({ 
          type: "file", 
          relativePath: "non-existent.jsonc",
          optional: false 
        });
        config.registerKeys([
          { key: "test.value", sources: ["file"] },
        ]);

        await expect(config.load()).rejects.toThrow();
      } finally {
        cleanupTempDir(tempDir2);
      }
    });
  });

  describe("ProtocolResolver 集成", () => {
    let config: ConfigComponent;
    let tempDir: string;

    beforeEach(() => {
      config = new ConfigComponent();
      tempDir = createTempDir();
      (config as any).setXdgDataHome(tempDir);
    });

    afterEach(() => {
      cleanupTempDir(tempDir);
    });

    test("配置支持 env:// 协议引用", async () => {
      // 设置环境变量
      process.env.API_KEY = "sk-test-key";

      try {
        const configPath = path.join(tempDir, "config.jsonc");
        fsSync.writeFileSync(configPath, JSON.stringify({
          llm: { apiKey: "${env://API_KEY}" }
        }));

        config.registerSource({ type: "file", relativePath: "config.jsonc" });
        config.registerKeys([
          { key: "llm.apiKey", sources: ["file"] },
        ]);

        await config.load();

        expect(config.get("llm.apiKey")).toBe("sk-test-key");
      } finally {
        delete process.env.API_KEY;
      }
    });

    test("env:// 协议支持默认值", async () => {
      const configPath = path.join(tempDir, "config.jsonc");
      fsSync.writeFileSync(configPath, JSON.stringify({
        llm: { apiKey: "${env://API_KEY:-default-key}" }
      }));

      config.registerSource({ type: "file", relativePath: "config.jsonc" });
      config.registerKeys([
        { key: "llm.apiKey", sources: ["file"] },
      ]);

      await config.load();

      expect(config.get("llm.apiKey")).toBe("default-key");
    });

    test("配置支持 file:// 协议引用", async () => {
      // 准备被引用的文件
      const secretsPath = path.join(tempDir, "secrets.json");
      fsSync.writeFileSync(secretsPath, JSON.stringify({
        apiKey: "secret-key-123"
      }));

      // 准备主配置文件
      const configPath = path.join(tempDir, "config.jsonc");
      fsSync.writeFileSync(configPath, JSON.stringify({
        llm: { apiKey: "${file://secrets.json#apiKey}" }
      }));

      config.registerSource({ type: "file", relativePath: "config.jsonc" });
      config.registerKeys([
        { key: "llm.apiKey", sources: ["file"] },
      ]);

      await config.load();

      expect(config.get("llm.apiKey")).toBe("secret-key-123");
    });
  });

  describe("Source 优先级", () => {
    test("MemorySource 优先级为 0", () => {
      const memory = new MemorySource();
      expect(memory.priority).toBe(0);
    });

    test("加载时按优先级顺序查询", async () => {
      const tempDir2 = createTempDir();
      
      try {
        // 准备文件配置
        const configPath = path.join(tempDir2, "config.jsonc");
        fsSync.writeFileSync(configPath, JSON.stringify({
          llm: { provider: "from-file" }
        }));

        const config = new ConfigComponent();
        (config as any).setXdgDataHome(tempDir2);

        // 先设置内存值
        config.set("llm.provider", "from-memory");

        // 注册 file source
        config.registerSource({ type: "file", relativePath: "config.jsonc" });
        config.registerKeys([
          { key: "llm.provider", sources: ["memory", "file"] },
        ]);

        await config.load();

        // 内存优先级高，应该返回内存的值
        expect(config.get("llm.provider")).toBe("from-memory");
      } finally {
        cleanupTempDir(tempDir2);
      }
    });
  });

  describe("已注册 Source 查询", () => {
    test("getRegisteredSources 返回已注册的 Source 列表", () => {
      const config = new ConfigComponent();
      
      // 使用可选文件，避免实际文件不存在导致错误
      config.registerSource({ type: "file", relativePath: "config1.jsonc", optional: true });
      config.registerSource({ type: "env", envPrefix: "APP" });

      const registeredSources = config.getRegisteredSources();
      
      expect(registeredSources).toHaveLength(3); // memory + file + env
      expect(registeredSources.map(s => s.name)).toContain("file");
      expect(registeredSources.map(s => s.name)).toContain("env");
      expect(registeredSources.map(s => s.name)).toContain("memory");
    });
  });

  describe("错误处理", () => {
    test("未注册的 Key 不加载", async () => {
      const config = new ConfigComponent();
      
      // 不注册任何 Key，直接调用 load
      // 应该不报错
      let error: unknown;
      try {
        await config.load();
      } catch (e) {
        error = e;
      }
      expect(error).toBeUndefined();
    });

    test("load 未知的 component 不报错", async () => {
      const config = new ConfigComponent();
      
      let error: unknown;
      try {
        await config.load("non-existent");
      } catch (e) {
        error = e;
      }
      expect(error).toBeUndefined();
    });

    test("重复 registerSource 不报错", () => {
      const config = new ConfigComponent();
      
      config.registerSource({ type: "file", relativePath: "config.jsonc" });
      expect(() => {
        config.registerSource({ type: "file", relativePath: "config.jsonc" });
      }).not.toThrow();
    });

    test("重复 registerKeys 不报错", () => {
      const config = new ConfigComponent();
      
      config.registerKeys([{ key: "test.key", sources: ["memory"] }]);
      expect(() => {
        config.registerKeys([{ key: "test.key", sources: ["memory"] }]);
      }).not.toThrow();
    });

    test("registerKeys should register default values to memory source", () => {
      const config = new ConfigComponent();
      
      // Before: no default value
      expect(config.get("test.default1")).toBe(undefined);
      
      config.registerKeys([
        { key: "test.default1", sources: ["memory"], default: "value1" },
        { key: "test.default2", sources: ["memory"], default: 123 },
        { key: "test.default3", sources: ["memory"], default: true },
      ]);
      
      // After: default values registered
      expect(config.get("test.default1")).toBe("value1");
      expect(config.get("test.default2")).toBe(123);
      expect(config.get("test.default3")).toBe(true);
    });
    
    test("registerKeys should not override existing values", () => {
      const config = new ConfigComponent();
      
      // Set value first
      config.set("test.key", "existing");
      
      config.registerKeys([
        { key: "test.key", sources: ["memory"], default: "default" },
      ]);
      
      // Should keep existing value
      expect(config.get("test.key")).toBe("existing");
    });
  });
});
