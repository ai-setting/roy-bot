/**
 * @fileoverview EventSource Remove Command
 * 
 * 移除事件源
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { EventSourceComponentInterface } from "@ai-setting/roy-bot-core";

export interface EventSourceRemoveOptions {
  id: string;
  config?: string;
  force?: boolean;
}

export const EventSourceRemoveCommand: CommandModule<object, EventSourceRemoveOptions> = {
  command: "remove <id>",
  aliases: ["rm"],
  describe: "移除指定的事件源",

  builder: (yargs) =>
    yargs
      .positional("id", {
        describe: "事件源 ID（支持前缀匹配）",
        type: "string",
        demandOption: true,
      })
      .option("force", {
        alias: "f",
        describe: "强制移除（即使正在运行）",
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

      // 检查是否正在运行
      const status = esComponent.getStatus(matchedSource.id);
      if (status === "running" && !args.force) {
        output.error(`事件源正在运行中，请先停止: ${matchedSource.name} (${status})`);
        output.log(chalk.gray(`使用 --force 强制移除或 'roy-bot eventsource stop ${matchedSource.id.substring(0, 8)}' 先停止`));
        process.exit(1);
      }

      // 如果正在运行，先停止
      if (status === "running") {
        await esComponent.stopSource(matchedSource.id);
        output.info(`已停止事件源: ${matchedSource.name}`);
      }

      // 移除
      const result = esComponent.unregister(matchedSource.id);

      if (result) {
        output.success(chalk.green(`事件源已移除: ${matchedSource.name}`));
      } else {
        output.error("移除失败");
        process.exit(1);
      }

    } finally {
      await envService.dispose();
    }
  },
};
