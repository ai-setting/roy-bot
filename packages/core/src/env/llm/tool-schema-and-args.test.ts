/**
 * @fileoverview tool schema / tool args 健壮性测试（Task #4231）
 *
 * 覆盖两个真实线上故障（2026-10-15）：
 *
 * 1. **opencodego（openai-compatible）400**：
 *    `Invalid schema for function 'task_operation_create':
 *     Pointer '/definitions/zod/properties/milestone_type' does not exist`
 *    → `zodToJsonSchema(schema,"zod")` 产出 `$ref`+`definitions`，各处"解包"时
 *      丢掉了 `definitions`，但 `properties` 里还留着指向 definitions 的 `$ref`
 *      （同一 Zod 实例被复用时产生）→ 悬空指针 → strict 网关拒绝。
 *
 * 2. **tong（GLM-5.3-W4A8）工具参数乱码**：
 *    上游把模型原生文本工具调用标记 `<arg_key>/<arg_value>` 混进结构化
 *    `function.arguments`，并伴随重复字乱码 → 旧代码 `safeParseToolArgs` 静默返回
 *    `{}`，导致"拿空参数执行"或"执行乱码命令" + 模型盲目重试。
 */

import { describe, it, expect } from "bun:test";
import { z } from "zod";
import {
  toolParametersToJsonSchema,
  findDanglingRefs,
  isZodSchema,
} from "./tool-schema";
import {
  parseToolArgsStrict,
  salvageTextualToolArgs,
  stripTextualToolArgsMarkers,
  safeParseToolArgs,
} from "./tool-args-parser";
import {
  CreateOperationToolSchema,
  ListOperationsToolSchema,
  UpdateOperationToolSchema,
} from "../task/tools/operation/operation-types";

// ============================================================================
// 1. JSON Schema 转换：不能有悬空 $ref
// ============================================================================

describe("toolParametersToJsonSchema（Task #4231）", () => {
  it("task_operation_create：$ref 全部展开，action_type 带 enum（不再是悬空指针）", () => {
    const js = toolParametersToJsonSchema(CreateOperationToolSchema);

    // 不能再有 $ref / definitions / $schema
    expect(findDanglingRefs(js)).toEqual([]);
    expect(js.definitions).toBeUndefined();
    expect(js.$ref).toBeUndefined();
    expect(js.$schema).toBeUndefined();

    // 顶层必须是 object schema
    expect(js.type).toBe("object");
    const props = js.properties as Record<string, any>;
    expect(props).toBeDefined();

    // ★ 回归断言：action_type 必须是内联 enum（旧实现这里是
    //   {"$ref":"#/definitions/zod/properties/milestone_type"} ← 上游 400 的元凶）
    expect(props.action_type.$ref).toBeUndefined();
    expect(Array.isArray(props.action_type.enum)).toBe(true);
    expect(props.action_type.enum).toContain("milestone");
    // milestone_type 同样内联
    expect(props.milestone_type.$ref).toBeUndefined();
    expect(Array.isArray(props.milestone_type.enum)).toBe(true);
  });

  it("task_operation_list / update 也一样干净（同样共用枚举实例）", () => {
    for (const schema of [ListOperationsToolSchema, UpdateOperationToolSchema]) {
      const js = toolParametersToJsonSchema(schema);
      expect(findDanglingRefs(js)).toEqual([]);
      expect(js.type).toBe("object");
    }
  });

  it("已经是 JSON Schema 的入参：原地 deref，不改调用方对象", () => {
    const input = {
      $ref: "#/definitions/x",
      definitions: { x: { type: "object", properties: { a: { type: "string" } } } },
    };
    const out = toolParametersToJsonSchema(input);
    expect(out.type).toBe("object");
    expect((out.properties as any).a.type).toBe("string");
    // 调用方对象未被修改
    expect((input as any).$ref).toBe("#/definitions/x");
  });

  it("悬空 $ref 不会被原样透传（降级成宽松 object）", () => {
    const out = toolParametersToJsonSchema({
      type: "object",
      properties: { broken: { $ref: "#/definitions/does-not-exist" } },
    });
    expect(findDanglingRefs(out)).toEqual([]);
    expect((out.properties as any).broken.type).toBe("object");
  });

  it("循环 $ref 不死循环（自引用 schema）", () => {
    const out = toolParametersToJsonSchema({
      definitions: { node: { type: "object", properties: { next: { $ref: "#/definitions/node" } } } },
      $ref: "#/definitions/node",
    });
    expect(out.type).toBe("object");
    expect(findDanglingRefs(out)).toEqual([]);
  });

  it("null / 非法入参 → 空 object schema（绝不返回 null）", () => {
    expect(toolParametersToJsonSchema(null)).toEqual({ type: "object", properties: {} });
    expect(toolParametersToJsonSchema(42 as any)).toEqual({ type: "object", properties: {} });
    expect(toolParametersToJsonSchema("nope" as any)).toEqual({ type: "object", properties: {} });
  });

  it("普通 z.object()（无共享实例）也保持可用", () => {
    const js = toolParametersToJsonSchema(z.object({ a: z.string(), b: z.number().optional() }));
    expect(js.type).toBe("object");
    // Task #5422：reason 注入后 properties 多一个 reason
    expect(Object.keys(js.properties as object).sort()).toEqual(["a", "b", "reason"]);
    expect(findDanglingRefs(js)).toEqual([]);
  });

  it("zod 识别 helper", () => {
    expect(isZodSchema(z.object({}))).toBe(true);
    expect(isZodSchema({ type: "object" })).toBe(false);
    expect(isZodSchema(null)).toBe(false);
  });
});

// ============================================================================
// 2. tool 参数严格解析 + 上游退化格式抢救
// ============================================================================

describe("parseToolArgsStrict（Task #4231）", () => {
  it("合法 JSON 字符串 → 正常解析", () => {
    const r = parseToolArgsStrict('{"task_id": 1, "milestone_title": "x"}');
    expect(r.ok).toBe(true);
    expect(r.args.task_id).toBe(1);
  });

  it("对象入参 → 原样返回", () => {
    const r = parseToolArgsStrict({ a: 1 });
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({ a: 1 });
  });

  it("空字符串 → 合法空参数（无参工具）", () => {
    expect(parseToolArgsStrict("").ok).toBe(true);
  });

  it("★ 上游把 GLM 文本工具调用标记混进值里 → 剥离 marker 后恢复", () => {
    const garbled =
      '{"subagent_type":"roy","sub_session_id":"sub-session-_id</arg_key><arg_value>","timeout":1800000}';
    const r = parseToolArgsStrict(garbled);
    expect(r.ok).toBe(true);
    expect(r.salvaged).toBe(true);
    expect(r.args.subagent_type).toBe("roy");
    expect(String(r.args.sub_session_id)).not.toContain("arg_value");
  });

  it("★ 整段是 <arg_key>/<arg_value> 文本格式 → 重建 JSON 对象", () => {
    const textual =
      '<arg_key>description</arg_key><arg_value>调研 opencode 插件</arg_value>' +
      '<arg_key>subagent_type</arg_key><arg_value>roy</arg_value>';
    const r = parseToolArgsStrict(textual);
    expect(r.ok).toBe(true);
    expect(r.salvaged).toBe(true);
    expect(r.args.description).toBe("调研 opencode 插件");
    expect(r.args.subagent_type).toBe("roy");
  });

  it("★ 彻底损坏（重复字 + 全角括号乱码）→ ok=false，**不再静默当 {}**", () => {
    const garbage = '重启这个后台台任务「调研研 GitHu\uFF08\uFF08';
    const r = parseToolArgsStrict(garbage);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("不是合法 JSON");
    // 与旧行为对比：旧 parser 静默返回空对象（= 用空参数执行工具，危险）
    expect(safeParseToolArgs(garbage)).toEqual({});
  });

  it("失败时 error 里带原始片段（便于 trace/排查）", () => {
    const r = parseToolArgsStrict("{broken json");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("{broken json");
  });

  it("双层 stringify 仍兼容（旧行为不回归）", () => {
    const r = parseToolArgsStrict(JSON.stringify('{"a":1}'));
    expect(r.ok).toBe(true);
    expect(r.args).toEqual({ a: 1 });
  });

  it("salvage / strip helpers 单测", () => {
    expect(salvageTextualToolArgs("<arg_key>a</arg_key><arg_value>1</arg_value>")).toEqual({ a: 1 });
    expect(salvageTextualToolArgs("<arg_key>a</arg_key><arg_value>{\"x\":true}</arg_value>")).toEqual({
      a: { x: true },
    });
    expect(salvageTextualToolArgs("no markers")).toBeUndefined();
    expect(stripTextualToolArgsMarkers('"a</arg_key><arg_value>b"')).toBe('"ab"');
  });
});
