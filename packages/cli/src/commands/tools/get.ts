/**
 * @fileoverview Tools Get Command
 * 
 * 命令：roy tools get <name>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { ToolComponent, Tool } from "@ai-setting/roy-bot-core";
import { extractParameters } from "./shared/schema-helper";

interface GetOptions {
  name: string;
  json?: boolean;
  config?: string;
}

export const GetCommand: CommandModule<object, GetOptions> = {
  command: "get <name>",
  describe: "获取指定工具的详细信息",

  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        demandOption: true,
        description: "工具名称",
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
      const toolComponent = env.getComponent("tool") as ToolComponent | undefined;

      if (!toolComponent) {
        output.error("ToolComponent not available");
        process.exit(1);
      }

      const tool = toolComponent.getTool(args.name);

      if (!tool) {
        output.error(`Tool not found: ${args.name}`);
        output.log("Use 'roy-bot tools list' to see available tools.");
        process.exit(1);
      }

      // 提取参数信息
      const params = extractParameters(tool.parameters);

      if (args.json) {
        output.json({
          name: tool.name,
          description: tool.description,
          category: tool.metadata?.category,
          tags: tool.metadata?.tags,
          parameters: params.map((p) => ({
            name: p.name,
            type: p.type,
            description: p.description,
            required: p.required,
            default: p.default,
          })),
        });
      } else {
        // 格式化输出
        output.log(chalk.bold.cyan(`Tool: ${tool.name}`));
        output.log(chalk.gray("─".repeat(60)));
        output.log(`Description: ${tool.description}`);
        if (tool.metadata?.category) {
          output.log(`Category: ${tool.metadata.category}`);
        }
        if (tool.metadata?.tags?.length) {
          output.log(`Tags: ${tool.metadata.tags.join(", ")}`);
        }
        output.log("");
        output.log(chalk.bold("Parameters:"));

        for (const param of params) {
          const required = param.required
            ? chalk.red("(required)")
            : chalk.gray("(optional)");
          const defaultVal =
            param.default !== undefined
              ? ` [default: ${JSON.stringify(param.default)}]`
              : "";
          output.log(`  --${param.name} <${param.type}> ${required}`);
          output.log(`      ${param.description}${defaultVal}`);
        }
      }
    } catch (error) {
      output.error(`Failed to get tool: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
