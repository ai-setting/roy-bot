/**
 * @fileoverview Commands Remove Command
 * 
 * 移除收藏命令
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../services/environment.service";
import { OutputService } from "../services/output.service";
import chalk from "chalk";
import type { CommandsComponent } from "@ai-setting/roy-bot-core";

export interface CommandsRemoveOptions {
  name: string;
  global: boolean;
  local: boolean;
  config?: string;
}

export const CommandsRemoveCommand: CommandModule<object, CommandsRemoveOptions> = {
  command: "remove <name>",
  aliases: ["rm"],
  describe: "移除收藏命令",

  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "命令名称",
        type: "string",
        demandOption: true,
      })
      .option("global", {
        alias: "g",
        describe: "从用户级别目录移除",
        type: "boolean",
        default: false,
      })
      .option("local", {
        alias: "l",
        describe: "从项目级别目录移除",
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

      // 统一移除逻辑：
      // - 如果指定了 --global，从 user 目录移除
      // - 如果指定了 --local，从 project 目录移除
      // - 如果都没指定，同时尝试从两个目录移除
      if (args.global) {
        // 从 user 目录移除
        try {
          await commandsComponent.remove({
            name: args.name,
            source: "user",
          });
          output.log(chalk.green(`✅ 已从用户目录移除命令 '${args.name}'`));
        } catch (error: any) {
          // 忽略"命令不存在"的错误
          if (!error.message?.includes("不存在")) {
            throw error;
          }
          output.warn(`命令 '${args.name}' 不存在于用户目录`);
        }
      } else if (args.local) {
        // 从 project 目录移除
        try {
          await commandsComponent.remove({
            name: args.name,
            source: "project",
          });
          output.log(chalk.green(`✅ 已从项目目录移除命令 '${args.name}'`));
        } catch (error: any) {
          // 忽略"命令不存在"的错误
          if (!error.message?.includes("不存在")) {
            throw error;
          }
          output.warn(`命令 '${args.name}' 不存在于项目目录`);
        }
      } else {
        // 同时尝试从两个目录移除
        let removed = false;
        
        // 先尝试从 user 目录移除
        try {
          await commandsComponent.remove({
            name: args.name,
            source: "user",
          });
          output.log(chalk.green(`✅ 已从用户目录移除命令 '${args.name}'`));
          removed = true;
        } catch (error: any) {
          // 忽略"命令不存在"的错误
          if (!error.message?.includes("不存在")) {
            throw error;
          }
        }
        
        // 再尝试从 project 目录移除
        try {
          await commandsComponent.remove({
            name: args.name,
            source: "project",
          });
          output.log(chalk.green(`✅ 已从项目目录移除命令 '${args.name}'`));
          removed = true;
        } catch (error: any) {
          // 忽略"命令不存在"的错误
          if (!error.message?.includes("不存在")) {
            throw error;
          }
        }
        
        if (!removed) {
          output.error(`命令 '${args.name}' 不存在`);
          process.exit(1);
        }
      }
    } catch (error: any) {
      output.error(`移除失败: ${error.message}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
