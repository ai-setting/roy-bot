import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { EnvironmentService } from "./environment.service";
import { OutputService } from "./output.service";

// ★ 测试隔离（Task #5181）：不再使用真实 os.homedir() 拼 ~/.roy-bot/commands
//   （11-08 事故根因：bun test 触发 CommandsComponent.init() 无条件 mkdir
//   重建了真实的 ~/.roy-bot/commands 目录）。
//   改为 beforeEach 中 mkdtemp 临时目录，afterEach 整体删除 —— 零触碰真实 HOME。
let TEST_COMMANDS_DIR = ""; // 在 beforeEach 中赋值（mkdtemp 临时目录）

/**
 * Commands Prompt Integration Test
 *
 * 验证 EnvironmentService 在创建环境时，
 * 是否正确注册 commands-prompt Hook，
 * 使得 default prompt 能够动态注入用户命令信息。
 *
 * 注意：命令创建在 mkdtemp 临时目录中，afterEach 整体删除。
 */
describe("EnvironmentService Commands Prompt Integration", () => {
  let tempDir: string;
  let configPath: string;
  let outputService: OutputService;
  let testCmdName: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "roy-env-commands-test-"));
    TEST_COMMANDS_DIR = path.join(tempDir, "commands");
    configPath = path.join(tempDir, "config.jsonc");

    // 创建空配置文件，使用测试命令目录
    // ★ 必须用嵌套形式：FileSource.getNestedValue 按点号拆分嵌套取值，
    //   扁平键 {"command.userCommandsDir": X} 读出 undefined（Task #5181 根因 2）
    await fs.writeFile(configPath, JSON.stringify({
      command: {
        userCommandsDir: TEST_COMMANDS_DIR,
        projectCommandsDir: path.join(tempDir, "project-commands"),
      },
    }));

    // 确保测试命令目录存在
    await fs.mkdir(TEST_COMMANDS_DIR, { recursive: true });

    // 使用真实的 OutputService（支持 quiet 模式）
    outputService = new OutputService({ quiet: true });

    // 使用唯一命令名避免冲突
    testCmdName = `test-cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  });

  afterEach(async () => {
    // 临时目录整体删除（含 commands 子目录），无需逐条清理
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("registerCommandsPromptHook", () => {
    it("should inject commands into default prompt via hook", async () => {
      // 1. 创建环境
      const envService = new EnvironmentService(outputService);
      
      await envService.create({
        configPath,
        sessionStorage: { type: "memory" },  // 使用内存存储，避免污染正式数据库
      });

      try {
        // 2. 获取 CommandsComponent 并添加命令
        const commandsComponent = envService.getCommands();
        expect(commandsComponent).toBeDefined();
        
        await commandsComponent!.add({
          name: testCmdName,
          target: "/usr/bin/echo",
          description: "Test command",
          tips: "Use with args",
        });

        // 3. 验证命令元信息存在
        const metaList = await commandsComponent!.getCommandsMeta();
        const testCmdMeta = metaList.find(m => m.name === testCmdName);
        expect(testCmdMeta).toBeDefined();
        expect(testCmdMeta?.description).toBe("Test command");
        
        // 4. 验证 renderCommandsSection 方法存在
        const envServiceAny = envService as any;
        expect(typeof envServiceAny.renderCommandsSection).toBe("function");
        
        // 5. 验证 commands section 渲染正确
        const section = envServiceAny.renderCommandsSection(metaList);
        expect(section).toContain("Your Commands Arsenal");
        expect(section).toContain(`| \`${testCmdName}\` | Test command |`);
        expect(section).toContain("Run `<command> --help`");
        
      } finally {
        await envService.dispose();
      }
    });

    it("should render commands section correctly", async () => {
      // 验证 renderCommandsSection 逻辑
      const metaList = [
        { name: "git", description: "Git version control", tips: "Use --help" },
        { name: "npm", description: "Node package manager", tips: "Use --help" },
      ];

      const envService = new EnvironmentService(outputService);
      
      // 通过反射获取私有方法（仅用于测试）
      const renderCommandsSection = (envService as any).renderCommandsSection?.bind(envService);
      
      if (renderCommandsSection) {
        const section = renderCommandsSection(metaList);
        
        expect(section).toContain("Your Commands Arsenal");
        expect(section).toContain("| `git` | Git version control |");
        expect(section).toContain("| `npm` | Node package manager |");
        expect(section).toContain("Run `<command> --help`");
        
        // 验证按字母顺序排列
        const gitIndex = section.indexOf("| `git`");
        const npmIndex = section.indexOf("| `npm`");
        expect(gitIndex).toBeLessThan(npmIndex);
      }
    });

    it("should handle empty command list", async () => {
      const envService = new EnvironmentService(outputService);

      // 通过反射获取私有方法
      const renderCommandsSection = (envService as any).renderCommandsSection?.bind(envService);

      if (renderCommandsSection) {
        const section = renderCommandsSection([]);

        // 空命令列表应该只返回标题（无表格行）
        expect(section).toContain("Your Commands Arsenal");
        expect(section).not.toContain("| `");
      }
    });

    // Issue #1694 → 2026-10-16 compact 事故：sub-agent prompts should NOT receive Commands Arsenal
    //
    // 最初（#1694）症状（实测 traceId=019f3c584d9589ae32d58f02db2e7b13）：
    //   workflow-json-output-plugin 调 agentComponent.run('json-extract', ...)
    //   json-extract 子 agent 的 system prompt 被 commands-prompt hook 追加了一整段
    //   "Your Commands Arsenal"，使 prompt 变得很大 + 与任务无关
    //   LLM 无法专注调用唯一的 workflow_submit_output 工具，导致子 agent 返回纯文本
    //   而非工具调用 → 上游节点的 structuredOutput 始终是 undefined
    //
    // 黑名单方案的缺陷（2026-10-16，traceId=83eadac2316d5be7529ca42ce7057d63）：
    //   当时用 SUB_AGENT_PROMPT_NAMES 黑名单排除 json-extract / workflow-extract，
    //   后来新增的 compact / compact-hint 被漏掉 → 压缩子 agent 的 prompt 被追加
    //   "Use them directly via bash when needed"，而它没有 bash 工具
    //   → `Tool not found: bash` → 空 checkpoint + 657 条消息被静默丢弃。
    //
    // 新契约：正向判定 —— 只有 agentType === "primary" 才注入，其余（含未声明）一律不注入。
    it("should NOT inject Commands Arsenal into sub-agent prompts (compact / compact-hint / json-extract)", async () => {
      const envService = new EnvironmentService(outputService);

      await envService.create({
        configPath,
        sessionStorage: { type: "memory" },
      });

      try {
        const core = await import("@ai-setting/roy-bot-core");
        const manager = (core as any).globalHookManager;
        expect(manager).toBeDefined();

        const internalHooks = (manager as any)._hooks;
        const afterHooks = internalHooks.get("prompt.after-render");
        const commandsHook = afterHooks?.find((h: any) => h.name === "commands-prompt");
        expect(commandsHook).toBeDefined();

        // 逐一验证：历史黑名单里的 json-extract / workflow-extract，
        // 以及漏掉导致生产事故的 compact / compact-hint
        const subAgents = ["json-extract", "workflow-extract", "compact", "compact-hint"];
        for (const name of subAgents) {
          const ctx = {
            data: {
              name,
              originalContent: `${name} prompt`,
              renderedContent: `${name} prompt`,
              variables: {},
              agentType: "sub", // AgentRegistry.getSystemPrompt 会传入 agent.type
            },
            phase: "after" as const,
          };

          await commandsHook!.execute(ctx);

          // 关键断言：commands section 应该 NOT 被追加
          expect(ctx.data.renderedContent).not.toContain("Your Commands Arsenal");
          expect(ctx.data.renderedContent).not.toContain("| `bounty` |");
          expect(ctx.data.renderedContent).toBe(`${name} prompt`);
        }
      } finally {
        await envService.dispose();
      }
    });

    it("should NOT inject Commands Arsenal when agentType is undeclared (fail-closed)", async () => {
      const envService = new EnvironmentService(outputService);

      await envService.create({
        configPath,
        sessionStorage: { type: "memory" },
      });

      try {
        const core = await import("@ai-setting/roy-bot-core");
        const manager = (core as any).globalHookManager;

        const internalHooks = (manager as any)._hooks;
        const afterHooks = internalHooks.get("prompt.after-render");
        const commandsHook = afterHooks?.find((h: any) => h.name === "commands-prompt");

        // 未声明 agentType 的 prompt（如 workflow 内联 prompt、CLI 直接展示）
        const ctx = {
          data: {
            name: "some-unknown-prompt",
            originalContent: "inline prompt",
            renderedContent: "inline prompt",
            variables: {},
          },
          phase: "after" as const,
        };

        await commandsHook!.execute(ctx);

        // fail-closed：默认不注入，新增调用点不会意外污染
        expect(ctx.data.renderedContent).toBe("inline prompt");
      } finally {
        await envService.dispose();
      }
    });

    it("should still inject Commands Arsenal into top-level user-facing prompts", async () => {
      const envService = new EnvironmentService(outputService);

      await envService.create({
        configPath,
        sessionStorage: { type: "memory" },
      });

      try {
        // ★ Task #5181：先在隔离的 mkdtemp commands 目录里加一条命令。
        //   hook 对空命令列表（metaList.length === 0）不注入，
        //   旧版依赖真实 ~/.roy-bot/commands 里的残留命令才能过 —— 测试隔离后必须自建。
        const commandsComponent = envService.getCommands();
        expect(commandsComponent).toBeDefined();
        await commandsComponent!.add({
          name: testCmdName,
          target: "/usr/bin/echo",
          description: "Test command",
          tips: "Use with args",
        });

        const core = await import("@ai-setting/roy-bot-core");
        const manager = (core as any).globalHookManager;
        expect(manager).toBeDefined();

        const ctx = {
          data: {
            name: "default",  // user-facing prompt
            originalContent: "Default prompt",
            renderedContent: "Default prompt",
            variables: {},
            agentType: "primary", // environment.ts / AgentRegistry 显式声明
          },
          phase: "after" as const,
        };

        const internalHooks = (manager as any)._hooks;
        const afterHooks = internalHooks.get("prompt.after-render");
        const commandsHook = afterHooks?.find((h: any) => h.name === "commands-prompt");

        if (commandsHook) {
          await commandsHook.execute(ctx);
        }

        // top-level prompt 应该收到 Commands Arsenal
        expect(ctx.data.renderedContent).toContain("Your Commands Arsenal");
      } finally {
        await envService.dispose();
      }
    });

    it("should register commands-prompt hook on environment creation", async () => {
      const envService = new EnvironmentService(outputService);
      
      await envService.create({
        configPath,
        sessionStorage: { type: "memory" },  // 使用内存存储，避免污染正式数据库
      });

      try {
        // 验证 Hook 已注册（通过日志输出确认）
        const promptComponent = envService.getEnvironment()?.getComponent("prompt");
        expect(promptComponent).toBeDefined();
      } finally {
        await envService.dispose();
      }
    });
  });

  /**
   * 端到端回归（2026-10-16 生产事故 traceId=83eadac2316d5be7529ca42ce7057d63）：
   *
   * 走**真实链路** AgentRegistry.getSystemPrompt → PromptComponent.getPrompt
   * → prompt.after-render hook，验证：
   *   - 内置子 agent（compact / compact-hint）的 system prompt 不包含 Commands Arsenal；
   *   - primary（default）的 system prompt 仍然包含。
   *
   * 这是对「黑名单漏加新子 agent」这个根因的直接回归保护：
   * 将来再加任何内置子 agent，只要它是 type='sub' 就自动不会被污染。
   */
  describe("end-to-end: AgentRegistry → PromptComponent → hook (agentType gating)", () => {
    it("compact / compact-hint 的 prompt 不含 Commands Arsenal，default(primary) 含", async () => {
      const envService = new EnvironmentService(outputService);

      await envService.create({
        configPath,
        sessionStorage: { type: "memory" },
      });

      try {
        // ★ Task #5181：先在隔离的 mkdtemp commands 目录里加一条命令。
        //   hook 对空命令列表不注入，旧版依赖真实 ~/.roy-bot/commands 残留命令。
        const commandsComponent = envService.getCommands();
        expect(commandsComponent).toBeDefined();
        await commandsComponent!.add({
          name: testCmdName,
          target: "/usr/bin/echo",
          description: "Test command",
          tips: "Use with args",
        });

        const env = envService.getEnvironment();
        const agentComponent = env?.getComponent("agent") as any;
        const registry = agentComponent?.getRegistry?.();
        expect(registry).toBeDefined();

        // 确保待测的 prompt 已在 PromptComponent 中注册
        const promptComponent = env?.getComponent("prompt") as any;

        // --- 子 agent：必须没有 Arsenal（逐一点名，覆盖事故相关者）---
        for (const name of ["compact", "compact-hint"]) {
          const prompt = await registry.getSystemPrompt(name);
          expect(prompt).toBeDefined();
          expect(prompt).not.toContain("Your Commands Arsenal");
          // 且确实是它自己的 prompt（不是被父 agent 的覆盖）
          expect(prompt).toContain(
            name === "compact" ? "Session Checkpoint Generator" : "Compact Hint Generator"
          );
        }

        // --- 通用防线：遍历 registry 里**所有**非 primary agent ---
        // 不再写死名单：将来新增任何内置子 agent 都会自动被这条断言覆盖
        // （本次事故的根因正是「黑名单漏加新子 agent」）。
        const allAgents: Array<{ name: string; type: string }> = registry.list?.() ?? [];
        expect(allAgents.length).toBeGreaterThan(0);
        const nonPrimary = allAgents.filter((a) => a.type !== "primary");
        expect(nonPrimary.length).toBeGreaterThan(0);

        for (const agent of nonPrimary) {
          const prompt = await registry.getSystemPrompt(agent.name);
          if (!prompt) continue; // 无 systemPromptRef 的 agent 跳过
          expect(prompt).not.toContain("Your Commands Arsenal");
        }

        // --- primary：仍然有 Arsenal（用户可见功能未退化）---
        promptComponent.add("__t_primary__", "You are the front door.");
        const primaryPrompt = await promptComponent.getPrompt("__t_primary__", {}, {
          agentType: "primary",
        });
        expect(primaryPrompt).toContain("You are the front door.");
        expect(primaryPrompt).toContain("Your Commands Arsenal");
      } finally {
        await envService.dispose();
      }
    });
  });
});
