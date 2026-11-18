/**
 * @fileoverview Workflow List Command
 *
 * List all registered workflows
 *
 * JSON output shape (Code Review S-4 polish):
 *   {
 *     "total":          <number>,         // FIRST so it survives tail-truncation
 *     "count":          <number>,
 *     "truncated":      <boolean>,        // total > count
 *     "limit":          <number>,         // requested page size
 *     "offset":         <number>,         // resolved offset (page-aware)
 *     "page":           <number>,         // 1-based page number
 *     "available_tags": [...],            // LAST among the metadata block
 *     "workflows":      [...]             // LAST so the array is the truncation target
 *   }
 *
 * The JSON construction lives in `buildListWorkflowsJson` so it can be
 * unit-tested directly (mirror of `tasks/_build-list-json.ts`). Keep this
 * shape in sync with:
 *   - packages/core/src/env/workflow/tools/list-tool.ts (tool path)
 */

import { CommandModule } from 'yargs';
import { EnvironmentService } from '../../../services/environment.service';
import { OutputService } from '../../../services/output.service';
import { renderWorkflowList } from '../renderers';
import { renderQuietHeader, renderQuietLine, renderQuietPaginationHint } from '../../shared/list-output';
import chalk from 'chalk';
import { createWorkflowListTool } from '@ai-setting/roy-bot-core/env/workflow/tools';
import type { ToolContext } from '@ai-setting/roy-bot-core/env/tool/types';
import type { WorkflowService } from '@ai-setting/roy-bot-core/env/workflow/service';

/**
 * CLI-facing shape of a single workflow in JSON output.
 * Independent of the tool-path shape so the CLI command can keep its own
 * surface stable.
 */
export interface ListWorkflowJson {
  name: string;
  version: string;
  description: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/**
 * Summary entry for `available_tags` in JSON output.
 * Mirrors the tool-path shape: `{ name, count }`.
 */
export interface AvailableTagJson {
  name: string;
  count: number;
}

/**
 * Pagination + position args accepted by `buildListWorkflowsJson`.
 */
export interface ListWorkflowsJsonArgs {
  limit: number;
  offset: number;
  page: number;
}

/**
 * Top-level JSON output for `workflow list --json`.
 *
 * IMPORTANT: key ordering is part of the public contract (matched by
 * unit tests in `list.test.ts`). The same contract is enforced
 * statically by the `local/list-output-json-key-order` ESLint rule.
 *
 *   - `total` MUST be first so it survives downstream tail-truncation.
 *   - `workflows` MUST be last so the array is the truncation target.
 *   - `available_tags` is part of the metadata block (between `page`
 *     and `workflows`), giving consumers a hint about what filter
 *     values are valid.
 */
export interface ListWorkflowsJsonOutput {
  total: number;
  count: number;
  truncated: boolean;
  limit: number;
  offset: number;
  page: number;
  available_tags?: AvailableTagJson[];
  workflows: ListWorkflowJson[];
}

/**
 * Build the JSON output object for `workflow list --json`.
 *
 * Pure function — does NOT touch OutputService or stdout; the caller
 * wraps it in `output.json(...)`. This split mirrors the
 * `tasks/_build-list-json.ts` pattern and lets us unit-test the
 * structure without spinning up a CLI subprocess.
 *
 * @param workflows     - The paginated workflows returned by the tool path.
 * @param total         - The total count of matching workflows BEFORE pagination.
 * @param args          - The resolved pagination args (`limit`, `offset`, `page`).
 * @param availableTags - Tag pool summary (optional; pass `[]` for none).
 */
export function buildListWorkflowsJson(
  workflows: ListWorkflowJson[],
  total: number,
  args: ListWorkflowsJsonArgs,
  availableTags: AvailableTagJson[],
): ListWorkflowsJsonOutput {
  // IMPORTANT: `total` is first so it survives downstream tail-truncation.
  const output: ListWorkflowsJsonOutput = {
    total,
    count: workflows.length,
    truncated: total > workflows.length,
    limit: args.limit,
    offset: args.offset,
    page: args.page,
    // `available_tags` lives in the metadata block. Inserted only when
    // non-empty so the JSON doesn't carry a no-op field.
    ...(availableTags.length > 0 ? { available_tags: availableTags } : {}),
    // IMPORTANT: `workflows` is last so it's the truncation target, not
    // the summary metadata that precedes it.
    workflows,
  };
  return output;
}

export interface WorkflowListOptions {
  tag?: string | string[];
  taskId?: number;
  search?: string;
  limit?: number;
  offset?: number;
  page?: number;        // v4: 1-based page number (alternative to --offset)
  pageSize?: number;    // v4: alias for --limit
  json?: boolean;
  yaml?: boolean;
  quiet?: boolean;      // inherited from global --quiet
  config?: string;
}

/**
 * WorkflowListCommand - List workflows
 */
export const WorkflowListCommand: CommandModule<object, WorkflowListOptions> = {
  command: 'list',
  describe: '列出所有已注册的 Workflow',

  builder: (yargs) =>
    yargs
      .option('tag', {
        alias: 't',
        describe: '按标签筛选（可多次 --tag ai --tag cli 表示 AND）',
        type: 'string',
      })
      .option('task-id', {
        alias: 'i',
        describe: '按关联任务 ID 筛选',
        type: 'number',
      })
      .option('search', {
        alias: 's',
        describe: '搜索 description 和 tags（支持 AND/OR/NOT 语法）',
        type: 'string',
      })
      .option('limit', {
        // Aliases: -l (legacy), -n (CLI-wide unified). Both point at
        // --limit so existing scripts using -l keep working while new
        // callers can use -n to match the rest of the CLI surface.
        // Default = 20 to match PAGINATION_OPTIONS (Task #1818 unification).
        // Note: previous default was 50 (kept here for legacy workflows list only).
        alias: ['l', 'n'], // -l legacy (backward-compat), -n unified CLI-wide
        describe: '返回数量限制（-l 旧 alias, -n 新统一 alias）',
        type: 'number',
        default: 20,  // 与 PAGINATION_OPTIONS 一致
      })
      .option('offset', {
        alias: 'o',
        describe: '分页偏移',
        type: 'number',
        default: 0,
      })
      .option('page', {
        describe: '页码（1-based，与 --page-size 配合；与 --offset 互斥）',
        type: 'number',
        default: 1,
      })
      .option('page-size', {
        describe: '每页大小（与 --page 配合；等价于 --limit）',
        type: 'number',
      })
      .check((argv) => {
        if (typeof argv.page === 'number' && argv.page < 1) {
          throw new Error('--page must be >= 1');
        }
        if (typeof argv.pageSize === 'number' && argv.pageSize < 1) {
          throw new Error('--page-size must be >= 1');
        }
        if (typeof argv.limit === 'number' && argv.limit < 1) {
          throw new Error('--limit must be >= 1');
        }
        if (typeof argv.offset === 'number' && argv.offset < 0) {
          throw new Error('--offset must be >= 0');
        }
        return true;
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
      // 使用全局 --quiet / --no-quiet 控制输出格式（默认简洁）
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
      
      const workflowComponent = env.getComponent('workflow');

      if (!workflowComponent) {
        output.error('WorkflowComponent not available');
        process.exit(1);
      }

      // 获取 WorkflowService
      const service = (workflowComponent as any).workflowService as WorkflowService;
      
      if (!service) {
        output.error('WorkflowService not initialized. Please run "roy-bot workflow init" first.');
        process.exit(1);
      }

      // 解析 --tag 参数：支持单次或多次传入
      const tagsArg = args.tag;
      const tagsList: string[] = Array.isArray(tagsArg)
        ? (tagsArg as string[])
        : tagsArg
          ? [tagsArg as string]
          : [];

      // v4: --page 优先于 --offset；如果同时给 --page 和 --offset，--page 生效
      const pageSize = typeof args.pageSize === 'number' ? args.pageSize : (typeof args.limit === 'number' ? args.limit : 50);
      const page = typeof args.page === 'number' ? args.page : 1;
      const effectiveOffset = (page - 1) * pageSize;
      const userOffset = typeof args.offset === 'number' ? args.offset : 0;
      // 若 --page 显式给出（>1），使用 page 算出的 offset；否则用 --offset
      const finalOffset = page > 1 ? effectiveOffset : userOffset;

      // Use workflow_list tool
      const tool = createWorkflowListTool(service);
      const result = await tool.execute({
        tag: tagsList.length === 1 ? tagsList[0] : undefined,
        tags: tagsList.length > 1 ? tagsList : undefined,
        search: args.search !== undefined && typeof args.search === 'string' ? args.search : undefined,
        limit: pageSize,
        offset: finalOffset,
      }, {} as ToolContext);

      if (!result.success) {
        output.error(result.error || 'Failed to list workflows');
        process.exit(1);
      }

      const data = JSON.parse(result.output as string) as Record<string, any>;
      const workflows = data.workflows || [];
      const availableTags = data.available_tags || [];
      const total = typeof data.total === 'number' ? data.total : workflows.length;

      if (args.json) {
        const projected: ListWorkflowJson[] = workflows.map((w: any) => ({
          name: w.name,
          version: w.version,
          description: w.description,
          tags: w.tags,
          createdAt: w.created_at,
          updatedAt: w.created_at,
        }));
        output.json(
          buildListWorkflowsJson(
            projected,
            total,
            {
              limit: pageSize,
              offset: finalOffset,
              page: page > 1 ? page : Math.floor(finalOffset / pageSize) + 1,
            },
            availableTags,
          ),
        );
      } else if (args.quiet) {
        // quiet 模式（默认）：# Total: N + 每行 "<id>\t<name>" + 分页提示
        output.log(renderQuietHeader(total, 'workflow'));
        workflows.forEach((w: any) =>
          output.log(renderQuietLine(w.name, w.name))
        );
        const hint = renderQuietPaginationHint({
          count: workflows.length,
          total,
          offset: finalOffset,
          limit: pageSize,
        });
        if (hint) output.log(hint);
        return;
      } else {
        // Map tool output to Workflow-like objects for renderer
        const renderWorkflows = workflows.map((w: any) => ({
          id: w.name,
          name: w.name,
          version: w.version,
          description: w.description,
          tags: w.tags || [],
          createdAt: w.created_at ? new Date(w.created_at) : new Date(),
          updatedAt: w.created_at ? new Date(w.created_at) : new Date(),
          definition: { nodes: [], config: {}, inputs: {} as Record<string, any> },
          metadata: {} as Record<string, any>,
        }));
        output.log(renderWorkflowList(renderWorkflows));

        // v4: 显示分页进度
        if (total > workflows.length) {
          const start = finalOffset + 1;
          const end = finalOffset + workflows.length;
          output.log(chalk.green(`\n✅ 显示 ${start}-${end} / 共 ${total} 个 Workflow`));
          const totalPages = Math.ceil(total / pageSize);
          const currentPage = Math.floor(finalOffset / pageSize) + 1;
          if (totalPages > 1) {
            output.log(chalk.cyan(`📄 第 ${currentPage} / ${totalPages} 页`));
          }
        } else {
          output.log(chalk.green(`\n✅ 共 ${total} 个 Workflow`));
        }
        if (availableTags.length > 0) {
          const tagsLine = availableTags
            .map((t: any) => `${t.name}(${t.count})`)
            .join(', ');
          output.log(chalk.cyan(`\n🏷️  Available tags: ${tagsLine}`));
        }
      }
    } catch (error) {
      output.error(`Failed to list workflows: ${error}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
