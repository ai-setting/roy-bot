/**
 * @fileoverview Environment Service
 * 
 * 封装 Environment 实例的创建和管理
 */

import path from "path";
import fs from "fs/promises";
import {
  BaseEnvironment,
  ConfigComponent,
  SessionComponent,
  LLMComponent,
  ToolComponent,
  AgentComponent,
  LogTraceComponent,
  PromptComponent,
  TaskComponent,

  SkillComponent,
  McpComponent,
  CommandsComponent,
  MemoryComponent,
  EventSourceComponent,
  EventSourceComponentInterface,
  PluginComponent,
  type Environment,
  resetTracerProvider,
  closeDatabase,
} from "@ai-setting/roy-bot-core";
// 导入 env/workflow 目录下的完整实现
import { WorkflowComponent } from "@ai-setting/roy-bot-core";
// 导入 MemoryPlugin
import { MemoryPlugin } from "@ai-setting/roy-bot-core";
// 导入 logger
import { createLogger } from "@ai-setting/roy-bot-core";
const logger = createLogger("environment-service");
// 导入全局 HookManager（用于注册 commands-prompt hook）
import { globalHookManager } from "@ai-setting/roy-bot-core";
import { OutputService } from "./output.service";
import { CliQuietModeService } from "./quiet-mode.service";

export interface EnvironmentServiceOptions {
  /** 工作目录 */
  workDir?: string;
  /** 环境名称 */
  envName?: string;
  /** 配置文件路径（绝对路径） */
  configPath?: string;
  /** 安静模式 - 抑制日志输出到控制台（仅影响环境初始化日志） */
  quiet?: boolean;
  /** 要加载的插件名称列表 */
  plugins?: string[];
  /**
   * 是否初始化并注册 PluginComponent（并按 `plugins` 列表加载）
   *
   * 默认 `false`（breaking change — Task #1960）。
   * 只读命令（sessions list/messages、tasks list、agents/skills/memory/prompt/...
   * commands-* 等）应保持默认不加载插件；只有真正需要插件的命令
   * （act / interactive / tasks complete）才显式传 `loadPlugins: true`。
   */
  loadPlugins?: boolean;
  /**
   * 调用方命令名（仅用于日志，标识 envService.create() 是被哪个 CLI 命令调用的）
   *
   * 当 `loadPlugins` 为 false 时，会在 debug 日志中记录该命令名以便排查。
   */
  commandName?: string;
  /** Session 存储配置（用于测试隔离） */
  sessionStorage?: {
    /** 存储类型 */
    type?: "memory" | "sqlite";
    /** SQLite 数据库路径（当 type=sqlite 时） */
    dbPath?: string;
  };
  /** Task 存储配置（用于测试隔离） */
  taskStorage?: {
    /** 存储类型 */
    type?: "memory" | "sqlite";
    /** SQLite 数据库路径（当 type=sqlite 时） */
    dbPath?: string;
  };
}

export interface ComponentInitOptions {
  /** ConfigComponent 配置 */
  configPath?: string;
}

/**
 * CLI 配置目录常量
 *
 * 用户级配置目录优先级（★ P7.3 F1 统一：
 * getUserConfigDir = app-config-io resolveUserConfigDir，
 * 弹窗读写与 boot 同源）：
 * 1. $XDG_CONFIG_HOME/roy-bot（XDG 标准）
 * 2. ~/.roy-bot（用户家目录，默认）
 * 3. {workDir}/.roy-bot（工作目录，项目级覆盖，
 *    create() 内另行处理）
 */
const CLI_CONFIG_DIR_NAME = "roy-bot";
const DEFAULT_CONFIG_FILE = "config.jsonc";

// ★ Task #5129 P7.3 F1 —— config 读侧路径统一：
//   复用 app-config-io 的 resolveUserConfigDir
//   （XDG 优先 → home 回退），与 tui-solid 弹窗读写同源。
import { resolveUserConfigDir } from "../tui-solid/app-config-io.js";
const getUserConfigDir = resolveUserConfigDir;



/**
 * EnvironmentService - CLI 环境服务
 * 
 * 负责创建和管理 BaseEnvironment 实例及其组件
 */
export class EnvironmentService {
  private environment: BaseEnvironment | null = null;
  private output: OutputService;
  private options: ComponentInitOptions = {};

  // 组件实例（用于 getSession, getLLM 等方法）
  private configComponent?: ConfigComponent;
  private sessionComponent?: SessionComponent;
  private llmComponent?: LLMComponent;
  private toolComponent?: ToolComponent;
  private agentComponent?: AgentComponent;
  private skillComponent?: SkillComponent;
  private logTraceComponent?: LogTraceComponent;
  private promptComponent?: PromptComponent;
  private taskComponent?: TaskComponent;
  private mcpComponent?: McpComponent;
  private commandsComponent?: CommandsComponent;
  private memoryComponent?: MemoryComponent;
  private memoryPlugin?: MemoryPlugin;
  private eventSourceComponent?: EventSourceComponent;
  private workflowComponent?: WorkflowComponent;
  private pluginComponent?: PluginComponent;

  constructor(output?: OutputService) {
    this.output = output ?? new OutputService();
  }

  /**
   * 获取已创建的 Environment 实例
   */
  getEnvironment(): BaseEnvironment | null {
    return this.environment;
  }

  /**
   * 获取 SessionComponent 实例
   */
  getSession(): SessionComponent | null {
    return this.sessionComponent || null;
  }

  /**
   * 获取 LLMComponent 实例
   */
  getLLM(): LLMComponent | null {
    return this.llmComponent || null;
  }

  /**
   * 获取 ToolComponent 实例
   */
  getTool(): ToolComponent | null {
    return this.toolComponent || null;
  }

  /**
   * 获取 AgentComponent 实例
   */
  getAgent(): AgentComponent | null {
    return this.agentComponent || null;
  }

  /**
   * 获取 SkillComponent 实例
   */
  getSkill(): SkillComponent | null {
    return this.skillComponent || null;
  }

  /**
   * 获取 CommandsComponent 实例
   */
  getCommands(): CommandsComponent | null {
    return this.commandsComponent || null;
  }

  /**
   * 获取 LogTraceComponent 实例
   */
  getLogTrace(): LogTraceComponent | null {
    return this.logTraceComponent || null;
  }

  /**
   * 获取 MemoryPlugin 实例（用于 shared instances with MemoryComponent）
   */
  getMemoryPlugin(): MemoryPlugin | null {
    return this.memoryPlugin || null;
  }

  /**
   * 释放环境资源
   */
  async dispose(): Promise<void> {
    if (this.environment) {
      try {
        await this.environment.stop();
      } catch {
        // ignore
      }
    } else {
      for (const component of [
        this.pluginComponent,
        this.eventSourceComponent,
        this.memoryComponent,
        this.commandsComponent,
        this.mcpComponent,
        this.skillComponent,
        this.taskComponent,
        this.promptComponent,
        this.logTraceComponent,
        this.agentComponent,
        this.toolComponent,
        this.sessionComponent,
        this.llmComponent,
        this.workflowComponent,
      ]) {
        if (component && typeof component.stop === "function") {
          try {
            await component.stop();
          } catch {
            // ignore
          }
        }
      }
    }

    this.configComponent?.shutdown?.();
    resetTracerProvider();
    closeDatabase();

    // ★ Task #5181：注销 commands-prompt hook。
    //   globalHookManager 是进程级单例，create() 每次都会注册一个
    //   commands-prompt hook（闭包持有本次的 commandsComponent）。
    //   不注销的话 hook 会随 create/dispose 循环不断累积，
    //   旧 hook 闭包里的 commandsComponent 已 dispose（getCommandsMeta
    //   读空目录），测试/多环境场景下 find() 取到旧 hook 会静默不注入。
    globalHookManager.unregister("prompt.after-render", "commands-prompt");

    this.environment = null;
    this.sessionComponent = undefined;
    this.llmComponent = undefined;
    this.toolComponent = undefined;
    this.agentComponent = undefined;
    this.skillComponent = undefined;
    this.logTraceComponent = undefined;
    this.configComponent = undefined;
    this.promptComponent = undefined;
    this.taskComponent = undefined;
    this.mcpComponent = undefined;
    this.commandsComponent = undefined;
    this.memoryComponent = undefined;
    this.memoryPlugin = undefined;
    this.eventSourceComponent = undefined;
    this.workflowComponent = undefined;
    this.pluginComponent = undefined;
  }

  /**
   * 创建 CLI 环境
   * 
   * 配置目录优先级：
   * 1. --config 参数指定的路径
   * 2. 工作目录下的 .roy-bot/config.jsonc（项目级覆盖）
   * 3. ~/.roy-bot/config.jsonc（用户级默认）
   */
  async create(options?: EnvironmentServiceOptions): Promise<BaseEnvironment> {
    const workDir = options?.workDir ?? process.cwd();
    const envName = options?.envName ?? "roy-cli";
    
    // 启用安静模式（抑制日志输出到控制台）
    if (options?.quiet) {
      CliQuietModeService.getInstance().setQuiet(true);
    }
    
    // 确定配置文件路径
    let configPath = options?.configPath;
    let configDir: string;
    
    if (!configPath) {
      // 1. 优先使用工作目录下的配置（项目级覆盖）
      const workDirConfigPath = path.join(workDir, CLI_CONFIG_DIR_NAME, DEFAULT_CONFIG_FILE);
      try {
        await fs.access(workDirConfigPath);
        configPath = workDirConfigPath;
        configDir = path.dirname(configPath);
      } catch {
        // 2. 回退到用户家目录 ~/.roy-bot
        configDir = getUserConfigDir();
        configPath = path.join(configDir, DEFAULT_CONFIG_FILE);
      }
    } else {
      configDir = path.dirname(configPath);
    }
    
    // 确保配置文件目录存在（如果需要初始化的话）
    try {
      await fs.mkdir(configDir, { recursive: true });
    } catch {
      // 目录已存在，忽略错误
    }

    // 保存配置选项
    this.options = {
      configPath,
    };

    // 1. 创建 BaseEnvironment
    const env = new BaseEnvironment({
      name: envName,
      version: "1.0.0",
    });


    // 2. 创建并注册核心组件
    
    // ConfigComponent - 必须在其他组件之前创建
    this.configComponent = new ConfigComponent();
    const configComponent = this.configComponent;
    
    // 设置 XDG_DATA_HOME 为配置文件目录，这样 relativePath 可以正常工作
    // 注意：这会影响到所有组件的路径解析
    configComponent.setXdgDataHome(configDir);
    
    // LLMComponent - 需要 ConfigComponent 和配置文件路径
    // 注意：必须在 env.init() 之前初始化，传入配置选项
    this.llmComponent = new LLMComponent();
    const llmComponent = this.llmComponent;
    await llmComponent.init({
      name: "llm",
      version: "1.0.0",
      enabled: true,
      env,
      options: {
        configComponent,
        configPath: path.basename(configPath), // 使用相对路径
      },
    });
    
    // SessionComponent
    this.sessionComponent = new SessionComponent();
    const sessionComponent = this.sessionComponent;
    
    // 构建 session 配置
    const sessionConfig: Record<string, unknown> = {};
    if (options?.sessionStorage) {
      if (options.sessionStorage.type) {
        sessionConfig.storage = { type: options.sessionStorage.type };
      }
      if (options.sessionStorage.dbPath) {
        sessionConfig.storage = {
          ...(sessionConfig.storage as Record<string, unknown> || {}),
          dbPath: options.sessionStorage.dbPath,
        };
      }
    }
    
    await sessionComponent.init({
      name: "session",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent, config: Object.keys(sessionConfig).length > 0 ? sessionConfig : undefined },
    });
    
    // ToolComponent
    this.toolComponent = new ToolComponent();
    const toolComponent = this.toolComponent;
    await toolComponent.init({
      name: "tool",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent },
    });
    
    // AgentComponent
    this.agentComponent = new AgentComponent();
    const agentComponent = this.agentComponent;
    await agentComponent.init({
      name: "agent",
      version: "1.0.0",
      enabled: true,
      env,
      options: {
        configComponent,
        configPath: path.basename(configPath), // 传入配置路径，以便从配置文件中加载 agent 配置
        // Task #4794 — act 一次性命令收尾：onStop() 时跳过 abort
        // 运行中的 agent run（含后台子 agent），否则子 agent 的
        // LLM 调用会在 TaskComponent 等待之前被中断。
        // REPL / 其他命令路径不受影响（默认 false = abort 全部）。
        ...(options?.commandName === "act"
          ? { skipAbortRunningTasksOnStop: true }
          : {}),
      },
    });
    
    // LogTraceComponent
    this.logTraceComponent = new LogTraceComponent();
    const logTraceComponent = this.logTraceComponent;
    await logTraceComponent.init({
      name: "log-trace",
      version: "1.0.0",
      enabled: true,
      env,
      options: { 
        configComponent,
        configPath: path.basename(configPath), // 传入相对路径，让 LogTraceComponent 从 XDG_DATA_HOME 读取
      },
    });
    
    // PromptComponent
    this.promptComponent = new PromptComponent();
    const promptComponent = this.promptComponent;
    await promptComponent.init({
      name: "prompt",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent },
    });

    // TaskComponent
    this.taskComponent = new TaskComponent();
    const taskComponent = this.taskComponent;
    // 构造 task 组件的 storage 配置（如果调用方提供）
    const taskConfig: Record<string, unknown> = {};
    if (options?.taskStorage) {
      if (options.taskStorage.type || options.taskStorage.dbPath) {
        taskConfig.storage = {
          type: options.taskStorage.type || "sqlite",
          ...(options.taskStorage.dbPath ? { dbPath: options.taskStorage.dbPath } : {}),
        };
      }
    }
    await taskComponent.init({
      name: "task",
      version: "1.0.0",
      enabled: true,
      env,
      options: {
        configComponent,
        // ★ Task #5580：把主 config.jsonc 注册为 task 组件的 file source
        //   —— `task.plugins.larkCard.emitTaskCard / emitSessionCard`
        //   从这里读（FileSource watch 默认开 ⇒ 改文件热更新，无需重启 ES）。
        configPath: path.basename(configPath),
        config: Object.keys(taskConfig).length > 0 ? taskConfig : undefined,
        // Task #4794 — act 一次性命令收尾：stop() 时跳过 abort
        // 仍在运行的后台子 agent（防 task_signal_abort 误杀），
        // 并等待其自然完成（子 agent 是同进程异步 run，
        // process.exit 会直接杀死它们）。
        // REPL / 其他命令路径不受影响（默认 false = abort 全部）。
        ...(options?.commandName === "act"
          ? {
              skipAbortRunningTasksOnDispose: true,
              waitForRunningTasksOnDispose: true,
            }
          : {}),
      },
    });

    // SkillComponent
    this.skillComponent = new SkillComponent();
    const skillComponent = this.skillComponent;
    await skillComponent.init({
      name: "skill",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent },
    });

    // McpComponent - 必须在 ToolComponent 之后初始化，以便注册 MCP tools
    this.mcpComponent = new McpComponent();
    const mcpComponent = this.mcpComponent;
    await mcpComponent.init({
      name: "mcp",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent },
    });

    // CommandsComponent
    this.commandsComponent = new CommandsComponent();
    const commandsComponent = this.commandsComponent;
    await commandsComponent.init({
      name: "commands",
      version: "2.0.0",
      enabled: true,
      env,
      options: { configComponent },
    });

    // MemoryPlugin - 在 MemoryComponent 之前创建，以便共享实例
    const memoryWorkDir = (workDir as any) || process.cwd();
    this.memoryPlugin = new MemoryPlugin(memoryWorkDir, {
      enabled: true,
    } as any);
    await this.memoryPlugin.initialize();

    // MemoryComponent - 必须在 ToolComponent 之后初始化，以便注册 memory tools
    // 传入 memoryPlugin 以复用其 DraftManager/Organizer 实例
    this.memoryComponent = new MemoryComponent();
    const memoryComponent = this.memoryComponent;
    await memoryComponent.init({
      name: "memory",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent, memoryPlugin: this.memoryPlugin },
    });

    // EventSourceComponent - 事件源组件
    this.eventSourceComponent = new EventSourceComponent();
    const eventSourceComponent = this.eventSourceComponent;
    await eventSourceComponent.init({
      name: "event-source",
      version: "1.0.0",
      enabled: true,
      env,
      options: { configComponent },
    });

    // 启用安静模式（必须在 WorkflowComponent 初始化之前设置）
    if (options?.quiet) {
      CliQuietModeService.getInstance().setQuiet(true);
    }

    // WorkflowComponent - 工作流组件
    this.workflowComponent = new WorkflowComponent();
    const workflowComponent = this.workflowComponent;
    await workflowComponent.init({
      env,
      options: {
        configComponent,
        toolComponent,
        llmComponent,
        logTraceComponent,
        skillRegistry: skillComponent,
        env,
      },
    } as any);
    await workflowComponent.start();

    // 注册所有组件
    env.registerComponent(configComponent);
    env.registerComponent(sessionComponent);
    env.registerComponent(llmComponent);
    env.registerComponent(toolComponent);
    env.registerComponent(agentComponent);
    env.registerComponent(logTraceComponent);
    env.registerComponent(promptComponent);

    // 注册 commands-prompt Hook（必须在 syncRegistryAgentsFromConfig 之前注册，
    // 因为 syncRegistryAgentsFromConfig 会解析 agent 的 systemPromptRef 并触发 render()
    // 如果 hook 还没注册，roy 等 agent 的 prompt 会被缓存为不含 Commands Arsenal 的版本）
    this.registerCommandsPromptHook(promptComponent, commandsComponent);

    // Prompt 注册到 env 后同步 registry agent 的 systemPromptRef
    await agentComponent.syncRegistryAgentsFromConfig();

    env.registerComponent(taskComponent);
    env.registerComponent(skillComponent);
    env.registerComponent(mcpComponent);
    env.registerComponent(commandsComponent);
    env.registerComponent(memoryComponent);
    env.registerComponent(eventSourceComponent as any);
    env.registerComponent(workflowComponent);

    // ========================================================================
    // PluginComponent - 仅当 loadPlugins === true 时初始化与注册（BREAKING 默认 off）
    // ========================================================================
    if (options?.loadPlugins === true) {
      this.pluginComponent = new PluginComponent();
      const pluginComponent = this.pluginComponent;
      await pluginComponent.init({
        name: "plugin",
        version: "1.0.0",
        enabled: true,
        env,
        options: {
          configComponent,
        },
      } as any);
      env.registerComponent(pluginComponent as any);
    } else {
      logger.debug(
        `[EnvironmentService] Skipping PluginComponent init (command=${options?.commandName ?? "<unknown>"}, reason=loadPlugins=false)`
      );
    }

    // 初始化 BaseEnvironment
    await env.init();

    // 启动 Environment - 触发所有组件的 start() 生命周期钩子
    // 这对于依赖 start() 注册工具的组件至关重要（如 TaskComponent, MemoryComponent、SkillComponent）
    await env.start();

    // 刷新 AgentComponent 的依赖组件引用
    // 原因：AgentComponent 在 onInit() 时调用 refreshDependencies()，
    // 但此时 env.start() 还未被调用，组件尚未注册到 Environment
    // 所以需要在 env.start() 之后再次刷新，确保 AgentComponent 能获取到 LLMComponent
    await agentComponent.refreshDependencies();
    logger.debug("[EnvironmentService] AgentComponent dependencies refreshed after env.start()");

    // 加载 Plugins（通过 PluginComponent）—— 仅当 loadPlugins === true 时执行
    if (options?.loadPlugins === true && options?.plugins && options.plugins.length > 0) {
      await this.loadPlugins(options.plugins);
    } else if (
      options?.loadPlugins !== true &&
      options?.plugins &&
      options.plugins.length > 0
    ) {
      logger.debug(
        `[EnvironmentService] Skipping plugin loading because loadPlugins=false (command=${options?.commandName ?? "<unknown>"})`
      );
    }

    this.environment = env;
    return env;
  }

  /**
   * 注册 commands-prompt Hook
   * 
   * 将收藏命令的能力动态注入 default prompt
   * 
   * 注意：必须使用 globalHookManager.register() 而不是 promptComponent.addHook()
   * 原因：PromptComponent.render() 执行的是 globalHookManager，而非 promptComponent.hookManager
   * 
   * Hook 上下文结构：
   * - ctx.component: { name, version }
   * - ctx.data: { name, originalContent, renderedContent, variables }
   * - ctx.metadata: Record<string, unknown>
   * - ctx.phase: "before" | "after"
   * - ctx.hookPoint: string
   */
  /**
   * Commands Arsenal 注入策略：**只对 primary agent 注入**
   *
   * 历史（Issue #1694，2026-07）：
   *   最初用「内建子 agent 名单黑名单」排除 json-extract / workflow-extract。
   *   症状：workflow-json-output-plugin 调 agentComponent.run('json-extract', ...)
   *   时，子 agent prompt 被追加一整段 Commands Arsenal，LLM 注意力被分散，
   *   无法调用唯一的 workflow_submit_output 工具 → structuredOutput 永远 undefined。
   *
   * 黑名单的致命缺陷（2026-10-16 生产事故 traceId=83eadac2316d5be7529ca42ce7057d63）：
   *   后来新增的内置子 agent `compact` / `compact-hint` 被漏加，于是压缩子 agent
   *   的 prompt 被追加了 Commands Arsenal —— 里面明写
   *   "Use them directly via bash when needed"，而 compact 的 allowedTools 只有
   *   ['workflow_submit_output']。LLM 读到自己「可以用 bash」就去调 bash
   *   → `Tool not found: bash` → maxIterations=1 首轮即终局
   *   → 写出全空 checkpoint（"Untitled Checkpoint"）→ 657 条消息被归档且摘要为空
   *   （上下文永久丢失）。全库共 **9 次生产空 checkpoint / 累计吞掉 4731 条消息 /
   *   单次最多 2710 条**（2026-10-14，session oc_xxxxxxxxxxxxxxxx）。
   *
   * 现在改为**正向判定**：只有 `agentType === "primary"`（面向用户的入口 agent，
   * 由 environment.ts / AgentRegistry 显式传入）才注入。
   *   - 默认不注入 → 将来新增的任何子 agent 自动安全（fail-closed）
   *   - 不再需要维护任何名单
   */
  private registerCommandsPromptHook(
    promptComponent: PromptComponent,
    commandsComponent: CommandsComponent
  ): void {
    globalHookManager.register("prompt.after-render", {
      name: "commands-prompt",
      execute: async (ctx: unknown) => {
        // globalHookManager.execute() 会将数据包装在 HookContext 中
        // ctx.data 才是 PromptHookContext
        const hookCtx = (ctx as any).data as {
          name: string;
          renderedContent: string;
          agentType?: string;
        };
        
        // 跳过匿名 prompt（如 workflow 内联 prompt）
        if (!hookCtx?.name || hookCtx.name === "anonymous") return;

        // ★ 只注入 primary agent 的 prompt。
        //   子 agent（compact / compact-hint / json-extract / workflow-extract /
        //   task-organizer / workflow-runner / ...）与任何未声明 agentType 的
        //   prompt 一律跳过 —— 它们只调内部工具，不该看到 user-facing 命令文档。
        if (hookCtx.agentType !== "primary") {
          // 注意：本 hook 每次渲染非 primary prompt 都会走到这里（含所有子 agent），
          // 不要用 output.log（可能刷屏）。保持静默返回即可。
          return;
        }

        try {
          const metaList = await commandsComponent.getCommandsMeta();
          
          // 无命令时不追加内容
          if (metaList.length === 0) return;

          const commandsSection = this.renderCommandsSection(metaList);
          hookCtx.renderedContent += "\n\n" + commandsSection;
          
        } catch (error) {
          this.output.error(`Failed to inject commands into prompt: ${error}`);
        }
      },
    });

    // ★ Task #5117 (M1)：quiet（headless）下不打 stdout
    if (!CliQuietModeService.getInstance().isQuiet()) {
      this.output.info("Registered commands-prompt Hook");
    }
  }

  /**
   * 加载插件
   * 
   * 根据插件名称动态导入并注册到 PluginComponent
   * 支持 core 插件和 coder-harness 插件
   */
  private async loadPlugins(pluginNames: string[]): Promise<void> {
    for (const name of pluginNames) {
      try {
        let plugin: any;
        
        switch (name) {
          // Core 插件
          case "task-tag": {
            const { TaskTagPlugin } = await import("@ai-setting/roy-bot-core");
            plugin = new TaskTagPlugin();
            break;
          }
          // Coder-harness 插件
          case "lsp": {
            const { LSPPlugin } = await import("@ai-setting/roy-bot-coder-harness");
            plugin = new LSPPlugin({ preloadMode: "startup" });
            break;
          }
          case "code-check": {
            const { CodeCheckPlugin } = await import("@ai-setting/roy-bot-coder-harness");
            plugin = new CodeCheckPlugin();
            break;
          }
          case "reminder": {
            const { ReminderPlugin } = await import("@ai-setting/roy-bot-coder-harness");
            plugin = new ReminderPlugin();
            break;
          }
          // 语言特定 LSP 插件
          case "tslsp": {
            const { TSLSPPlugin } = await import("@ai-setting/roy-bot-coder-harness");
            plugin = new TSLSPPlugin({ preloadMode: "startup" });
            break;
          }
          case "pylsp": {
            const { PyLSPPlugin } = await import("@ai-setting/roy-bot-coder-harness");
            plugin = new PyLSPPlugin({ preloadMode: "startup" });
            break;
          }
          case "mdlsp": {
            const { MDLSPPlugin } = await import("@ai-setting/roy-bot-coder-harness");
            plugin = new MDLSPPlugin();
            break;
          }
          case "ontologylsp": {
            const { OntologyLSPPlugin } = await import("@ai-setting/roy-bot-ontology-harness");
            plugin = new OntologyLSPPlugin({
              preloadMode: "startup",
              workspaceRoot: process.cwd(),
            });
            break;
          }
          default:
            this.output.warn(`[EnvironmentService] Unknown plugin: ${name}`);
            continue;
        }
        
        // 通过 PluginComponent.register() 注册
        this.pluginComponent?.register(plugin);
        this.output.log(`[EnvironmentService] Registered plugin: ${name}`);
      } catch (error) {
        this.output.error(`[EnvironmentService] Error loading plugin "${name}": ${error}`);
      }
    }
  }

  /**
   * 渲染命令表格 section
   */
  private renderCommandsSection(metaList: { name: string; description: string; filePath: string }[]): string {
    // 按名称排序
    const sortedMeta = [...metaList].sort((a, b) => a.name.localeCompare(b.name));

    // 命令概览表格
    const tableRows = sortedMeta
      .map(m => `| \`${m.name}\` | ${this.escapeMd(m.description)} |`)
      .join("\n");

    // 每个命令的详细帮助（从 meta.md 读取）
    const detailSections = sortedMeta
      .map(m => {
        const helpContent = this.readCommandHelp(m.filePath);
        if (!helpContent) return "";
        return `### \`${m.name}\`

${helpContent}`;
      })
      .filter(Boolean)
      .join("\n\n");

    return `## Your Commands Arsenal

You have access to these custom commands. Use them directly via bash when needed.

| Command | Description |
|---------|-------------|
${tableRows}

${detailSections ? `${detailSections}\n\n` : ""}---
> 💡 **Tip**: Run \`<command> --help\` or \`<command> <subcommand> --help\` to explore full capabilities of any command.`;
  }

  /**
   * 从 meta.md 文件读取命令帮助内容
   */
  private readCommandHelp(filePath: string): string {
    try {
      const { readFileSync, existsSync } = require("node:fs");
      if (!existsSync(filePath)) return "";
      const content = readFileSync(filePath, "utf-8");

      // 解析 meta.md：跳过 frontmatter（--- 之间的内容）
      const lines = content.split("\n");
      let startIdx = 0;
      if (lines[0]?.trim() === "---") {
        const endIdx = lines.findIndex((l, i) => i > 0 && l.trim() === "---");
        if (endIdx > 0) {
          startIdx = endIdx + 1;
        }
      }

      const bodyLines = lines.slice(startIdx).filter(l => l.trim());
      if (bodyLines.length === 0) return "";

      // 取前 30 行作为帮助摘要（足够展示 USAGE + COMMANDS + EXAMPLES）
      const summary = bodyLines.slice(0, 30).join("\n");
      return summary;
    } catch {
      return "";
    }
  }

  /**
   * Markdown 转义（防止表格格式破坏）
   */
  private escapeMd(s: string): string {
    return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  }
}
