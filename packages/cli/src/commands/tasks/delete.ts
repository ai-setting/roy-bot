/**
 * @fileoverview Tasks Delete Command
 * 
 * 命令：roy-bot tasks delete <task-id>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { TaskComponent, Task } from "@ai-setting/roy-bot-core";

interface DeleteOptions {
  id: number;
  force?: boolean;
  config?: string;
}

export const DeleteCommand: CommandModule<object, DeleteOptions> = {
  command: "delete <id>",
  aliases: ["remove", "rm", "del"],
  describe: "删除任务",
  
  builder: (yargs) =>
    yargs
      .positional("id", {
        type: "number",
        describe: "任务 ID",
        demandOption: true,
      })
      .option("force", { 
        alias: "f", 
        type: "boolean", 
        default: false, 
        description: "强制删除，不确认" 
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

      // Check if task exists
      const task: Task | undefined = await taskComponent.getTask(args.id);
      if (!task) {
        output.error(`Task not found: ${args.id}`);
        process.exit(1);
      }

      if (!args.force) {
        output.log(chalk.yellow(`Are you sure you want to delete task #${args.id}?`));
        output.log(chalk.yellow(`  Title: ${task.title}`));
        output.log(chalk.yellow(`  Status: ${task.status}`));
        output.log(chalk.yellow(`\nUse --force to skip this confirmation`));
        process.exit(1);
      }

      const deleted = await taskComponent.deleteTask(args.id);
      
      if (deleted) {
        output.log(chalk.green(`\n✓ Task deleted: #${args.id}`));
      } else {
        output.error(`Failed to delete task: ${args.id}`);
        process.exit(1);
      }
    } catch (error) {
      output.error(`Failed to delete task: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
