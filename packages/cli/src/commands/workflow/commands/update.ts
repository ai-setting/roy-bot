/**
 * @fileoverview Workflow Update Command
 * 
 * Update an existing workflow
 */

import { CommandModule } from 'yargs';
import { EnvironmentService } from '../../../services/environment.service';
import { OutputService } from '../../../services/output.service';
import { renderWorkflowUpdated } from '../renderers';
import chalk from 'chalk';
import fs from 'fs';
import path from 'path';
import type { WorkflowService } from '@ai-setting/roy-bot-core/env/workflow/service';
import { parseWorkflowFile } from '@ai-setting/roy-bot-core/env/workflow/types';

export interface WorkflowUpdateOptions {
  name: string;
  file?: string;
  description?: string;
  tags?: string[];
  taskId?: number;
  config?: string;
}

/**
 * WorkflowUpdateCommand - Update an existing workflow
 */
export const WorkflowUpdateCommand: CommandModule<object, object> = {
  command: 'update <name>',
  describe: '更新已存在的 Workflow',

  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: 'Workflow 名称',
        type: 'string',
        demandOption: true,
      })
      .option('file', {
        alias: 'f',
        describe: 'Workflow 定义文件 (YAML/JSON)',
        type: 'string',
      })
      .option('description', {
        alias: 'd',
        describe: '更新描述',
        type: 'string',
      })
      .option('tags', {
        alias: 't',
        describe: '更新标签（逗号分隔）',
        type: 'string',
      })
      .option('task-id', {
        alias: 'i',
        describe: '更新关联任务 ID',
        type: 'number',
      })
      .option('config', {
        describe: '配置文件路径',
        type: 'string',
      }),

  async handler(args) {
    const a = args as any;
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: a.config });
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
      const existing = service.getWorkflow(a.name);
      if (!existing) {
        output.error(`Workflow not found: ${a.name}`);
        process.exit(1);
      }

      // Prepare updates
      const updates: any = {};

      if (a.description !== undefined) {
        updates.description = a.description;
      }

      if (a.taskId !== undefined) {
        updates.metadata = { ...existing.metadata, taskId: a.taskId };
      }

      if (a.file) {
        const filePath = path.resolve(a.file);
        if (!fs.existsSync(filePath)) {
          output.error(`File not found: ${filePath}`);
          process.exit(1);
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const { definition } = await parseWorkflowFile(content, filePath);
        updates.definition = definition;
      }

      // Parse tags if provided
      const tags = a.tags ? a.tags.split(',').map((t: string) => t.trim()) : undefined;

      // Update workflow
      const workflow = await service.updateWorkflow(a.name, updates, { tags });

      output.log(renderWorkflowUpdated(workflow));
      output.log(chalk.green(`\n✅ Workflow '${a.name}' updated successfully`));
    } catch (error) {
      output.error(`Failed to update workflow: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
