/**
 * @fileoverview Tasks Complete Command
 * 
 * 命令：roy-bot tasks complete <task-id>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type {
  SessionComponent,
  TaskComponent,
  Task,
} from "@ai-setting/roy-bot-core";
// ★ Task #5063 — 归档态 current_status 措辞同源锚点（不写字面量，避免漂移）
import { TASK_ARCHIVED_STATUS_WORD } from "@ai-setting/roy-bot-core";

interface CompleteOptions {
  archive?: boolean;
  id: number;
  json?: boolean;
  config?: string;
  plugin?: string[];
}

export const CompleteCommand: CommandModule<object, CompleteOptions> = {
  command: "complete <id>",
  aliases: ["done", "finish"],
  describe: "完成任务",
  
  builder: (yargs) =>
    yargs
      .positional("id", {
        type: "number",
        describe: "任务 ID",
        demandOption: true,
      })
      .option("archive", { alias: "a", type: "boolean", default: false, description: "归档任务（设为 archived 状态而非完成）" })
      .option("json", { alias: "j", type: "boolean", default: false, description: "JSON 输出" })
      .option("plugin", {
        alias: "p",
        type: "string",
        array: true,
        description: "Enable plugin (e.g., --plugin task-tag)",
      }),
  
  async handler(args) {
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      // 传递 plugin 选项到 EnvironmentService
      await envService.create({ 
        configPath: args.config,
        plugins: args.plugin,
        loadPlugins: true,
        commandName: "tasks:complete",
      });
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
      
      let task: Task | undefined;
      if (args.archive) {
        // ★ Task #5063 — 归档时同步写 current_status。
        // 与 #5060 的 completed / cancelled 路径同类缺陷收口：原来只设
        // status="archived" ⇒ current_status 仍停在归档前的旧文案。
        // TaskComponent.updateTask 已能兜底派生终态措辞（终态收口），
        // 这里显式写出来，让 CLI 路径的意图可见、且不依赖兜底。
        task = await taskComponent.updateTask(args.id, {
          status: "archived",
          current_status: TASK_ARCHIVED_STATUS_WORD,
        });
        if (task) {
          await taskComponent.createOperation({
            taskId: args.id,
            sessionId: currentSessionId,
            milestoneType: "completed",
            milestoneTitle: "Task archived",
            milestoneDescription: "归档任务",
          });
        }
      } else {
        task = await taskComponent.completeTask(args.id, currentSessionId);
      }
      
      if (!task) {
        output.error(`Task not found: ${args.id}`);
        process.exit(1);
      }

      if (args.json) {
        output.json(task);
      } else {
        output.log(chalk.green(`\n✓ Task completed: #${task.id}`));
        output.log(`  Title: ${task.title}`);
        output.log(`  Progress: ${task.progress}%`);
        output.log(`  Completed at: ${task.updatedAt}`);
      }
    } catch (error) {
      output.error(`Failed to complete task: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
