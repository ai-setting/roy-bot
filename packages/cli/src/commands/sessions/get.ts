/**
 * @fileoverview Sessions Get Command
 * 
 * 命令：roy-bot sessions get <session-id>
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SessionComponent, Session, SessionCheckpoint } from "@ai-setting/roy-bot-core";

// Inline type for WorkflowSessionMetadata
interface WorkflowSessionMetadata {
  type: 'workflow';
  workflowId?: string;
  workflowName: string;
  status: 'running' | 'paused' | 'completed' | 'failed' | 'stopped';
  agentSessions?: AgentSessionRef[];
}

interface AgentSessionRef {
  nodeId: string;
  sessionId: string;
  status: 'active' | 'paused' | 'completed' | 'failed' | 'stopped';
}

/**
 * Color a workflow status string. Mirrors the AgentSessionRef status palette.
 *   running   -> green
 *   paused    -> yellow
 *   completed -> gray
 *   failed    -> red
 *   stopped   -> magenta
 */
export function colorWorkflowStatus(
  status: WorkflowSessionMetadata['status']
): (s: string) => string {
  switch (status) {
    case 'running':
      return chalk.green;
    case 'paused':
      return chalk.yellow;
    case 'completed':
      return chalk.gray;
    case 'failed':
      return chalk.red;
    case 'stopped':
      return chalk.magenta;
    default:
      return chalk.gray;
  }
}

/**
 * Color an agent session status string.
 *   active    -> green
 *   paused    -> yellow
 *   completed -> gray
 *   failed    -> red
 *   stopped   -> magenta
 */
export function colorAgentSessionStatus(
  status: AgentSessionRef['status']
): (s: string) => string {
  switch (status) {
    case 'active':
      return chalk.green;
    case 'paused':
      return chalk.yellow;
    case 'completed':
      return chalk.gray;
    case 'failed':
      return chalk.red;
    case 'stopped':
      return chalk.magenta;
    default:
      return chalk.gray;
  }
}

interface GetOptions {
  sessionId: string;
  messages?: boolean;
  checkpoints?: boolean;
  json?: boolean;
  config?: string;
}

export const GetCommand: CommandModule<object, object> = {
  command: "get <session-id>",
  aliases: ["show"],
  describe: "获取会话详情",

  builder: (yargs) =>
    yargs
      .positional("session-id", {
        describe: "会话 ID",
        type: "string",
        demandOption: true,
      })
      .option("messages", { type: "boolean", default: false })
      .option("checkpoints", { alias: "c", type: "boolean", default: false })
      .option("json", { alias: "j", type: "boolean", default: false }),

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
      const sessionComponent = env.getComponent("session") as SessionComponent | undefined;

      if (!sessionComponent) {
        output.error("SessionComponent not available");
        process.exit(1);
      }

      const session = await sessionComponent.get(a.sessionId);
      if (!session) {
        output.error(`Session not found: ${a.sessionId}`);
        process.exit(1);
      }

      const activeSessionId = sessionComponent.getActiveSessionId();
      const checkpoints: SessionCheckpoint[] = a.checkpoints 
        ? await sessionComponent.getCheckpoints(a.sessionId)
        : [];

      if (a.json) {
        output.json({
          id: session.id,
          title: session.title,
          directory: session.directory,
          parentID: session.parentID,
          messageCount: session.messageCount,
          isActive: session.id === activeSessionId,
          checkpoints: checkpoints.map((cp: SessionCheckpoint) => ({
            id: cp.id,
            title: cp.title,
            messageIndex: cp.messageIndex,
            type: cp.type,
            createdAt: new Date(cp.createdAt).toISOString(),
            // ★ C 方案（Task #4933）：正文是整段自然语言 content
            content: cp.content,
          })),
          metadata: session.metadata,
          createdAt: new Date(session.createdAt).toISOString(),
          updatedAt: new Date(session.updatedAt).toISOString(),
        });
      } else {
        // 详细信息输出
        const lines = [
          chalk.bold("┌─ Session Details ─────────────────────────────────┐"),
          `│ ID:          ${session.id}`,
          `│ Title:       ${session.title}`,
          `│ Directory:   ${session.directory}`,
          `│ Messages:    ${session.messageCount}`,
          `│ Active:      ${session.id === activeSessionId ? chalk.green("✓") : chalk.gray("-")}`,
          `│ Created:     ${new Date(session.createdAt).toLocaleString("zh-CN")}`,
          `│ Updated:     ${new Date(session.updatedAt).toLocaleString("zh-CN")}`,
        ];

        // ★ Task #5403：关联群信息（取代已废弃的 alias/linkedTo）。
        //   群 session 是独立会话，仅 metadata 记溯源；这里只做可观测展示。
        const groupChat = await sessionComponent.findGroupChatForSession(session.id);
        if (groupChat?.chatId) {
          lines.push(`│ 📨 Group chat: ${chalk.cyan(groupChat.chatId)}`);
        }
        const linkedFrom = (session.metadata as Record<string, unknown> | undefined)
          ?.linkedFromSessionId;
        if (typeof linkedFrom === "string" && linkedFrom) {
          lines.push(
            `│ 🔗 Linked from: ${chalk.cyan(linkedFrom)}` +
              chalk.gray(` (use: sessions messages ${linkedFrom})`)
          );
        }

        // Check if this is a workflow session
        const workflowMeta = session.metadata?.type === 'workflow' 
          ? session.metadata as unknown as WorkflowSessionMetadata 
          : null;
        
        if (workflowMeta) {
          lines.push("├─ Workflow Info ─────────────────────────────────────┤");
          lines.push(`│ Type:        ${chalk.cyan("workflow")}`);
          lines.push(`│ Workflow:    ${workflowMeta.workflowName}`);
          if (workflowMeta.workflowId) {
            lines.push(`│ Workflow ID: ${workflowMeta.workflowId}`);
          }
          const statusColor = colorWorkflowStatus(workflowMeta.status);
          lines.push(`│ Status:      ${statusColor(workflowMeta.status)}`);

          // Display agent sub-sessions if any
          if (workflowMeta.agentSessions && workflowMeta.agentSessions.length > 0) {
            lines.push("├─ Agent Sub-sessions ─────────────────────────────────┤");
            workflowMeta.agentSessions.forEach((agent: AgentSessionRef) => {
              const agentStatusColor = colorAgentSessionStatus(agent.status);
              lines.push(`│ ${agent.nodeId}: ${agent.sessionId} (${agentStatusColor(agent.status)})`);
            });
          }
        }

        if (checkpoints.length > 0) {
          lines.push("├─ Checkpoints ──────────────────────────────────────┤");
          checkpoints.slice(-5).reverse().forEach((cp: SessionCheckpoint, i: number) => {
            const marker = i === 0 ? "✓ Latest" : "  #" + (checkpoints.length - i);
            lines.push(`│ ${marker}  ${cp.title}`);
            lines.push(`│           ${new Date(cp.createdAt).toLocaleString("zh-CN")}`);
          });
        }

        lines.push("└───────────────────────────────────────────────────┘");
        output.log(lines.join("\n"));
      }
    } catch (error) {
      output.error(`Failed to get session: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
