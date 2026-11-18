/**
 * @fileoverview config list 子命令
 * 
 * 原 show-config 功能的重构版本
 */

import { CommandModule } from "yargs";
import chalk from "chalk";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import { ConfigService } from "./config-service";
import { SUPPORTED_COMPONENTS, COMPONENT_DESCRIPTIONS, resolveComponentName } from "./types";

export interface ConfigListOptions {
  component?: string;
  json?: boolean;
  keys?: boolean;
  sources?: boolean;
  config?: string;
}

/**
 * show-config 命令使用示例
 */
const USAGE_COMMANDS = [
  { command: "roy-bot config list", description: "显示帮助信息" },
  { command: "roy-bot config list tool", description: "查看 tool component 配置" },
  { command: "roy-bot config list session", description: "查看 session component 配置" },
  { command: "roy-bot config list all", description: "查看所有 components 概览" },
  { command: "roy-bot config list tool --json", description: "JSON 格式输出" },
  { command: "roy-bot config list tool --keys", description: "只显示配置键" },
];

/**
 * ConfigListCommand - config list 子命令
 */
export const ConfigListCommand: CommandModule<object, ConfigListOptions> = {
  command: "list [component]",
  describe: "查看组件配置信息",

  builder: (yargs) =>
    yargs
      .positional("component", {
        type: "string",
        describe: "Component 名称",
      })
      .option("json", {
        type: "boolean",
        describe: "JSON 格式输出",
        alias: "j",
      })
      .option("keys", {
        type: "boolean",
        describe: "只显示配置键",
        alias: "k",
      })
      .option("sources", {
        type: "boolean",
        describe: "只显示配置源",
        alias: "s",
      })
      .option("config", {
        type: "string",
        describe: "配置文件路径",
        alias: "c",
      })
      .example("roy-bot config list", "显示帮助信息")
      .example("roy-bot config list tool", "查看 tool component 配置")
      .example("roy-bot config list session", "查看 session component 配置")
      .example("roy-bot config list all", "查看所有 components 概览")
      .example("roy-bot config list tool --json", "JSON 格式输出")
      .example("roy-bot config list tool --keys", "只显示配置键"),

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
      configService.envService = envService;

      // 无参数时显示帮助
      if (!args.component) {
        showHelp(output);
        return;
      }

      // all: 显示所有 components
      if (args.component === "all") {
        await showAllComponents(output, configService);
        return;
      }

      // 解析 component 名称（处理别名）
      const componentName = resolveComponentName(args.component);
      
      // 验证 component
      if (!SUPPORTED_COMPONENTS.includes(componentName as any)) {
        output.error(`Unknown component: ${args.component}`);
        output.log("");
        output.log("Supported components:");
        for (const comp of SUPPORTED_COMPONENTS) {
          output.log(`  ${chalk.cyan(comp.padEnd(15))} ${COMPONENT_DESCRIPTIONS[comp] || ""}`);
        }
        process.exit(1);
      }

      // 显示特定 component
      await showComponentConfig(componentName, output, configService, {
        json: args.json,
        keys: args.keys,
        sources: args.sources,
      });
    } catch (error) {
      output.error(`Failed to show config: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};

/**
 * 显示帮助信息
 */
function showHelp(output: OutputService) {
  output.log(chalk.bold.cyan("# roy-bot config list"));
  output.log("");
  output.log("查看 roy-bot 组件配置信息");
  output.log("");
  output.log(chalk.bold("Usage:"));
  output.log(`  ${chalk.cyan("roy-bot config list [component] [options]")}`);
  output.log("");
  output.log(chalk.bold("Components:"));
  for (const comp of SUPPORTED_COMPONENTS) {
    output.log(
      `  ${chalk.cyan(comp.padEnd(15))} ${chalk.gray(COMPONENT_DESCRIPTIONS[comp] || "")}`
    );
  }
  output.log(`  ${chalk.cyan("all".padEnd(15))} 显示所有 components 概览`);
  output.log("");
  output.log(chalk.bold("Options:"));
  output.log(`  ${chalk.cyan("-j, --json")}     JSON 格式输出`);
  output.log(`  ${chalk.cyan("-k, --keys")}     只显示配置键`);
  output.log(`  ${chalk.cyan("-s, --sources")}  只显示配置源`);
  output.log("");
  output.log(chalk.bold("Examples:"));
  for (const { command, description } of USAGE_COMMANDS) {
    output.log(`  ${chalk.cyan(command.padEnd(40))} ${chalk.gray(description)}`);
  }
}

/**
 * 显示所有 components 概览
 */
async function showAllComponents(
  output: OutputService,
  configService: ConfigService
) {
  const components: Array<{ name: string; config: Record<string, unknown> }> = [];

  for (const compName of SUPPORTED_COMPONENTS) {
    const config = configService.getComponentConfig(compName);
    components.push({ name: compName, config });
  }

  output.log(chalk.bold.cyan("# All Components Overview"));
  output.log("");
  output.log(
    `  ${chalk.cyan("Component".padEnd(15))} ${chalk.cyan("Keys".padEnd(10))} ${chalk.gray("Description")}`
  );
  output.log(`  ${chalk.gray("─".repeat(60))}`);

  for (const comp of components) {
    const keyCount = Object.keys(comp.config).length;
    output.log(
      `  ${chalk.cyan(comp.name.padEnd(15))} ${keyCount.toString().padEnd(10)} ${chalk.gray(COMPONENT_DESCRIPTIONS[comp.name] || "")}`
    );
  }
}

/**
 * 显示特定 component 配置
 */
async function showComponentConfig(
  componentName: string,
  output: OutputService,
  configService: ConfigService,
  options: { json?: boolean; keys?: boolean; sources?: boolean }
) {
  // agent 组件特殊处理
  if (componentName === "agent") {
    await showAgentComponentConfig(output, configService, options);
    return;
  }

  // prompt 组件特殊处理
  if (componentName === "prompt") {
    await showPromptComponentConfig(output, configService, options, configService.envService);
    return;
  }

  const config = configService.getComponentConfig(componentName);
  const filePath = configService.getComponentFilePath(componentName);

  if (options.json) {
    output.json({
      name: componentName,
      filePath,
      config,
    });
    return;
  }

  output.log(chalk.bold.cyan(`# ${componentName} Component Configuration`));
  output.log("");

  // File Path
  if (filePath) {
    output.log(chalk.bold("File:"));
    output.log(`  ${chalk.cyan(filePath)}`);
    output.log("");
  }

  // Config Keys
  if (!options.sources) {
    output.log(chalk.bold("Configuration:"));
    if (Object.keys(config).length === 0) {
      output.log(`  ${chalk.gray("（无配置）")}`);
    } else {
      const flatConfig = flattenConfig(config);
      for (const [key, value] of flatConfig) {
        const displayValue = formatValue(value);
        output.log(`  ${chalk.cyan(key + ":")} ${displayValue}`);
      }
    }
    output.log("");
  }
}

/**
 * 显示 Agent Component 配置
 */
async function showAgentComponentConfig(
  output: OutputService,
  configService: ConfigService,
  options: { json?: boolean; keys?: boolean; sources?: boolean }
) {
  const config = configService.getComponentConfig("agent");

  if (options.json) {
    output.json({
      name: "agent",
      config,
    });
    return;
  }

  output.log(chalk.bold.cyan("# Agent Component Configuration"));
  output.log("");

  // Config Keys
  if (!options.sources) {
    output.log(chalk.bold("Configuration:"));
    if (Object.keys(config).length === 0) {
      output.log(`  ${chalk.gray("（无配置，使用默认值）")}`);
    } else {
      const flatConfig = flattenConfig(config);
      for (const [key, value] of flatConfig) {
        const displayValue = formatValue(value);
        output.log(`  ${chalk.cyan(key + ":")} ${displayValue}`);
      }
    }
    output.log("");
  }

  // Agent 配置目录（需要从 Environment 获取）
  const envService = (configService as any).envService;
  const env = envService?.getEnvironment?.();
  if (env) {
    const agentComponent = env.getComponent?.("agent");
    const registry = agentComponent?.getRegistry?.();
    if (registry) {
      const configDir = registry.getConfigDir();
      const exists = registry.configDirExists();
      const agentCount = registry.list().length;
      output.log(chalk.bold("Agent Config Directory:"));
      output.log(`  ${chalk.cyan("path:")} ${configDir}`);
      output.log(`  ${chalk.cyan("exists:")} ${exists ? chalk.green("yes") : chalk.red("no")}`);
      output.log(`  ${chalk.cyan("agents:")} ${agentCount} loaded`);
      output.log("");
    }
  }
}

/**
 * 显示 Prompt Component 配置
 */
async function showPromptComponentConfig(
  output: OutputService,
  configService: ConfigService,
  options: { json?: boolean; keys?: boolean; sources?: boolean },
  envService?: any
) {
  const config = configService.getComponentConfig("prompt");
  const filePath = configService.getComponentFilePath("prompt");

  if (options.json) {
    output.json({
      name: "prompt",
      filePath,
      config,
    });
    return;
  }

  output.log(chalk.bold.cyan("# Prompt Component Configuration"));
  output.log("");

  // File Path
  if (filePath) {
    output.log(chalk.bold("File:"));
    output.log(`  ${chalk.cyan(filePath)}`);
    output.log("");
  }

  // Config Keys
  if (!options.sources) {
    output.log(chalk.bold("Configuration:"));
    if (Object.keys(config).length === 0) {
      output.log(`  ${chalk.gray("（无配置，使用默认值）")}`);
    } else {
      const flatConfig = flattenConfig(config);
      for (const [key, value] of flatConfig) {
        const displayValue = formatValue(value);
        output.log(`  ${chalk.cyan(key + ":")} ${displayValue}`);
      }
    }
    output.log("");
  }

  // Prompt 信息
  output.log(chalk.bold("Prompts:"));
  output.log(`  ${chalk.gray("- 内置: 5 个（default, coding, review, project-memory, global-memory）")}`);
  
  const promptPaths = (config as any)?.promptPaths;
  if (promptPaths && Array.isArray(promptPaths) && promptPaths.length > 0) {
    output.log(`  ${chalk.gray("- 外部: " + promptPaths.length + " 个路径")}`);
    for (const p of promptPaths) {
      output.log(`    ${chalk.cyan(p.path)} ${chalk.gray("(type: " + p.type + ")")}`);
    }
  } else {
    output.log(`  ${chalk.gray("- 外部: 0 个（未配置 promptPaths）")}`);
  }
  output.log("");

  // 默认 prompt
  const defaultName = (config as any)?.defaultName || "default";
  output.log(chalk.bold("Default Prompt:"));
  output.log(`  ${chalk.cyan("defaultName:")} ${defaultName}`);
  output.log("");

  // Prompt 存储目录
  const env = envService?.getEnvironment?.();
  if (env) {
    const promptComponent = env.getComponent?.("prompt");
    if (promptComponent) {
      const configDir = (promptComponent as any).getPromptConfigDir?.();
      const exists = (promptComponent as any).getPromptStore?.()?.configDirExists?.();
      if (configDir) {
        let promptCount = 0;
        try {
          const store = (promptComponent as any).getPromptStore?.();
          const stored = await store?.loadAll?.();
          promptCount = Array.isArray(stored) ? stored.length : 0;
        } catch {
          // ignore
        }

        output.log(chalk.bold("Prompt Storage Directory:"));
        output.log(`  ${chalk.cyan("path:")} ${configDir}`);
        output.log(`  ${chalk.cyan("exists:")} ${exists ? chalk.green("yes") : chalk.red("no")}`);
        output.log(`  ${chalk.cyan("prompts:")} ${promptCount} loaded`);
        output.log("");
      }
    }
  }
}

/**
 * 扁平化配置对象
 */
function flattenConfig(
  obj: unknown,
  prefix = ""
): Array<[string, unknown]> {
  const result: Array<[string, unknown]> = [];

  if (typeof obj !== "object" || obj === null) {
    if (prefix) {
      result.push([prefix, obj]);
    }
    return result;
  }

  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      result.push(...flattenConfig(value, fullKey));
    } else {
      result.push([fullKey, value]);
    }
  }

  return result;
}

/**
 * 格式化值显示
 */
function formatValue(value: unknown): string {
  if (value === undefined) {
    return chalk.gray("undefined");
  }
  if (value === null) {
    return chalk.gray("null");
  }
  if (typeof value === "object") {
    return chalk.gray(JSON.stringify(value));
  }
  return String(value);
}
