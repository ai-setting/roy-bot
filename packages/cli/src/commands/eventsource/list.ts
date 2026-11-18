/**
 * @fileoverview EventSource List Command
 * 
 * 列出所有已配置的事件源
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk, { ChalkInstance } from "chalk";
import type { EventSourceComponentInterface, EventSourceConfig } from "@ai-setting/roy-bot-core";
import {
  applyPagination,
  renderPaginationFooter,
  renderQuietHeader,
  renderQuietLine,
  renderQuietPaginationHint,
  PAGINATION_OPTIONS,
} from "../shared/list-output";
import type { ListPaginationArgs } from "../shared/list-output";

export interface EventSourceListOptions {
  json?: boolean;
  quiet?: boolean;
  config?: string;
  limit?: number;
  offset?: number;
}

interface SourceRow {
  id: string;
  name: string;
  type: string;
  status: string;
  enabled: string;
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
 * 格式化事件源表格
 */
function formatSourcesTable(sources: SourceRow[]): string {
  if (sources.length === 0) {
    return chalk.yellow("没有配置的事件源，使用 'roy-bot eventsource add' 添加");
  }

  const ID_WIDTH = 10;
  const NAME_WIDTH = 20;
  const TYPE_WIDTH = 12;
  const STATUS_WIDTH = 10;
  const ENABLED_WIDTH = 8;
  const GAP = "  ";

  const headerLine = [
    chalk.bold("ID".padEnd(ID_WIDTH)),
    chalk.bold("NAME".padEnd(NAME_WIDTH)),
    chalk.bold("TYPE".padEnd(TYPE_WIDTH)),
    chalk.bold("STATUS".padEnd(STATUS_WIDTH)),
    chalk.bold("ENABLED".padEnd(ENABLED_WIDTH)),
  ].join(GAP);

  const sepLine = "─".repeat(ID_WIDTH + NAME_WIDTH + TYPE_WIDTH + STATUS_WIDTH + ENABLED_WIDTH + GAP.length * 4);

  const formatRow = (src: SourceRow): string => {
    const id = truncateVisual(src.id, ID_WIDTH).padEnd(ID_WIDTH);
    const name = truncateVisual(src.name, NAME_WIDTH).padEnd(NAME_WIDTH);
    const type = truncateVisual(src.type, TYPE_WIDTH).padEnd(TYPE_WIDTH);
    const status = truncateVisual(src.status, STATUS_WIDTH).padEnd(STATUS_WIDTH);
    const enabled = src.enabled.padEnd(ENABLED_WIDTH);
    return `${id}${GAP}${name}${GAP}${type}${GAP}${status}${GAP}${enabled}`;
  };

  const rows = sources.map(formatRow);
  return [headerLine, sepLine, ...rows].join("\n");
}

export const EventSourceListCommand: CommandModule<object, EventSourceListOptions> = {
  command: "list",
  aliases: ["ls"],
  describe: "列出所有事件源",

  builder: (yargs) =>
    yargs
      .option("json", {
        alias: "j",
        describe: "JSON 格式输出",
        type: "boolean",
        default: false,
      })
      .option("limit", PAGINATION_OPTIONS.limit)
      .option("offset", PAGINATION_OPTIONS.offset)
      // 使用全局 --quiet / --no-quiet（默认简洁输出）
      .option("quiet", { alias: "q", type: "boolean", hidden: true }),

  async handler(args) {
    const output = new OutputService();
    // Note: 全局 quiet 已在 cli.ts middleware 中通过 CliQuietModeService 设置，
    // 这里不需要再 output.configure({ quiet })。
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: args.config });
      const env = envService.getEnvironment();
      if (!env) {
        output.error("Failed to create environment");
        process.exit(1);
      }
      
      const esComponent = env.getComponent("event-source") as unknown as EventSourceComponentInterface | undefined;

      if (!esComponent) {
        output.error("EventSourceComponent not available");
        process.exit(1);
      }

      const allSources = esComponent.list() ?? [];
      const total = allSources.length;

      // 应用分页（CLI 层截断）
      const page: ListPaginationArgs = {
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
      };
      const sources = applyPagination(allSources, page);

      if (total === 0) {
        if (args.json) {
          output.json({
            // 统一 JSON 结构：total FIRST, sources LAST
            total: 0,
            count: 0,
            truncated: false,
            limit: page.limit,
            offset: page.offset,
            sources: [],
          });
        } else {
          output.log(chalk.yellow("没有配置的事件源，使用 'roy-bot eventsource add' 添加"));
        }
        return;
      }

      // 给 sources 加上 status 字段
      const sourcesWithStatus = sources.map((s) => ({
        ...s,
        status: esComponent.getStatus(s.id) || "unknown",
      }));

      if (args.json) {
        output.json({
          // 统一 JSON 结构：total FIRST, sources LAST
          total,
          count: sourcesWithStatus.length,
          truncated: total > sourcesWithStatus.length,
          limit: page.limit,
          offset: page.offset,
          sources: sourcesWithStatus,
        });
        return;
      }

      if (args.quiet) {
        // quiet 模式：# Total: N + 每行 "<id>\t<name>" (eventsource 有独立 id) + 分页提示
        output.log(renderQuietHeader(total, "event source"));
        sources.forEach((s) =>
          output.log(renderQuietLine(s.id, s.name))
        );
        const hint = renderQuietPaginationHint({
          count: sources.length,
          total,
          offset: page.offset,
          limit: page.limit,
        });
        if (hint) output.log(hint);
        return;
      }

      // 表格输出
      const rows: SourceRow[] = sources.map((s) => {
        const status = esComponent.getStatus(s.id) || "unknown";
        const statusColorMap: Record<string, ChalkInstance> = {
          running: chalk.green,
          stopped: chalk.gray,
          error: chalk.red,
          starting: chalk.yellow,
          created: chalk.gray,
          stopping: chalk.yellow,
          unknown: chalk.gray,
        };
        const statusColor = statusColorMap[status] || chalk.gray;

        return {
          id: s.id.substring(0, 8),
          name: s.name,
          type: s.type,
          status: statusColor(status),
          enabled: s.enabled ? chalk.green("✓") : chalk.gray("✗"),
        };
      });

      output.log(formatSourcesTable(rows));
      output.log("");  // blank line separator (用 log 而非 info 保证任何模式都输出)
      output.log(renderPaginationFooter({
        total,
        count: sources.length,
        offset: page.offset,
        limit: page.limit,
        itemName: "event source",
      }));
    } catch (error) {
      output.error(`Failed to list event sources: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
