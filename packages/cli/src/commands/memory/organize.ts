/**
 * @fileoverview Memory Organize Command
 * 
 * Manual trigger for memory organization
 * 
 * Usage:
 *   roy-bot memory organize
 *   roy-bot memory organize --scope project
 *   roy-bot memory organize --scope global
 *   roy-bot memory organize --scope all
 *   roy-bot memory organize --since 2026-04-01
 *   roy-bot memory organize --session <session-id>
 *   roy-bot memory organize --list-sessions
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SessionComponent, AgentComponent, MemoryPlugin as IMemoryPlugin } from "@ai-setting/roy-bot-core";

interface OrganizeOptions {
  scope?: "project" | "global" | "all";
  since?: string;
  session?: string;
  listSessions?: boolean;
}

/**
 * OrganizeContext - 用于依赖注入的上下文
 */
export interface OrganizeContext {
  envService: EnvironmentService;
  sessionComponent: SessionComponent | null;
  agentComponent: AgentComponent | null;
  memoryPlugin?: IMemoryPlugin;
}

/**
 * 创建 OrganizeContext
 */
export function createOrganizeContext(
  envService: EnvironmentService
): OrganizeContext {
  return {
    envService,
    sessionComponent: envService.getSession(),
    agentComponent: envService.getAgent(),
  };
}

/**
 * 准备 MemoryPlugin
 * 
 * @param workDir 工作目录
 * @param agentComponent AgentComponent（可选，用于 AI 记忆整理）
 */
export async function prepareMemoryPlugin(
  workDir: string,
  agentComponent?: AgentComponent
): Promise<IMemoryPlugin> {
  // 动态导入 MemoryPlugin
  const { MemoryPlugin } = await import("@ai-setting/roy-bot-core");
  
  // 设置全局注册表（供 MemoryPlugin 初始化时获取组件）
  const globalRegistry = (globalThis as any).__royAgentRegistry || {};
  // 保留现有的 sessionComponent（如果有）
  if (!globalRegistry.sessionComponent) {
    // 从 EnvironmentService 获取（如果可用）
    // 注意：在 CLI 模式下，sessionComponent 由调用方通过 ctx 传递
  }
  globalRegistry.agentComponent = agentComponent;
  (globalThis as any).__royAgentRegistry = globalRegistry;
  
  // 创建 MemoryPlugin
  const memoryPlugin = new MemoryPlugin(workDir, {
    enabled: true,
  } as any);
  
  await memoryPlugin.initialize();
  
  // 额外注册 AgentComponent（双保险，确保 MemoryPlugin 能使用 AI）
  if (agentComponent) {
    (memoryPlugin as any).registerAgentComponent(agentComponent);
  }
  
  return memoryPlugin;
}

/**
 * 清理资源
 */
export function cleanupOrganizeResources(
  ctx: OrganizeContext,
  memoryPlugin?: IMemoryPlugin
): void {
  // 清理全局注册表
  delete (globalThis as any).__royAgentRegistry;
  
  // MemoryPlugin 清理由调用方负责
  ctx.memoryPlugin = memoryPlugin;
}

export const OrganizeCommand: CommandModule = {
  command: "organize [options]",
  describe: "手动触发记忆整理",
  builder: (yargs) =>
    yargs
      .option("scope", {
        alias: "s",
        description: "整理范围: project, global, all (默认: all)",
        type: "string",
        choices: ["project", "global", "all"],
        default: "all",
      })
      .option("since", {
        alias: "t",
        description: "整理指定时间以来的记忆 (ISO 日期或 Unix 时间戳)",
        type: "string",
      })
      .option("session", {
        alias: "S",
        description: "整理指定会话的记忆",
        type: "string",
      })
      .option("list-sessions", {
        alias: "l",
        description: "列出可用的会话",
        type: "boolean",
        default: false,
      })
      .example("roy-bot memory organize", "整理所有记忆")
      .example("roy-bot memory organize --scope project", "只整理项目记忆")
      .example("roy-bot memory organize --scope global", "只整理全局记忆")
      .example("roy-bot memory organize --since 2026-04-01", "整理指定时间以来的记忆")
      .example("roy-bot memory organize --list-sessions", "列出所有会话")
      .example("roy-bot memory organize --session abc123", "整理指定会话的记忆"),

  async handler(argv) {
    const output = new OutputService();
    const envService = new EnvironmentService(output);
    let memoryPlugin: IMemoryPlugin | undefined;

    try {
      await envService.create();

      const ctx = createOrganizeContext(envService);
      const sessionComponent = ctx.sessionComponent;

      // 处理 --list-sessions 选项
      if ((argv as OrganizeOptions).listSessions) {
        await listSessions(sessionComponent, output);
        return;
      }

      const options = argv as OrganizeOptions;

      output.log(chalk.bold("\n📋 记忆整理\n"));

      // 如果指定了 session，获取该 session 的消息并显示预览
      if (options.session) {
        output.log(chalk.gray(`📂 会话: ${options.session}`));

        const messages = await getSessionMessages(sessionComponent, options.session);
        if (messages.length === 0) {
          output.error(`会话不存在或没有消息: ${options.session}`);
          process.exit(1);
        }

        output.log(chalk.gray(`📝 共 ${messages.length} 条消息\n`));

        // 显示消息预览
        output.log(chalk.gray("📄 消息摘要预览:"));
        for (let i = 0; i < Math.min(3, messages.length); i++) {
          const msg = messages[i];
          const content = typeof msg.content === "string"
            ? msg.content.substring(0, 100) + "..."
            : JSON.stringify(msg.content).substring(0, 100) + "...";
          output.log(chalk.gray(`  [${msg.role}] ${content}`));
        }
        output.log("");
      } else {
        output.log(chalk.gray("💡 提示: 使用 --session 指定会话来整理对话记忆\n"));
      }

      output.log(chalk.gray(`🎯 整理范围: ${options.scope || "all"}\n`));

      // 获取 AgentComponent
      if (!ctx.agentComponent) {
        output.error("AgentComponent not available, cannot organize memory with AI");
        process.exit(1);
      }

      // 准备 MemoryPlugin（包含注册 AgentComponent）
      memoryPlugin = await prepareMemoryPlugin(process.cwd(), ctx.agentComponent);

      // 解析 since 时间戳
      let sinceTimestamp: number | undefined;
      if (options.since) {
        const date = new Date(options.since);
        if (!isNaN(date.getTime())) {
          sinceTimestamp = date.getTime();
        }
      }

      // 调用 organize
      output.log(chalk.gray("⏳ 正在整理记忆...\n"));

      await (memoryPlugin as any).organize({
        scope: options.scope as "project" | "global" | "all" || "all",
        sessionId: options.session,
        since: sinceTimestamp,
      });

      output.success("\n✅ 记忆整理完成");
      output.log(chalk.gray("\n提示: 使用 `roy-bot memory recall` 查看整理后的记忆"));

    } catch (error) {
      output.error(`整理记忆失败: ${error}`);
      process.exit(1);
    } finally {
      // 清理 MemoryPlugin
      if (memoryPlugin) {
        await memoryPlugin.dispose();
      }
      // 清理全局注册表
      cleanupOrganizeResources(createOrganizeContext(envService), memoryPlugin);
      // 清理 EnvironmentService
      await envService.dispose();
    }
  },
};

/**
 * 获取指定 session 的消息
 */
async function getSessionMessages(
  sessionComponent: SessionComponent | null,
  sessionId: string
): Promise<Array<{ role: string; content: string }>> {
  if (!sessionComponent) {
    return [];
  }

  try {
    const session = await sessionComponent.get(sessionId);
    if (!session) {
      return [];
    }

    // 获取消息，默认获取最近 100 条
    const messages = await sessionComponent.getMessages(sessionId, { limit: 100 });

    // 过滤掉 tool 相关消息，只保留 user 和 assistant
    return messages
      .filter((msg) => msg.role === "user" || msg.role === "assistant")
      .map((msg) => ({
        role: msg.role,
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
      }));
  } catch (error) {
    return [];
  }
}

/**
 * 列出所有会话
 */
export async function listSessions(
  sessionComponent: SessionComponent | null,
  output: OutputService
): Promise<void> {
  if (!sessionComponent) {
    output.error("SessionComponent not available");
    return;
  }

  try {
    const sessions = await sessionComponent.list({ limit: 20 });

    if (sessions.length === 0) {
      output.log(chalk.gray("暂无会话"));
      return;
    }

    output.log(chalk.bold(`\n📂 会话列表 (最近 20 个)\n\n`));

    for (const session of sessions) {
      const date = new Date(session.createdAt).toLocaleDateString("zh-CN");
      const time = new Date(session.createdAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });

      output.log(chalk.cyan(`ID: ${session.id}`));
      output.log(`  标题: ${session.title || "无标题"}`);
      output.log(`  创建: ${date} ${time}`);
      output.log("");
    }
  } catch (error) {
    output.error(`列出会话失败: ${error}`);
  }
}
