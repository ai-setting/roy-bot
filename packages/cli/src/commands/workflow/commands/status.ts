/**
 * @fileoverview Workflow Status Command
 * 
 * Get workflow run status
 */

import { CommandModule } from 'yargs';
import { EnvironmentService } from '../../../services/environment.service';
import { OutputService } from '../../../services/output.service';
import { renderRunDetail } from '../renderers';
import chalk from 'chalk';
import { createWorkflowRunStatusTool } from '@ai-setting/roy-bot-core/env/workflow/tools';
import type { ToolContext } from '@ai-setting/roy-bot-core/env/tool/types';
import type { WorkflowService } from '@ai-setting/roy-bot-core/env/workflow/service';
import type { WorkflowRun } from '@ai-setting/roy-bot-core/env/workflow/types';

export interface WorkflowStatusOptions {
  runId: string;
  watch?: boolean;
  interval?: number;
  config?: string;
}

/**
 * WorkflowStatusCommand - Get workflow run status
 */
export const WorkflowStatusCommand: CommandModule<object, WorkflowStatusOptions> = {
  command: 'status <runId>',
  describe: '查看 Workflow 运行状态',

  builder: (yargs) =>
    yargs
      .positional('runId', {
        describe: 'Workflow run ID (== session ID, Task #1837)',
        type: 'string',
        demandOption: true,
      })
      .option('watch', {
        alias: 'w',
        describe: '持续监控状态',
        type: 'boolean',
        default: false,
      })
      .option('interval', {
        alias: 'i',
        describe: '监控间隔（毫秒）',
        type: 'number',
        default: 1000,
      })
      .option('config', {
        describe: '配置文件路径',
        type: 'string',
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
      const workflowComponent = env.getComponent('workflow') as any;

      if (!workflowComponent) {
        output.error('WorkflowComponent not available');
        process.exit(1);
      }

      const service = workflowComponent.getService() as WorkflowService;

      // Create workflow_run_status tool
      const tool = createWorkflowRunStatusTool(service);

      if (args.watch) {
        // Watch mode
        let lastStatus = '';
        while (true) {
          const result = await tool.execute({ run_id: args.runId }, {} as ToolContext);
          if (!result.success) {
            output.error(result.error || `Run not found: ${args.runId}`);
            process.exit(1);
          }

          const data = JSON.parse(result.output) as Record<string, any>;
          const status = data.status;

          if (status !== lastStatus) {
            const run: WorkflowRun = {
              id: data.run_id,
              workflowId: data.workflow_id || '',
              workflowName: data.workflow_name,
              status,
              startedAt: data.created_at ? new Date(data.created_at) : undefined,
              debugMode: false,
            };
            output.log(renderRunDetail(run));
            lastStatus = status;
          }

          // Check if terminal state
          if (['completed', 'failed', 'stopped'].includes(status)) {
            break;
          }

          // Wait for next check
          await new Promise(resolve => setTimeout(resolve, args.interval));
        }
      } else {
        // Single status check
        const result = await tool.execute({ run_id: args.runId }, {} as ToolContext);
        if (!result.success) {
          output.error(result.error || `Run not found: ${args.runId}`);
          process.exit(1);
        }

        const data = JSON.parse(result.output) as Record<string, any>;
        const status = data.status;

        const run: WorkflowRun = {
          id: data.run_id,
          workflowId: data.workflow_id || '',
          workflowName: data.workflow_name,
          status,
          startedAt: data.created_at ? new Date(data.created_at) : undefined,
          debugMode: false,
        };
        output.log(renderRunDetail(run));

        // Show status emoji
        const statusEmoji: Record<string, string> = {
          idle: '⏸️',
          running: '🔄',
          paused: '⏸️',
          completed: '✅',
          failed: '❌',
          stopped: '⏹️',
        };
        const emoji = statusEmoji[status] || '❓';
        output.log(chalk.bold(`\n${emoji} Status: ${status.toUpperCase()}`));
      }
    } catch (error) {
      output.error(`Failed to get workflow status: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
