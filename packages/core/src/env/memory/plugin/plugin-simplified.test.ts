/**
 * @fileoverview Memory Plugin Simplified Tests (TDD)
 * 
 * 测试目标：验证简化后的 Memory Plugin 设计
 * 
 * 设计原则：
 * - 移除 DraftManager（草稿管理已废弃）
 * - 移除 MemoryOrganizer（整理机制已废弃）
 * - 移除 AccessLog（访问日志已废弃）
 * - 保留 MemoryManager（核心组件）
 */

import { describe, expect, test } from "bun:test";
import * as pluginModule from "./index";

describe("Memory Plugin - Simplified Design", () => {
  describe("should NOT export deprecated components", () => {
    test("DraftManager should be removed/not exported", () => {
      // DraftManager 已被移除，不应该导出
      expect(pluginModule).not.toHaveProperty("DraftManager");
    });

    test("MemoryOrganizer should be removed/not exported", () => {
      expect(pluginModule).not.toHaveProperty("MemoryOrganizer");
    });

    test("AccessLog should be removed/not exported", () => {
      expect(pluginModule).not.toHaveProperty("AccessLog");
    });
  });

  describe("should keep core functionality", () => {
    test("MemoryManager should still exist as core component", () => {
      // MemoryManager 保留，作为核心组件
      expect(pluginModule.MemoryManager).toBeDefined();
    });

    test("MemoryPlugin should still exist for backwards compatibility", () => {
      // MemoryPlugin 保留，但简化内部实现
      expect(pluginModule.MemoryPlugin).toBeDefined();
    });

    test("createMemoryPlugin should still exist", () => {
      expect(pluginModule.createMemoryPlugin).toBeDefined();
    });

    test("recallMemory should still exist", () => {
      expect(pluginModule.recallMemory).toBeDefined();
    });
  });
});
