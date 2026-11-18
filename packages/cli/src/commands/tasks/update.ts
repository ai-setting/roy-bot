/**
 * @fileoverview Tasks Update Command
 * 
 * 命令：roy-bot tasks update <task-id>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type {
  SessionComponent,
  TaskComponent,
  Task,
  TaskStatus,
  TaskPriority,
  UpdateTaskOptions,
} from "@ai-setting/roy-bot-core";

interface UpdateOptions {
  id: number;
  title?: string;
  description?: string;
  status?: string;
  priority?: string;
  type?: string;
  progress?: number;
  current_status?: string;
  "project-path"?: string;
  context?: string;
  /** 父任务 ID，null = 设为根任务（无父任务） */
  "parent-id"?: number | null;
  json?: boolean;
  config?: string;
}

export const UpdateCommand: CommandModule<object, UpdateOptions> = {
  command: "update <id>",
  aliases: ["set"],
  describe: "更新任务",
  
  builder: (yargs) =>
    yargs
      .positional("id", {
        type: "number",
        describe: "任务 ID",
        demandOption: true,
      })
      .option("title", { alias: "t", type: "string", description: "标题" })
      .option("description", { alias: "d", type: "string", description: "描述" })
      .option("status", { alias: "s", type: "string", choices: ["todo", "active", "to_validate", "completed", "paused", "cancelled"], description: "状态" })
      .option("priority", { alias: "p", type: "string", choices: ["low", "medium", "high"], description: "优先级" })
      .option("type", { type: "string", choices: ["normal", "cycle", "longterm"], description: "任务类型 (normal/cycle/longterm)" })
      .option("progress", { type: "number", min: 0, max: 100, description: "进度 (0-100)" })
      .option("current_status", { alias: "c", type: "string", description: "当前状态描述" })
      .option("project-path", { type: "string", description: "项目路径" })
      .option("context", { type: "string", description: "任务上下文 (JSON 字符串)" })
      .option("parent-id", { type: "number", description: "父任务 ID（不传则保持原父任务；传 null 可提升为根任务）" })
      .option("owner", {
        type: "string",
        description:
          '负责人（owner）：传字符串 = 指派/改派；传空字符串（--owner ""）= 清空（未指派）。' +
          "不传该选项 = 不改动。多人协作场景下用于标注任务负责人。",
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
      
      // Build parent_task_id from yargs value. Use `'parent-id' in args` so that
      // an explicit `--parent-id null` (root promotion) is preserved as `null`,
      // while a missing flag stays as `undefined` (no change).
      const parentTaskId = Object.prototype.hasOwnProperty.call(args, "parent-id")
        ? (args as Record<string, unknown>)["parent-id"] as number | null
        : undefined;

      const updateOptions: UpdateTaskOptions = {
        title: args.title,
        description: args.description,
        status: args.status as TaskStatus,
        priority: args.priority as TaskPriority,
        type: args.type as any,
        progress: args.progress,
        current_status: args.current_status,
        project_path: args["project-path"],
        context: args.context,
        parent_task_id: parentTaskId,
        // Task #5440 — 负责人：只在该选项实际出现时才透传（不漏掉显式 ""）
        ...(Object.prototype.hasOwnProperty.call(args, "owner")
          ? { owner: (args as Record<string, unknown>).owner as string | null }
          : {}),
      };
      const task: Task | undefined = await taskComponent.updateTask(args.id, updateOptions);

      if (!task) {
        output.error(`Task not found: ${args.id}`);
        process.exit(1);
      }

      // Create operation record for status/progress changes
      if (args.status || args.progress !== undefined || args.current_status) {
        await taskComponent.createOperation({
          taskId: args.id,
          sessionId: currentSessionId,
          milestoneType: "progress",
          milestoneTitle: args.current_status || `Updated: ${args.status || `${args.progress}%`}`,
          milestoneDescription: JSON.stringify({
            status: args.status,
            progress: args.progress,
          }),
        });
      }

      if (args.json) {
        output.json(task);
      } else {
        output.log(chalk.green(`\n✓ Task updated: #${task.id}`));
        output.log(`  Title: ${task.title}`);
        output.log(`  Status: ${task.status}`);
        output.log(`  Priority: ${task.priority}`);
        output.log(`  Type: ${task.type}`);
        output.log(`  Progress: ${task.progress}%`);
        output.log(`  Project Path: ${task.project_path}`);
        output.log(`  Context: ${task.context}`);
        if (task.current_status) {
          output.log(`  Current Status: ${task.current_status}`);
        }
      }
    } catch (error) {
      output.error(`Failed to update task: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
