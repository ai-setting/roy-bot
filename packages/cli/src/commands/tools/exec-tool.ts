/**
 * @fileoverview Tools Exec-Tool Command
 * 
 * 命令：roy tools exec-tool <name>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import type { ToolComponent, Tool } from "@ai-setting/roy-bot-core";
import {
  extractParameters,
  validateRequiredParams,
} from "./shared/schema-helper";

interface ExecToolOptions {
  name: string;
  config?: string;
  // 动态参数将通过 yargs builder 动态添加
  [key: string]: unknown;
}

export const ExecToolCommand: CommandModule<object, ExecToolOptions> = {
  command: "exec-tool <name>",
  describe: "执行指定工具",

  builder: (yargs) => {
    return yargs
      .positional("name", {
        type: "string",
        demandOption: true,
        description: "工具名称",
      })
      .strict(false); // 允许动态参数
  },

  async handler(args) {
    const output = new OutputService();
    const envService = new EnvironmentService(output);
    const toolName = args.name;

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

      // 获取工具
      const tool = toolComponent.getTool(toolName);

      if (!tool) {
        output.error(`Tool not found: ${toolName}`);
        output.log("Use 'roy-bot tools list' to see available tools.");
        process.exit(1);
      }

      // 提取参数信息
      const params = extractParameters(tool.parameters);

      // 收集用户提供的参数（排除 name 和 config）
      const userArgs: Record<string, unknown> = {};
      for (const param of params) {
        if (args[param.name] !== undefined) {
          userArgs[param.name] = args[param.name];
        }
      }

      // 验证必需参数
      const validation = validateRequiredParams(params, userArgs);

      if (!validation.valid) {
        output.error(`Missing required arguments for '${toolName}':`);
        for (const missing of validation.missing) {
          const param = params.find((p) => p.name === missing);
          output.log(`  - ${missing} (${param?.description || "required"})`);
        }
        output.log("");
        output.log(`Usage: roy tools exec-tool ${toolName} [options]`);
        for (const param of params) {
          const req = param.required ? "required" : "optional";
          const def =
            param.default !== undefined
              ? ` [default: ${JSON.stringify(param.default)}]`
              : "";
          output.log(`  --${param.name} <${param.type}> (${req})${def}`);
        }
        process.exit(1);
      }

      // 执行工具
      const result = await toolComponent.execute({
        name: toolName,
        args: userArgs,
        context: {
          workdir: process.cwd(),
        },
      });

      // 输出结果（JSON 格式）
      output.json(result);

      // 根据结果设置退出码
      if (!result.success) {
        process.exit(1);
      }
    } catch (error) {
      output.json({
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          execution_time_ms: 0,
        },
      });
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
