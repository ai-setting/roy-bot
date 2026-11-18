/**
 * @fileoverview Sessions Compact Command
 * 
 * 命令：roy-bot sessions compact <session-id>
 * 
 * 压缩会话，生成 checkpoint
 * 
 * 特性：
 * 1. 如果未指定 --scenario 参数，自动调用 generateCompactHint 生成场景化提示
 * 2. 输出生成的 hint prompt（用于告知用户生成了什么指导）
 * 3. 输出最终的 checkpoint
 * 4. 复用自动触发 compact 的两阶段逻辑
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type {
  SessionComponent,
  Session,
  LLMComponent,
  PromptComponent,
} from "@ai-setting/roy-bot-core";

interface CompactOptions {
  sessionId: string;
  summary?: string;
  scenario?: string;
  dryRun?: boolean;
  json?: boolean;
  config?: string;
}

export const CompactCommand: CommandModule<object, object> = {
  command: "compact <session-id>",
  aliases: ["compress", "checkpoint"],
  describe: "压缩会话，生成 checkpoint [new]",

  builder: (yargs) =>
    yargs
      .positional("session-id", {
        describe: "会话 ID",
        type: "string",
        demandOption: true,
      })
      .option("summary", {
        alias: "s",
        type: "string",
        description:
          "[已废弃] 摘要提示（C 方案起压缩正文由模型自由撰写，该参数不再生效；请用 --scenario）",
      })
      .option("scenario", { 
        alias: "S", 
        type: "string", 
        description: "场景提示（可选）。不指定时自动生成。例如：'Task execution in progress: implementing feature X, current working directory is /path/to/project'" 
      })
      .option("dry-run", { alias: "d", type: "boolean", default: false, description: "预览压缩效果" })
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

      // 检查会话是否存在
      const session: Session | undefined = await sessionComponent.get(a.sessionId);
      if (!session) {
        output.error(`Session not found: ${a.sessionId}`);
        process.exit(1);
      }

      // 初始化 SummaryAgent 所需的组件
      const llmComponent = env.getComponent("llm") as LLMComponent | undefined;
      const promptComponent = env.getComponent("prompt") as PromptComponent | undefined;
      
      if (!llmComponent || !promptComponent) {
        output.error("LLMComponent or PromptComponent not available. Cannot generate checkpoint.");
        process.exit(1);
      }

      // Dry run - 预览
      if (a.dryRun) {
        const preview = await sessionComponent.previewCompact(a.sessionId);
        
        if (a.json) {
          output.json({
            sessionId: a.sessionId,
            preview: {
              messageCountToCompact: preview.messageCountToCompact,
              estimatedCheckpointTokens: preview.estimatedCheckpointTokens,
              wouldTrigger: preview.wouldTrigger,
            },
            dryRun: true,
          });
        } else {
          output.log(chalk.bold("┌─ Compact Preview ─────────────────────────────────┐"));
          output.log(`│ Session: ${session.title}`);
          output.log(`│ Messages to compact: ${chalk.yellow(preview.messageCountToCompact)}`);
          output.log(`│ Estimated checkpoint tokens: ${preview.estimatedCheckpointTokens}`);
          output.log(`│ Would trigger: ${preview.wouldTrigger ? chalk.green("Yes") : chalk.gray("No")}`);
          output.log("│");
          output.log("│ " + chalk.gray("(Dry run - no changes made)"));
          output.log("└" + "─".repeat(51) + "┘");
        }
        return;
      }

      // ================================================================
      // 两阶段逻辑：如果未指定 scenario，自动生成 hint
      // ================================================================
      let scenarioHint = a.scenario || "";
      
      if (!scenarioHint) {
        if (!a.json) {
          output.info("Generating scenario hint...");
        }
        try {
          scenarioHint = await sessionComponent.generateCompactHint(a.sessionId);
          if (!a.json) {
            output.log(chalk.bold("├─ Auto-generated Scenario Hint ──────────────────────────┤"));
            output.log("│ " + chalk.cyan(scenarioHint.substring(0, 70)));
            if (scenarioHint.length > 70) {
              output.log(chalk.gray("│ ") + scenarioHint.substring(70, 140));
            }
          }
        } catch (hintError) {
          if (!a.json) {
            output.warn("Failed to generate scenario hint, continuing with empty hint");
          }
          scenarioHint = "";
        }
      } else {
        if (!a.json) {
          output.info(`Using provided scenario: ${a.scenario}`);
        }
      }

      // ================================================================
      // 执行 compact
      // ================================================================
      if (!a.json) {
        output.info("Generating checkpoint...");
      }

      const result = await sessionComponent.compact(a.sessionId, {
        // ★ Task #4933（C 方案）：CompactOptions 只剩 scenarioHint。
        //   旧的 summary 字段在 compact() 中从未被读取 —— 不再传递。
        scenarioHint,
      });

      if (a.json) {
        output.json({
          success: true,
          hint: {
            autoGenerated: !a.scenario,
            value: scenarioHint || null,
          },
          checkpoint: {
            id: result.checkpoint.id,
            title: result.checkpoint.title,
            // ★ C 方案（Task #4933）：整段自然语言正文
            content: result.checkpoint.content,
            createdAt: new Date(result.checkpoint.createdAt).toISOString(),
          },
          stats: {
            messagesCompacted: result.deletedMessageCount,
            remainingMessages: result.remainingMessageCount,
            totalCheckpoints: result.checkpointCount,
          },
        });
      } else {
        // 成功输出
        output.log(chalk.bold.green("┌─ Checkpoint Created ────────────────────────────────┐"));
        output.log(`│ ID:      ${result.checkpoint.id}`);
        output.log(`│ Title:   ${result.checkpoint.title}`);
        output.log(`│ Type:    compact`);
        output.log(`│ Created: ${new Date(result.checkpoint.createdAt).toLocaleString("zh-CN")}`);
        
        // Scenario Hint 部分
        output.log(chalk.bold("├─ Scenario Hint ────────────────────────────────────┤"));
        if (scenarioHint) {
          const hintLines = scenarioHint.split("\n");
          hintLines.forEach((line: string, i: number) => {
            if (i === 0) {
              output.log(chalk.cyan("│ " + line.substring(0, 48)));
              if (line.length > 48) {
                for (let j = 48; j < line.length; j += 48) {
                  output.log(chalk.gray("│ ") + line.substring(j, j + 48));
                }
              }
            } else {
              output.log(chalk.gray("│ ") + line);
            }
          });
        } else {
          output.log(chalk.gray("│ (no hint)"));
        }
        
        // ★ C 方案（Task #4933）：整段自然语言正文
        output.log("├─ Content ───────────────────────────────────────────┤");
        for (const line of (result.checkpoint.content ?? "").split("\n")) {
          output.log(`│ ${line}`);
        }
        if (result.checkpoint.recentMessages?.length) {
          output.log("├─ Recent Messages (preserved for context) ──────────┤");
          result.checkpoint.recentMessages.forEach((msg) => {
            const prefix = msg.role === 'user' ? '👤' : '🤖';
            const content = msg.content.length > 60 
              ? msg.content.substring(0, 60) + '...' 
              : msg.content;
            output.log(chalk.gray(`│ ${prefix} [${msg.role}] ${content}`));
          });
        }
        output.log("├─ Stats ─────────────────────────────────────────────┤");
        output.log(`│ Messages compacted: ${chalk.yellow(result.deletedMessageCount)}`);
        output.log(`│ Remaining messages: ${result.remainingMessageCount}`);
        output.log(`│ Total checkpoints: ${result.checkpointCount}`);
        output.log("└" + "─".repeat(51) + "┘");
      }
    } catch (error) {
      output.error(`Failed to compact session: ${error instanceof Error ? error.message : String(error)}`);
      if (process.env.DEBUG) {
        console.error(error);
      }
      process.exit(1);
    } finally {
      await envService.dispose();
    }
  },
};
