/**
 * @fileoverview executeTool "Tool not found" 必须显式可见 (TDD RED)
 *
 * 症状（生产 traceId=83eadac2316d5be7529ca42ce7057d63，2026-10-16）：
 *   compact 子 agent 的 LLM 调了 `bash`，但它的 allowedTools 只有
 *   ['workflow_submit_output']，于是 executeTool 返回
 *   `{"success":false,...,"error":"Tool not found: bash"}`。
 *
 *   问题在于**可观测性**：
 *   - span 的 status 是 `ok`（错误只在 result 里），`roy-bot debug trace --list`
 *     完全看不出异常；
 *   - 只有 logger.debug（默认 info 级别下根本不落盘）。
 *
 *   结果：compact 子 agent 每次压缩都静默失败 → 写出全空 checkpoint
 *   （"Untitled Checkpoint"）→ 657 条消息被归档且摘要为空。
 *   一直到人工翻 25GB trace DB 才发现。
 *
 * 修复：
 *   1. 找不到工具时打 ERROR 日志（含 agent 名 + 可用工具清单，便于对账 prompt/工具表）；
 *   2. `tool.error` 事件携带 availableTools / agentName，便于程序化诊断。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";
import { getTracerProvider, resetTracerProvider } from "../log-trace/opentelemetry/tracer-provider";
import { isQuietMode, setQuietMode } from "../log-trace/logger";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

function createMockEnv(components: Record<string, any>): Environment {
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => components[name]),
    listComponents: vi.fn(() => Object.keys(components)),
    handle_query: vi.fn(),
    handle_action: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    subscribeTo: vi.fn(() => () => {}),
    subscribeAll: vi.fn(() => () => {}),
    pushEnvEvent: vi.fn(),
  } as unknown as Environment;
}

describe("AgentComponent — Tool not found 必须打 ERROR 日志（可观测性）", () => {
  let agentComponent: AgentComponent;
  let mockEnv: Environment;
  let configComponent: ConfigComponent;
  let pushEnvEvent: ReturnType<typeof vi.fn>;
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;
  let llmComponent: any;
  let tempDir: string;
  let previousQuietMode: boolean;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-tool-not-found-test-"));

    configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", path.join(tempDir, "agents"));
    await configComponent.set("workspace_dir", "/home/test/workspace");
    fsSync.mkdirSync(path.join(tempDir, "agents"), { recursive: true });

    // 工具表里只有 read_file —— 没有 bash（模拟 compact 的 allowedTools 过滤结果）
    const toolComponent = {
      listTools: vi.fn(() => [
        { name: "read_file", description: "read a file", parameters: {} },
      ]),
      getTool: vi.fn((n: string) => (n === "read_file" ? { name: "read_file" } : undefined)),
    };

    const sessionComponent = {
      get: vi.fn(async (id: string) => ({ id, title: "t", metadata: {}, messageCount: 0 })),
      addMessage: vi.fn(async () => "msg_1"),
      addMessages: vi.fn(async () => ["msg_1"]),
      getMessages: vi.fn(async () => []),
      getContext: vi.fn(async () => ({ messages: [], checkpoint: undefined })),
      update: vi.fn(async () => true),
    };

    // LLM 第一轮要求调用 bash（表里没有）→ 之后返回纯文本结束
    let call = 0;
    llmComponent = {
      invoke: vi.fn(() => {
        call++;
        if (call === 1) {
          return Promise.resolve({
            output: {
              content: "",
              toolCalls: [
                {
                  id: "call_bash_1",
                  function: { name: "bash", arguments: JSON.stringify({ command: "ls" }) },
                },
              ],
            },
          });
        }
        return Promise.resolve({ output: { content: "done", toolCalls: [] } });
      }),
    };

    pushEnvEvent = vi.fn();
    mockEnv = createMockEnv({
      config: configComponent,
      session: sessionComponent,
      llm: llmComponent,
      tool: toolComponent,
    });
    (mockEnv as any).pushEnvEvent = pushEnvEvent;

    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // 日志的 console 输出受模块级全局 quietMode 控制，其它测试文件可能已把它设为 true
    // 且未复位（跨文件污染）。本文件断言 ERROR 日志会落到 console，故显式开启。
    previousQuietMode = isQuietMode();
    setQuietMode(false);

    agentComponent = new AgentComponent();
    await agentComponent.init({ env: mockEnv, options: { configComponent } } as any);
  });

  afterEach(() => {
    setQuietMode(previousQuietMode);
    consoleErrorSpy.mockRestore();
    vi.restoreAllMocks();
    resetTracerProvider();
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  it("找不到工具时应打 ERROR 日志，包含工具名 / agent 名 / 可用工具清单", async () => {
    agentComponent.registerAgent("compact", {
      type: "sub",
      systemPrompt: "checkpoint generator",
      allowedTools: ["read_file", "workflow_submit_output"],
      maxIterations: 2,
    });

    const result = await agentComponent.run("compact", "Generate a checkpoint.", {
      sessionId: "session_x",
    });

    // 1. 行为不变：LLM 确实请求了 bash
    expect(
      result.toolCalls.some((t: any) => (t.function?.name ?? t.name) === "bash")
    ).toBe(true);

    // ...且失败结果被回灌给了模型（AI SDK v6 需要 1:1 tool-call / tool-result 配对）
    const secondCallMessages = llmComponent.invoke.mock.calls[1]?.[0]?.messages ?? [];
    const toolResultPayload = JSON.stringify(secondCallMessages);
    expect(toolResultPayload).toContain("Tool not found: bash");

    // 2. 核心 RED 断言：必须打 ERROR 级别日志
    expect(consoleErrorSpy).toHaveBeenCalled();
    const errorOutput = consoleErrorSpy.mock.calls.map((c) => String(c[0] ?? "")).join("\n");
    expect(errorOutput).toContain("Tool not found");
    expect(errorOutput).toContain("bash");
    expect(errorOutput).toContain("compact"); // agent 名，便于定位是谁的 prompt 不一致

    // 3. 事件携带可用工具清单，便于对账 prompt / 工具表
    const toolErrorEvent = pushEnvEvent.mock.calls
      .map((c) => c[0])
      .find((e: any) => e?.type === "tool.error");
    expect(toolErrorEvent).toBeDefined();
    expect(toolErrorEvent.payload.toolName).toBe("bash");
    expect(toolErrorEvent.payload.agentName).toBe("compact");
    expect(toolErrorEvent.payload.availableTools).toEqual(["read_file"]);
  });

  it("executeTool 的 span 必须被标成 error（否则 debug trace --list 看不出来）", async () => {
    // 捕获 decorator 实际操作到的 span
    const captured: Array<{ name: string; end: any }> = [];
    const provider: any = getTracerProvider();
    vi.spyOn(provider, "getTracer").mockReturnValue({
      startSpan: (name: string) => {
        const span = { name, setAttribute: vi.fn(), end: vi.fn() };
        captured.push(span);
        return span;
      },
    } as any);

    agentComponent.registerAgent("compact", {
      type: "sub",
      systemPrompt: "checkpoint generator",
      allowedTools: ["read_file", "workflow_submit_output"],
      maxIterations: 2,
    });

    await agentComponent.run("compact", "Generate a checkpoint.", { sessionId: "session_x" });

    const executeSpans = captured.filter((s) => s.name === "agent.component.executeTool");
    expect(executeSpans.length).toBeGreaterThan(0);

    // 关键断言：Tool not found 的那次调用，span 以 ERROR 收尾
    // （span.status 由 end(result, error) 决定：error 存在 → ERROR）
    const failingEnd = executeSpans
      .flatMap((s) => s.end.mock.calls)
      .find(([, err]: any[]) => err !== undefined);
    expect(failingEnd).toBeDefined();
    expect(String((failingEnd as any)[1].message)).toBe("Tool not found: bash");
  });
});
