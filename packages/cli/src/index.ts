/**
 * @roy-bot/cli - CLI for roy-bot
 */

// Re-export for convenience
export { runCli } from "./cli";
export { OutputService } from "./services/output.service";
export { EnvironmentService } from "./services/environment.service";

// Re-export all commands
export { ActCommand, createActCommand } from "./commands/act";
export { InteractiveCommand, createInteractiveCommand } from "./commands/run";
export { SessionsCommand } from "./commands/sessions";
export { TasksCommand } from "./commands/tasks";
export { CommandsCommand } from "./commands/commands";
export { MemoryCommand } from "./commands/memory";
export { SkillsCommand } from "./commands/skills";
export { ToolsCommand } from "./commands/tools";
export { McpCommand } from "./commands/mcp";
export { ConfigCommand } from "./commands/config";
export { DebugCommand } from "./commands/debug";
export { LspCommand } from "./commands/lsp";
export { WorkflowCommand } from "./commands/workflow";
export { EventSourceCommand } from "./commands/eventsource";

// Re-export subcommands and types from ConfigCommand
export {
  ConfigListCommand,
  ConfigExportCommand,
  ConfigImportCommand,
} from "./commands/config";
export type {
  SupportedComponent,
  COMPONENT_DESCRIPTIONS,
} from "./commands/config/types";

// Re-export subcommands from DebugCommand
export {
  LogCommand,
  TraceCommand,
  SpanCommand,
} from "./commands/debug";

// Re-export subcommands from LspCommand
export {
  LspInstallCommand,
  LspListCommand,
  LspCheckCommand,
} from "./commands/lsp";

// Re-export subcommands and types from WorkflowCommand
export {
  WorkflowListCommand,
  WorkflowAddCommand,
  WorkflowGetCommand,
  WorkflowUpdateCommand,
  WorkflowRemoveCommand,
  WorkflowRunCommand,
  WorkflowStopCommand,
  WorkflowStatusCommand,
  WorkflowNodesCommand,
  WorkflowValidateCommand,
} from "./commands/workflow";
export type { WorkflowOptions } from "./commands/workflow";

// Re-export subcommands from EventSourceCommand
export {
  EventSourceListCommand,
  EventSourceAddCommand,
  EventSourceUpdateCommand,
  EventSourceRemoveCommand,
  EventSourceStartCommand,
  EventSourceStopCommand,
  EventSourceStatusCommand,
} from "./commands/eventsource";
