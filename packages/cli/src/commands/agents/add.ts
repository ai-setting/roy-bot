/**
 * @fileoverview Agents Add Command
 *
 * 命令：roy-bot agents add <name>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { AgentComponent, AgentDefinition } from "@ai-setting/roy-bot-core";

interface AddOptions {
  name: string;
  type: "primary" | "sub" | "workflow";
  description?: string;
  systemPromptRef?: string;
  systemPrompt?: string;
  model?: string;
  workflow?: string;
  allowedTools?: string;
  deniedTools?: string;
  json?: boolean;
  config?: string;
}

function parseToolList(value?: string): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  return value.split(",").map((tool) => tool.trim()).filter(Boolean);
}

export const AddCommand: CommandModule<object, AddOptions> = {
  command: "add <name>",
  describe: "添加 agent 配置（写入 YAML 文件）",

  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "Agent 名称",
        demandOption: true,
      })
      .option("type", {
        alias: "t",
        type: "string",
        choices: ["primary", "sub", "workflow"] as const,
        default: "sub",
        description: "Agent 类型",
      })
      .option("description", {
        type: "string",
        description: "Agent 描述",
      })
      .option("system-prompt-ref", {
        type: "string",
        description: "引用 PromptComponent 中的 prompt 名称",
      })
      .option("system-prompt", {
        type: "string",
        description: "内联 system prompt",
      })
      .option("model", {
        type: "string",
        description: "使用的模型",
      })
      .option("workflow", {
        alias: "w",
        type: "string",
        description: "关联的 workflow 名称（仅 type=workflow 时有效）",
      })
      .option("allowed-tools", {
        type: "string",
        description: "允许的工具（逗号分隔）",
      })
      .option("denied-tools", {
        type: "string",
        description: "拒绝的工具（逗号分隔）",
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
      const registry = agentComponent?.getRegistry?.();
      if (!registry) {
        output.error("Agent registry not available");
        process.exit(1);
      }

      if (registry.hasAgent(args.name)) {
        output.error(`Agent already exists: ${args.name}`);
        process.exit(1);
      }

      // ★ P1: CLI 层 --workflow 必填校验
      if (args.type === "workflow" && !args.workflow) {
        output.error(`--workflow/-w is required when type is 'workflow'`);
        process.exit(1);
      }

      const agent: AgentDefinition = {
        name: args.name,
        type: args.type,
        description: args.description,
        workflow: args.workflow,
        systemPromptRef: args.systemPromptRef,
        systemPrompt: args.systemPrompt,
        model: args.model,
        allowedTools: parseToolList(args.allowedTools),
        deniedTools: parseToolList(args.deniedTools),
      };

      const saved = await registry.saveAgent(agent);
      if (!saved) {
        output.error(`Failed to save agent: ${args.name}`);
        process.exit(1);
      }

      const filePath = registry.getAgentFilePath(args.name);

      if ((args as any).json) {
        output.json({ agent, filePath });
      } else {
        output.log(chalk.green(`✓ Agent '${args.name}' created`));
        output.log(chalk.gray(`  ${filePath}`));
      }
    } catch (error) {
      output.error(`Failed to add agent: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
