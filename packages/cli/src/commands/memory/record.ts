/**
 * @fileoverview Memory Record Command
 * 
 * 命令：roy-bot memory record
 * 
 * 将记忆内容记录到 memory file
 * 支持 --extract 模式：从会话历史中提取记忆并保存
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type {
  MemoryComponent,
  AgentComponent,
} from "@ai-setting/roy-bot-core";
import { createMemoryAgentTools, getBuiltInPrompt } from "@ai-setting/roy-bot-core";
import type { PromptComponent } from "@ai-setting/roy-bot-core";
import { bashTool, globTool, readFileTool } from "@ai-setting/roy-bot-core";

interface RecordOptions {
  config?: string;
  /** 作用域: project 或 global */
  scope: "project" | "global";
  /** 操作模式: append/prepend/overwrite/delete */
  mode: "append" | "prepend" | "overwrite" | "delete";
  /** 记忆内容 */
  content?: string;
  /** 章节标题 */
  title?: string;
  /** 触发提取模式 */
  extract?: boolean;
  /** 指定 session ID */
  "session-id"?: string;
  /** 自然语言提取指导 */
  require?: string;
}

/**
 * Memory Agent 提取模式 - 从会话历史生成记忆
 */
async function runExtractMode(
  output: OutputService,
  memoryComponent: MemoryComponent,
  agentComponent: AgentComponent,
  sessionComponent: any,
  env: any,
  options: {
    scope: "project" | "global";
    sessionId?: string;
    require?: string;
  }
): Promise<void> {
  const { scope, sessionId, require: userRequirement } = options;

  output.log(chalk.blue(`\n🔍 Memory Extract Mode (${scope})`));
  output.log(chalk.gray("正在分析会话历史，生成记忆...\n"));

  try {
    // 1. 获取当前 memory
    const currentMemory = await memoryComponent.recallMemory(scope) || "(无现有记忆)";

    // 2. 获取 prompt（通过 PromptComponent 或 fallback 到 getBuiltInPrompt）
    const promptName = scope === "project" ? "project-memory" : "global-memory";
    let promptTemplate: string | undefined;
    
    try {
      const promptComponent = env?.getComponent?.("prompt") as PromptComponent | undefined;
      if (promptComponent) {
        promptTemplate = await promptComponent.getPrompt(promptName);
      }
    } catch (err) {
      // PromptComponent 不可用或获取失败，fallback 到 getBuiltInPrompt
    }
    
    // Fallback：如果 PromptComponent 不可用或未找到，使用 getBuiltInPrompt
    if (!promptTemplate) {
      promptTemplate = getBuiltInPrompt(promptName);
    }

    if (!promptTemplate) {
      output.error(`Prompt not found for scope: ${scope}`);
      process.exit(1);
    }

    // 3. 替换变量
    const systemPrompt = promptTemplate
      .replace("{USER_REQUIREMENT}", userRequirement || "请从会话历史中提炼关键知识。")
      .replace("{SCOPE}", scope)
      .replace("{CURRENT_MEMORY}", currentMemory);

    // 4. 创建 Memory Agent tools
    const memoryTools = createMemoryAgentTools({
      sessionComponent,
      memoryComponent: memoryComponent as any,
    });

    // 5. 准备 Agent 工具列表
    const agentTools = [
      memoryTools.searchSessions,
      memoryTools.getSession,
      memoryTools.writeMemory,
    ];

    // 6. Project scope 额外添加文件工具（读取项目文档和代码）
    if (scope === "project") {
      agentTools.push(bashTool, globTool, readFileTool);
    }

    // 7. 获取允许的工具名称列表
    const allowedToolNames = agentTools.map((t) => t.name);

    // 8. 注册 Agent
    const agentName = `memory-extract-${scope}`;
    agentComponent.registerAgent(agentName, {
      type: "sub",
      systemPrompt,
      allowedTools: allowedToolNames,
      deniedTools: [],
    });
    agentComponent.setDefaultTools(agentTools);

    // 9. 将 Agent tools 注册到 ToolComponent（用于 executeTool 时查找）
    const toolComponent = (env as any).getComponent?.("tool");
    if (toolComponent) {
      for (const tool of agentTools) {
        try {
          toolComponent.register(tool);
          output.log(chalk.gray(`Tool registered: ${tool.name}`));
        } catch (err) {
          output.log(chalk.gray(`Tool already registered: ${tool.name}`));
        }
      }
    }
    
    output.log(chalk.gray(`Agent "${agentName}" registered with ${agentTools.length} tools`));

    // 6. 执行 Agent（使用 handle_query，参考 delegate_task 模式）
    // 这确保与 delegate_task 使用相同的执行路径，包括 memory 注入等
    const query = `请分析会话历史，提炼${scope === "project" ? "项目" : "全局"}记忆并写入记忆文件。`;
    
    let result: string;
    try {
      // 使用 env.handle_query() 而不是 agentComponent.run()
      // 这与 delegate_task 的实现模式一致
      result = await env.handle_query(query, {
        sessionId,
        agentType: agentName,
      });
    } catch (error) {
      result = `执行失败: ${error instanceof Error ? error.message : String(error)}`;
    }

    // 10. 输出结果
    // handle_query 返回 string，如果有错误会抛出异常
    if (result && result.startsWith("执行失败")) {
      output.error(`提取失败: ${result}`);
    } else if (result) {
      output.log(chalk.green("\n✅ 记忆提取完成"));
      output.log(chalk.gray("记忆已保存到 memory 文件。\n"));
      // 可选：输出 agent 返回的结果摘要
      if (result.length > 0 && result !== "✅ 记忆提取完成") {
        output.log(chalk.gray(`执行摘要: ${result.substring(0, 200)}${result.length > 200 ? "..." : ""}`));
      }
    }

    // 11. 清理 - 注销 Agent 和 Tools
    agentComponent.unregisterAgent(agentName);
    if (toolComponent) {
      // 清理 memory tools
      for (const tool of [memoryTools.searchSessions, memoryTools.getSession, memoryTools.writeMemory]) {
        toolComponent.unregister(tool.name);
      }
      // 如果是 project scope，额外清理文件工具
      if (scope === "project") {
        for (const toolName of ["bash", "glob", "read_file"]) {
          toolComponent.unregister(toolName);
        }
      }
    }
  } catch (error) {
    output.error(`提取失败: ${error}`);
    throw error;
  }
}

export const RecordCommand: CommandModule<object, object> = {
  command: "record",
  aliases: ["save"],
  describe: "记录记忆内容到 memory file",
  
  builder: (yargs) =>
    yargs
      .option("mode", {
        alias: "m",
        type: "string",
        choices: ["append", "prepend", "overwrite", "delete"],
        default: "append",
        description: "操作模式: append(尾部追加), prepend(头部插入), overwrite(覆盖), delete(删除)",
      })
      .option("content", {
        alias: "c",
        type: "string",
        description: "记忆内容 (markdown 格式)",
      })
      .option("title", {
        alias: "t",
        type: "string",
        description: "记忆标题 (用于生成章节标题)",
      })
      .option("filename", {
        alias: "f",
        type: "string",
        description: "文件名 (默认使用 memory.memoryFile 配置)",
      })
      .option("config", {
        type: "string",
        describe: "Config file path",
      })
      // Extract 模式选项
      .option("extract", {
        alias: "e",
        type: "boolean",
        default: false,
        description: "触发提取模式：从会话历史中提取记忆",
      })
      .option("scope", {
        type: "string",
        choices: ["project", "global"],
        describe: "记忆作用域",
        demandOption: true,  // 必填
      })
      .option("session-id", {
        type: "string",
        describe: "指定 session ID（可选）",
      })
      .option("require", {
        alias: "r",
        type: "string",
        describe: "自然语言提取指导",
      })
      .demandOption(
        ["mode"],
        "请指定操作模式 (--mode)"
      )
      .check((argv) => {
        const mode = argv.mode as string;
        // extract 模式不需要 content
        if (argv.extract) {
          return true;
        }
        if (mode !== "delete" && !argv.content) {
          throw new Error("--content is required for all modes except 'delete' and 'extract'");
        }
        return true;
      }),
  
  async handler(args) {
    const a = args as any;
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: a.config });
      const env = envService.getEnvironment();
      if (!env) {
        output.error("Failed to create environment");
        process.exit(1);
      }
      const memoryComponent = env.getComponent("memory") as MemoryComponent | undefined;

      if (!memoryComponent) {
        output.error("MemoryComponent not available");
        process.exit(1);
      }

      // Extract 模式：从会话历史提取记忆
      if (a.extract) {
        const agentComponent = env.getComponent("agent") as AgentComponent | undefined;
        const sessionComponent = env.getComponent("session");

        if (!agentComponent) {
          output.error("AgentComponent not available");
          process.exit(1);
        }

        await runExtractMode(output, memoryComponent, agentComponent, sessionComponent, env, {
          scope: a.scope || "project",
          sessionId: args["session-id"] as string | undefined,
          require: a.require,
        });
        return;
      }

      // 普通 record 模式
      const result = await memoryComponent.recordMemory({
        scope: a.scope,
        mode: a.mode,
        content: a.content,
        title: a.title,
      });

      if (!result) {
        output.error("Failed to record memory: no memory paths configured");
        process.exit(1);
      }

      const actionMessages: Record<string, string> = {
        created: "已创建记忆文件",
        overwrite: "已覆盖记忆文件",
        append: "已追加内容到记忆文件",
        prepend: "已插入内容到记忆文件开头",
        delete: "已删除记忆文件",
      };

      output.log(chalk.green(`✓ ${actionMessages[result.action]}`));
      output.log(chalk.gray(`路径: ${result.path}`));

      // 如果是 overwrite/append/prepend，显示写入的内容预览
      if (result.action !== "delete" && a.content) {
        const preview = a.content.substring(0, 100);
        output.log(chalk.gray(`内容预览: ${preview}${a.content.length > 100 ? "..." : ""}`));
      }
    } catch (error) {
      output.error(`Failed to record memory: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
