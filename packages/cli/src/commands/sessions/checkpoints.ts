/**
 * @fileoverview Sessions Checkpoints Command
 * 
 * 命令：roy-bot sessions checkpoints <session-id>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SessionComponent, Session, SessionCheckpoint } from "@ai-setting/roy-bot-core";

interface CheckpointsOptions {
  sessionId: string;
  detail?: boolean;
  json?: boolean;
  config?: string;
}

export const CheckpointsCommand: CommandModule<object, object> = {
  command: "checkpoints <session-id>",
  aliases: ["cps"],
  describe: "查看会话检查点列表 [new]",

  builder: (yargs) =>
    yargs
      .positional("session-id", {
        describe: "会话 ID",
        type: "string",
        demandOption: true,
      })
      .option("detail", { alias: "d", type: "boolean", default: false })
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

      const session: Session | undefined = await sessionComponent.get(a.sessionId);
      if (!session) {
        output.error(`Session not found: ${a.sessionId}`);
        process.exit(1);
      }

      const checkpoints: SessionCheckpoint[] = await sessionComponent.getCheckpoints(a.sessionId);

      if (checkpoints.length === 0) {
        output.log(chalk.gray("No checkpoints for this session"));
        return;
      }

      if (a.json) {
        output.json({
          sessionId: a.sessionId,
          checkpoints: checkpoints.map((cp: SessionCheckpoint) => ({
            id: cp.id,
            title: cp.title,
            type: cp.type,
            messageIndex: cp.messageIndex,
            // ★ C 方案（Task #4933）：正文是整段自然语言 content
            //   （旧格式存量已由 adaptLegacyCheckpoint 读时适配）
            content: cp.content,
            messageCountBefore: cp.messageCountBefore,
            createdAt: new Date(cp.createdAt).toISOString(),
          })),
          total: checkpoints.length,
        });
        return;
      }

      if (a.detail) {
        // 详细模式
        checkpoints.reverse().forEach((cp: SessionCheckpoint, i: number) => {
          const isLatest = i === 0;
          output.log(chalk.bold(`┌─ Checkpoint: ${cp.title} ${isLatest ? chalk.green("✓") : ""} ──────` + "─".repeat(Math.max(0, 30 - cp.title.length)) + "┐"));
          output.log(`│ ID:            ${cp.id}`);
          output.log(`│ Type:          ${cp.type}`);
          output.log(`│ Message Index: ${cp.messageIndex} (${cp.messageCountBefore} messages)`);
          output.log(`│ Created:       ${new Date(cp.createdAt).toLocaleString("zh-CN")}`);
          // ★ C 方案（Task #4933）：直接打印整段自然语言正文
          output.log("├─ Content ───────────────────────────────────────────┤");
          for (const line of (cp.content ?? "").split("\n")) {
            output.log(`│ ${line}`);
          }
          output.log("└" + "─".repeat(51) + "┘");
          output.log("");
        });
      } else {
        // 简洁模式
        const header = [
          chalk.bold("#"),
          chalk.bold("Title"),
          chalk.bold("Type"),
          chalk.bold("Messages"),
          chalk.bold("Created"),
        ].join(" │ ");

        output.log(`┌─ Checkpoints (${checkpoints.length}) ${"─".repeat(40)}┐`);
        output.log(`│${header}│`);
        output.log("├" + "─".repeat(header.length + 2) + "┤");

        checkpoints.reverse().forEach((cp: any, i: number) => {
          const isLatest = i === 0;
          const marker = isLatest ? chalk.green("✓ ") : "  ";
          const title = cp.title.length > 25 ? cp.title.slice(0, 22) + "..." : cp.title;
          const created = new Date(cp.createdAt).toLocaleString("zh-CN", {
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          });

          output.log(`│${marker}${i + 1}  ${title.padEnd(25)} │ ${cp.type.padEnd(5)} │ ${cp.messageCountBefore.toString().padStart(8)} │ ${chalk.gray(created)}│`);
        });

        output.log("└" + "─".repeat(header.length + 2) + "┘");
      }
    } catch (error) {
      output.error(`Failed to get checkpoints: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
