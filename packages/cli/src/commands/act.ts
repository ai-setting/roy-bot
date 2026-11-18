/**
 * @fileoverview Act Command
 * 
 * 自然语言交互命令 - CLI 核心命令
 * 
 * 功能：
 * - 支持在指定 session 上继续对话（--session）
 * - 支持继续上次会话（--continue）
 * - 支持上下文阈值自动压缩
 */

import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { CommandModule } from "yargs";
import { EnvironmentService } from "../services/environment.service";
import { OutputService } from "../services/output.service";
import { StreamOutputService } from "../services/stream-output.service";
import { ContextHandlerService } from "../services/context-handler.service";
import { ContextError, ErrorCodes, getTracerProvider, type ContentPart } from "@ai-setting/roy-bot-core";
// Task #4625: 上游失败 → 一行可读说明（额度类失败带恢复窗口）
import { formatCliFailureLine } from "@ai-setting/roy-bot-core/env/error-reply";
import { CliQuietModeService } from "../services/quiet-mode.service";
import { TaskEventHandler } from "./shared/task-event-handler";
import {
  buildActAgentContext,
  isWorkflowPausedActResult,
  validateActAgent,
  type ActAgentLookup,
} from "./act-agent-validation";
// ★ Task #4634：CLI --model / --fallback-model → AgentContext 的统一接线
import {
  buildModelAgentContext,
  checkFallbackModelArg,
  FALLBACK_MODEL_DESCRIBE,
  MODEL_DESCRIBE,
} from "./model-flags";
import { assembleMultimodalMessage, parseActImageArgs } from "./shared/multimodal-message";
import { runActShutdownCleanup } from "./act-shutdown";
import { finalizeActStdout } from "./act-stdout-finalize";

export type WorkspaceRootGitRunner = (
  command: string,
  args: string[],
  options: {
    cwd: string;
    encoding: "utf8";
    stdio: ["ignore", "pipe", "ignore"];
  },
) => string;

/** Detect the git workspace root, falling back to the caller's cwd. */
export function detectWorkspaceRoot(
  cwd: string = process.cwd(),
  runGit: WorkspaceRootGitRunner = execFileSync as WorkspaceRootGitRunner,
): string {
  try {
    return runGit("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return cwd;
  }
}

const execFileAsync = promisify(execFile);

/**
 * F8: 异步版本的 detectWorkspaceRoot。
 * 使用 promisify(execFile) 替代 execFileSync，避免阻塞 CLI 主线程。
 * 失败时回退到 cwd，行为与同步版本一致。
 */
export async function detectWorkspaceRootAsync(
  cwd: string = process.cwd(),
): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return cwd;
  }
}

export interface ActOptions {
  message?: string;
  continue?: boolean;
  session?: string;
  model?: string;
  /**
   * Task #4623 — 兜底模型（`providerId/modelId`）。
   * 主模型 404 / 429 / 配额耗尽 / 5xx / 超时 / 重试耗尽时，本次 run 自动降级。
   * default agent 与 sub agent 均生效。
   */
  fallbackModel?: string | string[];
  agent?: string;     // 指定的 agent 名称
  env?: string;
  config?: string;
  quiet?: boolean;
  reasoning?: boolean;
  toolCalls?: boolean;
  toolResults?: boolean;
  plugins?: string[];  // 启用的 coder 插件列表，如 ["lsp", "code-check", "reminder"]
  /**
   * 多模态：附加图片到 user message。
   * - 单张：--image ./a.png
   * - 多张：--image ./a.png --image ./b.jpg
   * - 也支持 URL：--image https://example.com/cat.jpg
   * - yargs 自动归一化为 string[]
   */
  image?: string[];
}

/**
 * 创建 ActCommand
 * 
 * @param externalEnvService - 外部传入的 EnvironmentService（可选）
 *        如果传入，三方可以在自己的代码中获取 env 实例并调用 publishEvent 等接口
 * @returns yargs CommandModule
 * 
 * @example
 * // 三方集成示例
 * import { createActCommand, EnvironmentService } from "@ai-setting/roy-bot-cli";
 * 
 * const envService = new EnvironmentService();
 * await envService.create({ /* config *\/ });
 * 
 * const env = envService.getEnvironment();
 * // 三方可以调用 env.publishEvent() 等接口
 * 
 * const ActCommand = createActCommand(envService);
 * // 使用 yargs 注册并执行命令
 */
export function createActCommand(
  externalEnvService?: EnvironmentService
): CommandModule<object, ActOptions> {
  return {
    command: "act [message]",
    describe: "自然语言交互 - 通过自然语言驱动整个操作系统",

    builder: (yargs) =>
      yargs
        .positional("message", {
          describe: "要执行的消息",
          type: "string",
        })
        .option("continue", {
          alias: "c",
          describe: "继续上次会话",
          type: "boolean",
          default: false,
        })
        .option("session", {
          alias: "s",
          describe: "指定会话 ID",
          type: "string",
        })
        .option("model", {
          describe: MODEL_DESCRIBE,
          type: "string",
        })
        .option("fallback-model", {
          describe: FALLBACK_MODEL_DESCRIBE,
          type: "string",
        })
        // ★ Task #4724 review2 MINOR-1/MINOR-2：非法的显式兜底值
        //   在**参数解析阶段**就报错退出，不静默放行。
        .check(checkFallbackModelArg)
        .option("config", {
          alias: "C",
          describe: "配置文件路径",
          type: "string",
        })
        .option("quiet", {
          describe: "安静模式（默认开启）",
          type: "boolean",
          default: true,
        })
        .option("reasoning", {
          alias: "r",
          describe: "显示 AI 思考过程",
          type: "boolean",
          default: true,
        })
        .option("tool-calls", {
          describe: "显示工具调用",
          type: "boolean",
          default: true,
        })
        .option("tool-results", {
          describe: "显示工具执行结果",
          type: "boolean",
          default: false,
        })
        .option("plugin", {
          alias: "p",
          describe: "启用 coder plugin (tslsp, pylsp, mdlsp, lsp, code-check, reminder)",
          type: "array",
          string: true,
        })
        .option("agent", {
          alias: "a",
          describe: "指定要使用的 agent（如 explore, markdown-ontology-extractor）",
          type: "string",
        })
        .option("image", {
          alias: "i",
          describe: "附加图片到消息（可多次传入；支持本地路径 / http(s) URL / data:base64）",
          type: "array",
          string: true,
        }),

    async handler(args) {
      // 设置日志 quiet 模式
      const quiet = args.quiet ?? true;
      CliQuietModeService.getInstance().setQuiet(quiet);

      const output = new OutputService();
      output.configure({ quiet });

      // 验证消息
      if (!args.message) {
        output.error("请提供要执行的消息，使用方式：roy-bot act <消息>");
        output.info("示例：roy-bot act \"帮我写一个 hello world\"");
        process.exit(1);
      }

      // P1: 解析 --image 多图参数
      //  - undefined → [] (backward compat)
      //  - string → [string] (yargs 单值)
      //  - string[] → 过滤空值 + 去重
      const imageArgs = parseActImageArgs(args.image);
      const hasImages = imageArgs.length > 0;
      if (hasImages && !quiet) {
        output.info(`📎 附加 ${imageArgs.length} 张图片`);
      }

      // 如果有外部传入的 envService，使用它；否则内部创建
      const shouldDisposeEnvService = !externalEnvService;
      const envService = externalEnvService ?? new EnvironmentService(output);

      // Plugin adapter dispose 函数（需要在 finally 中调用）
      let pluginAdapterDispose: (() => Promise<void>) | null = null;
      // LSP Manager dispose 函数
      let lspManagerDispose: (() => Promise<void>) | null = null;
      // Task Event Handler stop 回调（需要在 finally 中调用）
      // 必须声明在 try 之外 —— let/const 块作用域仅限 try，finally 看不到
      let stopTaskEventHandlerCleanup: (() => void) | null = null;

      // ========== 解析插件参数 ==========
      const rawPlugins = args.plugin;
      const pluginNames: string[] = Array.isArray(rawPlugins)
        ? rawPlugins
        : rawPlugins
          ? [rawPlugins]
          : [];

      // coder-harness 插件名称集合
      // coder-harness 插件名称集合（支持新旧两种命名）
      // 旧命名: lsp (统一 LSP)
      // 新命名: tslsp, pylsp, mdlsp (语言特定 LSP)
      const CODER_HARNESS_PLUGINS = new Set([
        "lsp",           // 统一 LSP（兼容旧命名）
        "code-check",    // 外部命令检查
        "reminder",      // 迭代提醒
        // 语言特定 LSP（phase-3 新增）
        "tslsp",         // TypeScript LSP
        "pylsp",        // Python LSP
        "mdlsp",        // Markdown LSP
        "ontologylsp",  // Typed Markdown Ontology (ontology-harness)
      ]);

      // 分离 coder-harness 插件和其他插件
      const coderPluginNames: string[] = [];
      const otherPluginNames: string[] = [];
      
      for (const plugin of pluginNames) {
        const name = plugin.split(":")[0];
        if (CODER_HARNESS_PLUGINS.has(name)) {
          coderPluginNames.push(plugin);
        } else {
          otherPluginNames.push(plugin);
        }
      }

      // 日志输出加载的插件
      if (otherPluginNames.length > 0 && !quiet) {
        output.info(`📌 加载插件: ${otherPluginNames.join(", ")}`);
      }

      try {
        if (!quiet) {
          output.info("初始化环境...");
        }

        // 创建环境（如果有外部传入的 envService，跳过创建）
        if (!externalEnvService) {
          await envService.create({
            envName: args.env,
            configPath: args.config,
            plugins: [...otherPluginNames, ...coderPluginNames],
            loadPlugins: true,
            commandName: "act",
          });
        }

        const env = envService.getEnvironment();
        const sessionComponent = envService.getSession();

        if (!sessionComponent) {
          output.error("SessionComponent not available");
          process.exit(1);
        }

        // 校验 --agent 指定的 agent 是否存在
        if (args.agent && args.agent !== "default") {
          const agentComponent = env.getComponent("agent") as ActAgentLookup | undefined;
          const validation = validateActAgent(agentComponent, args.agent);
          if (!validation.valid) {
            output.error(validation.message);
            output.info("提示: roy-bot agents list");
            process.exit(1);
          }
          if (!quiet) {
            output.info(`Agent: ${args.agent}`);
          }
        }

        // ========== Task Event Handler（订阅 task.* 事件） ==========
        const taskEventHandlerForCleanup = new TaskEventHandler({
          env,
          enabled: true, // 始终启用，Logger 会根据 quiet 模式控制输出
        });
        // 赋值给外层声明（在 try 之外），finally 才能看到
        stopTaskEventHandlerCleanup = taskEventHandlerForCleanup.start();

        // ========== Session 处理 ==========
        let sessionId = args.session;

        // 如果指定了 --continue，获取上次会话
        if (args.continue && !sessionId) {
          const activeSession = await sessionComponent.getActiveSession();
          if (activeSession) {
            sessionId = activeSession.id;
            if (!quiet) {
              output.info(`继续会话: ${activeSession.title} (${sessionId})`);
            }
          } else {
            output.warn("没有找到上次会话，将创建新会话");
          }
        }

        // 如果指定了 session，设置为 active 并获取会话信息
        if (sessionId) {
          await sessionComponent.setActiveSession(sessionId);
          const session = await sessionComponent.get(sessionId);
          if (session) {
            if (!quiet) {
              output.info(`会话: ${session.title} (${sessionId})`);
            }
          } else if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) {
            // 非法 ID（可能含特殊字符 / 超长 / 空）→ 拒绝 + fallback 创建
            output.warn(`会话 ID 格式非法: ${sessionId}，将创建新会话`);
            sessionId = undefined;
          } else if (!quiet) {
            // 合法但不存在：保留 sessionId 供下方 create() 用作 ID
            // 这样 task-show / CLI 等可以自产唯一 sessionId 命名空间
            output.info(`会话 ID 合法但不存在，将使用此 ID 创建新会话: ${sessionId}`);
          }
        }

        // 如果没有 session（或合法但不存在），创建一个新会话
        // - sessionId 为空 → create({ id: undefined }) → backend 自动生成
        // - sessionId 合法但不存在 → create({ id: sessionId }) → 使用用户提供的 ID
        if (!sessionId || !(await sessionComponent.get(sessionId))) {
          const newSession = await sessionComponent.create({
            id: sessionId,
            title: `Session - ${new Date().toLocaleString("zh-CN")}`,
          });
          sessionId = newSession.id;
          await sessionComponent.setActiveSession(sessionId);
          if (!quiet) {
            output.info(`创建新会话: ${newSession.title} (${sessionId})`);
          }
        }

        // 初始化 SummaryAgent（用于 compact）
        const llmComponent = envService.getLLM();
        if (!env) {
          output.error("Environment not available");
          process.exit(1);
        }
        // compact agent 已内置注册（compact / compact-hint），无需外部初始化

        // ========== Plugin 加载（coder-harness 插件） ==========
        // coder-harness 插件已通过 EnvironmentService.loadPlugins() 加载
        // 这里只需要处理 LSP 预热（如果需要）
        if (coderPluginNames.includes("lsp")) {
          try {
            // 过滤有效的插件名称
            const enabledPlugins = coderPluginNames.filter(
              (p) => CODER_HARNESS_PLUGINS.has(p.split(":")[0])
            );
            if (enabledPlugins.length > 0) {
              console.log(`已启用插件: ${enabledPlugins.join(", ")}`)
              output.success(`✅ 已启用插件: ${enabledPlugins.join(", ")}`);
              
              // 显示 LSP 预加载信息
              if (!quiet) {
                output.info(`🔧 LSP 服务预加载中，首次诊断可能需要等待...`);
              }
            }

            // 加载 LSP 配置并预热
            const { createLSPConfigLoader } = await import("@ai-setting/roy-bot-coder-harness");
            const configLoader = createLSPConfigLoader();
            const lspConfig = configLoader.load();

            if (!quiet) {
              output.info("正在预热 LSP 服务器...");
              if (lspConfig.preload) {
                output.info("📋 使用配置文件中的预加载设置");
              }
            }
            const { createGlobalLSPManager } = await import("@ai-setting/roy-bot-coder-harness");
            const detectedRoot = detectWorkspaceRoot();
            const lspManager = createGlobalLSPManager({
              idleTimeout: lspConfig.idleTimeout ?? 300000,
              maxConnections: lspConfig.maxConnections ?? 10,
              autoDownload: lspConfig.autoInstall ?? false,
              preloadLanguages: lspConfig.preloadLanguages,
              workspaceRoot: detectedRoot,
            });
            // 注册 shutdown handler 确保进程退出时清理
            lspManager.registerShutdownHandler();
            // 保存 dispose 函数以便在退出时调用
            lspManagerDispose = () => lspManager.dispose();
            // 预热所有服务器（异步，不阻塞）
            if (lspConfig.preload || coderPluginNames.includes("lsp")) {
              lspManager.prewarm(undefined, detectedRoot).then(() => {
                if (!quiet) {
                  output.success("✅ LSP 服务器预热完成");
                }
              }).catch((err) => {
                if (!quiet) {
                  output.warn(`⚠ LSP 预热部分失败: ${err.message}`);
                }
              });
            }
          } catch (error) {
            output.warn(`⚠ LSP 预热失败: ${error}`);
          }
        }

        // 创建流式输出服务
        const streamService = new StreamOutputService({
          showReasoning: args.reasoning,
          showToolCalls: args.toolCalls,
          showToolResults: args.toolResults,
        });

        // 设置 context window 配置（如果有 LLM component）
        if (llmComponent) {
          const contextConfig = llmComponent.getContextThresholdConfig("minimax");
          streamService.setContextInfo(contextConfig.contextWindow, contextConfig.contextWindow * contextConfig.thresholdRatio);
        }

        // 订阅 LLM 事件和上下文事件进行流式输出
        const unsubscribe = env.subscribeTo(
          [
            "llm.start",
            "llm.text",
            "llm.reasoning",
            "llm.completed",
            "llm.error",
            "tool.call",
            "tool.result",
            "tool.error",
            "context.threshold_exceeded",
            "context.compacting",
            "context.compacted",
            "workflow.node.start",
            "workflow.node.completed",
            "workflow.completed",
            "workflow.failed",
          ],
          (event) => {
            // 上下文压缩事件
            if (event.type === "context.threshold_exceeded" && !quiet) {
              const payload = event.payload as any;
              output.warn(`⚙ 上下文阈值 (${payload.totalTokens}/${payload.contextWindow})`);
            }
            if (event.type === "context.compacting" && !quiet) {
              output.info("⚙ 压缩中...");
            }
            if (event.type === "context.compacted" && !quiet) {
              const payload = event.payload as { checkpointId?: string };
              output.success(`✓ 已压缩 (${payload.checkpointId ?? "unknown"})`);
            }

            // ★ P2: Workflow 事件提示
            if (event.type === "workflow.node.start" && !quiet) {
              const payload = event.payload as any;
              output.info(`⚙ 工作流节点: ${payload.nodeId || ""}`);
            }
            if (event.type === "workflow.node.completed" && !quiet) {
              const payload = event.payload as any;
              output.success(`✓ 工作流节点完成: ${payload.nodeId || ""}`);
            }
            if (event.type === "workflow.completed" && !quiet) {
              output.success(`✓ 工作流执行完成`);
            }
            if (event.type === "workflow.failed" && !quiet) {
              const payload = event.payload as { error?: { message?: string } };
              const msg = payload?.error?.message ?? "unknown error";
              output.error(`✗ 工作流失败: ${msg}`);
            }

            // 其他事件交给 streamService 处理
            streamService.handleEvent(event);
          }
        );

        if (!quiet) {
          output.info(`执行: ${args.message}`);
        }

        // ========================================================================
        // 使用 OTel tracer 创建根 span
        // 
        // 使用统一的 roy-tracer，这样可以继承全局 context
        // ========================================================================
        const provider = getTracerProvider();
        const tracer = provider.getTracer("roy-tracer");
        const rootSpan = tracer.startSpan("act.execute", {
          attributes: {
            message: args.message.substring(0, 200),
            sessionId,
            ...(buildActAgentContext(args.agent) ?? {}),
          },
        });
        const traceId = rootSpan.spanContext.traceId;
        
        if (!quiet) {
          output.info(`[Trace] ${traceId}`);
        }

        // 设置全局 context
        provider.setGlobalContext(rootSpan.spanContext);

        // 创建 Context Handler（用于自动压缩）
        const contextHandler = new ContextHandlerService(
          env,
          sessionComponent,
          { maxRetries: 1, autoCompact: true }
        );

        // 构建 context（携带 trace id 和 agent 信息）
        const context = {
          sessionId,
          ...buildActAgentContext(args.agent),
          // ★ Task #4634：model / fallbackModel 统一由 buildModelAgentContext 产出
          //   （--model → 主模型；--fallback-model → 兜底模型，CLI 覆盖配置
          //    llm.fallbackModel，default + sub agent 均生效）
          ...buildModelAgentContext(args),
          metadata: {
            originalQuery: args.message,
            traceId,
            // P1: 标记是否多模态 (用于 compact summary 区分)
            queryKind: hasImages ? "multimodal" : "text",
          },
        };

        // P1: 组装多模态 user message
        //   0 张图 → 保持 string (backward compat, 避免 microtask)
        //   ≥1 张图 → ContentPart[] (text first, then images)
        const finalQuery: string | ContentPart[] =
          hasImages
            ? await assembleMultimodalMessage(args.message!, imageArgs)
            : args.message!;

        // 执行查询（带上下文阈值处理）
        let result: string;
        try {
          result = await contextHandler.handleQueryWithContext(finalQuery, context);
          rootSpan.end(result);
        } catch (error) {
          rootSpan.setAttribute("error", String(error));
          rootSpan.end(undefined, error instanceof Error ? error : new Error(String(error)));
          
          if (error instanceof ContextError && error.code === ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED) {
            output.error(
              `上下文阈值超出限制: ${error.usage?.totalTokens}/${error.contextWindow}`
            );
            output.info(
              "请手动压缩会话: roy-bot sessions compact " + (sessionId || "<session-id>")
            );
          }
          throw error;
        } finally {
          // 清理全局 context
          provider.setGlobalContext(undefined);
        }

        unsubscribe();

        // 显示结果：仅在 LLM 流没有发出任何文本时（workflow agent / 零文本响应）
        // 才补打印，否则会与 StreamOutputService 已经通过 process.stdout.write
        // 输出到 stdout 的内容重复（Task #2833）。
        finalizeActStdout({
          result,
          streamService,
          output,
        });

        if (!quiet) {
          if (isWorkflowPausedActResult(result)) {
            output.warn("工作流已暂停，等待用户输入（见上方 resume 提示）");
          } else {
            output.success("执行完成");
          }
        }
      } catch (error) {
        // Task #4625: 上游失败压成一行可读说明。
        // 原来直接打 `error.message`，对 `AIRetryError` 来说是
        // "Failed after 4 attempts. Last error: ..." + 上游英文原文 ——
        // 既没说清是什么问题，也没说多久能恢复。额度类失败必须带恢复窗口。
        output.error(`执行失败: ${formatCliFailureLine(error)}`);
        if (process.env.DEBUG) {
          console.error(error);
        }
        process.exit(1);
      } finally {
        // 调用提取的 shutdown helper（包含 Step 0-3 + 后续的 Step 4 TempFileManager 清理）
        // ⚠️ 使用显式 key-value 形式（不用 shorthand）— 防止 Bun bundler 把
        //    helper 内部 destructure 重命名后未同步更新 shorthand 导致的 ReferenceError
        await runActShutdownCleanup({
          stopTaskEventHandlerCleanup: stopTaskEventHandlerCleanup,
          lspManagerDispose: lspManagerDispose,
          pluginAdapterDispose: pluginAdapterDispose,
          envService: envService,
          shouldDisposeEnvService: shouldDisposeEnvService,
          output: output,
          logger: { debug: () => {}, warn: console.warn },
        });
      }
    },
  };
}

/**
 * ActCommand - 自然语言交互命令（默认实例，用于 CLI）
 * 
 * @example
 * # 在指定 session 上继续对话
 * roy-bot act "继续开发" --session s_abc123
 * 
 * # 继续上次会话
 * roy-bot act "继续" --continue
 * 
 * # 组合使用
 * roy-bot act "继续" --continue --reasoning
 * 
 * # 启用 coder 插件
 * roy-bot act "帮我重构这段代码" --plugin lsp --plugin code-check --plugin reminder
 */
export const ActCommand = createActCommand();
