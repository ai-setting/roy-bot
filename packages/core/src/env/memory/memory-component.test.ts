/**
 * @fileoverview MemoryComponent Tests - Simplified
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import path from "path";
import fs from "fs/promises";
import os from "os";
import { MemoryComponent } from "./memory-component";
import { ConfigComponent } from "../../config/config-component";

describe("MemoryComponent", () => {
  let memoryComponent: MemoryComponent;
  let configComponent: ConfigComponent;
  let testDir: string;

  beforeEach(async () => {
    // 创建临时测试目录
    testDir = path.join(os.tmpdir(), `memory-test-${Date.now()}`);
    await fs.mkdir(path.join(testDir, "operations"), { recursive: true });
    await fs.mkdir(path.join(testDir, "solutions"), { recursive: true });

    // 写入测试文件
    await fs.writeFile(
      path.join(testDir, "operations", "task_123_design.md"),
      "# 操作记录\n\n## 问题\nBun 编译崩溃",
      "utf-8"
    );
    await fs.writeFile(
      path.join(testDir, "solutions", "fix_bun_crash.md"),
      "# 解决方案\n\n使用 gpt-4o 模型",
      "utf-8"
    );

    // 创建组件
    configComponent = new ConfigComponent();
    memoryComponent = new MemoryComponent();
    await memoryComponent.init({
      options: {
        configComponent,
        config: {
          memoryPaths: [{ type: "project", path: testDir }],
          recursive: true,
          cacheEnabled: false,
        },
      },
    });
  });

  afterEach(async () => {
    // 清理
    try {
      await memoryComponent.stop();
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  describe("init", () => {
    it("should initialize with config", async () => {
      expect(memoryComponent.name).toBe("memory");
      expect(memoryComponent.version).toBe("2.0.0");
    });

    it("should get memory paths", () => {
      const paths = memoryComponent.getMemoryPaths();
      expect(paths).toHaveLength(1);
      expect(paths[0].path).toBe(testDir);
    });
  });

  describe("recordMemory", () => {
    it("should create new memory file", async () => {
      const result = await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# 新记忆\n\n测试内容",
        title: "测试记忆",
      });

      expect(result).not.toBeNull();
      expect(result!.action).toBe("created");

      // 验证文件存在
      const memoryPath = path.join(testDir, "memory.md");
      const content = await fs.readFile(memoryPath, "utf-8");
      expect(content).toContain("测试记忆");
    });

    it("should overwrite existing memory file", async () => {
      // 先创建
      await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# 旧内容\n\n旧",
      });

      // 再覆盖
      const result = await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# 新内容\n\n新",
        title: "更新标题",
      });

      expect(result!.action).toBe("overwrite");

      const memoryPath = path.join(testDir, "memory.md");
      const content = await fs.readFile(memoryPath, "utf-8");
      expect(content).toContain("新内容");
      expect(content).not.toContain("旧内容");
    });

    it("should append to memory file", async () => {
      // 先创建
      await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# 初始内容",
      });

      // 追加
      const result = await memoryComponent.recordMemory({
        mode: "append",
        content: "追加的内容",
        title: "追加段落",
      });

      expect(result!.action).toBe("append");

      const memoryPath = path.join(testDir, "memory.md");
      const content = await fs.readFile(memoryPath, "utf-8");
      expect(content).toContain("初始内容");
      expect(content).toContain("追加的内容");
    });

    it("should prepend to memory file", async () => {
      // 先创建
      await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# 原有内容",
      });

      // 插入
      const result = await memoryComponent.recordMemory({
        mode: "prepend",
        content: "前置内容",
        title: "新段落",
      });

      expect(result!.action).toBe("prepend");

      const memoryPath = path.join(testDir, "memory.md");
      const content = await fs.readFile(memoryPath, "utf-8");
      expect(content.indexOf("前置内容")).toBeLessThan(content.indexOf("原有内容"));
    });

    it("should delete memory file", async () => {
      // 先创建
      await memoryComponent.recordMemory({
        mode: "overwrite",
        content: "# 要删除的内容",
      });

      // 删除
      const result = await memoryComponent.recordMemory({
        mode: "delete",
      });

      expect(result!.action).toBe("delete");

      const memoryPath = path.join(testDir, "memory.md");
      const exists = await fs.access(memoryPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);
    });
  });

  describe("recallMemory", () => {
    it("should read memory.md content", async () => {
      // 创建 memory.md 文件
      await fs.writeFile(
        path.join(testDir, "memory.md"),
        "# 用户记忆\n\n我喜欢吃苹果 🍎",
        "utf-8"
      );

      const result = await memoryComponent.recallMemory();

      expect(result).toContain("[project]");
      expect(result).toContain("memory.md");
      expect(result).toContain("我喜欢吃苹果");
    });

    it("should read from multiple memory paths", async () => {
      // 创建第二个路径
      const secondDir = path.join(os.tmpdir(), `memory-test-second-${Date.now()}`);
      await fs.mkdir(secondDir, { recursive: true });
      await fs.writeFile(
        path.join(secondDir, "memory.md"),
        "# 全局记忆\n\n全局配置信息",
        "utf-8"
      );

      // 更新配置添加第二个路径
      memoryComponent.updateMemoryPaths([
        { type: "project", path: testDir },
        { type: "user", path: secondDir },
      ]);

      // 创建 testDir 的 memory.md
      await fs.writeFile(
        path.join(testDir, "memory.md"),
        "# 用户记忆\n\n用户偏好",
        "utf-8"
      );

      const result = await memoryComponent.recallMemory();

      // 验证两个 scope 都出现
      expect(result).toContain("[project]");
      expect(result).toContain("[user]");
      expect(result).toContain("用户偏好");
      expect(result).toContain("全局配置信息");

      // 清理
      await fs.rm(secondDir, { recursive: true, force: true });
    });
  });

  describe("lifecycle", () => {
    it("should transition to running state after start", async () => {
      await memoryComponent.start();
      expect(memoryComponent.getStatus()).toBe("running");
    });

    it("should transition to stopped state after stop", async () => {
      await memoryComponent.start();
      await memoryComponent.stop();
      expect(memoryComponent.getStatus()).toBe("stopped");
    });
  });
});
