/**
 * @fileoverview Workflow Command - Main entry point
 * 
 * Workflow DAG management and execution CLI commands
 * 
 * Note: Resume functionality is unified into `workflow run -s <sessionId>`.
 * Use `workflow run -s <sessionId> --input "response"` to resume a paused workflow.
 */

import { CommandModule } from 'yargs';
import { WorkflowListCommand } from './commands/list';
import { WorkflowAddCommand } from './commands/add';
import { WorkflowGetCommand } from './commands/get';
import { WorkflowUpdateCommand } from './commands/update';
import { WorkflowRemoveCommand } from './commands/remove';
import { WorkflowRunCommand } from './commands/run';
import { WorkflowStopCommand } from './commands/stop';
import { WorkflowStatusCommand } from './commands/status';
import { WorkflowNodesCommand } from './commands/nodes';
import { WorkflowValidateCommand } from './commands/validate';
import { WorkflowSearchCommand } from './commands/search';
import { WorkflowTagListCommand, WorkflowTagGetCommand } from './commands/tag';

/**
 * WorkflowTagCommand - Parent command for `workflow tag <subcommand>`
 * Groups `tag list` and `tag get` under a single `workflow tag` command.
 */
const WorkflowTagCommand = {
  command: 'tag',
  describe: 'Manage workflow tags — list and get from the workflow_tags table. Use BEFORE `workflow add` to discover existing tags.',
  builder: (yargs: any) =>
    yargs
      .command(WorkflowTagListCommand)
      .command(WorkflowTagGetCommand)
      .demandCommand(1, '请指定 tag 子命令：list 或 get <name>')
      .help(),
  handler() {},
};

export interface WorkflowOptions {
  command?: string;
}

/**
 * WorkflowCommand - Workflow DAG management
 */
export const WorkflowCommand: CommandModule<object, WorkflowOptions> = {
  command: 'workflow',
  describe: 'Workflow DAG management and execution - create, run, and monitor workflows',

  builder: (yargs) =>
    yargs
      .command(WorkflowListCommand)
      .command(WorkflowAddCommand)
      .command(WorkflowSearchCommand)
      .command(WorkflowTagCommand)
      .command(WorkflowNodesCommand)
      .command(WorkflowValidateCommand)
      .command(WorkflowGetCommand)
      .command(WorkflowUpdateCommand)
      .command(WorkflowRemoveCommand)
      .command(WorkflowRunCommand)
      .command(WorkflowStopCommand)
      .command(WorkflowStatusCommand)
      .demandCommand(1, '请指定子命令：list、add、search、tag、validate、nodes、get、update、remove、run、stop、status\n\nResume: 使用 `workflow run -s <sessionId>` 恢复暂停的工作流')
      .help(),

  handler() {
    // Default to help (handled by yargs demandCommand)
  },
};

// Export subcommands
export {
  WorkflowListCommand,
  WorkflowAddCommand,
  WorkflowSearchCommand,
  WorkflowTagListCommand,
  WorkflowTagGetCommand,
  WorkflowGetCommand,
  WorkflowUpdateCommand,
  WorkflowRemoveCommand,
  WorkflowRunCommand,
  WorkflowStopCommand,
  WorkflowStatusCommand,
  WorkflowNodesCommand,
  WorkflowValidateCommand,
};
