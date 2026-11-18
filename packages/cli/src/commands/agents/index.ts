/**
 * @fileoverview Agents Command Entry
 * 
 * 命令入口：roy-bot agents [action]
 */

import { CommandModule } from "yargs";
import { ListCommand } from "./list";
import { GetCommand } from "./get";
import { AddCommand } from "./add";
import { DeleteCommand } from "./delete";
import { ConfigDirCommand } from "./config-dir";

/**
 * Agents Command
 * 
 * Agent 管理命令，提供以下子命令：
 * - list: 列出所有 agents
 * - get: 获取指定 agent 的详细信息
 */
export const AgentsCommand: CommandModule = {
  command: "agents",
  aliases: ["agent"],
  describe: "Agent 管理 - 列出、获取、添加、删除 agent 配置",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(GetCommand)
      .command(AddCommand)
      .command(DeleteCommand)
      .command(ConfigDirCommand)
      .demandCommand()
      .help(),
  handler: () => {
    console.log("Use 'roy-bot agents --help' for usage information");
  },
};
