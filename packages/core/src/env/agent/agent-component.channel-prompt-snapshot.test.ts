/**
 * @fileoverview AgentComponent — 渠道 prompt 在快照**构建时**注入（Task #5224）
 *
 * ## 历史背景（补丁链的终结）
 *
 * - **fix③（Task #5217）**：snapshot 命中时**追加** runtime 的 channel prompt
 *   （eventSourceSystemPrompt）。存在原因：快照**持久化**到
 *   `session.metadata.cacheSnapshot` 且跨进程存活 ⇒ 旧快照创建于 lean 渠道
 *   prompt 引入之前，且失效检测只看 memory.md mtime → 旧快照被判「新鲜」
 *   永久复用 → 渠道 prompt 永远进不了 LLM system message（Task #5210 根因）。
 * - **includes 判重（Task #5223）**：fix③ 的无条件追加在新快照场景
 *   （首拍即含渠道 prompt）导致重复注入 ×2。
 *
 * ## Task #5224 的终局设计
 *
 * 快照改**内存级**（`AgentComponent._cacheSnapshots`，key=sessionId，不落库），
 * 渠道 prompt **构建时注入**（唯一注入点），两个补丁的根因同时消失：
 *
 *   1. 不落库 ⇒ 进程重启后快照必然重建 ⇒ 快照必含构建时的渠道 prompt
 *   2. 渠道 prompt 是 per-**渠道**常量（EventSource 实例级缓存），
 *      而 session ↔ chat 一一对应 ⇒ 同 session 恒定同一渠道 prompt
 *
 * ⇒ 复用轮直接复用快照里那一份即可：**恰好 1 份**，天然不重不漏。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Mock Helpers（复用 agent-component.snapshot-invalidate.test.ts 模式）
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

function createRealMemoryComponent(globalDir: string, projectDir: string) {
  return {
    getMemoryPaths: vi.fn(() => [
      { type: "global" as const, path: globalDir },
      { type: "project" as const, path: projectDir },
    ]),
    getMemoryFile: vi.fn(() => "memory.md"),
    recallMemory: vi.fn(async () => {
      const parts: string[] = [];
      for (const [type, dir] of [
        ["global", globalDir],
        ["project", projectDir],
      ] as const) {
        try {
          const content = fsSync.readFileSync(path.join(dir, "memory.md"), "utf-8");
          if (content.trim()) {
            parts.push(`## [${type}] memory.md\n${content}`);
          }
        } catch {
          // 文件不存在，跳过
        }
      }
      return parts.join("\n\n");
    }),
  };
}

// ============================================================================
// Tests
// ============================================================================
//
// ★ Task #5224 —— 渠道 prompt **构建时注入**（唯一注入点），复用轮不再追加。
//
// 背景（补丁链的终结）：
//   - fix③（Task #5217）：snapshot 命中时**追加** runtime 的 channel prompt
//     —— 因为快照持久化且跨进程，旧快照不含渠道 prompt
//   - includes 判重（Task #5223）：fix③ 追加导致新快照场景重复注入 ×2
//
// Task #5224 后两个补丁**同时失效**（根因消除）：
//   - 快照不落库 ⇒ 进程重启后必然重建 ⇒ 快照必含构建时的渠道 prompt
//   - 渠道 prompt 是 per-**渠道**常量（ES 实例级缓存），session ↔ chat 一一对应
//     ⇒ 同 session 恒定同一渠道 prompt ⇒ 复用轮用快照里那份即可，恰好 1 份
//
// ⇒ 新语义：**渠道 prompt 在构建时并入快照**，之后所有轮次复用同一份。

describe("AgentComponent — 渠道 prompt 构建时注入（Task #5224 唯一注入点）", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let sessionComponent: any;
  let llmComponent: any;
  let memoryComponent: any;
  let tempDir: string;
  let globalDir: string;
  let projectDir: string;

  const PROMPT_TEMPLATE = "你是 Roy 接待智能体。记忆: {{memory}}";
  const CHANNEL_PROMPT = "## 文档交付规范：产出物存飞书云盘，云盘链接交付";

  function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let idx = haystack.indexOf(needle);
    while (idx !== -1) {
      count++;
      idx = haystack.indexOf(needle, idx + needle.length);
    }
    return count;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-channel-prompt-test-"));
    globalDir = path.join(tempDir, "global");
    projectDir = path.join(tempDir, "project");
    fsSync.mkdirSync(globalDir, { recursive: true });
    fsSync.mkdirSync(projectDir, { recursive: true });

    configComponent = new ConfigComponent();
    configComponent.setXdgDataHome(tempDir);
    await configComponent.set("agent.configDir", path.join(tempDir, "agents"));
    await configComponent.set("workspace_dir", "/home/test/workspace");
    fsSync.mkdirSync(path.join(tempDir, "agents"), { recursive: true });

    sessionComponent = createMockSessionComponent();
    llmComponent = createMockLLMComponent();
    memoryComponent = createRealMemoryComponent(globalDir, projectDir);

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

  it("首拍带渠道 prompt → 构建进快照；复用轮恰好 1 份（不重复不丢失）", async () => {
    const sessionId = "session_channel_1";

    fsSync.writeFileSync(path.join(globalDir, "memory.md"), "MEMORY_V1", "utf-8");
    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PROMPT_TEMPLATE,
      maxIterations: 1,
    });

    // 首拍（带渠道 prompt）→ 渠道 prompt 构建进快照
    await agentComponent.run("default", "q1", {
      sessionId,
      metadata: { systemPrompt: CHANNEL_PROMPT },
    });

    // 快照含渠道 prompt（构建时注入的唯一证据）
    const snap = (agentComponent as any)._cacheSnapshots?.get(sessionId);
    expect(snap).toBeDefined();
    expect(snap.systemPrompt).toContain("文档交付规范");

    const sp0 = systemPromptOfCall(0);
    expect(sp0).toContain("文档交付规范");
    expect(countOccurrences(sp0, CHANNEL_PROMPT)).toBe(1);

    // 复用轮（仍带渠道 prompt）→ 恰好 1 份（★ 取代 fix③ + includes 判重）
    await agentComponent.run("default", "q2", {
      sessionId,
      metadata: { systemPrompt: CHANNEL_PROMPT },
    });
    const sp1 = systemPromptOfCall(1);
    expect(sp1).toContain("MEMORY_V1");
    expect(sp1).toContain("文档交付规范");
    expect(countOccurrences(sp1, CHANNEL_PROMPT)).toBe(1);
    // 复用轮与首拍字节级一致（prompt cache 前缀稳定）
    expect(sp1).toBe(sp0);
  });

  it("GREEN-guard: 无渠道 prompt 时快照复用仍字节级一致（prompt cache 语义保留）", async () => {
    const sessionId = "session_channel_2";

    fsSync.writeFileSync(path.join(globalDir, "memory.md"), "STABLE_MEM", "utf-8");
    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PROMPT_TEMPLATE,
      maxIterations: 1,
    });
    await agentComponent.run("default", "q1", { sessionId });
    await agentComponent.run("default", "q2", { sessionId });

    expect(systemPromptOfCall(0)).toContain("STABLE_MEM");
    expect(systemPromptOfCall(1)).toBe(systemPromptOfCall(0));
    // recallMemory 只在首拍调用一次（复用不重拍）
    expect(memoryComponent.recallMemory).toHaveBeenCalledTimes(1);
  });

  it("GREEN-guard: 渠道粘性 —— 渠道轮之后的非渠道轮仍保留渠道 prompt（恰好 1 份）", async () => {
    const sessionId = "session_channel_3";

    fsSync.writeFileSync(path.join(globalDir, "memory.md"), "MEM_FIRST", "utf-8");
    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PROMPT_TEMPLATE,
      maxIterations: 1,
    });
    // 首轮就带渠道 prompt → 快照含渠道 prompt
    await agentComponent.run("default", "q1", {
      sessionId,
      metadata: { systemPrompt: CHANNEL_PROMPT },
    });
    expect(systemPromptOfCall(0)).toContain("文档交付规范");

    // 第二轮不带渠道 prompt（如非渠道轮次）→ 快照复用仍含，且恰好 1 份
    await agentComponent.run("default", "q2", { sessionId });
    expect(systemPromptOfCall(1)).toContain("文档交付规范");
    expect(countOccurrences(systemPromptOfCall(1), CHANNEL_PROMPT)).toBe(1);
  });

  it("GREEN-guard: 进程重启后快照重建 → 渠道 prompt 由新快照重新构建（恰好 1 份）", async () => {
    const sessionId = "session_channel_4";

    fsSync.writeFileSync(path.join(globalDir, "memory.md"), "MEM_RESTART", "utf-8");
    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PROMPT_TEMPLATE,
      maxIterations: 1,
    });
    await agentComponent.run("default", "q1", {
      sessionId,
      metadata: { systemPrompt: CHANNEL_PROMPT },
    });
    expect(systemPromptOfCall(0)).toContain("文档交付规范");

    // 模拟进程重启：新 AgentComponent 实例（内存态全失）
    const newLlmComponent = createMockLLMComponent();
    const newAgentComponent = new AgentComponent();
    await newAgentComponent.init({
      env: createMockEnv(sessionComponent, configComponent, newLlmComponent, memoryComponent),
      options: { configComponent },
    } as any);
    newAgentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PROMPT_TEMPLATE,
      maxIterations: 1,
    });
    await newAgentComponent.run("default", "q2", {
      sessionId,
      metadata: { systemPrompt: CHANNEL_PROMPT },
    });

    const newCall = newLlmComponent.invoke.mock.calls[0]?.[0]?.messages ?? [];
    const sp = newCall
      .filter((m: any) => m.role === "system")
      .map((m: any) => (typeof m.content === "string" ? m.content : ""))
      .join("\n---\n");
    expect(sp).toContain("文档交付规范");
    expect(countOccurrences(sp, CHANNEL_PROMPT)).toBe(1);
    expect(sp).toContain("MEM_RESTART");
  });
});