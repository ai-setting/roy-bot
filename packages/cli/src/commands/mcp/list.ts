/**
 * @fileoverview MCP List Command
 * 
 * 命令：roy mcp list
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import {
  applyPagination,
  renderPaginationFooter,
  renderQuietHeader,
  renderQuietLine,
  renderQuietPaginationHint,
  PAGINATION_OPTIONS,
} from "../shared/list-output";
import type { ListPaginationArgs } from "../shared/list-output";
import type { McpComponent } from "@ai-setting/roy-bot-core";

interface ListOptions {
  json?: boolean;
  quiet?: boolean;
  config?: string;
  limit?: number;
  offset?: number;
}

export const ListCommand: CommandModule<object, ListOptions> = {
  command: "list",
  aliases: ["ls"],
  describe: "列出所有 MCP 服务器及其状态",
  
  builder: (yargs) =>
    yargs
      .option("json", {
        alias: "j",
        type: "boolean",
        default: false,
        description: "JSON 输出",
      })
      .option("limit", PAGINATION_OPTIONS.limit)
      .option("offset", PAGINATION_OPTIONS.offset)
      // 使用全局 --quiet / --no-quiet（默认简洁输出）
      .option("quiet", { alias: "q", type: "boolean", hidden: true }),

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
      const mcpComponent = env.getComponent("mcp") as McpComponent | undefined;

      if (!mcpComponent) {
        output.error("McpComponent not available");
        process.exit(1);
      }

      const allServers = mcpComponent.listServers();
      const total = allServers.length;

      // 应用分页（CLI 层截断）
      const page: ListPaginationArgs = {
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
      };
      const servers = applyPagination(allServers, page);

      if (args.json) {
        output.json({
          // 统一 JSON 结构：total FIRST, servers LAST
          total,
          count: servers.length,
          truncated: total > servers.length,
          limit: page.limit,
          offset: page.offset,
          servers: servers.map(s => ({
            name: s.name,
            status: s.status,
            error: s.error,
            toolsCount: s.toolsCount,
          })),
        });
      } else if (args.quiet) {
        // quiet 模式：# Total: N + 每行 "<id>\t<name>" + 分页提示
        output.log(renderQuietHeader(total, "mcp server"));
        servers.forEach((s) =>
          output.log(renderQuietLine(s.name, s.name))
        );
        const hint = renderQuietPaginationHint({
          count: servers.length,
          total,
          offset: page.offset,
          limit: page.limit,
        });
        if (hint) output.log(hint);
      } else {
        if (servers.length === 0) {
          output.log(chalk.yellow("No MCP servers configured"));
          return;
        }

        const statusColor = (status: string) => {
          switch (status) {
            case "connected": return chalk.green;
            case "connecting": return chalk.yellow;
            case "error": return chalk.red;
            case "disconnected": return chalk.gray;
            default: return chalk.white;
          }
        };

        const header = [
          chalk.bold("Name"),
          chalk.bold("Status"),
          chalk.bold("Tools"),
        ].join(" | ");

        const rows = servers.map(s => [
          chalk.cyan(s.name),
          statusColor(s.status)(`[${s.status}]`),
          s.toolsCount !== undefined ? String(s.toolsCount) : "-",
        ].join(" | "));

        output.log([
          `┌─ MCP Servers ${"─".repeat(40)}┐`,
          `│${header}│`,
          "├" + "─".repeat(header.length + 2) + "┤",
          ...rows.map(r => `│${r}│`),
          "└" + "─".repeat(header.length + 2) + "┘",
          "",
          renderPaginationFooter({
            total,
            count: servers.length,
            offset: page.offset,
            limit: page.limit,
            itemName: "mcp server",  // 与 quiet header 一致
          }),
        ].join("\n"));
      }
    } catch (error) {
      output.error(`Failed to list MCP servers: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
