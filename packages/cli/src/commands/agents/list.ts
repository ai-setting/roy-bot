/**
 * @fileoverview Agents List Command
 * 
 * 命令：roy-bot agents list
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { AgentComponent } from "@ai-setting/roy-bot-core";
import type { AgentDefinition } from "@ai-setting/roy-bot-core";
import {
  applyPagination,
  renderPaginationFooter,
  renderQuietHeader,
  renderQuietLine,
  renderQuietPaginationHint,
  PAGINATION_OPTIONS,
} from "../shared/list-output";
import type { ListPaginationArgs } from "../shared/list-output";

interface ListOptions {
  type?: "primary" | "sub" | "workflow" | "all";
  json?: boolean;
  quiet?: boolean;
  config?: string;
  limit?: number;
  offset?: number;
}

export const ListCommand: CommandModule<object, ListOptions> = {
  command: "list",
  aliases: ["ls"],
  describe: "列出所有可用 agents",
  
  builder: (yargs) =>
    yargs
      .option("type", {
        alias: "t",
        type: "string",
        choices: ["primary", "sub", "workflow", "all"],
        default: "all",
        description: "按类型筛选",
      })
      .option("json", {
        alias: "j",
        type: "boolean",
        default: false,
        description: "JSON 输出",
      })
      .option("limit", PAGINATION_OPTIONS.limit)
      .option("offset", PAGINATION_OPTIONS.offset)
      // 使用全局 --quiet / --no-quiet（默认简洁输出）
      .option("quiet", { alias: "q", type: "boolean", hidden: true }),
  
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
      
      const agentComponent = env.getComponent("agent") as AgentComponent | undefined;
      if (!agentComponent) {
        output.error("AgentComponent not available");
        process.exit(1);
      }

      // 获取 registry 和 agents
      const registry = agentComponent.getRegistry?.();
      if (!registry) {
        output.error("Agent registry not available");
        process.exit(1);
      }

      let agents: AgentDefinition[];

      // 内置 subagent 名册（来自 delegate-tool 的 builtInSubAgents）
      // 用 systemPromptRef 关联到 builtInPrompts 的内置 prompt，
      // 已在 initRegistry() 时由 AgentRegistry.register*Agent() 注册。
      // 列出时优先于自定义 registry agents — 因为这是"bundled always-available"能力。
      const builtInSubAgentNames = new Set<string>([
        "general",
        "explore",
        "roy",
        "workflow-runner",  // ★ Task #2164: pre-emptive inclusion (vs reference M1 fix)
        // 其余内置（json-extract / workflow-extract / compact / compact-hint）
        // 都是工具调用专属 agent，不应展示给用户；
        // 仅展示用户可直接 delegate_task 调用的 subagent。
      ]);

      if (args.type && args.type !== "all") {
        agents = registry.listAgentsByType(args.type);
        // 内置 agent（roy/...）也参与 type 过滤
        // 注意：roy 已通过 AgentRegistry.registerRoyAgent() 自动注册，
        // 所以 listAgentsByType("sub") 已经包含 roy。这里无需额外处理。
      } else {
        agents = registry.list();
      }

      const total = agents.length;

      // 应用分页（CLI 层截断，in-memory 列表）
      const page: ListPaginationArgs = {
        limit: args.limit ?? 20,
        offset: args.offset ?? 0,
      };
      const pagedAgents = applyPagination(agents, page);

      if (args.json) {
        output.json({
          // 统一 JSON 结构：total FIRST, agents LAST
          total,
          count: pagedAgents.length,
          truncated: total > pagedAgents.length,
          limit: page.limit,
          offset: page.offset,
          type: args.type ?? "all",
          agents: pagedAgents.map(a => ({
            name: a.name,
            type: a.type,
            source: builtInSubAgentNames.has(a.name) ? "built-in" : "user",
            description: a.description,
            workflow: a.workflow,
            model: a.model,
            systemPromptRef: a.systemPromptRef,
            hasInlinePrompt: !!a.systemPrompt,
          })),
        });
      } else if (args.quiet) {
        // quiet 模式：# Total: N + 每行 "<id>\t<name>" + 分页提示
        output.log(renderQuietHeader(total, "agent"));
        pagedAgents.forEach((a) =>
          output.log(renderQuietLine(a.name, a.name))
        );
        const hint = renderQuietPaginationHint({
          count: pagedAgents.length,
          total,
          offset: page.offset,
          limit: page.limit,
        });
        if (hint) output.log(hint);
      } else {
        // 表格输出
        const header = [
          chalk.bold("Name"),
          chalk.bold("Type"),
          chalk.bold("Source"),
          chalk.bold("Model"),
          chalk.bold("Workflow"),
          chalk.bold("Description"),
        ].join(" | ");

        const typeColor = (type: string) => {
          if (type === "primary") return chalk.yellow;
          if (type === "workflow") return chalk.magenta;
          return chalk.blue;
        };

        const rows = pagedAgents.map((a) => {
          const desc = (a.description || "").length > 40
            ? (a.description || "").slice(0, 37) + "..."
            : (a.description || "-");
          const workflowDisplay = a.type === "workflow" && a.workflow
            ? chalk.cyan(a.workflow.length > 30 ? a.workflow.slice(0, 27) + "..." : a.workflow)
            : chalk.gray("-");
          const modelDisplay = a.model
            ? chalk.yellow(a.model.length > 20 ? a.model.slice(0, 17) + "..." : a.model)
            : chalk.gray("-");
          const sourceDisplay = builtInSubAgentNames.has(a.name)
            ? chalk.green("built-in")
            : chalk.gray("user");
          return [
            chalk.cyan(a.name),
            typeColor(a.type)(a.type),
            sourceDisplay,
            modelDisplay,
            workflowDisplay,
            desc,
          ].join(" | ");
        });

        if (rows.length === 0) {
          output.log(chalk.yellow("No agents found."));
          output.log("");
          output.log(chalk.gray("Tip: Create agent configs in ~/.local/share/roy-bot/agents/"));
        } else {
          output.log([
            `┌─ Agents ${"─".repeat(50)}┐`,
            `│${header}│`,
            "├" + "─".repeat(header.length + 2) + "┤",
            ...rows.map(r => `│${r}│`),
            "└" + "─".repeat(header.length + 2) + "┘",
            "",
            renderPaginationFooter({
              total,
              count: pagedAgents.length,
              offset: page.offset,
              limit: page.limit,
              itemName: "agent",
              extras: args.type && args.type !== "all" ? [`type=${args.type}`] : [],
            }),
          ].join("\n"));
        }
      }
    } catch (error) {
      output.error(`Failed to list agents: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
