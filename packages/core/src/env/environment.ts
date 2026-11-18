/**
 * @fileoverview BaseEnvironment Implementation
 * 
 * Environment 的基础实现类（非抽象），提供：
 * - 组件注册与管理
 * - 核心调度方法（handle_query, handle_action）
 * - EnvEvent 事件机制
 * 
 * 设计原则：
 * 1. Environment 只做两件事：
 *    - 组件管理：持有、注册、获取组件
 *    - 核心调度：handle_query / handle_action / EnvEvent
 * 2. 其他能力归属到对应 Component
 * 
 * 子类可覆盖：
 * - registerDefaultComponents(): 注册默认组件
 * - handle_query(): 查询处理逻辑
 * - handle_action(): 动作处理逻辑
 * - onInit/onStart/onStop: 生命周期钩子
 */

import { BaseComponent, type Component } from "./component";
import type { 
  Environment, 
  ServiceConfig, 
  ComponentConfigEntry, 
  GeneratedComponentOptions 
} from "./interface";
import type { 
  EnvironmentConfig,
  BaseEnvironmentConfig,
  EnvEvent,
  EnvEventInput,
  EnvEventHandler,
  Action,
  ToolResult,
  Context,
} from "./types";
import { createLogger } from "./log-trace/logger";
import { generateId } from "../utils/id";
import { ContextError, ErrorCodes } from "./errors";
import * as fsSync from "fs";
import * as path from "path";
import { TracedAs } from "./log-trace/decorator";
import { envQueryParamFilter } from "./log-trace/trace-filters";
import type { AgentContext } from "./agent/types";
import type { AgentComponent } from "./agent/agent-component";
import type { PromptComponent } from "./prompt/prompt-component";
import type { MemoryComponent } from "./memory/memory-component";
import type { RunResult } from "./workflow/types/run";
import type { ConfigComponent } from "../config/config-component";
import type { ContentPart } from "./llm/types";
import { getEnvContext, runWithEnvContextAsync } from "./context/env-context";
import type { EnvContext } from "./context/env-context";

import { createAutoTaskPlugin } from "./task/plugins/auto-task-plugin";
import { createLayaDecisionPlugin } from "./task/plugins/laya-decision-plugin";
import { registerLayaCompletionTaskHook } from "./task/plugins/laya-completion-plugin";
import { TaskHookPoints } from "./task/hooks/task-hook-points";
import type { TaskComponent } from "./task/task-component";
import type { LayaDecisionPluginOptions } from "./task/plugins/laya-decision-plugin";
const logger = createLogger("environment");

/**
 * Task #4627 — 把 Laya 决策插件注册到 **task hook 通道**（`task:before.create`）。
 *
 * ⚠️ 为什么必须走 task hook 而不是 Agent Plugin（#4620 的 bug 1）：
 *   `AgentComponent.registerPlugin()` 只把 plugin 放进 `agent.plugins` Map，
 *   **不写 globalHookManager**；而 `agent.plugins` 只在 agent 作用域 hook 点
 *   被派发（`agent:before.start` / `agent:before.llm` / ...），**不含
 *   `task:before.create`**。`task:before.create` 的唯一派发路径是
 *   `TaskComponent.createTask()` → `globalHookManager.execute(...)`。
 *
 * ⚠️ 幂等保护：
 *   `globalHookManager.register()` 是 **push 到数组**（不覆盖同名），
 *   而 `handle_query` 每次调用都会走一遍注册逻辑 → 不去重会导致：
 *     ① hook 被注册 N 次 → hint 重复执行
 *     ② 模型被重复调用 N 次（每次 task_create 都打 N 次 HTTP）
 *   这里采用「先 unregister 再 register」保证**全局恰好 1 份**。
 *
 * ⚠️ fail-open：注册失败**绝不影响** agent 启动 / task_create 成功语义。
 *
 * @param taskComponent —— TaskComponent（由 `this.getComponent("task")` 取得）
 * @param options —— LayaDecisionPluginOptions（生产不传 → 读 auth.json；
 *                   测试可注入 decisionPort / fetchImpl）
 * @returns 是否成功注册
 */
export function registerLayaDecisionTaskHook(
  taskComponent: TaskComponent | undefined | null,
  options?: LayaDecisionPluginOptions,
): boolean {
  if (!taskComponent) {
    logger.warn(
      "[registerLayaDecisionTaskHook] TaskComponent not available — skip (fail-open)",
    );
    return false;
  }
  try {
    const hook = createLayaDecisionPlugin(options);

    // ★ 幂等：先摘掉同名的旧 hook，保证全局恰好 1 份
    taskComponent.unregisterHook(TaskHookPoints.BEFORE_CREATE, hook.name);

    taskComponent.registerHook(TaskHookPoints.BEFORE_CREATE, {
      name: hook.name,
      priority: hook.priority,
      execute: async (ctx: unknown) => {
        // ★ 永不抛：hook 的 execute 抛出会污染 task_component 的 hook 链
        try {
          // HookContext 的载荷在 `.data`；但不同调用方也可能直接传裸载荷
          const data =
            ctx && typeof ctx === "object" && "data" in ctx
              ? (ctx as { data: unknown }).data
              : ctx;
          await hook.execute(data);
        } catch (err) {
          logger.warn(
            `[registerLayaDecisionTaskHook] hook execution failed (ignored): ${
              (err as Error)?.message
            }`,
          );
        }
      },
    });
    logger.info(
      `[registerLayaDecisionTaskHook] registered hook "${hook.name}" at ${TaskHookPoints.BEFORE_CREATE} (priority=${hook.priority})`,
    );
    return true;
  } catch (err) {
    logger.warn(
      `[registerLayaDecisionTaskHook] registration failed (ignored): ${(err as Error)?.message}`,
    );
    return false;
  }
}

/**
 * 默认 agent 名字（向后兼容）
 */
export const DEFAULT_AGENT_NAME = "Roy";

/**
 * 注入 {{agent_name}} 占位符
 *
 * - 若 prompt 不含占位符 → 原样返回（零开销）
 * - 从 context.metadata.defaultAgentName 读取值
 * - 缺失/null/undefined/空字符串 → 回退到 DEFAULT_AGENT_NAME
 *
 * 用 `global` 正则（/g）确保替换所有出现，避免残留占位符。
 */
export function injectAgentNamePlaceholder(
  prompt: string,
  context?: AgentContext
): string {
  if (!prompt.includes("{{agent_name}}")) {
    return prompt;
  }
  const metadata = context?.metadata as Record<string, unknown> | undefined;
  const defaultAgentName =
    (typeof metadata?.defaultAgentName === "string" && metadata.defaultAgentName.length > 0)
      ? metadata.defaultAgentName
      : DEFAULT_AGENT_NAME;
  return prompt.replace(/\{\{agent_name\}\}/g, defaultAgentName);
}

/**
 * BaseEnvironment 实现类（非抽象）
 * 
 * 实现 Environment 接口，提供简洁的环境基础功能。
 * 子类可继承此类并覆盖特定方法来自定义行为。
 */
export class BaseEnvironment extends BaseComponent implements Environment {
  // ============ 标识 ============
  
  readonly name: string;
  readonly version: string;
  
  // ============ 组件管理 ============
  
  protected components = new Map<string, Component>();

  /**
   * 构造函数
   */
  constructor(config?: BaseEnvironmentConfig) {
    super();
    this.name = config?.name ?? "base-environment";
    this.version = config?.version ?? "1.0.0";
    
    // 注册默认组件
    this.registerDefaultComponents();
  }

  /**
   * 注册默认组件（子类可覆盖）
   */
  protected registerDefaultComponents(): void {
    // 子类可覆盖以注册默认组件
  }

  /**
   * 获取环境配置
   */
  getConfig(): EnvironmentConfig & { env: Environment } {
    return {
      name: this.name,
      version: this.version,
      enabled: true,
      env: this,
    };
  }

  // ============ 组件管理 ============

  /**
   * 注册组件
   */
  registerComponent(component: Component): void {
    this.components.set(component.name, component);
    logger.debug(`Component registered: ${component.name}`);
  }

  /**
   * 注销组件
   */
  unregisterComponent(name: string): void {
    const component = this.components.get(name);
    if (component) {
      this.components.delete(name);
      logger.debug(`Component unregistered: ${name}`);
    }
  }

  /**
   * 获取组件
   */
  getComponent<T extends Component>(name: string): T | undefined {
    return this.components.get(name) as T | undefined;
  }

  /**
   * 列出所有组件
   */
  listComponents(): Component[] {
    return Array.from(this.components.values());
  }

  // ============ 核心能力（子类可覆盖） ============

  /**
   * 处理自然语言查询（核心入口）
   * 
   * 委托给 AgentComponent.run() 处理
   */
  /**
   * ★ 2026-10-22：**入参只存摘要**（Task #4479）。
   *
   * `query` 是 `string | ContentPart[]` —— 多模态时是图片/文件数组，可能很大；
   * 返回值是完整的 agent 响应文本。把两者都换成摘要（长度/条数/类型）。
   */
  @TracedAs("env.handle_query", {
    paramFilter: envQueryParamFilter,
    recordResult: false,
    logResult: true,
    log: true,
  })
  async handle_query(
    query: string | ContentPart[],
    context?: AgentContext
  ): Promise<string> {
    // 1. 获取 AgentComponent
    const agentComponent = this.getComponent<AgentComponent>("agent");
    
    if (!agentComponent) {
      throw new Error("AgentComponent not found. Please register AgentComponent before calling handle_query.");
    }

    // 4. 根据 agentType 获取或创建 agent
    // - 如果 context.agentType 为空或 "default"，使用默认 agent
    // - 否则使用 context.agentType 对应的 agent（delegate-tool 会预先注册）
    const agentName = (context?.agentType && context.agentType !== "default") 
      ? context.agentType 
      : "default";

    // ★ P2: 提前检查 Workflow 类型 agent
    // Workflow agent 不需要 system prompt / memory 注入，提前返回节省开销
    const registry = agentComponent.getRegistry?.();
    if (registry) {
      const agentDef = registry.get(agentName);
      if (agentDef?.type === "workflow") {
        // ★ 创建 ALS 上下文，注入 agentContext 共享引用
        // 这样 workflow 内每个 agent node 通过 getEnvContext() 都能拿到同一个
        // agentContext 对象，setCurrentTaskId 写入的值跨节点可见
        // 优先继承现有 ALS 上下文的 agentContext 引用
        // 确保 workflow agent 内部的 setCurrentTaskId 能传播到父级
        const existingCtx = getEnvContext();
        const workflowEnvContext: EnvContext = {
          envEvent: (context as any) || { type: "workflow" },
          sourceId: "workflow",
          userId: (context?.metadata?.userId as string) || "",
          // ★ 继承外部 ALS 上下文的 replyChannel，确保 task hooks 能发送飞书通知
          replyChannel: existingCtx?.replyChannel,
          // ★ 继承外部 ALS 上下文的 pluginEnabled，确保插件状态检查通过
          pluginEnabled: existingCtx?.pluginEnabled,
          agentContext: existingCtx?.agentContext ?? {},  // 优先共享父级 ALS 的 agentContext
        };
        return await runWithEnvContextAsync(workflowEnvContext, async () => {
          return await this.handleWorkflowAgentQuery(
            agentName, query, agentComponent, context
          ) as string;
        });
      }
    }

    // 2. 获取 system prompt（从 PromptComponent 获取）
    let systemPrompt = "You are a helpful assistant.";
    let promptSource = "fallback";
    try {
      const promptComponent = this.getComponent<PromptComponent>("prompt");
      if (promptComponent) {
        // ★ 2026-10-16：显式声明这是 primary agent 的 prompt。
        //   commands-prompt hook 只对 primary 注入 Commands Arsenal（自定义命令文档）。
        const loadedPrompt = await promptComponent.getPrompt("default", {}, {
          agentType: "primary",
        });
        if (loadedPrompt) {
          systemPrompt = loadedPrompt;
          promptSource = "PromptComponent";
        }
      }
    } catch (err) {
      logger.warn(`[handle_query] Failed to get prompt from PromptComponent: ${err}`);
    }
    logger.info(`[handle_query] Using system prompt from ${promptSource}, length: ${systemPrompt.length}`);

    // 3. 读取 memory 内容并注入到 prompt（如果 {{memory}} 变量存在）
    let finalSystemPrompt = systemPrompt;
    if (systemPrompt.includes("{{memory}}")) {
      try {
        const memoryComponent = this.getComponent<MemoryComponent>("memory");
        if (memoryComponent) {
          const memoryContent = await memoryComponent.recallMemory();
          finalSystemPrompt = systemPrompt.replace("{{memory}}", memoryContent || "(No memory)");
          logger.info(`[handle_query] Injected memory content, length: ${memoryContent.length}`);
        } else {
          finalSystemPrompt = systemPrompt.replace("{{memory}}", "(Memory component not available)");
        }
      } catch (err) {
        logger.warn(`[handle_query] Failed to load memory content: ${err}`);
        finalSystemPrompt = systemPrompt.replace("{{memory}}", "(Failed to load memory)");
      }
    }

    // 3.1 注入 workspace_dir（当前工作目录）
    if (finalSystemPrompt.includes("{{workspace_dir}}")) {
      const workspaceDir = process.cwd();
      finalSystemPrompt = finalSystemPrompt.replace("{{workspace_dir}}", workspaceDir);
      logger.debug(`[handle_query] Injected workspace_dir: ${workspaceDir}`);
    }

    // 3.2 注入 {{agent_name}}（默认 agent 名字，可被 CLI --default-agent-name 覆盖）
    {
      const prev = finalSystemPrompt;
      finalSystemPrompt = injectAgentNamePlaceholder(finalSystemPrompt, context);
      if (prev !== finalSystemPrompt) {
        const metadata = context?.metadata as Record<string, unknown> | undefined;
        const injectedName =
          (typeof metadata?.defaultAgentName === "string" && metadata.defaultAgentName.length > 0)
            ? metadata.defaultAgentName
            : DEFAULT_AGENT_NAME;
        logger.debug(`[handle_query] Injected agent_name: ${injectedName}`);
      }
    }

    let agent = agentComponent.getAgent(agentName);
    if (!agent) {
      // 如果指定了 agentType 但 agent 不存在，使用默认 agent
      if (agentName !== "default") {
        logger.warn(`[handle_query] Agent "${agentName}" not found, falling back to "default"`);
      }
      agent = agentComponent.getAgent("default");
    }
    
    // 如果默认 agent 也不存在，则创建
    if (!agent) {
      // 为 default 接待 agent 设置工具黑名单：只保留 delegate_task 和 bash（用于简单 Roy 命令）
      // bash: 允许执行简单的 Roy Agent 相关命令
      // stop_task: 允许终止后台任务
      // read_file: 必须在所有 agent 中默认可用（用户明确要求），因为截断后需要按需读取完整内容
      //
      // ★ Task #5007 — 验收权移交 default agent：
      //   default 是**验收方**（裁判），roy sub-agent 是**执行方**（运动员）。
      //   task_complete 从黑名单移出 ⇒ default 可对 sub-agent 的产出做最终验收
      //   （触发 task:after.complete 的 goal 检查 decision model）。
      //   task_cancel 同理可用 —— 但**仅在用户明令取消时**才调用（Task #5055）。
      //
      // ★ Task #5007 后续优化 — task_operation_create 已解锁：
      //   default agent 可用它记录用户的反馈、说明、强调点到任务操作记录中，
      //   使 sub-agent 续推时通过 task_operation_list 读取上下文。
      //   操作记录因此成为 agents 间的通信介质（不只是人工日志）。
      //   ⚠️ task_create / task_update 仍保持禁用 —— 不改「执行与验收分离」原则。
      const defaultDeniedTools = [
        "echo", "glob", "grep", "write_file", "edit_file",
        "task_create", "task_update", "task_delete",
        "task_operation_update", "task_operation_delete",
        "skill",
        "record_memory", "recall_memory", "search_sessions", "get_session", "write_memory",
      ];
      // 动态添加所有以 mcp_ 开头的工具到拒绝列表
      try {
        const toolComponent = this.getComponent<any>("tool");
        if (toolComponent?.listTools) {
          const allTools = toolComponent.listTools() as Array<{ name: string }>;
          const mcpTools = allTools
            .filter((t: { name: string }) => t.name.startsWith("mcp_"))
            .map((t: { name: string }) => t.name);
          if (mcpTools.length > 0) {
            defaultDeniedTools.push(...mcpTools);
            logger.debug(`[handle_query] Dynamically denied MCP tools: ${mcpTools.join(", ")}`);
          }
        }
      } catch (err) {
        logger.warn(`[handle_query] Failed to dynamically filter MCP tools: ${err}`);
      }
      agent = agentComponent.registerAgent("default", {
        type: "primary",
        systemPrompt: finalSystemPrompt,
        deniedTools: defaultDeniedTools,
      });
      logger.info(`[handle_query] Created default receptionist agent with deniedTools: ${defaultDeniedTools.length} tools denied`);

    // 自动注册 AutoTaskPlugin v5.0 - 达到 iteration 阈值时向 user 推送 delegate_task 提醒
    // 默认 threshold=20（前 20 次迭代让 agent 自主尝试），卡住再推送提醒
    // v5.0 不再调用 AgentComponent.run() → 不再需要 agentComponent 字段
    try {
      const autoTaskPlugin = createAutoTaskPlugin({
        threshold: 20,
      });
      agentComponent.registerPlugin("default", autoTaskPlugin);
      logger.info("[handle_query] AutoTaskPlugin v5.0 registered on default agent (threshold=20)");
    } catch (err) {
      logger.warn(`[handle_query] Failed to register AutoTaskPlugin: ${err}`);
    }
    } else {
      // ★ 对已存在的 agent（含 registry 注册的 roy、explore 等），
      //    重新注入 memory 和 workspace_dir 到 systemPrompt
      //    （确保 {{memory}} 和 {{workspace_dir}} 在每次运行时都被正确替换）
      //    注意: agent.config 可能为空（如 registry 创建且有 systemPromptRef 时）
      if (agent.config?.systemPrompt) {
        if (agent.config.systemPrompt.includes("{{memory}}")) {
          try {
            const memoryComponent = this.getComponent<MemoryComponent>("memory");
            if (memoryComponent) {
              const memoryContent = await memoryComponent.recallMemory();
              agent.config.systemPrompt = agent.config.systemPrompt.replace("{{memory}}", memoryContent || "(No memory)");
            } else {
              agent.config.systemPrompt = agent.config.systemPrompt.replace("{{memory}}", "(Memory component not available)");
            }
          } catch (err) {
            logger.warn(`[handle_query] Failed to inject memory for agent ${agentName}: ${err}`);
            agent.config.systemPrompt = agent.config.systemPrompt.replace("{{memory}}", "(Failed to load memory)");
          }
        }
        if (agent.config.systemPrompt.includes("{{workspace_dir}}")) {
          agent.config.systemPrompt = agent.config.systemPrompt.replace("{{workspace_dir}}", process.cwd());
        }

        // Reuse the shared helper to inject {{agent_name}} (DRY).
        // Note: shadowing the outer `agentName` (agentType selector) is no longer
        // possible because we use the same name from `injectAgentNamePlaceholder()`.
        agent.config.systemPrompt = injectAgentNamePlaceholder(agent.config.systemPrompt, context);


      }
      logger.debug(`[handle_query] Injected memory/workspace_dir for existing agent: ${agentName}`);
    }

    // Task #4467 / #4627 — Laya 决策插件注册到 **task:before.create**。
    //
    // ⚠️ #4627 bug 2 修复：这段代码**必须放在 `if (!agent)` 分支之外**。
    //    原来它被塞在「default agent 不存在时才创建」的分支里 → `act --agent roy`
    //    时 roy agent 已在 AgentRegistry 注册 → 走 else 分支 → 整块被跳过
    //    → LayaDecisionPlugin **一次都没注册**。
    //
    // globalHookManager 是**全局单例**，与 agent 无关 —— 任何 agent 建任务
    // 都应该做 decision 检测，所以这里对所有 agent 生效。
    //
    // ⚠️ fail-open：注册失败不影响 agent 运行 / task_create 成功语义。
    try {
      const taskComponent = this.getComponent<TaskComponent>("task");
      registerLayaDecisionTaskHook(taskComponent);
    } catch (err) {
      logger.warn(`[handle_query] Failed to register LayaDecisionTaskHook: ${err}`);
    }

    // Task #4760 — Laya 完成判定插件注册到 **task:after.complete**。
    //
    // 与 create 侧对称：任何 agent 完成任务都应做「目标 vs 交付物」判定。
    // ⚠️ fail-open：注册失败不影响 agent 运行 / task_complete 成功语义。
    try {
      const taskComponent = this.getComponent<TaskComponent>("task");
      registerLayaCompletionTaskHook(taskComponent);
    } catch (err) {
      logger.warn(`[handle_query] Failed to register LayaCompletionTaskHook: ${err}`);
    }

    // 执行 agent
    const result = await agentComponent.run(agent.name, query, context);
    
    // 4. 如果有错误，检查是否是 ContextError，需要让上层处理
    if (result.error) {
      // 优先使用原始错误对象（保留 ContextError 类型信息）
      if (result.originalError instanceof ContextError) {
        throw result.originalError;
      }

      // ★ Task #4983 R4（DS review MINOR-2）：ask_user 编码载荷
      //   **必须先于** ContextError 启发式分流。
      //
      //   `result.error` 形如
      //   `__ASK_USER_ERROR__:{"query":"<用户问题>",...}` —— query
      //   正文来自用户提问，含 "context"/"token"/"threshold"/"阈值"
      //   等词时会被下面的子串启发式**误判成 ContextError** ⇒
      //   isAskUserError 不命中 ⇒ CLI 兜底投递不执行 +
      //   ContextHandlerService 进入对 ask_user 毫无意义的 compact
      //   重试。前缀是结构化标识，先分流后启发式。
      //
      //   原样抛出 plain Error（与下方其他错误的形态一致），
      //   CLI 层 query-executor.parseAskUserErrorPayload 仍能从
      //   message 前缀识别 ask_user ⇒ 兜底投递链路不断。
      //   R4 review MINOR-4：用 includes 而非 startsWith，与全仓
      //   其他三处识别口径一致（query-executor.ts:130/157、
      //   delegate-tool.ts:1172、agent-component-adapter.ts:409）；
      //   将来 result.error 被加前缀（如 [run:xxx]）也不会漏。
      if (result.error.includes("__ASK_USER_ERROR__:")) {
        throw new Error(result.error);
      }

      // 如果错误信息包含上下文阈值相关，抛出 ContextError 让 ContextHandler 处理
      const errorMsg = result.error.toLowerCase();
      if (
        errorMsg.includes("context") ||
        errorMsg.includes("threshold") ||
        errorMsg.includes("token") ||
        result.error.includes("CTX_001")
      ) {
        // 尝试从错误消息中提取上下文使用信息
        // 格式如: "Context threshold exceeded: 1230/10000 (12.3%)"
        const usageMatch = result.error.match(/(\d+)\/(\d+)\s*\(([\d.]+)%\)/);
        let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
        let contextWindow: number | undefined;
        
        if (usageMatch) {
          const totalTokens = parseInt(usageMatch[1], 10);
          usage = { 
            promptTokens: totalTokens, 
            completionTokens: 0, 
            totalTokens 
          };
          contextWindow = parseInt(usageMatch[2], 10);
        }
        
        // 构造 ContextError 抛出
        const ctxError = new ContextError(
          result.error,
          ErrorCodes.CONTEXT_THRESHOLD_EXCEEDED,
          context?.sessionId,
          usage,
          contextWindow
        );
        throw ctxError;
      }
      // 其他错误继续抛出。
      //
      // Task #4625：**必须把原始错误挂到 `cause` 上**。
      // 这里曾经只保留 `result.error` 这个字符串，导致结构化信息全部丢失：
      // `AI_RetryError` 里嵌套的 `APICallError.responseHeaders["retry-after"]`
      // 正是告诉用户"额度多久恢复"的唯一来源。丢掉它之后，CLI 只能说
      // "恢复时间未知"，用户无从判断该等还是该换模型。
      //
      // `cause` 是标准 Error 字段，`collectErrorText` / `extractRetryAfterSeconds`
      // 都会递归进去，所以保留它即可让窗口一路传到 CLI。
      throw new Error(
        result.error,
        result.originalError ? { cause: result.originalError } : undefined,
      );
    }
    
    // 6. 返回响应文本
    return result.finalText || "";
  }

  /**
   * ★ Workflow 类型 agent 查询处理
   * 
   * 检查 agentDef.type 是否为 "workflow"，是则通过 WorkflowComponent 执行 workflow。
   * 非 workflow 类型返回 null，让 handle_query 走原有 ReAct 路径。
   */
  /** ★ 2026-10-22：同 `env.handle_query`，只存摘要（Task #4479）。 */
  @TracedAs("env.handle_workflow_agent_query", {
    paramFilter: envQueryParamFilter,
    recordResult: false,
    logResult: true,
    log: true,
  })
  private async handleWorkflowAgentQuery(
    agentName: string,
    query: string | ContentPart[],
    agentComponent: AgentComponent,
    context?: AgentContext  // ★ 透传 handle_query 的 context 到 RunOptions
  ): Promise<string | null> {
    const registry = agentComponent.getRegistry?.();
    if (!registry) {
      return null;
    }

    const agentDef = registry.get(agentName);
    if (!agentDef || agentDef.type !== "workflow") {
      return null;
    }

    const workflowComponent = this.getComponent("workflow") as {
      getService?: () => { getWorkflowByName: (name: string) => any } | null;
      runWorkflow: (def: any, input: any, opts: any) => Promise<RunResult>;
    } | undefined;
    if (!workflowComponent) {
      throw new Error(
        `WorkflowComponent not available — cannot run workflow agent "${agentName}". ` +
        `Ensure the workflow component is registered.`
      );
    }

    const workflowName = agentDef.workflow;
    if (!workflowName) {
      throw new Error(
        `Agent "${agentName}" has type 'workflow' but no workflow configured.`
      );
    }

    // 通过 WorkflowService 获取 workflow definition
    const svc = workflowComponent.getService?.();
    if (!svc || typeof svc.getWorkflowByName !== "function") {
      throw new Error(
        `WorkflowService not available. Cannot run workflow agent "${agentName}".`
      );
    }

    const workflow = svc.getWorkflowByName(workflowName);
    if (!workflow) {
      throw new Error(
        `Workflow "${workflowName}" not found. ` +
        `Use 'roy-bot workflow add' to register it first.`
      );
    }

    // 执行 workflow（传入用户 query 作为 input）
    // 注意：engine 中的 stripEphemeralResumeInput 会提取 userQuery 作为恢复参数，
    // 不会出现在 workflowInput 中，因此使用 query 作为 key 保证节点可访问
    const wfResult = await workflowComponent.runWorkflow(
      workflow.definition,
      { query },
      { context }  // ★ 透传 AgentContext 到 RunOptions
    );

    // ★ P2: 处理 paused/HIL 状态
    if (wfResult.status === "paused") {
      return JSON.stringify({
        status: "paused",
        message: `Workflow "${workflowName}" paused, waiting for user input.`,
        pendingNodeId: wfResult.pendingNodeId,
        query: wfResult.query,
        sessionId: wfResult.sessionId,
        hint: `Resume with: roy-bot workflow run -s ${wfResult.sessionId} --input "your response"`,
      });
    }

    // ★ P0: 检查 workflow 执行状态
    if (wfResult.status === "failed") {
      throw new Error(
        `Workflow "${workflowName}" execution failed: ${wfResult.error || "Unknown error (status: " + wfResult.status + ")"}`
      );
    }

    // ★ P0: 序列化 output 为字符串
    if (typeof wfResult.output === "string") {
      return wfResult.output;
    }
    if (wfResult.output !== undefined && wfResult.output !== null) {
      return JSON.stringify(wfResult.output);
    }
    if (wfResult.error) {
      throw new Error(
        `Workflow "${workflowName}" completed with error: ${wfResult.error}`
      );
    }
    // 兜底：无 output 无 error 时返回空（已完成但无输出）
    return "";
  }

  /**
   * 处理动作
   * 
   * 默认实现抛出错误，子类必须实现。
   */
  async handle_action(action: Action, context: Context): Promise<ToolResult> {
    throw new Error("handle_action not implemented. Override in subclass.");
  }

  // ============ EnvEvent 机制 ============

  /**
   * 事件订阅者映射
   */
  protected eventHandlers = new Map<string, Set<EnvEventHandler>>();

  /**
   * 通配符订阅者（接收所有事件）
   */
  protected wildcardHandlers = new Set<EnvEventHandler>();

  /**
   * 订阅 EnvEvent（返回取消订阅函数）
   */
  subscribe(handler: EnvEventHandler): () => void {
    this.wildcardHandlers.add(handler);
    logger.debug(`EnvEvent handler subscribed (wildcard)`);
    
    // 返回取消订阅函数
    return () => {
      this.wildcardHandlers.delete(handler);
      logger.debug(`EnvEvent handler unsubscribed (wildcard)`);
    };
  }

  /**
   * 订阅指定类型事件
   */
  subscribeTo(eventType: string | string[], handler: EnvEventHandler): () => void {
    const types = Array.isArray(eventType) ? eventType : [eventType];
    
    for (const type of types) {
      if (!this.eventHandlers.has(type)) {
        this.eventHandlers.set(type, new Set());
      }
      this.eventHandlers.get(type)!.add(handler);
    }
    
    logger.debug(`EnvEvent handler subscribed for types: ${types.join(", ")}`);
    
    // 返回取消订阅函数
    return () => {
      for (const type of types) {
        this.eventHandlers.get(type)?.delete(handler);
      }
      logger.debug(`EnvEvent handler unsubscribed for types: ${types.join(", ")}`);
    };
  }

  /**
   * 订阅所有事件（通配符）
   * 
   * 与 subscribe 相同，为保持 API 一致性
   */
  subscribeAll(handler: EnvEventHandler): () => void {
    return this.subscribe(handler);
  }

  /**
   * 推送事件
   */
  pushEnvEvent(event: EnvEvent | EnvEventInput): void {
    // 如果是完整 EnvEvent，直接使用；否则创建新的
    const fullEvent: EnvEvent = "id" in event && event.id
      ? event as EnvEvent
      : {
          id: (event as EnvEventInput).id ?? generateId(),
          type: event.type,
          timestamp: (event as EnvEventInput).timestamp ?? Date.now(),
          metadata: {
            ...(event as EnvEventInput).metadata,
            env_name: (event as EnvEventInput).metadata?.env_name ?? this.name,
          },
          payload: (event as EnvEventInput).payload ?? {},
        };

    // 通知通配符订阅者
    for (const handler of this.wildcardHandlers) {
      try {
        handler(fullEvent);
      } catch (error) {
        logger.error(`Error in EnvEvent handler: ${error}`);
      }
    }

    // 通知特定类型订阅者
    const handlers = this.eventHandlers.get(fullEvent.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(fullEvent);
        } catch (error) {
          logger.error(`Error in EnvEvent handler for ${fullEvent.type}: ${error}`);
        }
      }
    }
  }

  /**
   * 创建并推送事件（便捷方法）
   */
  protected emit<T = unknown>(
    type: string,
    payload: T,
    metadata?: Partial<EnvEvent["metadata"]>
  ): void {
    const event: EnvEvent<T> = {
      id: generateId(),
      type,
      timestamp: Date.now(),
      metadata: {
        env_name: this.name,
        ...metadata,
      },
      payload,
    };
    this.pushEnvEvent(event);
  }

  // ============ 生命周期 ============

  /**
   * 初始化所有组件（分阶段初始化）
   * 
   * 1. 第一阶段：初始化 ConfigComponent（如果存在）
   * 2. 第二阶段：初始化其他组件
   */
  protected async initializeComponents(): Promise<void> {
    logger.debug(`Starting component initialization, total: ${this.components.size}`);

    // 1️⃣ 第一阶段：初始化 ConfigComponent（如果存在）
    // 特殊处理：直接访问 this.components 因为此时 ConfigComponent 尚未 init
    // 正常情况下组件应通过 this.env.getComponent() 获取其他已初始化的组件
    const configComp = this.components.get("config");
    if (configComp && configComp.getStatus() === "created") {
      logger.debug(`Initializing ConfigComponent first...`);
      await configComp.init({
        name: "config",
        version: configComp.version,
        enabled: true,
        env: this,
      });
      logger.debug(`ConfigComponent initialized`);
    } else {
      logger.debug(`No ConfigComponent found, skipping first stage`);
    }

    // 2️⃣ 第二阶段：初始化其他组件
    const otherComponents = Array.from(this.components.values())
      .filter(c => c.getStatus() === "created");
    
    if (otherComponents.length > 0) {
      logger.debug(`Initializing ${otherComponents.length} other components...`);
      for (const component of otherComponents) {
        logger.debug(`Initializing component: ${component.name}`);
        await component.init({
          name: component.name,
          version: component.version,
          enabled: true,
          env: this,
        });
        logger.debug(`Component initialized: ${component.name}`);
      }
    }
    
    logger.debug(`All components initialized`);
  }

  /**
   * 启动所有组件
   * 
   * 注意：由于 Environment.init() 会将组件状态设为 "running"，我们需要确保
   * 即使组件已经是 "running" 状态，它们的 start() 方法仍然被调用。
   * 这是因为 start() 负责注册工具等运行时资源。
   */
  protected async startComponents(): Promise<void> {
    // 启动所有已注册的组件（不检查状态）
    const allComponents = Array.from(this.components.values());
    
    if (allComponents.length > 0) {
      logger.debug(`Starting ${allComponents.length} components...`);
      for (const component of allComponents) {
        logger.debug(`Starting component: ${component.name} (current status: ${component.getStatus()})`);
        await component.start();
        logger.debug(`Component started: ${component.name}`);
      }
    }
  }

  /**
   * 停止所有组件
   *
   * Task #4794 根因 #4 — LIFO 逆序停止。
   *
   * 注册顺序是 config→session→llm→tool→agent→…→task，
   * 旧实现按 Map 迭代顺序 FIFO 停止 → task 最后停。
   * 当 task 组件在 stop() 里等待后台子 agent 完成
   * （BackgroundTaskManager.dispose waitForRunningTasks）时，
   * 子 agent 下一次 LLM 调用会因 LLMComponent 已停而抛
   * "LLMComponent is not running" → 任务 failed → 等待中断
   * → 进程退出杀死同进程子 agent（e2e 取证 23:22:56.803）。
   *
   * LIFO：task（最后注册）最先停止，等待期间 llm/tool/agent
   * 仍存活；config/session（最先注册）最后停止。
   */
  protected async stopComponents(): Promise<void> {
    const componentsToStop = Array.from(this.components.values())
      .filter(c => c.getStatus() !== "stopped")
      .reverse();

    if (componentsToStop.length > 0) {
      logger.debug(`Stopping ${componentsToStop.length} components...`);
      for (const component of componentsToStop) {
        logger.debug(`Stopping component: ${component.name}`);
        await component.stop();
        logger.debug(`Component stopped: ${component.name}`);
      }
    }
  }

  /**
   * 初始化（可覆盖）
   */
  protected async onInit(): Promise<void> {
    await this.initializeComponents();
    logger.info(`Environment "${this.name}" initialized`);
  }

  /**
   * 启动（可覆盖）
   */
  protected async onStart(): Promise<void> {
    await this.startComponents();
    logger.info(`Environment "${this.name}" started`);
  }

  /**
   * 停止（可覆盖）
   */
  protected async onStop(): Promise<void> {
    await this.stopComponents();
    // 清理事件处理器
    this.eventHandlers.clear();
    this.wildcardHandlers.clear();
    logger.info(`Environment "${this.name}" stopped`);
  }

  /**
   * BaseComponent 钩子
   * 
   * Environment 特殊处理：它本身就是 env，所以不需要外部传入。
   * 此方法覆盖 BaseComponent.init()，直接设置自引用。
   */
  async init(): Promise<void> {
    // Environment 特殊处理：设置自引用
    // 注意：这里需要直接访问 protected env 属性，使用 TypeScript 的原型链访问
    // 这是唯一需要绕过类型检查的地方，因为 Environment 是特殊情况
    Object.defineProperty(this, "env", {
      value: this,
      writable: true,
      enumerable: false,
      configurable: true,
    });
    
    this.setStatus("initializing");
    await this.onInit();
    this.setStatus("running");
  }

  async start(): Promise<void> {
    // 注意：Environment.init() 会将状态设为 "running"，但组件的 start() 仍需被调用
    // 所以这里使用一个内部标志来跟踪是否已经启动过
    if ((this as any)._started) return;
    (this as any)._started = true;
    
    await this.onStart();
    this.setStatus("running");
    logger.info(`Environment "${this.name}" started`);
  }

  async stop(): Promise<void> {
    this.setStatus("stopping");
    await this.onStop();
    this.setStatus("stopped");
  }

  // ============ 服务配置能力 ============

  /**
   * 从配置文件加载服务配置
   */
  async loadServiceConfig(configPath: string): Promise<ServiceConfig> {
    // 1. 获取 ConfigComponent
    const configComponent = this.getComponent<ConfigComponent>("config");
    if (!configComponent) {
      throw new Error("ConfigComponent not found. Please register ConfigComponent before loading service config.");
    }

    // 2. 获取配置目录
    const xdgDataHome = configComponent.getXdgDataHome();
    
    // 3. 读取配置文件
    const fullPath = path.resolve(xdgDataHome, configPath);
    if (!fsSync.existsSync(fullPath)) {
      throw new Error(`Service config file not found: ${fullPath}`);
    }
    
    // 4. 解析配置文件（支持 JSON/JSONC）
    const content = fsSync.readFileSync(fullPath, "utf-8");
    let config: ServiceConfig;
    
    try {
      config = JSON.parse(content);
    } catch (e) {
      throw new Error(`Failed to parse service config: ${e}`);
    }
    
    logger.debug(`Service config loaded from: ${fullPath}`);
    return config;
  }

  /**
   * 生成组件初始化选项
   */
  generateComponentOptions(
    componentName: string,
    configEntry: ComponentConfigEntry
  ): GeneratedComponentOptions {
    // 1. 获取 ConfigComponent（必填）
    const configComponent = this.getComponent<ConfigComponent>("config");
    if (!configComponent) {
      throw new Error("ConfigComponent not found. Please register ConfigComponent before generating component options.");
    }

    // 2. 构建选项对象
    const options: GeneratedComponentOptions = {
      configComponent,
      configPath: configEntry.configPath,
      envPrefix: configEntry.envPrefix,
      config: configEntry.config,
    };
    
    logger.debug(`Generated options for component: ${componentName}`);
    return options;
  }

  /**
   * 注册组件并用配置初始化
   */
  async registerComponentWithConfig(
    component: Component,
    configEntry: ComponentConfigEntry
  ): Promise<void> {
    // 1. 如果组件未注册，先注册
    if (!this.components.has(component.name)) {
      this.registerComponent(component);
    }
    
    // 2. 生成初始化选项
    const options = this.generateComponentOptions(component.name, configEntry);
    
    // 3. 如果组件已初始化，跳过
    if (component.getStatus() === "running") {
      logger.debug(`Component ${component.name} already initialized, skipping`);
      return;
    }
    
    // 4. 初始化组件
    await component.init({
      name: component.name,
      version: component.version,
      enabled: configEntry.enabled ?? true,
      env: this,
      options,
    });
    
    logger.debug(`Component ${component.name} registered and initialized with config`);
  }

  /**
   * 从配置文件初始化整个环境
   */
  async initFromConfig(configPath: string): Promise<void> {
    // 0. 设置 Environment 自引用（如果不尚未设置）
    if (!(this as any).env) {
      Object.defineProperty(this, "env", {
        value: this,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
    
    // 1. 加载服务配置
    const serviceConfig = await this.loadServiceConfig(configPath);
    
    // 2. 更新环境名称和版本（如果配置了）
    if (serviceConfig.environment) {
      if (serviceConfig.environment.name) {
        (this as any).name = serviceConfig.environment.name;
      }
      if (serviceConfig.environment.version) {
        (this as any).version = serviceConfig.environment.version;
      }
    }
    
    // 3. 确保 ConfigComponent 已注册
    const configComponent = this.getComponent<ConfigComponent>("config");
    if (!configComponent) {
      throw new Error("ConfigComponent not found. Please register ConfigComponent before initFromConfig.");
    }
    
    // 4. 初始化 ConfigComponent
    if (configComponent.getStatus() === "created") {
      await configComponent.init({
        name: "config",
        version: configComponent.version,
        enabled: true,
        env: this,
      });
    }
    
    // 5. 初始化每个配置的组件
    const components = serviceConfig.components || {};
    for (const [componentName, configEntry] of Object.entries(components)) {
      // 跳过禁用的组件
      if (configEntry.enabled === false) {
        logger.debug(`Component ${componentName} is disabled, skipping`);
        continue;
      }
      
      // 获取组件实例
      const component = this.getComponent(componentName);
      if (!component) {
        logger.warn(`Component ${componentName} not registered, skipping`);
        continue;
      }
      
      // 跳过 ConfigComponent（已初始化）
      if (component.name === "config") continue;
      
      // 注册并初始化
      await this.registerComponentWithConfig(component, configEntry);
    }
    
    // 6. 设置环境状态为 running
    this.setStatus("running");
    
    logger.info(`Environment "${this.name}" initialized from config: ${configPath}`);
  }
}
