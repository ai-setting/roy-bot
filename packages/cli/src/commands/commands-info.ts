/**
 * @fileoverview Commands Info Command
 * 
 * 显示命令详细信息
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../services/environment.service";
import { OutputService } from "../services/output.service";
import chalk from "chalk";
import { exec } from "child_process";
import { promisify } from "util";
import type { CommandsComponent } from "@ai-setting/roy-bot-core";

const execAsync = promisify(exec);

export interface CommandsInfoOptions {
  name: string;
  config?: string;
}

export const CommandsInfoCommand: CommandModule<object, CommandsInfoOptions> = {
  command: "info <name>",
  describe: "显示命令详细信息",

  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: "命令名称",
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

      const info = await commandsComponent.getInfo(args.name);

      if (!info) {
        output.error(`命令 '${args.name}' 不存在`);
        process.exit(1);
      }

      output.log(chalk.bold("Name:") + ` ${info.name}`);
      output.log(chalk.bold("Path:") + ` ${info.path}`);
      output.log(chalk.bold("Source:") + ` ${info.source.toUpperCase()}`);
      output.log(chalk.bold("Description:") + ` ${info.shortDescription || "-"}`);
      output.log();
      output.log(chalk.gray("─".repeat(50)));
      output.log();

      // 显示完整 --help
      try {
        const { stdout } = await execAsync(`${info.path} --help`, { timeout: 5000 });
        output.log(stdout);
      } catch {
        try {
          const { stdout } = await execAsync(`${info.path} -h`, { timeout: 5000 });
          output.log(stdout);
        } catch {
          output.log(chalk.gray("（无法获取帮助信息）"));
        }
      }
    } catch (error: any) {
      output.error(`错误: ${error.message}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
