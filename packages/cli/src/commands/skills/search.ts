/**
 * @fileoverview Skills Search Command
 * 
 * 命令：roy-bot skills search <term>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SkillComponent, SkillListItem } from "@ai-setting/roy-bot-core";

interface SearchOptions {
  term: string;
  json?: boolean;
  quiet?: boolean;
  config?: string;
}

export const SearchCommand: CommandModule<object, SearchOptions> = {
  command: "search <term>",
  aliases: ["find"],
  describe: "搜索技能（按名称或描述）",
  
  builder: (yargs) =>
    yargs
      .positional("term", {
        type: "string",
        demandOption: true,
        description: "搜索关键词",
      })
      .option("json", {
        alias: "j",
        type: "boolean",
        default: false,
        description: "JSON 输出",
      })
      .option("quiet", {
        alias: "q",
        type: "boolean",
        default: false,
        description: "简洁输出",
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
      const skillComponent = env.getComponent("skill") as SkillComponent | undefined;

      if (!skillComponent) {
        output.error("SkillComponent not available");
        process.exit(1);
      }

      const allSkills = skillComponent.getSkillList() as SkillListItem[];
      const term = args.term.toLowerCase();

      // 搜索匹配（name 或 description 包含 term）
      const results = allSkills.filter((s: SkillListItem) => 
        s.name.toLowerCase().includes(term) ||
        s.description.toLowerCase().includes(term)
      );

      if (results.length === 0) {
        output.log(chalk.yellow(`No skills found matching: ${args.term}`));
        return;
      }

      if (args.json) {
        output.json({
          count: results.length,
          term: args.term,
          results: results.map((s: SkillListItem) => ({
            name: s.name,
            description: s.description,
            source: s.source,
            matchedIn: s.name.toLowerCase().includes(term) ? "name" : "description",
          })),
        });
      } else if (args.quiet) {
        results.forEach((s: SkillListItem) => output.log(s.name));
      } else {
        output.log(chalk.bold(`Search results for "${args.term}":`));
        output.log("");

        const header = [
          chalk.bold("Name"),
          chalk.bold("Description"),
          chalk.bold("Match"),
        ].join(" | ");

        const rows = results.map((s: SkillListItem) => {
          const matchedIn = s.name.toLowerCase().includes(term) ? "name" : "description";
          const matchColor = matchedIn === "name" ? chalk.green : chalk.blue;
          
          const desc = s.description.length > 40 
            ? s.description.slice(0, 37) + "..." 
            : s.description;
            
          return [
            chalk.cyan(s.name),
            desc,
            matchColor(`[${matchedIn}]`),
          ].join(" | ");
        });

        output.log([
          `┌─ Skills ${"─".repeat(55)}┐`,
          `│${header}│`,
          "├" + "─".repeat(header.length + 2) + "┤",
          ...rows.map(r => `│${r}│`),
          "└" + "─".repeat(header.length + 2) + "┘",
          "",
          chalk.gray(`${results.length} matching skill(s) found.`),
        ].join("\n"));
      }
    } catch (error) {
      output.error(`Failed to search skills: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
