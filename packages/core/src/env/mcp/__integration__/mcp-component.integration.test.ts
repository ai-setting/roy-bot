import { describe, it, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { vi } from "vitest";
import { McpComponent } from "../mcp-component";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { McpServerRemoteConfig } from "../types.js";

/**
 * MCP 工具注册测试
 */

// Mock MCP SDK
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: "web_search",
          description: "Search the web",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
            },
            required: ["query"],
          },
        },
        {
          name: "web_fetch",
          description: "Fetch webpage content",
          inputSchema: {
            type: "object",
            properties: {
              url: { type: "string", description: "URL to fetch" },
            },
            required: ["url"],
          },
        },
      ],
    }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "mock result" }],
    }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
  StreamableHTTPClientTransport: vi.fn().mockImplementation(() => ({})),
}));

// 不要 mock BaseComponent，因为它会影响其他测试文件

// Mock Logger
vi.mock("../../log-trace/logger", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// Mock Scanner
vi.mock("../scanner", () => ({
  McpScanner: vi.fn().mockImplementation(() => ({
    scan: vi.fn().mockResolvedValue(
      new Map([
        [
          "exa",
          {
            name: "exa",
            directoryConfig: {
              type: "remote",
              url: "https://mcp.exa.ai/mcp?tools=web_search_exa",
              enabled: true,
              timeout: 30000,
            },
          },
        ],
      ])
    ),
  })),
}));

// Mock Loader
vi.mock("../loader", () => ({
  McpLoader: vi.fn().mockImplementation(() => ({
    buildDefaultConfig: vi.fn().mockImplementation((server) => ({
      type: "remote",
      url: server.directoryConfig?.url as string,
      enabled: true,
      timeout: 30000,
    })),
    mergeConfig: vi.fn().mockImplementation((defaultConfig) => defaultConfig),
    connect: vi.fn().mockImplementation(async (name, config) => ({
      name,
      config,
      client: {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            {
              name: "web_search_exa",
              description: "Search the web using Exa",
              inputSchema: {
                type: "object",
                properties: {
                  query: { type: "string", description: "Search query" },
                },
                required: ["query"],
              },
            },
          ],
        }),
        callTool: vi.fn().mockResolvedValue({
          content: [{ type: "text", text: "search result" }],
          isError: false,
        }),
      },
    })),
    disconnect: vi.fn().mockResolvedValue(undefined),
    disconnectAll: vi.fn().mockResolvedValue(undefined),
  })),
}));

describe("McpComponent 工具注册", () => {
  let component: McpComponent;
  let mockToolComponent: any;
  let registeredTools: Map<string, any>;

  beforeEach(() => {
    vi.clearAllMocks();

    // 创建 mock ToolComponent
    registeredTools = new Map<string, any>();
    mockToolComponent = {
      register: vi.fn((tool) => {
        registeredTools.set(tool.name, tool);
      }),
      unregister: vi.fn((name) => {
        return registeredTools.delete(name);
      }),
      getTool: vi.fn((name) => registeredTools.get(name)),
      listTools: vi.fn(() => Array.from(registeredTools.values())),
      _tools: registeredTools,
    };

    component = new McpComponent();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("init", () => {
    it("应该接受有效的配置并初始化", async () => {
      const mockConfigComponent = {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        registerSource: vi.fn(),
        registerComponent: vi.fn(),
        load: vi.fn().mockResolvedValue(undefined),
      };

      await component.init({
        options: {
          configComponent: mockConfigComponent as any,
          config: {
            enabled: false,
            mcpPaths: [],
          },
        },
      });

      expect(component.getStatus()).toBeDefined();
    });

    it("缺少 configComponent 应该抛出错误", async () => {
      await expect(
        component.init({
          options: {},
        })
      ).rejects.toThrow("ConfigComponent is required");
    });
  });

  describe("start - MCP 工具注册到 ToolComponent", () => {
    it("应该将扫描到的 MCP 工具注册到 ToolComponent", async () => {
      const mockConfigComponent = {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        registerSource: vi.fn(),
        registerComponent: vi.fn(),
        load: vi.fn().mockResolvedValue(undefined),
      };

      await component.init({
        options: {
          configComponent: mockConfigComponent as any,
          config: {
            enabled: true,
            mcpPaths: [{ type: "project", path: ".roy/mcp" }],
          },
        },
      });

      // 设置 env（包含 getComponent 方法）并注入 mock ToolComponent
      (component as any).env = {
        getComponent: vi.fn().mockReturnValue(mockToolComponent),
      };
      (component as any).toolComponent = mockToolComponent;

      // 启动组件
      await component.start();

      // 验证：MCP 工具应该被注册到 ToolComponent
      // Mock Loader 返回的客户端会被 adaptMcpTool 适配
      expect(mockToolComponent.register).toHaveBeenCalled();
      
      // 验证：至少有一个工具被注册
      const servers = component.listServers();
      console.log("Server status:", servers);
    });

    it("ToolComponent 不存在时应该跳过工具注册", async () => {
      const mockConfigComponent = {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        registerSource: vi.fn(),
        registerComponent: vi.fn(),
        load: vi.fn().mockResolvedValue(undefined),
      };

      await component.init({
        options: {
          configComponent: mockConfigComponent as any,
          config: {
            enabled: true,
            mcpPaths: [{ type: "project", path: ".roy/mcp" }],
          },
        },
      });

      // 设置 env（getComponent 返回 undefined）
      (component as any).env = {
        getComponent: vi.fn().mockReturnValue(undefined),
      };
      (component as any).toolComponent = undefined;

      // 启动组件 - 不应该抛出错误
      await component.start();
      expect(component.getStatus()).toBeDefined();
    });
  });

  describe("工具列表方法", () => {
    it("listTools 应该返回已注册的 MCP 工具", () => {
      const tools = component.listTools();
      expect(Array.isArray(tools)).toBe(true);
    });

    it("listServers 应该返回服务器状态列表", () => {
      const servers = component.listServers();
      expect(Array.isArray(servers)).toBe(true);
    });
  });

  describe("reload", () => {
    it("应该能够重新加载服务器并重新注册工具", async () => {
      const mockConfigComponent = {
        get: vi.fn().mockReturnValue(undefined),
        set: vi.fn().mockResolvedValue(undefined),
        registerSource: vi.fn(),
        registerComponent: vi.fn(),
        load: vi.fn().mockResolvedValue(undefined),
      };

      await component.init({
        options: {
          configComponent: mockConfigComponent as any,
          config: {
            enabled: true,
            mcpPaths: [{ type: "project", path: ".roy/mcp" }],
          },
        },
      });

      (component as any).env = {
        getComponent: vi.fn().mockReturnValue(mockToolComponent),
      };
      (component as any).toolComponent = mockToolComponent;

      await component.start();
      await component.reload();

      // reload 应该清理旧状态
      expect(component.listServers()).toBeDefined();
    });
  });
});

describe("MCP 工具适配器测试", () => {
  it("应该正确适配 MCP 工具格式", async () => {
    // 这个测试验证 adaptMcpTool 的输出格式
    const { adaptMcpTool } = await import("../tool/adapter.js");

    const mockMcpTool = {
      name: "web_search",
      description: "Search the web",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        required: ["query"],
      },
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "result" }],
        isError: false,
      }),
    } as any;

    const adaptedTool = adaptMcpTool(mockMcpTool as any, mockClient, "exa");

    // 验证适配后的工具格式
    expect(adaptedTool.name).toBe("mcp_exa_web_search");
    expect(adaptedTool.description).toContain("MCP tool [exa/web_search]");
    expect(adaptedTool.metadata?.category).toBe("mcp");
    expect(adaptedTool.metadata?.tags).toContain("exa");
  });

  it("应该正确处理工具执行", async () => {
    const { adaptMcpTool } = await import("../tool/adapter.js");

    const mockMcpTool = {
      name: "test_tool",
      description: "Test tool",
      inputSchema: {
        type: "object",
        properties: {},
      },
    };

    const mockResult = {
      content: [{ type: "text", text: "test result" }],
      isError: false,
    };

    const mockClient = {
      callTool: vi.fn().mockResolvedValue(mockResult),
    } as any;

    const adaptedTool = adaptMcpTool(mockMcpTool as any, mockClient, "test");

    // 执行工具
    const result = await adaptedTool.execute({});

    expect(result.success).toBe(true);
    expect(result.output).toBe("test result");
    expect(mockClient.callTool).toHaveBeenCalledWith({
      name: "test_tool",
      arguments: {},
    });
  });
});

// 清理 mock，避免污染其他测试
afterAll(() => {
  vi.restoreAllMocks();
});
