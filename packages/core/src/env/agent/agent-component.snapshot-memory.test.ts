/**
 * @fileoverview Task #5224 — cacheSnapshot 机制重构：内存级 + session 关联
 *
 * ## 用户确认的设计（最终版）
 *
 * - 快照改为**内存级**（Map，key=sessionId），**不持久化** sessions.db
 * - session 生命周期内**一次性构建**（含当时 memory + 渠道 prompt），之后一直用
 * - **移除 `_isMemorySnapshotStale` 失效检测**
 *   （老 session 不检测不重建；新 session 自然用最新 memory；进程重启全部重建）
 * - 渠道 prompt **构建时注入**（注入点唯一），移除 fix③ 追加 + includes 判重补丁
 *
 * ## 本文件覆盖的断言（RED → GREEN）
 *
 * - R1 快照不写入 session.metadata.cacheSnapshot（内存级）
 * - R2 session 内二次 run 复用同一快照 —— **即使 memory.md 已改变**
 * - R3 渠道 prompt 构建时注入恰好 1 次（复用轮不重复、不丢失）
 * - R4 进程重启（新实例）后快照重建（读到新 memory）
 * - R5 同渠道多轮字节级一致（prompt cache 语义保留）
 * - R6 快照按 sessionId 隔离（不同 session 各自独立）
 * - R7 内存 Map 生命周期：同一 AgentComponent 实例内跨 run 复用
 *
 * ## 不再成立（随设计移除）
 *
 * - memory.md mtime 变化触发重拍（失效检测已移除）
 * - 跨 AgentComponent 实例复用持久化快照（不持久化 ⇒ 必然重建）
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentComponent } from "./agent-component";
import type { Environment } from "../interface";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Mock Helpers（复用 channel-prompt-snapshot.test.ts 模式）
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
    saveCheckpoint: vi.fn(() => {}),
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
    // ★ 关键：提供真实的 mtime 采集能力（Task #4813 B1 失效检测依赖）。
    //   缺失这两个方法 → _collectMemoryStat 恒返回 {0,0} → 失效检测永远
    //   判「新鲜」→ RED 断言会假绿。必须提供以保证 RED 真实。
    getMemoryPaths: vi.fn(() => [
      { type: "global", path: globalDir },
      { type: "project", path: projectDir },
    ]),
    getMemoryFile: vi.fn(() => "memory.md"),
  };
}

/** 写 memory 文件并保证 mtime 与之前不同（CI 文系统 mtime 精度可能是 1s） */
function writeMemoryFile(dir: string, content: string, previousMtimeMs?: number): void {
  const filePath = path.join(dir, "memory.md");
  fsSync.writeFileSync(filePath, content, "utf-8");
  if (previousMtimeMs !== undefined) {
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

// ============================================================================
// Tests
// ============================================================================

describe("AgentComponent — cacheSnapshot 内存级重构（Task #5224）", () => {
  const PROMPT_TEMPLATE = "你是 Roy 接待智能体。记忆: {{memory}}";
  const CHANNEL_A = "## 渠道A规范：企微回复规范";
  const CHANNEL_B = "## 渠道B规范：飞书文档交付规范";

  let configComponent: ConfigComponent;
  let sessionComponent: any;
  let memoryComponent: any;
  let tempDir: string;
  let globalDir: string;
  let projectDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "agent-snapshot-mem-test-"));
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
    memoryComponent = createRealMemoryComponent(globalDir, projectDir);
  });

  afterEach(() => {
    try {
      fsSync.rmSync(tempDir, { recursive: true });
    } catch {}
  });

  async function initAgent(llmComponent: any): Promise<AgentComponent> {
    const agentComponent = new AgentComponent();
    await agentComponent.init({
      env: createMockEnv(sessionComponent, configComponent, llmComponent, memoryComponent),
      options: { configComponent },
    } as any);
    agentComponent.registerAgent("default", {
      type: "primary",
      systemPrompt: PROMPT_TEMPLATE,
      maxIterations: 1,
    });
    return agentComponent;
  }

  function systemPromptOfCall(llmComponent: any, callIndex: number): string {
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

  // ==========================================================================
  // R1: 快照不持久化到 sessions.db
  // ==========================================================================
  it("R1: 快照不写入 session.metadata.cacheSnapshot（内存级）", async () => {
    const sessionId = "session_mem_r1";
    fsSync.writeFileSync(path.join(globalDir, "memory.md"), "MEM_R1", "utf-8");

    const llm = createMockLLMComponent();
    const agent = await initAgent(llm);
    await agent.run("default", "q1", {
      sessionId,
      metadata: { systemPrompt: CHANNEL_A },
    });

    // 内存 Map 中应有快照（session 关联）
    const memSnap = (agent as any)._cacheSnapshots?.get(sessionId);
    expect(memSnap).toBeDefined();
    expect(memSnap.systemPrompt).toContain("MEM_R1");
    expect(memSnap.systemPrompt).toContain("渠道A规范");

    // sessions.db（mock 的 session metadata）中不得写入 cacheSnapshot
    const meta = sessionComponent._sessions.get(sessionId)?.metadata ?? {};
    expect(meta.cacheSnapshot).toBeUndefined();
    // update 调用不得携带 cacheSnapshot 字段
    for (const [, updates] of sessionComponent.update.mock.calls) {
      expect(updates?.metadata?.cacheSnapshot).toBeUndefined();
    }
  });

  // ==========================================================================
  // R2: session 内二次 run 复用同一快照 —— 即使 memory.md 变了
  // ==========================================================================
  it("R2: session 内二次 run 复用同一快照（即使 memory.md 已改变）", async () => {
    const sessionId = "session_mem_r2";
    fsSync.writeFileSync(path.join(globalDir, "memory.md"), "MEM_R2_V1", "utf-8");

    const llm = createMockLLMComponent();
    const agent = await initAgent(llm);
    await agent.run("default", "q1", { sessionId });
    expect(systemPromptOfCall(llm, 0)).toContain("MEM_R2_V1");

    // memory 改变（mtime 推进）
    const mtimeV1 = fsSync.statSync(path.join(globalDir, "memory.md")).mtimeMs;
    writeMemoryFile(globalDir, "MEM_R2_V2", mtimeV1);
    expect(fsSync.statSync(path.join(globalDir, "memory.md")).mtimeMs).toBeGreaterThan(mtimeV1);

    await agent.run("default", "q2", { sessionId });

    // ★ 核心：session 生命周期内快照冻结 —— 仍是 V1，不重拍
    expect(systemPromptOfCall(llm, 1)).toContain("MEM_R2_V1");
    expect(systemPromptOfCall(llm, 1)).not.toContain("MEM_R2_V2");
    // 两轮字节级一致
    expect(systemPromptOfCall(llm, 1)).toBe(systemPromptOfCall(llm, 0));
    // recallMemory 只在首拍调用一次（不重算）
    expect(memoryComponent.recallMemory).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // R3: 渠道 prompt 构建时注入恰好 1 次
  // ==========================================================================
  it("R3: 渠道 prompt 构建时注入，复用轮恰好 1 次（不重复不丢失）", async () => {
    const sessionId = "session_mem_r3";
    fsSync.writeFileSync(path.join(globalDir, "memory.md"), "MEM_R3", "utf-8");

    const llm = createMockLLMComponent();
    const agent = await initAgent(llm);

    // 首拍带渠道 prompt → 构建进快照
    await agent.run("default", "q1", {
      sessionId,
      metadata: { systemPrompt: CHANNEL_A },
    });
    const sp0 = systemPromptOfCall(llm, 0);
    expect(sp0).toContain("渠道A规范");
    expect(countOccurrences(sp0, CHANNEL_A)).toBe(1);

    // 复用轮仍带渠道 prompt → 恰好 1 份（不重复）
    await agent.run("default", "q2", {
      sessionId,
      metadata: { systemPrompt: CHANNEL_A },
    });
    const sp1 = systemPromptOfCall(llm, 1);
    expect(sp1).toContain("渠道A规范");
    expect(countOccurrences(sp1, CHANNEL_A)).toBe(1);
    expect(sp1).toBe(sp0);
  });

  // ==========================================================================
  // R4: 进程重启（新实例）后快照重建
  // ==========================================================================
  it("R4: 进程重启（新 AgentComponent 实例）后快照重建（读到新 memory）", async () => {
    const sessionId = "session_mem_r4";
    fsSync.writeFileSync(path.join(globalDir, "memory.md"), "MEM_R4_V1", "utf-8");

    const llm1 = createMockLLMComponent();
    const agent1 = await initAgent(llm1);
    await agent1.run("default", "q1", { sessionId });
    expect(systemPromptOfCall(llm1, 0)).toContain("MEM_R4_V1");
    expect(memoryComponent.recallMemory).toHaveBeenCalledTimes(1);

    // 重启：memory 已更新，新实例重建快照 → 读到新记忆
    fsSync.writeFileSync(path.join(globalDir, "memory.md"), "MEM_R4_V2", "utf-8");
    const llm2 = createMockLLMComponent();
    const agent2 = await initAgent(llm2);
    await agent2.run("default", "q2", { sessionId });
    expect(memoryComponent.recallMemory).toHaveBeenCalledTimes(2);
    expect(systemPromptOfCall(llm2, 0)).toContain("MEM_R4_V2");
    expect(systemPromptOfCall(llm2, 0)).not.toContain("MEM_R4_V1");
  });

  // ==========================================================================
  // R5: 同渠道多轮字节级一致（prompt cache 语义保留）
  // ==========================================================================
  it("R5: 同渠道多轮字节级一致（prompt cache 语义保留）", async () => {
    const sessionId = "session_mem_r5";
    fsSync.writeFileSync(path.join(globalDir, "memory.md"), "MEM_R5", "utf-8");

    const llm = createMockLLMComponent();
    const agent = await initAgent(llm);
    await agent.run("default", "q1", {
      sessionId,
      metadata: { systemPrompt: CHANNEL_A },
    });
    await agent.run("default", "q2", {
      sessionId,
      metadata: { systemPrompt: CHANNEL_A },
    });
    await agent.run("default", "q3", {
      sessionId,
      metadata: { systemPrompt: CHANNEL_A },
    });
    const sp0 = systemPromptOfCall(llm, 0);
    expect(systemPromptOfCall(llm, 1)).toBe(sp0);
    expect(systemPromptOfCall(llm, 2)).toBe(sp0);
    // 同渠道复用不重拍（recallMemory 仅首拍 1 次）
    expect(memoryComponent.recallMemory).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // R6: 快照按 sessionId 隔离
  // ==========================================================================
  it("R6: 快照按 sessionId 隔离（不同 session 各自独立构建）", async () => {
    fsSync.writeFileSync(path.join(globalDir, "memory.md"), "MEM_R6", "utf-8");

    const llm = createMockLLMComponent();
    const agent = await initAgent(llm);
    await agent.run("default", "q1", {
      sessionId: "session_r6_a",
      metadata: { systemPrompt: CHANNEL_A },
    });
    await agent.run("default", "q2", {
      sessionId: "session_r6_b",
      metadata: { systemPrompt: CHANNEL_B },
    });

    // 两个 session 的渠道 prompt 互不串味
    const spA = systemPromptOfCall(llm, 0);
    const spB = systemPromptOfCall(llm, 1);
    expect(spA).toContain("渠道A规范");
    expect(spA).not.toContain("渠道B规范");
    expect(spB).toContain("渠道B规范");
    expect(spB).not.toContain("渠道A规范");
    // 两个 session 各自拍过一次（recallMemory 2 次）
    expect(memoryComponent.recallMemory).toHaveBeenCalledTimes(2);
  });

  // ==========================================================================
  // R7: 内存 Map 生命周期 —— 同一实例内跨 run 复用
  // ==========================================================================
  it("R7: 内存 Map 按 sessionId 存储快照（同一实例内跨 run 复用）", async () => {
    const sessionId = "session_mem_r7";
    fsSync.writeFileSync(path.join(globalDir, "memory.md"), "MEM_R7", "utf-8");

    const llm = createMockLLMComponent();
    const agent = await initAgent(llm);
    await agent.run("default", "q1", { sessionId });

    const map = (agent as any)._cacheSnapshots;
    expect(map).toBeInstanceOf(Map);
    expect(map.size).toBe(1);
    expect(map.has(sessionId)).toBe(true);
    const snap = map.get(sessionId);
    expect(snap.systemPrompt).toContain("MEM_R7");
    expect(typeof snap.additionInfo).toBe("string");
    expect(snap.snapshotAt).toBeGreaterThan(0);
  });
});
