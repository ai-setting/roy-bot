/**
 * @fileoverview Sessions Mock Command
 * 
 * 命令：roy-bot sessions mock <session-id>
 * 
 * 插入模拟的交互消息（模拟一个完整的 agent 交互流程）
 */

import { CommandModule } from "yargs";
import { EnvironmentService } from "../../services/environment.service";
import { OutputService } from "../../services/output.service";
import chalk from "chalk";
import type { SessionComponent, Session } from "@ai-setting/roy-bot-core";

interface MockOptions {
  sessionId: string;
  count?: number;
  json?: boolean;
  config?: string;
}

// 模拟的消息序列（一个完整的 agent 交互）
const MOCK_SEQUENCES = [
  // 序列 1: 文件操作
  {
    name: "文件操作流程",
    messages: [
      { role: "user", content: "帮我查看一下当前目录有哪些文件" },
      { role: "assistant", content: "", toolCalls: [{ name: "glob", args: { pattern: "**/*" } }] },
      { role: "tool", content: "找到 5 个文件:\n- README.md\n- package.json\n- src/index.ts\n- src/app.ts\n- tsconfig.json" },
      { role: "assistant", content: "当前目录包含以下文件：\n1. README.md - 项目说明\n2. package.json - 项目配置\n3. src/index.ts - 入口文件\n4. src/app.ts - 应用文件\n5. tsconfig.json - TypeScript 配置" },
    ],
  },
  // 序列 2: 搜索代码
  {
    name: "代码搜索流程",
    messages: [
      { role: "user", content: "搜索一下代码中包含 'TODO' 的地方" },
      { role: "assistant", content: "", toolCalls: [{ name: "grep", args: { pattern: "TODO" } }] },
      { role: "tool", content: "找到 3 处 TODO:\n1. src/index.ts:15 - TODO: 实现错误处理\n2. src/app.ts:42 - TODO: 优化性能\n3. src/utils.ts:8 - TODO: 添加单元测试" },
      { role: "assistant", content: "代码中发现 3 处 TODO 标记：\n\n| 文件 | 行号 | 内容 |\n|------|------|------|\n| src/index.ts | 15 | 实现错误处理 |\n| src/app.ts | 42 | 优化性能 |\n| src/utils.ts | 8 | 添加单元测试 |\n\n需要我帮你处理这些 TODO 吗？" },
    ],
  },
  // 序列 3: 写文件
  {
    name: "写文件流程",
    messages: [
      { role: "user", content: "帮我创建一个新的配置文件 config.yaml" },
      { role: "assistant", content: "", toolCalls: [{ name: "writeFile", args: { path: "config.yaml", content: "# 配置文件\nname: my-app\nversion: 1.0.0\n\ndatabase:\n  host: localhost\n  port: 5432" } }] },
      { role: "tool", content: "文件 config.yaml 已创建成功" },
      { role: "assistant", content: "已创建配置文件 `config.yaml`，包含：\n- 基本配置（name, version）\n- 数据库配置（host, port）\n\n你可以根据需要修改这些配置。" },
    ],
  },
  // 序列 4: 读取文件
  {
    name: "读取文件流程",
    messages: [
      { role: "user", content: "看看 package.json 的内容" },
      { role: "assistant", content: "", toolCalls: [{ name: "readFile", args: { path: "package.json" } }] },
      { role: "tool", content: '{\n  "name": "my-app",\n  "version": "1.0.0",\n  "scripts": {\n    "dev": "bun run src/index.ts",\n    "build": "bun build"\n  }\n}' },
      { role: "assistant", content: "package.json 内容如下：\n\n```json\n{\n  \"name\": \"my-app\",\n  \"version\": \"1.0.0\",\n  \"scripts\": {\n    \"dev\": \"bun run src/index.ts\",\n    \"build\": \"bun build\"\n  }\n}\n```\n\n这是一个标准的 Node.js 项目配置。" },
    ],
  },
];

export const MockCommand: CommandModule<object, object> = {
  command: "mock <session-id>",
  describe: "插入模拟消息到会话（用于测试 checkpoint）",

  builder: (yargs) =>
    yargs
      .positional("session-id", {
        describe: "会话 ID",
        type: "string",
        demandOption: true,
      })
      .option("count", {
        alias: "n",
        type: "number",
        default: 1,
        description: "插入几组模拟消息（1-4）",
      })
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

      const count = Math.min(Math.max(a.count || 1, 1), MOCK_SEQUENCES.length);
      const addedMessages: string[] = [];

      if (!a.json) {
        output.info(`Inserting ${count} mock sequence(s) into session...`);
        output.log("");
      }

      // 添加模拟消息
      for (let seqIdx = 0; seqIdx < count; seqIdx++) {
        const sequence = MOCK_SEQUENCES[seqIdx];

        if (!a.json) {
          output.log(chalk.bold(`\n📝 Sequence ${seqIdx + 1}: ${sequence.name}`));
        }

        for (const msg of sequence.messages) {
          // 处理 tool call 消息
          if (msg.role === "assistant" && msg.toolCalls) {
            // 添加 assistant 消息（带 tool call）
            const toolCallText = msg.toolCalls
              .map((tc) => `🔧 Calling tool: ${tc.name}\n\`\`\`\n${JSON.stringify(tc.args, null, 2)}\n\`\`\``)
              .join("\n\n");

            const assistantMsgId = await sessionComponent.addMessage(a.sessionId!, {
              role: "assistant",
              content: toolCallText,
            });
            if (assistantMsgId) addedMessages.push(assistantMsgId);

            if (!a.json) {
              output.log(chalk.cyan(`  [${addedMessages.length}] assistant: 🔧 Tool call`));
            }

            // 添加 tool result
            const toolMsgId = await sessionComponent.addMessage(a.sessionId!, {
              role: "tool",
              content: msg.content,
            });
            if (toolMsgId) addedMessages.push(toolMsgId);

            if (!a.json) {
              output.log(chalk.yellow(`  [${addedMessages.length}] tool: ${msg.content.substring(0, 50)}...`));
            }
          } else {
            // 普通消息
            const msgId = await sessionComponent.addMessage(a.sessionId!, {
              role: msg.role as any,
              content: msg.content,
            });
            if (msgId) addedMessages.push(msgId);

            if (!a.json) {
              const roleColor = msg.role === "user" ? chalk.green : msg.role === "assistant" ? chalk.cyan : chalk.gray;
              output.log(roleColor(`  [${addedMessages.length}] ${msg.role}: ${msg.content.substring(0, 50)}...`));
            }
          }
        }
      }

      // 显示结果
      if (a.json) {
        output.json({
          success: true,
          sessionId: a.sessionId,
          sequencesAdded: count,
          messagesAdded: addedMessages.length,
          messageIds: addedMessages,
        });
      } else {
        output.log("\n" + chalk.bold.green("✅ Mock data inserted successfully!"));
        output.log(`   Session: ${a.sessionId}`);
        output.log(`   Sequences: ${count}`);
        output.log(`   Messages: ${addedMessages.length}`);
        output.log("");
        output.log(chalk.gray("   Now run: "));
        output.log(chalk.gray(`   roy-bot sessions compact ${a.sessionId}`));
        output.log(chalk.gray("   to trigger checkpoint generation"));
      }
    } finally {
      await envService.dispose();
    }
  },
};
