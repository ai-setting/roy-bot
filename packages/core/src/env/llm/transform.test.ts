import { describe, test, expect } from "bun:test";
import { z } from "zod";
import { LLMTransform } from "./transform";
import type { LLMMessage, ToolInfo } from "./types";

describe("LLMTransform", () => {
  const transform = new LLMTransform();

  describe("normalizeMessages", () => {
    test("should handle basic user message", () => {
      const input: LLMMessage[] = [
        { role: "user", content: "Hello" },
      ];

      const result = transform.normalizeMessages(input, "openai");
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ role: "user", content: "Hello" });
    });

    test("should handle system message", () => {
      const input: LLMMessage[] = [
        { role: "system", content: "You are helpful" },
        { role: "user", content: "Hi" },
      ];

      const result = transform.normalizeMessages(input, "openai");
      expect(result[0].role).toBe("system");
      expect(result[0].content).toBe("You are helpful");
    });

    test("should convert tool message to assistant format for openai", () => {
      const input: LLMMessage[] = [
        { role: "tool", content: '{"result":"sunny"}', toolCallId: "call_1" },
      ];

      const result = transform.normalizeMessages(input, "openai");
      // OpenAI 使用 tool role
      expect(result[0].role).toBe("tool");
      expect(result[0].toolCallId).toBe("call_1");
    });

    test("should handle messages with tool calls", () => {
      const input: LLMMessage[] = [
        {
          role: "assistant",
          content: "Let me search for that",
          toolCalls: [
            { id: "call_1", name: "search", arguments: '{"query":"weather"}' },
          ],
        },
      ];

      const result = transform.normalizeMessages(input, "openai");
      expect(result[0].toolCalls).toHaveLength(1);
      expect(result[0].toolCalls?.[0].name).toBe("search");
    });

    test("should handle multi-turn conversation", () => {
      const input: LLMMessage[] = [
        { role: "user", content: "What's the weather?" },
        { role: "assistant", content: "I'll check for you" },
        { role: "user", content: "Thanks" },
      ];

      const result = transform.normalizeMessages(input, "openai");
      expect(result).toHaveLength(3);
    });

    test("should pass through for anthropic format", () => {
      const input: LLMMessage[] = [
        { role: "user", content: "Hello" },
      ];

      // Anthropic might have different requirements
      const result = transform.normalizeMessages(input, "anthropic");
      expect(result).toHaveLength(1);
    });
  });

  describe("extractToolSchema", () => {
    test("should extract basic tool schema", () => {
      const tool: ToolInfo = {
        name: "getWeather",
        description: "Get weather for a location",
        parameters: {
          type: "object",
          properties: {
            location: { type: "string" },
          },
          required: ["location"],
        },
      };

      const result = transform.extractToolSchema(tool);
      expect(result.name).toBe("getWeather");
      expect(result.description).toBe("Get weather for a location");
    });

    test("should handle tool without description", () => {
      const tool: ToolInfo = {
        name: "simpleTool",
        parameters: {
          type: "object",
          properties: {},
        },
      };

      const result = transform.extractToolSchema(tool);
      expect(result.name).toBe("simpleTool");
      expect(result.description).toBeUndefined();
    });

    test("should extract nested parameters", () => {
      const tool: ToolInfo = {
        name: "complexTool",
        parameters: {
          type: "object",
          properties: {
            user: {
              type: "object",
              properties: {
                name: { type: "string" },
                age: { type: "number" },
              },
            },
          },
        },
      };

      const result = transform.extractToolSchema(tool);
      expect(result.parameters.properties).toBeDefined();
      expect(result.parameters.properties?.user).toBeDefined();
    });

    test("should handle array parameters", () => {
      const tool: ToolInfo = {
        name: "batchTool",
        parameters: {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      };

      const result = transform.extractToolSchema(tool);
      expect(result.parameters.properties?.items?.type).toBe("array");
    });
  });

  describe("zodToJsonSchema", () => {
    test("should convert zod schema to json schema", () => {
      const zodSchema = z.object({
        name: z.string(),
        age: z.number(),
      });

      const result = transform.zodToJsonSchema(zodSchema);
      expect(result.type).toBe("object");
      expect(result.properties).toBeDefined();
      expect(result.properties?.name).toBeDefined();
      expect(result.properties?.age).toBeDefined();
    });

    test("should handle optional fields", () => {
      const zodSchema = z.object({
        name: z.string(),
        email: z.string().optional(),
      });

      const result = transform.zodToJsonSchema(zodSchema);
      expect(result.type).toBe("object");
      expect(result.properties).toBeDefined();
      expect(result.properties?.name).toBeDefined();
      expect(result.properties?.email).toBeDefined();
    });

    test("should handle nested objects", () => {
      const zodSchema = z.object({
        user: z.object({
          name: z.string(),
          address: z.object({
            city: z.string(),
          }),
        }),
      });

      const result = transform.zodToJsonSchema(zodSchema);
      expect(result.properties?.user?.properties).toBeDefined();
      expect(result.properties?.user?.properties?.address?.properties).toBeDefined();
    });

    test("should handle array types", () => {
      const zodSchema = z.object({
        tags: z.array(z.string()),
      });

      const result = transform.zodToJsonSchema(zodSchema);
      expect(result.properties?.tags?.type).toBe("array");
    });

    test("should handle enum types", () => {
      const zodSchema = z.object({
        status: z.enum(["active", "inactive", "pending"]),
      });

      const result = transform.zodToJsonSchema(zodSchema);
      expect(result.properties?.status?.enum).toEqual(["active", "inactive", "pending"]);
    });

    // ── Task #4619 (cross-validation m-1) ────────────────────────────────
    // A `z.preprocess(...)` / `.transform(...)` schema is a **ZodEffects**,
    // not a ZodObject. `extractZodSchema` used to fall through to its final
    // `return {}` for those, silently producing an empty schema — a model
    // would have been told the tool takes no parameters at all.
    //
    // The task tool schemas (`task_get` / `task_update` / `task_complete`)
    // are ZodEffects since the legacy-alias work, so this is a live path.
    test("should unwrap a ZodEffects (preprocess) schema", () => {
      const zodSchema = z.preprocess(
        (raw) => raw,
        z.object({
          task_id: z.number(),
          title: z.string().optional(),
        }),
      );

      const result = transform.zodToJsonSchema(zodSchema);
      expect(result.type).toBe("object");
      expect(result.properties).toBeDefined();
      expect(result.properties?.task_id).toBeDefined();
      expect(result.properties?.title).toBeDefined();
      // `task_id` is required, `title` is not.
      expect(result.required).toEqual(["task_id"]);
    });

    test("should unwrap a ZodEffects (transform) schema", () => {
      const zodSchema = z
        .object({ id: z.number() })
        .transform((v) => ({ ...v, seen: true }));

      const result = transform.zodToJsonSchema(zodSchema);
      expect(result.type).toBe("object");
      expect(result.properties?.id).toBeDefined();
    });
  });

  describe("formatToolResult", () => {
    test("should format successful tool result", () => {
      const result = transform.formatToolResult({
        toolCallId: "call_1",
        result: '{"temperature": 25}',
      });
      expect(result.content).toBe('{"temperature": 25}');
    });

    test("should format error tool result", () => {
      const result = transform.formatToolResult({
        toolCallId: "call_1",
        result: "Error: API timeout",
        isError: true,
      });
      expect(result.content).toBe("Error: API timeout");
      expect(result.isError).toBe(true);
    });
  });

  describe("parseToolArguments", () => {
    test("should parse valid JSON arguments", () => {
      const result = transform.parseToolArguments('{"query":"weather"}');
      expect(result).toEqual({ query: "weather" });
    });

    test("should return empty object for empty string", () => {
      const result = transform.parseToolArguments("");
      expect(result).toEqual({});
    });

    test("should handle JSON parse errors gracefully", () => {
      const result = transform.parseToolArguments("not valid json");
      expect(result).toEqual({});
    });
  });
});
