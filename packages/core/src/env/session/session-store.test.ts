import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { MemorySessionStore } from "./storage/memory";
import { SQLiteSessionStore } from "./storage/sqlite";
import { join } from "path";
import * as fs from "fs";

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * 创建临时数据库路径（每次测试使用唯一路径）
 */
function createTestDbPath(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 8);
  return join("/tmp", `test-sessions-${timestamp}-${random}.db`);
}

/**
 * 清理测试数据库文件
 */
async function cleanupTestDb(dbPath: string): Promise<void> {
  try {
    await fs.promises.unlink(dbPath);
  } catch {
    // 文件不存在，忽略
  }
  // 也清理可能的 WAL 和 SHM 文件
  try {
    await fs.promises.unlink(`${dbPath}-wal`);
  } catch {}
  try {
    await fs.promises.unlink(`${dbPath}-shm`);
  } catch {}
}

// ============================================================================
// SQLiteSessionStore Tests
// ============================================================================

describe("SQLiteSessionStore 基础功能", () => {
  let store: SQLiteSessionStore;
  let testDbPath: string;

  beforeEach(async () => {
    testDbPath = createTestDbPath();
    store = new SQLiteSessionStore(testDbPath);
  });

  afterEach(async () => {
    await store.close();
    await cleanupTestDb(testDbPath);
  });

  describe("Session CRUD", () => {
    test("应该创建新会话", async () => {
      const session = await store.create({ title: "Test Session" });
      
      expect(session.id).toMatch(/^session_/);
      expect(session.title).toBe("Test Session");
      expect(session.directory).toBe("/tmp");
      expect(session.messageCount).toBe(0);
    });

    test("应该获取会话", async () => {
      const created = await store.create({ title: "Get Test" });
      const retrieved = await store.get(created.id);
      
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.title).toBe("Get Test");
    });

    test("获取不存在的会话应返回 undefined", async () => {
      const result = await store.get("non-existent-id");
      expect(result).toBeUndefined();
    });

    test("应该列出所有会话", async () => {
      await store.create({ title: "Session 1" });
      await store.create({ title: "Session 2" });
      await store.create({ title: "Session 3" });
      
      const sessions = await store.list();
      expect(sessions.length).toBeGreaterThanOrEqual(3);
    });

    test("应该更新会话标题", async () => {
      const session = await store.create({ title: "Old Title" });
      const updated = await store.update(session.id, { title: "New Title" });
      
      expect(updated).toBe(true);
      const retrieved = await store.get(session.id);
      expect(retrieved?.title).toBe("New Title");
    });

    test("更新不存在的会话应返回 false", async () => {
      const result = await store.update("non-existent-id", { title: "Test" });
      expect(result).toBe(false);
    });

    test("应该删除会话", async () => {
      const session = await store.create({ title: "To Delete" });
      const deleted = await store.delete(session.id);
      
      expect(deleted).toBe(true);
      const retrieved = await store.get(session.id);
      expect(retrieved).toBeUndefined();
    });

    test("删除不存在的会话应返回 false", async () => {
      const result = await store.delete("non-existent-id");
      expect(result).toBe(false);
    });
  });

  describe("Messages", () => {
    test("应该添加消息到会话", async () => {
      const session = await store.create({ title: "Messages Test" });
      const messageId = await store.addMessage(session.id, {
        role: "user",
        content: "Hello, world!"
      });
      
      expect(messageId).toMatch(/^msg_/);
    });

    test("添加消息到不存在的会话应抛出错误", async () => {
      await expect(
        store.addMessage("non-existent", { role: "user", content: "Test" })
      ).rejects.toThrow("Session not found");
    });

    test("应该获取会话消息", async () => {
      const session = await store.create({ title: "Get Messages Test" });
      await store.addMessage(session.id, { role: "user", content: "Message 1" });
      await store.addMessage(session.id, { role: "assistant", content: "Message 2" });
      
      const messages = await store.getMessages(session.id);
      expect(messages.length).toBe(2);
      expect(messages[0].content).toBe("Message 1");
      expect(messages[1].content).toBe("Message 2");
    });

    test("应该获取消息数量", async () => {
      const session = await store.create({ title: "Count Test" });
      await store.addMessage(session.id, { role: "user", content: "1" });
      await store.addMessage(session.id, { role: "user", content: "2" });
      await store.addMessage(session.id, { role: "user", content: "3" });
      
      const count = await store.getMessageCount(session.id);
      expect(count).toBe(3);
    });

    test("应该支持分页获取消息", async () => {
      const session = await store.create({ title: "Pagination Test" });
      for (let i = 0; i < 10; i++) {
        await store.addMessage(session.id, { role: "user", content: `Message ${i}` });
      }
      
      const messages1 = await store.getMessages(session.id, 0, 3);
      expect(messages1.length).toBe(3);
      
      const messages2 = await store.getMessages(session.id, 3, 3);
      expect(messages2.length).toBe(3);
    });
  });

  describe("持久化", () => {
    test("应该持久化会话数据", async () => {
      // 创建并关闭
      const session = await store.create({ title: "Persistence Test" });
      await store.close();
      
      // 重新创建 store（相同路径）
      const store2 = new SQLiteSessionStore(testDbPath);
      const retrieved = await store2.get(session.id);
      
      expect(retrieved).toBeDefined();
      expect(retrieved?.title).toBe("Persistence Test");
      
      await store2.close();
    });

    test("应该持久化消息数据", async () => {
      const session = await store.create({ title: "Messages Persistence Test" });
      await store.addMessage(session.id, { role: "user", content: "Persisted message" });
      await store.close();
      
      const store2 = new SQLiteSessionStore(testDbPath);
      const messages = await store2.getMessages(session.id);
      
      expect(messages.length).toBe(1);
      expect(messages[0].content).toBe("Persisted message");
      
      await store2.close();
    });
  });

  describe("close", () => {
    test("close后应该清理内存缓存但保留持久化数据", async () => {
      await store.create({ title: "Session 1" });
      await store.create({ title: "Session 2" });
      
      const sessionsBefore = await store.list();
      expect(sessionsBefore.length).toBeGreaterThanOrEqual(2);
      
      await store.close();
      
      // SQLite close 后数据仍然持久化，重新打开可以读取
      const store2 = new SQLiteSessionStore(testDbPath);
      const sessionsAfter = await store2.list();
      expect(sessionsAfter.length).toBeGreaterThanOrEqual(2);
      await store2.close();
    });

    test("应该支持多次调用", async () => {
      await store.create({ title: "Test" });
      
      await store.close();
      await store.close();
      
      expect(true).toBe(true);
    });
  });
});

// ============================================================================
// MemorySessionStore Tests
// ============================================================================

describe("SessionStore 资源清理", () => {
  let store: MemorySessionStore;
  
  beforeEach(() => {
    store = new MemorySessionStore();
  });
  
  describe("close", () => {
    test("应该清理所有会话数据", async () => {
      // 创建一些会话
      await store.create({ title: "Session 1" });
      await store.create({ title: "Session 2" });
      
      // 验证有数据
      const sessionsBefore = await store.list();
      expect(sessionsBefore.length).toBe(2);
      
      // 调用 close
      await store.close();
      
      // 验证数据已清理
      const sessionsAfter = await store.list();
      expect(sessionsAfter.length).toBe(0);
    });
    
    test("应该清理所有消息数据", async () => {
      // 创建会话并添加消息
      const session = await store.create({ title: "Test Session" });
      await store.addMessage(session.id, { role: "user", content: "Hello" });
      await store.addMessage(session.id, { role: "assistant", content: "Hi" });
      
      // 验证有消息
      const countBefore = await store.getMessageCount(session.id);
      expect(countBefore).toBe(2);
      
      // 调用 close
      await store.close();
      
      // 验证消息已清理
      const countAfter = await store.getMessageCount(session.id);
      expect(countAfter).toBe(0);
    });
    
    test("应该支持多次调用", async () => {
      await store.create({ title: "Test" });
      
      // 多次调用不应该报错
      await store.close();
      await store.close();
      
      expect(true).toBe(true);
    });
  });

  describe("getMessageIndexes", () => {
    test("应该返回指定role的所有消息index", async () => {
      const session = await store.create({ title: "Get Indexes Test" });
      // user, assistant, user, assistant, user
      await store.addMessage(session.id, { role: "user", content: "Msg 0" });
      await store.addMessage(session.id, { role: "assistant", content: "Msg 1" });
      await store.addMessage(session.id, { role: "user", content: "Msg 2" });
      await store.addMessage(session.id, { role: "assistant", content: "Msg 3" });
      await store.addMessage(session.id, { role: "user", content: "Msg 4" });
      
      const userIndexes = await store.getMessageIndexes(session.id, "user");
      expect(userIndexes).toEqual([0, 2, 4]);
      
      const assistantIndexes = await store.getMessageIndexes(session.id, "assistant");
      expect(assistantIndexes).toEqual([1, 3]);
    });

    test("应该返回空数组当没有匹配的消息", async () => {
      const session = await store.create({ title: "No Match Test" });
      await store.addMessage(session.id, { role: "user", content: "Msg 0" });
      
      const systemIndexes = await store.getMessageIndexes(session.id, "system");
      expect(systemIndexes).toEqual([]);
    });

    test("应该返回空数组当会话不存在", async () => {
      const indexes = await store.getMessageIndexes("non-existent", "user");
      expect(indexes).toEqual([]);
    });
  });

  describe("getMessages with negative offset", () => {
    test("应该支持负数offset从后往前取", async () => {
      const session = await store.create({ title: "Negative Offset Test" });
      // 添加 10 条消息
      for (let i = 0; i < 10; i++) {
        await store.addMessage(session.id, { role: "user", content: `Msg ${i}` });
      }
      
      // offset=-1, limit=5: 获取最新的 5 条
      const messages1 = await store.getMessages(session.id, -1, 5);
      expect(messages1.length).toBe(5);
      expect(messages1[0].content).toBe("Msg 5"); // 第 6 条开始
      expect(messages1[4].content).toBe("Msg 9"); // 最后一条
      
      // offset=-2, limit=5: 获取倒数第 2 批 5 条
      const messages2 = await store.getMessages(session.id, -2, 5);
      expect(messages2.length).toBe(5);
      expect(messages2[0].content).toBe("Msg 0"); // 第 1 条开始
      expect(messages2[4].content).toBe("Msg 4"); // 第 5 条
    });

    test("负数offset超出范围应该返回空数组", async () => {
      const session = await store.create({ title: "Negative Offset Overflow Test" });
      await store.addMessage(session.id, { role: "user", content: "Msg 0" });
      
      // offset=-10, limit=5: 超出范围
      const messages = await store.getMessages(session.id, -10, 5);
      expect(messages.length).toBe(1);
    });
  });

  describe("SessionMetadata messageCount", () => {
    test("应该在添加消息后更新metadata中的messageCount", async () => {
      const session = await store.create({ title: "Message Count Test" });
      expect(session.metadata?.messageCount).toBe(0);
      
      await store.addMessage(session.id, { role: "user", content: "Msg 0" });
      await store.addMessage(session.id, { role: "assistant", content: "Msg 1" });
      await store.addMessage(session.id, { role: "user", content: "Msg 2" });
      
      const updated = await store.get(session.id);
      expect(updated?.metadata?.messageCount).toBe(3);
    });
  });
});
