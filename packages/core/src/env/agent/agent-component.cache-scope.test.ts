/**
 * @fileoverview AgentComponent Cache Scope Tests (TDD RED)
 *
 * 测试 additionInfo + {{memory}} 在 session 持续期间保持 session-scope 稳定。
 *
 * 背景（来自 Task #2737 报告 §3 + 用户核心洞察）：
 * - 现状：additionInfo 每次 buildMessages 重新读取 ctx.context.additionInfo，
 *   {{memory}} 每次 _run 重新调用 recallMemory()，导致 system prompt 字节级不稳定
 *   → LLM prompt cache 在 Anthropic/DeepSeek/GLM 命中率极低（实测 0-5%）。
 * - 目标：additionInfo + {{memory}} 改为 session-scope 常量，第一轮算一次，
 *   session 持续期间保持字节级一致 → cache 命中率对齐 pi-agent 96.6-96.8%。
 *
 * TDD 三个核心 RED 测试：
 * - T1: additionInfo 跨 4 轮字节级一致
 * - T2: {{memory}} 跨 4 轮字节级一致（recallMemory 仅调用 1 次）
 * - T3: session 内快照保持（内存级，不重新计算；不落库）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Mock Helpers (复用 variable-replace.test.ts 模式)
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
      const state = sessions.get(sessionId);
      if (!state) {
        // Simulate SQLite: create a new session row on first access
        const newState: MockSessionState = {
          messages: [],
          metadata: {},
        };
        sessions.set(sessionId, newState);
        return {
          id: sessionId,
          title: "test",
          directory: "/tmp",
          parentId: undefined,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messageCount: 0,
          metadata: newState.metadata,
        };
      }
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
      const message = {
        id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        sessionID: sessionId,
        role: msg.role,
        content: msg.content,
        timestamp: Date.now(),
        parts: msg.parts,
        metadata: msg.metadata,
      };
      state.messages.push(message);
      sessions.set(sessionId, state);
      return message.id;
    }),
    addMessages: vi.fn(async (sessionId: string, msgs: any[]) => {
      const state = sessions.get(sessionId) ?? { messages: [], metadata: {} };
      for (const msg of msgs) {
        const message = {
          id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          sessionID: sessionId,
          role: msg.role,
          content: msg.content,
          timestamp: Date.now(),
          parts: msg.parts,
          metadata: msg.metadata,
        };
        state.messages.push(message);
      }
      sessions.set(sessionId, state);
      return state.messages.length;
    }),
    getMessages: vi.fn(async (sessionId: string) => {
      return sessions.get(sessionId)?.messages ?? [];
    }),
    getMessageCount: vi.fn(async (sessionId: string) => {
      return sessions.get(sessionId)?.messages.length ?? 0;
    }),
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

function createMockMemoryComponent(recallResult?: string) {
  return {
    recallMemory: vi.fn(
      async () => recallResult ?? "Project summary: test project\nKey files: src/index.ts"
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

describe("AgentComponent — additionInfo + {{memory}} session-scope cache stability", () => {
  let agentComponent: AgentComponent;
  let mockEnv: Environment;
  let configComponent: ConfigComponent;
  let sessionComponent: any;
  let llmComponent: any;
  let memoryComponent: any;
  let tempDir: string;
  const testWorkspaceDir = "/home/test/workspace";

  beforeEach(async () => {
    vi.clearAllMocks();

    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-cache-scope-test-"));
    configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", path.join(tempDir, "agents"));
    await configComponent.set("workspace_dir", testWorkspaceDir);
    fsSync.mkdirSync(path.join(tempDir, "agents"), { recursive: true });

    sessionComponent = createMockSessionComponent();
    llmComponent = createMockLLMComponent();
    memoryComponent = createMockMemoryComponent();
    mockEnv = createMockEnv(sessionComponent, configComponent, llmComponent, memoryComponent);

    agentComponent = new AgentComponent();
    await agentComponent.init({ env: mockEnv, options: { configComponent } } as any);
  });

  afterEach(() => {
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  /**
   * Helper: 提取每次 LLM 调用时传入的所有 system message content（合并为单个字符串）
   * 【Task #2748 §5.6】multi-block system 后，system 可能是 1-4 段，合并后比较
   */
  function getLLMSystemPrompts(llm: any): string[] {
    if (!llm.invoke.mock || !llm.invoke.mock.calls.length) return [];
    return llm.invoke.mock.calls.map((call: any) => {
      const messages = call[0]?.messages || [];
      const sysMessages = messages.filter((m: any) => m.role === "system");
      return sysMessages.map((sm: any) => {
        if (typeof sm.content === "string") return sm.content;
        if (Array.isArray(sm.content))
          return sm.content.map((p: any) => p.text || "").join("");
        return "";
      }).join("\n---\n");
    });
  }

  // ==========================================================================
  // T1: additionInfo 跨 4 轮字节级一致
  // ==========================================================================
  describe("T1: additionInfo 字节级稳定 (session-scope)", () => {
    it("同一 session 4 轮 LLM 调用注入的 system prompt 字节级一致（additionInfo 不重算）", async () => {
      // Register agent with template containing both {{memory}} and {{workspace_dir}}
      const originalPrompt = "工作目录: {{workspace_dir}}\n记忆: {{memory}}\n开始。";
      agentComponent.registerAgent("cache-test-agent", {
        type: "primary",
        systemPrompt: originalPrompt,
        maxIterations: 1,
      });

      const sessionId = "session_t1";
      // Run 4 turns with SAME sessionId, additionInfo 变化（模拟不同 task）
      // RED 期望：每轮 system prompt 应该 byte-equal（因为 additionInfo 不变 = session-scope）
      for (let i = 0; i < 4; i++) {
        await agentComponent.run("cache-test-agent", `query ${i}`, {
          sessionId,
          additionInfo: `[Task #${i + 1}]`, // <<< 变化值，RED 后应当不影响 system prompt
        });
      }

      const sysPrompts = getLLMSystemPrompts(llmComponent);
      expect(sysPrompts).toHaveLength(4);

      // 核心断言：4 轮 system prompt 字节级一致
      // （additionInfo 已经被 snapshot 到 session.metadata.cacheSnapshot，跨轮稳定）
      const first = sysPrompts[0];
      for (let i = 1; i < 4; i++) {
        expect(sysPrompts[i]).toBe(first);
      }

      // 额外的反向断言：4 轮 system prompt 不应包含不同 taskId
      // （防止测试假绿 —— 即使 additionInfo 实际被合并到 system，每轮的内容也必须 byte-equal）
      for (let i = 0; i < 4; i++) {
        // snapshot 应当是第一次的 additionInfo（即 "[Task #1]"）
        // 如果代码还没实现 snapshot，这里会包含 "[Task #2]" / "[Task #3]" / "[Task #4]"
        expect(sysPrompts[i]).toContain("[Task #1]"); // 第一次的 additionInfo
      }
    });
  });

  // ==========================================================================
  // T2: {{memory}} 跨 4 轮字节级一致（recallMemory 仅调用 1 次）
  // ==========================================================================
  describe("T2: {{memory}} 字节级稳定 (session-scope snapshot)", () => {
    it("同一 session 4 轮 LLM 调用中，recallMemory() 仅在第一轮调用（snapshot 复用）", async () => {
      const originalPrompt = "工作目录: {{workspace_dir}}\n记忆: {{memory}}\n开始。";
      agentComponent.registerAgent("cache-test-agent", {
        type: "primary",
        systemPrompt: originalPrompt,
        maxIterations: 1,
      });

      // mock memory with counter
      let recallCount = 0;
      memoryComponent.recallMemory = vi.fn(async () => {
        recallCount++;
        return "snapshot memory content v1";
      });

      const sessionId = "session_t2";
      for (let i = 0; i < 4; i++) {
        await agentComponent.run("cache-test-agent", `query ${i}`, {
          sessionId,
          additionInfo: `[Task #1]`, // 固定（让 T1 也通过，但这里只测 memory）
        });
      }

      // 核心断言：recallMemory 只在第一轮被调用一次
      // 当前实现：每轮都调用 → recallCount === 4（RED）
      // 修复后：snapshot 复用 → recallCount === 1（GREEN）
      expect(recallCount).toBe(1);
    });

    it("同一 session 4 轮 system prompt 字节级一致（memory 内容 snapshot 后不变）", async () => {
      const originalPrompt = "工作目录: {{workspace_dir}}\n记忆: {{memory}}\n开始。";
      agentComponent.registerAgent("cache-test-agent", {
        type: "primary",
        systemPrompt: originalPrompt,
        maxIterations: 1,
      });

      // 设置 first-run memory 为 "snapshot memory content v1"
      memoryComponent.recallMemory = vi.fn(async () => "snapshot memory content v1");

      const sessionId = "session_t2b";
      await agentComponent.run("cache-test-agent", "query 1", {
        sessionId,
        additionInfo: "[Task #1]",
      });
      // Simulate: memory component changes (e.g., user updated memory file)
      // In real impl, recallMemory() might return different value
      // But session-scope snapshot must keep first call's value
      memoryComponent.recallMemory = vi.fn(async () => "MUTATED memory content");

      await agentComponent.run("cache-test-agent", "query 2", {
        sessionId,
        additionInfo: "[Task #1]",
      });
      await agentComponent.run("cache-test-agent", "query 3", {
        sessionId,
        additionInfo: "[Task #1]",
      });
      await agentComponent.run("cache-test-agent", "query 4", {
        sessionId,
        additionInfo: "[Task #1]",
      });

      const sysPrompts = getLLMSystemPrompts(llmComponent);
      expect(sysPrompts).toHaveLength(4);

      // 4 轮 system prompt 字节级一致
      const first = sysPrompts[0];
      for (let i = 1; i < 4; i++) {
        expect(sysPrompts[i]).toBe(first);
      }

      // 关键：4 轮 system prompt 都不能包含 "MUTATED"
      // （memory snapshot 应当保存第一次的 "snapshot memory content v1"）
      for (let i = 0; i < 4; i++) {
        expect(sysPrompts[i]).not.toContain("MUTATED");
        expect(sysPrompts[i]).toContain("snapshot memory content v1");
      }
    });
  });

  // ==========================================================================
  // T3: session 内 snapshot 保持稳定（内存级）
  // ==========================================================================
  describe("T3: session 内 snapshot 保持稳定（内存级）", () => {
    it("session 1st run 后快照存于内存 Map；同实例二次 run 复用同一快照", async () => {
      const originalPrompt = "工作目录: {{workspace_dir}}\n记忆: {{memory}}\n开始。";
      agentComponent.registerAgent("cache-test-agent", {
        type: "primary",
        systemPrompt: originalPrompt,
        maxIterations: 1,
      });

      // Set first-run memory to "snapshot memory content v1" (so snapshot captures it)
      memoryComponent.recallMemory = vi.fn(async () => "snapshot memory content v1");

      const sessionId = "session_t3";

      // Session 1st run — should trigger snapshot creation
      await agentComponent.run("cache-test-agent", "query 1", {
        sessionId,
        additionInfo: "[Task #1] frozen",
      });

      // 1. ★ Task #5224：快照存于**内存 Map**（key=sessionId），
      //    不再写入 session.metadata.cacheSnapshot（持久化已移除）。
      const memSnapshot = (agentComponent as any)._cacheSnapshots?.get(sessionId);
      expect(memSnapshot).toBeDefined();

      const snapshot = memSnapshot as any;
      // Note: Do not use `expect.stringContaining` here — Vitest's toMatchObject
      // can mutate the snapshot value to a sentinel on partial match. Use direct
      // string assertions to avoid the mutation.
      expect(snapshot.additionInfo).toBe("[Task #1] frozen");
      expect(snapshot.systemPrompt).toContain("snapshot memory content v1");
      expect(snapshot.snapshotAt).toBeGreaterThan(0);
      expect(typeof snapshot.systemPrompt).toBe("string");

      // 2. 快照**不落库**（sessions.db 不得承载整份 systemPrompt ——
      //    这是本地库膨胀到 GB 级的主因）
      const sessionState = sessionComponent._sessions.get(sessionId);
      expect(sessionState).toBeDefined();
      expect(sessionState.metadata?.cacheSnapshot).toBeUndefined();

      // 3. 同一实例内二次 run —— 复用同一快照（不重新计算）。
      //    改 memory 内容模拟「memory 在 session 中途变化」：
      //    新语义下 session 内快照冻结 ⇒ 不重拍。
      memoryComponent.recallMemory = vi.fn(async () => "FRESH memory after reload");

      await agentComponent.run("cache-test-agent", "query 2 (after reload)", {
        sessionId,
        additionInfo: "[Task #2] DIFFERENT", // <<< 不同 additionInfo
      });

      // 4. 复用快照 ⇒ recallMemory 不再被调用
      expect(memoryComponent.recallMemory).not.toHaveBeenCalled();

      // 5. 两轮 system prompt 字节级一致（快照冻结语义）
      const allSysPrompts = getLLMSystemPrompts(llmComponent);
      expect(allSysPrompts).toHaveLength(2);
      expect(allSysPrompts[1]).toBe(allSysPrompts[0]);

      // 反向断言：第二轮不含新 memory / 新 additionInfo
      expect(allSysPrompts[1]).not.toContain("FRESH");
      expect(allSysPrompts[1]).not.toContain("[Task #2]");
      expect(allSysPrompts[1]).toContain("[Task #1] frozen"); // snapshot 保持
    });
  });
});
