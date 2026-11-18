import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { adaptMcpTool, createMcpToolsDescription, getToolParamDescriptions, convertInputSchemaToZod } from "./adapter";
import type { ToolInfo } from "../../tool/types";

/**
 * TDD RED: 测试 Tool Adapter
 */

// Mock MCP Client
const createMockMcpClient = () => ({
  callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
    if (name === "success-tool") {
      return {
        content: [{ type: "text" as const, text: "success result" }],
        isError: false,
      };
    }
    if (name === "error-tool") {
      return {
        content: [{ type: "text" as const, text: "error result" }],
        isError: true,
      };
    }
    return {
      content: [{ type: "text" as const, text: "unknown" }],
      isError: false,
    };
  },
});

describe("adaptMcpTool", () => {
  const mockClient = createMockMcpClient() as any;

  it("should create tool with correct naming", () => {
    const mcpTool: McpTool = {
      name: "read_file",
      description: "Read a file from the filesystem",
      inputSchema: { type: "object" },
    };

    const tool = adaptMcpTool(mcpTool, mockClient, "filesystem-mcp");

    expect(tool.name).toBe("mcp_filesystem-mcp_read_file");
  });

  it("should create tool with correct description", () => {
    const mcpTool: McpTool = {
      name: "search",
      description: "Search for files",
      inputSchema: { type: "object" },
    };

    const tool = adaptMcpTool(mcpTool, mockClient, "memory");

    expect(tool.description).toContain("memory");
    expect(tool.description).toContain("search");
    expect(tool.description).toContain("Search for files");
  });

  it("should return z.unknown for empty inputSchema", () => {
    const mcpTool: McpTool = {
      name: "no-args",
      description: "Tool with no arguments",
      inputSchema: { type: "object", properties: {} },
    };

    const tool = adaptMcpTool(mcpTool, mockClient, "test");

    expect(tool.parameters).toBeDefined();
  });

  it("should create tool with metadata", () => {
    const mcpTool: McpTool = {
      name: "test",
      description: "Test tool",
      inputSchema: { type: "object" },
    };

    const tool = adaptMcpTool(mcpTool, mockClient, "test-mcp");

    expect(tool.metadata).toBeDefined();
    expect(tool.metadata?.category).toBe("mcp");
    expect(tool.metadata?.tags).toContain("mcp");
    expect(tool.metadata?.tags).toContain("test-mcp");
  });

  it("should preserve original MCP tool info in metadata", () => {
    const mcpTool: McpTool = {
      name: "web_search",
      description: "Search the web",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "The search query" },
        },
        required: ["query"],
      },
    };

    const tool = adaptMcpTool(mcpTool, mockClient, "exa");

    // 验证 metadata 中保留了原始信息
    expect(tool.metadata?.mcpTool).toBeDefined();
    expect((tool.metadata?.mcpTool as any).originalName).toBe("web_search");
    expect((tool.metadata?.mcpTool as any).originalDescription).toBe("Search the web");
    expect((tool.metadata?.mcpTool as any).inputSchema).toEqual(mcpTool.inputSchema);
  });

  it("should execute successfully", async () => {
    const mcpTool: McpTool = {
      name: "success-tool",
      description: "A tool that succeeds",
      inputSchema: { type: "object" },
    };

    const tool = adaptMcpTool(mcpTool, mockClient, "test");
    const result = await tool.execute({}, {} as any);

    expect(result.success).toBe(true);
    expect(result.output).toBe("success result");
  });

  it("should handle error results", async () => {
    const mcpTool: McpTool = {
      name: "error-tool",
      description: "A tool that errors",
      inputSchema: { type: "object" },
    };

    const tool = adaptMcpTool(mcpTool, mockClient, "test");
    const result = await tool.execute({}, {} as any);

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should pass arguments to MCP tool", async () => {
    let receivedArgs: Record<string, unknown> = {};

    const customClient = {
      callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
        receivedArgs = args;
        return { content: [{ type: "text", text: "ok" }] };
      },
    };

    const mcpTool: McpTool = {
      name: "greet",
      description: "Greet someone",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
        required: ["name"],
      },
    };

    const tool = adaptMcpTool(mcpTool, customClient as any, "test");
    await tool.execute({ name: "World" }, {} as any);

    expect(receivedArgs.name).toBe("World");
  });
});

describe("convertInputSchemaToZod - 参数描述保留", () => {
  it("should preserve parameter descriptions", () => {
    const schema = {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query to look up",
        },
        numResults: {
          type: "integer",
          description: "Number of results to return",
        },
      },
      required: ["query"],
    };

    const tool = adaptMcpTool(
      { name: "search", description: "Search", inputSchema: schema },
      {} as any,
      "test"
    );

    // 通过 metadata 验证描述被保留
    const params = getToolParamDescriptions(tool);
    expect(params.query).toBe("The search query to look up");
    expect(params.numResults).toBe("Number of results to return");
  });

  it("should handle optional parameters", () => {
    const schema = {
      type: "object",
      properties: {
        requiredParam: {
          type: "string",
          description: "Required parameter",
        },
        optionalParam: {
          type: "string",
          description: "Optional parameter",
        },
      },
      required: ["requiredParam"],
    };

    const zodSchema = convertInputSchemaToZod(schema);

    // 验证必需参数不能省略
    const result1 = zodSchema.safeParse({ requiredParam: "test" });
    expect(result1.success).toBe(true);

    // 验证可选参数可以省略
    const result2 = zodSchema.safeParse({});
    expect(result2.success).toBe(false); // requiredParam is missing

    const result3 = zodSchema.safeParse({ requiredParam: "test", optionalParam: "opt" });
    expect(result3.success).toBe(true);
  });

  it("should handle string with minLength/maxLength", () => {
    const schema = {
      type: "object",
      properties: {
        code: {
          type: "string",
          description: "Verification code",
          minLength: 6,
          maxLength: 6,
        },
      },
      required: ["code"],
    };

    const zodSchema = convertInputSchemaToZod(schema);
    const result = zodSchema.safeParse({ code: "123456" });
    expect(result.success).toBe(true);
  });

  it("should handle number with min/max constraints", () => {
    const schema = {
      type: "object",
      properties: {
        page: {
          type: "integer",
          description: "Page number",
          minimum: 1,
          maximum: 100,
        },
      },
    };

    const zodSchema = convertInputSchemaToZod(schema);

    // 有效范围
    const result1 = zodSchema.safeParse({ page: 50 });
    expect(result1.success).toBe(true);

    // 超出范围
    const result2 = zodSchema.safeParse({ page: 101 });
    expect(result2.success).toBe(false);
  });

  it("should handle enum values", () => {
    const schema = {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["pending", "active", "completed"],
          description: "Task status",
        },
      },
    };

    const zodSchema = convertInputSchemaToZod(schema);
    const result1 = zodSchema.safeParse({ status: "active" });
    expect(result1.success).toBe(true);

    const result2 = zodSchema.safeParse({ status: "invalid" });
    expect(result2.success).toBe(false);
  });

  it("should add valid values to enum description", () => {
    const schema = {
      type: "object",
      properties: {
        freshness: {
          type: "string",
          enum: ["24h", "week", "month", "year", "any"],
          description: "How recent results should be",
        },
      },
    };

    const zodSchema = convertInputSchemaToZod(schema);
    
    // 验证有效值
    expect(zodSchema.safeParse({ freshness: "24h" }).success).toBe(true);
    expect(zodSchema.safeParse({ freshness: "week" }).success).toBe(true);
    expect(zodSchema.safeParse({ freshness: "any" }).success).toBe(true);
    
    // 验证无效值
    expect(zodSchema.safeParse({ freshness: "day" }).success).toBe(false);
    expect(zodSchema.safeParse({ freshness: "d" }).success).toBe(false);
  });

  it("should include valid values in schema for LLM", async () => {
    const { adaptMcpTool } = await import("../tool/adapter.js");
    const { zodToJsonSchema } = await import("zod-to-json-schema");

    const mcpTool = {
      name: "web_search_exa",
      description: "Search the web using Exa",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
          freshness: {
            type: "string",
            enum: ["24h", "week", "month", "year", "any"],
            description: "How recent results should be",
          },
        },
        required: ["query"],
      },
    };

    const mockClient = {
      callTool: async () => ({ content: [{ type: "text", text: "ok" }], isError: false }),
    };

    const tool = adaptMcpTool(mcpTool as any, mockClient as any, "exa");
    
    // 转换为 JSON Schema（模拟传递给 LLM）
    const jsonSchema = zodToJsonSchema(tool.parameters, "zod");
    
    // 验证 schema 中包含 enum 信息
    const freshnessSchema = (jsonSchema.definitions?.zod?.properties?.freshness || 
                             jsonSchema.properties?.freshness) as any;
    
    expect(freshnessSchema).toBeDefined();
    expect(freshnessSchema.enum).toEqual(["24h", "week", "month", "year", "any"]);
    
    // 验证描述中包含有效值
    expect(freshnessSchema.description).toContain("Valid values");
    expect(freshnessSchema.description).toContain('"24h"');
    expect(freshnessSchema.description).toContain('"any"');
  });

  it("should handle array types", () => {
    const schema = {
      type: "object",
      properties: {
        ids: {
          type: "array",
          items: { type: "string" },
          description: "List of IDs",
        },
      },
    };

    const zodSchema = convertInputSchemaToZod(schema);
    const result = zodSchema.safeParse({ ids: ["a", "b", "c"] });
    expect(result.success).toBe(true);
  });

  it("should handle anyOf/oneOf (union types)", () => {
    const schema = {
      type: "object",
      properties: {
        value: {
          anyOf: [
            { type: "string" },
            { type: "number" },
          ],
          description: "Can be string or number",
        },
      },
    };

    const zodSchema = convertInputSchemaToZod(schema);

    const result1 = zodSchema.safeParse({ value: "hello" });
    expect(result1.success).toBe(true);

    const result2 = zodSchema.safeParse({ value: 123 });
    expect(result2.success).toBe(true);
  });

  it("should handle nested object properties", () => {
    const schema = {
      type: "object",
      properties: {
        user: {
          type: "object",
          properties: {
            name: { type: "string" },
            email: { type: "string" },
          },
          required: ["name"],
        },
      },
    };

    const zodSchema = convertInputSchemaToZod(schema);
    const result = zodSchema.safeParse({
      user: { name: "John", email: "john@example.com" },
    });
    expect(result.success).toBe(true);
  });

  it("should handle nullable types", () => {
    const schema = {
      type: "object",
      properties: {
        nickname: {
          type: "string",
          nullable: true,
          description: "Optional nickname",
        },
      },
    };

    const zodSchema = convertInputSchemaToZod(schema);
    const result1 = zodSchema.safeParse({ nickname: "test" });
    expect(result1.success).toBe(true);

    const result2 = zodSchema.safeParse({ nickname: null });
    expect(result2.success).toBe(true);
  });
});

describe("getToolParamDescriptions", () => {
  it("should extract parameter descriptions from tool metadata", () => {
    const mcpTool: McpTool = {
      name: "search",
      description: "Search",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
          limit: {
            type: "integer",
            description: "Result limit",
          },
        },
        required: ["query"],
      },
    };

    const tool = adaptMcpTool(mcpTool, {} as any, "test");
    const descriptions = getToolParamDescriptions(tool);

    expect(descriptions.query).toBe("Search query");
    expect(descriptions.limit).toBe("Result limit");
  });

  it("should return empty object if no descriptions", () => {
    const mcpTool: McpTool = {
      name: "test",
      description: "Test",
      inputSchema: {
        type: "object",
        properties: {
          param1: { type: "string" },
        },
      },
    };

    const tool = adaptMcpTool(mcpTool, {} as any, "test");
    const descriptions = getToolParamDescriptions(tool);

    expect(descriptions).toEqual({});
    expect(descriptions.param1).toBeUndefined();
  });
});

describe("createMcpToolsDescription", () => {
  it("should return empty message for no tools", () => {
    const description = createMcpToolsDescription([]);
    expect(description).toContain("No MCP tools");
  });

  it("should format tools correctly", () => {
    const tools: ToolInfo[] = [
      {
        name: "mcp_test_tool1",
        description: "First tool",
        parameters: z.unknown(),
        execute: async () => ({ success: true, output: "" }),
      },
      {
        name: "mcp_test_tool2",
        description: "Second tool",
        parameters: z.unknown(),
        execute: async () => ({ success: true, output: "" }),
      },
    ];

    const description = createMcpToolsDescription(tools);

    expect(description).toContain("mcp_test_tool1");
    expect(description).toContain("First tool");
    expect(description).toContain("mcp_test_tool2");
    expect(description).toContain("Second tool");
  });
});

// TDD RED: Bug 1 - MCP Tool Parameter Validation
describe("MCP Tool Parameter Validation", () => {
  const mockClient = {
    callTool: async ({ name, arguments: args }: { name: string; arguments: Record<string, unknown> }) => {
      return { content: [{ type: "text" as const, text: "success" }], isError: false };
    },
  };

  it("should return error when required parameter is missing", async () => {
    const mcpTool: McpTool = {
      name: "web_search_exa",
      description: "Search using Exa",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
        },
        required: ["query"],
      },
    };

    const tool = adaptMcpTool(mcpTool, mockClient as any, "exa");
    
    // Execute with empty args (missing required 'query')
    const result = await tool.execute({}, {} as any);
    
    expect(result.success).toBe(false);
    expect(result.error).toContain("query");
    expect(result.error).toContain("required");
  });

  it("should execute successfully when all required parameters are provided", async () => {
    const mcpTool: McpTool = {
      name: "web_search_exa",
      description: "Search using Exa",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
          numResults: {
            type: "integer",
            description: "Number of results",
          },
        },
        required: ["query"],
      },
    };

    const tool = adaptMcpTool(mcpTool, mockClient as any, "exa");
    
    // Execute with required 'query' parameter
    const result = await tool.execute({ query: "test search" }, {} as any);
    
    expect(result.success).toBe(true);
    expect(result.output).toBe("success");
  });

  it("should pass through MCP SDK validation errors with clear message", async () => {
    const errorClient = {
      callTool: async () => {
        // Simulate JSON-RPC -32602 error
        const error = new Error("Invalid params");
        (error as any).code = -32602;
        throw error;
      },
    };

    const mcpTool: McpTool = {
      name: "web_search_exa",
      description: "Search using Exa",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query",
          },
        },
        required: ["query"],
      },
    };

    const tool = adaptMcpTool(mcpTool, errorClient as any, "exa");
    const result = await tool.execute({ query: "test" }, {} as any);
    
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    // Error should be user-friendly, not raw JSON-RPC
    expect(result.error).not.toContain("-32602");
  });

  it("should handle multiple required parameters", async () => {
    const mcpTool: McpTool = {
      name: "multi_param_tool",
      description: "Tool with multiple required params",
      inputSchema: {
        type: "object",
        properties: {
          param1: { type: "string" },
          param2: { type: "number" },
          optional: { type: "boolean" },
        },
        required: ["param1", "param2"],
      },
    };

    const tool = adaptMcpTool(mcpTool, mockClient as any, "test");
    
    // Missing both required params
    const result1 = await tool.execute({}, {} as any);
    expect(result1.success).toBe(false);
    expect(result1.error).toContain("param1");
    expect(result1.error).toContain("param2");
    
    // Only one required param
    const result2 = await tool.execute({ param1: "test" }, {} as any);
    expect(result2.success).toBe(false);
    expect(result2.error).toContain("param2");
    
    // All required params provided
    const result3 = await tool.execute({ param1: "test", param2: 123 }, {} as any);
    expect(result3.success).toBe(true);
  });

  it("should allow null values for nullable parameters", async () => {
    const mcpTool: McpTool = {
      name: "nullable_tool",
      description: "Tool with nullable param",
      inputSchema: {
        type: "object",
        properties: {
          nickname: {
            type: "string",
            nullable: true,
            description: "Optional nickname",
          },
        },
      },
    };

    const tool = adaptMcpTool(mcpTool, mockClient as any, "test");
    const result = await tool.execute({ nickname: null }, {} as any);
    
    expect(result.success).toBe(true);
  });
});
