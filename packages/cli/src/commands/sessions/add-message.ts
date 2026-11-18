/**
 * @fileoverview Sessions Add Message Command
 * 
 * 命令：roy-bot sessions add-message <session-id> <role> <content>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SessionComponent, Session } from "@ai-setting/roy-bot-core";

interface AddMessageOptions {
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  json?: boolean;
  config?: string;
}

export const AddMessageCommand: CommandModule<object, object> = {
  command: "add-message <session-id> <role> <content>",
  aliases: ["add"],
  describe: "添加消息到会话 [test]",

  builder: (yargs) =>
    yargs
      .positional("session-id", {
        describe: "会话 ID",
        type: "string",
        demandOption: true,
      })
      .positional("role", {
        describe: "消息角色",
        type: "string",
        choices: ["user", "assistant", "system", "tool"],
        demandOption: true,
      })
      .positional("content", {
        describe: "消息内容",
        type: "string",
        demandOption: true,
      })
      .option("json", { alias: "j", type: "boolean", default: false }),

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

      // 检查会话是否存在
      const session: Session | undefined = await sessionComponent.get(a.sessionId);
      if (!session) {
        output.error(`Session not found: ${a.sessionId}`);
        process.exit(1);
      }

      // 添加消息
      const messageId = await sessionComponent.addMessage(a.sessionId, {
        role: a.role,
        content: a.content,
      });

      if (a.json) {
        output.json({
          success: true,
          messageId,
          sessionId: a.sessionId,
          role: a.role,
          contentLength: a.content.length,
        });
      } else {
        output.success(`Message added to session ${a.sessionId}`);
        output.log(`Message ID: ${messageId}`);
        output.log(`Role: ${a.role}`);
        output.log(`Content: ${a.content.substring(0, 100)}${a.content.length > 100 ? "..." : ""}`);
      }
    } finally {
      await envService.dispose();
    }
  },
};
