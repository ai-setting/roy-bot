/**
 * @fileoverview AgentComponent Memory Leak Regression Tests (Task #1580)
 *
 * 回归测试，覆盖 Task #1574 / #1580 诊断报告确认的两个内存问题：
 *   - P0-1: `doomLoopCaches` Map 每次 _run() 累积条目
 *   - P1-1: `systemPrompt` 字符串 .replace() bug + state mutation
 *
 * 所有测试在修复前应该失败（RED），修复后通过（GREEN）。
 *
 * 重要：每个测试用 20 次 `_run()` 验证多次调用后内部状态不增长，
 * 因为单次调用看不出泄漏。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Mock Helpers (复用与 variable-replace.test.ts 一致的模式)
// ============================================================================

function createMockSessionComponent() {
  const messages = new Map<string, any[]>();
  return {
    _messages: messages,
    addMessage: vi.fn(async (sessionId: string, msg: any) => {
      const sessionMessages = messages.get(sessionId) ?? [];
      sessionMessages.push({
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sessionID: sessionId,
        role: msg.role,
        content: msg.content,
        timestamp: Date.now(),
        parts: msg.parts,
        metadata: msg.metadata,
      });
      messages.set(sessionId, sessionMessages);
      return `msg_${Date.now()}`;
    }),
    getMessages: vi.fn(async (sessionId: string) => messages.get(sessionId) ?? []),
    getMessageCount: vi.fn(async (sessionId: string) => messages.get(sessionId)?.length ?? 0),
    getContext: vi.fn(async (sessionId: string) => ({
      messages: messages.get(sessionId) ?? [],
      checkpoint: undefined,
    })),
  };
}

function createMockLLMComponent() {
  return {
    invoke: vi.fn(() =>
      Promise.resolve({
        output: {
          content: "test response",
          toolCalls: [],
        },
      })
    ),
  };
}

function createMockMemoryComponent(recallResult: string = "FAKE_MEMORY_CONTENT") {
  return {
    recallMemory: vi.fn(async () => recallResult),
  };
}

function createMockEnv(opts: {
  configComponent: ConfigComponent;
  sessionComponent: any;
  llmComponent: any;
  memoryComponent?: any;
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
      if (name === "memory") return opts.memoryComponent;
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

// ============================================================================
// P0-1: per-run state cleanup tests
// ============================================================================

describe("AgentComponent memory cleanup (Task #1580 - P0)", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let sessionComponent: any;
  let llmComponent: any;
  let mockEnv: Environment;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-memleak-test-"));
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", path.join(tempDir, "agents"));
    fsSync.mkdirSync(path.join(tempDir, "agents"), { recursive: true });

    sessionComponent = createMockSessionComponent();
    llmComponent = createMockLLMComponent();
    mockEnv = createMockEnv({
      configComponent,
      sessionComponent,
      llmComponent,
    });

    await agentComponent.init({ env: mockEnv, options: { configComponent } } as any);
  });

  afterEach(async () => {
    try {
      await agentComponent.stop();
    } catch {}
    try {
      fsSync.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("doomLoopCaches does not leak entries across runs (P0-1 main fix)", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      systemPrompt: "You are a helpful assistant.",
      maxIterations: 1,
    });

    const doomCaches = (agentComponent as any).doomLoopCaches as Map<string, Map<string, number>>;
    const initial = doomCaches.size;

    // 跑 20 轮：每个 runId 都不同
    for (let i = 0; i < 20; i++) {
      await agentComponent.run("test-agent", `query-${i}`);
    }

    expect(doomCaches.size).toBe(initial);
  });

  it("aborted Map does not leak across runs (sibling of P0-1)", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      maxIterations: 1,
    });

    const aborted = (agentComponent as any).aborted as Map<string, boolean>;
    const initial = aborted.size;

    for (let i = 0; i < 20; i++) {
      await agentComponent.run("test-agent", `query-${i}`);
    }

    expect(aborted.size).toBe(initial);
  });

  it("abortControllers does not leak across runs (sibling of P0-1)", async () => {
    agentComponent.registerAgent("test-agent", {
      type: "primary",
      maxIterations: 1,
    });

    const abortControllers = (agentComponent as any).abortControllers as Map<string, AbortController>;
    const initial = abortControllers.size;

    for (let i = 0; i < 20; i++) {
      await agentComponent.run("test-agent", `query-${i}`);
    }

    expect(abortControllers.size).toBe(initial);
  });
});

// ============================================================================
// P1-1: systemPrompt mutation tests
// ============================================================================

describe("AgentComponent systemPrompt immutability (Task #1580 - P1)", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let sessionComponent: any;
  let llmComponent: any;
  let memoryComponent: any;
  let mockEnv: Environment;
  let tempDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    agentComponent = new AgentComponent();
    configComponent = new ConfigComponent();
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-memleak-test-"));
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", path.join(tempDir, "agents"));
    fsSync.mkdirSync(path.join(tempDir, "agents"), { recursive: true });

    sessionComponent = createMockSessionComponent();
    llmComponent = createMockLLMComponent();
    memoryComponent = createMockMemoryComponent("MEMORY_CONTENT");
    mockEnv = createMockEnv({
      configComponent,
      sessionComponent,
      llmComponent,
      memoryComponent,
    });

    await agentComponent.init({ env: mockEnv, options: { configComponent } } as any);
  });

  afterEach(async () => {
    try {
      await agentComponent.stop();
    } catch {}
    try {
      fsSync.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("systemPrompt is NOT mutated across runs (template preserved)", async () => {
    const originalPrompt = "{{workspace_dir}} | {{memory}}";
    agentComponent.registerAgent("template-agent", {
      type: "primary",
      systemPrompt: originalPrompt,
      maxIterations: 1,
    });

    // 跑多轮：每次都不应修改 agent.config.systemPrompt
    await agentComponent.run("template-agent", "query-1");
    await agentComponent.run("template-agent", "query-2");
    await agentComponent.run("template-agent", "query-3");

    // 修复前：BUG，因为 .replace() in-place mutation 会让 template 消失
    // 修复后：原始模板应保持不变
    const agent = (agentComponent as any).getAgent("template-agent");
    expect(agent.config.systemPrompt).toBe(originalPrompt);
  });

  it("systemPrompt {{memory}} placeholder is replaced in ALL occurrences (replaceAll, not replace)", async () => {
    // 验证：原始 prompt 含 3 个 {{memory}} 占位符
    const multiPlaceholder = "{{memory}} and {{memory}} and {{memory}}";
    agentComponent.registerAgent("multi-mem-agent", {
      type: "primary",
      systemPrompt: multiPlaceholder,
      maxIterations: 1,
    });

    await agentComponent.run("multi-mem-agent", "query");

    // 修复前：.replace() 只替换第一个 → systemPrompt 还含 2 个 {{memory}}
    //   LLM 看到的 system 消息: "MEMORY_CONTENT and {{memory}} and {{memory}}"
    // 修复后：.replaceAll() 替换全部 → system message 不含 {{memory}}
    expect(llmComponent.invoke).toHaveBeenCalled();
    const llmCall = llmComponent.invoke.mock.calls[0][0] as any;
    const messages = llmCall.messages || [];
    // system message 是第一个
    const systemMsg = messages.find((m: any) => m.role === "system");
    expect(systemMsg).toBeDefined();
    const systemContent = typeof systemMsg.content === "string"
      ? systemMsg.content
      : Array.isArray(systemMsg.content)
        ? systemMsg.content.map((p: any) => p.text || "").join("")
        : "";
    const memoryOccurrences = (systemContent.match(/\{\{memory\}\}/g) || []).length;
    expect(memoryOccurrences).toBe(0);
  });
});
