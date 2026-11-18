/**
 * @fileoverview EventSource Stop Command
 * 
 * 停止事件源
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { EventSourceComponentInterface } from "@ai-setting/roy-bot-core";

export interface EventSourceStopOptions {
  id: string;
  config?: string;
  force?: boolean;
}

export const EventSourceStopCommand: CommandModule<object, EventSourceStopOptions> = {
  command: "stop <id>",
  aliases: ["kill"],
  describe: "停止指定的事件源",

  builder: (yargs) =>
    yargs
      .positional("id", {
        describe: "事件源 ID（支持前缀匹配）",
        type: "string",
        demandOption: true,
      })
      .option("force", {
        alias: "f",
        describe: "强制停止",
        type: "boolean",
        default: false,
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
      const esComponent = env.getComponent("event-source") as unknown as EventSourceComponentInterface | undefined;

      if (!esComponent) {
        output.error("EventSourceComponent not available");
        process.exit(1);
      }

      // 查找事件源（支持前缀匹配）
      const sources = esComponent.list();
      const matchedSource = sources.find(
        (s) => s.id === args.id || s.id.startsWith(args.id)
      );

      if (!matchedSource) {
        output.error(`事件源不存在: ${args.id}`);
        process.exit(1);
      }

      // 检查状态
      const status = esComponent.getStatus(matchedSource.id);
      if (status !== "running") {
        output.log(chalk.yellow(`事件源未运行: ${matchedSource.name} (${status || "unknown"})`));
        return;
      }

      // 停止
      output.info(`正在停止事件源 '${matchedSource.name}'...`);

      try {
        await esComponent.stopSource(matchedSource.id);
        output.success(chalk.green(`事件源已停止: ${matchedSource.name}`));
      } catch (error) {
        output.error(`停止失败: ${error}`);
        process.exit(1);
      }

    } finally {
      await envService.dispose();
    }
  },
};
