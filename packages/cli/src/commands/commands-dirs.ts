/**
 * @fileoverview Commands Dirs Command
 * 
 * 显示命令目录
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../services/environment.service";
import { OutputService } from "../services/output.service";
import chalk from "chalk";
import type { CommandsComponent } from "@ai-setting/roy-bot-core";

export interface CommandsDirsOptions {
  json?: boolean;
  config?: string;
}

export const CommandsDirsCommand: CommandModule<object, CommandsDirsOptions> = {
  command: "dirs",
  describe: "显示命令目录",

  builder: (yargs) =>
    yargs
      .option("json", {
        alias: "j",
        describe: "JSON 格式输出",
        type: "boolean",
        default: false,
      })
      .option("config", {
        describe: "配置文件路径",
        type: "string",
      }),

  async handler(args) {
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: args.config });
      const env = envService.getEnvironment();
      if (!env) {
        output.error("Failed to create environment");
        process.exit(1);
      }
      const commandsComponent = env.getComponent("commands") as CommandsComponent | undefined;

      if (!commandsComponent) {
        output.error("CommandsComponent not available");
        process.exit(1);
      }

      const dirs = await commandsComponent.getCommandDirs();

      if (args.json) {
        output.json(dirs);
      } else {
        output.log(chalk.bold("命令目录:"));
        output.log();
        output.log(chalk.cyan("USER:") + `   ${dirs.user}`);
        output.log(chalk.cyan("PROJECT:") + ` ${dirs.project}`);
      }
    } catch (error: any) {
      output.error(`错误: ${error.message}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
