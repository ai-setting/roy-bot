/**
 * @fileoverview Sessions Adapt Checkpoints Command
 *
 * 命令：roy-bot sessions adapt-checkpoints <session-id> [--apply]
 *       roy-bot sessions adapt-checkpoints --recent 30 [--apply]
 *
 * Task #4933（C 方案）：把存量旧格式 checkpoint（summary / processKeyPoints /
 * currentState / nextSteps / userIntents 五栏位）迁移为新格式（整段 content）。
 *
 * ⚠️ 默认 dry-run（只报告不写库）。
 * ⚠️ `--apply` 会重写 session.metadata —— 若 roy-bot daemon 正在运行并持有
 *    sessions.db 的内存缓存，外部写入可能被 daemon 后续覆盖。
 *    **建议在 daemon 重启后（或停机时）执行 --apply**。
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type {
  SessionComponent,
  Session,
  CheckpointAdaptReport,
} from "@ai-setting/roy-bot-core";

interface AdaptCheckpointsOptions {
  sessionId?: string;
  recent?: number;
  apply?: boolean;
  json?: boolean;
  config?: string;
}

export const AdaptCheckpointsCommand: CommandModule<object, object> = {
  command: "adapt-checkpoints [session-id]",
  aliases: ["adapt-cps"],
  describe: "把存量旧格式 checkpoint 适配为新格式（C 方案，默认 dry-run）",

  builder: (yargs) =>
    yargs
      .positional("session-id", {
        describe: "会话 ID（不传时配合 --recent 批量扫描）",
        type: "string",
      })
      .option("recent", {
        type: "number",
        description: "按 updated_at 倒序扫描最近 N 个 session（含 checkpoint 的）",
      })
      .option("apply", {
        type: "boolean",
        default: false,
        description: "实际写回数据库（默认 dry-run 只报告）",
      })
      .option("json", { alias: "j", type: "boolean", default: false }),

  async handler(args) {
    const a = args as unknown as AdaptCheckpointsOptions;
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: a.config });
      const env = envService.getEnvironment();
      if (!env) {
        output.error("Failed to create environment");
        process.exit(1);
      }
      const sessionComponent = env.getComponent("session") as
        | SessionComponent
        | undefined;
      if (!sessionComponent) {
        output.error("SessionComponent not available");
        process.exit(1);
      }

      // ---- 决定要处理哪些 session ----
      let sessionIds: string[] = [];
      if (a.sessionId) {
        sessionIds = [a.sessionId];
      } else if (a.recent && a.recent > 0) {
        const all: Session[] = await sessionComponent.list({ limit: 10000 });
        const sorted = [...all].sort((x, y) => y.updatedAt - x.updatedAt);
        // 只保留真的有 checkpoint 的
        for (const s of sorted) {
          if (sessionIds.length >= a.recent) break;
          const raw = await sessionComponent.readStoredCheckpointsRaw(s.id);
          if (raw.length > 0) sessionIds.push(s.id);
        }
      } else {
        output.error(
          "请提供 <session-id>，或用 --recent N 指定扫描最近 N 个有 checkpoint 的 session"
        );
        process.exit(1);
      }

      if (sessionIds.length === 0) {
        output.log(chalk.gray("没有找到含 checkpoint 的 session"));
        return;
      }

      // ---- 逐 session 适配 ----
      const reports: CheckpointAdaptReport[] = [];
      for (const sid of sessionIds) {
        const exists = await sessionComponent.get(sid);
        if (!exists) {
          output.warn(`Session not found: ${sid}`);
          continue;
        }
        const report = await sessionComponent.adaptStoredCheckpoints(sid, {
          apply: a.apply === true,
        });
        reports.push(report);
      }

      const totals = reports.reduce(
        (acc, r) => ({
          total: acc.total + r.total,
          legacy: acc.legacy + r.legacy,
          modern: acc.modern + r.modern,
          applied: acc.applied + r.applied,
        }),
        { total: 0, legacy: 0, modern: 0, applied: 0 }
      );

      if (a.json) {
        output.json({
          dryRun: a.apply !== true,
          sessions: reports.length,
          totals,
          reports,
        });
        return;
      }

      // ---- 人类可读输出 ----
      const mode = a.apply === true ? chalk.yellow("APPLY") : chalk.green("DRY-RUN");
      output.log(chalk.bold(`┌─ Checkpoint Adaptation (${mode}) ${"─".repeat(24)}┐`));
      output.log(`│ Sessions scanned:   ${reports.length}`);
      output.log(`│ Checkpoints total:  ${totals.total}`);
      output.log(`│ Legacy (to adapt):  ${chalk.yellow(totals.legacy)}`);
      output.log(`│ Modern (skip):      ${chalk.gray(totals.modern)}`);
      output.log(`│ Applied (written):  ${a.apply === true ? chalk.green(totals.applied) : chalk.gray("0 (dry-run)")}`);
      output.log("└" + "─".repeat(51) + "┘");

      for (const r of reports) {
        if (r.total === 0) continue;
        output.log("");
        output.log(
          chalk.bold(`Session ${r.sessionId}`) +
            chalk.gray(`  (total=${r.total} legacy=${r.legacy} modern=${r.modern})`)
        );
        for (const s of r.samples) {
          output.log(chalk.gray(`  • ${s.title} → ${s.contentLength} chars`));
          output.log(chalk.gray(`    ${s.contentPreview.replace(/\n/g, " ")}…`));
        }
      }

      if (a.apply !== true && totals.legacy > 0) {
        output.log("");
        output.log(
          chalk.yellow(
            `提示：这是 dry-run，未写库。确认无误后加 --apply 实际迁移。\n` +
            `⚠️ 若 roy-bot daemon 正在运行（持有 sessions.db 内存缓存），\n` +
            `   外部进程写入可能被 daemon 覆盖 —— 建议 daemon 重启后再执行 --apply。`
          )
        );
      }
    } catch (error) {
      output.error(
        `Failed to adapt checkpoints: ${error instanceof Error ? error.message : String(error)}`
      );
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
