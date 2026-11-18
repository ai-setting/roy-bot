/**
 * @fileoverview Debug Commands Entry
 * 
 * Command: roy debug [log|trace|span]
 * 
 * 提供调试能力：
 * - log: 查看日志文件（支持 --tail -n）
 * - trace: 以 tree 方式查看 trace 的 spans，或用 --list [--limit N] 列出最近的 trace
 * - span: 通过 spanId 查询详细的 span 信息
 */

import type { CommandModule } from "yargs";
import { LogCommand } from "./log";
import { TraceCommand } from "./trace";
import { SpanCommand } from "./span";

/**
 * Debug Command
 */
export const DebugCommand: CommandModule = {
  command: "debug",
  describe: "调试工具 - 日志查看、trace 分析、span 查询",
  builder: (yargs) =>
    yargs
      .command(LogCommand)
      .command(TraceCommand)
      .command(SpanCommand)
      .demandCommand()
      .help(),
  handler: () => {
    // Default handler - will show help
  },
};

// Export subcommands for testing
export { LogCommand } from "./log";
export { TraceCommand } from "./trace";
export { SpanCommand } from "./span";
