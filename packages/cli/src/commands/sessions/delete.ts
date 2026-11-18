/**
 * @fileoverview Sessions Delete Command
 * 
 * 命令：roy-bot sessions delete <session-id...>
 * 
 * 支持：
 * - 单个删除：roy-bot sessions delete <session-id>
 * - 批量删除：roy-bot sessions delete <session-id-1> <session-id-2> ...
 * - 全量删除：roy-bot sessions delete --all
 * - 按时间删除：roy-bot sessions delete --older-than <days>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SessionComponent, Session } from "@ai-setting/roy-bot-core";

interface DeleteOptions {
  sessionIds: string[];
  all?: boolean;
  olderThan?: number;
  keepActive?: boolean;
  force?: boolean;
  dryRun?: boolean;
  config?: string;
}

export const DeleteCommand: CommandModule<object, object> = {
  command: "delete [session-ids...]",
  aliases: ["rm"],
  describe: "删除会话（支持批量删除和全量删除）",

  builder: (yargs) =>
    yargs
      .positional("session-ids", {
        describe: "会话 ID（可指定多个）",
        type: "string",
        demandOption: false,
      })
      .option("all", {
        alias: "a",
        type: "boolean",
        default: false,
        description: "删除所有会话",
      })
      .option("older-than", {
        alias: "o",
        type: "number",
        description: "删除指定天数之前的会话",
      })
      .option("keep-active", {
        alias: "k",
        type: "boolean",
        default: false,
        description: "全量删除时保留当前活动会话",
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        default: false,
        description: "跳过确认直接删除",
      })
      .option("dry-run", {
        alias: "d",
        type: "boolean",
        default: false,
        description: "预览模式，只显示将要删除的会话",
      })
      .check((argv) => {
        // 确保至少指定了一种删除方式
        const sessionIds = argv.sessionIds as string[] | undefined;
        const hasIds = sessionIds && sessionIds.length > 0;
        const hasAll = argv.all === true;
        const hasOlderThan = argv.olderThan !== undefined;
        
        if (!hasIds && !hasAll && !hasOlderThan) {
          throw new Error("请指定要删除的会话 ID，或使用 --all 或 --older-than 选项");
        }
        return true;
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

      const activeSessionId = sessionComponent.getActiveSessionId();
      let sessionsToDelete: Session[] = [];

      // 确定要删除的会话
      if (a.sessionIds && a.sessionIds.length > 0) {
        // 批量删除指定的会话
        for (const id of a.sessionIds) {
          const session = await sessionComponent.get(id);
          if (session) {
            sessionsToDelete.push(session);
          } else {
            output.warn(`Session not found: ${id}`);
          }
        }
      } else if (a.all) {
        // 全量删除
        const allSessions = await sessionComponent.list({ limit: 100000 });
        sessionsToDelete = allSessions.filter((s: Session) => {
          if (a.keepActive && s.id === activeSessionId) {
            return false;
          }
          return true;
        });
        if (a.keepActive && sessionsToDelete.length > 0) {
          output.log(chalk.yellow(`Keeping active session: ${activeSessionId}`));
        }
      } else if (a.olderThan !== undefined) {
        // 按时间删除
        const cutoffDate = new Date();
        cutoffDate.setDate(cutoffDate.getDate() - a.olderThan);
        const cutoffTimestamp = cutoffDate.getTime();

        const allSessions = await sessionComponent.list({ limit: 100000 });
        sessionsToDelete = allSessions.filter((s: Session) => {
          const updatedAt = new Date(s.updatedAt).getTime();
          if (updatedAt < cutoffTimestamp) {
            if (a.keepActive && s.id === activeSessionId) {
              return false;
            }
            return true;
          }
          return false;
        });
        output.log(chalk.gray(`Deleting sessions not updated since ${cutoffDate.toISOString().split("T")[0]} (${a.olderThan} days ago)`));
      } else {
        // 这个分支理论上不会到达，因为 yargs check 已经验证了
        output.log("No sessions to delete");
        return;
      }

      if (sessionsToDelete.length === 0) {
        output.log("No sessions to delete");
        return;
      }

      // 预览模式
      if (a.dryRun) {
        output.log(chalk.yellow(`[DRY RUN] Would delete ${sessionsToDelete.length} session(s):\n`));
        sessionsToDelete.forEach((s: Session, i: number) => {
          const marker = s.id === activeSessionId ? chalk.green("▶") : " ";
          output.log(`  ${marker} ${s.id}`);
          output.log(`     Title: ${s.title}`);
          output.log(`     Updated: ${new Date(s.updatedAt).toLocaleString()}`);
          if (i < sessionsToDelete.length - 1) output.log("");
        });
        return;
      }

      // 确认删除
      if (!a.force) {
        output.log(chalk.red(`\n⚠️  About to delete ${sessionsToDelete.length} session(s):\n`));
        sessionsToDelete.forEach((s: Session, i: number) => {
          const marker = s.id === activeSessionId ? chalk.green("▶") : " ";
          output.log(`  ${marker} ${s.id} - ${s.title}`);
        });
        output.log("");
        
        const answer = await new Promise<string>((resolve) => {
          const readline = require("readline");
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });
          rl.question(chalk.red("Type 'yes' to confirm deletion: "), (res: string) => {
            rl.close();
            resolve(res);
          });
        });

        if (answer.toLowerCase() !== "yes") {
          output.log("Deletion cancelled");
          return;
        }
      }

      // 执行删除
      let successCount = 0;
      let failCount = 0;
      const errors: string[] = [];

      for (const session of sessionsToDelete) {
        try {
          const success = await sessionComponent.delete(session.id);
          if (success) {
            successCount++;
          } else {
            failCount++;
            errors.push(`Failed to delete: ${session.id}`);
          }
        } catch (error) {
          failCount++;
          errors.push(`${session.id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // 输出结果
      if (successCount > 0) {
        output.success(chalk.green(`✓`) + ` Deleted ${successCount} session(s)`);
      }
      if (failCount > 0) {
        output.error(`✗ Failed to delete ${failCount} session(s)`);
        errors.forEach((e) => output.error(`  - ${e}`));
      }

      if (successCount === 0 && failCount === 0) {
        output.log("No sessions were deleted");
      }
    } catch (error) {
      output.error(`Failed to delete session: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
