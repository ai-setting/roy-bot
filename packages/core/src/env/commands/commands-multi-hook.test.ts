/**
 * @fileoverview Multi-Hook Compatibility Test
 * 
 * 验证多个 prompt.after-render hooks 能够正确共存和累积效果
 * 
 * 模拟场景：
 * 1. commands-prompt-hook（来自 roy-bot）
 * 2. bounty-prompt-hook（来自 ai-agent-bounty）
 * 3. 其他可能的 custom hooks
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

  const TEST_PROMPT_NAME = "test-multi-hook-prompt";

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

    promptComponent.add(TEST_PROMPT_NAME, "Base system prompt.", "inline");

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

  it("should support multiple hooks modifying the same renderedContent", async () => {
    // 1. 先创建测试命令
    const commandsDir = path.join(tempDir, "commands");
    await fs.mkdir(commandsDir, { recursive: true });
    await fs.symlink("/usr/bin/echo", path.join(commandsDir, "test-cmd"));
    await fs.writeFile(
      path.join(commandsDir, "test-cmd.meta.md"),
      `---
name: test-cmd
description: Test command
source: user
---
`
    );

    // 2. 注册 commands-prompt-hook（priority 0）
    globalHookManager.register("prompt.after-render", {
      name: "commands-prompt-hook",
      priority: 0,
      execute: async (ctx: unknown) => {
        const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
        if (hookCtx?.name !== TEST_PROMPT_NAME) return;

        hookCtx.renderedContent += "\n\n[Commands Hook Added This]";
      },
    });

    // 3. 注册 custom-hook（priority 50）
    globalHookManager.register("prompt.after-render", {
      name: "custom-hook",
      priority: 50,
      execute: async (ctx: unknown) => {
        const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
        if (hookCtx?.name !== TEST_PROMPT_NAME) return;

        hookCtx.renderedContent += "\n\n[Custom Hook Added This]";
      },
    });

    // 4. 注册 bounty-prompt-hook（priority 100）
    globalHookManager.register("prompt.after-render", {
      name: "bounty-prompt-hook",
      priority: 100,
      execute: async (ctx: unknown) => {
        const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
        if (hookCtx?.name !== TEST_PROMPT_NAME) return;

        hookCtx.renderedContent += "\n\n[Bounty Hook Added This]";
      },
    });

    // 5. 渲染 prompt
    const rendered = await promptComponent.getPrompt(TEST_PROMPT_NAME);

    // 6. 验证所有 hooks 的内容都被累积
    expect(rendered).toContain("Base system prompt.");
    expect(rendered).toContain("[Commands Hook Added This]");
    expect(rendered).toContain("[Bounty Hook Added This]");
    expect(rendered).toContain("[Custom Hook Added This]");

    // 7. 验证执行顺序（按 priority 排序）
    const commandsIdx = rendered.indexOf("[Commands Hook Added This]");
    const customIdx = rendered.indexOf("[Custom Hook Added This]");
    const bountyIdx = rendered.indexOf("[Bounty Hook Added This]");

    expect(commandsIdx).toBeLessThan(customIdx);  // priority 0 < 50
    expect(customIdx).toBeLessThan(bountyIdx);    // priority 50 < 100
  });

  it("should handle hooks that modify different prompts independently", async () => {
    promptComponent.add("other-prompt", "Other prompt content.", "inline");

    // Hook 只对 TEST_PROMPT_NAME 注入
    globalHookManager.register("prompt.after-render", {
      name: "selective-hook",
      execute: async (ctx: unknown) => {
        const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
        if (hookCtx?.name !== TEST_PROMPT_NAME) return;
        hookCtx.renderedContent += "\n\n[Selective Hook]";
      },
    });

    // 渲染 other-prompt（不应该是 TEST_PROMPT_NAME）
    const otherPrompt = await promptComponent.getPrompt("other-prompt");
    expect(otherPrompt).not.toContain("[Selective Hook]");
    expect(otherPrompt).toBe("Other prompt content.");

    // 渲染 TEST_PROMPT_NAME
    const testPrompt = await promptComponent.getPrompt(TEST_PROMPT_NAME);
    expect(testPrompt).toContain("[Selective Hook]");
  });

  it("should handle empty command list without breaking other hooks", async () => {
    // 不添加任何命令

    // 注册 commands-prompt-hook（无命令时静默跳过）
    globalHookManager.register("prompt.after-render", {
      name: "commands-prompt-hook",
      execute: async (ctx: unknown) => {
        const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
        if (hookCtx?.name !== TEST_PROMPT_NAME) return;

        const metaList = await commandsComponent.getCommandsMeta();
        if (metaList.length > 0) {
          hookCtx.renderedContent += "\n\n[Commands]";
        }
        // 注意：这里不会追加任何内容
      },
    });

    // 注册 bounty-prompt-hook（总是追加）
    globalHookManager.register("prompt.after-render", {
      name: "bounty-prompt-hook",
      execute: async (ctx: unknown) => {
        const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
        if (hookCtx?.name !== TEST_PROMPT_NAME) return;
        hookCtx.renderedContent += "\n\n[Bounty]";
      },
    });

    const rendered = await promptComponent.getPrompt(TEST_PROMPT_NAME);

    // bounty hook 仍然生效
    expect(rendered).toContain("[Bounty]");
    // commands hook 没有追加（因为没有命令）
    expect(rendered).not.toContain("[Commands]");
  });

  it("should preserve hooks from previous tests (no cleanup leakage)", async () => {
    // 验证 afterEach 正确清理了 hooks
    // 如果之前的 hooks 没有被清理，这个测试会失败
    
    let hookCalled = false;
    globalHookManager.register("prompt.after-render", {
      name: "isolation-test-hook",
      execute: async (ctx: unknown) => {
        hookCalled = true;
        const hookCtx = (ctx as any).data as { name: string; renderedContent: string };
        if (hookCtx?.name !== TEST_PROMPT_NAME) return;
        hookCtx.renderedContent += "\n\n[Isolation Test]";
      },
    });

    const rendered = await promptComponent.getPrompt(TEST_PROMPT_NAME);
    
    // 只应该有一个 hook 被调用（isolation-test-hook）
    // 如果之前有 hooks 没被清理，会有多个内容
    expect(rendered).toBe("Base system prompt.\n\n[Isolation Test]");
  });
});
