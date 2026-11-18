/**
 * @fileoverview Commands List Command
 * 
 * 列出收藏的命令
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../services/environment.service";
import { OutputService } from "../services/output.service";
import chalk from "chalk";
import type { CommandsComponent } from "@ai-setting/roy-bot-core";
import {
  applyPagination,
  renderPaginationFooter,
  renderQuietHeader,
  renderQuietLine,
  renderQuietPaginationHint,
  PAGINATION_OPTIONS,
} from "./shared/list-output";
import type { ListPaginationArgs } from "./shared/list-output";

export interface CommandsListOptions {
  pattern?: string;
  json?: boolean;
  config?: string;
  limit?: number;
  offset?: number;
}

interface CommandRow {
  name: string;
  path: string;
  source: string;
  description: string;
}

/**
 * 计算字符串的视觉宽度（中文字符占2格）
 */
function visualWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    if (char.charCodeAt(0) > 255) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * 按视觉宽度截断字符串
 */
function truncateVisual(str: string, maxWidth: number): string {
  let result = "";
  let width = 0;
  for (const char of str) {
    const charWidth = char.charCodeAt(0) > 255 ? 2 : 1;
    if (width + charWidth > maxWidth) break;
    result += char;
    width += charWidth;
  }
  return result;
}

/**
 * 格式化命令表格
 */
function formatCommandsTable(commands: CommandRow[]): string {
  if (commands.length === 0) {
    return chalk.yellow("命令目录为空，使用 'roy-bot commands add' 添加命令");
  }

  const NAME_WIDTH = 20;
  const SOURCE_WIDTH = 10;
  const DESC_WIDTH = 50;
  const GAP = "  ";

  const headerLine = [
    chalk.bold("NAME".padEnd(NAME_WIDTH)),
    chalk.bold("SOURCE".padEnd(SOURCE_WIDTH)),
    chalk.bold("DESCRIPTION"),
  ].join(GAP);

  const sepLine = "─".repeat(NAME_WIDTH + SOURCE_WIDTH + DESC_WIDTH + GAP.length * 2);

  const formatRow = (cmd: CommandRow): string => {
    const name = truncateVisual(cmd.name, NAME_WIDTH).padEnd(NAME_WIDTH);
    const source = cmd.source.padEnd(SOURCE_WIDTH);
    const desc = truncateVisual(cmd.description || "-", DESC_WIDTH);
    return `${name}${GAP}${source}${GAP}${desc}`;
  };

  const rows = commands.map(formatRow);
  return [headerLine, sepLine, ...rows].join("\n");
}

export const CommandsListCommand: CommandModule<object, CommandsListOptions> = {
  command: "list [pattern]",
  describe: "列出收藏的命令（支持 glob 过滤）",

  builder: (yargs) =>
    yargs
      .positional("pattern", {
        describe: "glob 过滤模式",
        type: "string",
      })
      .option("json", {
        alias: "j",
        describe: "JSON 格式输出",
        type: "boolean",
        default: false,
      })
      .option("limit", PAGINATION_OPTIONS.limit)
      .option("offset", PAGINATION_OPTIONS.offset)
      // 使用全局 --quiet / --no-quiet（默认简洁输出）
      .option("quiet", { alias: "q", type: "boolean", hidden: true })
      .option("config", {
        describe: "配置文件路径",
        type: "string",
      }),

  async handler(args) {
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: args.config });
      const env = envService.getEnvironment();
      if (!env) {
        output.error("Failed to create environment");
        process.exit(1);
      }
      const commandsComponent = env.getComponent("commands") as CommandsComponent | undefined;

      if (!commandsComponent) {
        output.error("CommandsComponent not available");
        process.exit(1);
      }

      const result = await commandsComponent.discover({ pattern: args.pattern });
      const total = result.commands.length;

      // 应用分页（CLI 层截断）
      const page: ListPaginationArgs = {
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
      };
      const commands = applyPagination(result.commands, page);

      if (args.json) {
        output.json({
          // 统一 JSON 结构：total FIRST, commands LAST
          total,
          count: commands.length,
          truncated: total > commands.length,
          limit: page.limit,
          offset: page.offset,
          pattern: args.pattern ?? null,
          stats: result.stats,
          commands: commands.map((cmd) => ({
            name: cmd.name,
            path: cmd.path,
            source: cmd.source,
            description: cmd.shortDescription,
          })),
        });
      } else if (args.quiet) {
        // quiet 模式：# Total: N + 每行 "<id>\t<name>" + 分页提示
        output.log(renderQuietHeader(total, "command"));
        commands.forEach((cmd) =>
          output.log(renderQuietLine(cmd.name, cmd.name))
        );
        const hint = renderQuietPaginationHint({
          count: commands.length,
          total,
          offset: page.offset,
          limit: page.limit,
        });
        if (hint) output.log(hint);
      } else {
        const rows: CommandRow[] = commands.map((cmd) => ({
          name: cmd.name,
          path: cmd.path,
          source: cmd.source === "user" ? "USER" : "PROJECT",
          description: cmd.shortDescription || "-",
        }));

        output.log(formatCommandsTable(rows));
        output.info("");
        output.log(renderPaginationFooter({
          total,
          count: commands.length,
          offset: page.offset,
          limit: page.limit,
          itemName: "command",
          extras: [
            `user:${result.stats.userCount}`,
            `project:${result.stats.projectCount}`,
          ],
        }));
      }
    } catch (error) {
      output.error(`Failed to list commands: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
