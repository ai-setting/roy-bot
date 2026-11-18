/**
 * @fileoverview Workflow Tag Commands (v3)
 *
 * Manage the workflow tag pool.
 *
 * Subcommands (registered directly into workflow CLI):
 *   - `workflow tag list [--sort-by] [--order] [--limit] [--json]` — list all tags
 *   - `workflow tag get <name> [--json]`                          — show one tag
 *
 * Soft-prompt purpose: when running `workflow add`, prefer tags from the pool
 * returned by `workflow tag list` to maintain semantic consistency.
 */

import { CommandModule } from 'yargs';
import { EnvironmentService } from '../../../services/environment.service';
import { OutputService } from '../../../services/output.service';
import { wrapFunction } from '@ai-setting/roy-bot-core';
import type { WorkflowService } from '@ai-setting/roy-bot-core/env/workflow/service';
import chalk from 'chalk';

// ============== Types ==============

export interface WorkflowTagListOptions {
  sortBy?: string;
  order?: string;
  limit?: number;
  json?: boolean;
  config?: string;
}

export interface WorkflowTagGetOptions {
  name: string;
  json?: boolean;
  config?: string;
}

export interface WorkflowTagListHandlerOptions {
  sortBy?: 'usage_count' | 'name' | 'created_at';
  order?: 'asc' | 'desc';
  limit?: number;
  asJson?: boolean;
  configPath?: string;
  output: OutputService;
  envService: EnvironmentService;
}

export interface WorkflowTagGetHandlerOptions {
  name: string;
  asJson?: boolean;
  configPath?: string;
  output: OutputService;
  envService: EnvironmentService;
}

export interface TagRow {
  name: string;
  usage_count: number;
  created_at: string;
  updated_at: string;
}

// ============== `workflow tag list` ==============

export const WorkflowTagListCommand: CommandModule<object, WorkflowTagListOptions> = {
  command: 'list',
  describe:
    'List all workflow tags from the workflow_tags table (sorted by usage_count DESC by default). Use this BEFORE `workflow add` to discover existing tags and reuse them for semantic consistency.',
  builder: (yargs) =>
    yargs
      .option('sort-by', {
        describe: 'Sort field',
        choices: ['usage_count', 'name', 'created_at'] as const,
        default: 'usage_count',
      })
      .option('order', {
        describe: 'Sort order',
        choices: ['asc', 'desc'] as const,
        default: 'desc',
      })
      .option('limit', {
        describe: 'Max number of tags to return',
        type: 'number',
        default: 100,
      })
      .option('json', {
        alias: 'j',
        describe: 'Output as JSON',
        type: 'boolean',
        default: false,
      })
      .option('config', {
        describe: 'Config file path',
        type: 'string',
      }),
  async handler(args) {
    const a = args as any;
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await runWorkflowTagList({
        sortBy: a.sortBy,
        order: a.order,
        limit: a.limit,
        asJson: a.json,
        configPath: a.config,
        output,
        envService,
      });
    } catch (error) {
      output.error(`Failed to list workflow tags: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};

// ============== `workflow tag get` ==============

export const WorkflowTagGetCommand: CommandModule<object, WorkflowTagGetOptions> = {
  command: 'get <name>',
  describe:
    'Get details of a single workflow tag (usage_count, created_at, updated_at). Returns error if tag not in the workflow_tags table.',
  builder: (yargs) =>
    yargs
      .positional('name', {
        describe: 'Tag name',
        type: 'string',
      })
      .option('json', {
        alias: 'j',
        describe: 'Output as JSON',
        type: 'boolean',
        default: false,
      })
      .option('config', {
        describe: 'Config file path',
        type: 'string',
      })
      .check((argv) => {
        if (typeof argv.name !== 'string' || argv.name.length === 0) {
          throw new Error('Tag name is required');
        }
        if (argv.name.length > 50) {
          throw new Error(`Tag name exceeds 50 characters`);
        }
        return true;
      }),
  async handler(args) {
    const a = args as any;
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await runWorkflowTagGet({
        name: a.name,
        asJson: a.json,
        configPath: a.config,
        output,
        envService,
      });
    } catch (error) {
      output.error(`Failed to get tag: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};

// ============== Traced Core Implementations ==============

const _runWorkflowTagListImpl = async function (
  opts: WorkflowTagListHandlerOptions
): Promise<void> {
  const { output, envService } = opts;

  await envService.create({ configPath: opts.configPath });
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

  const result = await callListTags(service, {
    sortBy: opts.sortBy ?? 'usage_count',
    order: opts.order ?? 'desc',
    limit: opts.limit ?? 100,
  });

  if (opts.asJson) {
    output.json({
      total: result.total,
      tags: result.tags,
    });
    return;
  }

  if (result.tags.length === 0) {
    output.log(chalk.yellow('🏷️  No tags in the workflow_tags table yet.'));
    output.log(
      chalk.gray(
        '   Tags are created automatically when you run `workflow add --tags <name>`.'
      )
    );
    return;
  }

  output.log(chalk.bold(`🏷️  Workflow tags (${result.total}):`));
  output.log(
    chalk.gray(
      `   ${padRight('NAME', 24)}${padRight('USAGE', 8)}${padRight('CREATED', 22)}`
    )
  );
  for (const t of result.tags) {
    const line = `   ${padRight(t.name, 24)}${padRight(
      String(t.usage_count),
      8
    )}${padRight(formatDate(t.created_at), 22)}`;
    output.log(line);
  }
  output.log(
    chalk.gray(
      `\n💡 Tip: when adding a new workflow, prefer tags from this list to ensure semantic consistency.`
    )
  );
};

const _runWorkflowTagGetImpl = async function (
  opts: WorkflowTagGetHandlerOptions
): Promise<void> {
  const { output, envService } = opts;

  await envService.create({ configPath: opts.configPath });
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

  const tag = callGetTag(service, opts.name);

  if (!tag) {
    if (opts.asJson) {
      output.json({ error: 'Tag not found', name: opts.name });
    } else {
      output.error(`Tag "${opts.name}" not found in the workflow_tags table.`);
      output.log(
        chalk.gray(
          `Tip: run \`roy-bot workflow tag list\` to see available tags.`
        )
      );
    }
    process.exitCode = 1;
    return;
  }

  if (opts.asJson) {
    output.json(tag);
    return;
  }

  output.log(chalk.bold(`🏷️  Tag: ${tag.name}`));
  output.log(chalk.gray(`   usage_count: ${tag.usage_count}`));
  output.log(chalk.gray(`   created_at:  ${tag.created_at}`));
  output.log(chalk.gray(`   updated_at:  ${tag.updated_at}`));
};

// ============== Helpers ==============

async function callListTags(
  service: WorkflowService,
  options: {
    sortBy: 'usage_count' | 'name' | 'created_at';
    order: 'asc' | 'desc';
    limit: number;
  }
): Promise<{ tags: TagRow[]; total: number }> {
  if (typeof (service as any).listTags !== 'function') {
    return { tags: [], total: 0 };
  }
  return await (service as any).listTags(options);
}

function callGetTag(service: WorkflowService, name: string): TagRow | undefined {
  if (typeof (service as any).getTag !== 'function') {
    return undefined;
  }
  return (service as any).getTag(name);
}

function padRight(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width - 1) + ' ';
  return str + ' '.repeat(width - str.length);
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return iso;
  }
}

// ============== Traced Public Entry Points ==============

export const runWorkflowTagList = wrapFunction(
  _runWorkflowTagListImpl,
  'workflow.cli.tag.list',
  {
    recordParams: true,
    recordResult: false,
    log: false,
  }
);

export const runWorkflowTagGet = wrapFunction(
  _runWorkflowTagGetImpl,
  'workflow.cli.tag.get',
  {
    recordParams: true,
    recordResult: false,
    log: false,
  }
);