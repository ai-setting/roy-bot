/**
 * @fileoverview Skills Show Config Command
 * 
 * 命令：roy-bot skills show-config
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SkillComponent, SkillConfig } from "@ai-setting/roy-bot-core";

interface ShowConfigOptions {
  config?: string;
}

export const ShowConfigCommand: CommandModule<object, ShowConfigOptions> = {
  command: "show-config",
  aliases: ["config"],
  describe: "显示技能配置信息",
  
  builder: (yargs) =>
    yargs
      .option("config", {
        type: "string",
        description: "配置文件路径",
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

      // SkillComponent 当前使用默认配置，还没有从配置系统读取
      // 这里展示的是默认配置路径
      const defaultConfig = skillComponent.getConfig?.();
      
      output.log(chalk.bold.cyan("# Skills Configuration\n"));
      
      // 扫描路径
      output.log(chalk.bold("## Scan Paths\n"));
      
      const paths = [
        { type: "user", desc: "用户路径", path: "~/.config/roy-bot/skills/" },
        { type: "project", desc: "项目路径", path: ".roy/skills/" },
      ];

      for (const p of paths) {
        const typeColor = p.type === "project" ? chalk.green : chalk.blue;
        output.log(`  ${typeColor("[ " + p.type + " ]")} ${chalk.gray(p.desc)}`);
        output.log(`         ${chalk.cyan(p.path)}\n`);
      }

      // 扫描规则
      output.log(chalk.bold("## Scan Rules\n"));
      output.log(`  ${chalk.gray("Pattern:")} ${chalk.cyan("**/SKILL.md")}`);
      output.log(`  ${chalk.gray("Recursive:")} ${chalk.green("true")}`);
      output.log(`  ${chalk.gray("Ignore:")} ${chalk.cyan("**/node_modules/**")}\n`);

      // 优先级说明
      output.log(chalk.bold("## Priority (High to Low)\n"));
      output.log(`  ${chalk.green("1. project")} - 项目路径（最高优先级）`);
      output.log(`  ${chalk.blue("2. user")} - 用户路径`);
      output.log(`  ${chalk.gray("3. built-in")} - 内置路径（预留）\n`);

      // 使用提示
      output.log(chalk.bold("## Usage\n"));
      output.log(`  ${chalk.cyan("roy-bot skills list")} ${chalk.gray("- 列出所有技能")}`);
      output.log(`  ${chalk.cyan("roy-bot skills get <name>")} ${chalk.gray("- 获取技能内容")}`);
      output.log(`  ${chalk.cyan("roy-bot skills search <term>")} ${chalk.gray("- 搜索技能")}`);
      output.log(`  ${chalk.cyan("roy-bot skills reload")} ${chalk.gray("- 重新扫描技能")}`);

    } catch (error) {
      output.error(`Failed to show config: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
