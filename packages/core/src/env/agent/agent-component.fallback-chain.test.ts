/**
 * @fileoverview Task #4724 — 多模型 fallback 链（有序列表）的 TDD 测试。
 *
 * 背景
 * ----
 * 现状（Task #4623 / #4682）只有**单层降级**：主模型失败 → 降级到唯一一个
 * fallback model → fallback 也失败就抛原始错误。用户需求（飞书原话）：
 *
 *   > 这个参数支持输出多个 model 列表，按照顺序作为优先级，
 *   > 可以尝试多个 model 的 fallback 兜底。
 *
 * 所以本次要把「单层降级」升级成「**链式降级**」：
 *
 *   primary 失败 → fallback[0] 失败 → fallback[1] 失败 → … → 全部失败才报错
 *
 * 覆盖的 6 个场景（与任务要求一一对应）：
 *
 *   1. 单模型向后兼容        —— `fallbackModel: "x"` 仍然只降级一层
 *   2. 多模型顺序 fallback  —— `fallbackModels: [a, b, c]` 按顺序逐个尝试
 *   3. config 列表          —— 配置 `llm.fallbackModels: [a, b]` 生效
 *   4. CLI 覆盖 config      —— 显式传入的列表**完全覆盖** config 列表
 *   5. 都未配                —— 没有配置时不做任何降级
 *   6. 全部模型失败报错      —— 链上所有模型都失败 → 抛**原始 primary 错误**
 *
 * @see ../../llm/model-fallback.ts —— 错误白名单判定（未改动）
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { AgentComponent } from "./agent-component";
import { ConfigComponent } from "../../config/config-component";
import type { Environment } from "../environment";

function createMockSessionComponent() {
  const sessions = new Map<string, any>();
  return {
    get: vi.fn(async (sessionId: string) => {
      if (sessions.has(sessionId)) return sessions.get(sessionId);
      const fresh = {
        id: sessionId,
        title: "test",
        directory: "/tmp",
        parentId: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: 0,
        metadata: {},
      };
      sessions.set(sessionId, fresh);
      return fresh;
    }),
    create: vi.fn(async (opts: any) => ({
      id: `sub_${sessions.size}`,
      parentSessionId: opts.parentSessionId ?? null,
      title: "test",
      directory: "/tmp",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messageCount: 0,
      metadata: opts.metadata || {},
    })),
    addMessage: vi.fn(async () => "msg_1"),
    addMessages: vi.fn(async () => undefined),
    getMessages: vi.fn(async () => []),
    getMessageCount: vi.fn(async () => 0),
    getContext: vi.fn(async () => ({ messages: [], checkpoint: undefined })),
    update: vi.fn(async () => true),
    list: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  };
}

function createMockEnv(opts: {
  configComponent: ConfigComponent;
  sessionComponent: any;
  llmComponent: any;
}): Environment {
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => {
      if (name === "session") return opts.sessionComponent;
      if (name === "config") return opts.configComponent;
      if (name === "llm") return opts.llmComponent;
      return undefined;
    }),
    hasComponent: vi.fn(),
    listComponents: vi.fn(() => []),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  } as unknown as Environment;
}

describe("Task #4724 — 多模型 fallback 链", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let sessionComponent: any;
  let llmComponent: any;
  let mockEnv: Environment;
  let tempDir: string;

  /** Records every `model` value the LLM component was invoked with. */
  let invokedModels: string[];

  const PRIMARY = "tong/GLM-5.3-Flash";

  beforeEach(async () => {
    vi.clearAllMocks();
    invokedModels = [];

    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-fallback-chain-"));
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", path.join(tempDir, "agents"));
    fsSync.mkdirSync(path.join(tempDir, "agents"), { recursive: true });

    sessionComponent = createMockSessionComponent();
    llmComponent = {
      invoke: vi.fn(async (req: any) => {
        invokedModels.push(req?.model);
        return { output: { content: "ok", toolCalls: [] } };
      }),
    };
    mockEnv = createMockEnv({ configComponent, sessionComponent, llmComponent });

    await agentComponent.init({ env: mockEnv, options: { configComponent } } as any);

    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 1,
    });
  });

  afterEach(async () => {
    try {
      await agentComponent.stop();
    } catch {}
    try {
      fsSync.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  /**
   * 让指定的模型全部失败，其余成功；记录每一次 attempt 的模型。
   *
   * @param failingModels - 抛错的模型集合
   * @param error - 抛出的错误（默认 404，命中 fallback 白名单）
   */
  function failOn(failingModels: string[], error: unknown = new Error("404 Page not found")) {
    const failSet = new Set(failingModels);
    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      if (failSet.has(req?.model)) throw error;
      return { output: { content: "recovered", toolCalls: [] } };
    });
  }

  // ==========================================================================
  // 场景 1：单模型向后兼容
  // ==========================================================================
  test("场景1：单模型 fallbackModel 仍然只降级一层（向后兼容）", async () => {
    failOn([PRIMARY, "minimax/MiniMax-M3"]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModel: "minimax/MiniMax-M3",
    } as any);

    // 只有 primary + 1 个 fallback，共 2 次 attempt
    expect(invokedModels).toEqual([PRIMARY, "minimax/MiniMax-M3"]);
    expect(result.error).toBeDefined();
    // 抛的是**原始 primary 错误**（保留 404 技术细节）
    expect(result.error).toContain("404");
  });

  test("场景1b：单模型 fallbackModel 成功时正常返回", async () => {
    failOn([PRIMARY]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModel: "minimax/MiniMax-M3",
    } as any);

    expect(invokedModels).toEqual([PRIMARY, "minimax/MiniMax-M3"]);
    expect(result.error).toBeUndefined();
    expect(result.finalText).toContain("recovered");
  });

  // ==========================================================================
  // 场景 2：多模型顺序 fallback
  // ==========================================================================
  test("场景2：fallbackModels 列表按顺序逐个尝试", async () => {
    failOn([PRIMARY, "a/M1", "b/M2"]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModels: ["a/M1", "b/M2", "c/M3"],
    } as any);

    // 顺序必须严格是 primary → a/M1 → b/M2 → c/M3
    expect(invokedModels).toEqual([PRIMARY, "a/M1", "b/M2", "c/M3"]);
    expect(result.error).toBeUndefined();
    expect(result.finalText).toContain("recovered");
  });

  test("场景2b：第一个 fallback 成功就不继续尝试后面的", async () => {
    failOn([PRIMARY]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModels: ["a/M1", "b/M2", "c/M3"],
    } as any);

    expect(invokedModels).toEqual([PRIMARY, "a/M1"]);
    expect(result.error).toBeUndefined();
  });

  test("场景2c：链上所有 fallback 都失败 → 抛原始 primary 错误", async () => {
    failOn([PRIMARY, "a/M1", "b/M2", "c/M3"]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModels: ["a/M1", "b/M2", "c/M3"],
    } as any);

    expect(invokedModels).toEqual([PRIMARY, "a/M1", "b/M2", "c/M3"]);
    expect(result.error).toBeDefined();
    // 原始 primary 错误（404），不是最后一个 fallback 的错误
    expect(result.error).toContain("404");
  });

  // ==========================================================================
  // 场景 3：config 列表
  // ==========================================================================
  test("场景3：配置 llm.fallbackModels 列表生效", async () => {
    await configComponent.set("llm.fallbackModels", ["a/M1", "b/M2"]);
    failOn([PRIMARY, "a/M1"]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
    } as any);

    expect(invokedModels).toEqual([PRIMARY, "a/M1", "b/M2"]);
    expect(result.error).toBeUndefined();
  });

  test("场景3b：配置数组优先于旧的单值 llm.fallbackModel", async () => {
    await configComponent.set("llm.fallbackModels", ["a/M1"]);
    await configComponent.set("llm.fallbackModel", "legacy/M0");
    failOn([PRIMARY]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
    } as any);

    expect(invokedModels).toEqual([PRIMARY, "a/M1"]);
    expect(invokedModels).not.toContain("legacy/M0");
    expect(result.error).toBeUndefined();
  });

  test("场景3c：旧的单值 llm.fallbackModel 仍然生效（向后兼容）", async () => {
    await configComponent.set("llm.fallbackModel", "legacy/M0");
    failOn([PRIMARY]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
    } as any);

    expect(invokedModels).toEqual([PRIMARY, "legacy/M0"]);
    expect(result.error).toBeUndefined();
  });

  test("场景3d：配置值是逗号分隔的**字符串**（环境变量形态）也生效", async () => {
    // LLM_FALLBACK_MODELS=a/M1,b/M2 只能给字符串，config 里也允许写字符串。
    await configComponent.set("llm.fallbackModels", "a/M1,b/M2" as any);
    failOn([PRIMARY, "a/M1"]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
    } as any);

    expect(invokedModels).toEqual([PRIMARY, "a/M1", "b/M2"]);
    expect(result.error).toBeUndefined();
  });

  test("场景3e：配置数组里的空项被跳过（不产生空模型调用）", async () => {
    await configComponent.set("llm.fallbackModels", ["", "  ", "a/M1"]);
    failOn([PRIMARY]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
    } as any);

    expect(invokedModels).toEqual([PRIMARY, "a/M1"]);
    expect(result.error).toBeUndefined();
  });

  // ==========================================================================
  // 场景 4：CLI 覆盖 config
  // ==========================================================================
  test("场景4：显式传入的 fallbackModels 完全覆盖 config 列表", async () => {
    await configComponent.set("llm.fallbackModels", ["cfg/M1", "cfg/M2"]);
    failOn([PRIMARY]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModels: ["cli/M1"],
    } as any);

    // 只用了 CLI 的列表，config 的一个都没用
    expect(invokedModels).toEqual([PRIMARY, "cli/M1"]);
    expect(invokedModels).not.toContain("cfg/M1");
    expect(invokedModels).not.toContain("cfg/M2");
    expect(result.error).toBeUndefined();
  });

  test("场景4b：单值 fallbackModel 也覆盖 config 列表", async () => {
    await configComponent.set("llm.fallbackModels", ["cfg/M1", "cfg/M2"]);
    failOn([PRIMARY]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModel: "cli/M1",
    } as any);

    expect(invokedModels).toEqual([PRIMARY, "cli/M1"]);
    expect(invokedModels).not.toContain("cfg/M1");
    expect(result.error).toBeUndefined();
  });

  test("场景4c：显式值无效（如 \"provider/\"）→ 不穿透到 config（review MINOR-3）", async () => {
    // 语义：显式优先 = 显式决定一切。用户显式传了一个**无效**的兜底值，
    // 就该按「没配兜底」处理，而不是悄悄回落到 config 的兜底链。
    await configComponent.set("llm.fallbackModels", ["cfg/M1"]);
    failOn([PRIMARY]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModels: ["provider/"], // 只有 provider 前缀，没有 modelId → 残值
    } as any);

    // config 的 cfg/M1 **不应**被使用
    expect(invokedModels).toEqual([PRIMARY]);
    expect(invokedModels).not.toContain("cfg/M1");
    expect(result.error).toContain("404");
  });

  test("场景4d：显式列表里的重复项被去重（review MINOR-4）", async () => {
    failOn([PRIMARY, "a/M1"]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModels: ["a/M1", "a/M1", "b/M2"],
    } as any);

    // a/M1 只应被试一次（去重），而不是两次
    expect(invokedModels).toEqual([PRIMARY, "a/M1", "b/M2"]);
    expect(result.error).toBeUndefined();
  });

  test("场景4e：显式**单值**无效（\"provider/\"）→ 也不穿透到 config（review2 MINOR-4）", async () => {
    // 与场景4c（数组形态）对称：单值形态也必须「显式决定一切」
    await configComponent.set("llm.fallbackModels", ["cfg/M1"]);
    failOn([PRIMARY]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModel: "provider/", // 只有 provider 前缀，没有 modelId → 残值
    } as any);

    expect(invokedModels).toEqual([PRIMARY]);
    expect(invokedModels).not.toContain("cfg/M1");
    expect(result.error).toContain("404");
  });

  test("场景5c：显式空数组 = 显式禁用兜底，**不**回落 config（review2 MINOR-3）", async () => {
    // ⚠️ 语义澄清（测试名与实现对齐）：
    //   `fallbackModels: []` 是一个**显式**的空列表 —— 与「完全没传」不同。
    //   显式优先 = 显式决定一切 → 不回落 config。
    //   （「完全没传」是 undefined，走 config —— 见场景3。）
    await configComponent.set("llm.fallbackModels", ["cfg/M1"]);
    failOn([PRIMARY]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModels: [],
    } as any);

    expect(invokedModels).toEqual([PRIMARY]);
    expect(invokedModels).not.toContain("cfg/M1");
    expect(result.error).toContain("404");
  });

  // ==========================================================================
  // 场景 5：都未配
  // ==========================================================================
  test("场景5：既没 CLI 也没 config → 不做任何降级，直接抛原始错误", async () => {
    failOn([PRIMARY]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
    } as any);

    expect(invokedModels).toEqual([PRIMARY]);
    expect(result.error).toBeDefined();
    expect(result.error).toContain("404");
  });

  test("场景5b：未传 fallbackModels（undefined）→ 走 config 的兜底链", async () => {
    // ⚠️ 与「场景5c：显式空数组」区分：
    //   undefined = 完全没传 → 回落 config；[] = 显式空列表 → 禁用兜底。
    await configComponent.set("llm.fallbackModels", ["cfg/M1"]);
    failOn([PRIMARY]);

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
    } as any);

    expect(invokedModels).toEqual([PRIMARY, "cfg/M1"]);
    expect(result.error).toBeUndefined();
  });

  // ==========================================================================
  // 场景 6：全部失败报错 + 错误语义保持
  // ==========================================================================
  test("场景6：401 不触发任何降级（认证失败换模型也没用）", async () => {
    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      throw new Error("401 Unauthorized");
    });

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModels: ["a/M1", "b/M2"],
    } as any);

    expect(invokedModels).toEqual([PRIMARY]);
    expect(result.error).toContain("401");
  });

  test("场景6b：主模型成功时完全不碰 fallback 链", async () => {
    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModels: ["a/M1", "b/M2"],
    } as any);

    expect(invokedModels).toEqual([PRIMARY]);
    expect(result.error).toBeUndefined();
  });

  test("场景6c：链中某个 fallback 命中 ContextError 时原样抛出（不继续降级）", async () => {
    // 第一个 fallback 抛 ContextError（上下文超限）→ 必须原样上抛，
    // 让 ContextHandler 的自动压缩链路接管，而不是继续试下一个模型。
    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      if (req?.model === PRIMARY) throw new Error("404 Page not found");
      const { ContextError } = await import("../errors");
      throw new ContextError("context window exceeded");
    });

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModels: ["a/M1", "b/M2"],
    } as any);

    expect(invokedModels).toEqual([PRIMARY, "a/M1"]);
    expect(result.error).toContain("context");
  });

  test("场景6d：链中 fallback 失败时继续尝试下一个（不因单个失败中断）", async () => {
    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      if (req?.model === PRIMARY) throw new Error("404 Page not found");
      if (req?.model === "a/M1") throw new Error("500 a broken");
      return { output: { content: "recovered", toolCalls: [] } };
    });

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModels: ["a/M1", "b/M2"],
    } as any);

    expect(invokedModels).toEqual([PRIMARY, "a/M1", "b/M2"]);
    expect(result.error).toBeUndefined();
    expect(result.finalText).toContain("recovered");
  });

  // ==========================================================================
  // abort 复检（★ review2 MINOR-4 — 兜底链中途被取消时不该继续试下一个）
  // ==========================================================================
  test("场景8：兜底链中途 abort → 不再发起后续兜底请求", async () => {
    // 模拟：primary 失败 → 试 F1；F1 失败后用户按了 Ctrl-C（abort 被置位）
    // → 期望 **F2 不会被调用**。
    const abortController = new AbortController();

    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      if (req?.model === PRIMARY) throw new Error("404 Page not found");
      if (req?.model === "a/M1") {
        // F1 失败的同时触发 abort（模拟用户在 F1 等待期间按 Ctrl-C）
        abortController.abort();
        throw new Error("503 service unavailable");
      }
      return { output: { content: "recovered", toolCalls: [] } };
    });

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      fallbackModels: ["a/M1", "b/M2"],
      abort: abortController.signal,
    } as any);

    // F2 **不应**被调用
    expect(invokedModels).toEqual([PRIMARY, "a/M1"]);
    expect(invokedModels).not.toContain("b/M2");
    expect(result.error).toBeDefined();
  });

  // ==========================================================================
  // delegate 边界：显式禁用兜底要传给子 agent（review3 MINOR）
  // ==========================================================================
  test("场景9：显式禁用兜底（空数组）→ 传给工具的 context 带空数组标记（子 agent 也禁用）", async () => {
    const captured: Array<{ model?: string; fallbackModel?: string; fallbackModels?: string[] }> = [];
    const captureTool = {
      name: "capture_ctx",
      description: "capture tool context",
      parameters: {} as any,
      execute: async (_args: unknown, toolCtx: any) => {
        captured.push({
          model: toolCtx.model,
          fallbackModel: toolCtx.fallbackModel,
          fallbackModels: toolCtx.fallbackModels,
        });
        return { success: true, output: "captured" };
      },
    };

    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 3,
    });

    let call = 0;
    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      call += 1;
      if (call === 1) {
        return {
          output: {
            content: "",
            toolCalls: [
              {
                id: "tc_1",
                name: "capture_ctx",
                arguments: {},
                function: { name: "capture_ctx", arguments: "{}" },
              },
            ],
          },
        };
      }
      return { output: { content: "done", toolCalls: [] } };
    });

    await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      // 显式空数组 = 显式禁用兜底（不回落 config）
      fallbackModels: [],
      extraTools: [captureTool],
    } as any);

    expect(captured).toHaveLength(1);
    // 关键：必须带**空数组**这个显式标记，子 agent 才知道「禁用」而不是「未配置」
    expect(captured[0]?.fallbackModels).toEqual([]);
  });

  test("场景9b：未传 fallbackModels → 不带该 key（子 agent 仍可回落 config）", async () => {
    const captured: Array<{ hasKey: boolean; value?: string[] }> = [];
    const captureTool = {
      name: "capture_ctx",
      description: "capture tool context",
      parameters: {} as any,
      execute: async (_args: unknown, toolCtx: any) => {
        captured.push({
          hasKey: "fallbackModels" in toolCtx,
          value: toolCtx.fallbackModels,
        });
        return { success: true, output: "captured" };
      },
    };

    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 3,
    });

    let call = 0;
    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      call += 1;
      if (call === 1) {
        return {
          output: {
            content: "",
            toolCalls: [
              {
                id: "tc_1",
                name: "capture_ctx",
                arguments: {},
                function: { name: "capture_ctx", arguments: "{}" },
              },
            ],
          },
        };
      }
      return { output: { content: "done", toolCalls: [] } };
    });

    await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      extraTools: [captureTool],
    } as any);

    expect(captured).toHaveLength(1);
    // 完全没传 → 不带 key（子 agent 按「未配置」处理，可回落 config）
    expect(captured[0]?.hasKey).toBe(false);
  });

  // ==========================================================================
  // sticky 断点续跑（★ review MINOR-6 — 核心新增语义必须有测试锁住）
  // ==========================================================================
  test("场景7：sticky 断点续跑 —— iter2 从 remaining 继续（primary 在兜底链里也不会被重试）", async () => {    // maxIterations: 2 → 会产生两次 invokeLLM 调用。
    // 期望的调用序列：
    //   iter1: primary 挂 → 试 a/M1（成功）→ state = {active: a/M1, remaining: [b/M2]}
    //   iter2: a/M1 挂 → **不重试 primary、不重试 a/M1** → 直接试 b/M2（成功）
    //
    // ⚠️ 如果实现把 sticky.remaining 错写成 configuredFallbacks（从头再来），
    //    本测试会变红 —— 这正是它存在的意义。
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 2,
    });

    let call = 0;
    const noopTool = {
      name: "noop_tool",
      description: "no-op tool used to trigger a second iteration",
      parameters: {} as any,
      execute: async () => ({ success: true, output: "ok" }),
    };
    llmComponent.invoke = vi.fn(async (req: any) => {
      invokedModels.push(req?.model);
      call += 1;
      // iter1：primary 失败
      if (call === 1 && req?.model === PRIMARY) throw new Error("404 Page not found");
      // iter1：a/M1 成功（返回 tool call 以触发第二轮迭代）
      if (call === 2) {
        return {
          output: {
            content: "",
            toolCalls: [
              {
                id: "tc_1",
                name: "noop_tool",
                arguments: {},
                function: { name: "noop_tool", arguments: "{}" },
              },
            ],
          },
        };
      }
      // iter2：a/M1 失败。
      // ⚠️ 错误文案必须**命中 fallback 白名单**才会继续降级：
      //   #4682 收紧了 5xx 判定（不再用裸 `\b5\d{2}\b`，避免把
      //   "max_tokens 500 must be <= 4096" 误判），所以这里用
      //   "503 service unavailable"（带服务语义，一定命中）。
      if (req?.model === "a/M1") throw new Error("503 service unavailable");
      // iter2：b/M2 成功
      return { output: { content: "recovered", toolCalls: [] } };
    });

    const result = await agentComponent.run("test-agent", "hi", {
      model: PRIMARY,
      // ⚠️ 刻意把 PRIMARY 也放进兜底链 —— 这是 `sticky.remaining` 与
      //   「每次重新算 configuredFallbacks.filter(≠activeModel)」唯一会分歧的场景：
      //   若 iter2 不用 remaining 而是从头重算，filter 只会剔掉当前 activeModel
      //   (a/M1)，**已经死掉的 PRIMARY 会被重新试一次**（白等一次失败）。
      //   正确行为是：iter2 直接从 remaining=[b/M2] 继续，PRIMARY 不再出现。
      fallbackModels: [PRIMARY, "a/M1", "b/M2"],
      extraTools: [noopTool],
    } as any);

    // 严格断言调用序列：primary 只出现一次，a/M1 出现两次（iter1 成功 + iter2 失败），
    // b/M2 出现一次（iter2 断点续跑）。**没有**第二次 primary。
    expect(invokedModels).toEqual([PRIMARY, "a/M1", "a/M1", "b/M2"]);
    // primary 只出现一次（iter1 失败后 iter2 不会回头再撞它）
    expect(invokedModels.filter((m) => m === PRIMARY)).toHaveLength(1);
    expect(result.error).toBeUndefined();
  });
});
