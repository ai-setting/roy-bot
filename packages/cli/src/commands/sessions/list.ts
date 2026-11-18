/**
 * @fileoverview Sessions List Command
 * 
 * 命令：roy-bot sessions list
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import { CliQuietModeService } from "../../services/quiet-mode.service";
import { renderPaginationFooter } from "../shared/list-output";
import chalk from "chalk";
import type {
  SessionComponent,
  Session,
  ListSessionsOptions,
} from "@ai-setting/roy-bot-core";
import {
  buildSessionTree,
  renderSessionTree,
  shortSessionId,
  expandSessionAncestors,
} from "./session-graph";
import { renderQuietHeader, renderQuietLine, renderQuietPaginationHint } from "../shared/list-output";

// Inline type for WorkflowSessionMetadata to avoid import issue
interface WorkflowSessionMetadata {
  type: 'workflow';
  workflowId?: string;
  workflowName: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
}

interface ListOptions {
  limit?: number;
  offset?: number;
  sort?: string;
  order?: string;
  json?: boolean;
  quiet?: boolean;
  id?: boolean;
  config?: string;
  type?: string;
  status?: string;
  graph?: boolean;
  shortId?: boolean;
}

export const ListCommand: CommandModule<object, ListOptions> = {
  command: "list [options]",
  aliases: ["ls"],
  describe: "列出所有会话",

  builder: (yargs) =>
    yargs
      .option("limit", { alias: "n", type: "number", default: 20 })
      .option("offset", { alias: "o", type: "number", default: 0, description: "分页偏移（-o alias）" })
      .option("sort", { type: "string", default: "updatedAt" })
      .option("order", { type: "string", default: "desc" })
      .option("json", { alias: "j", type: "boolean", default: false })
      .option("quiet", { alias: "q", type: "boolean", hidden: true })  // 使用全局 quiet 选项
      .option("id", { alias: "i", type: "boolean", default: false, description: "显示 Session ID" })
      .option("type", { alias: "t", type: "string", description: "按 session 类型过滤 (如 workflow)" })
      .option("status", { alias: "s", type: "string", description: "按状态过滤 (如 running, paused)" })
      .option("graph", { alias: "g", type: "boolean", default: false, description: "以层次化树形结构展示 session 父子关系" })
      .option("short-id", { type: "boolean", default: false, description: "[graph] 用 8 字符截断 id 显示（默认显示完整 sessionId）" }),

  async handler(args) {
    // Note: 全局 quiet 已在 cli.ts middleware 中通过 CliQuietModeService 设置，
    // 这里不需要再 setQuiet 也不需要 output.configure。
    const output = new OutputService();
    const envService = new EnvironmentService(output);

    try {
      await envService.create({ configPath: args.config });
      const env = envService.getEnvironment();
      if (!env) {
        output.error("Failed to create environment");
        process.exit(1);
      }
      const sessionComponent = env.getComponent("session") as SessionComponent;

      if (!sessionComponent) {
        output.error("SessionComponent not available");
        process.exit(1);
      }

      const listOptions: ListSessionsOptions = {
        sort: { field: args.sort as any, order: args.order as any },
        offset: args.offset,
        limit: args.limit,
      };
      
      // Add metadata filter if type or status is specified
      if (args.type || args.status) {
        const metadataFilter: Record<string, unknown> = {};
        if (args.type) {
          metadataFilter.type = args.type;
        }
        if (args.status) {
          metadataFilter.status = args.status;
        }
        listOptions.filter = {
          metadata: metadataFilter,
        };
      }
      
      const sessions = await sessionComponent.list(listOptions);
      const totalCount = await sessionComponent.getCount();
      const activeSessionId = sessionComponent.getActiveSessionId();

      // --graph: hierarchical tree view (text-only, ignores --json)
      if (args.graph) {
        // Auto-expand the parent chain so the tree stays complete even when
        // the limit/offset window excludes some ancestors. Without this,
        // `buildSessionTree` would treat their children as orphans, and the
        // tree would lose its hierarchy. The original `sessions` array is
        // still honored for limit semantics — only the graph view expands.
        // Mirrors Task #1951's expandParentChain for the tasks list.
        const expandedSessions = await expandSessionAncestors(sessionComponent, sessions);
        const tree = buildSessionTree(expandedSessions);
        output.log(renderSessionTree(tree, { useShortId: args.shortId === true }));
        return;
      }

      if (args.json) {
        output.json({
          // 统一 JSON 结构：total FIRST, sessions LAST (Task #1818)
          total: totalCount,
          count: sessions.length,
          truncated: totalCount > sessions.length,
          limit: args.limit,
          offset: args.offset,
          sessions: sessions.map((s: Session) => {
            const workflowMeta = s.metadata?.type === 'workflow' 
              ? s.metadata as unknown as WorkflowSessionMetadata 
              : null;
            return {
              id: s.id,
              title: s.title,
              directory: s.directory,
              messageCount: s.messageCount,
              type: workflowMeta?.type || 'chat',
              status: workflowMeta?.status,
              workflowName: workflowMeta?.workflowName,
              parentSessionId: s.parentSessionId ?? null,
              parentID: s.parentID ?? null,
              hasCheckpoint: !!s.metadata?.checkpoints?.checkpoints?.length,
              lastCheckpointAt: s.metadata?.checkpoints?.latestCheckpointId,
              createdAt: new Date(s.createdAt).toISOString(),
              updatedAt: new Date(s.updatedAt).toISOString(),
              isActive: s.id === activeSessionId,
            };
          }),
        });
      } else if (args.id) {
        // --id 模式：只显示 ID（向后兼容，依赖 ID-only 的脚本）
        sessions.forEach((s: Session) => output.log(s.id));
      } else if (args.quiet) {
        // quiet 模式：# Total: N + 每行 "<id>\t<title>" + 分页提示
        output.log(renderQuietHeader(totalCount, "session"));
        sessions.forEach((s: Session) =>
          output.log(renderQuietLine(s.id, s.title))
        );
        const hint = renderQuietPaginationHint({
          count: sessions.length,
          total: totalCount,
          offset: args.offset ?? 0,
          limit: args.limit ?? 20,
        });
        if (hint) output.log(hint);
      } else {
        // 表格输出
        const hasTypeFilter = !!args.type;
        const hasStatusFilter = !!args.status;
        
        const header = [
          chalk.bold("#"),
          chalk.bold("Title"),
          chalk.bold("ID"),
          chalk.bold("Parent"),
          hasTypeFilter || hasStatusFilter ? chalk.bold("Status") : null,
          chalk.bold("Msgs"),
          chalk.bold("CP"),
        ].filter(Boolean).join(" │ ");

        const rows = sessions.map((s: Session, i: number) => {
          const marker = s.id === activeSessionId ? chalk.green("▶") : " ";
          const hasCp = (s.metadata?.checkpoints?.checkpoints?.length ?? 0) > 0;
          const title = s.title.length > 20 ? s.title.slice(0, 17) + "..." : s.title;
          // 显示完整的 Session ID
          const idStr = s.id;
          // Parent column: --short-id (8-char post-prefix) or full id; default full
          // (Issue #3: parent ID now respects --short-id, matching --graph behavior)
          const useShortId = args.shortId === true;
          const parentStr = s.parentSessionId
            ? chalk.gray(
                useShortId
                  ? shortSessionId(s.parentSessionId)
                  : s.parentSessionId
              )
            : chalk.gray("-");
          
          // Get workflow metadata if present
          const workflowMeta = s.metadata?.type === 'workflow' 
            ? s.metadata as unknown as WorkflowSessionMetadata 
            : null;
          const statusStr = workflowMeta?.status || '';
          
          // Format status for display
          let statusDisplay = '';
          if (hasTypeFilter || hasStatusFilter) {
            if (workflowMeta) {
              statusDisplay = workflowMeta.status === 'running' ? chalk.green('running') 
                : workflowMeta.status === 'paused' ? chalk.yellow('paused')
                : workflowMeta.status === 'completed' ? chalk.gray('completed')
                : workflowMeta.status === 'failed' ? chalk.red('failed')
                : statusStr;
            }
          }

          const cells = [
            marker + " " + (args.offset! + i + 1),
            title,
            chalk.gray(idStr),
            parentStr,
          ];
          
          if (hasTypeFilter || hasStatusFilter) {
            cells.push(statusDisplay || chalk.gray('-'));
          }
          
          cells.push(
            s.messageCount.toString(),
            hasCp ? chalk.green("✓") : chalk.gray("-"),
          );

          return cells.join(" │ ");
        });

        output.log([
          `┌─ Sessions ${"─".repeat(50)}┐`,
          `│${header}│`,
          "├" + "─".repeat(header.length + 2) + "┤",
          ...rows.map((r: string) => `│${r}│`),
          "└" + "─".repeat(header.length + 2) + "┘",
          "",
          renderPaginationFooter({
            // Note: totalCount is the WHOLE-DB count, not the filtered
            // count. Use that here for the "X of Y" phrasing so users
            // see how many sessions exist in total even when --type/--status
            // filters are applied. This matches the JSON output's `total`.
            total: totalCount,
            count: sessions.length,
            offset: args.offset ?? 0,
            limit: args.limit ?? 20,
            itemName: "session",
            extras: [
              // Note: totalCount (DB 总数) 已在 "X of Y" 中通过 total 字段显示,
              // 这里不重复 unfiltered。只在有 filter 时显示具体 filter.
              ...(args.type ? [`type=${args.type}`] : []),
              ...(args.status ? [`status=${args.status}`] : []),
            ],
          }),
        ].join("\n"));
      }
    } catch (error) {
      output.error(`Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
