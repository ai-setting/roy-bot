/**
 * @fileoverview Workflow Search Command
 *
 * Search workflows by keyword + multiple tags (AND filter).
 *
 * Examples:
 *   roy-bot workflow search --keyword "ai"
 *   roy-bot workflow search --tag ai
 *   roy-bot workflow search --tag ai --tag cli
 *   roy-bot workflow search --keyword "ai" --tag ml --tag etl
 *
 * v2: returns `available_tags` from the workflow_tags table.
 */

import { CommandModule } from 'yargs';
import { EnvironmentService } from '../../../services/environment.service';
import { OutputService } from '../../../services/output.service';
import { renderWorkflowList } from '../renderers';
import chalk from 'chalk';
import { wrapFunction } from '@ai-setting/roy-bot-core';
import type { WorkflowService } from '@ai-setting/roy-bot-core/env/workflow/service';
import type { Workflow } from '@ai-setting/roy-bot-core/env/workflow/types';

export interface WorkflowSearchOptions {
  keyword?: string;
  tag?: string[];
  limit?: number;
  offset?: number;
  json?: boolean;
  yaml?: boolean;
  config?: string;
}

/**
 * WorkflowSearchCommand - Search workflows by keyword and/or tags
 */
export const WorkflowSearchCommand: CommandModule<object, WorkflowSearchOptions> = {
  command: 'search',
  describe: 'Search workflows by keyword and/or tags (multiple tags use AND filter). v2: returns available_tags.',

  builder: (yargs) =>
    yargs
      .option('keyword', {
        alias: 'k',
        describe: 'Search keyword in name and description',
        type: 'string',
      })
      .option('tag', {
        alias: 't',
        describe: 'Filter by tag (can be specified multiple times for AND filter)',
        type: 'array',
        string: true,
      })
      .option('limit', {
        alias: 'l',
        describe: 'Maximum number of results',
        type: 'number',
        default: 50,
      })
      .option('offset', {
        alias: 'o',
        describe: 'Pagination offset',
        type: 'number',
        default: 0,
      })
      .option('json', {
        alias: 'j',
        describe: 'Output as JSON',
        type: 'boolean',
        default: false,
      })
      .option('yaml', {
        alias: 'y',
        describe: 'Output as YAML',
        type: 'boolean',
        default: false,
      })
      .option('config', {
        describe: 'Config file path',
        type: 'string',
      })
      .check((argv) => {
        const hasKeyword = typeof argv.keyword === 'string' && argv.keyword.length > 0;
        const hasTags = Array.isArray(argv.tag) && argv.tag.length > 0;
        if (!hasKeyword && !hasTags) {
          throw new Error('At least one of --keyword or --tag must be provided');
        }
        if (Array.isArray(argv.tag)) {
          for (const t of argv.tag) {
            if (typeof t !== 'string' || t.length === 0) {
              throw new Error('Empty tag values are not allowed');
            }
            if (t.length > 50) {
              throw new Error(`Tag "${t}" exceeds 50 characters`);
            }
            if (t.includes(',')) {
              throw new Error(
                `Tag "${t}" contains comma; pass them as separate --tags`
              );
            }
          }
        }
        return true;
      }),

  async handler(args) {
    const a = args as any;
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await runWorkflowSearch({
        keyword: a.keyword,
        tags: a.tag as string[] | undefined,
        limit: a.limit,
        offset: a.offset,
        asJson: a.json,
        asYaml: a.yaml,
        configPath: a.config,
        output,
        envService,
      });
    } catch (error) {
      output.error(`Failed to search workflows: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};

/**
 * Search handler extracted for testability
 */
export interface WorkflowSearchHandlerOptions {
  keyword?: string;
  tags?: string[];
  limit?: number;
  offset?: number;
  asJson?: boolean;
  asYaml?: boolean;
  configPath?: string;
  output: OutputService;
  envService: EnvironmentService;
}

/**
 * Core search implementation (traced via wrapFunction)
 */
const _runWorkflowSearchImpl = async function (
  opts: WorkflowSearchHandlerOptions
): Promise<void> {
  const { keyword, tags, limit, offset, asJson, asYaml, configPath, output, envService } = opts;

  await envService.create({ configPath });
  const env = envService.getEnvironment();
  if (!env) {
    output.error('Failed to create environment');
    process.exit(1);
  }

  const workflowComponent = env.getComponent('workflow') as any;
  if (!workflowComponent) {
    output.error('WorkflowComponent not available');
    process.exit(1);
  }

  const service = workflowComponent.getService() as WorkflowService;
  if (!service) {
    output.error(
      'WorkflowService not initialized. Please run "roy-bot workflow init" first.'
    );
    process.exit(1);
  }

  // v2: use searchWorkflowsWithTags to also get available_tags from tag table
  const useWithTags = typeof (service as any).searchWorkflowsWithTags === 'function';
  const result = useWithTags
    ? await (service as any).searchWorkflowsWithTags({
        keyword,
        tags,
        limit,
        offset,
      })
    : {
        workflows: service.searchWorkflows({ keyword, tags, limit, offset }),
        available_tags: [],
      };

  const workflows: Workflow[] = result.workflows ?? [];
  const availableTags = result.available_tags ?? [];

  if (asJson) {
    output.json({
      total: workflows.length,
      available_tags: availableTags,
      keyword,
      workflows: workflows.map((w: Workflow) => ({
        name: w.name,
        version: w.version,
        description: w.description,
        tags: w.tags,
        createdAt: w.createdAt,
        updatedAt: w.updatedAt,
      })),
      tags,
    });
    return;
  }

  if (asYaml) {
    const yaml = await import('yaml');
    output.log(
      yaml.stringify({
        workflows: workflows.map((w: Workflow) => ({
          name: w.name,
          version: w.version,
          description: w.description,
          tags: w.tags,
        })),
        available_tags: availableTags,
        total: workflows.length,
        keyword,
        tags,
      })
    );
    return;
  }

  // Map Workflows to render-friendly objects
  const renderWorkflows: any[] = workflows.map((w: Workflow) => ({
    id: w.name,
    name: w.name,
    version: w.version,
    description: w.description,
    tags: w.tags || [],
    createdAt: w.createdAt ? new Date(w.createdAt) : new Date(),
    updatedAt: w.updatedAt ? new Date(w.updatedAt) : new Date(),
    definition: { nodes: [], config: {}, inputs: {} as Record<string, any> },
    metadata: {} as Record<string, any>,
  }));

  if (renderWorkflows.length === 0) {
    output.log(chalk.yellow('🔍 No workflows matched the search criteria.'));
    output.log(chalk.gray(`   keyword: ${keyword || '(none)'}`));
    output.log(
      chalk.gray(
        `   tags: ${tags && tags.length > 0 ? tags.join(', ') : '(none)'}`
      )
    );
  } else {
    output.log(chalk.bold(`🔍 Search results (${renderWorkflows.length}):`));
    output.log(renderWorkflowList(renderWorkflows));
    output.log(chalk.green(`\n✅ Found ${renderWorkflows.length} workflow(s)`));
  }

  // v2: Show available tags section if any
  if (availableTags.length > 0) {
    output.log('');
    output.log(chalk.bold('📚 Available tags (sorted by usage_count):'));
    for (const t of availableTags) {
      const name = t.name ?? (t as any).tag;
      const count = t.count ?? t.usage_count;
      output.log(chalk.gray(`   - ${name} (${count})`));
    }
  }
};

/**
 * Traced wrapper for runWorkflowSearch.
 * Exposed as named export so callers can use it directly.
 */
export const runWorkflowSearch = wrapFunction(
  _runWorkflowSearchImpl,
  'workflow.cli.search',
  {
    recordParams: true,
    recordResult: false,
    log: false,
  }
);
