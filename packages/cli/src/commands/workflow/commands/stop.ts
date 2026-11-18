/**
 * @fileoverview Workflow Stop Command
 * 
 * Stop a running or paused workflow
 */

import { CommandModule } from 'yargs';
import { EnvironmentService } from '../../../services/environment.service';
import { OutputService } from '../../../services/output.service';
import chalk from 'chalk';
import { createWorkflowRunStopTool } from '@ai-setting/roy-bot-core/env/workflow/tools';
import type { ToolContext } from '@ai-setting/roy-bot-core/env/tool/types';
import type { WorkflowService, SessionInfo } from '@ai-setting/roy-bot-core/env/workflow/service';
import { wrapFunction } from '@ai-setting/roy-bot-core';

export interface WorkflowStopOptions {
  runId: string;
  config?: string;
}

/**
 * Stop workflow implementation
 */
const stopWorkflow = wrapFunction(
  async function stopWorkflowImpl(args: WorkflowStopOptions): Promise<void> {
  const output = new OutputService();
  const envService = new EnvironmentService(output);

  try {
    await envService.create({ configPath: args.config });
    const env = envService.getEnvironment();
    if (!env) {
      output.error("Failed to create environment");
      process.exit(1);
    }
    const workflowComponent = env.getComponent('workflow') as any;

    if (!workflowComponent) {
      output.error('WorkflowComponent not available');
      process.exit(1);
    }

    const service = workflowComponent.getService() as WorkflowService;

    // Use workflow_run_stop tool for validation and execution
    const tool = createWorkflowRunStopTool(service);
    const result = await tool.execute({ run_id: args.runId }, {} as ToolContext);

    if (!result.success) {
      output.error(result.error || `Failed to stop workflow: ${args.runId}`);
      process.exit(1);
    }

    output.log(chalk.red(`\n⏹️  Workflow stopped: ${args.runId}`));
  } catch (error) {
    output.error(`Failed to stop workflow: ${error}`);
    process.exit(1);
  } finally {
    await envService.dispose();
  }
},
  "workflow.cli.stop",
  { recordParams: true, recordResult: true, log: true }
);

/**
 * WorkflowStopCommand - Stop a running or paused workflow
 */
export const WorkflowStopCommand: CommandModule<object, WorkflowStopOptions> = {
  command: 'stop <runId>',
  describe: '停止运行中的 Workflow',

  builder: (yargs) =>
    yargs
      .positional('runId', {
        describe: 'Workflow run ID (== session ID, Task #1837)',
        type: 'string',
        demandOption: true,
      })
      .option('config', {
        describe: '配置文件路径',
        type: 'string',
      }),

  handler: stopWorkflow,
};
