/**
 * @fileoverview Tasks Tree Command
 *
 * 命令：roy-bot tasks tree
 * 以树形结构展示所有任务（基于 parent_task_id）
 *
 * The pure tree-building + rendering logic lives in `./task-graph.ts` so
 * that `tasks list --graph` can reuse it. This file is the I/O glue:
 * yargs, EnvironmentService, OutputService, and JSON / text-mode dispatch.
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { TaskComponent, Task, ListTasksOptions } from "@ai-setting/roy-bot-core";
import { buildTaskTree, renderTaskTree, type TaskNode } from "./task-graph";

interface TreeOptions {
  status?: string;
  priority?: string;
  type?: string;
  json?: boolean;
  rootId?: number;
  /**
   * Tree depth (canonical name). Yargs alias `max-depth` keeps the old
   * flag working for 1 version. See handler for the resolved semantics.
   *
   *  - `0`  → only root tasks (no children)
   *  - `1`  → roots + 1 level of children (2 rows total)
   *  - `2`  → roots + 2 levels of children (3 rows total) [default]
   *  - `-1` → no limit (every level)
   *
   * Matches `task-tree-tool.ts` `depth` semantics and `tasks list
   * --depth`. The off-by-one ambiguity (some users read "depth=1" as
   * "1 row only") is intentionally NOT changed — use `--depth 0` for
   * "roots only".
   */
  depth?: number;
  /** @deprecated Use `depth` instead. Kept as alias for back-compat. */
  maxDepth?: number;
  config?: string;
}

// Re-export the shared node type for any consumer that imports from
// `./tree` (backward-compat with potential existing imports).
export type { TaskNode };

export const TreeCommand: CommandModule<object, TreeOptions> = {
  command: "tree",
  describe: "以树形结构展示所有任务（基于 parent_task_id）",

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
      .option("root-id", {
        type: "number",
        description: "以指定任务 ID 作为根开始构建子树（仅展示该任务及其后代）",
      })
      // DEPRECATED in Task #2122: kept as alias of `--depth` for 1 version.
      // Use `--depth` instead.
      .option("max-depth", {
        type: "number",
        alias: "depth",
        description: "[已弃用] 请使用 --depth；保留 1 版本兼容（alias）",
        hidden: true,
      })
      .option("depth", {
        type: "number",
        description:
          "展示深度：0=只根任务（无 children），1=根+1 层，2=根+2 层（默认），-1=全部层级",
        default: 2,
      })
      .option("json", {
        alias: "j",
        type: "boolean",
        default: false,
        description: "以 JSON 格式输出树形结构",
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
      const taskComponent = env.getComponent("task") as TaskComponent | undefined;
      if (!taskComponent) {
        output.error("TaskComponent not available");
        process.exit(1);
      }

      // 取所有任务（用大 limit；一般项目任务量 < 几千）
      const listOptions: ListTasksOptions = {
        status: args.status as any,
        priority: args.priority as any,
        type: args.type as any,
        limit: 9999,
      };
      const listResult = await taskComponent.listTasks(listOptions);
      let tasks: Task[] = listResult.tasks;

      // 如果指定了 root-id，裁剪到该子树
      if (args.rootId !== undefined) {
        const rootId = args.rootId;
        const root = tasks.find(t => t.id === rootId);
        if (!root) {
          output.error(`Task #${rootId} not found`);
          process.exit(1);
        }
        // BFS 收集 rootId + 所有后代
        const allowed = new Set<number>([rootId]);
        let frontier: number[] = [rootId];
        while (frontier.length > 0) {
          const next: number[] = [];
          for (const t of tasks) {
            if (t.parent_task_id !== undefined && frontier.includes(t.parent_task_id) && !allowed.has(t.id)) {
              allowed.add(t.id);
              next.push(t.id);
            }
          }
          frontier = next;
        }
        tasks = tasks.filter(t => allowed.has(t.id));
      }

      const tree = buildTaskTree(tasks);

      if (args.json) {
        output.json({
          total: tasks.length,
          rootCount: tree.length,
          tree,
        });
        return;
      }

      if (tree.length === 0) {
        output.log(chalk.gray("No tasks to display."));
        return;
      }

      output.log(renderTaskTree(tree, { maxDepth: args.depth, rootId: args.rootId }));
    } catch (error) {
      output.error(`Failed to build task tree: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
