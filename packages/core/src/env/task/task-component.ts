/**
 * @fileoverview Task Component
 * 
 * Component for managing task lifecycle including:
 * - Task CRUD operations
 * - Operation record management
 * - Tool registration
 */

import { BaseComponent, type ComponentConfig } from "../component";
import {
  TaskConfigSchema,
  type TaskConfig,
  type Task,
  type TaskStatus,
  type TaskOperation,
  type CreateTaskOptions,
  type UpdateTaskOptions,
  type ListTasksOptions,
  type CreateOperationOptions,
  type ListOperationsOptions,
  type TaskListResult,
  type SearchTasksOptions,
} from "./types";
import { SQLiteTaskStore, type TaskStore, getDefaultTaskDbPath } from "./storage";
import { RemoteTaskStore } from "./storage/remote-task-store";
import { createLogger } from "../log-trace/logger";
import type { ToolComponent } from "../tool";
import type { Tool } from "../tool/types";
import * as taskTools from "./tools";
import * as operationTools from "./tools/operation";
import { createDelegateTool, createStopTool, BackgroundTaskManager } from "./delegate";
import { TASK_CONFIG_REGISTRATION, TASK_DEFAULTS } from "./task-config-registration";
import type { ConfigComponent } from "../../config/config-component";
import { envKeyToConfigKey } from "../../config/env-key";

// Env-scoped tool factory 注入 query_background_process 工具所需的 BackgroundTaskManager
// （2026-07-15 重构：替代 module-global setQueryBackgroundProcessManager setter 模式）
import {
  createQueryBackgroundProcessTool,
} from "../tool/built-in/query-background-process-tool";

// Task #4982 — compact_session 工具（default agent 专用 sub-session 压缩）
import {
  createCompactSessionTool,
  compactSessionTool,
} from "../tool/built-in/compact-session-tool";

// Hook 机制
import { globalHookManager } from "../hook/global-hook-manager";
import { TaskHookPoints, type TaskHookPoint } from "./hooks";
import type {
  TaskCreateContext,
  TaskCreateResultContext,
  TaskUpdateContext,
  TaskUpdateResultContext,
  TaskDeleteContext,
  TaskDeleteResultContext,
  TaskOperationCreateContext,
  TaskOperationCreateResultContext,
  TaskCompleteResultContext,
} from "./hooks/contexts";
import { getEnvContextOrEmpty } from "../context/env-context";

// Tag 服务
import { DefaultTagService, type TagService } from "./tag-service";

// Event 发布
import { TaskEntityEventTypes } from "./events/task-event-types";
import type { Hook } from "../hook/types";
import { TracedAs } from "../log-trace/decorator";
// Task #5060 — 终态 current_status 措辞同源锚点（与 cancel-tool 共用）
// Task #5063 — 新增 TASK_CANCELLED_STATUS_WORD / TASK_ARCHIVED_STATUS_WORD
//   （终态 current_status 的**唯一**措辞来源，见 withTerminalCurrentStatus）
import {
  TASK_COMPLETED_STATUS_WORD,
  TASK_CANCELLED_STATUS_WORD,
  TASK_ARCHIVED_STATUS_WORD,
  TASK_REOPENED_STATUS_WORD,
  TASK_TERMINAL_STATUS_WORDS,
  TASK_DELIVERABLE_RECORDED,
  TASK_TO_VALIDATE_STATUS_WORD,
  TERMINAL_NON_ACCEPTABLE_STATUSES,
} from "./tools/completion-copy";

const logger = createLogger("task");

/**
 * Task #5067 — 「这个 status 是不是终态」的判定（reopen 反向收口用）
 *
 * ⚠️ 与 TASK_COMPLETE_TERMINAL_STATUSES（hooks/contexts.ts）**故意不同**：
 *   那个集合是 completed/failed/cancelled/timeout —— 决定「要不要 fire
 *   AFTER_COMPLETE 钩子」；这里要判的是「current_status 该不该按终态文案刷」，
 *   集合是 completed/cancelled/archived（failed/timeout 不是合法 TaskStatus）。
 *   两者语义正交，别合并。
 */
function isTerminalTaskStatus(status: TaskStatus): boolean {
  return (
    status === "completed" || status === "cancelled" || status === "archived"
  );
}

/**
 * Task #5067 — 「这段 current_status 是不是系统写的终态文案」的判定
 *
 * 判据：以某个终态锚点**开头**（TASK_COMPLETED_STATUS_WORD /
 * TASK_CANCELLED_STATUS_WORD / TASK_ARCHIVED_STATUS_WORD）。
 *
 * 为什么是 startsWith 而不是 includes：
 *   系统写的终态文案可能带后缀（「已归档：批量整理」「已完成（交付物已记录：/x.md）」），
 *   开头才是语义主体。用 includes 会误伤调用方自己写的
 *   「已完成的部分：A/B/C」这类正常文案。
 *
 * 已知取舍：若调用方**恰好手动写了**以终态锚点开头的文案，且任务当时
 * 正处于终态，reopen 时该文案会被系统措辞替换。这是「值比对」方案的
 * 固有代价，已用「前态 status 必须是终态」把触发面压到极窄。
 */
function looksLikeSystemTerminalWording(currentStatus: string | undefined): boolean {
  if (!currentStatus) return false;
  const trimmed = currentStatus.trim();
  if (!trimmed) return false;
  return TASK_TERMINAL_STATUS_WORDS.some((word) => trimmed.startsWith(word));
}

/**
 * Task #2778 v2: deliverable 在 operation 行的统一格式
 * 同时用于 task.context.deliverable_storage_path 字段和 operation.milestoneDescription 描述。
 * 调用方在 op 列表 / task 列表里都看到一致的 "Deliverable: <path>" 字符串。
 */
export const DELIVERABLE_OPERATION_PREFIX = "Deliverable: ";

/**
 * 把 deliverable 路径格式化成 operation.milestoneDescription。
 * - 有 path：返回 "Deliverable: <path>"
 * - 无 path：返回 undefined（避免误写 "Deliverable: undefined"）
 */
export function formatDeliverableForOperation(
  deliverableStoragePath: string | undefined
): string | undefined {
  if (!deliverableStoragePath) return undefined;
  return `${DELIVERABLE_OPERATION_PREFIX}${deliverableStoragePath}`;
}

/**
 * TaskComponent 配置选项（通过 options 传递）
 * 
 * 配置加载顺序（优先级从低到高）：
 * 1. File - 配置文件（通过 configPath 指定）
 * 2. Env - 环境变量（通过 envPrefix 配置前缀）
 * 3. Object - 直接传入的 config 对象（最高优先级）
 */
export interface TaskComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: ConfigComponent;
  
  /** 配置文件相对路径（可选，基于 XDG_DATA_HOME） */
  configPath?: string;
  
  /** 环境变量前缀（可选，默认 "TASK"） */
  envPrefix?: string;
  
  /** 直接传入的配置对象（可选，优先级最高） */
  config?: Partial<TaskConfig>;

  /**
   * Task #4794 — 组件 stop() 时 BackgroundTaskManager.dispose() 的收尾行为。
   *
   * CLI `act` 一次性命令收尾时传 true（主 run 已结束，后台子 agent
   * 是有意留下继续跑的）；REPL / ESC cascade 等用户主动退出场景
   * 保持默认 false（abort 全部，语义不变）。
   */
  skipAbortRunningTasksOnDispose?: boolean;

  /**
   * Task #4794 — 与 skipAbortRunningTasksOnDispose 配套：
   * stop() 时等待运行中的后台任务完成后再返回。
   * 子 agent 是同进程异步 run，进程 exit 会直接杀死它们，
   * 所以 act 收尾必须等待。默认 false。
   */
  waitForRunningTasksOnDispose?: boolean;
}

export class TaskComponent extends BaseComponent {
  name = "task";
  version = "1.0.0";
  
  private store!: TaskStore;
  private config?: TaskConfig;
  private toolComponent?: ToolComponent;
  private backgroundTaskManager?: BackgroundTaskManager;

  /**
   * Task #4794 — stop() 时是否跳过 abort 仍在运行的后台任务
   * （act 一次性命令收尾 = true；用户主动退出 = false 默认）。
   */
  private skipAbortRunningTasksOnDispose = false;

  /**
   * Task #4794 — stop() 时是否等待运行中任务完成
   * （act 收尾配套：跳过 abort 后必须等子 agent 跑完，
   * 否则 process.exit 仍会杀死同进程子 agent）。
   */
  private waitForRunningTasksOnDispose = false;
  private configComponent?: ConfigComponent;
  private tagService!: TagService;
  private plugins: Map<string, Hook> = new Map();

  /**
   * Task #2245 — Codex P1-4: public typed accessor for `backgroundTaskManager`.
   *
   * Replaces the previous `as any` cast pattern (session-tree-stopper.ts)
   * that accessed the private field directly. Returns undefined if the
   * BackgroundTaskManager has not been initialized yet (init pending)
   * or has been disposed.
   */
  getBackgroundTaskManager(): BackgroundTaskManager | undefined {
    return this.backgroundTaskManager;
  }

  /**
   * ★ Task #5580（2026-11-15 补充）—— lark 卡片开关（config.jsonc 可配）。
   *
   * ## 配置键（沿用 task 组件点号惯例）
   *
   * - `task.plugins.larkCard.emitTaskCard`（默认 true）
   *   —— task hook 触发的**任务卡片**（用户主关注，pin）
   * - `task.plugins.larkCard.emitSessionCard`（默认 true）
   *   —— sub-session 生命周期触发的 **session 卡片**（调试用）
   *
   * ## 生效方式
   *
   * config.jsonc 是 task 组件的 file source（watch 开启）⇒
   * 改文件即热更新，**无需重启 ES**。每次 hook 执行时现读
   * （`LarkCliTaskNotifyHook` 在 execute 内调用本方法）。
   *
   * ## 降级
   *
   * configComponent 缺失 / 键未配置 / 值不是 boolean ⇒ 默认 true
   * （与改造前行为一致：两卡并存）。
   */
  getCardNotifyConfig(): { emitTaskCard: boolean; emitSessionCard: boolean } {
    const readFlag = (key: string): boolean => {
      try {
        const v = this.configComponent?.get(key);
        // 显式 false 才关（其它脏值一律按 true 处理，安全侧）
        return v !== false;
      } catch {
        return true;
      }
    };
    return {
      emitTaskCard: readFlag("task.plugins.larkCard.emitTaskCard"),
      emitSessionCard: readFlag("task.plugins.larkCard.emitSessionCard"),
    };
  }

  // ========================================================================
  // Event Publishing
  // ========================================================================

  /**
   * 发布 EnvEvent
   */
  private publishEvent<T>(type: string, payload: T, sessionId?: string): void {
    if (this.env?.pushEnvEvent) {
      this.env.pushEnvEvent({
        type,
        payload,
        metadata: {
          source: "task.component",
          trigger_session_id: sessionId,
        },
      });
      logger.info(`[TaskComponent] Event published: ${type}`);
    }
  }

  constructor() {
    super();
  }

  /**
   * Initialize the component
   * 
   * 配置加载优先级（从高到低）：
   * 1. Object - 直接传入的 config 对象
   * 2. Env - 环境变量（通过 envPrefix 配置前缀）
   * 3. File - 配置文件（通过 configPath 指定）
   */
  async init(config?: ComponentConfig): Promise<void> {
    // 调用基类 init，注入 env
    await super.init(config);

    // 从 options 获取 ConfigComponent
    const options = config?.options as unknown as TaskComponentOptions | undefined;
    if (!options?.configComponent) {
      throw new Error("ConfigComponent is required for TaskComponent initialization");
    }

    this.configComponent = options.configComponent;
    // Task #4794 — act 收尾路径标记：stop() 时跳过 abort 运行中任务
    this.skipAbortRunningTasksOnDispose =
      options.skipAbortRunningTasksOnDispose === true;
    this.waitForRunningTasksOnDispose =
      options.waitForRunningTasksOnDispose === true;
    await this.registerConfig(options);

    this.setStatus("running");
    logger.info("[TaskComponent] Initialized");
  }

  /**
   * 注册配置到 ConfigComponent
   * 
   * 配置加载顺序（优先级从低到高）：
   * 1. Defaults - 默认值（最低）
   * 2. FileSource - 从配置文件加载
   * 3. EnvSource - 从环境变量加载
   * 4. config 对象 - 直接传入的配置（最高）
   */
  private async registerConfig(options: TaskComponentOptions): Promise<void> {
    const configComponent = this.configComponent;
    if (!configComponent) return;

    const { configPath, envPrefix, config } = options;
    const prefix = envPrefix ?? "TASK";

    // 1. 使用 registerComponent 注册配置结构（keys 和 sources，不含 defaults）
    configComponent.registerComponent(TASK_CONFIG_REGISTRATION);

    // 2. 注册 FileSource（如果提供了 configPath）
    if (configPath) {
      configComponent.registerSource({
        type: "file",
        relativePath: configPath,
        optional: true,
        // ★ Task #5580：watch 开启 —— `task.plugins.larkCard.*`
        //   开关改 config.jsonc 即热生效（无需重启 ES）。
        //   既有键的读取方（initStore 等）只在 init 时读一次，
        //   不受 watch 影响；新开关每次 hook 执行时现读。
        watch: true
      });
    }

    // 3. 注册 EnvSource
    configComponent.registerSource({
      type: "env",
      envPrefix: prefix,
      priority: 20,
      watch: false
    });
    
    // 4. 从 sources 加载配置（FileSource 和 EnvSource）
    await configComponent.load("task");
    
    // 5. 后备方案：直接读取环境变量（确保所有环境变量都被处理）
    for (const envKey of Object.keys(process.env)) {
      const configKey = envKeyToConfigKey(envKey, prefix, "task");
      if (!configKey) continue;
      const value = process.env[envKey];
      if (value !== undefined) {
        await configComponent.set(configKey, value);
      }
    }

    // 6. 设置默认值（只有当配置不存在时）
    for (const [key, value] of Object.entries(TASK_DEFAULTS)) {
      if (configComponent.get(key) === undefined) {
        await configComponent.set(key, value);
      }
    }

    // 6.5 特殊处理 dbPath 动态默认值（只有当配置不存在时）
    if (configComponent.get("task.storage.dbPath") === undefined) {
      await configComponent.set("task.storage.dbPath", getDefaultTaskDbPath());
    }

    // 7. 直接配置对象（最高优先级）
    if (config) {
      const flatConfig = this.flattenConfig(config);
      for (const [key, value] of Object.entries(flatConfig)) {
        await configComponent.set(key, value);
      }
    }

    // 8. 注册配置热更新监听
    this.registerConfigWatcher(configComponent);

    // 9. 解析最终配置并初始化 store
    await this.initStore();

    // 10. 初始化 TagService
    this.tagService = new DefaultTagService(this.store);
  }

  /**
   * 根据配置初始化 store
   */
  private async initStore(): Promise<void> {
    const configComponent = this.configComponent;
    if (!configComponent) return;

    const storageType = configComponent.get("task.storage.type") ?? "sqlite";
    const dbPath = configComponent.get("task.storage.dbPath") as string | undefined;

    // ★ CV MAJOR-2 — store 切换必须**原子**：
    //   1. 先构造新 store（可能因为配置非法而抛错）
    //   2. 只有构造成功才 close 旧 store 并重绑 tagService
    //   否则失败路径会把旧 store 关掉却还留着它，日志还说「保留旧 store」
    //   —— remote 模式下那是个已关闭的实例，后续所有 task 操作全部失败。
    const previous = this.store;
    const nextStore = this.buildStore(storageType, dbPath);

    if (previous) {
      try {
        previous.close();
      } catch (e) {
        logger.warn(
          `[TaskComponent] Failed to close previous store: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }

    this.store = nextStore;
    // tagService 持有的是 store 的引用：store 一换就必须重绑，
    // 否则 tag 的读写会静默打向旧库（切到 remote 后仍写本地 sqlite）。
    this.tagService = new DefaultTagService(this.store);

    if (storageType === "remote") {
      const endpoint = configComponent.get("task.storage.endpoint") as string | undefined;
      logger.info(
        `[TaskComponent] Using remote task-service: ${endpoint}` +
          `${configComponent.get("task.storage.authToken") ? " (with bearer token)" : " (no auth token)"}`,
      );
    } else if (storageType === "sqlite") {
      logger.info(`[TaskComponent] Using SQLite storage: ${dbPath || "default path"}`);
    }
  }

  /**
   * 按配置**构造**（不安装）一个 store。
   *
   * 单独抽出来是为了让 `initStore` 能「先构造后安装」——构造失败时旧 store
   * 保持原样（CV MAJOR-2）。
   */
  private buildStore(storageType: unknown, dbPath: string | undefined): TaskStore {
    const configComponent = this.configComponent;

    // ── remote：指向常驻 task-service（方案 v3 §4.1）────────────────────
    if (storageType === "remote") {
      const endpoint = configComponent?.get("task.storage.endpoint") as string | undefined;
      const authToken = configComponent?.get("task.storage.authToken") as string | undefined;

      // 显式校验：缺 endpoint 绝不猜默认值，也绝不静默退回本地库
      // （否则会出现「以为在写 service，实际写本地」的双库分叉）。
      if (!endpoint) {
        throw new Error(
          "[TaskComponent] task.storage.type=remote requires task.storage.endpoint " +
            "(e.g. http://127.0.0.1:7820). Set task.storage.endpoint and task.storage.authToken " +
            "to match the running roy-task-service. No local fallback is performed by design.",
        );
      }

      return new RemoteTaskStore({ endpoint, authToken });
    }

    // ── sqlite（默认，行为与之前完全一致）──────────────────────────────
    if (storageType === "sqlite") {
      return new SQLiteTaskStore(dbPath);
    }

    // 未知 type：保持历史行为（退回默认 sqlite），但明确告警，避免
    // 拼错 type 后静默用错存储。
    logger.warn(
      `[TaskComponent] Unknown task.storage.type="${String(storageType)}", ` +
        `falling back to default SQLite storage. Supported: "sqlite" | "remote".`,
    );
    return new SQLiteTaskStore();
  }

  /**
   * 将配置对象展平为点号路径
   */
  private flattenConfig(
    obj: Record<string, unknown>,
    prefix = "task"
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = `${prefix}.${key}`;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(
          result,
          this.flattenConfig(value as Record<string, unknown>, fullKey)
        );
      } else {
        result[fullKey] = value;
      }
    }
    return result;
  }

  /**
   * 注册配置热更新监听
   */
  private registerConfigWatcher(configComponent: ConfigComponent): void {
    if (typeof configComponent.watch !== "function") {
      return;
    }
    
    this.configWatcher = configComponent.watch("task.*", (event) => {
      this.onConfigChange(event);
    });
  }

  /**
   * 处理配置变更
   */
  protected onConfigChange(event: { key: string; oldValue?: unknown; newValue?: unknown }): void {
    logger.info(`[TaskComponent] Config changed: ${event.key}`, {
      oldValue: event.oldValue,
      newValue: event.newValue
    });
    // 如果 storage 配置变更，需要重新初始化 store
    if (
      event.key === "task.storage.type" ||
      event.key === "task.storage.dbPath" ||
      event.key === "task.storage.endpoint" ||
      event.key === "task.storage.authToken"
    ) {
      // ⚠️ 热更新路径不能抛到 watcher（会让事件订阅者收到未捕获异常）：
      // 记错误并保留旧 store，等下一次配置修正后再重建。
      Promise.resolve(this.initStore()).catch((e: unknown) => {
        logger.error(
          `[TaskComponent] Failed to re-init store after ${event.key} change: ` +
            `${e instanceof Error ? e.message : String(e)} (keeping previous store)`,
        );
      });
    }
  }

  /** 配置变更 watcher 清理函数 */
  private configWatcher?: () => void;

  /**
   * Start the component - register tools
   */
  async start(): Promise<void> {
    await super.start();

    // Create BackgroundTaskManager
    this.backgroundTaskManager = new BackgroundTaskManager(this.env);

    // Get ToolComponent and register tools
    this.toolComponent = this.env?.getComponent("tool");
    if (this.toolComponent) {
      await this.registerTools();

      // ★ Env-scoped tool factory 注入（2026-07-15 重构，修复多 Environment 互相覆盖问题）
      // 用 BackgroundTaskManager 创建 manager-bound query_background_process tool 并
      // 重新注册到 ToolComponent，覆盖 no-manager 默认版本。
      // 这样 default agent 看到的工具闭包里持有这个 TaskComponent 的 manager 引用。
      // 多个 Environment 拥有独立的 manager，互不干扰。
      this.toolComponent.register(
        createQueryBackgroundProcessTool(this.backgroundTaskManager),
        "built-in",
      );
      logger.debug(
        "[TaskComponent] Injected BackgroundTaskManager into query_background_process tool (factory pattern)",
      );

      // ★ Task #4982 — compact_session 工具（default agent 专用）
      // 用 BackgroundTaskManager + SessionComponent 创建 deps-bound
      // 实例并注册到 ToolComponent，覆盖 no-deps 默认版本。
      // default agent 由此获得「压缩 sub-session 后继续复用」的能力。
      const sessionComponent = this.env?.getComponent("session") as
        | { compact: (id: string, opts?: any) => Promise<any> }
        | undefined;
      this.toolComponent.register(
        createCompactSessionTool(
          this.backgroundTaskManager,
          (sessionComponent as any) ?? null,
        ),
        "built-in",
      );
      logger.debug(
        "[TaskComponent] Registered compact_session tool (factory pattern)",
      );
    } else {
      logger.warn("[TaskComponent] ToolComponent not found, skipping tool registration");
    }
  }

  /**
   * Stop the component
   */
  async stop(): Promise<void> {
    // 清理配置 watcher
    if (this.configWatcher) {
      this.configWatcher();
      this.configWatcher = undefined;
    }

    // ★ 把 query_background_process 重新注册为 no-manager 版本
    // （避免 component 关闭后 LLM 仍持有失效的 BackgroundTaskManager 引用）
    if (this.toolComponent) {
      try {
        this.toolComponent.register(
          createQueryBackgroundProcessTool(null),
          "built-in",
        );
        logger.debug(
          "[TaskComponent] Reset query_background_process tool to no-manager default (cleanup)",
        );
      } catch (err) {
        logger.warn(
          `[TaskComponent] Failed to reset query_background_process tool: ${(err as Error).message}`,
        );
      }

      // ★ Task #4982 — compact_session 重置为 no-deps 版本
      try {
        this.toolComponent.register(compactSessionTool, "built-in");
        logger.debug(
          "[TaskComponent] Reset compact_session tool to no-deps default (cleanup)",
        );
      } catch (err) {
        logger.warn(
          `[TaskComponent] Failed to reset compact_session tool: ${(err as Error).message}`,
        );
      }
    }

    // Dispose BackgroundTaskManager to clean up timers and prevent process hanging
    // Task #4794 — skipAbortRunningTasksOnDispose=true（act 收尾）时
    // 不 abort 仍在运行的后台子 agent（防 task_signal_abort 误杀），
    // 并等待其自然完成（子 agent 是同进程异步 run，进程 exit 会杀死它们）
    if (this.backgroundTaskManager) {
      // Task #4794 根因 #3 — dispose 是 async，必须 await。
      // 否则 fire-and-forget：dispose 在 waitForRunningTasks
      // 轮询的 setTimeout 处让出事件循环后，stop() 继续返回
      // → Environment stopped → process.exit 杀死同进程子 agent
      // （e2e 取证：23:10:21.776 打印一次 "dispose waiting" 后
      // 3ms 内全部组件停止，done 文件永不生成）。
      await this.backgroundTaskManager.dispose(
        this.skipAbortRunningTasksOnDispose
          ? {
              skipAbortRunningTasks: true,
              waitForRunningTasks: this.waitForRunningTasksOnDispose,
            }
          : undefined,
      );
      this.backgroundTaskManager = undefined;
    }
    if (this.store) {
      await this.store.close();
    }
    await super.stop();
  }

  // ========================================================================
  // Tool Registration
  // ========================================================================
  
  /**
   * Register task tools to ToolComponent
   */
  private async registerTools(): Promise<void> {
    if (!this.toolComponent) return;

    // Task tools
    const taskToolsList: Tool[] = [
      taskTools.createTaskTool(this),
      taskTools.getTaskTool(this),
      taskTools.listTasksTool(this),
      taskTools.treeTasksTool(this),
      taskTools.searchTasksTool(this),
      taskTools.batchArchiveTaskTool(this),
      taskTools.batchDeleteTaskTool(this),
      taskTools.updateTaskTool(this),
      taskTools.deleteTaskTool(this),
      taskTools.completeTaskTool(this),
      // Task #5007 — 验收权移交 default agent：取消 Task 本身（status=cancelled）
      taskTools.cancelTaskTool(this),
      // ★ Task #5073 — 两阶段验收：sub-agent 提交待验证（status=to_validate）
      taskTools.preCompleteTaskTool(this),
    ];

    // Operation tools
    const operationToolsList: Tool[] = [
      operationTools.createOperationTool(this),
      operationTools.getOperationTool(this),
      operationTools.listOperationsTool(this),
      operationTools.updateOperationTool(this),
      operationTools.deleteOperationTool(this),
    ];

    // Delegate tools (with background task manager)
    const delegateTools: Tool[] = [
      createDelegateTool(this),
      createStopTool(this.backgroundTaskManager!),
    ];

    // Register all tools
    for (const tool of [...taskToolsList, ...operationToolsList, ...delegateTools]) {
      this.toolComponent.register(tool);
      logger.info(`[TaskComponent] Registered tool: ${tool.name}`);
    }
  }

  // ========================================================================
  // Hook 执行
  // ========================================================================

  /**
   * 执行 Hook
   */
  @TracedAs("task.component.executeHook", { recordParams: true })
  private async executeHook<P extends TaskHookPoint>(
    hookPoint: P,
    data: any,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    const ctx = {
      component: { name: this.name, version: this.version },
      data,
      metadata,
      phase: hookPoint.includes("before") ? "before" as const : "after" as const,
      hookPoint,
    };
    
    // ★ 直接传 data 而非 ctx，避免 hook-manager 二次包装导致 ctx.data 结构错误
    await globalHookManager.execute(hookPoint, data, metadata);
  }

  // ========================================================================
  // Task CRUD
  // ========================================================================
  
  /**
   * Create a new task
   */
  @TracedAs("task.component.createTask", { recordParams: true, recordResult: true, log: true })
  async createTask(options: CreateTaskOptions): Promise<Task> {
    const sessionId = options.sessionId;
    
    // parent_task_id is optional. If provided, validate the parent task exists.
    // If omitted / null / undefined, create a root task (no parent).
    if (options.parent_task_id !== undefined && options.parent_task_id !== null) {
      const parentTask = await this.store.getTask(options.parent_task_id);
      if (!parentTask) {
        throw new Error(`Parent task #${options.parent_task_id} not found. ` +
          "Please provide a valid parent_task_id. Use task_list(depth=0) to see all root tasks.");
      }
    }
    
    // 1. beforeCreate Hook
    const createCtx: TaskCreateContext = {
      options: { ...options },
      sessionId,
      tagService: this.tagService,
      // ⚠️ Task #4620：决策检测插件要按 similar_task_ids 取候选任务详情 ——
      //   候选详情只有 TaskComponent 能给。这是 #4467 契约允许的「1 行」改动，
      //   插件只读这个句柄（不写不删），决策仍然是「只提示不拦截」。
      taskComponent: this,
    };
    
    await this.executeHook(TaskHookPoints.BEFORE_CREATE, createCtx);
    
    // 2. 实际创建
    const task = await this.store.createTask(createCtx.options);
    
    // 3. Auto-create operation record for task creation
    await this.store.createOperation({
      taskId: task.id,
      sessionId,
      milestoneType: "create",
      milestoneTitle: `Task created: ${task.title}`,
      milestoneDescription: task.description || "",
    });
    
    // 4. afterCreate Hook
    const resultCtx: TaskCreateResultContext = {
      task,
      sessionId,
      tagService: this.tagService,
    };
    await this.executeHook(TaskHookPoints.AFTER_CREATE, resultCtx);
    
    // 5. 发布 task.created 事件
    this.publishEvent(TaskEntityEventTypes.CREATED, { task, sessionId }, sessionId);
    
    logger.info(`[TaskComponent] Task created: ${task.id} - ${task.title}`);
    return task;
  }
  
  /**
   * Get task by ID
   */
  async getTask(id: number): Promise<Task | undefined> {
    return this.store.getTask(id);
  }

  /**
   * 按 session_id 反查该 session 创建的第一个 task（sub-session → task 确定性映射）。
   */
  async getTaskIdBySessionId(sessionId: string): Promise<number | undefined> {
    return this.store.getTaskIdBySessionId(sessionId);
  }

  /**
   * Task #5081 — 按 session_id 反查该 session 绑定的**全部** task。
   *
   * 为什么需要：一个 sub-session 可能创建/关联多个 task
   * （getTaskIdBySessionId 只返回第一个，ORDER BY timestamp ASC）。
   * TaskOpWatermarkPlugin 对全部 task 求并集水位（保守不漏报）。
   */
  async getTaskIdsBySessionId(sessionId: string): Promise<number[]> {
    const store = this.store as unknown as {
      getTaskIdsBySessionId?(sessionId: string): Promise<number[] | undefined>;
    };
    if (typeof store.getTaskIdsBySessionId === "function") {
      const ids = await store.getTaskIdsBySessionId(sessionId);
      return Array.isArray(ids) ? ids : [];
    }
    const first = await this.store.getTaskIdBySessionId(sessionId);
    return typeof first === "number" ? [first] : [];
  }

  /**
   * Get task with operations
   *
   * Task #4619 (cross-validation M-2): the result is **flat** —
   * `{ ...task, operations }` — not `{ task, operations }`.
   *
   * Two independent reasons, both about the published contract:
   *
   * 1. The old plugin's `taskGet` returned `{ ...task, operations }`, and
   *    that flat shape is what every client written against the published
   *    plugin reads (`task.title`, `task.operations`). Nesting moved every
   *    task field one level down — just as breaking as dropping the
   *    operations.
   * 2. `TaskStoreBackend.getTaskWithOperations()` (the backend the plugin
   *    binds) already returns the flat shape. The two implementations had
   *    drifted, so the same tool produced two different shapes depending on
   *    which backend it was bound to.
   *
   * ---
   *
   * Task #4622: the flat shape ALSO carries a **nested `task` alias**, so
   * the already-published `@ai-setting/roy-bot-cli@1.7.59` keeps working.
   *
   * That CLI declares `"@ai-setting/roy-bot-core": "^1.5.83"` — a range
   * that accepts 1.7.61 — and its `tasks get` command reads the **nested**
   * shape:
   *
   *     const result = await taskComponent.getTaskWithOperations(args.id);
   *     output.log(`Task #${result.task.id}: ${result.task.title}`);
   *
   * Publishing the flat-only shape therefore broke `roy-bot tasks get`
   * for every user still on CLI 1.7.59:
   *
   *     TypeError: Cannot read properties of undefined (reading 'id')
   *
   * (Measured against the real published tarball, not reasoned about.)
   *
   * So the result carries **both** views:
   *
   *     result.id        → flat access (the plugin's MCP contract)
   *     result.task.id   → nested access (published CLI 1.7.59)
   *
   * The alias points at the **same object** the flat fields were spread
   * from, so the two views can never disagree. It is deliberately **not**
   * self-referential (`result.task === result`), because that would make
   * `JSON.stringify` throw "Converting circular structure to JSON" — and
   * this very object is what `task_get` serialises for the MCP wire.
   */
  async getTaskWithOperations(
    id: number,
  ): Promise<(Task & { operations: TaskOperation[]; task: Task }) | undefined> {
    const task = await this.store.getTask(id);
    if (!task) return undefined;

    const operations = await this.store.listOperations({ taskId: id });
    return { ...task, operations, task };
  }

  /**
   * ★ Task #5063 — 终态 current_status 收口辅助（**唯一**措辞/规则来源）
   *
   * 规则（测试锁死，勿改）：
   *   1. **只在 status 迁移到终态时**补 current_status
   *      —— 非终态（todo/active/paused）原样返回，不碰 current_status。
   *         （否则会破坏 `task_update(current_status="推进中")` 这类合法用法。）
   *   2. **调用方显式传了 current_status 就尊重调用方**，不覆盖
   *      —— completeTask / cancelTaskTool 已在自己的调用里写好了带
   *         deliverable / reason 的终态文案，不能被这里冲掉。
   *   3. 只认**本次更新要落**的 status —— `status` 缺省时一律不动。
   *
   * 终态集合与措辞：
   *   - completed → TASK_COMPLETED_STATUS_WORD（但 completeTask 自己写了带
   *     deliverable 的版本，走的是规则 2「尊重调用方」，不受这里影响）
   *   - cancelled → TASK_CANCELLED_STATUS_WORD
   *   - archived  → TASK_ARCHIVED_STATUS_WORD
   *
   * ⚠️ 与 TASK_COMPLETE_TERMINAL_STATUSES（hooks/contexts.ts）**故意不同**：
   *   那个集合决定「要不要 fire AFTER_COMPLETE 钩子」（archived 不 fire）；
   *   这个集合决定「要不要刷新 current_status」（archived 要刷）。
   *   两者语义正交，别合并。
   *
   * ★ Task #5067 — 新增**反向**收口（reopen：终态 → 非终态）
   *
   *   #5063 只管「迁入终态」。反向路径没管 ⇒ 任务从终态被 reopen 回
   *   active/todo 时，current_status 仍停在终态文案（"已归档"/"已取消"/"已完成"），
   *   出现「status: active 但 current_status: 已归档」的自相矛盾状态。
   *
   *   规则 4（新增，测试锁死）：
   *     **从终态迁出到非终态，且当前 current_status 是系统写的终态文案时，
   *       把 current_status 换成 reopen 措辞。**
   *
   *   为什么这不违反规则 1：
   *     规则 1 说的「非终态迁移不碰 current_status」指的是**普通进度更新**
   *     （如 `task_update(current_status="推进中")`）—— 那必须保留调用方
   *     显式传的值。而 reopen 时 current_status 里留着的是**系统自己写的
   *     终态文案**，不是调用方的意图 ⇒ 这种情况**应该**被刷新。
   *
   *   判定用「值比对 + 前态 status」双条件（修法 A 增强版）：
   *     - 值比对：current_status 以某个终态锚点**开头**（TASK_TERMINAL_STATUS_WORDS）
   *     - 前态 status：任务**当前**确实处于终态（archived/cancelled/completed）
   *     两个条件同时成立才替换。为什么要加「前态」条件：
   *       只看值的话，active 任务上手写的「已完成的部分：A/B/C」会被误判
   *       成陈旧终态文案而被冲掉。加上前态判定后，只有**真的从终态迁出**
   *       时才动 —— 把误伤面压到极窄。
   */
  private withTerminalCurrentStatus(
    options: UpdateTaskOptions,
    previousTask?: Task,
  ): UpdateTaskOptions {
    const status = options.status;

    // 规则 3 + 规则 1：没传 status，或不是终态 ⇒ 原样返回
    if (!status) return options;

    // 规则 2：调用方显式给了 current_status ⇒ 尊重调用方
    if (options.current_status !== undefined) return options;

    let terminalWord: string | undefined;
    switch (status) {
      case "completed":
        terminalWord = TASK_COMPLETED_STATUS_WORD;
        break;
      case "cancelled":
        terminalWord = TASK_CANCELLED_STATUS_WORD;
        break;
      case "archived":
        terminalWord = TASK_ARCHIVED_STATUS_WORD;
        break;
      default:
        // ★ Task #5067 规则 4 —— **反向**收口：终态 → 非终态（reopen）。
        //
        //   只有「当前状态确实是终态」且「current_status 是系统写的终态文案」
        //   才替换成 reopen 措辞。两个条件缺一不可：
        //     - 缺「前态是终态」：active 任务上手写的「已完成的部分」会被误伤
        //     - 缺「值是终态文案」：用户自己写的普通文案会被无端覆盖
        //
        //   ⚠️ 非终态但**不**是 reopen 的普通更新（只传 progress 等）根本进不来
        //      这里 —— 规则 3（status 缺省）已在上方早返回。
        if (
          previousTask &&
          isTerminalTaskStatus(previousTask.status) &&
          looksLikeSystemTerminalWording(previousTask.current_status)
        ) {
          return { ...options, current_status: TASK_REOPENED_STATUS_WORD };
        }
        // todo / active / paused —— 非终态，不碰 current_status
        return options;
    }

    // ⚠️ 只在真的拿到终态措辞时才加 current_status 字段 ——
    //   绝不能塞 `current_status: undefined` 进去：某些 store / port 会用
    //   `"current_status" in options` 判断字段是否存在（而不是 `!== undefined`），
    //   塞 undefined 会让它们误判成「调用方要求清空 current_status」。
    return { ...options, current_status: terminalWord };
  }

  /**
   * Update task
   */
  @TracedAs("task.component.updateTask", { recordParams: true, recordResult: true, log: true })
  async updateTask(id: number, options: UpdateTaskOptions): Promise<Task | undefined> {
    // ★ Task #5063 — 终态 current_status 收口（archived / cancelled 出口）。
    //
    // 背景（Task #5060 的 follow-up，DS review 留档 MINOR m2）：
    //   #5060 修掉了 completeTask / cancelTaskTool 不写 current_status 的缺陷，
    //   但 **archived 是同一 bug 的第四个出口**，且**通用入口没修**：
    //     - `tasks complete --archive`（cli/src/commands/tasks/complete.ts）
    //     - 批量归档工具（tools/batch-archive-tool.ts）
    //     - 通用 `task_update`（tools/update-tool.ts，zod enum 直接允许 archived/cancelled）
    //   ⇒ 走归档路径的任务，current_status 仍停在归档前的旧文案
    //     （如「调研中：检索 GitHub…」），与 #5060 修掉的 bug 一模一样，只是入口不同。
    //
    // 为什么收口在**这一层**（而不是每个调用点各打一处补丁）：
    //   updateTask 是所有终态 status 的**唯一汇聚点** —— 在这里收口，
    //   一次就覆盖上面 3 条路径 + 未来任何新增的终态调用点，不会再漏。
    //
    // ⚠️ 边界（必须保持，测试锁死）：
    //   1. **只在 status 迁移到终态时**写 current_status
    //      —— 非终态迁移（todo/active/paused）**不碰** current_status，
    //         否则会破坏 `task_update(current_status="推进中")` 这类合法用法。
    //   2. **调用方显式传了 current_status 就尊重调用方**（不覆盖）
    //      —— completeTask / cancelTaskTool 已经在自己的调用里写好了
    //         带 deliverable / reason 的终态文案，不能被这里冲掉。
    // 1. beforeUpdate Hook
    //    ⚠️ BEFORE_UPDATE 的 options 必须保持「调用方原始请求」语义 ——
    //    终态 current_status 是**本层派生**出来的（调用方没要求写），
    //    若把它塞进 hook options，hook 订阅者看到的就不是调用方的真实意图了。
    const updateCtx: TaskUpdateContext = {
      id,
      options: { ...options },
      tagService: this.tagService,
    };
    await this.executeHook(TaskHookPoints.BEFORE_UPDATE, updateCtx);

    // 2. 实际更新
    //    ★ Task #5063 DS review MAJOR M1 修正 ——
    //    终态 current_status 的派生必须基于 **hook 处理过的** updateCtx.options，
    //    而不是 hook 之前的快照。理由：
    //      - hooks/contexts.ts:82 明确文档化「Plugin 可直接修改 options 来干预
    //        更新行为」—— 这是已文档化的公共扩展点，hook 的修改必须能落库。
    //        （之前在 hook 之前快照派生 ⇒ hook 的修改被整包丢弃，静默废掉该扩展点。）
    //      - hook 若自行写了 current_status，正好命中规则 2「尊重调用方」。
    //      - 派生值仍**不泄漏**进 hook options / AFTER_UPDATE changes ——
    //        AFTER_UPDATE / AFTER_COMPLETE 的 changes 仍用原始 options。
    //
    // ★ Task #5067 — reopen 反向收口需要「迁移**前**」的任务状态。
    //   为什么在这读（hook 之后、更新之前）：
    //     - 必须在 hook **之后** ⇒ hook 可能改写 status（要按改写后的判）
    //     - 必须在更新**之前** ⇒ 读到的是迁移前的真实状态
    //   为什么只在「非终态」时读：
    //     迁入终态的路径用不到前态（规则 1 直接命中），
    //     不给常规更新平白增加一次 DB 读。
    const requestedStatus = updateCtx.options.status;
    let previousTask: Task | undefined;
    if (requestedStatus && !isTerminalTaskStatus(requestedStatus)) {
      previousTask = await this.store.getTask(id);
    }

    const effectiveOptions = this.withTerminalCurrentStatus(
      updateCtx.options,
      previousTask,
    );
    const task = await this.store.updateTask(id, effectiveOptions);
    
    if (task) {
      // 3. afterUpdate Hook
      //    changes 保持「调用方原始请求」语义（同上）——
      //    AFTER_COMPLETE hook 的契约是 changes 镜像调用方的 status 变更
      //    （见 TaskUpdateResultContext / TaskCompleteResultContext 的注释）。
      const resultCtx: TaskUpdateResultContext = {
        task,
        changes: options,
        tagService: this.tagService,
      };
      await this.executeHook(TaskHookPoints.AFTER_UPDATE, resultCtx);
      
      // 4. 发布 task.updated 事件
      this.publishEvent(TaskEntityEventTypes.UPDATED, { task, changes: options, sessionId: "" }, "");
      
      logger.info(`[TaskComponent] Task updated: ${id}`);
      
      // 5. ★ Task #5073（设计调整②）— updateTask 路径**不再**触发
      //    AFTER_COMPLETE。
      //
      //    背景（38603 用户设计调整）：goal 检查（LayaCompletionPlugin
      //    decision model）从 task_complete 挪到 task_pre_complete ——
      //    AFTER_COMPLETE 现在承载「提交待验证（自查关）」语义，
      //    由 preCompleteTask 专门触发（见下）。
      //    completed / failed / cancelled / timeout 四态曾全部触发，
      //    但判定插件 run() 一直 guard `terminalStatus !== "completed"`
      //    skip，非 completed 的 fire 从来没有被消费过；
      //    卡片终态收尾走 AFTER_UPDATE 的 cardStatusOf（completed /
      //    cancelled / archived / failed 全覆盖），不依赖本钩子。
      //
      //    ⚠️ task_complete（验收落定）**不跑 goal 检查** ——
      //      判定在 pre_complete 已发生（sub-agent 自查），complete
      //      是验收方的最终状态落定动作。
    }
    return task;
  }
  
  /**
   * Delete task
   */
  async deleteTask(id: number): Promise<boolean> {
    // 1. beforeDelete Hook
    const deleteCtx: TaskDeleteContext = { id };
    await this.executeHook(TaskHookPoints.BEFORE_DELETE, deleteCtx);
    
    // 2. 实际删除
    const result = await this.store.deleteTask(id);
    
    // 3. afterDelete Hook
    const resultCtx: TaskDeleteResultContext = { id, deleted: result };
    await this.executeHook(TaskHookPoints.AFTER_DELETE, resultCtx);
    
    if (result) {
      // 4. 发布 task.deleted 事件
      this.publishEvent(TaskEntityEventTypes.DELETED, { taskId: id, sessionId: "" }, "");
      logger.info(`[TaskComponent] Task deleted: ${id}`);
    }
    return result;
  }
  
  /**
   * List tasks
   *
   * @returns `{ tasks, total }` where `total` is the count before pagination.
   */
  async listTasks(options?: ListTasksOptions): Promise<TaskListResult> {
    return this.store.listTasks(options);
  }

  /**
   * Search tasks by keywords
   *
   * Searches across title, description, goals, tags, and operation records.
   * Returns `{ tasks, total }` for pagination.
   */
  async searchTasksByKeywords(
    keywords: string[],
    options?: SearchTasksOptions
  ): Promise<TaskListResult> {
    return this.store.searchTasksByKeywords(keywords, options || {});
  }

  /**
   * Get task tree (subtree) starting from the given task
   *
   * @param taskId 起始任务 ID
   * @param depth 层级深度，-1 表示无限层级（默认）
   * @returns 所有后代任务的扁平列表（不含 taskId 本身）
   */
  async getTaskTree(taskId: number, depth: number = -1): Promise<Task[]> {
    return this.store.getTaskTree(taskId, depth);
  }

  /**
   * Get direct children of a task (one level)
   */
  async getChildTasks(
    taskId: number,
    options?: ListTasksOptions
  ): Promise<TaskListResult> {
    return this.store.getChildTasks(taskId, options);
  }
  
  /**
   * Complete task
   *
   * Task #2778: 新增 deliverableStoragePath 可选参数，调用方传入实际交付物寻址地址，
   * 会被持久化到 task.context.deliverable_storage_path。
   *
   * Task #2778 v2: 同时把 deliverable 写入 task_operation.milestoneDescription（双写），
   * 便于从 operation 列表直接看到交付物地址，无需查 context 字段。
   *
   * @param id 任务 ID
   * @param sessionId 当前 session ID
   * @param deliverableStoragePath 可选，交付物寻址地址（URL / 路径 / 分支名）
   * @returns 更新后的 Task 或 undefined
   */
  @TracedAs("task.component.completeTask", { recordParams: true, recordResult: true, log: true })
  async completeTask(
    id: number,
    sessionId: string,
    deliverableStoragePath?: string
  ): Promise<Task | undefined> {
    // Check that cycle-type tasks cannot be completed
    const existing = await this.store.getTask(id);
    if (existing && existing.type === "cycle") {
      throw new Error(`Cannot complete cycle task: #${id} - ${existing.title}. Cycle tasks are not meant to be completed.`);
    }

    // ★ Task #5073（DS review MAJOR-3）— 终态护栏：已终态任务
    //   **不可**被「验收通过」翻转成 completed。
    //
    //   落在 TaskComponent 层（不是 tool 层）—— completeTask 是
    //   tool（task_complete）与 CLI（`tasks complete`）的汇聚点。
    //   TaskStoreBackend（MCP 通道）是独立实现、不经 TaskComponent，
    //   它的 task_complete 工具实例自带 tool 层拦截（complete-tool）
    //   —— 即 MCP 靠 tool 层覆盖，backend 直连通道不在本护栏
    //   范围（DS review r4 MINOR-1/MINOR-2，留档）。
    //   - cancelled：已取消的事实不该被验收抹掉（要恢复走 reopen：
    //     task_update(status=active)）
    //   - archived：历史归档同样不可翻转成 completed
    //   规范路径 to_validate → completed 与兜底路径 active →
    //   completed（#5054 补验收）都放行 —— 只拦「对已终态任务
    //   二次验收」。
    if (
      existing &&
      (TERMINAL_NON_ACCEPTABLE_STATUSES as readonly string[]).includes(
        existing.status,
      )
    ) {
      throw new Error(
        `Cannot complete task: #${id} - ${existing.title}. ` +
          `It is already in terminal status "${existing.status}". ` +
          `Reopen it first via task_update(status="active") if acceptance should proceed.`,
      );
    }

    // ★ Task #2778: 如果提供了 deliverableStoragePath，先 merge 到 context。
    // 这样后续 updateTask 调用会通过 BEFORE_UPDATE / AFTER_UPDATE hooks 持久化新 context。
    // parse 安全：context 损坏时 fallback 到空对象，避免抛错中断完成流程。
    //
    // ★ Task #5060: **同时写 current_status** —— 终态任务不能留着「还没做完」的旧文案。
    // 原来 completeTask 只设 status/progress ⇒ current_status 停留在完成前的中间态描述，
    // 出现「status=completed / progress=100 / current_status=『决定暂停：未 commit』」
    // 的自相矛盾状态（用户 2026-11-05 实测）。修好后不再需要额外 task_update 补文案。
    const updateOptions: UpdateTaskOptions = {
      status: "completed",
      progress: 100,
      current_status: deliverableStoragePath
        ? `${TASK_COMPLETED_STATUS_WORD}（${TASK_DELIVERABLE_RECORDED}：${deliverableStoragePath}）`
        : TASK_COMPLETED_STATUS_WORD,
    };
    if (deliverableStoragePath) {
      let existingContext: Record<string, unknown> = {};
      if (existing?.context) {
        try {
          const parsed = JSON.parse(existing.context);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            existingContext = parsed as Record<string, unknown>;
          }
        } catch {
          // context 损坏时忽略，使用空对象（避免任务完成被中断）
          logger.warn(`[TaskComponent] Task #${id} context is not valid JSON, ignoring when merging deliverable`);
        }
      }
      existingContext.deliverable_storage_path = deliverableStoragePath;
      updateOptions.context = JSON.stringify(existingContext);
    }

    // 使用 updateTask 以触发 BEFORE_UPDATE 和 AFTER_UPDATE hooks
    // 这样 LarkCliTaskNotifyHook 等监听 task:after.update 的插件才能收到通知
    const task = await this.updateTask(id, updateOptions);

    if (task) {
      // 调用 this.createOperation 以触发 OPERATION_AFTER_CREATE hook
      // ★ Task #2778 v2: 双写 — deliverable 同时写入 operation.milestoneDescription
      // 这样 task_operation_list 可以直接看到交付物地址，不必回查 task.context。
      // 无 deliverable 时 milestoneDescription 留空（不要误写 "Deliverable: undefined"）。
      await this.createOperation({
        taskId: id,
        sessionId,
        milestoneType: "completed",
        milestoneTitle: "Task completed",
        milestoneDescription: formatDeliverableForOperation(deliverableStoragePath),
      });

      // 发布 task.completed 事件
      this.publishEvent(TaskEntityEventTypes.COMPLETED, { task, sessionId }, sessionId);

      logger.info(
        `[TaskComponent] Task completed: ${id}, deliverable=${deliverableStoragePath || "(none)"}`
      );
    }

    return task;
  }

  /**
   * 直接更新任务 context（不触发 BEFORE/AFTER_UPDATE hook、不发事件）
   *
   * ★ Task #4776 review MINOR-1：AFTER_COMPLETE hook 内的嵌套
   *   updateTask({context}) 会二次 fire AFTER_UPDATE，把订阅者
   *   （LarkCliTaskNotifyHook 等）无谓拉起 —— 终态任务被再次走
   *   cardStatusOf 终态路径。hint 回写这类「内部簿记」不应有通知副作用，
   *   因此提供本方法绕过 hook 链，直接走 store 层。
   *
   * 语义与 updateTask({context}) 完全一致：整份覆盖 context 字段。
   * 调用方负责自己 merge 既有字段（不要拿快照整份覆盖别人写的内容）。
   *
   * @param id 任务 ID
   * @param context 新的 context JSON 字符串（整份覆盖）
   * @returns 更新后的 Task，任务不存在时返回 undefined
   */
  async updateTaskContext(id: number, context: string): Promise<Task | undefined> {
    return this.store.updateTask(id, { context });
  }

  /**
   * ★ Task #5073 — 提交待验证（两阶段验收的第一阶段）
   *
   * 需求（用户 2026-11-06 飞书）：sub-agent 觉得可以完成了，
   * 传交付物等参数调 task_pre_complete → task 状态变为 to_validate；
   * default agent 调 task_complete 校验之后状态正式 completed。
   *
   * 语义要点：
   *   - to_validate **不是终态**：
   *     - 不加入 isTerminalTaskStatus（reopen 反向收口不管它）
   *     - 卡片（lark 插件）保持 running 更新态（cardStatusOf 不识别
   *       to_validate → 走 sendCardUpdate 普通 patch，不 unpin）
   *   - ★ 设计调整②（38603）：preCompleteTask 在 updateTask 后**显式
   *     fire 一次 AFTER_COMPLETE**（goal 检查自查关，terminalStatus=
   *     to_validate）；updateTask 本体已**不再**触发 AFTER_COMPLETE
   *     （见 updateTask 注释），本钩子的触发点唯一 = preCompleteTask。
   *   - current_status 同步（#5060 收口模式）：措辞同源锚点
   *     TASK_TO_VALIDATE_STATUS_WORD =「待验证」，调用方传了
   *     progressSummary 就带上（「待验证：<summary>」）
   *   - 交付物双写（#2778 v2 同模式）：context.deliverable_storage_path
   *     + operation 的 Deliverable 行
   *   - 幂等：重复提交安全（后一次覆盖前一次的 current_status /
   *     deliverable，operation 各自留痕）
   *
   * @param id 任务 ID
   * @param sessionId 当前 session ID
   * @param deliverableStoragePath 可选，交付物寻址地址
   * @param progressSummary 可选，本次交付的进展摘要（拼进 current_status）
   * @returns 更新后的 Task 或 undefined
   */
  @TracedAs("task.component.preCompleteTask", { recordParams: true, recordResult: true, log: true })
  async preCompleteTask(
    id: number,
    sessionId: string,
    deliverableStoragePath?: string,
    progressSummary?: string,
  ): Promise<Task | undefined> {
    // cycle 任务不能提交验收（与 completeTask 同规则：周期任务不收尾）
    const existing = await this.store.getTask(id);
    if (existing && existing.type === "cycle") {
      throw new Error(`Cannot pre-complete cycle task: #${id} - ${existing.title}. Cycle tasks are not meant to be completed or submitted for acceptance.`);
    }

    // current_status：措辞同源锚点（completion-copy.ts），带摘要时拼接。
    // ⚠️ 显式传 current_status 会命中 withTerminalCurrentStatus 规则 2
    //    「尊重调用方」—— 正确：这里的文案就是系统为 to_validate 态写的。
    const toValidateWording = progressSummary
      ? `${TASK_TO_VALIDATE_STATUS_WORD}：${progressSummary}`
      : TASK_TO_VALIDATE_STATUS_WORD;

    const updateOptions: UpdateTaskOptions = {
      status: "to_validate",
      current_status: toValidateWording,
    };

    // 交付物 merge 到 context（与 completeTask 的 #2778 解析安全同款）
    if (deliverableStoragePath) {
      let existingContext: Record<string, unknown> = {};
      if (existing?.context) {
        try {
          const parsed = JSON.parse(existing.context);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            existingContext = parsed as Record<string, unknown>;
          }
        } catch {
          // context 损坏时忽略，使用空对象（避免提交被中断）
          logger.warn(`[TaskComponent] Task #${id} context is not valid JSON, ignoring when merging deliverable`);
        }
      }
      existingContext.deliverable_storage_path = deliverableStoragePath;
      updateOptions.context = JSON.stringify(existingContext);
    }

    // 走 updateTask 触发 BEFORE_UPDATE / AFTER_UPDATE 钩子链
    // （LarkCliTaskNotifyHook 等监听 task:after.update 的插件收到通知；
    //   updateTask 已不再触发 AFTER_COMPLETE —— 见 updateTask 注释）
    const task = await this.updateTask(id, updateOptions);

    if (task) {
      // ★ Task #5073（设计调整②）— fire AFTER_COMPLETE（goal 检查自查关）
      //
      // 用户设计调整（38603）：decision model（LayaCompletionPlugin）
      // 从 task_complete 挪到 task_pre_complete —— sub-agent 提交待验证时
      // 先跑一次 goal 检查（自查关），验收方 task_complete 时不再重复跑。
      // AFTER_COMPLETE 语义随之收窄为「仅 completed」，
      // 这里**显式** fire 一次并携带 to_validate 终态信息：
      // 插件按 changes.status / task.status 自行分流
      // （to_validate = 自查关；completed = 验收完成）。
      const env = getEnvContextOrEmpty();
      const completeCtx: TaskCompleteResultContext = {
        task,
        changes: updateOptions,
        terminalStatus: "to_validate" as TaskCompleteResultContext["terminalStatus"],
        sessionId: (env as any).sessionId ?? sessionId,
        tagService: this.tagService,
      };
      await this.executeHook(TaskHookPoints.AFTER_COMPLETE, completeCtx);

      // operation 留痕（双写：Deliverable 行 + 待验证里程碑）
      // 无 deliverable 时 milestoneDescription 只留摘要（不写 "Deliverable: undefined"）
      const descParts: string[] = [];
      const deliverableLine = formatDeliverableForOperation(deliverableStoragePath);
      if (deliverableLine) descParts.push(deliverableLine);
      if (progressSummary) descParts.push(progressSummary);

      await this.createOperation({
        taskId: id,
        sessionId,
        milestoneType: "milestone",
        milestoneTitle: `${TASK_TO_VALIDATE_STATUS_WORD}（to_validate）：Task #${id} submitted for acceptance`,
        milestoneDescription: descParts.join(" / ") || TASK_TO_VALIDATE_STATUS_WORD,
      });

      logger.info(
        `[TaskComponent] Task submitted for acceptance (to_validate): ${id}, deliverable=${deliverableStoragePath || "(none)"}`
      );
    }

    return task;
  }

  // ========================================================================
  // Operation CRUD
  // ========================================================================
  
  /**
   * Create operation record
   */
  @TracedAs("task.component.createOperation", { recordParams: true, recordResult: true, log: true })
  async createOperation(options: CreateOperationOptions): Promise<TaskOperation> {
    // 1. beforeCreate Hook
    const createCtx: TaskOperationCreateContext = {
      options: { ...options },
    };
    await this.executeHook(TaskHookPoints.OPERATION_BEFORE_CREATE, createCtx);

    // 2. 实际创建
    const op = await this.store.createOperation(createCtx.options);

    // 3. afterCreate Hook
    // ★ 把 task 加载后通过 metadata 传给 hook，
    //   让 plugin（如 PerTaskGroupChatPlugin.onAfterOperationCreate）能从 task.context 读 chat_id。
    //   之前 metadata={}，导致 plugin 必须自行 loadTask，逻辑分散且容易 skip。
    const task = await this.store.getTask(op.taskId);
    const resultCtx: TaskOperationCreateResultContext = { operation: op };
    await this.executeHook(TaskHookPoints.OPERATION_AFTER_CREATE, resultCtx, { task, operation: op });
    
    // 4. 发布 task.operation_added 事件
    this.publishEvent(TaskEntityEventTypes.OPERATION_ADDED, { operation: op, taskId: op.taskId }, op.sessionId);
    
    logger.info(`[TaskComponent] Operation created: ${op.id} for task ${op.taskId}`);
    return op;
  }
  
  /**
   * Get operation by ID
   */
  async getOperation(id: number): Promise<TaskOperation | undefined> {
    return this.store.getOperation(id);
  }
  
  /**
   * Update operation
   */
  async updateOperation(id: number, updates: { milestoneTitle?: string; milestoneDescription?: string; processDescription?: string; actionTitle?: string; actionDescription?: string }): Promise<TaskOperation | undefined> {
    return this.store.updateOperation(id, updates);
  }
  
  /**
   * Delete operation
   */
  async deleteOperation(id: number): Promise<boolean> {
    return this.store.deleteOperation(id);
  }
  
  /**
   * List operations for a task
   */
  async listOperations(options: ListOperationsOptions): Promise<TaskOperation[]> {
    return this.store.listOperations(options);
  }

  /**
   * Task #5081 — 绕过 operationsCache 的直读（optional 能力探测）。
   *
   * store 实现 `listOperationsFresh` 时直打 DB；否则降级
   * `listOperations` + `invalidateOperationsCache`（若支持）。
   * 语义等价，保证跨进程写入的记录可见。
   */
  async listOperationsFresh(options: ListOperationsOptions): Promise<TaskOperation[]> {
    const store = this.store as {
      listOperationsFresh?: (o: ListOperationsOptions) => Promise<TaskOperation[]>;
      invalidateOperationsCache?: (taskId: number) => void;
    };
    if (typeof store.listOperationsFresh === "function") {
      return await store.listOperationsFresh(options);
    }
    if (typeof store.invalidateOperationsCache === "function") {
      store.invalidateOperationsCache(options.taskId);
    }
    return await this.store.listOperations(options);
  }

  // ========================================================================
  // Plugin Management
  // ========================================================================

  /**
   * 获取 TagService
   */
  getTagService(): TagService {
    return this.tagService;
  }

  /**
   * 注册 Hook（推荐方式）
   * 
   * 直接注册 Hook 到 globalHookManager，无需通过 TaskPlugin
   * 
   * @param hookPoint Hook 点（如 "task:after.create"）
   * @param hook Hook 对象
   * 
   * @example
   * ```typescript
   * // 直接注册 Hook
   * taskComponent.registerHook("task:after.create", {
   *   name: "my-notify",
   *   priority: 5,
   *   pluginName: "my-notify",    // 用于 pluginEnabled 检查
   *   sourceId: "lark-cli",       // 用于 pluginEnabled 检查
   *   execute: async (ctx) => {
   *     const env = getEnvContextOrEmpty();
   *     // ...
   *   },
   * });
   * ```
   */
  registerHook(hookPoint: string, hook: Hook): void {
    globalHookManager.register(hookPoint, hook);
    this.plugins.set(this.makePluginKey(hookPoint, hook.name), hook);
    logger.debug(`[TaskComponent] Registered hook: ${hook.name} at ${hookPoint}`);
  }

  /**
   * 注册多个 Hook
   */
  registerHooks(hooks: Array<{ hookPoint: string; hook: Hook }>): void {
    for (const { hookPoint, hook } of hooks) {
      this.registerHook(hookPoint, hook);
    }
  }

  /**
   * 注销 Hook（通过 name）
   */
  unregisterHook(hookPoint: string, hookName: string): boolean {
    const removed = globalHookManager.unregister(hookPoint, hookName);
    if (removed) {
      this.plugins.delete(this.makePluginKey(hookPoint, hookName));
      logger.info(`[TaskComponent] Unregistered hook: ${hookName} from ${hookPoint}`);
    }
    return removed;
  }

  /**
   * 获取所有注册的 Hook
   */
  listHooks(): Hook[] {
    return Array.from(this.plugins.values());
  }

  /**
   * 同一个 hook.name 可能挂在不同 hookPoint，复合 key 避免相互覆盖
   */
  private makePluginKey(hookPoint: string, hookName: string): string {
    return `${hookPoint}::${hookName}`;
  }

  /**
   * 获取指定 hook 点的 Hook 数量
   */
  countHooks(hookPoint: string): number {
    return globalHookManager.count(hookPoint);
  }
}
