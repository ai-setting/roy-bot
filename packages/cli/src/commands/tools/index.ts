/**
 * @fileoverview Tools Command Entry
 * 
 * 命令入口：roy tools [action]
 */

import { CommandModule } from "yargs";
import { ListCommand } from "./list";
import { GetCommand } from "./get";
import { ExecToolCommand } from "./exec-tool";

/**
 * Tools Command
 * 
 * 工具管理命令，提供以下子命令：
 * - list: 列出所有工具
 * - get: 获取工具详情
 * - exec-tool: 执行工具
 */
export const ToolsCommand: CommandModule = {
  command: "tools",
  describe: "工具管理 - 列出、获取、执行内置工具",

  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(GetCommand)
      .command(ExecToolCommand)
      .demandCommand()
      .help(),

  handler: () => {
    console.log("Use 'roy-bot tools --help' for usage information");
  },
};
