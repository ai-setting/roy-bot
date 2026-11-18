/**
 * @fileoverview Prompt List Command
 * 
 * 命令：roy-bot prompt list
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { PromptComponent } from "@ai-setting/roy-bot-core";
import {
  applyPagination,
  renderPaginationFooter,
  renderQuietHeader,
  renderQuietLine,
  renderQuietPaginationHint,
  PAGINATION_OPTIONS,
} from "../shared/list-output";
import type { ListPaginationArgs } from "../shared/list-output";

interface ListOptions {
  source?: "built-in" | "directory" | "file" | "inline" | "all";
  json?: boolean;
  quiet?: boolean;
  config?: string;
  limit?: number;
  offset?: number;
}

export const ListCommand: CommandModule<object, ListOptions> = {
  command: "list",
  aliases: ["ls"],
  describe: "列出所有可用 prompts",
  
  builder: (yargs) =>
    yargs
      .option("source", {
        alias: "s",
        type: "string",
        choices: ["built-in", "directory", "file", "inline", "all"],
        default: "all",
        description: "按来源筛选",
      })
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
      
      const promptComponent = env.getComponent("prompt") as PromptComponent | undefined;
      if (!promptComponent) {
        output.error("PromptComponent not available");
        process.exit(1);
      }

      const allPrompts = promptComponent.listEntries().map((entry) => ({
        name: entry.name,
        source: entry.source,
      }));

      const filtered = args.source && args.source !== "all"
        ? allPrompts.filter((p) => p.source === args.source)
        : allPrompts;
      const total = filtered.length;

      // 应用分页（CLI 层截断）
      const page: ListPaginationArgs = {
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
      };
      const prompts = applyPagination(filtered, page);

      if (args.json) {
        output.json({
          // 统一 JSON 结构：total FIRST, prompts LAST
          total,
          count: prompts.length,
          truncated: total > prompts.length,
          limit: page.limit,
          offset: page.offset,
          source: args.source ?? "all",
          prompts: prompts.map(p => ({
            name: p.name,
            source: p.source,
          })),
        });
      } else if (args.quiet) {
        // quiet 模式：# Total: N + 每行 "<id>\t<name>" + 分页提示
        output.log(renderQuietHeader(total, "prompt"));
        prompts.forEach((p) =>
          output.log(renderQuietLine(p.name, p.name))
        );
        const hint = renderQuietPaginationHint({
          count: prompts.length,
          total,
          offset: page.offset,
          limit: page.limit,
        });
        if (hint) output.log(hint);
      } else {
        // 表格输出
        const header = [
          chalk.bold("Name"),
          chalk.bold("Source"),
        ].join(" | ");

        const rows = prompts.map((p) => {
          return [
            chalk.cyan(p.name),
            chalk.gray(`[${p.source}]`),
          ].join(" | ");
        });

        if (rows.length === 0) {
          output.log(chalk.yellow("No prompts found."));
        } else {
          output.log([
            `┌─ Prompts ${"─".repeat(50)}┐`,
            `│${header}│`,
            "├" + "─".repeat(header.length + 2) + "┤",
            ...rows.map(r => `│${r}│`),
            "└" + "─".repeat(header.length + 2) + "┘",
            "",
            renderPaginationFooter({
              total,
              count: prompts.length,
              offset: page.offset,
              limit: page.limit,
              itemName: "prompt",
              extras: args.source && args.source !== "all" ? [`source=${args.source}`] : [],
            }),
          ].join("\n"));
        }
      }
    } catch (error) {
      output.error(`Failed to list prompts: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
