/**
 * @fileoverview 验证 config import 保留 JSONC $ 引用语法的测试
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fsSync from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import * as os from "os";

describe("config import 保留 JSONC $ 引用", () => {
  let tempDir: string;
  let configFilePath: string;

  beforeEach(() => {
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "roy-import-test-"));
    configFilePath = path.join(tempDir, "config.jsonc");
  });

  afterEach(() => {
    if (fsSync.existsSync(tempDir)) {
      fsSync.rmSync(tempDir, { recursive: true });
    }
  });

  it("保留 $file:// 协议引用不被清空", async () => {
    // 1. 创建包含 $ 引用的原始配置文件
    const originalContent = `{
  "agent": {
    "defaultAgent": {
      "apiKey": "\${file://auth.json#providers.minimax.apiKey}",
      "model": "minimax"
    }
  }
}`;
    await fsPromises.writeFile(configFilePath, originalContent, "utf-8");

    // 2. 创建导入源文件（只包含部分配置）
    const sourceFilePath = path.join(tempDir, "source.json");
    const sourceContent = `{
  "agent": {
    "defaultAgent": {
      "filterHistory": true
    }
  }
}`;
    await fsPromises.writeFile(sourceFilePath, sourceContent, "utf-8");

    // 3. 执行导入
    const { ConfigService } = await import("./config-service");
    const mockConfigComponent = createMockConfigComponent(configFilePath);
    const mockOutput = createMockOutput();
    const configService = new ConfigService(mockConfigComponent, mockOutput as any);
    
    const result = await configService.importFromFile("agent", {
      sourceFile: sourceFilePath,
      verbose: false,
    });

    expect(result.success).toBe(true);

    // 4. 验证 $ 引用被保留
    const finalContent = await fsPromises.readFile(configFilePath, "utf-8");
    const finalData = JSON.parse(finalContent);
    
    // apiKey 应该保留 $ 引用，而不是空字符串
    expect(finalData.agent.defaultAgent.apiKey).toBe(
      "\${file://auth.json#providers.minimax.apiKey}"
    );
    // filterHistory 应该是导入的新值
    expect(finalData.agent.defaultAgent.filterHistory).toBe(true);
    // model 也应该保留
    expect(finalData.agent.defaultAgent.model).toBe("minimax");
  });

  it("保留 $env:// 协议引用不被清空", async () => {
    // 1. 创建包含 $ 引用和 $env 混合的配置文件
    const originalContent = `{
  "llm": {
    "defaultLlm": {
      "apiKey": "\${env://MINIMAX_API_KEY:-default_key}",
      "baseURL": "\${file://config.json#llm.baseURL}",
      "model": "minimax"
    }
  }
}`;
    await fsPromises.writeFile(configFilePath, originalContent, "utf-8");

    // 2. 创建导入源文件
    const sourceFilePath = path.join(tempDir, "source.json");
    const sourceContent = `{
  "llm": {
    "defaultLlm": {
      "temperature": 0.7
    }
  }
}`;
    await fsPromises.writeFile(sourceFilePath, sourceContent, "utf-8");

    // 3. 执行导入
    const { ConfigService } = await import("./config-service");
    const mockConfigComponent = createMockConfigComponent(configFilePath);
    const mockOutput = createMockOutput();
    const configService = new ConfigService(mockConfigComponent, mockOutput as any);
    
    const result = await configService.importFromFile("llm", {
      sourceFile: sourceFilePath,
      verbose: false,
    });

    expect(result.success).toBe(true);

    // 4. 验证 $ 引用被保留
    const finalContent = await fsPromises.readFile(configFilePath, "utf-8");
    const finalData = JSON.parse(finalContent);
    
    // apiKey 应该保留 $env:// 引用
    expect(finalData.llm.defaultLlm.apiKey).toBe(
      "\${env://MINIMAX_API_KEY:-default_key}"
    );
    // baseURL 应该保留 $file:// 引用
    expect(finalData.llm.defaultLlm.baseURL).toBe(
      "\${file://config.json#llm.baseURL}"
    );
    // temperature 应该是导入的新值
    expect(finalData.llm.defaultLlm.temperature).toBe(0.7);
  });

  it("保留带默认值的 $ 引用", async () => {
    // 1. 创建包含带默认值 $ 引用的配置文件
    const originalContent = `{
  "agent": {
    "defaultAgent": {
      "apiKey": "\${file://auth.json#apiKey:-fallback_key}",
      "timeout": 30
    }
  }
}`;
    await fsPromises.writeFile(configFilePath, originalContent, "utf-8");

    // 2. 创建导入源文件
    const sourceFilePath = path.join(tempDir, "source.json");
    const sourceContent = `{
  "agent": {
    "defaultAgent": {
      "maxRetries": 3
    }
  }
}`;
    await fsPromises.writeFile(sourceFilePath, sourceContent, "utf-8");

    // 3. 执行导入
    const { ConfigService } = await import("./config-service");
    const mockConfigComponent = createMockConfigComponent(configFilePath);
    const mockOutput = createMockOutput();
    const configService = new ConfigService(mockConfigComponent, mockOutput as any);
    
    const result = await configService.importFromFile("agent", {
      sourceFile: sourceFilePath,
      verbose: false,
    });

    expect(result.success).toBe(true);

    // 4. 验证带默认值的 $ 引用被保留
    const finalContent = await fsPromises.readFile(configFilePath, "utf-8");
    const finalData = JSON.parse(finalContent);
    
    expect(finalData.agent.defaultAgent.apiKey).toBe(
      "\${file://auth.json#apiKey:-fallback_key}"
    );
    expect(finalData.agent.defaultAgent.timeout).toBe(30);
    expect(finalData.agent.defaultAgent.maxRetries).toBe(3);
  });
});

/**
 * 创建模拟 ConfigComponent
 */
function createMockConfigComponent(filePath: string) {
  return {
    name: "config",
    getSources: () => [
      {
        name: "memory",
        read: () => undefined,
        write: () => {},
        list: () => [],
      },
      {
        name: "file",
        filePath,
        read: () => undefined,
        write: () => {},
        list: () => [],
      },
    ],
  } as any;
}

/**
 * 创建模拟 OutputService
 */
function createMockOutput() {
  return {
    log: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    success: () => {},
  };
}
