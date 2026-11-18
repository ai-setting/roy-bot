/**
 * @fileoverview Skills Command Entry
 * 
 * 命令入口：roy-bot skills [action]
 */

import { CommandModule } from "yargs";
import { ListCommand } from "./list";
import { GetCommand } from "./get";
import { SearchCommand } from "./search";
import { ReloadCommand } from "./reload";
import { ShowConfigCommand } from "./show-config";

/**
 * Skills Command
 * 
 * 技能管理命令，提供以下子命令：
 * - list: 列出所有技能
 * - get: 获取指定技能内容
 * - search: 搜索技能
 * - reload: 重新加载技能
 * - show-config: 显示配置信息
 */
export const SkillsCommand: CommandModule = {
  command: "skills",
  describe: "技能管理 - 列出、获取、搜索、重新加载技能",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(GetCommand)
      .command(SearchCommand)
      .command(ReloadCommand)
      .command(ShowConfigCommand)
      .demandCommand()
      .help(),
  handler: () => {
    console.log("Use 'roy-bot skills --help' for usage information");
  },
};
