import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CommandsComponent } from "./commands-component";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import type { ConfigComponent } from "../../config/config-component";

/**
 * 创建 Mock ConfigComponent
 */
function createMockConfigComponent(initialConfig: Record<string, any> = {}): ConfigComponent {
  const storage = new Map<string, any>(Object.entries(initialConfig));
  
  return {
    get<T = any>(key: string): T | undefined {
      return storage.get(key);
    },
    set<T = any>(key: string, value: T): void {
      storage.set(key, value);
    },
    has(key: string): boolean {
      return storage.has(key);
    },
    delete(key: string): boolean {
      return storage.delete(key);
    },
    clear(): void {
      storage.clear();
    },
    getAll(): Record<string, any> {
      return Object.fromEntries(storage);
    },
    registerComponent: vi.fn(),
    registerSource: vi.fn(),
    load: vi.fn().mockResolvedValue(undefined),
    getSources: vi.fn().mockReturnValue([]),
    ensureSourcesCreated: vi.fn(),
  } as unknown as ConfigComponent;
}

describe("CommandsComponent", () => {
  let component: CommandsComponent;
  let tempDir: string;
  let userCommandsDir: string;
  let projectCommandsDir: string;
  let mockConfigComponent: ConfigComponent;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "roy-commands-test-"));
    userCommandsDir = path.join(tempDir, "user-commands");
    projectCommandsDir = path.join(tempDir, "project-commands");

    await fs.mkdir(userCommandsDir);
    await fs.mkdir(projectCommandsDir);

    component = new CommandsComponent();
    
    // 确保 mockConfigComponent 预先设置了命令目录配置
    // 避免测试污染真实的 ~/.roy-bot/commands 目录
    mockConfigComponent = createMockConfigComponent({
      "command.userCommandsDir": userCommandsDir,
      "command.projectCommandsDir": projectCommandsDir,
    });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("init", () => {
    it("should initialize with config from ConfigComponent", async () => {
      // 验证 mockConfigComponent 的配置被正确应用
      await component.init({
        name: "commands",
        version: "1.0.0",
        enabled: true,
        options: {
          configComponent: mockConfigComponent,
        },
      });

      const dirs = await component.getCommandDirs();
      // 验证使用 mockConfigComponent 中预设的配置（临时目录）
      expect(dirs.user).toBe(userCommandsDir);
      expect(dirs.project).toBe(projectCommandsDir);
    });

    it("should use config from options object", async () => {
      await component.init({
        name: "commands",
        version: "1.0.0",
        enabled: true,
        options: {
          configComponent: mockConfigComponent,
          config: {
            userCommandsDir,
            projectCommandsDir,
          },
        },
      });

      const dirs = await component.getCommandDirs();
      expect(dirs.user).toBe(userCommandsDir);
      expect(dirs.project).toBe(projectCommandsDir);
    });

    it("should use config from ConfigComponent", async () => {
      mockConfigComponent.set("command.userCommandsDir", userCommandsDir);
      mockConfigComponent.set("command.projectCommandsDir", projectCommandsDir);

      await component.init({
        name: "commands",
        version: "1.0.0",
        enabled: true,
        options: {
          configComponent: mockConfigComponent,
        },
      });

      const dirs = await component.getCommandDirs();
      expect(dirs.user).toBe(userCommandsDir);
      expect(dirs.project).toBe(projectCommandsDir);
    });

    it("should throw error without ConfigComponent", async () => {
      await expect(
        component.init({
          name: "commands",
          version: "1.0.0",
          enabled: true,
        })
      ).rejects.toThrow("ConfigComponent is required");
    });
  });

  describe("discover", () => {
    beforeEach(async () => {
      mockConfigComponent.set("command.userCommandsDir", userCommandsDir);
      mockConfigComponent.set("command.projectCommandsDir", projectCommandsDir);
      
      await component.init({
        name: "commands",
        version: "1.0.0",
        enabled: true,
        options: {
          configComponent: mockConfigComponent,
        },
      });
    });

    it("should return empty list when no commands exist", async () => {
      const result = await component.discover();
      expect(result.commands).toEqual([]);
      expect(result.stats.userCount).toBe(0);
      expect(result.stats.projectCount).toBe(0);
    });

    it("should discover commands from user directory", async () => {
      const testScript = path.join(userCommandsDir, "test-cmd");
      await fs.writeFile(testScript, "#!/bin/bash\necho hello", { mode: 0o755 });

      const result = await component.discover();
      expect(result.commands.length).toBe(1);
      expect(result.commands[0].name).toBe("test-cmd");
      expect(result.commands[0].source).toBe("user");
      expect(result.stats.userCount).toBe(1);
    });

    it("should discover commands from project directory", async () => {
      const testScript = path.join(projectCommandsDir, "project-cmd");
      await fs.writeFile(testScript, "#!/bin/bash\necho project", { mode: 0o755 });

      const result = await component.discover();
      expect(result.commands.length).toBe(1);
      expect(result.commands[0].name).toBe("project-cmd");
      expect(result.commands[0].source).toBe("project");
      expect(result.stats.projectCount).toBe(1);
    });

    it("should deduplicate and prefer project commands", async () => {
      const userCmd = path.join(userCommandsDir, "duplicate");
      await fs.writeFile(userCmd, "#!/bin/bash\necho user", { mode: 0o755 });

      const projectCmd = path.join(projectCommandsDir, "duplicate");
      await fs.writeFile(projectCmd, "#!/bin/bash\necho project", { mode: 0o755 });

      const result = await component.discover();
      expect(result.commands.length).toBe(1);
      expect(result.commands[0].source).toBe("project");
    });

    it("should filter by glob pattern", async () => {
      await fs.writeFile(path.join(userCommandsDir, "git-status"), "#!/bin/bash", { mode: 0o755 });
      await fs.writeFile(path.join(userCommandsDir, "npm-ci"), "#!/bin/bash", { mode: 0o755 });
      await fs.writeFile(path.join(userCommandsDir, "git-log"), "#!/bin/bash", { mode: 0o755 });

      const result = await component.discover({ pattern: "git*" });
      expect(result.commands.length).toBe(2);
      expect(result.commands.map((c) => c.name).sort()).toEqual(["git-log", "git-status"]);
    });

    it("should skip hidden files", async () => {
      await fs.writeFile(path.join(userCommandsDir, ".hidden"), "#!/bin/bash", { mode: 0o755 });
      await fs.writeFile(path.join(userCommandsDir, "visible"), "#!/bin/bash", { mode: 0o755 });

      const result = await component.discover();
      expect(result.commands.length).toBe(1);
      expect(result.commands[0].name).toBe("visible");
    });
  });

  describe("add", () => {
    beforeEach(async () => {
      mockConfigComponent.set("command.userCommandsDir", userCommandsDir);
      mockConfigComponent.set("command.projectCommandsDir", projectCommandsDir);
      
      await component.init({
        name: "commands",
        version: "1.0.0",
        enabled: true,
        options: {
          configComponent: mockConfigComponent,
        },
      });
    });

    it("should add command to user directory by default", async () => {
      await component.add({
        name: "test-cmd",
        target: "/usr/bin/echo",
      });

      const exists = await fs
        .access(path.join(userCommandsDir, "test-cmd"))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      const stat = await fs.lstat(path.join(userCommandsDir, "test-cmd"));
      expect(stat.isSymbolicLink()).toBe(true);
    });

    it("should add command to project directory when specified", async () => {
      await component.add({
        name: "test-project-cmd",
        target: "/usr/bin/echo",
        source: "project",
      });

      const exists = await fs
        .access(path.join(projectCommandsDir, "test-project-cmd"))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);
    });

    it("should throw error when command already exists", async () => {
      await component.add({ name: "existing", target: "/usr/bin/echo" });

      await expect(
        component.add({ name: "existing", target: "/usr/bin/cat" })
      ).rejects.toThrow("already exists");
    });
  });

  describe("remove", () => {
    beforeEach(async () => {
      mockConfigComponent.set("command.userCommandsDir", userCommandsDir);
      mockConfigComponent.set("command.projectCommandsDir", projectCommandsDir);
      
      await component.init({
        name: "commands",
        version: "1.0.0",
        enabled: true,
        options: {
          configComponent: mockConfigComponent,
        },
      });
    });

    it("should remove command from user directory", async () => {
      await component.add({ name: "remove-me", target: "/usr/bin/echo" });
      await component.remove({ name: "remove-me" });

      const exists = await fs
        .access(path.join(userCommandsDir, "remove-me"))
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(false);
    });

    it("should throw error when command not found", async () => {
      await expect(component.remove({ name: "nonexistent" })).rejects.toThrow("not found");
    });
  });

  describe("getInfo", () => {
    beforeEach(async () => {
      mockConfigComponent.set("command.userCommandsDir", userCommandsDir);
      mockConfigComponent.set("command.projectCommandsDir", projectCommandsDir);
      
      await component.init({
        name: "commands",
        version: "1.0.0",
        enabled: true,
        options: {
          configComponent: mockConfigComponent,
        },
      });
    });

    it("should return command info", async () => {
      await component.add({ name: "info-test", target: "/usr/bin/echo" });

      const info = await component.getInfo("info-test");
      expect(info).not.toBeNull();
      expect(info!.name).toBe("info-test");
      expect(info!.source).toBe("user");
    });

    it("should return null for nonexistent command", async () => {
      const info = await component.getInfo("nonexistent");
      expect(info).toBeNull();
    });
  });

  describe("getDescription with meta.md", () => {
    beforeEach(async () => {
      mockConfigComponent.set("command.userCommandsDir", userCommandsDir);
      mockConfigComponent.set("command.projectCommandsDir", projectCommandsDir);
      
      await component.init({
        name: "commands",
        version: "1.0.0",
        enabled: true,
        options: {
          configComponent: mockConfigComponent,
        },
      });
    });

    it("should use description from meta.md when available", async () => {
      // Create a command with meta.md
      const metaContent = `---
name: bounty
description: AI Agent Bounty System - 悬赏任务发布、领取、提交、审批平台
source: user
---

# Bounty Command
`;
      await fs.writeFile(path.join(userCommandsDir, "bounty.meta.md"), metaContent, "utf-8");
      
      // Create the actual command script
      const testScript = path.join(userCommandsDir, "bounty");
      await fs.writeFile(testScript, "#!/bin/bash\necho 'bounty command'", { mode: 0o755 });

      const result = await component.discover();
      expect(result.commands.length).toBe(1);
      expect(result.commands[0].name).toBe("bounty");
      expect(result.commands[0].shortDescription).toBe("AI Agent Bounty System - 悬赏任务发布、领取、提交、审批平台");
    });

    it("should fallback to --help when no meta.md exists", async () => {
      // Create a command without meta.md
      const testScript = path.join(userCommandsDir, "test-cmd");
      await fs.writeFile(testScript, "#!/bin/bash\necho 'test command'", { mode: 0o755 });

      const result = await component.discover();
      expect(result.commands.length).toBe(1);
      expect(result.commands[0].name).toBe("test-cmd");
      // Since there's no meta.md, it will try --help which may return empty
      // Just verify it doesn't crash
      expect(typeof result.commands[0].shortDescription).toBe("string");
    });

    it("should use meta.md description in getInfo", async () => {
      // Create a command with meta.md
      const metaContent = `---
name: bounty
description: AI Agent Bounty System - 悬赏任务发布、领取、提交、审批平台
source: user
---

# Bounty Command
`;
      await fs.writeFile(path.join(userCommandsDir, "bounty.meta.md"), metaContent, "utf-8");
      
      // Create the actual command script
      const testScript = path.join(userCommandsDir, "bounty");
      await fs.writeFile(testScript, "#!/bin/bash\necho 'bounty command'", { mode: 0o755 });

      const info = await component.getInfo("bounty");
      expect(info).not.toBeNull();
      expect(info!.name).toBe("bounty");
      expect(info!.shortDescription).toBe("AI Agent Bounty System - 悬赏任务发布、领取、提交、审批平台");
    });

    it("should handle meta.md with special characters in description", async () => {
      const metaContent = `---
name: special-cmd
description: Special command with "quotes" and - dashes
source: user
---

# Special Command
`;
      await fs.writeFile(path.join(userCommandsDir, "special-cmd.meta.md"), metaContent, "utf-8");
      
      const testScript = path.join(userCommandsDir, "special-cmd");
      await fs.writeFile(testScript, "#!/bin/bash\necho 'special'", { mode: 0o755 });

      const result = await component.discover();
      expect(result.commands.length).toBe(1);
      expect(result.commands[0].shortDescription).toBe('Special command with "quotes" and - dashes');
    });
  });

  describe("exec", () => {
    beforeEach(async () => {
      mockConfigComponent.set("command.userCommandsDir", userCommandsDir);
      mockConfigComponent.set("command.projectCommandsDir", projectCommandsDir);
      
      await component.init({
        name: "commands",
        version: "1.0.0",
        enabled: true,
        options: {
          configComponent: mockConfigComponent,
        },
      });
    });

    it("should execute command with args", async () => {
      await component.add({ name: "my-echo", target: "/bin/echo" });

      const result = await component.exec({
        name: "my-echo",
        args: ["hello", "world"],
      });

      expect(result.success).toBe(true);
      expect(result.stdout.trim()).toBe("hello world");
    });

    it("should return error for nonexistent command", async () => {
      const result = await component.exec({
        name: "nonexistent-command-xyz",
        args: [],
      });

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(127);
    });
  });
});
