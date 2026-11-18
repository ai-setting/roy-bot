/**
 * @fileoverview MCP Commands
 * 
 * 命令组：roy mcp
 */

import { CommandModule } from "yargs";
import { ListCommand } from "./list";
import { ToolsCommand } from "./tools";
import { ReloadCommand } from "./reload";

export const McpCommand: CommandModule<object, {}> = {
  command: "mcp",
  describe: "MCP 服务器管理",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(ToolsCommand)
      .command(ReloadCommand)
      .demandCommand(1, "请指定一个子命令")
      .help(),
  handler: () => {}, // Required but never called since subcommands handle themselves
};

export { ListCommand } from "./list";
export { ToolsCommand } from "./tools";
export { ReloadCommand } from "./reload";
