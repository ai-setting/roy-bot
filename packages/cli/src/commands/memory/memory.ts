/**
 * @fileoverview Memory Command - Simplified
 * 
 * 命令：roy-bot memory
 * 
 * Simplified 设计：只保留 record 和 recall 命令
 */

import { CommandModule } from "yargs";
import { RecordCommand } from "./record";
import { RecallCommand } from "./recall";

export const MemoryCommand: CommandModule = {
  command: "memory",
  describe: "管理记忆文件 (record, recall)",
  builder: (yargs) =>
    yargs
      .command(RecordCommand)
      .command(RecallCommand)
      .demandCommand(1, "请指定子命令。可用子命令: record, recall"),
  
  handler: () => {
    // 默认显示帮助
  },
};
