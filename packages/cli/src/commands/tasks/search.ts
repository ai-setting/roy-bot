/**
 * @fileoverview Tasks Search Command
 *
 * 命令：roy-bot tasks search <keywords...>
 * 关键词搜索任务（匹配 title/description/goals/tags/operations）
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { TaskComponent, Task } from "@ai-setting/roy-bot-core";
import { buildListTasksJson } from "./_build-list-json";
import { renderQuietHeader, renderQuietLine, renderQuietPaginationHint } from "../shared/list-output";

interface SearchOptions {
  keywords: string[];
  limit?: number;
  offset?: number;
  status?: string;
  priority?: string;
  type?: string;
  depth?: number;
  includeArchived?: boolean;
  json?: boolean;
  quiet?: boolean;
  config?: string;
}

export const SearchCommand: CommandModule<object, SearchOptions> = {
  command: "search <keywords..>",
  aliases: ["find", "grep"],
  describe: "关键词搜索任务（匹配 title/description/goals/tags/operations）",

  builder: (yargs) =>
    yargs
      .positional("keywords", {
        type: "string",
        array: true,
        describe: "搜索关键词（多个关键词 AND 逻辑）",
        demandOption: true,
      })
      .option("limit", { alias: "n", type: "number", default: 20, description: "返回数量" })
      .option("offset", { alias: "o", type: "number", default: 0, description: "分页偏移（-o alias）" })
      .option("status", {
        alias: "s",
        type: "string",
        choices: ["todo", "active", "to_validate", "completed", "paused", "cancelled", "archived"],
        description: "按状态筛选",
      })
      .option("priority", {
        alias: "p",
        type: "string",
        choices: ["low", "medium", "high"],
        description: "按优先级筛选",
      })
      .option("type", {
        type: "string",
        choices: ["normal", "cycle", "longterm"],
        description: "按任务类型筛选",
      })
      .option("depth", {
        type: "number",
        description: "检索层级深度：0=只根任务，1=根+一层子任务，2=根+二层子任务",
      })
      .option("include-archived", {
        type: "boolean",
        default: false,
        description: "是否包含已归档任务",
      })
      .option("json", { alias: "j", type: "boolean", default: false, description: "JSON 输出" })
      .option("quiet", { alias: "q", type: "boolean", hidden: true }),

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
      const taskComponent = env.getComponent("task") as TaskComponent | undefined;
      if (!taskComponent) {
        output.error("TaskComponent not available");
        process.exit(1);
      }

      const result = await taskComponent.searchTasksByKeywords(args.keywords, {
        limit: args.limit,
        offset: args.offset,
        status: args.status,
        priority: args.priority,
        type: args.type,
        depth: args.depth,
        include_archived: args.includeArchived,
      });

      const tasks: Task[] = result.tasks;
      const total: number = result.total;

      if (args.json) {
        // S-2: share the JSON builder with `tasks list` so both commands
        // emit the same shape. `keywords` is passed as `extras` and is
        // inserted AFTER the standard metadata but BEFORE the tasks array,
        // preserving the "metadata first, array last" invariant.
        output.json(
          buildListTasksJson(
            tasks,
            total,
            { limit: args.limit, offset: args.offset },
            { keywords: args.keywords },
          ),
        );
      } else if (args.quiet) {
        // quiet 模式：# Total: N + 每行 "<id>\t<title>" + 分页提示
        output.log(renderQuietHeader(total, "task"));
        tasks.forEach((t: Task) =>
          output.log(renderQuietLine(t.id, t.title))
        );
        const hint = renderQuietPaginationHint({
          count: tasks.length,
          total,
          offset: args.offset ?? 0,
          limit: args.limit ?? 20,
        });
        if (hint) output.log(hint);
      } else {
        const keywordStr = args.keywords.join(" ");
        output.log(chalk.bold(`\n🔍 Search: "${keywordStr}" — ${total} results\n`));

        if (tasks.length === 0) {
          output.log(chalk.gray("  No matching tasks found."));
          return;
        }

        for (const t of tasks) {
          const statusColor = t.status === "completed" ? chalk.green :
                            t.status === "active" ? chalk.blue :
                            t.status === "to_validate" ? chalk.cyan :
                            t.status === "paused" ? chalk.yellow :
                            t.status === "cancelled" ? chalk.strikethrough :
                            t.status === "archived" ? chalk.gray :
                            chalk.gray;

          const pid = t.parent_task_id ? chalk.gray(` (#${t.parent_task_id})`) : "";
          output.log(`  #${t.id} ${statusColor("[" + t.status + "]")} ${t.title}${pid}`);
          if (t.current_status) {
            output.log(`       ${chalk.gray(t.current_status.slice(0, 80))}`);
          }
        }

        if (total > tasks.length) {
          output.log(chalk.gray(`\n  ... and ${total - tasks.length} more. Use --offset and --limit to paginate.`));
        }

        output.log(chalk.gray(`  Page: ${Math.floor((args.offset || 0) / (args.limit || 20)) + 1}/${Math.ceil(total / (args.limit || 20))}`));
      }
    } catch (error) {
      output.error(`Failed to search tasks: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
