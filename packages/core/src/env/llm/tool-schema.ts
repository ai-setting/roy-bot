/**
 * @fileoverview Tool parameters → JSON Schema（**消除悬空 $ref**）Task #4231
 *
 * ## 背景（真实线上故障，2026-10-15）
 *
 * 切到 `opencodego`（openai-compatible）provider 后，sub-agent 直接失败：
 *
 * ```
 * Upstream request failed: [invalid_request_error]
 * Invalid schema for function 'task_operation_create':
 * Pointer '/definitions/zod/properties/milestone_type' does not exist
 * ```
 *
 * 根因：`zod-to-json-schema` 用 `zodToJsonSchema(schema, "zod")` 会把 schema 包成
 *
 * ```json
 * { "$ref": "#/definitions/zod", "definitions": { "zod": { ... } } }
 * ```
 *
 * 而各处的"解包"逻辑只把 `definitions.zod` 提出来当顶层 schema，**丢掉了
 * `definitions`**，但 `definitions.zod.properties` 里可能还有**指向 definitions 的
 * `$ref`**（同一 Zod 实例被复用时，例如 `milestone_type` 与 `action_type` 共用
 * 同一个 `z.enum(...)` 实例 → `action_type: {"$ref": "#/definitions/zod/properties/milestone_type"}`）。
 *
 * 解包后这些 `$ref` 就成了悬空指针：
 * - 宽松的 provider（Anthropic / 部分网关）容忍 → 一直没暴露；
 * - **strict 校验的 OpenAI 兼容网关（opencodego）直接 400**。
 *
 * ## 修法
 *
 * 统一走 `toolParametersToJsonSchema()`：
 * 1. Zod → JSON Schema（带 name 也不怕）
 * 2. **就地把所有 `$ref` 展开（dereference）**，支持
 *    `#/definitions/<name>`、`#/definitions/<name>/properties/<p>`、
 *    `#/$defs/...` 等指针，带环保护
 * 3. 丢掉 `definitions` / `$defs` / `$schema`，保证顶层是
 *    `{ type: "object", properties: {...} }`
 *
 * 换 provider / 换 SDK 都不会再因为 schema 指针炸掉。
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import { isToolReasonRequired } from "../tool/validator";

/** 判断是否是 Zod schema（zod v3/v4 都有 _def） */
export function isZodSchema(obj: unknown): boolean {
  return !!obj && typeof obj === "object" && "_def" in (obj as Record<string, unknown>);
}

/** 递归地把 schema 里的 `$ref` 全部就地展开 */
function dereference(
  node: unknown,
  root: Record<string, unknown>,
  seenRefs: Set<string> = new Set()
): unknown {
  if (Array.isArray(node)) {
    return node.map((n) => dereference(n, root, seenRefs));
  }
  if (!node || typeof node !== "object") return node;

  const obj = node as Record<string, unknown>;
  const ref = obj["$ref"];

  if (typeof ref === "string" && ref.startsWith("#/")) {
    // 环保护：同一个 ref 在一个分支上只展开一次
    if (seenRefs.has(ref)) {
      // 自引用（树状 schema 里少见）：退化成宽松对象，避免无限递归
      return { type: "object" };
    }
    const target = resolvePointer(root, ref);
    if (target === undefined) {
      // 悬空 ref → 丢成宽松对象，绝不把坏指针发给 provider
      return { type: "object" };
    }
    const nextSeen = new Set(seenRefs);
    nextSeen.add(ref);
    const resolved = dereference(target, root, nextSeen);
    // $ref 同级可能还有 description 等（draft-07 里应被忽略，这里合并更友好）
    const { $ref: _drop, ...rest } = obj;
    if (resolved && typeof resolved === "object" && !Array.isArray(resolved)) {
      return { ...(resolved as Record<string, unknown>), ...rest };
    }
    return resolved;
  }

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "definitions" || k === "$defs" || k === "$schema") continue;
    out[k] = dereference(v, root, seenRefs);
  }
  return out;
}

/** 解析 `#/a/b/c` 形式的 JSON Pointer */
function resolvePointer(root: Record<string, unknown>, ref: string): unknown {
  const path = ref.replace(/^#\//, "").split("/").filter((s) => s.length > 0);
  let cur: unknown = root;
  for (const rawSeg of path) {
    const seg = rawSeg.replace(/~1/g, "/").replace(/~0/g, "~");
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * 深度扫描：schema 里是否还有 `$ref`（测试/自检用）
 *
 * @returns 找到的 ref 列表（空数组 = 干净）
 */
export function findDanglingRefs(schema: unknown): string[] {
  const found: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "$ref" && typeof v === "string") found.push(v);
      else walk(v);
    }
  };
  walk(schema);
  return found;
}

/**
 * 把 tool 的 `parameters` 规范化成可以直接发给 provider 的 JSON Schema
 *
 * @param parameters Zod schema 或已经是 JSON Schema 的对象
 */
export function toolParametersToJsonSchema(
  parameters: unknown
): Record<string, unknown> {
  const EMPTY: Record<string, unknown> = {
    type: "object",
    properties: {},
  };
  if (parameters === null || parameters === undefined) return EMPTY;
  if (typeof parameters !== "object") return EMPTY;

  let raw: Record<string, unknown>;

  if (isZodSchema(parameters)) {
    try {
      raw = zodToJsonSchema(parameters as never, "zod") as Record<string, unknown>;
    } catch {
      return EMPTY;
    }
  } else {
    // 已经是 JSON Schema：浅拷贝后做 deref（不改调用方对象）
    raw = JSON.parse(JSON.stringify(parameters)) as Record<string, unknown>;
  }

  const deref = dereference(raw, raw) as Record<string, unknown>;

  // 顶层必须是 object schema（provider 对 tools[].function.parameters 的要求）
  if (deref["type"] !== "object") {
    if (deref["properties"] && typeof deref["properties"] === "object") {
      deref["type"] = "object";
    } else {
      // ★ Task #5422：降级成空 object 而非原样 EMPTY 返回，
      //   保证 reason 注入仍能生效（z.unknown / 联合等形态）
      const emptyWithReason: Record<string, unknown> = {
        type: "object",
        properties: {},
      };
      if (isToolReasonRequired()) {
        emptyWithReason["properties"] = {
          reason: {
            type: "string",
            description:
              "一句话说明为什么调用此工具（将随调用记录存入会话，便于事后追溯）",
          },
        };
        emptyWithReason["required"] = ["reason"];
      }
      return emptyWithReason;
    }
  }
  if (!deref["properties"] || typeof deref["properties"] !== "object") {
    deref["properties"] = {};
  }
  delete deref["definitions"];
  delete deref["$defs"];
  delete deref["$schema"];

  // ★ Task #5422：出口统一注入必填 `reason` 字段（B+C 方案的 B 半边）
  //
  // 所有来源（内置/task/memory/skill/workflow/MCP/插件）的模型可见
  // schema 都经过本函数（invoke.ts:826 + adapter-pi-ai.ts:662 两个
  // provider 通道），在此单点注入即可一网打尽，后续新增工具零成本。
  //
  // - 工具已声明 reason（如 task_cancel 的业务 reason）：保留其
  //   原有描述，仅强制 required；
  // - 逃生开关 tool.reason.required=false：完全跳过注入（与
  //   ToolValidator 的前置校验共用同一开关，语义一致）。
  if (isToolReasonRequired()) {
    const props = deref["properties"] as Record<string, unknown>;
    if (!props["reason"]) {
      props["reason"] = {
        type: "string",
        description:
          "一句话说明为什么调用此工具（将随调用记录存入会话，便于事后追溯）",
      };
    }
    const required = deref["required"];
    if (Array.isArray(required)) {
      if (!required.includes("reason")) required.push("reason");
    } else {
      deref["required"] = ["reason"];
    }
  }

  return deref;
}
