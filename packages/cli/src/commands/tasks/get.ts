/**
 * @fileoverview Tasks Get Command
 * 
 * 命令：roy-bot tasks get <task-id>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type {
  TaskComponent,
  Task,
  TaskOperation,
} from "@ai-setting/roy-bot-core";

interface GetOptions {
  id: number;
  operations?: boolean;
  json?: boolean;
  config?: string;
}

export const GetCommand: CommandModule<object, GetOptions> = {
  command: "get <id>",
  aliases: ["show"],
  describe: "获取任务详情",
  
  builder: (yargs) =>
    yargs
      .positional("id", {
        type: "number",
        describe: "任务 ID",
        demandOption: true,
      })
      .option("operations", {
        alias: "o",
        type: "boolean",
        default: false,
        description: "包含操作记录",
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
      const taskComponent = env.getComponent("task") as TaskComponent | undefined;

      if (!taskComponent) {
        output.error("TaskComponent not available");
        process.exit(1);
      }

      if (args.operations) {
        const result = await taskComponent.getTaskWithOperations(args.id);
        if (!result) {
          output.error(`Task not found: ${args.id}`);
          process.exit(1);
        }
        
        if (args.json) {
          output.json(result);
        } else {
          output.log(chalk.bold(`\nTask #${result.id}: ${result.title}\n`));
          output.log(`Status: ${chalk.blue(result.status)} | Priority: ${result.priority} | Type: ${result.type} | Progress: ${result.progress}%`);
          output.log(`Created: ${result.createdAt} | Updated: ${result.updatedAt}`);
          output.log(`Project Path: ${result.project_path}`);
          output.log(`Context: ${result.context}`);
          if (result.current_status) {
            output.log(`\nCurrent Status: ${result.current_status}`);
          }
          
          output.log(chalk.bold(`\nOperations (${result.operations.length}):\n`));
          result.operations.forEach((op: TaskOperation, i: number) => {
            const actionColor = op.milestoneType === "completed" ? chalk.green :
                               op.milestoneType === "milestone" ? chalk.blue :
                               op.milestoneType === "problem" ? chalk.red :
                               chalk.gray;
            // 双维度渲染：状态/里程碑 vs 过程
            output.log(`  ${i + 1}. ` + actionColor(`[${op.milestoneType}]`) + ` ${op.milestoneTitle}`);
            output.log(`     Session: ${op.sessionId} | Time: ${op.timestamp}`);
            if (op.milestoneDescription) {
              output.log(`     ${op.milestoneDescription}`);
            }
            if (op.processDescription) {
              output.log(chalk.gray(`     📋 过程概要: ${op.processDescription}`));
            }
          });
        }
      } else {
        const task: Task | undefined = await taskComponent.getTask(args.id);
        if (!task) {
          output.error(`Task not found: ${args.id}`);
          process.exit(1);
        }
        
        if (args.json) {
          output.json(task);
        } else {
          output.log(chalk.bold(`\nTask #${task.id}: ${task.title}\n`));
          output.log(`Status: ${chalk.blue(task.status)} | Priority: ${task.priority} | Type: ${task.type} | Progress: ${task.progress}%`);
          output.log(`Created: ${task.createdAt} | Updated: ${task.updatedAt}`);
          output.log(`Project Path: ${task.project_path}`);
          output.log(`Context: ${task.context}`);
          if (task.current_status) {
            output.log(`\nCurrent Status: ${task.current_status}`);
          }
          if (task.description) {
            output.log(`\nDescription: ${task.description}`);
          }
        }
      }
    } catch (error) {
      output.error(`Failed to get task: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
