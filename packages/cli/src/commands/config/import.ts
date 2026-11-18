/**
 * @fileoverview config import 子命令
 */

import { CommandModule } from "yargs";
import chalk from "chalk";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import { ConfigService } from "./config-service";
import { SUPPORTED_COMPONENTS, resolveComponentName } from "./types";

export interface ConfigImportOptions {
  component: string;
  file: string;
  dryRun?: boolean;
  verbose?: boolean;
  config?: string;
}

/**
 * ConfigImportCommand - config import 子命令
 */
export const ConfigImportCommand: CommandModule<object, ConfigImportOptions> = {
  command: "import <component>",
  describe: "从文件导入配置到组件的 file source",

  builder: (yargs) =>
    yargs
      .positional("component", {
        type: "string",
        describe: "Component 名称",
        choices: [...SUPPORTED_COMPONENTS, "sessions"],
        demandOption: true,
      })
      .option("file", {
        type: "string",
        describe: "导入源配置文件",
        alias: "f",
        demandOption: true,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "预览变更，不实际写入",
        default: false,
      })
      .option("verbose", {
        type: "boolean",
        describe: "显示详细操作信息",
        alias: "v",
        default: false,
      })
      .option("config", {
        type: "string",
        describe: "配置文件路径",
        alias: "c",
      })
      .example("roy-bot config import session --file session-config.json", "导入 session 配置")
      .example("roy-bot config import session --file session-config.json --dry-run", "预览变更")
      .example("roy-bot config import session --file session-config.json --verbose", "显示详细信息"),

  async handler(args) {
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: args.config });
      const env = envService.getEnvironment();
      if (!env) {
        output.error("Failed to get environment");
        process.exit(1);
      }
      const configComponent = env.getComponent("config") as any;
      if (!configComponent) {
        output.error("ConfigComponent not available");
        process.exit(1);
      }
      const configService = new ConfigService(configComponent, output);

      // 解析 component 名称（处理别名）
      const componentName = resolveComponentName(args.component);
      
      // 验证 component
      if (!SUPPORTED_COMPONENTS.includes(componentName as any)) {
        output.error(`Unknown component: ${args.component}`);
        output.log("");
        output.log("Supported components:");
        for (const comp of SUPPORTED_COMPONENTS) {
          output.log(`  ${chalk.cyan(comp)}`);
        }
        process.exit(1);
      }

      // 导入配置
      const result = await configService.importFromFile(componentName, {
        sourceFile: args.file,
        dryRun: args.dryRun,
        verbose: args.verbose,
      });

      if (!result.success) {
        output.error(result.message || "导入失败");
        process.exit(1);
      }

      if (result.merged && result.changes.length > 0 && args.verbose) {
        output.log("");
        output.log(chalk.bold("变更详情:"));
        for (const change of result.changes) {
          output.log(`  ${change.key}: ${JSON.stringify(change.oldValue)} → ${JSON.stringify(change.newValue)}`);
        }
      }
    } catch (error) {
      output.error(`Failed to import config: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
