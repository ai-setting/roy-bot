/**
 * @fileoverview Prompt Command Entry
 * 
 * 命令入口：roy-bot prompt [action]
 */

import { CommandModule } from "yargs";
import { ListCommand } from "./list";
import { GetCommand } from "./get";
import { AddCommand } from "./add";
import { ConfigDirCommand } from "./config-dir";

/**
 * Prompt Command
 * 
 * Prompt 管理命令，提供以下子命令：
 * - list: 列出所有 prompts
 * - get: 获取指定 prompt 的内容
 */
export const PromptCommand: CommandModule = {
  command: "prompt",
  describe: "Prompt 管理 - 列出、获取、添加 prompt",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(GetCommand)
      .command(AddCommand)
      .command(ConfigDirCommand)
      .demandCommand()
      .help(),
  handler: () => {
    console.log("Use 'roy-bot prompt --help' for usage information");
  },
};
