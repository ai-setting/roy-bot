/**
 * @fileoverview Sessions Grep Command
 * 
 * 命令：roy-bot sessions grep <query>
 * 
 * 在所有会话消息中进行全文搜索，支持：
 * - 多关键字搜索 (AND/OR/NOT)
 * - 按会话过滤
 * - 按时间范围过滤
 * - 结果以 session 为单位聚合展示
 * - --quiet 安静模式
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import { type SessionComponent, type SearchMessagesOptions } from "@ai-setting/roy-bot-core";
import { CliQuietModeService } from "../../services/quiet-mode.service";

export const GrepCommand: CommandModule<object, object> = {
  command: "grep <query...>",
  aliases: ["search"],
  describe: "搜索会话消息（全文搜索）",

  builder: (yargs) =>
    yargs
      .positional("query", {
        describe: "搜索关键词（支持 AND/OR/NOT）",
        type: "string",
        demandOption: true,
      })
      .option("session", {
        alias: "s",
        type: "string",
        description: "限制搜索特定会话 ID",
      })
      .option("limit", {
        alias: "n",
        type: "number",
        default: 50,
        description: "最大返回结果数",
      })
      .option("before", {
        alias: "b",
        type: "number",
        description: "搜索此时间之前的消息（Unix timestamp 或天数）",
      })
      .option("after", {
        alias: "a",
        type: "number",
        description: "搜索此时间之后的消息（Unix timestamp 或天数）",
      })
      .option("json", {
        alias: "j",
        type: "boolean",
        default: false,
        description: "JSON 格式输出",
      })
      .option("quiet", {
        alias: "q",
        type: "boolean",
        default: false,
        description: "简洁输出",
      }),

  async handler(args) {
    // 强制类型转换以处理 yargs 的类型推断问题
    const a = args as any;
    
    // 在任何日志输出之前设置 quiet 模式
    const isQuiet = a.quiet === true;
    if (isQuiet) {
      CliQuietModeService.getInstance().setQuiet(true);
    }

    const output = new OutputService();
    output.configure({ quiet: isQuiet });
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ 
        configPath: a.config,
      });
      const env = envService.getEnvironment();
      if (!env) {
        output.error("Failed to create environment");
        process.exit(1);
      }
      const sessionComponent = env.getComponent("session") as SessionComponent;

      if (!sessionComponent) {
        output.error("SessionComponent not available");
        process.exit(1);
      }

      // 转换相对时间为绝对时间戳
      const now = Date.now();
      let beforeTime: number | undefined;
      let afterTime: number | undefined;

      if (a.before !== undefined) {
        // 如果是小于 1e12，视为天数
        beforeTime = a.before < 1e12 
          ? now - a.before * 24 * 60 * 60 * 1000 
          : a.before;
      }

      if (a.after !== undefined) {
        afterTime = a.after < 1e12 
          ? now - a.after * 24 * 60 * 60 * 1000 
          : a.after;
      }

      // query 是 string[]，合并为字符串
      const query = Array.isArray(a.query) ? a.query.join(" ") : a.query ?? "";

      const searchOptions: SearchMessagesOptions = {
        query,
        sessionId: a.session,
        limit: a.limit,
        beforeTime,
        afterTime,
      };

      // 执行搜索
      const results = await sessionComponent.searchMessages(searchOptions);

      if (results.length === 0) {
        if (!a.quiet) {
          output.log(chalk.yellow(`No results found for: ${query}`));
        }
        return;
      }

      if (a.json) {
        // JSON 格式输出
        output.json({
          query,
          totalMatches: results.reduce((sum, r) => sum + r.matches.length, 0),
          sessionCount: results.length,
          results: results.map((r) => ({
            sessionId: r.sessionId,
            sessionTitle: r.sessionTitle,
            messageCount: r.messageCount,
            matches: r.matches.map((m) => ({
              messageId: m.messageId,
              role: m.role,
              content: m.content,
              timestamp: new Date(m.timestamp).toISOString(),
              contextBefore: m.contextBefore,
              contextAfter: m.contextAfter,
            })),
          })),
        });
      } else if (a.quiet) {
        // 简洁输出：只显示匹配的消息
        for (const result of results) {
          for (const match of result.matches) {
            const time = new Date(match.timestamp).toLocaleString("zh-CN");
            output.log(`${chalk.gray(result.sessionId)} ${chalk.blue(result.sessionTitle)} ${chalk.gray(time)}`);
            output.log(`  ${match.content}`);
            output.log("");
          }
        }
      } else {
        // 格式化输出：以 session 为单位聚合
        let totalMatches = 0;
        
        for (let ri = 0; ri < results.length; ri++) {
          const result = results[ri];
          totalMatches += result.matches.length;
          
          // Session 头部
          const time = new Date(result.updatedAt).toLocaleString("zh-CN");
          const titleStr = `─ ${result.sessionTitle} (${result.sessionId})`;
          output.log(chalk.bold(`\n┌${titleStr}${"─".repeat(Math.max(0, 50 - titleStr.length))}┐`));
          output.log(`│ ${chalk.gray(`Updated: ${time} | ${result.messageCount} messages | ${result.matches.length} matches`)}${" ".repeat(Math.max(0, 50 - 60))}│`);

          // 每条匹配的消息
          for (let i = 0; i < result.matches.length; i++) {
            const match = result.matches[i];
            const roleColor = match.role === "user" ? chalk.blue 
              : match.role === "assistant" ? chalk.green 
              : chalk.gray;
            const msgTime = new Date(match.timestamp).toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            });

            output.log(`├─ #${i + 1} ${roleColor(match.role.padEnd(10))} ${chalk.gray(msgTime)}`);
            output.log("│");

            // 消息内容（限制行数，过滤空行）
            const lines = match.content
              .split("\n")
              .map(line => line.trim())  // 去除每行首尾空白
              .filter(line => line.length > 0);  // 过滤空行
            
            const maxLines = 5;
            const displayLines = lines.slice(0, maxLines);
            
            if (displayLines.length === 0) {
              output.log("│   " + chalk.gray("(empty content)"));
            } else {
              for (const line of displayLines) {
                const truncated = line.length > 76 ? line.slice(0, 73) + "..." : line;
                output.log(`│   ${chalk.gray(truncated)}`);
              }
            }
            
            if (lines.length > maxLines) {
              output.log("│   " + chalk.gray(`... (${lines.length - maxLines} more lines)`));
            }
            output.log("│");
          }
          
          // Session 底部
          output.log(`└${"─".repeat(52)}┘`);
        }

        // 统计信息
        output.log(`\n${chalk.green("✓")} Found ${chalk.bold(totalMatches.toString())} matches in ${chalk.bold(results.length.toString())} sessions`);
        output.log(chalk.gray(`Query: "${query}"`));
      }
    } catch (error) {
      output.error(`Search failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
