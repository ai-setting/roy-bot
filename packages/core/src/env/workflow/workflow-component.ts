/**
 * @fileoverview WorkflowComponent
 * 
 * Workflow 组件入口，提供工作流管理和执行能力。
 * 
 * 功能：
 * - 工作流 CRUD 操作（通过 WorkflowService）
 * - 工作流执行（通过 WorkflowEngine）
 * - Decorator 节点注册
 * 
 * Note: After session-based refactoring, workflow runs are managed via SessionComponent.
 * The Session.metadata stores workflow run state (status, input, agentSessions).
 * Node execution messages are stored in Session.messages with workflow.node.* roles.
 */

import 'reflect-metadata';
import { BaseComponent, type ComponentConfig } from '../component';
import type {
  WorkflowDefinition,
  RunOptions,
  RunResult,
} from './types';
import { WorkflowService, WorkflowEngineFactory } from './service';
import { WorkflowEngine } from './engine';
import { WorkflowConverter } from './extractor/workflow-converter';
import { registerDecoratorNodeType } from './utils/node-registry-helper';
import type { ToolComponent } from '../tool/tool-component';
import type { LogTraceComponent } from '../log-trace/log-trace-component';
import type { Environment } from '../interface';
import type { AgentComponent } from '../agent/agent-component';
import type { AgentRunner } from './nodes/agent-node';

// Logger - 使用统一的 Logger 系统，支持 quiet 模式
import { createLogger } from '../log-trace/logger';
const componentLogger = createLogger('workflow');

// SkillRegistry 类型
import type { SkillRegistry } from './nodes/skill-node';

// Workflow Tools
import { askUserTool } from './tools/ask-user-tool';
import { createWorkflowGetTool } from './tools/workflow-get-tool';
import { createWorkflowListTool } from './tools/workflow-list-tool';
import { createWorkflowTagListTool } from './tools/workflow-tag-list-tool';
import { createWorkflowAddTool } from './tools/workflow-add-tool';
import { createWorkflowValidateTool } from './tools/workflow-validate-tool';
import { createWorkflowSearchTool } from './tools/workflow-search-tool';
import { createRunWorkflowTool } from './tools/run-workflow';
import { createWorkflowRunStatusTool } from './tools/workflow-run-status-tool';
import { createWorkflowRunStopTool } from './tools/workflow-run-stop-tool';
import type { Tool } from '../tool/types';

/**
 * SkillRegistry Adapter
 * 
 * 将 SkillComponent 适配为 SkillRegistry 接口，供 SkillNode 使用。
 * 
 * SkillComponent.getSkill() 返回 SkillEntry 对象（包含 content 等属性），
 * 而 SkillRegistry 接口期望的 Skill.invoke() 方法需要 skill 对象支持。
 * 这个适配器将两者连接起来。
 */
class SkillRegistryAdapter implements SkillRegistry {
  constructor(private skillComponent: { getSkill(name: string): any; hasSkill(name: string): boolean }) {}
  
  getSkill(name: string): { name: string; invoke(input: any, context: any): Promise<any> } | undefined {
    const entry = this.skillComponent.getSkill(name);
    if (!entry) return undefined;
    
    // 创建一个适配的 Skill 对象
    return {
      name: entry.name,
      invoke: async (input: any, context: any): Promise<any> => {
        // SkillNode 调用 skill.invoke(input, context)
        // 这里我们直接返回 skill 的 content，供 SkillNode 使用
        // 注意：SkillNode 期望返回的是 skill 内容（字符串），而不是执行结果
        return entry.content;
      },
    };
  }
  
  hasSkill(name: string): boolean {
    return this.skillComponent.hasSkill(name);
  }
}

// Re-export engine classes and types
export {
  EventBus,
  DAGManager,
  Scheduler,
  Executor,
  WorkflowEngine,
} from './engine';

export type {
  NodeExecutionContext,
  RunOptions,
  RunResult,
  RunStatus,
  NodeStatus,
  DAGAnalysis,
  SchedulerOptions,
  SchedulerState,
  ExecutorOptions,
  WorkflowEngineConfig,
  NodeContext,
  NodeFactory,
} from './engine';

// Re-export types
export type {
  NodeDefinition,
  RetryConfig,
  TemplateResolver,
} from './types';

export type {
  WorkflowDefinition,
} from './types/workflow';

// Re-export service
export {
  WorkflowService,
  WorkflowServiceRegistry,
} from './service';

// Re-export decorator types
export type {
  WorkflowOptions,
  NodeAsOptions,
  EdgeOptions,
  WorkflowMetadata,
  NodeMetadata,
  EdgeMetadata,
  ValidationResult,
  ConvertedWorkflowDefinition,
  ConvertedNodeDefinition,
} from './types/decorators-types';

// Re-export decorators
export {
  Workflow,
  NodeAs,
  Edge,
  WorkflowEdges,
  getWorkflowMetadata,
  getNodeMetadatas,
  getEdgeMetadatas,
  DecoratorNode,
} from './decorators';

export type {
  DecoratorNodeConfig,
} from './decorators/decorator-node';

// Re-export converter
export {
  WorkflowConverter,
} from './extractor/workflow-converter';

// Re-export utilities
export { createWorkflowFromClass } from './utils/create-workflow';
export { registerDecoratorNodeType } from './utils/node-registry-helper';

// ==================== Component Types ====================

export interface WorkflowComponentConfig extends ComponentConfig {
  /** 自动注册 decorator 节点类型 */
  autoRegisterDecorators?: boolean;
}

export interface WorkflowComponentOptions {
  /** Tool 组件（可选） */
  toolComponent?: ToolComponent;
  /** Log Trace 组件（可选） */
  logTraceComponent?: LogTraceComponent;
  /** Environment（包含 AgentComponent 等） */
  env?: Environment;
  /** Skill registry（可选） */
  skillRegistry?: { getSkill(name: string): any; hasSkill(name: string): boolean };
  /** Agent runner（可选，用于 agent 节点） */
  agentRunner?: AgentRunner;
}

// ==================== WorkflowComponent ====================

export class WorkflowComponent extends BaseComponent {
  readonly name = "workflow";
  readonly version = "1.0.0";
  
  public workflowService: WorkflowService | null = null;
  public sessionComponent: any = null;  // Expose for CLI resume command
  private nodeRegistry: any = null;
  private decoratorsRegistered = false;
  
  /**
   * 获取 WorkflowService 实例
   */
  getService(): WorkflowService | null {
    return this.workflowService;
  }
  private toolComponent?: ToolComponent;
  private logTraceComponent?: LogTraceComponent;
  private _workflowEnv?: Environment;
  private skillRegistry?: { getSkill(name: string): any; hasSkill(name: string): boolean };
  private agentRunner?: AgentRunner;

  /**
   * 初始化 WorkflowComponent
   */
  async init(options: any): Promise<void> {
    const opts = options as WorkflowComponentOptions;
    (this as any)._status = 'initializing';
    componentLogger.info('Initializing WorkflowComponent...');

    // 保存组件引用供后续使用
    this.toolComponent = opts.toolComponent;
    this.logTraceComponent = opts.logTraceComponent;
    this._workflowEnv = opts.env as any;
    this.skillRegistry = opts.skillRegistry;
    this.agentRunner = opts.agentRunner;

    try {
      // Register decorator node type
      if ((opts as any).autoRegisterDecorators !== false) {
        await this.registerDecorators();
      }

      // 注意：ask_user 工具不在这里注册
      // 因为 toolComponent 在 init() 时还未初始化
      // 将在 initSqliteService() 中注册

      (this as any)._status = 'ready';
      componentLogger.info('WorkflowComponent initialized successfully');
    } catch (error) {
      (this as any)._status = 'error';
      componentLogger.error('Failed to initialize WorkflowComponent:', error);
      throw error;
    }
  }

  /**
   * 注册 decorator 节点类型
   */
  private async registerDecorators(): Promise<void> {
    if (this.decoratorsRegistered) return;

    try {
      // 动态导入避免循环依赖
      const { NodeRegistry } = await import('./engine');
      const { registerDecoratorNodeType } = await import('./utils/node-registry-helper');

      this.nodeRegistry = new NodeRegistry();
      registerDecoratorNodeType(this.nodeRegistry);

      this.decoratorsRegistered = true;
      componentLogger.info('Decorator node type registered');
    } catch (error) {
      componentLogger.error('Failed to register decorator node type:', error);
      throw error;
    }
  }

  /**
   * Note: After session-based refactoring, runRepository is no longer needed.
   * Workflow runs are managed via SessionComponent.
   */
  createService(options: {
    workflowRepository: any;
    toolComponent?: ToolComponent;
    env?: Environment;
    skillRegistry?: { getSkill(name: string): any; hasSkill(name: string): boolean };
    sessionComponent?: any;  // SessionComponent for session-based resume
    tagRepository?: any;    // v2: TagRepository for usage_count tracking
  }): WorkflowService {
    // 创建 SkillRegistry adapter（将 SkillComponent 适配为 SkillRegistry）
    const skillRegistryAdapter = options.skillRegistry
      ? new SkillRegistryAdapter(options.skillRegistry)
      : undefined;

    // 保存 sessionComponent 引用供 engineFactory 使用
    const sessionComponentForEngine = options.sessionComponent;

    // 创建引擎工厂
    // 传入 workflowRepository 以便在 resume 时能从数据库加载 workflow definition
    const engineFactory: WorkflowEngineFactory = (workflow: any, opts?: RunOptions) => {
      const { NodeRegistry, WorkflowEngine } = require('./engine');

      const registry = new NodeRegistry({
        toolRegistry: options.toolComponent,
        agentComponent: options.env?.getComponent<AgentComponent>('agent'),
        skillRegistry: skillRegistryAdapter,
        sessionComponent: sessionComponentForEngine,  // Pass sessionComponent for agent session management
      });

      // 注册 decorator 节点
      const { registerDecoratorNodeType } = require('./utils/node-registry-helper');
      registerDecoratorNodeType(registry);

      // 传入 sessionComponent 和 workflowRepository 以便在完成时持久化状态和实现 resume
      // sessionComponent 用于 session-based resume（CLI 无状态场景）
      // workflowRepository 用于从数据库加载 workflow definition（resume 时需要）
      return new WorkflowEngine(registry, sessionComponentForEngine, options.workflowRepository);
    };

    this.workflowService = new WorkflowService(
      options.workflowRepository,
      engineFactory,
      options.sessionComponent, // For session-based resume
      options.tagRepository     // v2: TagRepository for usage_count
    );

    return this.workflowService;
  }

  /**
   * 运行工作流定义
   */
  async runWorkflow(
    definition: WorkflowDefinition,
    input?: Record<string, any>,
    options?: RunOptions
  ): Promise<RunResult> {
    const { NodeRegistry } = await import('./engine');
    const { registerDecoratorNodeType } = await import('./utils/node-registry-helper');

    // 获取组件引用（优先使用 env 中的最新引用，因为 env 中注册了所有组件）
    const toolComponent = this.toolComponent || this._workflowEnv?.getComponent<ToolComponent>('tool');
    const skillComponent = this._workflowEnv?.getComponent<any>('skill');
    
    // 获取 AgentComponent 并创建 AgentRunner adapter
    let agentRunner = this.agentRunner;
    if (!agentRunner && this._workflowEnv) {
      const agentComponent = this._workflowEnv.getComponent<AgentComponent>('agent');
      if (agentComponent) {
        // 动态导入 AgentComponentAdapter
        const { AgentComponentAdapter } = await import('./nodes/agent-component-adapter');
        // 如果有 sessionComponent，传入 AgentComponentAdapter 以支持 agent sub-session
        agentRunner = new AgentComponentAdapter(
          agentComponent,
          {},
          this.sessionComponent
        );
      }
    }

    // 创建 NodeRegistry 并注册所有内置节点类型
    // 注意：必须传入 sessionComponent 以支持 agent sub-session 创建
    const registry = new NodeRegistry({
      toolRegistry: toolComponent as any,
      skillRegistry: skillComponent,
      agentRunner,
      sessionComponent: this.sessionComponent,  // 支持 agent sub-session 创建
    });

    // 注册 decorator 节点
    registerDecoratorNodeType(registry);

    // 创建引擎
    const engine = new WorkflowEngine(registry, this.sessionComponent);

    // 直接运行
    return engine.runWorkflow(definition, { ...options, input });
  }

  /**
   * 停止组件并清理资源
   * 
   * 遵循 Component 接口契约，通过 onStop 钩子实现
   */
  protected async onStop(): Promise<void> {
    componentLogger.info('[WorkflowComponent] Stopping and cleaning up resources...');
    
    // 清理 NodeRegistry（如果已创建）
    if (this.nodeRegistry) {
      // NodeRegistry 目前没有清理方法，保留引用供 GC
      this.nodeRegistry = null;
    }
    
    // 清理 WorkflowService 和数据库连接
    if (this.workflowService) {
      this.workflowService = null;
      // 延迟导入并关闭数据库连接
      try {
        const { closeDatabase } = await import('./storage/sqlite');
        closeDatabase();
        componentLogger.info('[WorkflowComponent] SQLite database closed');
      } catch (error) {
        componentLogger.warn('[WorkflowComponent] Failed to close SQLite database:', error);
      }
    }
    
    (this as any)._status = "stopped";
    componentLogger.info('[WorkflowComponent] Cleanup completed');
  }

  /**
   * 启动组件 - 初始化持久化的 SQLite WorkflowService
   */
  async start(): Promise<void> {
    await super.start();
    
    // 初始化持久化的 WorkflowService
    await this.initSqliteService();
    
    // 注册 ask_user 工具到 ToolComponent
    // 这样 Workflow 中的 AgentNode 执行时，Agent 能够找到并调用 ask_user 工具
    await this.registerAskUserTool();

    // 注册 workflow tools 到 ToolComponent
    // 这些工具通过 ToolComponent 注册表可见，但不会自动加入 defaultTools。
    // 只有通过 allowedTools 明确引用的 agent 才能使用。
    await this.registerWorkflowTools();
  }

  /**
   * 注册 ask_user 工具到 ToolComponent
   * 
   * 这样 Workflow 中的 AgentNode 执行时，Agent 能够找到并调用 ask_user 工具。
   * ask_user 工具会抛出 AskUserError，触发 workflow pause。
   */
  private async registerAskUserTool(): Promise<void> {
    try {
      const toolComponent = this.toolComponent || this._workflowEnv?.getComponent<ToolComponent>('tool');
      
      if (!toolComponent) {
        componentLogger.warn('ToolComponent not available, cannot register ask_user tool');
        return;
      }
      
      // 注册 ask_user 工具（使用 as any 绕过类型检查，因为 parameters 使用 Zod schema）
      if (typeof toolComponent.register === 'function') {
        toolComponent.register(askUserTool as any);
        componentLogger.info('ask_user tool registered to ToolComponent');
      } else if (typeof toolComponent.registerMany === 'function') {
        toolComponent.registerMany([askUserTool as any]);
        componentLogger.info('ask_user tool registered to ToolComponent');
      } else {
        componentLogger.warn('ToolComponent does not support tool registration');
      }
    } catch (error) {
      componentLogger.warn('Failed to register ask_user tool:', error);
      // 不抛出错误，只是无法使用 ask_user 功能
    }
  }

  /**
   * 注册 workflow tools 到 ToolComponent
   * 
   * 注册 5 个 workflow 工具：workflow_get, workflow_list, workflow_run,
   * workflow_run_status, workflow_run_stop。
   * 
   * 注意：这些工具不自动加入 defaultTools，只通过 ToolComponent 的注册表可见。
   * 只有通过 allowedTools 明确引用的 agent（如 workflow-runner）才能使用。
   */
  private async registerWorkflowTools(): Promise<void> {
    if (!this.workflowService) {
      componentLogger.warn('WorkflowService not initialized, cannot register workflow tools');
      return;
    }

    try {
      const toolComponent = this.toolComponent || this._workflowEnv?.getComponent<ToolComponent>('tool');
      
      if (!toolComponent) {
        componentLogger.warn('ToolComponent not available, cannot register workflow tools');
        return;
      }

      // Task #2144 — wire workflow_run attach to bgTask lifecycle.
      // WorkflowComponent has access to the BackgroundTaskManager via
      // taskComponent.backgroundTaskManager (set up in delegate-tool.ts).
      // We inject WorkflowService.stopRun into it AND pass attach/detach
      // hooks to createRunWorkflowTool so the tool can register/unregister
      // workflow runIds against the currently-active bgTask.
      //
      // Forward-compatibility: if the env or TaskComponent doesn't expose
      // backgroundTaskManager (older configurations), fall back to a
      // hook-less tool — main session behavior is identical to pre-Task #2144.
      const taskComponent = this._workflowEnv?.getComponent<any>("task");
      const backgroundTaskManager = taskComponent?.backgroundTaskManager;
      if (backgroundTaskManager && typeof backgroundTaskManager.setWorkflowService === "function") {
        backgroundTaskManager.setWorkflowService(this.workflowService);
      }

      const lifecycleHooks = backgroundTaskManager
        ? {
            attachWorkflowRun: (bgTaskId: string, runId: string) =>
              backgroundTaskManager.attachWorkflowRun(bgTaskId, runId),
            detachWorkflowRun: (bgTaskId: string, runId: string) =>
              backgroundTaskManager.detachWorkflowRun(bgTaskId, runId),
            // Task #2190 — replace placeholder runId with real engine runId.
            // Triggered by the run-workflow tool when onSessionCreated fires
            // (PRE-attach has already registered the reserved runId; this
            // swaps it to the real id so stop_task can find it by the real id).
            replaceWorkflowRun: (bgTaskId: string, oldRunId: string, newRunId: string) =>
              backgroundTaskManager.replaceWorkflowRun(bgTaskId, oldRunId, newRunId),
          }
        : undefined;

      const tools: Tool[] = [
        createWorkflowGetTool(this.workflowService),
        createWorkflowListTool(this.workflowService),
        createWorkflowAddTool(this.workflowService),
        createWorkflowValidateTool(this.workflowService),
        createWorkflowSearchTool(this.workflowService),
        createWorkflowTagListTool(this.workflowService),
        createRunWorkflowTool(this.workflowService, lifecycleHooks),
        createWorkflowRunStatusTool(this.workflowService),
        createWorkflowRunStopTool(this.workflowService),
      ];

      for (const tool of tools) {
        toolComponent.register(tool);
        componentLogger.info(`[WorkflowComponent] Registered workflow tool: ${tool.name}`);
      }
    } catch (error) {
      componentLogger.warn('Failed to register workflow tools:', error);
      // 不抛出错误，避免阻塞组件启动
    }
  }

  /**
   * 初始化 SQLite 持久化的 WorkflowService
   * 
   * Note: After session-based refactoring, runRepository is no longer needed.
   * Workflow runs are managed via SessionComponent.
   */
  private async initSqliteService(): Promise<void> {
    try {
      // 动态导入 SQLite storage 和 repositories
      const { getDatabase, initializeTables } = await import('./storage/sqlite');
      const { WorkflowRepository } = await import('./storage/workflow-repo');
      const { TagRepository } = await import('./storage/tag-repo');

      // 注意：ask_user 工具不在这里注册
      // 只在 workflow run 运行时，通过 AgentNode 的 allowedTools 机制注册
      // 这样确保 ask_user 只在 workflow 上下文中可用

      // 初始化数据库和表
      const db = getDatabase();
      initializeTables();

      // 创建持久化的 repositories（v2: 同时创建 TagRepository）
      const workflowRepository = new WorkflowRepository(db);
      const tagRepository = new TagRepository(db);
      
      // 获取组件引用（优先使用 env 中的最新引用）
      const toolComponent = this.toolComponent || this._workflowEnv?.getComponent<ToolComponent>('tool');
      const agentComponent = this._workflowEnv?.getComponent<AgentComponent>('agent');
      const skillComponent = this.skillRegistry || this._workflowEnv?.getComponent<any>('skill');
      const sessionComponent = this._workflowEnv?.getComponent<any>('session');
      
      componentLogger.info(`initSqliteService - toolComponent: ${!!toolComponent}, skillRegistry: ${!!skillComponent}, sessionComponent: ${!!sessionComponent}`);

      // 注意：workflow-json-output-plugin 现在由 AgentComponentAdapter（持有 AgentComponent 引用）
      // 在其构造时调用 registerWorkflowJsonOutputPlugin({ agentComponent }) 注册。
      // 这里不再做无参注册（会导致 plugin 标记为 registered 但 agentComponentRef 为 null）。
      
      // 创建并设置 WorkflowService（v2: 传入 tagRepository）
      this.createService({
        workflowRepository,
        tagRepository,
        toolComponent,
        env: this._workflowEnv,
        skillRegistry: skillComponent,
        sessionComponent,  // For session-based resume
      });
      
      // 保存 sessionComponent 引用供 CLI resume 使用
      this.sessionComponent = sessionComponent;
      
      // 动态注册 ask_user 工具到 ToolComponent
      // 这样 workflow agent 可以使用 ask_user 工具触发工作流暂停
      await this.registerAskUserTool();
      
      componentLogger.info('SQLite WorkflowService initialized successfully');
    } catch (error) {
      componentLogger.error('Failed to initialize SQLite WorkflowService:', error);
      // 不抛出错误，降级到内存模式
      await this.createInMemoryService();
    }
  }

  /**
   * 创建内存中的 WorkflowService（用于快速运行或降级）
   */
  private createInMemoryService(): WorkflowService {
    // In-memory workflow repository
    const workflows = new Map<string, any>();

    const workflowRepository = {
      create: (wf: any) => {
        const id = wf.id || `wf_${Date.now()}`;
        const record = { ...wf, id, createdAt: new Date(), updatedAt: new Date() };
        workflows.set(id, record);
        return record;
      },
      getById: (id: string) => workflows.get(id) || null,
      getByName: (name: string) => {
        for (const wf of workflows.values()) {
          if (wf.name === name) return wf;
        }
        return null;
      },
      list: () => Array.from(workflows.values()),
      update: (id: string, updates: any) => {
        const wf = workflows.get(id);
        if (!wf) return null;
        const updated = { ...wf, ...updates, updatedAt: new Date() };
        workflows.set(id, updated);
        return updated;
      },
      delete: (id: string) => workflows.delete(id),
    };

    // 获取 sessionComponent
    const sessionComponent = this._workflowEnv?.getComponent<any>('session');

    return this.createService({
      workflowRepository,
      sessionComponent,
    });
  }

  /**
   * 停止组件
   */
  async stop(): Promise<void> {
    componentLogger.info('Stopping WorkflowComponent...');
    (this as any)._status = 'stopping';

    // 清理资源
    this.workflowService = null;
    this.nodeRegistry = null;

    try {
      const { closeDatabase } = await import("./storage/sqlite");
      closeDatabase();
    } catch {
      // ignore
    }

    (this as any)._status = 'stopped';
    componentLogger.info('WorkflowComponent stopped');
  }
}
