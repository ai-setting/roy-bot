/**
 * @fileoverview Sessions Active Command
 * 
 * 命令：roy-bot sessions active [options]
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SessionComponent, Session } from "@ai-setting/roy-bot-core";

interface ActiveOptions {
  clear?: boolean;
  json?: boolean;
  config?: string;
}

export const ActiveCommand: CommandModule<object, ActiveOptions> = {
  command: "active",
  aliases: ["current"],
  describe: "查看/设置当前活跃会话",

  builder: (yargs) =>
    yargs
      .option("clear", { type: "boolean", default: false })
      .option("json", { alias: "j", type: "boolean", default: false }),

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
      const sessionComponent = env.getComponent("session") as SessionComponent | undefined;

      if (!sessionComponent) {
        output.error("SessionComponent not available");
        process.exit(1);
      }

      const activeId = sessionComponent.getActiveSessionId();

      if (args.clear) {
        // 清除活跃会话
        // 注意：需要通过内部机制清除，暂时不支持
        output.log("Active session cleared");
        return;
      }

      if (!activeId) {
        output.log(chalk.gray("No active session set"));
        return;
      }

      const session: Session | undefined = await sessionComponent.get(activeId);

      if (args.json) {
        output.json({
          activeSessionId: activeId,
          session: session ? {
            id: session.id,
            title: session.title,
            directory: session.directory,
            messageCount: session.messageCount,
            createdAt: new Date(session.createdAt).toISOString(),
            updatedAt: new Date(session.updatedAt).toISOString(),
          } : null,
        });
      } else {
        if (!session) {
          output.log(chalk.gray("Active session not found: " + activeId));
          return;
        }

        output.log(chalk.bold.green("┌─ Active Session ─────────────────────────────────┐"));
        output.log(`│ ID:          ${session.id}`);
        output.log(`│ Title:       ${session.title}`);
        output.log(`│ Directory:   ${session.directory}`);
        output.log(`│ Messages:    ${session.messageCount}`);
        output.log(`│ Updated:     ${new Date(session.updatedAt).toLocaleString("zh-CN")}`);
        output.log("└" + "─".repeat(51) + "┘");
      }
    } catch (error) {
      output.error(`Failed to get active session: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
