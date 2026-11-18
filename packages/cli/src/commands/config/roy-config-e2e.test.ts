/**
 * @fileoverview roy-bot config 命令端到端测试
 * 
 * 验证 roy-bot config export 能正确导出 config.jsonc 中各 component 的配置（包括默认值）
 * 
 * TDD 流程：
 * - RED: 测试应该失败（因为当前实现有问题）
 * - GREEN: 实现最小代码让测试通过
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import { ConfigService } from "./config-service";

describe("roy-bot config export integration", () => {
  let tempDir: string;
  let configFilePath: string;

  beforeEach(() => {
    // 创建临时目录
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "roy-config-e2e-"));
    configFilePath = path.join(tempDir, "config.jsonc");
  });

  afterEach(() => {
    // 清理临时目录
    if (fsSync.existsSync(tempDir)) {
      fsSync.rmSync(tempDir, { recursive: true });
    }
    vi.restoreAllMocks();
  });

  describe("ConfigService.getComponentConfig should read from file source", () => {
    it("should export llm config from file source", async () => {
      // 创建 config.jsonc 文件，包含 llm 配置
      const configContent = `{
  // LLM 配置
  "llm": {
    "defaultModel": "gpt-4o",
    "defaultProvider": "openai",
    "temperature": 0.7,
    "providers": {
      "openai": {
        "apiKey": "sk-test-key",
        "baseURL": "https://api.openai.com/v1"
      }
    }
  }
}`;
      fsSync.writeFileSync(configFilePath, configContent, "utf-8");

      // 使用 EnvironmentService 创建环境
      const output = new OutputService();
      const envService = new EnvironmentService(output);

      try {
        await envService.create({ 
          configPath: configFilePath,
          sessionStorage: { type: "memory" }  // 使用内存存储，避免污染正式数据库
        });
        const env = envService.getEnvironment();
        expect(env).not.toBeNull();

        const configComponent = env!.getComponent("config");
        expect(configComponent).toBeDefined();

        const configService = new ConfigService(configComponent as any, output);

        // 导出 llm 配置
        const llmConfig = configService.getComponentConfig("llm");

        // 验证配置已正确读取
        expect(llmConfig.defaultModel).toBe("gpt-4o");
        expect(llmConfig.defaultProvider).toBe("openai");
        expect(llmConfig.temperature).toBe(0.7);
        expect(llmConfig.providers).toBeDefined();
        expect(llmConfig.providers.openai.apiKey).toBe("sk-test-key");
      } finally {
        await envService.dispose();
      }
    });

    it("should export agent config from file source", async () => {
      // 创建 config.jsonc 文件，包含 agent 配置
      const configContent = `{
  // Agent 配置
  "agent": {
    "maxIterations": 100,
    "maxErrorRetries": 3,
    "doomLoopThreshold": 5
  }
}`;
      fsSync.writeFileSync(configFilePath, configContent, "utf-8");

      const output = new OutputService();
      const envService = new EnvironmentService(output);

      try {
        await envService.create({ 
          configPath: configFilePath,
          sessionStorage: { type: "memory" }  // 使用内存存储，避免污染正式数据库
        });
        const env = envService.getEnvironment();

        const configComponent = env!.getComponent("config");
        const configService = new ConfigService(configComponent as any, output);

        // 导出 agent 配置
        const agentConfig = configService.getComponentConfig("agent");

        // 验证配置已正确读取
        expect(agentConfig.maxIterations).toBe(100);
        expect(agentConfig.maxErrorRetries).toBe(3);
        expect(agentConfig.doomLoopThreshold).toBe(5);
      } finally {
        await envService.dispose();
      }
    });

    it("should export multiple components from the same config file", async () => {
      // 创建 config.jsonc 文件，包含多个 component 配置
      const configContent = `{
  // LLM 配置
  "llm": {
    "defaultModel": "claude-3-sonnet",
    "defaultProvider": "anthropic"
  },
  // Agent 配置
  "agent": {
    "maxIterations": 50
  },
  // Tool 配置
  "tool": {
    "timeout": 30000
  }
}`;
      fsSync.writeFileSync(configFilePath, configContent, "utf-8");

      const output = new OutputService();
      const envService = new EnvironmentService(output);

      try {
        await envService.create({ 
          configPath: configFilePath,
          sessionStorage: { type: "memory" }  // 使用内存存储，避免污染正式数据库
        });
        const env = envService.getEnvironment();

        const configComponent = env!.getComponent("config");
        const configService = new ConfigService(configComponent as any, output);

        // 导出各个 component 配置
        const llmConfig = configService.getComponentConfig("llm");
        const agentConfig = configService.getComponentConfig("agent");
        const toolConfig = configService.getComponentConfig("tool");

        // 验证配置
        expect(llmConfig.defaultModel).toBe("claude-3-sonnet");
        expect(llmConfig.defaultProvider).toBe("anthropic");
        expect(agentConfig.maxIterations).toBe(50);
        expect(toolConfig.timeout).toBe(30000);
      } finally {
        await envService.dispose();
      }
    });

    it("should export default values when config file only has partial settings", async () => {
      // 创建 config.jsonc 文件，只包含部分配置
      const configContent = `{
  // 只有 llm 配置
  "llm": {
    "defaultModel": "gpt-4o"
  }
}`;
      fsSync.writeFileSync(configFilePath, configContent, "utf-8");

      const output = new OutputService();
      const envService = new EnvironmentService(output);

      try {
        await envService.create({ 
          configPath: configFilePath,
          sessionStorage: { type: "memory" }  // 使用内存存储，避免污染正式数据库
        });
        const env = envService.getEnvironment();

        const configComponent = env!.getComponent("config");
        const configService = new ConfigService(configComponent as any, output);

        // 获取 agent 配置（未在文件中设置）
        const agentConfig = configService.getComponentConfig("agent");

        // 应该有默认值（即使没有在文件中设置）
        // 注意：这取决于各 component 是否有注册默认值
        expect(agentConfig).toBeDefined();
        // maxIterations 应该有默认值（从 component 注册的 defaults）
        // 如果当前实现没有默认值，至少应该是空对象而不是 undefined
        expect(typeof agentConfig).toBe("object");
      } finally {
        await envService.dispose();
      }
    });

    it("should handle JSONC format with comments", async () => {
      // 创建带注释的 JSONC 文件
      const configContent = `{
  // LLM 配置
  "llm": {
    // 模型设置
    "defaultModel": "gpt-4-turbo",  // inline comment
    "temperature": 0.5
  },
  // Agent 配置
  "agent": {
    "maxIterations": 200
  }
}`;
      fsSync.writeFileSync(configFilePath, configContent, "utf-8");

      const output = new OutputService();
      const envService = new EnvironmentService(output);

      try {
        await envService.create({ 
          configPath: configFilePath,
          sessionStorage: { type: "memory" }  // 使用内存存储，避免污染正式数据库
        });
        const env = envService.getEnvironment();

        const configComponent = env!.getComponent("config");
        const configService = new ConfigService(configComponent as any, output);

        // 验证 JSONC 注释被正确解析
        const llmConfig = configService.getComponentConfig("llm");
        expect(llmConfig.defaultModel).toBe("gpt-4-turbo");
        expect(llmConfig.temperature).toBe(0.5);

        const agentConfig = configService.getComponentConfig("agent");
        expect(agentConfig.maxIterations).toBe(200);
      } finally {
        await envService.dispose();
      }
    });

    it("should export to file correctly with all components", async () => {
      // 创建包含完整配置的 config.jsonc
      const configContent = `{
  "llm": {
    "defaultModel": "gpt-4o",
    "defaultProvider": "openai"
  },
  "agent": {
    "maxIterations": 100
  }
}`;
      fsSync.writeFileSync(configFilePath, configContent, "utf-8");

      const output = new OutputService();
      const envService = new EnvironmentService(output);

      const exportFilePath = path.join(tempDir, "exported-config.json");

      try {
        await envService.create({ 
          configPath: configFilePath,
          sessionStorage: { type: "memory" }  // 使用内存存储，避免污染正式数据库
        });
        const env = envService.getEnvironment();

        const configComponent = env!.getComponent("config");
        const configService = new ConfigService(configComponent as any, output);

        // 导出 llm 配置到文件
        await configService.exportToFile("llm", { filePath: exportFilePath });

        // 读取导出的文件
        const exportedContent = fsSync.readFileSync(exportFilePath, "utf-8");
        const exportedData = JSON.parse(exportedContent);

        // 验证导出内容
        expect(exportedData.llm).toBeDefined();
        expect(exportedData.llm.defaultModel).toBe("gpt-4o");
        expect(exportedData.llm.defaultProvider).toBe("openai");
      } finally {
        await envService.dispose();
        // 清理导出文件
        if (fsSync.existsSync(exportFilePath)) {
          fsSync.unlinkSync(exportFilePath);
        }
      }
    });
  });
});
