/**
 * @fileoverview Prompt Config Dir Command
 *
 * 命令：roy-bot prompt config-dir
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { PromptComponent } from "@ai-setting/roy-bot-core";

interface ConfigDirOptions {
  json?: boolean;
  config?: string;
}

export const ConfigDirCommand: CommandModule<object, ConfigDirOptions> = {
  command: "config-dir",
  describe: "显示 prompt 持久化目录路径",

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

      const promptComponent = env.getComponent("prompt") as PromptComponent | undefined;
      if (!promptComponent) {
        output.error("PromptComponent not available");
        process.exit(1);
      }

      const configDir = promptComponent.getPromptConfigDir();
      const exists = promptComponent.getPromptStore().configDirExists();

      if ((args as any).json) {
        output.json({ configDir, exists });
      } else {
        output.log(`${chalk.cyan("Prompt Config Directory:")} ${configDir}`);
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
