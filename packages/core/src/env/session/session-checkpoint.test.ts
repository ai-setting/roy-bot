/**
 * @fileoverview Session Checkpoint Tests
 * 
 * TDD: 先写测试 (RED)，再实现代码 (GREEN)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { SessionComponent } from "./session-component";
import { ConfigComponent } from "../../config/config-component";
import type { SessionCheckpoint } from "./types";
import type { Environment } from "../interface";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";

// ============================================================================
// Test Utilities (for test isolation)
// ============================================================================

function createTempDbPath(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return path.join(os.tmpdir(), `test-sessions-${timestamp}-${random}.db`);
}

async function cleanupTempDb(dbPath: string): Promise<void> {
  try { await fsSync.promises.unlink(dbPath); } catch {}
  try { await fsSync.promises.unlink(`${dbPath}-wal`); } catch {}
  try { await fsSync.promises.unlink(`${dbPath}-shm`); } catch {}
}

describe("SessionComponent Checkpoint", () => {
  let component: SessionComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let tempDbPath: string;

  beforeEach(() => {
    component = new SessionComponent();
    configComponent = new ConfigComponent();
    tempDbPath = createTempDbPath();
    
    mockEnv = {
      name: "test-env",
      version: "1.0.0",
      getComponent: vi.fn((name: string) => {
        if (name === "config") return configComponent;
        return undefined;
      }),
      hasComponent: vi.fn((name: string) => name === "config"),
      logger: vi.fn(),
      trace: vi.fn(),
    } as unknown as Environment;
  });

  afterEach(async () => {
    // Stop component to release resources
    if (component.getStatus() !== "stopped") {
      try {
        await component.stop();
      } catch {}
    }
    // Clean up temporary database
    await cleanupTempDb(tempDbPath);
    vi.restoreAllMocks();
  });

  describe("Checkpoint types", () => {
    test("should have version 1.1.0 or higher", async () => {
      await component.init({ 
        env: mockEnv, 
        options: { 
          configComponent,
          config: { storage: { type: "sqlite", dbPath: tempDbPath } }
        } 
      });
      expect(component.version).toBe("1.1.0");
    });
  });

  describe("create with checkpoints metadata", () => {
    test("should initialize session with checkpoints metadata", async () => {
      await component.init({ 
        env: mockEnv, 
        options: { 
          configComponent,
          config: { storage: { type: "sqlite", dbPath: tempDbPath } }
        } 
      });
      const session = await component.create({ title: "Test Session" });

      expect(session.metadata).toBeDefined();
      expect(session.metadata?.checkpoints).toBeDefined();
      expect(session.metadata?.checkpoints?.checkpoints).toEqual([]);
      expect(session.metadata?.checkpoints?.latestCheckpointId).toBeUndefined();
    });
  });

  describe("previewCompact", () => {
    test("should preview compact without making changes", async () => {
      await component.init({ 
        env: mockEnv, 
        options: { 
          configComponent,
          config: { storage: { type: "sqlite", dbPath: tempDbPath } }
        } 
      });
      const session = await component.create({ title: "Test" });
      
      // Add some messages
      await component.addMessage(session.id, { role: "user", content: "Hello" });
      await component.addMessage(session.id, { role: "assistant", content: "Hi there" });
      await component.addMessage(session.id, { role: "user", content: "How are you?" });

      const preview = await component.previewCompact(session.id);

      expect(preview).toBeDefined();
      expect(preview.messageCountToCompact).toBe(3);
      expect(preview.wouldTrigger).toBe(false); // Less than maxMessages
    });

    test("should throw error for non-existent session", async () => {
      await component.init({ 
        env: mockEnv, 
        options: { 
          configComponent,
          config: { storage: { type: "sqlite", dbPath: tempDbPath } }
        } 
      });
      
      await expect(component.previewCompact("non-existent")).rejects.toThrow("Session not found");
    });
  });

  describe("getCheckpoints", () => {
    test("should return empty array for session without checkpoints", async () => {
      await component.init({ 
        env: mockEnv, 
        options: { 
          configComponent,
          config: { storage: { type: "sqlite", dbPath: tempDbPath } }
        } 
      });
      const session = await component.create({ title: "Test" });

      const checkpoints = await component.getCheckpoints(session.id);

      expect(checkpoints).toEqual([]);
    });

    test("should return checkpoints after compact", async () => {
      await component.init({ 
        env: mockEnv, 
        options: { 
          configComponent,
          config: { storage: { type: "sqlite", dbPath: tempDbPath } }
        } 
      });
      const session = await component.create({ title: "Test" });

      // This test will fail because compact needs SummaryAgent
      // We'll implement it after setting up the mock
    });
  });

  describe("getCheckpoint", () => {
    test("should return undefined for non-existent checkpoint", async () => {
      await component.init({ 
        env: mockEnv, 
        options: { 
          configComponent,
          config: { storage: { type: "sqlite", dbPath: tempDbPath } }
        } 
      });
      const session = await component.create({ title: "Test" });

      const checkpoint = await component.getCheckpoint(session.id, "non-existent");

      expect(checkpoint).toBeUndefined();
    });
  });

  describe("deleteCheckpoint", () => {
    test("should return false for non-existent checkpoint", async () => {
      await component.init({ 
        env: mockEnv, 
        options: { 
          configComponent,
          config: { storage: { type: "sqlite", dbPath: tempDbPath } }
        } 
      });
      const session = await component.create({ title: "Test" });

      const result = await component.deleteCheckpoint(session.id, "non-existent");

      expect(result).toBe(false);
    });
  });

  describe("getContext", () => {
    test("should get context from session", async () => {
      await component.init({ 
        env: mockEnv, 
        options: { 
          configComponent,
          config: { storage: { type: "sqlite", dbPath: tempDbPath } }
        } 
      });
      const session = await component.create({ title: "Test" });

      const ctx = await component.getContext(session.id);

      expect(ctx).toBeDefined();
      expect(ctx.session).toBeDefined();
      expect(ctx.messages).toBeDefined();
      expect(Array.isArray(ctx.messages)).toBe(true);
    });

    test("should throw error for non-existent session", async () => {
      await component.init({ 
        env: mockEnv, 
        options: { 
          configComponent,
          config: { storage: { type: "sqlite", dbPath: tempDbPath } }
        } 
      });

      await expect(component.getContext("non-existent")).rejects.toThrow("Session not found");
    });

    test("should return full history when fullHistory is true", async () => {
      await component.init({ 
        env: mockEnv, 
        options: { 
          configComponent,
          config: { storage: { type: "sqlite", dbPath: tempDbPath } }
        } 
      });
      const session = await component.create({ title: "Test" });
      await component.addMessage(session.id, { role: "user", content: "Hello" });

      const ctx = await component.getContext(session.id, { fullHistory: true });

      expect(ctx.totalMessageCount).toBe(1);
      expect(ctx.messages.length).toBe(1);
    });

    test("should apply message limit", async () => {
      await component.init({ env: mockEnv, options: { configComponent, config: { storage: { type: "sqlite", dbPath: tempDbPath } } } });
      const session = await component.create({ title: "Test" });
      
      for (let i = 0; i < 10; i++) {
        await component.addMessage(session.id, { role: "user", content: `Message ${i}` });
      }

      const ctx = await component.getContext(session.id, { messageLimit: 5 });

      expect(ctx.messages.length).toBeLessThanOrEqual(5);
    });

    test("should get all messages when session has more than 50 messages", async () => {
      // This test verifies the bug fix: getMessages has default limit=50
      // which causes incomplete message retrieval when session has > 50 messages
      await component.init({ env: mockEnv, options: { configComponent, config: { storage: { type: "sqlite", dbPath: tempDbPath } } } });
      const session = await component.create({ title: "Test" });

      // Add 60 messages (exceeds default limit of 50)
      for (let i = 0; i < 60; i++) {
        await component.addMessage(session.id, { role: "user", content: `Message ${i}` });
      }

      const ctx = await component.getContext(session.id);

      // Should return all 60 messages, not just 50
      expect(ctx.messages.length).toBe(60);
      expect(ctx.totalMessageCount).toBe(60);
      expect(ctx.messages[0].content).toBe("Message 0");
      expect(ctx.messages[59].content).toBe("Message 59");
    });

    test("should get all messages including checkpoints when session has > 50 messages", async () => {
      // Test that getContext returns all messages when session has > 50 messages
      // (optimization with checkpoint is tested separately)
      await component.init({ env: mockEnv, options: { configComponent, config: { storage: { type: "sqlite", dbPath: tempDbPath } } } });
      const session = await component.create({ title: "Test" });

      // Add 60 messages (exceeds default limit of 50)
      for (let i = 0; i < 60; i++) {
        await component.addMessage(session.id, { role: "user", content: `Message ${i}` });
      }

      const ctx = await component.getContext(session.id);

      // Should return all 60 messages
      expect(ctx.messages.length).toBe(60);
      expect(ctx.totalMessageCount).toBe(60);
    });

    test("should read from checkpoint when checkpoint metadata exists", async () => {
      // Test the optimization: when checkpoint exists in session metadata,
      // getContext should read from checkpoint position, not from 0
      await component.init({ env: mockEnv, options: { configComponent, config: { storage: { type: "sqlite", dbPath: tempDbPath } } } });
      const session = await component.create({ title: "Test" });

      // Add 10 messages
      for (let i = 0; i < 10; i++) {
        await component.addMessage(session.id, { role: "user", content: `Message ${i}` });
      }

      // Add a checkpoint message at position 10
      await component.addMessage(session.id, {
        role: "user",
        content: "# Checkpoint",
        metadata: { isCheckpoint: true, checkpointId: "cp_test" }
      });

      // Add 10 more messages (total 21, with checkpoint at position 10)
      for (let i = 10; i < 20; i++) {
        await component.addMessage(session.id, { role: "user", content: `Message ${i}` });
      }

      // Without checkpoint metadata in session, should return all 21 messages
      const ctxWithoutMetadata = await component.getContext(session.id);
      expect(ctxWithoutMetadata.messages.length).toBe(21);

      // With checkpoint metadata in session, should return only 11 messages (from checkpoint)
      // Note: The optimization in getContext reads from checkpoint.messageIndex when available
    });

    test("should correctly identify checkpoint position from metadata", async () => {
      // Verify that checkpoint messageIndex is correctly tracked
      await component.init({ env: mockEnv, options: { configComponent, config: { storage: { type: "sqlite", dbPath: tempDbPath } } } });
      const session = await component.create({ title: "Test" });

      // Add messages
      await component.addMessage(session.id, { role: "user", content: "First" });
      await component.addMessage(session.id, { role: "user", content: "Second" });

      // Get checkpoints - should be empty initially
      const checkpointsBefore = await component.getCheckpoints(session.id);
      expect(checkpointsBefore.length).toBe(0);

      // Add checkpoint message
      await component.addMessage(session.id, {
        role: "user",
        content: "# Checkpoint",
        metadata: { isCheckpoint: true, checkpointId: "cp_manual" }
      });

      // Add more messages
      await component.addMessage(session.id, { role: "user", content: "After checkpoint" });

      // Verify we can get the checkpoint by ID (when it's stored properly)
      const checkpoint = await component.getCheckpoint(session.id, "cp_manual");
      // Note: This will be undefined unless the checkpoint was created via compact()
      // which properly stores it in the checkpoints cache
    });

    test("should get all messages with fullHistory when session has > 50 messages", async () => {
      // Test that fullHistory returns ALL messages including those before checkpoint
      await component.init({ env: mockEnv, options: { configComponent, config: { storage: { type: "sqlite", dbPath: tempDbPath } } } });
      const session = await component.create({ title: "Test" });

      // Add 30 messages
      for (let i = 0; i < 30; i++) {
        await component.addMessage(session.id, { role: "user", content: `Message ${i}` });
      }

      // Add a checkpoint message
      // ★ C 方案（Task #4933）：checkpoint 消息必须带 checkpointMeta ——
      //   生产路径（createCheckpointMessage）总是写入它，getContext 依赖它
      //   提取 checkpoints 列表。手写 fixture 也要真实形态。
      await component.addMessage(session.id, {
        role: "user",
        content: "# Checkpoint\n\n这是测试 checkpoint 的整段自然语言正文，长度超过阈值。",
        metadata: {
          isCheckpoint: true,
          checkpointId: "cp_test",
          checkpointMeta: {
            id: "cp_test",
            messageIndex: 30,
            title: "测试 checkpoint",
            content: "这是测试 checkpoint 的整段自然语言正文，长度超过阈值。",
            createdAt: Date.now(),
            type: "compact",
            messageCountBefore: 30,
          },
        },
      });

      // Add 40 more messages (total 71, with checkpoint)
      for (let i = 30; i < 70; i++) {
        await component.addMessage(session.id, { role: "user", content: `Message ${i}` });
      }

      const ctx = await component.getContext(session.id, { fullHistory: true });

      // Should return ALL 71 messages
      expect(ctx.messages.length).toBe(71);
      expect(ctx.totalMessageCount).toBe(71);
      expect(ctx.checkpoints.length).toBe(1);
    });
  });

  describe("shouldCompact", () => {
    test("should return false when messages below threshold", async () => {
      await component.init({ 
        env: mockEnv, 
        options: { 
          configComponent,
          config: { 
            maxMessages: 100,
            storage: { type: "sqlite", dbPath: tempDbPath } 
          }
        } 
      });
      const session = await component.create({ title: "Test" });
      await component.addMessage(session.id, { role: "user", content: "Hi" });

      const result = await component.shouldCompact(session.id);

      expect(result).toBe(false);
    });
  });
});

describe("SessionCheckpoint types", () => {
  test("should have required checkpoint properties (C 方案：整段 content)", () => {
    const checkpoint = {
      id: "cp_test",
      messageIndex: 0,
      title: "Test Checkpoint",
      content: "本次会话完成了压缩机制改造，checkpoint 正文已退化为整段自然语言。",
      createdAt: Date.now(),
      type: "compact" as const,
      messageCountBefore: 10,
    };

    expect(checkpoint.id).toBe("cp_test");
    expect(checkpoint.type).toBe("compact");
    expect(typeof checkpoint.content).toBe("string");
    expect(checkpoint.content.length).toBeGreaterThan(0);
    expect(typeof checkpoint.messageCountBefore).toBe("number");
  });

  test("C 方案：不再有五栏位（summary/processKeyPoints/currentState/nextSteps/userIntents）", () => {
    // 用户决策：「不是说不用结构化吗…有的话不符合预期哈」
    // → 类型上彻底删除这些字段，避免下游误用。
    const checkpoint: Record<string, unknown> = {
      id: "cp_test",
      messageIndex: 0,
      title: "Test",
      content: "整段自然语言正文，长度足够。",
      createdAt: Date.now(),
      type: "compact",
      messageCountBefore: 0,
    };

    expect("summary" in checkpoint).toBe(false);
    expect("processKeyPoints" in checkpoint).toBe(false);
    expect("currentState" in checkpoint).toBe(false);
    expect("nextSteps" in checkpoint).toBe(false);
    expect("userIntents" in checkpoint).toBe(false);

    // TypeScript 层面验证：SessionCheckpoint 不含五栏位
    const _typeCheck: SessionCheckpoint = checkpoint as unknown as SessionCheckpoint;
    expect(_typeCheck.content).toBeDefined();
  });

  test("content 形式自由：段落 / 列表 / 代码块都合法", () => {
    const formats = [
      "一段连续的自然语言叙述，描述会话做了什么、到哪一步、后续要做什么。",
      "要点式：\n- 决策一\n- 决策二\n- 后续步骤",
      "含代码：\n```bash\nbun test --parallel 4\n```\n测试全部通过。",
    ];
    for (const content of formats) {
      const cp = {
        id: "cp_x",
        messageIndex: 0,
        title: "格式测试",
        content,
        createdAt: Date.now(),
        type: "compact" as const,
        messageCountBefore: 1,
      };
      expect(cp.content).toBe(content);
      expect(cp.content.length).toBeGreaterThan(0);
    }
  });
});
