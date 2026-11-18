/**
 * @fileoverview Tasks Operations Command
 * 
 * 命令：roy-bot tasks operations <task-id>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type {
  TaskComponent,
  Task,
  TaskOperation,
  ActionType,
  ListOperationsOptions,
} from "@ai-setting/roy-bot-core";

interface OperationsOptions {
  taskId: number;
  type?: string;
  limit?: number;
  offset?: number;
  json?: boolean;
  config?: string;
}

export const OperationsCommand: CommandModule<object, object> = {
  command: "operations <task-id>",
  aliases: ["ops", "log"],
  describe: "查看任务操作记录",
  
  builder: (yargs) =>
    yargs
      .positional("task-id", {
        type: "number",
        describe: "任务 ID",
        demandOption: true,
      })
      .option("type", {
        alias: "t",
        type: "string",
        choices: ["create", "progress", "milestone", "problem", "solution", "decision", "review", "completed"],
        description: "按类型筛选",
      })
      .option("limit", { alias: "n", type: "number", default: 20, description: "返回数量" })
      .option("offset", { type: "number", default: 0, description: "偏移量" })
      .option("json", { alias: "j", type: "boolean", default: false, description: "JSON 输出" }),
  
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
      const taskComponent = env.getComponent("task") as TaskComponent | undefined;

      if (!taskComponent) {
        output.error("TaskComponent not available");
        process.exit(1);
      }

      // Check if task exists
      const task: Task | undefined = await taskComponent.getTask(a.taskId);
      if (!task) {
        output.error(`Task not found: ${a.taskId}`);
        process.exit(1);
      }

      const listOptions: ListOperationsOptions = {
        taskId: a.taskId,
        actionType: a.type as ActionType,
        limit: a.limit,
        offset: a.offset,
      };
      const operations: TaskOperation[] = await taskComponent.listOperations(listOptions);

      if (a.json) {
        output.json({
          count: operations.length,
          task: { id: task.id, title: task.title },
          operations,
        });
      } else {
        output.log(chalk.bold(`\nOperations for Task #${task.id}: ${task.title}\n`));
        
        if (operations.length === 0) {
          output.log(chalk.gray("No operations found."));
        } else {
          operations.forEach((op: TaskOperation, i: number) => {
            const actionColor = op.milestoneType === "completed" ? chalk.green :
                               op.milestoneType === "milestone" ? chalk.blue :
                               op.milestoneType === "problem" ? chalk.red :
                               chalk.gray;

            // 双维度渲染：状态/里程碑 vs 过程
            output.log(`${chalk.bold(a.offset! + i + 1)}. ` + actionColor(`[${op.milestoneType}]`) + ` ${op.milestoneTitle}`);
            output.log(`   Session: ${chalk.cyan(op.sessionId)} | Time: ${op.timestamp}`);
            if (op.milestoneDescription) {
              output.log(`   ${op.milestoneDescription}`);
            }
            if (op.processDescription) {
              output.log(chalk.gray(`   📋 过程概要: ${op.processDescription}`));
            }
            output.log("");
          });
        }
        
        output.log(chalk.gray(`Total: ${operations.length} operations`));
      }
    } catch (error) {
      output.error(`Failed to list operations: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
