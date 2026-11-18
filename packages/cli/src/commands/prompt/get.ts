/**
 * @fileoverview Prompt Get Command
 * 
 * 命令：roy-bot prompt get <name>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { PromptComponent } from "@ai-setting/roy-bot-core";

interface GetOptions {
  name: string;
  json?: boolean;
  var?: string[];
  config?: string;
}

export const GetCommand: CommandModule<object, GetOptions> = {
  command: "get <name>",
  describe: "获取指定 prompt 的内容",
  
  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "Prompt 名称",
        demandOption: true,
      })
      .option("json", {
        alias: "j",
        type: "boolean",
        default: false,
        description: "JSON 输出",
      })
      .option("var", {
        alias: "v",
        type: "string",
        array: true,
        description: "变量替换，格式：key=value",
      }),
  
  async handler(args) {
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: (args as any).config });
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

      // 获取 prompt
      // 使用 getPrompt 支持变量渲染
      const vars = parseVars((args as any).var);
      const prompt = await promptComponent.getPrompt(args.name, vars);
      
      if (!prompt) {
        output.error(`Prompt not found: ${args.name}`);
        process.exit(1);
      }

      if ((args as any).json) {
        output.json({
          name: args.name,
          content: prompt,
          variables: vars,
        });
      } else {
        output.log(chalk.bold.cyan(`# Prompt: ${args.name}`));
        output.log("");
        
        if (Object.keys(vars).length > 0) {
          output.log(chalk.gray("Variables:"));
          for (const [key, value] of Object.entries(vars)) {
            output.log(`  ${chalk.cyan(key + ":")} ${value}`);
          }
          output.log("");
        }
        
        output.log(chalk.bold("Content:"));
        output.log("─".repeat(60));
        output.log(prompt);
        output.log("─".repeat(60));
      }
    } catch (error) {
      output.error(`Failed to get prompt: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};

/**
 * 解析变量参数
 */
function parseVars(vars?: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  if (!vars) return result;
  
  for (const v of vars) {
    const idx = v.indexOf("=");
    if (idx > 0) {
      const key = v.substring(0, idx);
      const value = v.substring(idx + 1);
      result[key] = value;
    }
  }
  
  return result;
}
