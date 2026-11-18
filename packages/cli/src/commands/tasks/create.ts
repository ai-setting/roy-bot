/**
 * @fileoverview Tasks Create Command
 * 
 * 命令：roy-bot tasks create <title>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import { TASK_DISCIPLINE_GOALS } from "@ai-setting/roy-bot-core";
import type {
  SessionComponent,
  TaskComponent,
  Task,
  CreateTaskOptions,
  TaskPriority,
} from "@ai-setting/roy-bot-core";

/**
 * Task #4942 — `--goals` help text is the ONLY place a runtime agent can learn
 * the goals contract when it creates tasks through this CLI entry point.
 *
 * Single source of truth: the numbered examples are EXTRACTED at module load
 * from core's `TASK_DISCIPLINE_GOALS` (packages/core/src/env/task/prompt/
 * task-discipline.ts), the same constant the `task_create` tool renders. No
 * private copy here — if core rewrites an example, this text follows, and
 * create.test.ts fails loudly instead of letting the two drift apart.
 *
 * Kept deliberately short: a full render of the discipline text is ~1200 chars,
 * unreadable as inline `--help` copy. We take the numbered examples verbatim
 * plus a 3-line digest of the surrounding rules.
 */
const GOALS_EXAMPLE_LINES = TASK_DISCIPLINE_GOALS.split("\n")
  .map((line) => line.trim())
  .filter((line) => /^\d+\.\s+\S/.test(line));

export const GOALS_OPTION_DESCRIPTION = [
  "目标和预期产出。MUST 写成可逐条验收的编号子项（numbered sub-items），不要用 `-` 平铺列表或一句话模糊目标。",
  ...GOALS_EXAMPLE_LINES,
  "type=longterm / cycle 不走逐条 complete 验收，但仍建议拆成阶段性可判子项。",
  "完整规则见 core TASK_DISCIPLINE_GOALS；每条子项建议用四原子断言形态（文件 / 进程 / 测试 / 状态）。",
].join("\n");

interface CreateOptions {
  title: string;
  description?: string;
  owner?: string;
  priority?: string;
  type?: string;
  goals?: string;
  due?: string;
  tags?: string;
  "project-path"?: string;
  context?: string;
  json?: boolean;
  config?: string;
}

export const CreateCommand: CommandModule<object, CreateOptions> = {
  command: "create <title>",
  aliases: ["add", "new"],
  describe: "创建新任务",
  
  builder: (yargs) =>
    yargs
      .positional("title", {
        type: "string",
        describe: "任务标题",
        demandOption: true,
      })
      .option("description", {
        alias: "d",
        type: "string",
        description: "任务描述",
      })
      .option("priority", {
        alias: "p",
        type: "string",
        choices: ["low", "medium", "high"],
        default: "medium",
        description: "优先级",
      })
      .option("type", {
        type: "string",
        choices: ["normal", "cycle", "longterm"],
        desc: "任务类型。normal=常规, cycle=周期任务（如周报）, longterm=长期目标",
        default: "normal",
      })
      .option("goals", {
        alias: "g",
        type: "string",
        description: GOALS_OPTION_DESCRIPTION,
      })
      .option("due", {
        type: "string",
        description: "截止日期 (ISO 格式)",
      })
      .option("tags", {
        type: "string",
        description: "标签 (逗号分隔)",
      })
      .option("project-path", {
        type: "string",
        description: "项目路径",
      })
      .option("parent-id", {
        type: "number",
        description: "父任务 ID（可选）。不传则创建根任务（root task）。使用 task_list(depth=0) 查看已有根任务列表。",
      })
      .option("context", {
        type: "string",
        description: "任务上下文 (JSON 字符串)",
      })
      .option("owner", {
        type: "string",
        description:
          "负责人（owner）：这个任务由谁负责推进，可空（不传即未指派）。" +
          "取值自由（open_id / 用户名 / 邮箱均可）；多人协作场景下用于区分负责人。",
      })
      .option("json", { alias: "j", type: "boolean", default: false, description: "JSON 输出" }),
  
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
      const taskComponent = env.getComponent("task") as TaskComponent | undefined;

      if (!taskComponent) {
        output.error("TaskComponent not available");
        process.exit(1);
      }

      // Get current session ID
      const currentSessionId = sessionComponent?.getActiveSessionId() || "cli";
      
      const createOptions: CreateTaskOptions = {
        parent_task_id: args["parent-id"],
        title: args.title,
        description: args.description,
        priority: args.priority as TaskPriority,
        type: args.type as any,
        goals_and_expected_deliverables: args.goals,
        due_date: args.due,
        tags: args.tags ? args.tags.split(",").map(t => t.trim()) : undefined,
        sessionId: currentSessionId,
        project_path: args["project-path"] || process.cwd(),
        context: args.context || '{}',
        // Task #5440 — 负责人（可选；不传即 null/未指派）
        ...(args.owner !== undefined ? { owner: args.owner } : {}),
      };
      const task: Task = await taskComponent.createTask(createOptions);

      if (args.json) {
        output.json(task);
      } else {
        output.log(chalk.green(`\n✓ Task created: #${task.id}`));
        output.log(`  Title: ${task.title}`);
        output.log(`  Status: ${task.status}`);
        output.log(`  Priority: ${task.priority}`);
        output.log(`  Type: ${task.type}`);
        output.log(`  Created at: ${task.createdAt}`);
      }
    } catch (error) {
      output.error(`Failed to create task: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
