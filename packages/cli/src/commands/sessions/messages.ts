/**
 * @fileoverview Sessions Messages Command
 * 
 * 命令：roy-bot sessions messages <session-id>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SessionComponent, Session, SessionMessage } from "@ai-setting/roy-bot-core";
import {
  formatMessageContent,
  formatCheckpointContent,
} from "./format-message-content";

/** Outer content line cap (per message) */
const MAX_CONTENT_LINES = 20;

export const MessagesCommand: CommandModule<object, object> = {
  command: "messages <session-id>",
  aliases: ["msgs"],
  describe: "查看会话消息",

  builder: (yargs) =>
    yargs
      .positional("session-id", {
        describe: "会话 ID",
        type: "string",
        demandOption: true,
      })
      .option("limit", { alias: "n", type: "number", demandOption: true, describe: "返回消息数量" })
      .option("offset", { alias: "o", type: "number", demandOption: true, describe: "起始偏移量" })
      .option("reverse", { alias: "r", type: "boolean", default: false })
      .option("json", { alias: "j", type: "boolean", default: false })
      .option("detail", {
        type: "boolean",
        default: false,
        describe: "显示完整消息内容（不截断）",
      }),

  async handler(args) {
    const a = args as any;
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: a.config });
      const env = envService.getEnvironment();
      if (!env) {
        output.error("Failed to create environment");
        process.exit(1);
      }
      const sessionComponent = env.getComponent("session") as SessionComponent | undefined;

      if (!sessionComponent) {
        output.error("SessionComponent not available");
        process.exit(1);
      }

      const session: Session | undefined = await sessionComponent.get(a.sessionId);
      if (!session) {
        output.error(`Session not found: ${a.sessionId}`);
        process.exit(1);
      }

      // 并行获取消息和总数
      const [messages, totalMessages] = await Promise.all([
        sessionComponent.getMessages(a.sessionId, {
          offset: a.offset,
          limit: a.limit,
        }),
        sessionComponent.getMessageCount(a.sessionId),
      ]);

      if (a.reverse) {
        messages.reverse();
      }

      if (a.json) {
        output.json({
          total: totalMessages,
          sessionId: a.sessionId,
          pagination: {
            offset: a.offset,
            limit: a.limit,
            hasMore: a.offset + a.limit < totalMessages,
          },
          messages: messages.map((m: SessionMessage) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            parts: m.parts, // 包含结构化 parts 信息
            timestamp: new Date(m.timestamp).toISOString(),
            isCheckpoint: m.metadata?.isCheckpoint,
          })),
        });
      } else {
        const detail = a.detail === true;

        const roleColors: Record<string, (text: string) => string> = {
          user: chalk.blue,
          assistant: chalk.green,
          system: chalk.gray,
          tool: chalk.yellow,
        };

        output.log(chalk.bold(`┌─ Messages (${a.sessionId}) ────────────────────────┐`));

        messages.forEach((m: SessionMessage, i: number) => {
          const roleColor = roleColors[m.role] || chalk.white;
          const time = new Date(m.timestamp).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          });

          if (m.metadata?.isCheckpoint) {
            // Checkpoint 消息特殊样式
            output.log(chalk.cyan("├─ #" + (a.offset + i + 1) + "  checkpoint") + "  " + chalk.gray(time));
            output.log("│");
            const checkpointContent = formatCheckpointContent(m.content, { detail });
            output.log("│ " + checkpointContent.split("\n").join("\n│ "));
            output.log("│");
          } else {
            output.log(chalk.cyan("├─ #" + (a.offset + i + 1) + "  ") + roleColor(m.role.padEnd(10)) + "  " + chalk.gray(time));

            // 使用 format-message-content.ts 的纯函数，支持 --detail
            const rawLines = formatMessageContent(m, { detail });
            // 给不同 part 类型加颜色（chalk 染色保持在 CLI 层）
            const contentLines = colorizeContentLines(rawLines, m);

            // 整体行数限制 (MAX_CONTENT_LINES = 20)，detail=true 时跳过
            const finalLines = detail ? contentLines : contentLines.slice(0, MAX_CONTENT_LINES);
            for (const line of finalLines) {
              output.log("│ " + line);
            }
            if (!detail && contentLines.length > MAX_CONTENT_LINES) {
              output.log("│ " + chalk.gray(`... (truncated, total ${contentLines.length} lines)`));
            }
            output.log("│");
          }
        });

        output.log("└" + "─".repeat(51) + "┘");
        // 显示分页信息和总数
        const hasMore = a.offset + a.limit < totalMessages;
        const showingEnd = Math.min(a.offset + a.limit, totalMessages);

        output.log(chalk.gray(
          `Showing ${a.offset + 1}-${showingEnd} of ${totalMessages} messages` +
          (hasMore ? " (more available)" : "")
        ));
      }
    } catch (error) {
      output.error(`Failed to get messages: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};

/**
 * 给 formatMessageContent 返回的纯文本行加上 chalk 颜色
 *
 * 设计：纯字符串无法识别 part 来源，靠模式匹配推断行类型。
 * 这种实现简单但脆弱（依赖前缀）；如果未来需要更精确控制，
 * 建议把 formatMessageContent 改为返回带 kind 标签的 { kind, text }[] 结构。
 */
function colorizeContentLines(lines: string[], _m: SessionMessage): string[] {
  return lines.map((line) => {
    // Header 行（part 标题）
    if (line.startsWith("[Tool Call]")) return chalk.cyan(line);
    if (line.startsWith("[Tool Result]")) return chalk.yellow(line);
    if (line === "[Reasoning]") return chalk.magenta(line);
    if (line === "[Checkpoint]") return chalk.cyan(line);
    if (line.startsWith("[Node Call]")) return chalk.blue(line);
    if (line.startsWith("[Node Interrupt]")) return chalk.yellow(line);
    if (line.startsWith("[Node Resume]")) return chalk.green(line);
    if (line.startsWith("[Node Start]")) return chalk.blue(line);
    if (line.startsWith("✅") || line.startsWith("❌")) {
      // Node Result / Node End
      if (line.includes("[Node Result]")) return chalk.green(line);
      if (line.includes("[Node End]")) return chalk.green(line);
      return line;
    }
    // 缩进的子内容（tool args、workflow output、error 等）
    if (line.startsWith("  ")) {
      if (line.startsWith("  Error:")) return chalk.red(line);
      if (line.startsWith("  Query:")) return chalk.bold(line);
      if (line.startsWith("  Options:") || line.startsWith("  agentSessionId:") || line.startsWith("  Duration:"))
        return chalk.gray(line);
      // 工具调用/结果的参数/输出/工作流输出默认灰色
      return chalk.gray(line);
    }
    // 工具调用 args/result 没有缩进的情况（短内容时也不缩进）
    // 通过 _m.parts 中 part 类型判断更准确，但简单起见：所有非 header、非缩进行保持原样
    return line;
  });
}
