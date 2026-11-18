/**
 * @fileoverview Config Command - 配置管理主入口
 */

import { CommandModule } from "yargs";
import { ConfigListCommand } from "./list";
import { ConfigExportCommand } from "./export";
import { ConfigImportCommand } from "./import";

/**
 * ConfigCommand - 配置管理命令
 */
export const ConfigCommand: CommandModule = {
  command: "config",
  describe: "配置管理 - 查看、导出、导入配置",
  aliases: ["cfg"],

  builder: (yargs) =>
    yargs
      .command(ConfigListCommand)
      .command(ConfigExportCommand)
      .command(ConfigImportCommand)
      .demandCommand()
      .help(),

  handler: () => {
    // 默认显示帮助（由 yargs demandCommand 处理）
  },
};

// 导出子命令
export { ConfigListCommand } from "./list";
export { ConfigExportCommand } from "./export";
export { ConfigImportCommand } from "./import";
export * from "./types";
