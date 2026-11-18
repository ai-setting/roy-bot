/**
 * @fileoverview Workflow Remove Command
 * 
 * Delete a workflow
 */

import { CommandModule } from 'yargs';
import { EnvironmentService } from '../../../services/environment.service';
import { OutputService } from '../../../services/output.service';
import { renderWorkflowDeleted } from '../renderers';
import chalk from 'chalk';
import type { WorkflowService } from '@ai-setting/roy-bot-core/env/workflow/service';

export interface WorkflowRemoveOptions {
  name: string;
  force?: boolean;
  config?: string;
}

/**
 * WorkflowRemoveCommand - Delete a workflow
 */
export const WorkflowRemoveCommand: CommandModule<object, WorkflowRemoveOptions> = {
  command: 'remove <name>',
  describe: '删除 Workflow',

  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: 'Workflow 名称',
        type: 'string',
        demandOption: true,
      })
      .option('force', {
        alias: 'f',
        describe: '强制删除（不确认）',
        type: 'boolean',
        default: false,
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

      // Check if workflow exists
      const existing = service.getWorkflow(args.name);
      if (!existing) {
        output.error(`Workflow not found: ${args.name}`);
        process.exit(1);
      }

      // Confirm deletion if not forced
      if (!args.force) {
        output.log(chalk.yellow(`Are you sure you want to delete workflow '${args.name}'?`));
        output.log(chalk.gray('Use --force to skip confirmation'));
        process.exit(1);
      }

      // Delete workflow
      const deleted = await service.deleteWorkflow(args.name);
      if (!deleted) {
        output.error(`Failed to delete workflow: ${args.name}`);
        process.exit(1);
      }

      output.log(renderWorkflowDeleted(args.name));
    } catch (error) {
      output.error(`Failed to delete workflow: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
