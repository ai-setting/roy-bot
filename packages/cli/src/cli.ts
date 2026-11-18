/**
 * @fileoverview CLI Main Entry
 */

// @ts-ignore - yargs types issue with bundler module resolution
import yargsLib from "yargs";
import { hideBin } from "yargs/helpers";
import { CliQuietModeService } from "./services/quiet-mode.service";
import { getPackageVersion } from "./lib/version";
import { ActCommand } from "./commands/act";
import { InteractiveCommand } from "./commands/run";
import { RunCommand } from "./commands/interactive";
import { ChatCommand } from "./commands/chat";
import { SessionsCommand } from "./commands/sessions/index";
import { TasksCommand } from "./commands/tasks/index";
import { SkillsCommand } from "./commands/skills/index";
import { AgentsCommand } from "./commands/agents/index";
import { PromptCommand } from "./commands/prompt/index";
import { CommandsCommand } from "./commands/commands";
import { ConfigCommand } from "./commands/config";
import { McpCommand } from "./commands/mcp/index";
import { ToolsCommand } from "./commands/tools/index";
import { MemoryCommand } from "./commands/memory/index";
import { EventSourceCommand } from "./commands/eventsource/index";
import { DebugCommand } from "./commands/debug/index";
import { WorkflowCommand } from "./commands/workflow/index";
import { LspCommand } from "./commands/lsp/index";
import { InstallCommand } from "./commands/install/index";
import { FallbackModelCommand } from "./commands/fallback-model";
// ★ Task #5302：事件源磁盘配置管理（/es 斜杆命令的 CLI 前端）
import { EsSlashCommand } from "./commands/es-slash";

/**
 * 全局 quiet 模式 middleware
 *
 * 默认 quiet 开启（减少日志输出），使用以下任一写法关闭 quiet 模式：
 * - --no-quiet        yargs 内置 boolean-negation（推荐）
 * - --noquiet         无连字符形式（用户友好别名）
 * - --quiet=false     显式赋值
 *
 * 检测到任一写法后，将 argv.quiet 置为 false，再由 CliQuietModeService
 * 广播给 core 层（其它进程内组件读取 isQuietMode()）。
 */
function quietModeMiddleware(argv: Record<string, unknown>): void {
  // 统一处理三种关闭 quiet 的写法（详见全局 .option("quiet"/"noquiet")）：
  //   --no-quiet      yargs 内置 boolean-negation → argv.quiet=false
  //   --noquiet       通过全局 .option 注册 → argv.noquiet=true
  //   --quiet=false   显式赋值 → argv.quiet=false
  //
  // 把 argv.noquiet=true 归一化为 argv.quiet=false，便于下游 CliQuietModeService
  // 只看一个字段。
  if (argv.noquiet === true) {
    argv.quiet = false;
    delete argv.noquiet;
  }

  const quietService = CliQuietModeService.getInstance();
  // 当 quiet 为 true（默认；没有传关闭标志）时，激活 quiet 模式。
  if (argv.quiet === true) {
    quietService.setQuiet(true);
  }
}

/**
 * Plugin 帮助信息
 */
const PLUGIN_HELP = `
Plugins:
  coder-harness LSP plugins:
    lsp         Enable all LSP (tslsp + pylsp + mdlsp) - legacy mode
    tslsp       TypeScript/JavaScript LSP (diagnostics, completions)
    pylsp       Python LSP (diagnostics, completions)
    mdlsp       Markdown LSP (diagnostics, wikilink checking)

  ontology-harness plugins:
    ontologylsp Typed Markdown Ontology (markdown LSP + TM001-TM006 constraints)

  coder-harness plugins:
    code-check  External command code checking (linter + type check)
    reminder    Max iterations reminder for ReAct loop

  component plugins:
    task-tag    Task tag suggestion and similar task experience

Examples:
  --plugin tslsp                   Enable TypeScript LSP
  --plugin pylsp                   Enable Python LSP
  --plugin mdlsp                   Enable Markdown LSP
  --plugin tslsp pylsp mdlsp       Enable all LSP plugins
  --plugin ontologylsp             Enable Typed Markdown Ontology checking
  --plugin lsp                     Enable all (legacy mode)
  --plugin code-check              Enable external command checking
  --plugin reminder                Enable iteration reminder
  --plugin tslsp code-check        Enable multiple plugins`;

export async function runCli(): Promise<void> {
  // Task #2687: 优先使用构建时注入的 ROY_AGENT_VERSION define 常量，
  // 确保 compile 模式下 --version 输出与 package.json 一致。
  // fallback 到 package.json 读取（开发模式）。
  const version = getPackageVersion();

  // @ts-ignore - yargs types issue
  const yargs = yargsLib as any;

  await yargs(hideBin(process.argv))
    .scriptName("roy-bot")
    .version(version)
    // 全局 quiet 选项（默认 quiet，使用 --no-quiet 开启日志）
    .option("quiet", {
      describe: "Quiet mode (default: on, use --no-quiet to enable logging)",
      type: "boolean",
      default: true,
      global: true,
    })
    // 全局 --noquiet 别名（无连字符形式）— 显式注册为 boolean 让
    // yargs 在任何位置都能正确识别（避免在 subcommand 前时被 yargs
    // 当作 "value of next flag"）。
    .option("noquiet", {
      type: "boolean",
      description: "Alias for --no-quiet (no hyphen form). Disables quiet mode.",
      global: true,
    })
    // 全局 plugin 选项
    .option("plugin", {
      alias: "p",
      type: "string",
      array: true,
      description: "Enable plugin (e.g., --plugin tslsp, --plugin lsp, --plugin task-tag)",
      global: true,
    })
    // 全局 middleware，在命令执行前设置 quiet 模式
    .middleware(quietModeMiddleware, true)
    .command(ActCommand)
    .command(InteractiveCommand)
    .command(RunCommand)
    .command(ChatCommand)
    .command(SessionsCommand)
    .command(TasksCommand)
    .command(SkillsCommand)
    .command(AgentsCommand)
    .command(PromptCommand)
    .command(CommandsCommand)
    .command(ConfigCommand)
    .command(McpCommand)
    .command(ToolsCommand)
    .command(MemoryCommand)
    .command(EventSourceCommand)
    .command(DebugCommand)
    .command(WorkflowCommand)
    .command(LspCommand)
    .command(InstallCommand)
    // ★ Task #4722：兜底模型管理（command 子系统的 CLI 前端）
    .command(FallbackModelCommand)
    // ★ Task #5302
    .command(EsSlashCommand)
    .demandCommand()
    .help()
    .alias("help", "h")
    .epilog(PLUGIN_HELP)
    .parse();
}
