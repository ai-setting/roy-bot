import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { z, ZodError } from "zod";
import { ToolValidator, setToolReasonRequired, setToolReasonConfigComponent } from "./validator";
import type { Tool, ValidationResult } from "./types";

describe("ToolValidator", () => {
  let validator: ToolValidator;

  beforeEach(() => {
    // Task #5422: reason 前置校验默认开启，存量单测不携带 reason，
    // 这里关闭逃生开关以保持原有断言语义（reason 行为在 tool-reason.test.ts 覆盖）。
    // 同时解除可能被其他测试文件经 ToolComponent.init 接线的 ConfigComponent，
    // 否则其 tool.reason.required=true 默认值会覆盖模块级开关。
    setToolReasonConfigComponent(null);
    setToolReasonRequired(false);
  });

  afterEach(() => {
    setToolReasonConfigComponent(null);
    setToolReasonRequired(true);
  });

  const createMockTool = (paramsSchema: z.ZodType): Tool => ({
    name: "test-tool",
    description: "Test tool",
    parameters: paramsSchema,
    execute: async () => ({ success: true, output: "ok" }),
  });

  beforeEach(() => {
    validator = new ToolValidator();
  });

  describe("validate", () => {
    test("should validate correct arguments", async () => {
      const tool = createMockTool(
        z.object({
          name: z.string(),
          age: z.number().optional(),
        })
      );

      const result = await validator.validate(tool, { name: "test" });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ name: "test" });
      expect(result.error).toBeUndefined();
    });

    test("should validate with optional fields", async () => {
      const tool = createMockTool(
        z.object({
          name: z.string(),
          age: z.number().optional(),
        })
      );

      const result = await validator.validate(tool, { name: "test", age: 25 });

      expect(result.success).toBe(true);
      expect(result.data).toEqual({ name: "test", age: 25 });
    });

    test("should return error for missing required field", async () => {
      const tool = createMockTool(
        z.object({
          name: z.string(),
          age: z.number(),
        })
      );

      const result = await validator.validate(tool, {});

      expect(result.success).toBe(false);
      expect(result.error).toContain("name");
      expect(result.error).toContain("Required");
    });

    test("should return error for wrong type", async () => {
      const tool = createMockTool(
        z.object({
          name: z.string(),
        })
      );

      const result = await validator.validate(tool, { name: 123 });

      expect(result.success).toBe(false);
      expect(result.error).toContain("name");
    });

    test("should return error for invalid enum value", async () => {
      const tool = createMockTool(
        z.object({
          status: z.enum(["active", "inactive"]),
        })
      );

      const result = await validator.validate(tool, { status: "pending" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("status");
      expect(result.error).toMatch(/invalid|expected/i);
    });

    test("should validate nested objects", async () => {
      const tool = createMockTool(
        z.object({
          user: z.object({
            name: z.string(),
            address: z.object({
              city: z.string(),
            }),
          }),
        })
      );

      const result = await validator.validate(tool, {
        user: { name: "John", address: { city: "NYC" } },
      });

      expect(result.success).toBe(true);
    });

    test("should validate arrays", async () => {
      const tool = createMockTool(
        z.object({
          tags: z.array(z.string()),
        })
      );

      const result = await validator.validate(tool, { tags: ["a", "b", "c"] });

      expect(result.success).toBe(true);
    });

    test("should validate with custom error formatter", async () => {
      const tool: Tool = {
        name: "test-tool",
        description: "Test tool",
        parameters: z.object({
          name: z.string(),
        }),
        execute: async () => ({ success: true, output: "ok" }),
        formatValidationError: (error: ZodError) => {
          return error.errors.map((e) => `${e.path.join(".")} - ${e.message}`).join("; ");
        },
      };

      const result = await validator.validate(tool, { name: 123 });

      expect(result.success).toBe(false);
      expect(result.error).toContain("name");
      expect(result.error).toContain("-");
    });
  });
});
