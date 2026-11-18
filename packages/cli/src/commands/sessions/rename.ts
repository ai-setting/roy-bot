/**
 * @fileoverview Sessions Rename Command
 * 
 * 命令：roy-bot sessions rename <session-id> <new-title>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SessionComponent, Session } from "@ai-setting/roy-bot-core";

interface RenameOptions {
  sessionId: string;
  title: string;
  json?: boolean;
  config?: string;
}

export const RenameCommand: CommandModule<object, object> = {
  command: "rename <session-id> <title>",
  aliases: ["mv"],
  describe: "更新会话标题",

  builder: (yargs) =>
    yargs
      .positional("session-id", {
        describe: "会话 ID",
        type: "string",
        demandOption: true,
      })
      .positional("title", {
        describe: "新标题",
        type: "string",
        demandOption: true,
      })
      .option("json", {
        describe: "JSON 格式输出",
        type: "boolean",
        default: false,
      }),

  async handler(args) {
    const a = args as any;
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: a.config });
      const env = envService.getEnvironment();
      if (!env) {
        output.error("Failed to create environment");
        process.exit(1);
      }
      const sessionComponent = env.getComponent("session") as SessionComponent | undefined;

      if (!sessionComponent) {
        output.error("SessionComponent not available");
        process.exit(1);
      }

      // 获取会话
      const session: Session | undefined = await sessionComponent.get(a.sessionId);
      if (!session) {
        output.error(`Session not found: ${a.sessionId}`);
        process.exit(1);
      }

      // 更新标题
      const success = await sessionComponent.update(a.sessionId, {
        title: a.title,
      });

      if (!success) {
        output.error("Failed to rename session");
        process.exit(1);
      }

      if (a.json) {
        output.json({
          success: true,
          session: {
            id: a.sessionId,
            title: a.title,
          },
        });
      } else {
        output.success(`Session renamed: ${chalk.green(a.title)}`);
        output.info(`ID: ${a.sessionId}`);
      }
    } catch (error) {
      output.error(`Failed to rename session: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
