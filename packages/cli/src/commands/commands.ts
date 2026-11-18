/**
 * @fileoverview Commands Command
 * 
 * 命令库管理 - CLI 主命令
 * 
 * 功能：
 * - 列出收藏命令（roy commands list）
 * - 添加命令（roy commands add）
 * - 移除命令（roy commands remove）
 * - 显示命令详情（roy commands info）
 * - 显示命令目录（roy commands dirs）
 */

import { CommandModule } from "yargs";
import { CommandsListCommand } from "./commands-list";
import { CommandsAddCommand } from "./commands-add";
import { CommandsRemoveCommand } from "./commands-remove";
import { CommandsInfoCommand } from "./commands-info";
import { CommandsDirsCommand } from "./commands-dirs";

export interface CommandsOptions {
  command?: string;
}

/**
 * CommandsCommand - 命令库管理
 */
export const CommandsCommand: CommandModule<object, CommandsOptions> = {
  command: "commands",
  describe: "命令库管理 - 收藏、查询常用命令",

  builder: (yargs) =>
    yargs
      .command(CommandsListCommand)
      .command(CommandsAddCommand)
      .command(CommandsRemoveCommand)
      .command(CommandsInfoCommand)
      .command(CommandsDirsCommand)
      .demandCommand(1, "请指定子命令：list、add、remove、info、dirs")
      .help()
      .strict(),

  handler() {
    // 默认显示帮助（由 yargs demandCommand 处理）
  },
};

// 导出子命令
export {
  CommandsListCommand,
  CommandsAddCommand,
  CommandsRemoveCommand,
  CommandsInfoCommand,
  CommandsDirsCommand,
};
