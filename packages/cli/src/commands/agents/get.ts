/**
 * @fileoverview Agents Get Command
 * 
 * 命令：roy-bot agents get <name>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { AgentComponent } from "@ai-setting/roy-bot-core";
import type { AgentDefinition } from "@ai-setting/roy-bot-core";

interface GetOptions {
  name: string;
  json?: boolean;
  config?: string;
}

export const GetCommand: CommandModule<object, GetOptions> = {
  command: "get <name>",
  describe: "获取指定 agent 的详细信息",
  
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "Agent 名称",
        demandOption: true,
      })
      .option("json", {
        alias: "j",
        type: "boolean",
        default: false,
        description: "JSON 输出",
      }),
  
  async handler(args) {
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: (args as any).config });
      const env = envService.getEnvironment();
      if (!env) {
        output.error("Failed to create environment");
        process.exit(1);
      }
      
      const agentComponent = env.getComponent("agent") as AgentComponent | undefined;
      if (!agentComponent) {
        output.error("AgentComponent not available");
        process.exit(1);
      }

      // 从 registry 获取 agent
      const registry = agentComponent.getRegistry?.();
      if (!registry) {
        output.error("Agent registry not available");
        process.exit(1);
      }

      const agent = registry.get(args.name);
      if (!agent) {
        output.error(`Agent not found: ${args.name}`);
        process.exit(1);
      }

      const resolvedSystemPrompt = await registry.getSystemPrompt(args.name);

      if ((args as any).json) {
        output.json({
          name: agent.name,
          type: agent.type,
          description: agent.description,
          workflow: agent.workflow,
          systemPromptRef: agent.systemPromptRef,
          systemPrompt: agent.systemPrompt,
          resolvedSystemPrompt,
          model: agent.model,
          maxIterations: agent.maxIterations,
          allowedTools: agent.allowedTools,
          deniedTools: agent.deniedTools,
          toolTimeout: agent.toolTimeout,
          toolRetries: agent.toolRetries,
          doomLoopThreshold: agent.doomLoopThreshold,
          filterHistory: agent.filterHistory,
        });
      } else {
        // 格式化输出
        output.log(chalk.bold.cyan(`# Agent: ${agent.name}`));
        output.log("");

        // 基本信息
        output.log(chalk.bold("Basic Info:"));
        output.log(`  ${chalk.cyan("name:")} ${agent.name}`);
        output.log(`  ${chalk.cyan("type:")} ${agent.type}`);
        if (agent.description) {
          output.log(`  ${chalk.cyan("description:")} ${agent.description}`);
        }
        output.log("");

        // Workflow 信息（仅 type=workflow 时显示）
        if (agent.type === "workflow") {
          output.log(chalk.bold("Workflow:"));
          if (agent.workflow) {
            output.log(`  ${chalk.cyan("workflow:")} ${agent.workflow}`);
            output.log(`  ${chalk.gray("→")} ${chalk.gray(`roy-bot workflow run ${agent.workflow} --input '{"query":"..."}'`)}`);
          } else {
            output.log(`  ${chalk.gray("(no workflow configured)")}`);
          }
          output.log("");
        }

        // System Prompt
        output.log(chalk.bold("System Prompt:"));
        if (agent.systemPromptRef) {
          output.log(`  ${chalk.green("[ref]")} ${chalk.cyan("systemPromptRef:")} ${agent.systemPromptRef}`);
        }
        if (agent.systemPrompt && !agent.systemPromptRef) {
          const promptPreview = agent.systemPrompt.length > 100
            ? agent.systemPrompt.slice(0, 97) + "..."
            : agent.systemPrompt;
          output.log(`  ${chalk.gray("[inline]")}`);
          output.log(`  ${chalk.gray(promptPreview.split("\n").join("\n  "))}`);
        }
        if (resolvedSystemPrompt) {
          const resolvedPreview = resolvedSystemPrompt.length > 200
            ? resolvedSystemPrompt.slice(0, 197) + "..."
            : resolvedSystemPrompt;
          output.log(`  ${chalk.green("[resolved]")}`);
          output.log(`  ${chalk.gray(resolvedPreview.split("\n").join("\n  "))}`);
        }
        if (!agent.systemPromptRef && !agent.systemPrompt && !resolvedSystemPrompt) {
          output.log(`  ${chalk.gray("(none)")}`);
        }
        output.log("");

        // 配置选项
        const hasOptions = agent.model || agent.maxIterations || agent.toolTimeout;
        if (hasOptions) {
          output.log(chalk.bold("Options:"));
          if (agent.model) {
            output.log(`  ${chalk.cyan("model:")} ${agent.model}`);
          }
          if (agent.maxIterations) {
            output.log(`  ${chalk.cyan("maxIterations:")} ${agent.maxIterations}`);
          }
          if (agent.toolTimeout) {
            output.log(`  ${chalk.cyan("toolTimeout:")} ${agent.toolTimeout}ms`);
          }
          output.log("");
        }

        // 工具权限
        const hasTools = agent.allowedTools?.length || agent.deniedTools?.length;
        if (hasTools) {
          output.log(chalk.bold("Tool Permissions:"));
          if (agent.allowedTools?.length) {
            output.log(`  ${chalk.green("allowed:")} ${agent.allowedTools.join(", ")}`);
          }
          if (agent.deniedTools?.length) {
            output.log(`  ${chalk.red("denied:")} ${agent.deniedTools.join(", ")}`);
          }
          output.log("");
        }
      }
    } catch (error) {
      output.error(`Failed to get agent: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
