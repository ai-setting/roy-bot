/**
 * @fileoverview SessionComponent Search Tests
 * 
 * TDD: Tests for searchMessages functionality
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "bun:test";
import { SessionComponent } from "./session-component";
import type { Session } from "./types";
import { ConfigComponent } from "../../config/config-component";
import * as fsSync from "fs";
import * as path from "path";
import * as os from "os";
import type { Environment } from "../interface";

// ============================================================================
// Test Utilities
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

// ============================================================================
// Test Suite
// ============================================================================

describe("SessionComponent.searchMessages", () => {
  let component: SessionComponent;
  let configComponent: ConfigComponent;
  let mockEnv: Environment;
  let tempDbPath: string;

  beforeEach(async () => {
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
    if (component.getStatus() !== "stopped") {
      try { await component.stop(); } catch {}
    }
    await cleanupTempDb(tempDbPath);
    vi.restoreAllMocks();
  });

  describe("基本搜索", () => {
    test("应该找到包含关键字的消息", async () => {
      await component.init({
        env: mockEnv,
        options: {
          configComponent,
          config: {
            storage: { type: "sqlite", dbPath: tempDbPath }
          }
        }
      });

      const session = await component.create({ title: "Test Session" });
      await component.addMessage(session.id, { role: "user", content: "Hello world" });
      await component.addMessage(session.id, { role: "assistant", content: "Hi there!" });

      const results = await component.searchMessages({ query: "hello" });

      expect(results.length).toBe(1);
      expect(results[0].sessionId).toBe(session.id);
      expect(results[0].matches.length).toBe(1);
      expect(results[0].matches[0].content).toBe("Hello world");
    });

    test("应该支持多关键字搜索（AND）", async () => {
      await component.init({
        env: mockEnv,
        options: {
          configComponent,
          config: {
            storage: { type: "sqlite", dbPath: tempDbPath }
          }
        }
      });

      const session = await component.create({ title: "Test Session" });
      await component.addMessage(session.id, { role: "user", content: "Hello world" });
      await component.addMessage(session.id, { role: "user", content: "Hello foo" });
      await component.addMessage(session.id, { role: "user", content: "world bar" });

      const results = await component.searchMessages({ query: "hello world" });

      // 应该只匹配同时包含 hello 和 world 的消息
      expect(results.length).toBeGreaterThanOrEqual(1);
      const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
      expect(totalMatches).toBeGreaterThanOrEqual(1);
    });

    test("应该支持 NOT 操作符", async () => {
      await component.init({
        env: mockEnv,
        options: {
          configComponent,
          config: {
            storage: { type: "sqlite", dbPath: tempDbPath }
          }
        }
      });

      const session = await component.create({ title: "Test Session" });
      await component.addMessage(session.id, { role: "user", content: "Hello world" });
      await component.addMessage(session.id, { role: "user", content: "Hello foo" });

      const results = await component.searchMessages({ query: "hello NOT foo" });

      expect(results.length).toBe(1);
      expect(results[0].matches.length).toBe(1);
      expect(results[0].matches[0].content).toBe("Hello world");
    });

    test("应该支持引号短语匹配", async () => {
      await component.init({
        env: mockEnv,
        options: {
          configComponent,
          config: {
            storage: { type: "sqlite", dbPath: tempDbPath }
          }
        }
      });

      const session = await component.create({ title: "Test Session" });
      // 包含完整短语 "hello world"
      await component.addMessage(session.id, { role: "user", content: 'Say "hello world" to everyone' });
      // 只包含分开的 hello 和 world，不是完整短语
      await component.addMessage(session.id, { role: "user", content: "hello there world" });

      const results = await component.searchMessages({ query: '"hello world"' });

      expect(results.length).toBe(1);
      expect(results[0].matches.length).toBe(1);
      expect(results[0].matches[0].content).toContain('"hello world"');
    });
  });

  describe("搜索结果聚合", () => {
    test("应该按 session 聚合结果", async () => {
      await component.init({
        env: mockEnv,
        options: {
          configComponent,
          config: {
            storage: { type: "sqlite", dbPath: tempDbPath }
          }
        }
      });

      const session1 = await component.create({ title: "Session 1" });
      const session2 = await component.create({ title: "Session 2" });
      
      await component.addMessage(session1.id, { role: "user", content: "test message 1" });
      await component.addMessage(session2.id, { role: "user", content: "test message 2" });

      const results = await component.searchMessages({ query: "test" });

      expect(results.length).toBe(2);
      expect(results.map(r => r.sessionId).sort()).toEqual([session1.id, session2.id].sort());
    });

    test("应该返回 session 元信息", async () => {
      await component.init({
        env: mockEnv,
        options: {
          configComponent,
          config: {
            storage: { type: "sqlite", dbPath: tempDbPath }
          }
        }
      });

      const session = await component.create({ title: "Test Session" });
      await component.addMessage(session.id, { role: "user", content: "test content" });

      const results = await component.searchMessages({ query: "test" });

      expect(results.length).toBe(1);
      expect(results[0].sessionTitle).toBe("Test Session");
      expect(results[0].sessionId).toBe(session.id);
      expect(results[0].messageCount).toBe(1);
    });

    test("应该支持限制每个 session 的结果数", async () => {
      await component.init({
        env: mockEnv,
        options: {
          configComponent,
          config: {
            storage: { type: "sqlite", dbPath: tempDbPath }
          }
        }
      });

      const session = await component.create({ title: "Test Session" });
      for (let i = 0; i < 5; i++) {
        await component.addMessage(session.id, { role: "user", content: `test message ${i}` });
      }

      const results = await component.searchMessages({ query: "test", limit: 2 });

      expect(results.length).toBe(1);
      expect(results[0].matches.length).toBeLessThanOrEqual(2);
    });
  });

  describe("搜索选项", () => {
    test("应该支持限制特定 session", async () => {
      await component.init({
        env: mockEnv,
        options: {
          configComponent,
          config: {
            storage: { type: "sqlite", dbPath: tempDbPath }
          }
        }
      });

      const session1 = await component.create({ title: "Session 1" });
      const session2 = await component.create({ title: "Session 2" });
      
      await component.addMessage(session1.id, { role: "user", content: "test message" });
      await component.addMessage(session2.id, { role: "user", content: "test message" });

      const results = await component.searchMessages({ query: "test", sessionId: session1.id });

      expect(results.length).toBe(1);
      expect(results[0].sessionId).toBe(session1.id);
    });

    test("应该支持 limit 参数限制总结果数", async () => {
      await component.init({
        env: mockEnv,
        options: {
          configComponent,
          config: {
            storage: { type: "sqlite", dbPath: tempDbPath }
          }
        }
      });

      for (let i = 0; i < 3; i++) {
        const session = await component.create({ title: `Session ${i}` });
        await component.addMessage(session.id, { role: "user", content: "test" });
      }

      const results = await component.searchMessages({ query: "test", maxResults: 2 });

      const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);
      expect(totalMatches).toBeLessThanOrEqual(2);
    });
  });

  describe("MessageMatch 结构", () => {
    test("应该返回正确的 match 结构", async () => {
      await component.init({
        env: mockEnv,
        options: {
          configComponent,
          config: {
            storage: { type: "sqlite", dbPath: tempDbPath }
          }
        }
      });

      const session = await component.create({ title: "Test" });
      await component.addMessage(session.id, { role: "user", content: "test message" });

      const results = await component.searchMessages({ query: "test" });

      expect(results.length).toBe(1);
      const match = results[0].matches[0];
      expect(match).toHaveProperty("messageId");
      expect(match).toHaveProperty("sessionId");
      expect(match).toHaveProperty("role");
      expect(match).toHaveProperty("content");
      expect(match).toHaveProperty("timestamp");
      expect(match.role).toBe("user");
      expect(match.content).toBe("test message");
    });

    test("应该支持 includeContext 选项", async () => {
      await component.init({
        env: mockEnv,
        options: {
          configComponent,
          config: {
            storage: { type: "sqlite", dbPath: tempDbPath }
          }
        }
      });

      const session = await component.create({ title: "Test" });
      await component.addMessage(session.id, { role: "user", content: "before message" });
      await component.addMessage(session.id, { role: "user", content: "test target" });
      await component.addMessage(session.id, { role: "user", content: "after message" });

      const results = await component.searchMessages({ 
        query: "test", 
        includeContext: true,
        contextLines: 1 
      });

      expect(results.length).toBe(1);
      const match = results[0].matches[0];
      expect(match).toHaveProperty("contextBefore");
      expect(match).toHaveProperty("contextAfter");
    });
  });

  describe("边界情况", () => {
    test("无结果时应该返回空数组", async () => {
      await component.init({
        env: mockEnv,
        options: {
          configComponent,
          config: {
            storage: { type: "sqlite", dbPath: tempDbPath }
          }
        }
      });

      const results = await component.searchMessages({ query: "nonexistent" });

      expect(results).toEqual([]);
    });

    test("搜索不存在的 session 应该返回空数组", async () => {
      await component.init({
        env: mockEnv,
        options: {
          configComponent,
          config: {
            storage: { type: "sqlite", dbPath: tempDbPath }
          }
        }
      });

      const results = await component.searchMessages({ 
        query: "test", 
        sessionId: "nonexistent-session-id" 
      });

      expect(results).toEqual([]);
    });

    test("应该正确处理大小写", async () => {
      await component.init({
        env: mockEnv,
        options: {
          configComponent,
          config: {
            storage: { type: "sqlite", dbPath: tempDbPath }
          }
        }
      });

      const session = await component.create({ title: "Test" });
      await component.addMessage(session.id, { role: "user", content: "HELLO World" });

      const results = await component.searchMessages({ query: "hello" });

      expect(results.length).toBe(1);
    });
  });
});
