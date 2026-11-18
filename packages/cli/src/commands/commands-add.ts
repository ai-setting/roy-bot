/**
 * @fileoverview Commands Add Command
 * 
 * 添加收藏命令
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../services/environment.service";
import { OutputService } from "../services/output.service";
import chalk from "chalk";
import type { CommandsComponent } from "@ai-setting/roy-bot-core";

export interface CommandsAddOptions {
  name: string;
  target: string;
  global: boolean;
  local: boolean;
  description: string;
  tips: string;
  config?: string;
}

export const CommandsAddCommand: CommandModule<object, CommandsAddOptions> = {
  command: "add <name> <target>",
  describe: "添加收藏命令（自动创建 symlink）",

  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "命令名称",
        type: "string",
        demandOption: true,
      })
      .positional("target", {
        describe: "目标命令路径或名称",
        type: "string",
        demandOption: true,
      })
      .option("global", {
        alias: "g",
        describe: "添加到用户级别目录（默认）",
        type: "boolean",
        default: true,
      })
      .option("local", {
        alias: "l",
        describe: "添加到项目级别目录",
        type: "boolean",
        default: false,
      })
      .option("description", {
        alias: "d",
        describe: "命令功能描述（用于 AI Prompt 注入）",
        type: "string",
        demandOption: true,
      })
      .option("tips", {
        alias: "t",
        describe: "探索提示（告诉用户如何使用 --help 探索）",
        type: "string",
        demandOption: true,
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

      const source = args.local ? "project" : "user";

      await commandsComponent.add({
        name: args.name,
        target: args.target,
        source,
        description: args.description,
        tips: args.tips,
      });

      const dirs = await commandsComponent.getCommandDirs();
      const targetDir = source === "user" ? dirs.user : dirs.project;

      output.log(chalk.green(`✅ 已添加命令 '${args.name}'`));
      output.log(chalk.gray(`   目标: ${args.target}`));
      output.log(chalk.gray(`   位置: ${targetDir}/${args.name}`));
      output.log(chalk.gray(`   级别: ${source === "user" ? "USER" : "PROJECT"}`));
    } catch (error: any) {
      output.error(`添加失败: ${error.message}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
