/**
 * @fileoverview config export 子命令
 */

import { CommandModule } from "yargs";
import chalk from "chalk";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import { ConfigService } from "./config-service";
import { SUPPORTED_COMPONENTS, resolveComponentName } from "./types";

export interface ConfigExportOptions {
  component: string;
  file?: string;
  pretty?: boolean;
  config?: string;
}

/**
 * ConfigExportCommand - config export 子命令
 */
export const ConfigExportCommand: CommandModule<object, ConfigExportOptions> = {
  command: "export <component>",
  describe: "导出组件配置到文件",

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
        describe: "导出文件路径",
        alias: "f",
        demandOption: true,
      })
      .option("pretty", {
        type: "boolean",
        describe: "格式化 JSON 输出",
        default: true,
      })
      .option("config", {
        type: "string",
        describe: "配置文件路径",
        alias: "c",
      })
      .example("roy-bot config export agent --file agent-config.json", "导出 agent 配置")
      .example("roy-bot config export session --file session-config.json", "导出 session 配置"),

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

      // 导出配置
      await configService.exportToFile(componentName, {
        filePath: args.file,
        pretty: args.pretty,
      });
    } catch (error) {
      output.error(`Failed to export config: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
