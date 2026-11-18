/**
 * @fileoverview Commands Prompt Hook Integration Test
 * 
 * 验证 commands-prompt Hook 正确注册和执行
 * 
 * Bug 修复验证：
 * - 之前使用 promptComponent.addHook() 注册 Hook
 * - 但 PromptComponent.render() 执行的是 globalHookManager
 * - 导致注册的 Hook 永远不会被执行
 * 
 * 修复方案：
 * - 使用 globalHookManager.register() 直接注册 Hook
 * 
 * 重要：Hook 上下文结构
 * - globalHookManager.execute() 会将数据包装在 HookContext 中
 * - ctx.data 才是 PromptHookContext { name, originalContent, renderedContent, variables }
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { globalHookManager } from "../hook/global-hook-manager";
import { PromptComponent } from "../prompt/prompt-component";
import { CommandsComponent } from "./commands-component";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

// 创建测试用的 ConfigComponent
class TestConfigComponent {
  private config: Map<string, unknown> = new Map();

  async load(): Promise<void> {
    // no-op for tests
  }

  get(key: string): unknown {
    return this.config.get(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.config.set(key, value);
  }

  registerComponent(): void {
    // no-op for tests
  }
}

describe("Commands Prompt Hook Integration", () => {
  let tempDir: string;
  let configComponent: TestConfigComponent;
  let promptComponent: PromptComponent;
  let commandsComponent: CommandsComponent;

  // 测试用的 prompt 名称（避免与内置 prompt 冲突）
  const TEST_PROMPT_NAME = "test-commands-prompt";

  beforeEach(async () => {
    // 清理之前的 hooks，避免测试间干扰
    globalHookManager.unregisterAll("prompt.after-render");

    // 创建临时目录
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "roy-commands-hook-test-"));
    
    // 初始化 ConfigComponent
    configComponent = new TestConfigComponent();
    
    // 设置默认配置
    await configComponent.set("command.userCommandsDir", path.join(tempDir, "commands"));
    await configComponent.set("command.projectCommandsDir", path.join(tempDir, "project-commands"));
    await configComponent.set("command.cacheDir", path.join(tempDir, "cache"));
    
    // 初始化 PromptComponent
    promptComponent = new PromptComponent();
    await promptComponent.init({
      name: "prompt",
      version: "1.0.0",
      enabled: true,
      options: {
        configComponent,
        defaultName: TEST_PROMPT_NAME,
      },
    });

    // 添加测试用的 prompt
    promptComponent.add(TEST_PROMPT_NAME, "You are a test assistant.", "inline");
    promptComponent.add("custom", "You are a custom assistant.", "inline");

    // 初始化 CommandsComponent
    commandsComponent = new CommandsComponent();
    await commandsComponent.init({
      name: "commands",
      version: "2.0.0",
      enabled: true,
      options: {
        configComponent,
      },
    });
  });

  afterEach(async () => {
    // 清理 hooks
    globalHookManager.unregisterAll("prompt.after-render");
    
    // 停止组件
    await promptComponent.stop?.();
    await commandsComponent.stop?.();
    
    // 清理临时目录
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("Hook Registration", () => {
    it("should register commands-prompt hook to globalHookManager", async () => {
      // 模拟 EnvironmentService 的 Hook 注册
      globalHookManager.register("prompt.after-render", {
        name: "commands-prompt",
        execute: async (ctx: unknown) => {
          // globalHookManager.execute() 会将数据包装在 HookContext 中
          // ctx.data 才是 PromptHookContext
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          
          // 只对指定 prompt 注入
          if (hookCtx?.name !== TEST_PROMPT_NAME) return;

          const metaList = await commandsComponent.getCommandsMeta();
          
          // 无命令时不追加内容
          if (metaList.length === 0) return;

          const rows = metaList
            .map(m => `| \`${m.name}\` | ${m.description} |`)
            .join("\n");

          hookCtx.renderedContent += "\n\n## Your Commands Arsenal\n\n" +
            "You have access to these custom commands:\n\n" +
            "| Command | Description |\n" +
            "|---------|-------------|\n" +
            rows + "\n" +
            "Progressive Discovery: Run `<command> --help` to explore full capabilities.";
        },
      });

      // 验证 Hook 已注册
      const hooks = (globalHookManager as any)._hooks?.get("prompt.after-render");
      expect(hooks).toBeDefined();
      expect(hooks.some((h: any) => h.name === "commands-prompt")).toBe(true);
    });

    it("should inject commands into default prompt when hook is executed", async () => {
      // 1. 添加测试命令
      const commandsDir = path.join(tempDir, "commands");
      await fs.mkdir(commandsDir, { recursive: true });
      
      // 创建符号链接
      await fs.symlink("/usr/bin/echo", path.join(commandsDir, "test-cmd"));
      
      // 创建 meta.md
      await fs.writeFile(
        path.join(commandsDir, "test-cmd.meta.md"),
        `---
name: test-cmd
description: A test command
source: user
---

# Test Command
`
      );

      // 2. 注册 Hook
      globalHookManager.register("prompt.after-render", {
        name: "commands-prompt",
        execute: async (ctx: unknown) => {
          // globalHookManager.execute() 会将数据包装在 HookContext 中
          // ctx.data 才是 PromptHookContext
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };

          if (hookCtx?.name !== TEST_PROMPT_NAME) return;

          const metaList = await commandsComponent.getCommandsMeta();
          
          if (metaList.length === 0) return;

          const rows = metaList
            .map(m => `| \`${m.name}\` | ${m.description} |`)
            .join("\n");

          hookCtx.renderedContent += "\n\n## Your Commands Arsenal\n\n" +
            "You have access to these custom commands:\n\n" +
            "| Command | Description |\n" +
            "|---------|-------------|\n" +
            rows + "\n" +
            "Progressive Discovery: Run `<command> --help` to explore full capabilities.";
        },
      });

      // 3. 渲染 prompt（这会触发 after-render hook）
      const renderedPrompt = await promptComponent.getPrompt(TEST_PROMPT_NAME);

      // 4. 验证 commands section 被注入
      expect(renderedPrompt).toContain("## Your Commands Arsenal");
      expect(renderedPrompt).toContain("| `test-cmd` | A test command |");
    });

    it("should NOT inject commands for non-default prompts", async () => {
      // 添加测试命令
      const commandsDir = path.join(tempDir, "commands");
      await fs.mkdir(commandsDir, { recursive: true });
      await fs.symlink("/usr/bin/echo", path.join(commandsDir, "test-cmd"));
      await fs.writeFile(
        path.join(commandsDir, "test-cmd.meta.md"),
        `---
name: test-cmd
description: A test command
source: user
---
`
      );

      // 注册 Hook（只对 TEST_PROMPT_NAME 注入）
      globalHookManager.register("prompt.after-render", {
        name: "commands-prompt",
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          
          // 只对指定 prompt 注入
          if (hookCtx?.name !== TEST_PROMPT_NAME) return;

          const metaList = await commandsComponent.getCommandsMeta();
          
          if (metaList.length === 0) return;

          hookCtx.renderedContent += "\n\n## Your Commands Arsenal\n\n" + 
            metaList.map(m => `| \`${m.name}\` | ${m.description} |`).join("\n");
        },
      });

      // 渲染 custom prompt（不是 TEST_PROMPT_NAME）
      const renderedPrompt = await promptComponent.getPrompt("custom");

      // 验证 commands section 未被注入
      expect(renderedPrompt).not.toContain("## Your Commands Arsenal");
      expect(renderedPrompt).toBe("You are a custom assistant.");
    });

    it("should handle empty command list gracefully", async () => {
      // 不添加任何命令

      // 注册 Hook
      globalHookManager.register("prompt.after-render", {
        name: "commands-prompt",
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          
          if (hookCtx?.name !== TEST_PROMPT_NAME) return;

          const metaList = await commandsComponent.getCommandsMeta();
          
          // 无命令时不追加内容
          if (metaList.length === 0) return;

          hookCtx.renderedContent += "\n\n## Your Commands Arsenal";
        },
      });

      // 渲染 prompt
      const renderedPrompt = await promptComponent.getPrompt(TEST_PROMPT_NAME);

      // 验证没有注入 commands section
      expect(renderedPrompt).not.toContain("## Your Commands Arsenal");
      expect(renderedPrompt).toBe("You are a test assistant.");
    });
  });
});
