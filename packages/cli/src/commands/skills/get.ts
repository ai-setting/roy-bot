/**
 * @fileoverview Skills Get Command
 * 
 * 命令：roy-bot skills get <name>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SkillComponent, SkillEntry } from "@ai-setting/roy-bot-core";

interface GetOptions {
  name: string;
  json?: boolean;
  config?: string;
}

export const GetCommand: CommandModule<object, GetOptions> = {
  command: "get <name>",
  describe: "获取指定技能内容",
  
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        demandOption: true,
        description: "技能名称",
      })
      .option("json", {
        alias: "j",
        type: "boolean",
        default: false,
        description: "JSON 输出",
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

      const skill = skillComponent.getSkill(args.name);

      if (!skill) {
        output.error(`Skill not found: ${args.name}`);
        output.log("Use 'roy-bot skills list' to see available skills.");
        process.exit(1);
      }

      if (args.json) {
        output.json({
          name: skill.name,
          description: skill.description,
          source: skill.source,
          filePath: skill.filePath,
          content: skill.content,
        });
      } else {
        // 输出技能信息头
        output.log(chalk.bold.cyan(`# ${skill.name}`));
        output.log("");
        output.log(`${chalk.gray("Description:")} ${skill.description}`);
        output.log(`${chalk.gray("Source:")} ${skill.source}`);
        output.log(`${chalk.gray("File:")} ${skill.filePath}`);
        output.log("");
        output.log(chalk.bold("--- Content ---"));
        output.log("");
        output.log(skill.content);
      }
    } catch (error) {
      output.error(`Failed to get skill: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
