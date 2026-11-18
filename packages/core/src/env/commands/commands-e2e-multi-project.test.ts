/**
 * @fileoverview Multi-Hook Compatibility Test
 * 
 * 概念澄清：
 * - Hook 点（Hook Point）：如 "prompt.after-render"，表示挂载位置
 * - Hook 实例：{ name, execute }，注册到某个 Hook 点
 * 
 * HookManager.register() 行为：
 * - 同一个 Hook 点可以注册多个不同 name 的 Hook
 * - 同名 Hook 会追加到数组（不是覆盖），都会被执行
 * 
 * 使用场景：
 * - roy-bot 注册 "commands-prompt" 到 "prompt.after-render"
 * - ai-agent-bounty 注册 "bounty-prompt-hook" 到 "prompt.after-render"
 * - 两者都会被执行，按 priority 排序
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
  async load(): Promise<void> {}
  get(key: string): unknown { return this.config.get(key); }
  async set(key: string, value: unknown): Promise<void> { this.config.set(key, value); }
  registerComponent(): void {}
}

describe("Multi-Hook Compatibility", () => {
  let tempDir: string;
  let configComponent: TestConfigComponent;
  let promptComponent: PromptComponent;
  let commandsComponent: CommandsComponent;

  const TEST_PROMPT_NAME = "default";

  beforeEach(async () => {
    globalHookManager.unregisterAll("prompt.after-render");

    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "roy-multi-hook-test-"));
    configComponent = new TestConfigComponent();
    
    await configComponent.set("command.userCommandsDir", path.join(tempDir, "commands"));
    await configComponent.set("command.projectCommandsDir", path.join(tempDir, "project-commands"));
    await configComponent.set("command.cacheDir", path.join(tempDir, "cache"));
    
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

    commandsComponent = new CommandsComponent();
    await commandsComponent.init({
      name: "commands",
      version: "2.0.0",
      enabled: true,
      options: { configComponent },
    });
  });

  afterEach(async () => {
    globalHookManager.unregisterAll("prompt.after-render");
    await promptComponent.stop?.();
    await commandsComponent.stop?.();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("基础：多个不同 name 的 Hook 共存于同一 Hook 点", () => {
    it("应该按 priority 顺序执行所有 Hook", async () => {
      // 模拟 roy-bot 注册的 Hook (priority 0)
      globalHookManager.register("prompt.after-render", {
        name: "commands-prompt",
        priority: 0,
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          if (hookCtx?.name !== "default") return;
          hookCtx.renderedContent += "\n\n[commands-prompt executed]";
        },
      });

      // 模拟 ai-agent-bounty 注册的 Hook (priority 100)
      globalHookManager.register("prompt.after-render", {
        name: "bounty-prompt-hook",
        priority: 100,
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          if (hookCtx?.name !== "default") return;
          hookCtx.renderedContent += "\n\n[bounty-prompt-hook executed]";
        },
      });

      // 模拟第三方插件注册的 Hook (priority 50)
      globalHookManager.register("prompt.after-render", {
        name: "analytics-hook",
        priority: 50,
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          if (hookCtx?.name !== "default") return;
          hookCtx.renderedContent += "\n\n[analytics-hook executed]";
        },
      });

      const rendered = await promptComponent.getPrompt("default");

      // 验证所有 Hook 都被执行
      expect(rendered).toContain("[commands-prompt executed]");
      expect(rendered).toContain("[bounty-prompt-hook executed]");
      expect(rendered).toContain("[analytics-hook executed]");

      // 验证执行顺序：按 priority 升序
      const cmdIdx = rendered.indexOf("[commands-prompt executed]");
      const analyticsIdx = rendered.indexOf("[analytics-hook executed]");
      const bountyIdx = rendered.indexOf("[bounty-prompt-hook executed]");
      
      expect(cmdIdx).toBeLessThan(analyticsIdx);     // 0 < 50
      expect(analyticsIdx).toBeLessThan(bountyIdx); // 50 < 100
    });

    it("不同 Hook 点的 Hook 应该互不影响", async () => {
      // 注册到 prompt.after-render
      globalHookManager.register("prompt.after-render", {
        name: "prompt-hook",
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          if (hookCtx?.name !== "default") return;
          hookCtx.renderedContent += "\n\n[prompt-hook]";
        },
      });

      // 注册到 agent.after（不同的 Hook 点）
      globalHookManager.register("agent.after", {
        name: "agent-hook",
        execute: async (ctx: unknown) => {
          // 这个 Hook 不会被 prompt after-render 触发
        },
      });

      const rendered = await promptComponent.getPrompt("default");

      // 只有 prompt-hook 应该被执行
      expect(rendered).toContain("[prompt-hook]");
      expect(rendered).not.toContain("[agent-hook]");
    });
  });

  describe("进阶：多次调用 getPrompt() 的场景", () => {
    it("每次 getPrompt() 调用都是全新的 renderedContent，不会累积", async () => {
      let callCount = 0;

      globalHookManager.register("prompt.after-render", {
        name: "counter-hook",
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          if (hookCtx?.name !== "default") return;
          callCount++;
          hookCtx.renderedContent += `\n\n[Counter: ${callCount}]`;
        },
      });

      // 第一次调用
      const rendered1 = await promptComponent.getPrompt("default");
      expect(rendered1).toContain("[Counter: 1]");
      expect(rendered1.match(/\[Counter:/g)).toHaveLength(1);

      // 第二次调用 - 应该从 2 开始，而不是 3
      const rendered2 = await promptComponent.getPrompt("default");
      expect(rendered2).toContain("[Counter: 2]");
      expect(rendered2.match(/\[Counter:/g)).toHaveLength(1);
    });

    it("多个 Hook 在多次调用中都应该被正确触发", async () => {
      globalHookManager.register("prompt.after-render", {
        name: "hook-a",
        priority: 0,
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          if (hookCtx?.name !== "default") return;
          hookCtx.renderedContent += "\n\n[hook-a]";
        },
      });

      globalHookManager.register("prompt.after-render", {
        name: "hook-b",
        priority: 100,
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          if (hookCtx?.name !== "default") return;
          hookCtx.renderedContent += "\n\n[hook-b]";
        },
      });

      // 第一次调用
      const rendered1 = await promptComponent.getPrompt("default");
      expect(rendered1).toContain("[hook-a]");
      expect(rendered1).toContain("[hook-b]");
      
      // 验证顺序
      expect(rendered1.indexOf("[hook-a]")).toBeLessThan(rendered1.indexOf("[hook-b]"));

      // 第二次调用 - 两个 Hook 仍然都执行
      const rendered2 = await promptComponent.getPrompt("default");
      expect(rendered2).toContain("[hook-a]");
      expect(rendered2).toContain("[hook-b]");
      
      // 第二次调用中的内容不包含第一次的内容（每次是全新的）
      const matches1 = rendered1.match(/\[hook-a\]|\[hook-b\]/g);
      const matches2 = rendered2.match(/\[hook-a\]|\[hook-b\]/g);
      expect(matches1).toHaveLength(2);
      expect(matches2).toHaveLength(2);
    });
  });

  describe("真实场景：roy-bot + ai-agent-bounty", () => {
    it("commands-prompt 和 bounty-prompt-hook 能正确共存", async () => {
      // 创建测试命令
      const commandsDir = path.join(tempDir, "commands");
      await fs.mkdir(commandsDir, { recursive: true });
      await fs.symlink("/usr/bin/echo", path.join(commandsDir, "lark-cli"));
      await fs.writeFile(
        path.join(commandsDir, "lark-cli.meta.md"),
        `---
name: lark-cli
description: Lark CLI tool
source: user
---
`
      );

      // 模拟 roy-bot 的 commands-prompt-hook
      globalHookManager.register("prompt.after-render", {
        name: "commands-prompt",
        priority: 0,
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          if (hookCtx?.name !== "default") return;
          
          const metaList = await commandsComponent.getCommandsMeta();
          if (metaList.length > 0) {
            const rows = metaList.map(m => `| \`${m.name}\` | ${m.description} |`).join("\n");
            hookCtx.renderedContent += "\n\n## Your Commands Arsenal\n\n" + rows;
          }
        },
      });

      // 模拟 ai-agent-bounty 的 bounty-prompt-hook
      globalHookManager.register("prompt.after-render", {
        name: "bounty-prompt-hook",
        priority: 100,
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          if (hookCtx?.name !== "default") return;
          hookCtx.renderedContent += "\n\n## Bounty Capabilities\n\n- Bug bounty tracking";
        },
      });

      const rendered = await promptComponent.getPrompt("default");

      // 验证 commands-prompt hook 生效
      expect(rendered).toContain("## Your Commands Arsenal");
      expect(rendered).toContain("| `lark-cli` | Lark CLI tool |");
      
      // 验证 bounty-prompt-hook 也生效
      expect(rendered).toContain("## Bounty Capabilities");
      expect(rendered).toContain("Bug bounty tracking");
      
      // 验证顺序：commands-prompt 先执行 (priority 0 < 100)
      const commandsIdx = rendered.indexOf("## Your Commands Arsenal");
      const bountyIdx = rendered.indexOf("## Bounty Capabilities");
      expect(commandsIdx).toBeLessThan(bountyIdx);
    });

    it("当 commands 为空时，bounty-prompt-hook 仍应生效", async () => {
      // 不创建任何命令

      // commands-prompt-hook 应该静默跳过
      globalHookManager.register("prompt.after-render", {
        name: "commands-prompt",
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          if (hookCtx?.name !== "default") return;
          
          const metaList = await commandsComponent.getCommandsMeta();
          if (metaList.length > 0) {
            hookCtx.renderedContent += "\n\n## Your Commands Arsenal";
          }
          // 没有命令时，静默跳过
        },
      });

      // bounty-prompt-hook 仍然执行
      globalHookManager.register("prompt.after-render", {
        name: "bounty-prompt-hook",
        priority: 100,
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          if (hookCtx?.name !== "default") return;
          hookCtx.renderedContent += "\n\n## Bounty Capabilities\n\n- Bug bounty tracking";
        },
      });

      const rendered = await promptComponent.getPrompt("default");

      // bounty hook 生效
      expect(rendered).toContain("## Bounty Capabilities");
      
      // commands hook 没有追加内容
      expect(rendered).not.toContain("## Your Commands Arsenal");
    });

    it("非 default prompt 不应触发任何 hook", async () => {
      promptComponent.add("custom-prompt", "Custom content.", "inline");

      globalHookManager.register("prompt.after-render", {
        name: "commands-prompt",
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          if (hookCtx?.name !== "default") return;
          hookCtx.renderedContent += "\n\n[commands]";
        },
      });

      globalHookManager.register("prompt.after-render", {
        name: "bounty-prompt-hook",
        execute: async (ctx: unknown) => {
          const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
          if (hookCtx?.name !== "default") return;
          hookCtx.renderedContent += "\n\n[bounty]";
        },
      });

      const rendered = await promptComponent.getPrompt("custom-prompt");

      expect(rendered).not.toContain("[commands]");
      expect(rendered).not.toContain("[bounty]");
      expect(rendered).toBe("Custom content.");
    });
  });
});
