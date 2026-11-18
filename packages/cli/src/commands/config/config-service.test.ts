/**
 * @fileoverview ConfigService 测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsSync from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as os from "os";
import { ConfigService } from "./config-service";

// Mock OutputService
const mockOutput = {
  log: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

// Mock ConfigComponent
function createMockConfigComponent(memoryData: Record<string, unknown> = {}) {
  const memorySource = {
    name: "memory" as const,
    priority: 0,
    read: (key: string) => memoryData[key],
    list: () =>
      Object.entries(memoryData).map(([key, value]) => ({ key, value })),
  };

  return {
    getSources: () => [memorySource],
    get: (key: string) => memoryData[key],
  };
}

describe("ConfigService", () => {
  let tempDir: string;
  let tempFilePath: string;

  beforeEach(() => {
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "config-test-"));
    tempFilePath = path.join(tempDir, "config.json");
    vi.clearAllMocks();
  });

  afterEach(() => {
    // 清理临时目录
    if (fsSync.existsSync(tempDir)) {
      fsSync.rmSync(tempDir, { recursive: true });
    }
  });

  describe("getComponentConfig", () => {
    it("should return empty config when no memory source", () => {
      const mockConfig = {
        getSources: () => [],
      };
      const service = new ConfigService(
        mockConfig as any,
        mockOutput as any
      );

      const config = service.getComponentConfig("agent");
      expect(config).toEqual({});
    });

    it("should extract component config with prefix", () => {
      const mockConfig = createMockConfigComponent({
        "agent.maxIterations": 100,
        "agent.maxErrorRetries": 3,
        "agent.doomLoopThreshold": 5,
        "llm.provider": "openai",
      });

      const service = new ConfigService(
        mockConfig as any,
        mockOutput as any
      );

      const config = service.getComponentConfig("agent");
      expect(config).toEqual({
        maxIterations: 100,
        maxErrorRetries: 3,
        doomLoopThreshold: 5,
      });
    });

    it("should preserve nested structure", () => {
      const mockConfig = createMockConfigComponent({
        "agent.defaultAgent.maxIterations": 100,
        "agent.defaultAgent.toolTimeout": 30000,
      });

      const service = new ConfigService(
        mockConfig as any,
        mockOutput as any
      );

      const config = service.getComponentConfig("agent");
      expect(config).toEqual({
        defaultAgent: {
          maxIterations: 100,
          toolTimeout: 30000,
        },
      });
    });
  });

  describe("getComponentFilePath", () => {
    it("should return file path from file source", () => {
      const mockConfig = {
        getSources: () => [
          {
            name: "file",
            filePath: "/path/to/config.json",
          },
        ],
      };
      const service = new ConfigService(
        mockConfig as any,
        mockOutput as any
      );

      const filePath = service.getComponentFilePath("agent");
      expect(filePath).toBe("/path/to/config.json");
    });

    it("should return undefined when no file source", () => {
      const mockConfig = {
        getSources: () => [
          {
            name: "memory",
            priority: 0,
          },
        ],
      };
      const service = new ConfigService(
        mockConfig as any,
        mockOutput as any
      );

      const filePath = service.getComponentFilePath("agent");
      expect(filePath).toBeUndefined();
    });
  });

  describe("exportToFile", () => {
    it("should export config to file", async () => {
      const mockConfig = createMockConfigComponent({
        "agent.maxIterations": 100,
      });
      const service = new ConfigService(
        mockConfig as any,
        mockOutput as any
      );

      await service.exportToFile("agent", {
        filePath: tempFilePath,
      });

      const content = fsSync.readFileSync(tempFilePath, "utf-8");
      const data = JSON.parse(content);
      expect(data).toEqual({
        agent: {
          maxIterations: 100,
        },
      });
    });

    it("should return content when no file path", async () => {
      const mockConfig = createMockConfigComponent({
        "agent.maxIterations": 100,
      });
      const service = new ConfigService(
        mockConfig as any,
        mockOutput as any
      );

      const content = await service.exportToFile("agent", {});

      expect(content).toContain("agent");
      expect(content).toContain("maxIterations");
      expect(content).toContain("100");
    });

    it("should create parent directories if not exist", async () => {
      const mockConfig = createMockConfigComponent({
        "agent.maxIterations": 100,
      });
      const service = new ConfigService(
        mockConfig as any,
        mockOutput as any
      );

      const nestedPath = path.join(tempDir, "nested", "dir", "config.json");
      await service.exportToFile("agent", { filePath: nestedPath });

      expect(fsSync.existsSync(nestedPath)).toBe(true);
    });
  });

  describe("importFromFile", () => {
    it("should import config from file and merge", async () => {
      // 创建源文件
      const sourceFile = path.join(tempDir, "source.json");
      fsSync.writeFileSync(
        sourceFile,
        JSON.stringify({
          agent: {
            maxIterations: 200,
            doomLoopThreshold: 5,
          },
        })
      );

      // 创建目标文件（已有部分配置）
      fsSync.writeFileSync(
        tempFilePath,
        JSON.stringify({
          agent: {
            maxIterations: 100,
            maxErrorRetries: 3,
          },
          llm: {
            provider: "openai",
          },
        })
      );

      const mockConfig = {
        getSources: () => [
          {
            name: "file",
            filePath: tempFilePath,
          },
        ],
      };
      const service = new ConfigService(
        mockConfig as any,
        mockOutput as any
      );

      const result = await service.importFromFile("agent", {
        sourceFile,
      });

      expect(result.success).toBe(true);
      expect(result.merged).toBe(true);
      expect(result.filePath).toBe(tempFilePath);
      expect(result.changes.length).toBeGreaterThan(0);

      // 验证文件内容
      const content = fsSync.readFileSync(tempFilePath, "utf-8");
      const data = JSON.parse(content);
      expect(data.agent.maxIterations).toBe(200); // 被覆盖
      expect(data.agent.maxErrorRetries).toBe(3); // 保留
      expect(data.agent.doomLoopThreshold).toBe(5); // 新增
      expect(data.llm.provider).toBe("openai"); // 保留
    });

    it("should support dry-run mode", async () => {
      const sourceFile = path.join(tempDir, "source.json");
      fsSync.writeFileSync(
        sourceFile,
        JSON.stringify({
          agent: { maxIterations: 200 },
        })
      );

      fsSync.writeFileSync(
        tempFilePath,
        JSON.stringify({
          agent: { maxIterations: 100 },
        })
      );

      const mockConfig = {
        getSources: () => [
          {
            name: "file",
            filePath: tempFilePath,
          },
        ],
      };
      const service = new ConfigService(
        mockConfig as any,
        mockOutput as any
      );

      const result = await service.importFromFile("agent", {
        sourceFile,
        dryRun: true,
      });

      expect(result.success).toBe(true);
      expect(result.filePath).toBe(tempFilePath);

      // 文件内容不应被修改
      const content = fsSync.readFileSync(tempFilePath, "utf-8");
      const data = JSON.parse(content);
      expect(data.agent.maxIterations).toBe(100); // 未被修改
    });

    it("should create new file if target does not exist", async () => {
      const sourceFile = path.join(tempDir, "source.json");
      fsSync.writeFileSync(
        sourceFile,
        JSON.stringify({
          agent: { maxIterations: 200 },
        })
      );

      const mockConfig = {
        getSources: () => [
          {
            name: "file",
            filePath: tempFilePath,
          },
        ],
      };
      const service = new ConfigService(
        mockConfig as any,
        mockOutput as any
      );

      const result = await service.importFromFile("agent", {
        sourceFile,
      });

      expect(result.success).toBe(true);
      expect(fsSync.existsSync(tempFilePath)).toBe(true);
    });

    it("should return error when source file not found", async () => {
      const mockConfig = {
        getSources: () => [
          {
            name: "file",
            filePath: tempFilePath,
          },
        ],
      };
      const service = new ConfigService(
        mockConfig as any,
        mockOutput as any
      );

      const result = await service.importFromFile("agent", {
        sourceFile: "/non/existent/file.json",
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("无法读取源文件");
    });

    it("should return error when component config not found in source", async () => {
      const sourceFile = path.join(tempDir, "source.json");
      fsSync.writeFileSync(
        sourceFile,
        JSON.stringify({
          llm: { provider: "openai" },
        })
      );

      const mockConfig = {
        getSources: () => [
          {
            name: "file",
            filePath: tempFilePath,
          },
        ],
      };
      const service = new ConfigService(
        mockConfig as any,
        mockOutput as any
      );

      const result = await service.importFromFile("agent", {
        sourceFile,
      });

      expect(result.success).toBe(false);
      expect(result.message).toContain("未找到 agent 配置");
    });

    it("should preserve other components when importing JSONC file with comments", async () => {
      // 创建源文件
      const sourceFile = path.join(tempDir, "source.json");
      fsSync.writeFileSync(
        sourceFile,
        JSON.stringify({
          agent: {
            maxIterations: 200,
            doomLoopThreshold: 5,
          },
        })
      );

      // 创建目标文件（JSONC 格式，包含注释和其他组件配置）
      const targetFilePath = path.join(tempDir, "target.jsonc");
      fsSync.writeFileSync(
        targetFilePath,
        `{
  // LLM 配置
  "llm": {
    "provider": "openai",
    "model": "gpt-4"
  },
  "agent": {
    "maxIterations": 100,
    "maxErrorRetries": 3
  }
}`
      );

      const mockConfig = {
        getSources: () => [
          {
            name: "file",
            filePath: targetFilePath,
          },
        ],
      };
      const service = new ConfigService(
        mockConfig as any,
        mockOutput as any
      );

      const result = await service.importFromFile("agent", {
        sourceFile,
      });

      expect(result.success).toBe(true);
      expect(result.merged).toBe(true);

      // 验证文件内容 - llm 配置应该被保留
      const content = fsSync.readFileSync(targetFilePath, "utf-8");
      const data = JSON.parse(content);
      expect(data.llm).toBeDefined();
      expect(data.llm.provider).toBe("openai");
      expect(data.llm.model).toBe("gpt-4");
      // agent 配置应该被合并
      expect(data.agent.maxIterations).toBe(200); // 被覆盖
      expect(data.agent.maxErrorRetries).toBe(3); // 保留
      expect(data.agent.doomLoopThreshold).toBe(5); // 新增
    });
  });
});
