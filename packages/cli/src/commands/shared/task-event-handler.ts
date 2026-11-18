/**
 * @fileoverview Task Event Handler
 *
 * 订阅 task.* 事件并通过 logger 输出
 *
 * v1.7.17 (Task #2953): moved to `console.error` (stderr) to avoid leaking
 * into the act stdout stream captured by plugin chat panels.
 *
 * v1.7.18 (Task #2959): user feedback — even stderr is "polluting"
 * because plugin subprocesses don't necessarily isolate streams cleanly.
 * Switched to `logger.info` so the messages route to the log file via
 * the unified logger, NOT to stdout or stderr. Under quiet mode
 * (default in `roy-bot act`), `logger.info` is silent on console;
 * under `--no-quiet`, it goes to console but only on demand.
 *
 * Diagnostic lifecycle markers and task.* event notifications — NOT
 * user-facing content. Putting them on stdout caused the task-show
 * chat plugin (which spawns `roy-bot act` as a subprocess and
 * captures stdout) to leak them into every Assistant message. The
 * logger path routes them to the file (and to console only when
 * --no-quiet), so subprocess stdout parsers see nothing.
 *
 * 注意：使用 logger.info 而非 console.log / console.error。quiet 模式
 * 默认开，logger.info 只写文件不输出 console；--no-quiet 时输出 console
 * 但用户主动开启。这是干净的调试日志路径。
 */

import { createLogger } from "@ai-setting/roy-bot-core";
import type { BaseEnvironment, EnvEvent } from "@ai-setting/roy-bot-core";

const logger = createLogger("task-event-handler");

// Task Entity Event Types
const TASK_EVENTS = {
  CREATED: "task.created",
  UPDATED: "task.updated",
  COMPLETED: "task.completed",
  DELETED: "task.deleted",
  OPERATION_ADDED: "task.operation_added",
  DELEGATED: "task.delegated",
} as const;

/**
 * TaskEventHandler 配置选项
 */
export interface TaskEventHandlerOptions {
  /** 环境实例 */
  env: BaseEnvironment;
  /** 是否启用（默认 true） */
  enabled?: boolean;
}

/**
 * Task Event Handler
 *
 * 订阅 task.* 事件，通过 logger 输出（默认走文件，不污染 stdout/stderr）
 *
 * 事件类型：
 * - task.created - 任务创建
 * - task.updated - 任务更新
 * - task.completed - 任务完成
 * - task.deleted - 任务删除
 * - task.operation_added - 操作记录添加
 * - task.delegated - 任务被委托
 */
export class TaskEventHandler {
  private env: BaseEnvironment;
  private enabled: boolean;
  private unsubscribe: (() => void) | null = null;

  constructor(options: TaskEventHandlerOptions) {
    this.env = options.env;
    this.enabled = options.enabled ?? true;
  }

  /**
   * 启动事件订阅
   * @returns 取消订阅函数
   */
  start(): () => void {
    if (!this.enabled) {
      return () => {};
    }

    // 订阅所有 task.* 事件
    this.unsubscribe = this.env.subscribeAll((event: EnvEvent) => {
      if (event.type.startsWith("task.")) {
        this.handleEvent(event);
      }
    });

    logger.info("[TaskEventHandler] Started");
    return () => this.stop();
  }

  /**
   * 停止事件订阅
   */
  stop(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
      logger.info("[TaskEventHandler] Stopped");
    }
  }

  /**
   * 处理事件
   */
  private handleEvent(event: EnvEvent): void {
    const payload = event.payload as any;

    switch (event.type) {
      case TASK_EVENTS.CREATED:
        this.logTaskCreated(payload);
        break;
      case TASK_EVENTS.UPDATED:
        this.logTaskUpdated(payload);
        break;
      case TASK_EVENTS.COMPLETED:
        this.logTaskCompleted(payload);
        break;
      case TASK_EVENTS.DELETED:
        this.logTaskDeleted(payload);
        break;
      case TASK_EVENTS.OPERATION_ADDED:
        this.logOperationAdded(payload);
        break;
      case TASK_EVENTS.DELEGATED:
        this.logTaskDelegated(payload);
        break;
      default:
        // 未知事件类型，打印基本信息
        logger.info(`[${event.type}]`, payload);
    }
  }

  private logTaskCreated(payload: any): void {
    const task = payload.task;
    logger.info(`📝 Task created: #${task.id} - ${task.title}`);
    logger.info(`   Status: ${task.status}, Priority: ${task.priority}, Type: ${task.type || 'normal'}`);
    if (task.project_path) {
      logger.info(`   Project: ${task.project_path}`);
    }
    if (task.context) {
      logger.info(`   Context: ${task.context}`);
    }
  }

  private logTaskUpdated(payload: any): void {
    const task = payload.task;
    const changes = payload.changes;
    logger.info(`✏️  Task updated: #${task.id} - ${task.title}`);
    logger.info(`   Status: ${task.status}, Priority: ${task.priority}, Type: ${task.type || 'normal'}, Progress: ${task.progress}%`);
    if (changes) {
      logger.info(`   Changes: ${JSON.stringify(changes)}`);
    }
  }

  private logTaskCompleted(payload: any): void {
    const task = payload.task;
    logger.info(`✅ Task completed: #${task.id} - ${task.title}`);
    logger.info(`   Progress: ${task.progress}%, Updated: ${task.updatedAt}`);
  }

  private logTaskDeleted(payload: any): void {
    logger.info(`🗑️  Task deleted: #${payload.taskId}`);
  }

  private logOperationAdded(payload: any): void {
    const op = payload.operation;
    logger.info(`📋 Operation added to task #${payload.taskId}:`);
    logger.info(`   [${op.milestoneType}] ${op.milestoneTitle}`);
    logger.info(`   Session: ${op.sessionId}`);
  }

  private logTaskDelegated(payload: any): void {
    logger.info(`🚀 Task delegated: #${payload.taskId}`);
    logger.info(`   Background: ${payload.backgroundTaskId}, Type: ${payload.subagentType}`);
    logger.info(`   ${payload.description}`);
  }
}