/**
 * @fileoverview Tests for Bug #2: compress → checkpoint → reload chain
 *
 * Scenario A: After compact(), the agent's `getConversationHistory()`
 * (which is what the LLM sees) should only contain post-checkpoint
 * content. It MUST NOT leak the archived pre-checkpoint messages
 * back into the LLM context. Otherwise the next `handle_query()` call
 * — even with a clean newQuery — will still see the full old
 * conversation history, defeating the purpose of compaction.
 *
 * Scenario B: handle_query → ContextError → compact → handle_query
 * must succeed end-to-end without re-triggering ContextError due to
 * leaked history.
 *
 * Updated for new architecture: Compact now uses AgentComponent.run("compact", ...)
 * instead of the removed SummaryAgent.setSummaryComponents() pattern.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

import { SessionComponent } from "./session-component";
import { ConfigComponent } from "../../config/config-component";
import type { Environment } from "../interface";

function createTempDbPath(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return path.join(os.tmpdir(), `test-sessions-compact-${timestamp}-${random}.db`);
}

async function cleanupTempDb(dbPath: string): Promise<void> {
  try { await fsSync.promises.unlink(dbPath); } catch {}
  try { await fsSync.promises.unlink(`${dbPath}-wal`); } catch {}
  try { await fsSync.promises.unlink(`${dbPath}-shm`); } catch {}
}

/**
 * Create a mock AgentComponent that simulates the compact agent's behavior.
 *
 * ★ C 方案（Task #4933 重写）：compact agent 不再调用 workflow_submit_output，
 *   直接以**整段自然语言** finalText 返回 checkpoint 正文。
 */
function createMockAgentComponent(checkpointText: string) {
  let callCount = 0;
  let lastQuery = "";
  let lastOpts: any = null;

  return {
    name: "agent",
    version: "1.0.0",
    run: async (agentName: string, query: string, opts: any) => {
      callCount++;
      lastQuery = query;
      lastOpts = opts;

      if (agentName === "compact") {
        return { iterations: 1, toolCalls: [], finalText: checkpointText };
      }
      return { iterations: 1, toolCalls: [] };
    },
    // Expose for test assertions
    _getCallCount: () => callCount,
    _getLastQuery: () => lastQuery,
    _getLastOpts: () => lastOpts,
    _reset: () => { callCount = 0; lastQuery = ""; lastOpts = null; },
  };
}

describe("Bug #2: compact → checkpoint → reload chain (Scenario A)", () => {
  let component: SessionComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let tempDbPath: string;
  let mockAgentComponent: ReturnType<typeof createMockAgentComponent>;

  // Stable checkpoint text returned by mocked compact agent（C 方案：整段自然语言）
  const mockCheckpoint =
    "# Compress Test\n\n" +
    "本次会话实现了 X，并开始 Y；中途发现了 Z。\n\n" +
    "当前状态：Y 进行中（约 50% 完成）。\n\n" +
    "后续：完成 Y，然后测试 X。";

  beforeEach(() => {
    component = new SessionComponent();
    configComponent = new ConfigComponent();
    tempDbPath = createTempDbPath();
    mockAgentComponent = createMockAgentComponent(mockCheckpoint);

    mockEnv = {
      name: "test-env",
      version: "1.0.0",
      getComponent: vi.fn((name: string) => {
        if (name === "agent") return mockAgentComponent;
        if (name === "config") return configComponent;
        return undefined;
      }),
      hasComponent: vi.fn((name: string) => {
        if (name === "agent") return true;
        if (name === "config") return true;
        return false;
      }),
      logger: vi.fn(),
      trace: vi.fn(),
    } as unknown as Environment;
  });

  afterEach(async () => {
    if (component.getStatus() !== "stopped") {
      try { await component.stop(); } catch {}
    }
    await cleanupTempDb(tempDbPath);
    vi.restoreAllMocks();
  });

  /**
   * Scenario A: After compact(), the agent's history-load call
   * (`getConversationHistory` / `getContext(fullHistory: false)`) MUST
   * NOT contain any of the 60 archived pre-checkpoint messages.
   */
  it("after compact: getContext returns only checkpoint + post-checkpoint messages (no leaked history)", async () => {
    await component.init({
      env: mockEnv,
      options: {
        configComponent,
        config: { storage: { type: "sqlite", dbPath: tempDbPath } },
      },
    });

    const session = await component.create({ title: "Compress flow test" });

    // 1. Add 60 user/assistant messages simulating a long conversation.
    //    Tag each with a unique substring we can later assert is gone.
    const oldContentPrefix = "OLD_CONTENT_TAG_";
    for (let i = 0; i < 60; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      await component.addMessage(session.id, {
        role,
        content: `${oldContentPrefix}_msg${i}_${"x".repeat(200)}`,
      });
    }

    // 2. Compact the session.
    //    The mock agent component invokes workflow_submit_output with mockCheckpoint.
    const beforeCount = (await component.get(session.id))!.messageCount;
    expect(beforeCount).toBe(60);

    const result = await component.compact(session.id);
    expect(result.deletedMessageCount).toBe(60);
    expect(result.remainingMessageCount).toBe(1); // Only checkpoint message

    // 3. Add a post-checkpoint user message simulating the next turn.
    const postCheckpointContent = "POST_CHECKPOINT_NEW_MESSAGE_AFTER_COMPACT";
    await component.addMessage(session.id, {
      role: "user",
      content: postCheckpointContent,
    });

    // 4. CRITICAL: getContext (used by AgentComponent.getConversationHistory)
    //    must return ONLY the checkpoint + post-checkpoint messages — none
    //    of the 60 archived OLD_CONTENT_TAG_* messages.
    const ctx = await component.getContext(session.id, { fullHistory: false });

    // Sanity: total non-archived messages = 1 checkpoint + 1 post-checkpoint.
    expect(ctx.messages.length).toBe(2);
    expect(ctx.totalMessageCount).toBe(2);

    // Content check: NONE of the archived messages should leak back.
    const allContent = ctx.messages.map((m) => m.content).join("\n");
    expect(allContent).not.toContain(oldContentPrefix);
    for (let i = 0; i < 60; i++) {
      expect(allContent).not.toContain(`_msg${i}_`);
    }

    // Post-checkpoint message must still be present.
    expect(allContent).toContain(postCheckpointContent);
  });

  /**
   * Scenario A (negative control): With fullHistory: true, archived
   * messages ARE returned — this confirms the filter actually does
   * something. This guards against false-positive GREEN.
   */
  it("getContext(fullHistory: true) DOES include archived messages (sanity check)", async () => {
    await component.init({
      env: mockEnv,
      options: {
        configComponent,
        config: { storage: { type: "sqlite", dbPath: tempDbPath } },
      },
    });

    const session = await component.create({ title: "Sanity check" });

    const tag = "FULL_HISTORY_SHOULD_INCLUDE_ME_AFTER_COMPACT";
    for (let i = 0; i < 60; i++) {
      await component.addMessage(session.id, {
        role: "user",
        content: `${tag}_msg${i}`,
      });
    }

    await component.compact(session.id);

    const ctxFull = await component.getContext(session.id, { fullHistory: true });
    // Archived messages SHOULD be included.
    expect(ctxFull.messages.some((m) => m.content.includes(tag))).toBe(true);
  });

  /**
   * Bug #2 Root Cause Verification: messages with huge content
   * (e.g., tool results returning 100KB+ blobs) must NOT cause compact
   * to fail due to unbounded LLM input.
   *
   * In the new architecture, the compact agent gets conversation history
   * through AgentComponent which applies its own truncation. This test
   * verifies that compact() succeeds even with very large messages.
   */
  it("compact with huge message contents: compact succeeds without throwing", async () => {
    await component.init({
      env: mockEnv,
      options: {
        configComponent,
        config: { storage: { type: "sqlite", dbPath: tempDbPath } },
      },
    });

    const session = await component.create({ title: "Huge-message compact" });

    // Each message simulates a tool output blob of 100KB.
    // 60 messages × 100KB = 6MB of session content.
    const hugeBlob = "X".repeat(100_000);
    for (let i = 0; i < 60; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      await component.addMessage(session.id, {
        role,
        content: hugeBlob,
      });
    }

    // Act: compact — must succeed without throwing.
    const result = await component.compact(session.id);
    expect(result.deletedMessageCount).toBe(60);
    expect(result.remainingMessageCount).toBe(1);

    // Verify the checkpoint was created with the mock data
    // ★ C 方案：mockCheckpoint 现在是整段自然语言文本 → 标题取首个 markdown 标题行
    const ctx = await component.getContext(session.id, { fullHistory: false });
    expect(ctx.startCheckpoint).toBeDefined();
    expect(ctx.startCheckpoint!.title).toBe("Compress Test");
    expect(ctx.startCheckpoint!.content).toContain("本次会话实现了 X");
  });
});

describe("Bug #2: compact → checkpoint → reload (Scenario B end-to-end)", () => {
  let component: SessionComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let tempDbPath: string;
  let mockAgentComponent: ReturnType<typeof createMockAgentComponent>;

  // C 方案：整段自然语言 checkpoint 正文
  const mockCheckpoint =
    "# 阈值跨越会话\n\n" +
    "本次会话跨越了上下文阈值并触发压缩，checkpoint 已生成。\n\n" +
    "当前状态：压缩后上下文干净，可以继续对话。";

  beforeEach(() => {
    component = new SessionComponent();
    configComponent = new ConfigComponent();
    tempDbPath = createTempDbPath();
    mockAgentComponent = createMockAgentComponent(mockCheckpoint);

    mockEnv = {
      name: "test-env",
      version: "1.0.0",
      getComponent: vi.fn((name: string) => {
        if (name === "agent") return mockAgentComponent;
        if (name === "config") return configComponent;
        return undefined;
      }),
      hasComponent: vi.fn((name: string) => {
        if (name === "agent") return true;
        if (name === "config") return true;
        return false;
      }),
      logger: vi.fn(),
      trace: vi.fn(),
    } as unknown as Environment;
  });

  afterEach(async () => {
    if (component.getStatus() !== "stopped") {
      try { await component.stop(); } catch {}
    }
    await cleanupTempDb(tempDbPath);
    vi.restoreAllMocks();
  });

  /**
   * Scenario B: After compact, post-checkpoint conversation
   * accumulation is correct — adding new messages and reading back
   * produces an in-order conversation.
   */
  it("after compact: subsequent messages are appended correctly and ordered with checkpoint", async () => {
    await component.init({
      env: mockEnv,
      options: {
        configComponent,
        config: { storage: { type: "sqlite", dbPath: tempDbPath } },
      },
    });

    const session = await component.create({ title: "E2E compress flow" });

    // Pre-checkpoint messages (will be archived)
    for (let i = 0; i < 30; i++) {
      await component.addMessage(session.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: `pre_msg_${i}`,
      });
    }

    // Compact
    const r = await component.compact(session.id);
    expect(r.deletedMessageCount).toBe(30);

    // Post-checkpoint messages
    await component.addMessage(session.id, { role: "user", content: "post_1_user" });
    await component.addMessage(session.id, {
      role: "assistant",
      content: "post_1_assistant_response",
    });
    await component.addMessage(session.id, { role: "user", content: "post_2_user" });

    // Read back via getContext (not fullHistory) — what the agent sees.
    const ctx = await component.getContext(session.id, { fullHistory: false });
    // Expect: 1 checkpoint + 3 post-checkpoint messages = 4 total
    expect(ctx.messages.length).toBe(4);

    // The 30 pre-checkpoint messages must not appear.
    const content = ctx.messages.map((m) => m.content).join("\n");
    expect(content).not.toContain("pre_msg_0");
    expect(content).not.toContain("pre_msg_29");

    // Post-checkpoint messages must appear in order.
    expect(content).toContain("post_1_user");
    expect(content).toContain("post_1_assistant_response");
    expect(content).toContain("post_2_user");
  });

  /**
   * Bug #2 Scenario B: Exceeding-threshold conversation succeeds
   * through compression + continue-conversation in a single round.
   * The flow:
   *   - 60 huge messages pushed the session over threshold
   *   - compact() succeeds (mock agent component handles it)
   *   - the next query sees only checkpoint + new input
   */
  it("threshold-crossing session: compact succeeds and post-compact context is clean", async () => {
    await component.init({
      env: mockEnv,
      options: {
        configComponent,
        config: { storage: { type: "sqlite", dbPath: tempDbPath } },
      },
    });

    const session = await component.create({ title: "Threshold crossing" });

    // 60 messages, each 50KB. Way beyond any typical context window.
    const blob = "Y".repeat(50_000);
    for (let i = 0; i < 60; i++) {
      await component.addMessage(session.id, {
        role: i % 2 === 0 ? "user" : "assistant",
        content: blob,
      });
    }

    // First compact: should NOT throw (mock agent handles it).
    const r = await component.compact(session.id);
    expect(r.deletedMessageCount).toBe(60);
    expect(r.remainingMessageCount).toBe(1);

    // Now simulate the post-compact query continuing the conversation.
    await component.addMessage(session.id, { role: "user", content: "continue please" });
    await component.addMessage(session.id, {
      role: "assistant",
      content: "yes, continuing",
    });

    // Read back via getContext — only post-checkpoint + checkpoint, not
    // the 6MB of archived blobs.
    const ctx = await component.getContext(session.id, { fullHistory: false });
    const allContent = ctx.messages.map((m) => m.content).join("");
    // No "Y".repeat(50_000) blobs should appear (they were archived).
    expect(allContent).not.toContain("Y".repeat(1000));
    // The new conversation IS visible.
    expect(allContent).toContain("continue please");
    expect(allContent).toContain("yes, continuing");
  });
});
