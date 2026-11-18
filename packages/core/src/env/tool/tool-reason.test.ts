/**
 * @fileoverview 工具 reason 入参测试（Task #5422）
 *
 * B+C 组合方案：
 * - B：toolParametersToJsonSchema() 出口统一注入必填 `reason`
 * - C：ToolValidator.validate() 前置校验 args.reason
 * - 逃生开关：tool.reason.required 配置（默认 true）
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";
import { toolParametersToJsonSchema } from "../llm/tool-schema";
import { ToolValidator } from "./validator";
import {
  setToolReasonRequired,
  isToolReasonRequired,
  setToolReasonConfigComponent,
} from "./validator";
import type { Tool } from "./types";

const createMockTool = (paramsSchema: z.ZodType): Tool => ({
  name: "test-tool",
  description: "Test tool",
  parameters: paramsSchema,
  execute: async () => ({ success: true, output: "ok" }),
});

describe("reason 注入：toolParametersToJsonSchema（Task #5422）", () => {
  it("普通 Zod object schema：注入必填 reason", () => {
    const js = toolParametersToJsonSchema(
      z.object({ command: z.string() })
    );
    const props = js.properties as Record<string, any>;
    expect(props.reason).toBeDefined();
    expect(props.reason.type).toBe("string");
    expect(props.reason.description).toContain("为什么调用");
    const required = js.required as string[];
    expect(required).toContain("reason");
  });

  it("ZodEffects（z.preprocess，task 工具形态）：同样注入", () => {
    const schema = z.preprocess(
      (v) => v,
      z.object({ task_id: z.number() })
    );
    const js = toolParametersToJsonSchema(schema);
    const props = js.properties as Record<string, any>;
    expect(props.reason).toBeDefined();
    expect((js.required as string[])).toContain("reason");
  });

  it("已是 JSON Schema 的入参：同样注入", () => {
    const js = toolParametersToJsonSchema({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a"],
    });
    const props = js.properties as Record<string, any>;
    expect(props.reason).toBeDefined();
    expect((js.required as string[])).toContain("reason");
    // 原有 required 保留
    expect((js.required as string[])).toContain("a");
  });

  it("工具已声明 reason 字段（task_cancel 业务 reason）：保留原描述 + 强制必填", () => {
    const js = toolParametersToJsonSchema(
      z.object({
        task_id: z.number(),
        reason: z.string().optional().describe("取消原因（可选）"),
      })
    );
    const props = js.properties as Record<string, any>;
    // 保留工具自己的描述
    expect(props.reason.description).toContain("取消原因");
    // 但强制必填
    expect((js.required as string[])).toContain("reason");
  });

  it("空 schema（z.unknown / 无属性）：也注入 reason", () => {
    const js = toolParametersToJsonSchema(z.unknown());
    expect((js.properties as Record<string, any>).reason).toBeDefined();
  });
});

describe("reason 前置校验：ToolValidator（Task #5422）", () => {
  let validator: ToolValidator;

  beforeEach(() => {
    validator = new ToolValidator();
    // 隔离：解除其他测试文件经 ToolComponent.init 接线的 ConfigComponent，
    // 否则其 tool.reason.required=true 默认值会覆盖模块级开关
    setToolReasonConfigComponent(null);
    setToolReasonRequired(true);
  });

  afterEach(() => {
    setToolReasonConfigComponent(null);
    setToolReasonRequired(true);
  });

  it("缺 reason：校验失败，错误信息含 reason", async () => {
    const tool = createMockTool(z.object({ name: z.string() }));
    const result = await validator.validate(tool, { name: "test" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("reason");
  });

  it("reason 为空字符串：校验失败", async () => {
    const tool = createMockTool(z.object({ name: z.string() }));
    const result = await validator.validate(tool, { name: "test", reason: "  " });
    expect(result.success).toBe(false);
    expect(result.error).toContain("reason");
  });

  it("reason 非字符串：校验失败", async () => {
    const tool = createMockTool(z.object({ name: z.string() }));
    const result = await validator.validate(tool, { name: "test", reason: 123 });
    expect(result.success).toBe(false);
    expect(result.error).toContain("reason");
  });

  it("带非空 reason：校验通过，其余参数正常解析", async () => {
    const tool = createMockTool(
      z.object({ name: z.string(), age: z.number().optional() })
    );
    const result = await validator.validate(tool, {
      name: "test",
      age: 25,
      reason: "查询用户信息",
    });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "test", age: 25 });
  });

  it("zod schema 未声明 reason（unknown key）：不阻塞校验", async () => {
    const tool = createMockTool(z.object({ name: z.string() }));
    const result = await validator.validate(tool, {
      name: "test",
      reason: "测试原因",
    });
    expect(result.success).toBe(true);
  });

  it("逃生开关关闭：缺 reason 不报错", async () => {
    setToolReasonRequired(false);
    expect(isToolReasonRequired()).toBe(false);
    const tool = createMockTool(z.object({ name: z.string() }));
    const result = await validator.validate(tool, { name: "test" });
    expect(result.success).toBe(true);
  });

  it("逃生开关关闭：schema 注入同步关闭", () => {
    setToolReasonRequired(false);
    const js = toolParametersToJsonSchema(z.object({ a: z.string() }));
    expect((js.properties as Record<string, any>).reason).toBeUndefined();
    expect((js.required as string[]) ?? []).not.toContain("reason");
  });
});
