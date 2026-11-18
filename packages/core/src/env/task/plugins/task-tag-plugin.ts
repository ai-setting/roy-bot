/**
 * @fileoverview TaskTagPlugin - 类似任务信息注入
 * 
 * 统一插件架构下的 TaskTagPlugin 实现
 * 
 * Hook 逻辑实现：
 * - delegateBefore: 注入类似任务信息（使用 keywords 检索，最多 5 个）
 * - operationAfterCreate: 任务完成时提取 Workflow
 * 
 * 改造说明：
 * - 继承 BasePlugin，实现统一插件接口
 * - 通过 PluginEnv.init() 获取依赖组件
 * - 使用 PluginEnv.registerHook() 注册 hooks
 */

import { BasePlugin, type PluginEnv, type HookContext } from "../../plugin/types";
import { TaskHookPoints } from "../hooks";
import type { 
  TaskDelegateContext,
  TaskOperationCreateResultContext 
} from "../hooks/contexts";
import { createLogger } from "../../log-trace/logger";
import {
  formatExtractorInput,
  parseExtractorOutput,
} from "./workflow-extractor-agent";
import { validateWorkflowDefinition } from "../../workflow/utils/validate-workflow-definition";
import type { Task, TaskOperation } from "../types";

const logger = createLogger("plugin:task-tag");

// ========================================================================
// 接口定义
// ========================================================================

interface TaskComponentLike {
  getTask(id: number): Promise<Task | undefined>;
  listOperations(options: { taskId: number; limit?: number }): Promise<TaskOperation[]>;
  createOperation(options: any): Promise<any>;
  getTagService?(): TagServiceLike | null;
}

interface TagServiceLike {
  findSimilarTasksByKeywords(keywords: string[], options?: { limit?: number; excludeTaskId?: number }): Promise<Task[]>;
}

// ========================================================================
// TaskTagPlugin
// ========================================================================

export class TaskTagPlugin extends BasePlugin {
  readonly name = "task-tag";
  readonly version = "1.0.0";
  readonly description = "Inject similar task information into delegate prompt and extract workflow on task completion";

  /** Plugin Env（init 时设置） */
  private env!: PluginEnv;

  /** TaskComponent 引用 */
  private taskComponent: TaskComponentLike | null = null;

  /** AgentComponent 引用 */
  private agentComponent: any = null;

  /** TagService 引用 */
  private tagService: TagServiceLike | null = null;

  constructor() {
    super();
  }

  /**
   * 初始化
   */
  init(env: PluginEnv): void {
    this.env = env;

    // 获取 TaskComponent
    this.taskComponent = env.getComponent("task") as TaskComponentLike | null;
    if (this.taskComponent && typeof this.taskComponent.getTagService === "function") {
      this.tagService = this.taskComponent.getTagService() as TagServiceLike;
    }

    // 获取 AgentComponent
    this.agentComponent = env.getComponent("agent");

    // 注册 delegateBefore Hook
    env.registerHook({
      point: TaskHookPoints.DELEGATE_BEFORE,
      priority: 20,
      handler: this.onDelegateBefore.bind(this),
    });

    // 注册 operationAfterCreate Hook
    env.registerHook({
      point: TaskHookPoints.OPERATION_AFTER_CREATE,
      priority: 10,
      handler: this.onOperationAfterCreate.bind(this),
    });

    // workflow-extract 是内置 agent，由 AgentComponent.initialize() 通过
    // AgentRegistry.registerWorkflowExtractAgent() 自动注册
    // 此处无需动态注册

    logger.info("[TaskTagPlugin] Initialized");
  }

  /**
   * 销毁
   */
  dispose(): void {
    this.env = null as any;
    this.taskComponent = null;
    this.agentComponent = null;
    this.tagService = null;
    logger.info("[TaskTagPlugin] Disposed");
  }

  // ========================================================================
  // delegateBefore: 注入类似任务信息（简洁版）
  // ========================================================================

  /**
   * 委派前：注入类似任务信息
   */
  private async onDelegateBefore(ctx: HookContext): Promise<void> {
    const data = ctx.data as TaskDelegateContext;
    const { taskId, prompt } = data;

    if (!taskId || !this.taskComponent) {
      return;
    }

    try {
      // 1. 获取当前 task
      const currentTask = await this.taskComponent.getTask(taskId);
      if (!currentTask) return;

      // 2. 提取关键词
      const keywords = this.extractKeywords(currentTask);
      if (keywords.length === 0) return;

      // 3. 检索类似任务（最多 5 个）
      //
      // ★ CV round 2 MINOR-1：tagService 必须在**调用时**现取，不能用 init()
      // 缓存的引用。task.storage.type / endpoint 热更新时 TaskComponent 会换
      // store 并重绑 tagService，缓存的旧引用会继续打旧库（切到 remote 后仍
      // 读本地 sqlite）。与 delegate-tool.ts 的 `getTagService()` 写法对齐。
      const tagService =
        (this.taskComponent && typeof this.taskComponent.getTagService === "function"
          ? (this.taskComponent.getTagService() as TagServiceLike)
          : undefined) ?? this.tagService;

      const similarTasks = await tagService?.findSimilarTasksByKeywords?.(keywords, {
        limit: 5,
        excludeTaskId: taskId,
      }) ?? [];

      if (similarTasks.length === 0) return;

      // 4. 构建提示
      const hint = this.formatSimilarTasks(similarTasks);

      // 5. 修改 prompt - 类似任务在前，用户指令在后
      data.prompt = `${hint}

---

## 用户指令

${prompt}`;

      logger.info(`[TaskTagPlugin] Injected ${similarTasks.length} similar tasks`);
    } catch (error) {
      logger.warn(`[TaskTagPlugin] Similar tasks injection failed: ${error}`);
    }
  }

  /**
   * 从 task 提取关键词
   */
  private extractKeywords(task: Task): string[] {
    const keywords: string[] = [];

    // 添加 tags
    if (task.tags?.length) {
      keywords.push(...task.tags);
    }

    // 从 title 提取有意义的词
    if (task.title) {
      const words = task.title
        .split(/[\s\-_,，。、#]+/)
        .filter(w => w.length > 2 && !/^\d+$/.test(w))
        .slice(0, 5);
      keywords.push(...words);
    }

    return keywords;
  }

  /**
   * 格式化类似任务（简洁版）
   */
  private formatSimilarTasks(tasks: Task[]): string {
    const lines = [
      "## 🔍 类似任务参考",
      "",
      "_提示：可通过 `task_get <id>` 获取详情，`task_operation_list <id>` 获取操作记录_",
      "",
    ];

    for (const task of tasks) {
      lines.push(`### Task #${task.id}`);
      lines.push(`**Title**: ${task.title}`);

      if (task.description) {
        const desc = task.description.slice(0, 100);
        lines.push(`**Description**: ${desc}${task.description.length > 100 ? "..." : ""}`);
      }

      if (task.goals_and_expected_deliverables) {
        const goal = task.goals_and_expected_deliverables.slice(0, 100);
        lines.push(`**Goal**: ${goal}${task.goals_and_expected_deliverables.length > 100 ? "..." : ""}`);
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  // ========================================================================
  // operationAfterCreate: 任务完成时提取 Workflow
  // ========================================================================

  private async onOperationAfterCreate(ctx: HookContext): Promise<void> {
    const data = ctx.data as TaskOperationCreateResultContext;
    const operation = (data as any)?.operation ?? (data as any)?.data?.operation;

    if (!operation || operation?.actionType !== "completed") return;

    await this.extractWorkflow(operation.taskId, operation.sessionId);
  }

  /**
   * 提取工作流（公开方法，用于测试）
   */
  async extractWorkflow(taskId: number, sessionId?: string): Promise<void> {
    try {
      const task = await this.taskComponent?.getTask(taskId);
      if (!task) return;

      const operations = await this.taskComponent?.listOperations({ taskId }) ?? [];
      const allSessionIds = [...new Set([sessionId, ...operations.map((op: any) => op.sessionId).filter(Boolean)])];

      const sessionComponent = this.env.getComponent("session") as any;
      const allMessages: any[] = [];

      for (const sid of allSessionIds) {
        try {
          const ctx = await sessionComponent?.getContext(sid, { fullHistory: false, minUserMessages: 200 });
          if (ctx?.messages) allMessages.push(...ctx.messages);
        } catch { /* skip */ }
      }

      if (!this.agentComponent) return;

      const input = formatExtractorInput({ task, operations, messages: allMessages });
      const result = await this.agentComponent.run("workflow-extract", input);
      const workflowDef = await parseExtractorOutput(result.finalText || "");

      if (!workflowDef) return;

      // Phase 2 (Task #1511): Validate the extracted workflow before adding.
      // Prevents invalid workflows (duplicate node IDs, missing deps, cycles)
      // from polluting the database.
      // Note: The 'workflow-extract' agent is expected to validate before output,
      // but we add this defense-in-depth check to handle edge cases.
      const validation = this.validateWorkflowDefinition(workflowDef);
      if (!validation.valid) {
        logger.warn(
          `[TaskTagPlugin] Skipping workflow creation due to validation failure: ` +
          `${validation.errors.join("; ")}`
        );
        // Record a failure operation so users can see what went wrong
        await this.taskComponent?.createOperation({
          taskId,
          sessionId,
          actionType: "workflow_extraction_failed",
          actionTitle: `Workflow extraction failed validation: ${workflowDef.name}`,
          actionDescription: validation.errors.join("; "),
        });
        return;
      }

      const workflowRepo = await this.getWorkflowRepository();
      if (!workflowRepo) return;

      let version = workflowDef.version || "1.0";
      const existingWf = workflowRepo.getByName(workflowDef.name);
      if (existingWf) {
        const parts = existingWf.version?.split(".") ?? ["1", "0"];
        version = `${parts[0]}.${parseInt(parts[1] || "0") + 1}`;
      }

      const workflow = workflowRepo.create({
        name: workflowDef.name,
        version,
        description: workflowDef.description,
        definition: workflowDef,
        config: workflowDef.config || {},
        metadata: { author: "workflow-extract", created_at: new Date().toISOString() },
        tags: [`task:${taskId}`],
      });

      await this.taskComponent?.createOperation({
        taskId,
        sessionId,
        actionType: "workflow_extracted",
        actionTitle: `Workflow extracted: ${workflow.name}`,
        actionDescription: workflow.id,
      });

      logger.info(`[TaskTagPlugin] Workflow extracted: ${workflow.id}`);
    } catch (error) {
      logger.warn(`[TaskTagPlugin] Workflow extraction failed: ${error}`);
    }
  }

  /**
   * Validate a workflow definition (defense-in-depth check before add).
   *
   * Delegates to the shared validateWorkflowDefinition helper which wraps
   * DAGManager.validate() and is the single source of truth across all
   * workflow entry points (tool, CLI, plugin).
   *
   * Note: The 'workflow-extract' agent should have validated already via
   * workflow_validate tool, but we add this check here as a safety net.
   *
   * @returns { valid: boolean, errors: string[] }
   */
  private validateWorkflowDefinition(workflowDef: any): { valid: boolean; errors: string[] } {
    return validateWorkflowDefinition(workflowDef);
  }

  private _workflowRepo: any = null;

  private async getWorkflowRepository(): Promise<any> {
    const workflowComponent = this.env.getComponent("workflow") as any;
    if (workflowComponent?.workflowService?.workflowRepository) {
      return workflowComponent.workflowService.workflowRepository;
    }

    if (!this._workflowRepo) {
      try {
        const sqlite = await import("../../workflow/storage/sqlite");
        this.ensureDataDir();
        const db = sqlite.getDatabase();
        sqlite.initializeTables();
        const { WorkflowRepository } = await import("../../workflow/storage/workflow-repo");
        this._workflowRepo = new WorkflowRepository(db);
        return this._workflowRepo;
      } catch {
        return null;
      }
    }
    return this._workflowRepo;
  }

  private ensureDataDir(): void {
    const { join } = require("path");
    const dataDir = join(process.env.XDG_DATA_HOME || join(process.env.HOME || "", ".local/share"), "roy-bot");
    require("fs").mkdirSync(dataDir, { recursive: true });
  }
}
