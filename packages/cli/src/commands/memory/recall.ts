/**
 * @fileoverview Memory Recall Command
 * 
 * 命令：roy-bot memory recall
 * 
 * 读取所有 memory file 的内容
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type {
  MemoryComponent,
} from "@ai-setting/roy-bot-core";

interface RecallOptions {
  config?: string;
  json?: boolean;
  /** 作用域 (可选，不传则读取所有) */
  scope?: "project" | "global";
}

export const RecallCommand: CommandModule<object, object> = {
  command: "recall",
  aliases: ["load"],
  describe: "读取所有 memory file 的内容",
  
  builder: (yargs) =>
    yargs
      .option("config", {
        type: "string",
        describe: "Config file path",
      })
      .option("json", {
        alias: "j",
        type: "boolean",
        default: false,
        description: "JSON 格式输出",
      })
      .option("scope", {
        type: "string",
        choices: ["project", "global"],
        describe: "记忆作用域 (可选，不传则读取所有)",
      }),
  
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
      const memoryComponent = env.getComponent("memory") as MemoryComponent | undefined;

      if (!memoryComponent) {
        output.error("MemoryComponent not available");
        process.exit(1);
      }

      // 读取记忆
      const content = await memoryComponent.recallMemory(a.scope);

      if (!content) {
        output.log(chalk.gray("(No memory files found)"));
        return;
      }

      if (a.json) {
        output.json({ content });
        return;
      }

      // 直接输出 markdown 内容（处理转义字符）
      output.log(content.replace(/\\n/g, "\n"));
    } catch (error) {
      output.error(`Failed to recall memory: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
