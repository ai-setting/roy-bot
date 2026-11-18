/**
 * @fileoverview AgentComponent — cacheSnapshot 冻结与重建语义
 *
 * ★ Task #5224 —— 本文件**取代**原「记忆失效检测（B1 mtime 方案，Task #4813）」。
 *
 * ## 为什么移除 mtime 失效检测
 *
 * 原方案（Task #4813）针对的是**持久化**快照的固疾：快照写进
 * `session.metadata.cacheSnapshot` 后跨进程存活，memory.md 更新了旧快照
 * 仍被判「新鲜」→ 长寿命会话钉死旧记忆（Task #4812 实证 10 个活跃
 * lark 会话中 5 个中招）。
 *
 * Task #5224 把快照改成**内存级**（`AgentComponent._cacheSnapshots`，
 * key=sessionId，不落库）后，这个固疾从根上消失：
 *   - **进程重启** → 内存态全失 → 快照必然重建 → 自然拿到最新 memory
 *   - **新 session** → 新 key → 快照必然重建 → 自然拿到最新 memory
 *   - **同一 session 内** → 快照冻结（不再中途重拍，避免 system prompt
 *     在会话中途漂移 → prompt cache 前缀失效）
 *
 * 因此失效检测（`_isMemorySnapshotStale`）与 mtime 采集（`_collectMemoryStat`）
 * 全部删除，本文件改为固化「冻结 + 两个重建触发条件」的新语义。
 *
 * ## 语义保留
 *   - additionInfo 冻结语义不变
 *   - sub-agent 的 _fallbackReplaceMemory 每 run 实时读行为不变
 *   - 记忆未变化时仍复用快照（字节级一致 → prompt cache 命中）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Mock Helpers（复用 agent-component.subagent-snapshot.test.ts 模式）
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
// 真实 MemoryComponent mock：基于临时目录的 memory 文件（可控制 mtime）
// ============================================================================

function createRealMemoryComponent(globalDir: string, projectDir: string) {
  return {
    getMemoryPaths: vi.fn(() => [
      { type: "global" as const, path: globalDir },
      { type: "project" as const, path: projectDir },
    ]),
    getMemoryFile: vi.fn(() => "memory.md"),
    recallMemory: vi.fn(async () => {
      // 模拟真实 recallMemory：读 global + project memory.md 拼接
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

/** 写 memory 文件并保证 mtime 与之前不同（CI 文系统 mtime 精度可能是 1s） */
function writeMemoryFile(dir: string, content: string, previousMtimeMs?: number): void {
  const filePath = path.join(dir, "memory.md");
  fsSync.writeFileSync(filePath, content, "utf-8");
  if (previousMtimeMs !== undefined) {
    // 确保新 mtime 严格大于旧 mtime（应对 1s 精度文件系统）
    let guard = 0;
    while (
      fsSync.statSync(filePath).mtimeMs <= previousMtimeMs &&
      guard < 50
    ) {
      const t = previousMtimeMs + 1100 + guard * 100;
      fsSync.utimesSync(filePath, new Date(t), new Date(t));
      guard++;
    }
  }
}

// ============================================================================
// Tests
// ============================================================================

describe("AgentComponent — cacheSnapshot 冻结与重建语义（Task #5224 取代 mtime 失效检测）", () => {
  let agentComponent: AgentComponent;
  let configComponent: ConfigComponent;
  let sessionComponent: any;
  let llmComponent: any;
  let memoryComponent: any;
  let tempDir: string;
  let globalDir: string;
  let projectDir: string;

  const PROMPT_TEMPLATE = "记忆: {{memory}}\n你是 Roy 接待智能体。";

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-snapshot-invalidate-test-"));
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

  function snapshotOf(sessionId: string): any {
    return (agentComponent as any)._cacheSnapshots?.get(sessionId);
  }

  // ==========================================================================
  // ★ Task #5224：mtime 失效检测已移除 —— session 内快照冻结
  // ==========================================================================
  it("session 内 memory.md mtime 变化后**不重拍**（失效检测已移除，快照冻结）", async () => {
    const sessionId = "session_invalidate_1";

    // 1. 首拍：写入记忆 v1 → run → 快照含 v1 内容
    writeMemoryFile(globalDir, "GLOBAL_MEMORY_V1");
    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PROMPT_TEMPLATE,
      maxIterations: 1,
    });
    await agentComponent.run("default", "q1", { sessionId });

    const snap1 = snapshotOf(sessionId);
    expect(snap1).toBeDefined();
    expect(systemPromptOfCall(0)).toContain("GLOBAL_MEMORY_V1");

    // 2. 记忆更新为 v2（mtime 变化）
    const mtimeV1 = fsSync.statSync(path.join(globalDir, "memory.md")).mtimeMs;
    writeMemoryFile(globalDir, "GLOBAL_MEMORY_V2", mtimeV1);
    expect(fsSync.statSync(path.join(globalDir, "memory.md")).mtimeMs).toBeGreaterThan(mtimeV1);

    // 3. 再次 run —— ★ 新语义：快照冻结，仍是 V1（不重拍）
    await agentComponent.run("default", "q2", { sessionId });

    expect(systemPromptOfCall(1)).toContain("GLOBAL_MEMORY_V1");
    expect(systemPromptOfCall(1)).not.toContain("GLOBAL_MEMORY_V2");
    // 快照对象未被替换（同一个实例）
    expect(snapshotOf(sessionId)).toBe(snap1);
    // recallMemory 只在首拍调用一次
    expect(memoryComponent.recallMemory).toHaveBeenCalledTimes(1);
  });

  it("快照不含 memoryStat 字段（失效检测已移除，不再需要 mtime 记录）", async () => {
    const sessionId = "session_invalidate_2";

    writeMemoryFile(globalDir, "MEMORY_FOR_FRESH_SNAPSHOT");
    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PROMPT_TEMPLATE,
      maxIterations: 1,
    });
    await agentComponent.run("default", "q1", { sessionId });

    const snap = snapshotOf(sessionId);
    expect(snap).toBeDefined();
    // ★ 失效检测已移除 ⇒ 不再采集/记录 mtime
    expect(snap.memoryStat).toBeUndefined();
    expect(systemPromptOfCall(0)).toContain("MEMORY_FOR_FRESH_SNAPSHOT");
  });

  it("GREEN-guard: memory 未变化时仍复用快照（prompt cache 语义保留）", async () => {
    const sessionId = "session_keep_cache";

    writeMemoryFile(globalDir, "STABLE_MEMORY");
    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PROMPT_TEMPLATE,
      maxIterations: 1,
    });
    await agentComponent.run("default", "q1", { sessionId });
    await agentComponent.run("default", "q2", { sessionId });

    // 两轮字节级一致（快照复用，不重拍）
    expect(systemPromptOfCall(0)).toContain("STABLE_MEMORY");
    expect(systemPromptOfCall(1)).toBe(systemPromptOfCall(0));

    // recallMemory 只在首拍调用一次
    expect(memoryComponent.recallMemory).toHaveBeenCalledTimes(1);
  });

  it("GREEN-guard: 快照结构含 systemPrompt / additionInfo / snapshotAt", async () => {
    const sessionId = "session_memstat";

    writeMemoryFile(globalDir, "G_CONTENT");
    writeMemoryFile(projectDir, "P_CONTENT");
    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PROMPT_TEMPLATE,
      maxIterations: 1,
    });
    await agentComponent.run("default", "q1", { sessionId });

    const snap = snapshotOf(sessionId);
    expect(snap).toBeDefined();
    expect(typeof snap.systemPrompt).toBe("string");
    expect(typeof snap.additionInfo).toBe("string");
    expect(snap.snapshotAt).toBeGreaterThan(0);
    expect(snap.systemPrompt).toContain("G_CONTENT");
    expect(snap.systemPrompt).toContain("P_CONTENT");
  });

  it("GREEN-guard: project memory.md 变化也不触发重拍（session 内冻结）", async () => {
    const sessionId = "session_project_change";

    writeMemoryFile(globalDir, "G_STABLE");
    writeMemoryFile(projectDir, "P_V1");
    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PROMPT_TEMPLATE,
      maxIterations: 1,
    });
    await agentComponent.run("default", "q1", { sessionId });

    const mtimeV1 = fsSync.statSync(path.join(projectDir, "memory.md")).mtimeMs;
    writeMemoryFile(projectDir, "P_V2", mtimeV1);

    await agentComponent.run("default", "q2", { sessionId });
    expect(systemPromptOfCall(1)).toContain("P_V1");
    expect(systemPromptOfCall(1)).not.toContain("P_V2");
    expect(systemPromptOfCall(1)).toContain("G_STABLE");
  });

  it("GREEN-guard: memory 文件被删除也不重拍（session 内快照冻结）", async () => {
    const sessionId = "session_file_deleted";

    writeMemoryFile(globalDir, "WILL_BE_DELETED");
    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PROMPT_TEMPLATE,
      maxIterations: 1,
    });
    await agentComponent.run("default", "q1", { sessionId });
    expect(systemPromptOfCall(0)).toContain("WILL_BE_DELETED");

    // 删除文件 → ★ 新语义：session 内冻结，仍是旧内容（不重拍）
    fsSync.unlinkSync(path.join(globalDir, "memory.md"));
    await agentComponent.run("default", "q2", { sessionId });

    expect(systemPromptOfCall(1)).toContain("WILL_BE_DELETED");
    expect(systemPromptOfCall(1)).not.toContain("(No memory)");
  });

  // ==========================================================================
  // ★ Task #5224：重建的两个触发条件（新 session / 进程重启）
  // ==========================================================================
  it("新 sessionId 触发重建（新 session 自然用最新 memory）", async () => {
    writeMemoryFile(globalDir, "MEM_SESSION_A");
    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PROMPT_TEMPLATE,
      maxIterations: 1,
    });

    await agentComponent.run("default", "q1", { sessionId: "session_a" });
    expect(systemPromptOfCall(0)).toContain("MEM_SESSION_A");

    // memory 更新
    const mtimeV1 = fsSync.statSync(path.join(globalDir, "memory.md")).mtimeMs;
    writeMemoryFile(globalDir, "MEM_SESSION_B", mtimeV1);

    // 新 session → 重建 → 读到最新 memory
    await agentComponent.run("default", "q2", { sessionId: "session_b" });
    expect(systemPromptOfCall(1)).toContain("MEM_SESSION_B");
    expect(systemPromptOfCall(1)).not.toContain("MEM_SESSION_A");
  });

  it("进程重启（新 AgentComponent 实例）触发重建（读到最新 memory）", async () => {
    const sessionId = "session_restart";
    writeMemoryFile(globalDir, "MEM_BEFORE_RESTART");

    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PROMPT_TEMPLATE,
      maxIterations: 1,
    });
    await agentComponent.run("default", "q1", { sessionId });
    expect(systemPromptOfCall(0)).toContain("MEM_BEFORE_RESTART");

    // memory 更新 + 新实例（模拟进程重启：内存态全失）
    const mtimeV1 = fsSync.statSync(path.join(globalDir, "memory.md")).mtimeMs;
    writeMemoryFile(globalDir, "MEM_AFTER_RESTART", mtimeV1);

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

    await newAgentComponent.run("default", "q2", { sessionId });

    const newCall = newLlmComponent.invoke.mock.calls[0]?.[0]?.messages ?? [];
    const sp = newCall
      .filter((m: any) => m.role === "system")
      .map((m: any) => (typeof m.content === "string" ? m.content : ""))
      .join("\n---\n");
    expect(sp).toContain("MEM_AFTER_RESTART");
    expect(sp).not.toContain("MEM_BEFORE_RESTART");
  });
});