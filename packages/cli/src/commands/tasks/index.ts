/**
 * @fileoverview Tasks Command Entry
 *
 * 命令入口：roy-bot tasks [action]
 */

import { CommandModule } from "yargs";
import { ListCommand } from "./list";
import { GetCommand } from "./get";
import { CreateCommand } from "./create";
import { UpdateCommand } from "./update";
import { DeleteCommand } from "./delete";
import { CompleteCommand } from "./complete";
import { OperationsCommand } from "./operations";
import { TreeCommand } from "./tree";
import { SearchCommand } from "./search";
import { command as organizeCommand, desc as organizeDesc, builder as organizeBuilder, handler as organizeHandler } from "./organize";

const OrganizeCommand: CommandModule = {
  command: organizeCommand,
  describe: organizeDesc,
  builder: organizeBuilder as any,
  handler: organizeHandler as any,
};

/**
 * Tasks Command
 *
 * 任务管理命令，提供以下子命令：
 * - list: 列出所有任务
 * - search: 关键词搜索任务
 * - tree: 以树形结构展示所有任务（基于 parent_task_id）
 * - get: 获取任务详情
 * - create: 创建任务
 * - update: 更新任务
 * - delete: 删除任务
 * - complete: 完成任务
 * - operations: 操作记录管理
 * - organize: 整理任务（清理测试/聚合相似/构建树）
 */
export const TasksCommand: CommandModule = {
  command: "tasks",
  describe: "任务管理 - 创建、追踪、管理任务",
  builder: (yargs) =>
    yargs
      // 传递全局 plugin 选项到子命令
      .option("plugin", {
        alias: "p",
        type: "string",
        array: true,
        description: "Enable plugin (e.g., --plugin task-tag)",
        global: false,  // 不再是 global，避免重复
      })
      .command(ListCommand)
      .command(SearchCommand)
      .command(TreeCommand)
      .command(GetCommand)
      .command(CreateCommand)
      .command(UpdateCommand)
      .command(DeleteCommand)
      .command(CompleteCommand)
      .command(OperationsCommand)
      .command(OrganizeCommand)
      .demandCommand()
      .help(),
  handler: () => {
    console.log("Use 'roy-bot tasks --help' for usage information");
  },
};
