/**
 * @fileoverview Workflow CLI Renderers
 * 
 * Output formatters for workflow CLI commands
 */

import chalk from 'chalk';
import type { Workflow, WorkflowRun } from '@ai-setting/roy-bot-core/env/workflow/types';

/**
 * 计算字符串的视觉宽度（中文字符占2格）
 */
function visualWidth(str: string): number {
  let width = 0;
  for (const char of str) {
    if (char.charCodeAt(0) > 255) {
      width += 2;
    } else {
      width += 1;
    }
  }
  return width;
}

/**
 * 按视觉宽度截断字符串
 */
function truncateVisual(str: string, maxWidth: number): string {
  if (!str) return '-';
  let result = '';
  let width = 0;
  for (const char of str) {
    const charWidth = char.charCodeAt(0) > 255 ? 2 : 1;
    if (width + charWidth > maxWidth) break;
    result += char;
    width += charWidth;
  }
  return result || '-';
}

/**
 * 格式化时间
 */
function formatDate(date: Date | string | undefined): string {
  if (!date) return '-';
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleString('zh-CN');
}

/**
 * 格式化时长
 */
function formatDuration(ms: number | undefined): string {
  if (ms === undefined || ms === null) return '-';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

/**
 * 获取状态颜色
 */
function statusColor(status: string): typeof chalk.green {
  switch (status) {
    case 'completed':
      return chalk.green;
    case 'running':
    case 'idle':
      return chalk.blue;
    case 'paused':
      return chalk.yellow;
    case 'failed':
      return chalk.red;
    case 'stopped':
      return chalk.gray;
    default:
      return chalk.white;
  }
}

/**
 * 渲染 Workflow 列表
 */
export function renderWorkflowList(workflows: Workflow[], options?: { json?: boolean }): string {
  if (options?.json) {
    return JSON.stringify({
      total: workflows.length,
      workflows: workflows.map(w => ({
        id: w.id,
        name: w.name,
        version: w.version,
        description: w.description,
        tags: w.tags,
        createdAt: w.createdAt.toISOString(),
        updatedAt: w.updatedAt.toISOString(),
      })),
    }, null, 2);
  }

  if (workflows.length === 0) {
    return chalk.yellow('No workflows found');
  }

  const NAME_WIDTH = 30;
  const VERSION_WIDTH = 10;
  const TAGS_WIDTH = 20;
  const UPDATED_WIDTH = 20;
  const GAP = '  ';

  const headerLine = [
    chalk.bold('NAME'.padEnd(NAME_WIDTH)),
    chalk.bold('VER'.padEnd(VERSION_WIDTH)),
    chalk.bold('TAGS'.padEnd(TAGS_WIDTH)),
    chalk.bold('UPDATED'),
  ].join(GAP);

  const sepLine = '─'.repeat(NAME_WIDTH + VERSION_WIDTH + TAGS_WIDTH + UPDATED_WIDTH + GAP.length * 3);

  const rows = workflows.map(w => {
    const name = truncateVisual(w.name, NAME_WIDTH).padEnd(NAME_WIDTH);
    const version = w.version.padEnd(VERSION_WIDTH);
    const tags = truncateVisual(w.tags.join(', '), TAGS_WIDTH).padEnd(TAGS_WIDTH);
    const updated = formatDate(w.updatedAt);
    return `${name}${GAP}${version}${GAP}${tags}${GAP}${updated}`;
  });

  return [headerLine, sepLine, ...rows].join('\n');
}

/**
 * 渲染 Workflow 详情
 */
export function renderWorkflowDetail(workflow: Workflow, options?: { includeRuns?: WorkflowRun[] }): string {
  const lines: string[] = [];

  lines.push(chalk.bold('\n📋 Workflow Details\n'));
  lines.push(`  ${chalk.cyan('ID:')}          ${workflow.id}`);
  lines.push(`  ${chalk.cyan('Name:')}        ${workflow.name}`);
  lines.push(`  ${chalk.cyan('Version:')}     ${workflow.version}`);
  lines.push(`  ${chalk.cyan('Description:')} ${workflow.description || '-'}`);
  lines.push(`  ${chalk.cyan('Tags:')}        ${workflow.tags.join(', ') || '-'}`);
  lines.push(`  ${chalk.cyan('Created:')}     ${formatDate(workflow.createdAt)}`);
  lines.push(`  ${chalk.cyan('Updated:')}     ${formatDate(workflow.updatedAt)}`);

  // Nodes summary
  const nodeCount = workflow.definition.nodes.length;
  lines.push(chalk.bold('\n📊 Nodes Summary\n'));
  lines.push(`  Total: ${nodeCount} nodes`);

  // Group nodes by type
  const nodesByType: Record<string, number> = {};
  for (const node of workflow.definition.nodes) {
    nodesByType[node.type] = (nodesByType[node.type] || 0) + 1;
  }
  for (const [type, count] of Object.entries(nodesByType)) {
    lines.push(`    - ${type}: ${count}`);
  }

  // Config summary
  if (workflow.definition.config) {
    lines.push(chalk.bold('\n⚙️  Configuration\n'));
    if (workflow.definition.config.parallel_limit !== undefined) {
      lines.push(`  parallel_limit: ${workflow.definition.config.parallel_limit}`);
    }
    if (workflow.definition.config.timeout !== undefined) {
      lines.push(`  timeout: ${workflow.definition.config.timeout}ms`);
    }
    if (workflow.definition.config.debug !== undefined) {
      lines.push(`  debug: ${workflow.definition.config.debug}`);
    }
  }

  // Runs summary (if included)
  if (options?.includeRuns && options.includeRuns.length > 0) {
    lines.push(chalk.bold('\n📜 Recent Runs\n'));
    lines.push(renderRunsList(options.includeRuns.slice(0, 5)));
  }

  return lines.join('\n');
}

/**
 * 渲染 Runs 列表
 */
export function renderRunsList(runs: WorkflowRun[], options?: { json?: boolean }): string {
  if (options?.json) {
    return JSON.stringify({
      total: runs.length,
      runs: runs.map(r => ({
        id: r.id,
        workflowId: r.workflowId,
        status: r.status,
        startedAt: r.startedAt?.toISOString(),
        completedAt: r.completedAt?.toISOString(),
        durationMs: r.durationMs,
        error: r.error,
      })),
    }, null, 2);
  }

  if (runs.length === 0) {
    return chalk.yellow('No runs found');
  }

  const ID_WIDTH = 20;
  const STATUS_WIDTH = 12;
  const DURATION_WIDTH = 12;
  const UPDATED_WIDTH = 20;
  const GAP = '  ';

  const headerLine = [
    chalk.bold('RUN ID'.padEnd(ID_WIDTH)),
    chalk.bold('STATUS'.padEnd(STATUS_WIDTH)),
    chalk.bold('DURATION'.padEnd(DURATION_WIDTH)),
    chalk.bold('STARTED'),
  ].join(GAP);

  const sepLine = '─'.repeat(ID_WIDTH + STATUS_WIDTH + DURATION_WIDTH + UPDATED_WIDTH + GAP.length * 3);

  const rows = runs.map(r => {
    const id = truncateVisual(r.id, ID_WIDTH).padEnd(ID_WIDTH);
    const status = statusColor(r.status)(r.status.padEnd(STATUS_WIDTH));
    const duration = formatDuration(r.durationMs).padEnd(DURATION_WIDTH);
    const started = formatDate(r.startedAt);
    return `${id}${GAP}${status}${GAP}${duration}${GAP}${started}`;
  });

  return [headerLine, sepLine, ...rows].join('\n');
}

/**
 * 渲染 Run 详情
 */
export function renderRunDetail(run: WorkflowRun): string {
  const lines: string[] = [];

  lines.push(chalk.bold('\n🏃 Run Details\n'));
  lines.push(`  ${chalk.cyan('Run ID:')}     ${run.id}`);
  lines.push(`  ${chalk.cyan('Workflow:')}  ${run.workflowId}`);
  lines.push(`  ${chalk.cyan('Status:')}    ${statusColor(run.status)(run.status)}`);
  lines.push(`  ${chalk.cyan('Started:')}   ${formatDate(run.startedAt)}`);
  
  if (run.pausedAt) {
    lines.push(`  ${chalk.cyan('Paused:')}    ${formatDate(run.pausedAt)}`);
  }
  if (run.resumedAt) {
    lines.push(`  ${chalk.cyan('Resumed:')}   ${formatDate(run.resumedAt)}`);
  }
  if (run.stoppedAt) {
    lines.push(`  ${chalk.cyan('Stopped:')}   ${formatDate(run.stoppedAt)}`);
  }
  if (run.completedAt) {
    lines.push(`  ${chalk.cyan('Completed:')} ${formatDate(run.completedAt)}`);
  }
  
  lines.push(`  ${chalk.cyan('Duration:')}  ${formatDuration(run.durationMs)}`);

  if (run.error) {
    lines.push(chalk.bold('\n❌ Error\n'));
    lines.push(`  ${chalk.red(run.error)}`);
  }

  if (run.output) {
    lines.push(chalk.bold('\n📤 Output\n'));
    lines.push('  ' + JSON.stringify(run.output, null, 2).split('\n').join('\n  '));
  }

  return lines.join('\n');
}

/**
 * 渲染工作流已添加成功
 */
export function renderWorkflowAdded(workflow: Workflow): string {
  return chalk.green(`\n✅ Workflow '${workflow.name}' added successfully\n`) +
    `   ID: ${workflow.id}\n` +
    `   Version: ${workflow.version}\n`;
}

/**
 * 渲染工作流已更新成功
 */
export function renderWorkflowUpdated(workflow: Workflow): string {
  return chalk.green(`\n✅ Workflow '${workflow.name}' updated successfully\n`) +
    `   ID: ${workflow.id}\n`;
}

/**
 * 渲染工作流已删除成功
 */
export function renderWorkflowDeleted(name: string): string {
  return chalk.green(`\n✅ Workflow '${name}' deleted successfully\n`);
}

/**
 * 渲染工作流运行结果
 */
export function renderRunResult(result: {
  runId: string;
  status: string;
  output?: any;
  error?: string;
  durationMs?: number;
  pendingNodeId?: string;
  query?: string;
  agentSessionId?: string;
}): string {
  const lines: string[] = [];

  if (result.status === 'completed') {
    lines.push(chalk.green('\n✅ Workflow completed successfully'));
  } else if (result.status === 'failed') {
    lines.push(chalk.red('\n❌ Workflow failed'));
  } else if (result.status === 'stopped') {
    lines.push(chalk.yellow('\n⚠️  Workflow stopped'));
  } else if (result.status === 'paused') {
    lines.push(chalk.yellow('\n⏸️  Workflow paused'));
    if (result.pendingNodeId) {
      lines.push(chalk.gray(`   Pending node: ${result.pendingNodeId}`));
    }
    if (result.query) {
      lines.push('');
      lines.push(chalk.bold('💬 Agent asked: ') + chalk.white(result.query));
    }
    if (result.agentSessionId) {
      lines.push(chalk.gray(`   Agent sub-session: ${result.agentSessionId}`));
    }
  } else {
    lines.push(chalk.blue(`\n🔄 Workflow ${result.status}`));
  }

  lines.push(`   Run ID: ${result.runId}`);
  
  if (result.durationMs) {
    lines.push(`   Duration: ${formatDuration(result.durationMs)}`);
  }

  if (result.error) {
    lines.push(chalk.red(`\n   Error: ${result.error}`));
  }

  if (result.output) {
    lines.push(chalk.bold('\n📤 Output:'));
    lines.push(JSON.stringify(result.output, null, 2));
  }

  return lines.join('\n');
}

/**
 * 渲染节点列表
 */
export function renderNodesList(nodes: Array<{ id?: string; type?: string; name?: string; depends_on?: string[] }>): string {
  const ID_WIDTH = 25;
  const TYPE_WIDTH = 12;
  const NAME_WIDTH = 20;
  const DEPS_WIDTH = 20;
  const GAP = '  ';

  const headerLine = [
    chalk.bold('NODE ID'.padEnd(ID_WIDTH)),
    chalk.bold('TYPE'.padEnd(TYPE_WIDTH)),
    chalk.bold('NAME'.padEnd(NAME_WIDTH)),
    chalk.bold('DEPENDS ON'),
  ].join(GAP);

  const sepLine = '─'.repeat(ID_WIDTH + TYPE_WIDTH + NAME_WIDTH + DEPS_WIDTH + GAP.length * 3);

  const rows = nodes.map(n => {
    const id = truncateVisual(n.id || '-', ID_WIDTH).padEnd(ID_WIDTH);
    const type = (n.type || '-').padEnd(TYPE_WIDTH);
    const name = truncateVisual(n.name || '-', NAME_WIDTH).padEnd(NAME_WIDTH);
    const deps = n.depends_on?.join(', ') || '-';
    return `${id}${GAP}${type}${GAP}${name}${GAP}${deps}`;
  });

  return [headerLine, sepLine, ...rows].join('\n');
}
