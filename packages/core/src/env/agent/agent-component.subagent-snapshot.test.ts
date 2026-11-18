/**
 * @fileoverview AgentComponent — cacheSnapshot scope isolation (TDD RED)
 *
 * 症状（生产 traceId=83eadac2316d5be7529ca42ce7057d63，2026-10-16）：
 *   session 超上下文阈值 → 自动压缩 → SessionComponent.compact() 调
 *   `agentComponent.run("compact", ..., { sessionId: <父 session> })`。
 *
 *   compact 是内置 sub agent（systemPromptRef='compact'、allowedTools=['workflow_submit_output']），
 *   但它为了读父 session 全量历史而复用了父 session 的 sessionId。
 *
 *   `_loadOrCreateCacheSnapshot(sessionId)` 命中父 session 已有的 snapshot（内容是
 *   default 接待员 prompt），于是 `systemPromptOverride` 把 compact 自己的 prompt 覆盖掉了。
 *
 *   结果：compact 子 agent 拿着「接待员」prompt（里面写着 "`bash` — 执行简单 shell 命令"、
 *   "delegate_task 是你的主要执行工具"）去调 bash → `Tool not found: bash`
 *   → maxIterations=1 直接结束 → 生成全空 checkpoint（"Untitled Checkpoint"）
 *   → 657 条消息被归档且摘要为空（上下文永久丢失）。
 *
 *   同源证据：compact-hint 的 finalText 也是 "You are the Roy receptionist agent ..."。
 *
 * 修复：cacheSnapshot 是给 **primary** agent 复用的 prompt-cache 优化。
 * 子 agent（compact / compact-hint / json-extract / ...）即使复用父 sessionId，
 * 也必须用它们自己的 system prompt。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Mock Helpers（复用 agent-component.cache-scope.test.ts 模式）
// ============================================================================

interface MockSessionState {
  messages: any[];
  metadata: Record<string, unknown>;
}

function createMockSessionComponent() {
  const sessions = new Map<string, MockSessionState>();
  return {
    _sessions: sessions,
    get: vi.fn(async (sessionId: string) => {
      const state = sessions.get(sessionId) ?? { messages: [], metadata: {} };
      sessions.set(sessionId, state);
      return {
        id: sessionId,
        title: "test",
        directory: "/tmp",
        parentId: undefined,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        messageCount: state.messages.length,
        metadata: state.metadata,
      };
    }),
    addMessage: vi.fn(async (sessionId: string, msg: any) => {
      const state = sessions.get(sessionId) ?? { messages: [], metadata: {} };
      state.messages.push({
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sessionID: sessionId,
        role: msg.role,
        content: msg.content,
        timestamp: Date.now(),
        parts: msg.parts,
      });
      sessions.set(sessionId, state);
      return "msg_ok";
    }),
    addMessages: vi.fn(async (sessionId: string, msgs: any[]) => {
      const state = sessions.get(sessionId) ?? { messages: [], metadata: {} };
      for (const msg of msgs) {
        state.messages.push({
          id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          sessionID: sessionId,
          role: msg.role,
          content: msg.content,
          timestamp: Date.now(),
          parts: msg.parts,
        });
      }
      sessions.set(sessionId, state);
      return state.messages.length;
    }),
    getMessages: vi.fn(async (sessionId: string) => sessions.get(sessionId)?.messages ?? []),
    getMessageCount: vi.fn(async (sessionId: string) => sessions.get(sessionId)?.messages.length ?? 0),
    getContext: vi.fn(async (sessionId: string) => ({
      messages: sessions.get(sessionId)?.messages ?? [],
      checkpoint: undefined,
    })),
    update: vi.fn(async (sessionId: string, updates: any) => {
      const state = sessions.get(sessionId) ?? { messages: [], metadata: {} };
      if (updates.metadata) {
        state.metadata = { ...state.metadata, ...updates.metadata };
      }
      sessions.set(sessionId, state);
      return true;
    }),
    archiveMessages: vi.fn(async () => 0),
    saveCheckpoint: vi.fn(async () => {}),
  };
}

function createMockLLMComponent() {
  return {
    invoke: vi.fn(() =>
      Promise.resolve({ output: { content: "test response", toolCalls: [] } })
    ),
  };
}

function createMockEnv(
  sessionComponent: any,
  configComponent: ConfigComponent,
  llmComponent: any,
  memoryComponent?: any
): Environment {
  return {
    name: "test-env",
    version: "1.0.0",
    getConfig: vi.fn(() => ({ name: "test-env", version: "1.0.0", enabled: true })),
    registerComponent: vi.fn(),
    unregisterComponent: vi.fn(),
    getComponent: vi.fn((name: string) => {
      if (name === "session") return sessionComponent;
      if (name === "config") return configComponent;
      if (name === "llm") return llmComponent;
      if (name === "memory") return memoryComponent;
      return undefined;
    }),
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
// Tests
// ============================================================================

describe("AgentComponent — cacheSnapshot 不得跨 agent 泄漏 (sub-agent 复用父 session)", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let sessionComponent: any;
  let llmComponent: any;
  let tempDir: string;

  const PARENT_PROMPT = "你是 Roy 接待智能体。你可以用 bash 执行 shell 命令。";
  const SUB_PROMPT = "你是 Session Checkpoint Generator。调用 workflow_submit_output 提交结果。";

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-snapshot-scope-test-"));
    configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", path.join(tempDir, "agents"));
    await configComponent.set("workspace_dir", "/home/test/workspace");
    fsSync.mkdirSync(path.join(tempDir, "agents"), { recursive: true });

    sessionComponent = createMockSessionComponent();
    llmComponent = createMockLLMComponent();
    const memoryComponent = { recallMemory: vi.fn(async () => "memory-content") };

    agentComponent = new AgentComponent();
    await agentComponent.init({
      env: createMockEnv(sessionComponent, configComponent, llmComponent, memoryComponent),
      options: { configComponent },
    } as any);
  });

  afterEach(() => {
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  function systemPromptOfCall(callIndex: number): string {
    const call = llmComponent.invoke.mock.calls[callIndex];
    const messages = call?.[0]?.messages ?? [];
    return messages
      .filter((m: any) => m.role === "system")
      .map((m: any) => {
        if (typeof m.content === "string") return m.content;
        if (Array.isArray(m.content)) return m.content.map((p: any) => p.text ?? "").join("");
        return "";
      })
      .join("\n---\n");
  }

  it("sub agent 复用父 session 的 sessionId 时，必须使用自己的 systemPrompt（不被父 snapshot 覆盖）", async () => {
    const sessionId = "session_shared";

    // 1. primary agent 先跑一轮 → 写入内存快照
    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PARENT_PROMPT,
      maxIterations: 1,
    });
    await agentComponent.run("default", "hello", { sessionId });

    // 快照确实存在（★ Task #5224：内存 Map，不再是 session.metadata）
    expect((agentComponent as any)._cacheSnapshots?.get(sessionId)).toBeDefined();

    // 2. sub agent（模拟 compact）复用同一个 sessionId 读取父 session 历史
    agentComponent.registerAgent("compact", {
      type: "sub",
      systemPrompt: SUB_PROMPT,
      allowedTools: ["workflow_submit_output"],
      maxIterations: 1,
    });
    await agentComponent.run("compact", "Generate a checkpoint.", { sessionId, persistSession: false });

    // 3. 核心断言：sub agent 的 LLM 调用拿到的是自己的 prompt
    expect(llmComponent.invoke).toHaveBeenCalledTimes(2);
    const subSystemPrompt = systemPromptOfCall(1);

    expect(subSystemPrompt).toContain("Session Checkpoint Generator");
    expect(subSystemPrompt).not.toContain("Roy 接待智能体");

    // 反向断言：primary 那一轮仍然是父 prompt（不能把快照能力整体砍掉）
    expect(systemPromptOfCall(0)).toContain("Roy 接待智能体");
  });

  it("primary agent 仍然复用 session snapshot（{{memory}} 只算一次）", async () => {
    const sessionId = "session_primary";
    const memoryComponent = (agentComponent as any)._env ?? undefined; // 仅占位，避免 lint
    void memoryComponent;

    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: `记忆: {{memory}}\n${PARENT_PROMPT}`,
      maxIterations: 1,
    });

    await agentComponent.run("default", "q1", { sessionId });
    await agentComponent.run("default", "q2", { sessionId });

    const first = systemPromptOfCall(0);
    const second = systemPromptOfCall(1);

    // primary 的 snapshot 行为保持不变：两轮字节级一致
    expect(first).toContain("memory-content");
    expect(second).toBe(first);
  });
});
