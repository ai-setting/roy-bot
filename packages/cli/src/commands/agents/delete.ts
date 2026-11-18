/**
 * @fileoverview Agents Delete Command
 *
 * 命令：roy-bot agents delete <name>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { AgentComponent } from "@ai-setting/roy-bot-core";

interface DeleteOptions {
  name: string;
  yes?: boolean;
  json?: boolean;
  config?: string;
}

export const DeleteCommand: CommandModule<object, DeleteOptions> = {
  command: "delete <name>",
  describe: "删除 agent 配置文件",

  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "Agent 名称",
        demandOption: true,
      })
      .option("yes", {
        alias: "y",
        type: "boolean",
        default: false,
        description: "跳过确认",
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

      const agent = registry.get(args.name);
      if (!agent) {
        output.error(`Agent not found: ${args.name}`);
        process.exit(1);
      }

      const filePath = registry.getAgentFilePath(args.name);
      if (!args.yes) {
        output.log(
          chalk.yellow(
            `Delete agent '${args.name}'? This removes ${filePath} (use --yes to skip confirmation)`
          )
        );
        process.exit(1);
      }

      const deleted = await registry.deleteAgent(args.name);
      if (!deleted) {
        output.error(`Failed to delete agent: ${args.name}`);
        process.exit(1);
      }

      if ((args as any).json) {
        output.json({ deleted: true, name: args.name, filePath });
      } else {
        output.log(chalk.green(`✓ Agent '${args.name}' deleted`));
      }
    } catch (error) {
      output.error(`Failed to delete agent: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
