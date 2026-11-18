/**
 * @fileoverview Workflow Get Command
 * 
 * Get workflow or run details
 */

import { CommandModule } from 'yargs';
import { EnvironmentService } from '../../../services/environment.service';
import { OutputService } from '../../../services/output.service';
import { renderWorkflowDetail, renderRunDetail, renderNodesList } from '../renderers';
import chalk from 'chalk';
import { createWorkflowGetTool } from '@ai-setting/roy-bot-core/env/workflow/tools';
import type { ToolContext } from '@ai-setting/roy-bot-core/env/tool/types';
import type { WorkflowService, SessionInfo } from '@ai-setting/roy-bot-core/env/workflow/service';
import type { WorkflowRun } from '@ai-setting/roy-bot-core/env/workflow/types';

export interface WorkflowGetOptions {
  identifier: string;
  runId?: boolean;
  includeNodes?: boolean;
  includeRuns?: boolean;
  json?: boolean;
  yaml?: boolean;
  config?: string;
}

/**
 * WorkflowGetCommand - Get workflow or run details
 */
export const WorkflowGetCommand: CommandModule<object, WorkflowGetOptions> = {
  command: 'get <identifier>',
  describe: '获取 Workflow 或 Run 详情',

  builder: (yargs) =>
    yargs
      .positional('identifier', {
        describe: 'Workflow 名称或 Run ID (Task #1837: runId == sessionId)',
        type: 'string',
        demandOption: true,
      })
      .option('run-id', {
        describe: '将 identifier 作为 Run ID 处理',
        type: 'boolean',
        default: false,
      })
      .option('include-nodes', {
        describe: '显示节点详情',
        type: 'boolean',
        default: false,
      })
      .option('include-runs', {
        describe: '包含运行历史',
        type: 'boolean',
        default: false,
      })
      .option('json', {
        alias: 'j',
        describe: 'JSON 格式输出',
        type: 'boolean',
        default: false,
      })
      .option('yaml', {
        alias: 'y',
        describe: 'YAML 格式输出',
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

      // Create workflow_get tool
      const tool = createWorkflowGetTool(service);

      // Determine if this is a run ID
      // Task #1837: runIds now start with `workflow_` natively. Workflow
      // names typically don't start with `workflow_` (e.g. `strict-task-agent`,
      // `bench-agent-host`), so we still rely on the explicit `--run-id`
      // flag or the legacy `workflow_run_xxx` double-prefix format for
      // automatic detection. The legacy `run_xxx` format is no longer
      // produced by the engine but kept here for backward compat with
      // older session IDs that may still exist in storage.
      const isRunId = args.runId ||
        args.identifier.startsWith('workflow_run_') ||
        args.identifier.startsWith('workflow_') ||
        args.identifier.startsWith('run_');

      if (isRunId) {
        // Use workflow_get tool with run_id
        const result = await tool.execute({ run_id: args.identifier }, {} as ToolContext);

        if (!result.success) {
          output.error(result.error || `Run not found: ${args.identifier}`);
          process.exit(1);
        }

        const data = JSON.parse(result.output) as Record<string, any>;

        if (args.json) {
          output.json({
            run: {
              id: data.run_id,
              workflowId: data.workflow_id,
              status: data.status,
              input: data.input,
              startedAt: data.created_at,
            },
          });
        } else {
          const run: WorkflowRun = {
            id: data.run_id,
            workflowId: data.workflow_id || '',
            workflowName: data.workflow_name,
            status: data.status,
            input: data.input,
            startedAt: data.created_at ? new Date(data.created_at) : undefined,
            debugMode: false,
          };
          output.log(renderRunDetail(run));
        }
      } else {
        // Use workflow_get tool with name
        const result = await tool.execute({ name: args.identifier }, {} as ToolContext);

        if (!result.success) {
          output.error(result.error || `Workflow not found: ${args.identifier}`);
          process.exit(1);
        }

        const data = JSON.parse(result.output) as Record<string, any>;

        // Build Workflow-like object for renderers
        const workflow = {
          id: data.name,
          name: data.name,
          version: data.version,
          description: data.description,
          tags: data.tags || [],
          createdAt: data.created_at ? new Date(data.created_at) : new Date(),
          updatedAt: data.updated_at ? new Date(data.updated_at) : new Date(),
          definition: data.definition || { inputs: {}, nodes: [], config: {} },
          metadata: {} as Record<string, any>,
        };

        // Get runs if requested (using listSessions since runs are now sessions)
        let sessionRuns: SessionInfo[] = [];
        if (args.includeRuns) {
          sessionRuns = await service.listSessions({ limit: 5 });
          // Filter runs for this workflow
          sessionRuns = sessionRuns.filter(r => 
            (r.metadata as any).workflowName === workflow.name
          );
        }

        // Convert SessionInfo[] to WorkflowRun[] for renderer
        const runs: WorkflowRun[] = sessionRuns.map(r => {
          const m = r.metadata as any;
          return {
            id: r.id,
            workflowId: m.workflowId || '',
            workflowName: m.workflowName || workflow.name,
            status: m.status,
            startedAt: r.createdAt,
            debugMode: false,
          };
        });

        if (args.json) {
          output.json({
            workflow: {
              id: workflow.name,
              name: workflow.name,
              version: workflow.version,
              description: workflow.description,
              definition: workflow.definition,
              tags: workflow.tags,
              createdAt: workflow.createdAt.toISOString(),
              updatedAt: workflow.updatedAt.toISOString(),
            },
            runs: runs.map(r => ({
              id: r.id,
              status: r.status,
              startedAt: r.startedAt?.toISOString(),
              workflowId: r.workflowId,
            })),
          });
        } else {
          output.log(renderWorkflowDetail(workflow as any, { includeRuns: runs }));

          // Show nodes if requested
          if (args.includeNodes) {
            output.log(chalk.bold('\n📋 All Nodes:'));
            output.log(renderNodesList(data.nodes || []));
          }

          // Render full definition as YAML
          const yaml = await import('yaml');
          const defYaml = yaml.stringify(data.definition || {}, { indent: 2 });
          output.log(chalk.bold('\n📄 Definition (YAML):'));
          output.log(chalk.gray(defYaml));
        }
      }
    } catch (error) {
      output.error(`Failed to get workflow: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
