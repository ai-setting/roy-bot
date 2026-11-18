/**
 * @fileoverview EventSource Start Command
 * 
 * 启动事件源
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { EventSourceComponentInterface } from "@ai-setting/roy-bot-core";

export interface EventSourceStartOptions {
  id: string;
  config?: string;
  background?: boolean;
}

export const EventSourceStartCommand: CommandModule<object, EventSourceStartOptions> = {
  command: "start <id>",
  describe: "启动指定的事件源",

  builder: (yargs) =>
    yargs
      .positional("id", {
        describe: "事件源 ID（支持前缀匹配）",
        type: "string",
        demandOption: true,
      })
      .option("background", {
        alias: "b",
        describe: "后台运行",
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
      if (status === "running") {
        output.log(chalk.yellow(`事件源已在运行: ${matchedSource.name}`));
        return;
      }

      // 启动
      output.info(`正在启动事件源 '${matchedSource.name}'...`);

      try {
        await esComponent.startSource(matchedSource.id);
        output.success(chalk.green(`事件源已启动: ${matchedSource.name}`));

        if (!args.background) {
          output.log(chalk.gray("按 Ctrl+C 停止..."));

          // 等待信号
          await new Promise<void>((resolve) => {
            const cleanup = () => {
              process.removeListener("SIGINT", cleanup);
              process.removeListener("SIGTERM", cleanup);
              resolve();
            };
            process.on("SIGINT", cleanup);
            process.on("SIGTERM", cleanup);
          });
        }
      } catch (error) {
        output.error(`启动失败: ${error}`);
        process.exit(1);
      }

    } finally {
      await envService.dispose();
    }
  },
};
