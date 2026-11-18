/**
 * @fileoverview Tools List Command
 *
 * 命令：roy tools list
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
import type { ToolComponent, Tool } from "@ai-setting/roy-bot-core";

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
  describe: "列出所有可用工具",

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
      const toolComponent = env.getComponent("tool") as ToolComponent | undefined;

      if (!toolComponent) {
        output.error("ToolComponent not available");
        process.exit(1);
      }

      const allTools = toolComponent.listTools();
      const total = allTools.length;

      // 应用分页（CLI 层截断）
      const page: ListPaginationArgs = {
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
      };
      const tools = applyPagination(allTools, page);

      if (args.json) {
        output.json({
          // 统一 JSON 结构：total FIRST, tools LAST
          total,
          count: tools.length,
          truncated: total > tools.length,
          limit: page.limit,
          offset: page.offset,
          tools: tools.map((t: Tool) => ({
            name: t.name,
            description: t.description,
            category: t.metadata?.category,
          })),
        });
      } else if (args.quiet) {
        // quiet 模式：# Total: N + 每行 "<id>\t<name>" + 分页提示
        output.log(renderQuietHeader(total, "tool"));
        tools.forEach((t: Tool) =>
          output.log(renderQuietLine(t.name, t.name))
        );
        const hint = renderQuietPaginationHint({
          count: tools.length,
          total,
          offset: page.offset,
          limit: page.limit,
        });
        if (hint) output.log(hint);
      } else {
        // 表格输出
        const header = [
          chalk.bold("Name"),
          chalk.bold("Description"),
          chalk.bold("Category"),
        ].join(" | ");

        const rows = tools.map((t: Tool) => {
          const desc =
            t.description.length > 40
              ? t.description.slice(0, 37) + "..."
              : t.description;
          return [
            chalk.cyan(t.name),
            desc,
            t.metadata?.category ? chalk.gray(`[${t.metadata.category}]`) : "-",
          ].join(" | ");
        });

        output.log([
          `┌─ Tools ${"─".repeat(48)}┐`,
          `│${header}│`,
          "├" + "─".repeat(header.length + 2) + "┤",
          ...rows.map((r) => `│${r}│`),
          "└" + "─".repeat(header.length + 2) + "┘",
          "",
          renderPaginationFooter({
            total,
            count: tools.length,
            offset: page.offset,
            limit: page.limit,
            itemName: "tool",
          }),
        ].join("\n"));
      }
    } catch (error) {
      output.error(`Failed to list tools: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
