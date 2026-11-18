/**
 * @fileoverview Agents Config Dir Command
 *
 * 命令：roy-bot agents config-dir
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { AgentComponent } from "@ai-setting/roy-bot-core";

interface ConfigDirOptions {
  json?: boolean;
  config?: string;
}

export const ConfigDirCommand: CommandModule<object, ConfigDirOptions> = {
  command: "config-dir",
  describe: "显示 agent 配置目录路径",

  builder: (yargs) =>
    yargs.option("json", {
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

      const configDir = registry.getConfigDir();
      const exists = registry.configDirExists();

      if ((args as any).json) {
        output.json({ configDir, exists });
      } else {
        output.log(`${chalk.cyan("Agent Config Directory:")} ${configDir}`);
        output.log(`${chalk.gray("Exists:")} ${exists ? "yes" : "no"}`);
      }
    } catch (error) {
      output.error(`Failed to get config dir: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
