/**
 * @fileoverview Tasks List Command
 * 
 * 命令：roy-bot tasks list
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type {
  TaskComponent,
  Task,
  ListTasksOptions,
} from "@ai-setting/roy-bot-core";
import {
  buildListTasksJson,
  type ListTaskJson,
  type ListTasksJsonOutput,
} from "./_build-list-json";
import {
  buildTaskTree,
  renderTaskTree,
  expandParentChain,
} from "./task-graph";
import { renderQuietHeader, renderQuietLine, renderQuietPaginationHint } from "../shared/list-output";

interface ListOptions {
  status?: string;
  priority?: string;
  type?: string;
  limit?: number;
  offset?: number;
  depth?: number;
  includeArchived?: boolean;
  json?: boolean;
  quiet?: boolean;
  graph?: boolean;
  config?: string;
}

// Re-export the shared types and helper from `_build-list-json.ts` so
// existing imports (`from "./list"`) continue to work AND so `search.ts`
// can share the same builder.
//
// Implementation lives in `_build-list-json.ts` — see that file for the
// shape contract and ordering invariants (including `depth` echo added
// in #1475 and the unification work in #1476).
export { buildListTasksJson, type ListTaskJson, type ListTasksJsonOutput };

export const ListCommand: CommandModule<object, ListOptions> = {
  command: "list",
  aliases: ["ls"],
  describe: "列出所有任务",

  builder: (yargs) =>
    yargs
      .option("status", {
        alias: "s",
        type: "string",
        choices: ["todo", "active", "to_validate", "completed", "paused", "cancelled"],
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
      .option("limit", { alias: "n", type: "number", default: 20, description: "返回数量" })
      .option("offset", { alias: "o", type: "number", default: 0, description: "分页偏移（-o alias）" })
      .option("depth", {
        type: "number",
        description: "检索层级深度：0=只根任务（无父任务），1=根+一层子任务，2=根+二层子任务，-1 或忽略=全部",
      })
      .option("include-archived", {
        type: "boolean",
        default: false,
        description: "是否包含已归档任务（status=archived 的任务默认被排除）",
      })
      .option("json", { alias: "j", type: "boolean", default: false, description: "JSON 输出" })
      .option("quiet", { alias: "q", type: "boolean", hidden: true })  // 使用全局 quiet 选项
      .option("graph", { alias: "g", type: "boolean", default: false, description: "以层次化树形结构展示任务父子关系" }),

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

      const listOptions: ListTasksOptions = {
        status: args.status as any,
        priority: args.priority as any,
        type: args.type as any,
        limit: args.limit,
        offset: args.offset,
        depth: args.depth,
        include_archived: args.includeArchived,
      };
      const listResult = await taskComponent.listTasks(listOptions);
      const tasks: Task[] = listResult.tasks;
      const total: number = listResult.total;

      // --graph: hierarchical tree view (text-only, ignores --json).
      // IMPORTANT: must be checked BEFORE --json, mirroring the
      // sessions/list.ts ordering (see Issue: tests assert graph first).
      if (args.graph) {
        // Auto-expand the parent chain so the tree stays complete even when
        // the limit/offset window excludes some ancestors. Without this,
        // `buildTaskTree` would treat their children as orphans (promoted
        // to root), and the tree would lose its hierarchy. The original
        // `tasks` array is still honored for limit semantics — only the
        // graph view expands.
        const expandedTasks = await expandParentChain(taskComponent, tasks);
        const tree = buildTaskTree(expandedTasks);
        output.log(renderTaskTree(tree, { maxDepth: args.depth }));
        return;
      }

      if (args.json) {
        output.json(buildListTasksJson(tasks, total, args));
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
        // 表格输出
        const header = [
          chalk.bold("#"),
          chalk.bold("Title"),
          chalk.bold("Status"),
          chalk.bold("Priority"),
          chalk.bold("Type"),
          chalk.bold("Progress"),
          chalk.bold("Parent"),
        ].join(" │ ");

        const rows = tasks.map((t: Task, i: number) => {
          const statusColor = t.status === "completed" ? chalk.green :
                            t.status === "active" ? chalk.blue :
                            t.status === "to_validate" ? chalk.cyan :
                            t.status === "paused" ? chalk.yellow :
                            t.status === "cancelled" ? chalk.strikethrough :
                            chalk.gray;

          const priorityColor = t.priority === "high" ? chalk.red :
                              t.priority === "medium" ? chalk.yellow :
                              chalk.gray;

          return [
            (args.offset! + i + 1).toString(),
            t.title.length > 30 ? t.title.slice(0, 27) + "..." : t.title,
            statusColor(t.status),
            priorityColor(t.priority),
            t.type || 'normal',
            `${t.progress}%`,
            t.parent_task_id ? `#${t.parent_task_id}` : chalk.gray("root"),
          ].join(" │ ");
        });

        const depthNote = args.depth !== undefined
          ? chalk.gray(` depth=${args.depth}`)
          : "";
        const archivedNote = args.includeArchived ? chalk.gray(" include-archived") : "";

        output.log([
          `┌─ Tasks ${"─".repeat(55)}┐`,
          `│${header}│`,
          "├" + "─".repeat(header.length + 2) + "┤",
          ...rows.map(r => `│${r}│`),
          "└" + "─".repeat(header.length + 2) + "┘",
          "",
          chalk.gray(`Showing ${tasks.length} of ${total} tasks (offset=${args.offset}, limit=${args.limit})${depthNote}${archivedNote}`),
        ].join("\n"));
      }
    } catch (error) {
      output.error(`Failed to list tasks: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
