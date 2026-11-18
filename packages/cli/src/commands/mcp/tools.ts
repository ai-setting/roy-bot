/**
 * @fileoverview MCP Tools Command
 * 
 * 命令：roy mcp tools
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { McpComponent } from "@ai-setting/roy-bot-core";

interface ToolsOptions {
  server?: string;
  json?: boolean;
  quiet?: boolean;
  config?: string;
}

export const ToolsCommand: CommandModule<object, ToolsOptions> = {
  command: "tools",
  aliases: ["t"],
  describe: "列出所有 MCP 工具",
  
  builder: (yargs) =>
    yargs
      .option("server", {
        alias: "s",
        type: "string",
        description: "按服务器筛选",
      })
      .option("json", {
        alias: "j",
        type: "boolean",
        default: false,
        description: "JSON 输出",
      })
      .option("quiet", {
        alias: "q",
        type: "boolean",
        default: false,
        description: "简洁输出",
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
      const mcpComponent = env.getComponent("mcp") as McpComponent | undefined;

      if (!mcpComponent) {
        output.error("McpComponent not available");
        process.exit(1);
      }

      let tools = mcpComponent.listTools();

      // 按服务器筛选
      if (args.server) {
        tools = tools.filter(t => 
          t.metadata?.tags?.includes(args.server!)
        );
      }

      if (args.json) {
        output.json({
          count: tools.length,
          tools: tools.map(t => ({
            name: t.name,
            description: t.description,
            category: t.metadata?.category,
            tags: t.metadata?.tags,
          })),
        });
      } else if (args.quiet) {
        tools.forEach(t => output.log(t.name));
      } else {
        if (tools.length === 0) {
          output.log(chalk.yellow("No MCP tools available"));
          return;
        }

        // 按服务器分组
        const byServer = new Map<string, typeof tools>();
        for (const tool of tools) {
          const serverName = tool.metadata?.tags?.find(t => t !== "mcp") || "unknown";
          if (!byServer.has(serverName)) {
            byServer.set(serverName, []);
          }
          byServer.get(serverName)!.push(tool);
        }

        for (const [serverName, serverTools] of byServer) {
          output.log(chalk.bold.cyan(`\n[${serverName}] ${serverTools.length} tools`));
          
          for (const tool of serverTools) {
            const desc = tool.description.length > 80 
              ? tool.description.slice(0, 77) + "..." 
              : tool.description;
            output.log(`  ${chalk.green("+")} ${chalk.white(tool.name)}`);
            output.log(`    ${chalk.gray(desc)}`);
          }
        }

        output.log(chalk.gray(`\nTotal: ${tools.length} tools across ${byServer.size} servers`));
      }
    } catch (error) {
      output.error(`Failed to list MCP tools: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
