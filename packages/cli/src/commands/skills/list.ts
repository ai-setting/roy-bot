/**
 * @fileoverview Skills List Command
 *
 * 命令：roy-bot skills list
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SkillComponent, SkillListItem } from "@ai-setting/roy-bot-core";
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
  source?: "built-in" | "user" | "project" | "all";
  json?: boolean;
  quiet?: boolean;
  config?: string;
  limit?: number;
  offset?: number;
}

export const ListCommand: CommandModule<object, object> = {
  command: "list",
  aliases: ["ls"],
  describe: "列出所有可用技能",

  builder: (yargs) =>
    yargs
      .option("source", {
        alias: "s",
        type: "string",
        choices: ["built-in", "user", "project", "all"],
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
      const skillComponent = env.getComponent("skill") as SkillComponent | undefined;

      if (!skillComponent) {
        output.error("SkillComponent not available");
        process.exit(1);
      }

      const allSkills = skillComponent.getSkillList() as SkillListItem[];

      // 按来源筛选（在 CLI 层截断之前）
      const filtered = a.source && a.source !== "all"
        ? allSkills.filter((s: SkillListItem) => s.source === a.source)
        : allSkills;
      const total = filtered.length;

      // 应用分页（CLI 层截断，in-memory 列表不需要 component 支持）
      const page: ListPaginationArgs = {
        limit: a.limit ?? 20,
        offset: a.offset ?? 0,
      };
      const skills = applyPagination(filtered, page);

      if (a.json) {
        output.json({
          // 统一 JSON 结构：total FIRST, items LAST
          total,
          count: skills.length,
          truncated: total > skills.length,
          limit: page.limit,
          offset: page.offset,
          source: a.source ?? "all",
          skills: skills.map((s: SkillListItem) => ({
            name: s.name,
            description: s.description,
            source: s.source,
          })),
        });
      } else if (a.quiet) {
        // quiet 模式：# Total: N + 每行 "<id>\t<name>" + 分页提示
        output.log(renderQuietHeader(total, "skill"));
        skills.forEach((s: SkillListItem) =>
          output.log(renderQuietLine(s.name, s.name))
        );
        const hint = renderQuietPaginationHint({
          count: skills.length,
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
          chalk.bold("Source"),
        ].join(" | ");

        const sourceColor = (source: string) => {
          switch (source) {
            case "project": return chalk.green;
            case "user": return chalk.blue;
            case "built-in": return chalk.gray;
            default: return chalk.white;
          }
        };

        const rows = skills.map((s: SkillListItem) => {
          const desc = s.description.length > 50
            ? s.description.slice(0, 47) + "..."
            : s.description;
          return [
            chalk.cyan(s.name),
            desc,
            sourceColor(s.source)(`[${s.source}]`),
          ].join(" | ");
        });

        output.log([
          `┌─ Skills ${"─".repeat(55)}┐`,
          `│${header}│`,
          "├" + "─".repeat(header.length + 2) + "┤",
          ...rows.map(r => `│${r}│`),
          "└" + "─".repeat(header.length + 2) + "┘",
          "",
          renderPaginationFooter({
            total,
            count: skills.length,
            offset: page.offset,
            limit: page.limit,
            itemName: "skill",
            extras: a.source && a.source !== "all" ? [`source=${a.source}`] : [],
          }),
        ].join("\n"));
      }
    } catch (error) {
      output.error(`Failed to list skills: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
