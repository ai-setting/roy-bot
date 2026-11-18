/**
 * @fileoverview Prompt Add Command
 *
 * 命令：roy-bot prompt add <name>
 */

import { readFile } from "fs/promises";
import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { PromptComponent } from "@ai-setting/roy-bot-core";

interface AddOptions {
  name: string;
  file?: string;
  content?: string;
  json?: boolean;
  config?: string;
}

export const AddCommand: CommandModule<object, AddOptions> = {
  command: "add <name>",
  describe: "添加 prompt 并持久化到 ~/.local/share/roy-bot/prompts/",

  builder: (yargs) =>
    yargs
      .positional("name", {
        type: "string",
        describe: "Prompt 名称",
        demandOption: true,
      })
      .option("file", {
        alias: "f",
        type: "string",
        description: "从文件读取 prompt 内容",
      })
      .option("content", {
        alias: "c",
        type: "string",
        description: "直接指定 prompt 内容",
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
      if (!args.file && !args.content) {
        output.error("Either --file or --content is required");
        process.exit(1);
      }

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

      const content = args.file
        ? await readFile(args.file, "utf-8")
        : (args.content as string);

      const filePath = await promptComponent.savePrompt(args.name, content);

      if ((args as any).json) {
        output.json({
          name: args.name,
          source: "file",
          filePath,
          length: content.trim().length,
        });
      } else {
        output.log(chalk.green(`✓ Prompt '${args.name}' saved`));
        output.log(chalk.gray(`  ${filePath}`));
      }
    } catch (error) {
      output.error(`Failed to add prompt: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
