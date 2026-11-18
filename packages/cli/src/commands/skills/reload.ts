/**
 * @fileoverview Skills Reload Command
 * 
 * 命令：roy-bot skills reload
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SkillComponent } from "@ai-setting/roy-bot-core";

interface ReloadOptions {
  config?: string;
}

export const ReloadCommand: CommandModule<object, ReloadOptions> = {
  command: "reload",
  describe: "重新扫描并更新 SkillTool",
  
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

      output.log(chalk.blue("Reloading skills..."));

      await skillComponent.reload();

      const skills = skillComponent.getSkillList();
      output.log(chalk.green(`Successfully reloaded ${skills.length} skills`));
    } catch (error) {
      output.error(`Failed to reload skills: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
