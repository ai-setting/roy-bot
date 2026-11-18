/**
 * @fileoverview MemoryManager V3 - Simplified
 * 
 * 后台异步任务队列处理
 * 
 * 简化设计：
 * - 移除 DraftManager（草稿管理已废弃）
 * - 移除 MemoryOrganizer（整理机制已废弃）
 * - 移除 AccessLog（访问日志已废弃）
 * - 只保留核心的任务队列处理
 */

import type { MemoryTask, ExtractMemoryPayload } from "./types";
import { createLogger } from "../../log-trace/logger";

const logger = createLogger("MemoryManagerV3");

/**
 * MemoryManager 配置
 */
export interface MemoryManagerConfig {
  /** 回调：当需要提取记忆时调用 */
  onExtractMemory?: (payload: ExtractMemoryPayload) => Promise<void>;
}

/**
 * 生成唯一任务 ID
 */
function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * MemoryManager V3 - Simplified
 * 
 * 简化的后台异步内存处理，只负责任务队列
 */
export class MemoryManager {
  /** 队列最大容量，防止内存溢出 */
  private static readonly MAX_QUEUE_SIZE = 100;

  private queue: MemoryTask[] = [];
  private processing: boolean = false;
  private shuttingDown: boolean = false;
  private config: MemoryManagerConfig;
  private processingPromise: Promise<void> | null = null;
  private resolveProcessing: (() => void) | null = null;

  constructor(config: MemoryManagerConfig = {}) {
    this.config = config;
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<MemoryManagerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 入队（非阻塞）
   */
  enqueue(task: Omit<MemoryTask, "id">): void {
    if (this.shuttingDown) {
      logger.debug("MemoryManager is shutting down, ignoring new task");
      return;
    }

    const fullTask: MemoryTask = {
      ...task,
      id: generateTaskId(),
    };

    // 队列大小限制，防止内存溢出
    if (this.queue.length >= MemoryManager.MAX_QUEUE_SIZE) {
      const dropped = this.queue.shift();
      logger.warn(`Queue full (${MemoryManager.MAX_QUEUE_SIZE}), dropping oldest task: ${dropped?.id}`);
    }

    this.queue.push(fullTask);
    logger.debug(`Task enqueued: ${task.type}, queue size: ${this.queue.length}`);

    // 如果没有正在处理，启动处理循环
    if (!this.processing) {
      this.startProcessingLoop();
    }
  }

  /**
   * 启动处理循环
   */
  private startProcessingLoop(): void {
    const runLoop = async (): Promise<void> => {
      while (this.queue.length > 0 && !this.shuttingDown) {
        const task = this.queue.shift()!;
        try {
          await this.processTask(task);
        } catch (error) {
          logger.error(`Task ${task.id} failed:`, error);
        }
      }
      // 处理完成
      this.processing = false;
      if (this.resolveProcessing) {
        this.resolveProcessing();
        this.resolveProcessing = null;
        this.processingPromise = null;
      }
    };

    this.processing = true;
    this.processingPromise = new Promise((resolve) => {
      this.resolveProcessing = resolve;
    });

    setImmediate(() => {
      runLoop().catch((error) => {
        logger.error("Processing loop error:", error);
        this.processing = false;
      });
    });
  }

  /**
   * 检查是否有待处理任务
   */
  hasPendingTasks(): boolean {
    return this.queue.length > 0 || this.processing;
  }

  /**
   * 等待处理完成
   */
  async waitForCompletion(): Promise<void> {
    // 如果队列为空且没有正在处理，快速路径
    if (this.queue.length === 0 && !this.processing) {
      return;
    }

    // 如果有待处理的 Promise，等待它
    if (this.processingPromise) {
      await this.processingPromise;
    }
  }

  /**
   * 准备关闭
   */
  prepareShutdown(): void {
    this.shuttingDown = true;
    logger.info("MemoryManager preparing for shutdown");
  }

  /**
   * 释放资源
   */
  async dispose(): Promise<void> {
    // 等待当前任务完成
    await this.waitForCompletion();

    // 清空队列
    this.queue = [];

    logger.info("MemoryManager disposed");
  }

  /**
   * 处理单个任务
   */
  private async processTask(task: MemoryTask): Promise<void> {
    logger.debug(`Processing task: ${task.type}`);

    switch (task.type) {
      case "extract_memory":
        await this.handleExtractMemory(task.payload as ExtractMemoryPayload);
        break;
      default:
        logger.warn(`Unknown task type: ${task.type}`);
    }
  }

  /**
   * 处理记忆提取
   */
  private async handleExtractMemory(payload: ExtractMemoryPayload): Promise<void> {
    const messageCount = payload.messages?.length || 0;
    logger.info(`Extracting memory from ${messageCount} messages`);

    // 调用回调
    if (this.config.onExtractMemory) {
      try {
        await this.config.onExtractMemory(payload);
      } catch (error) {
        logger.error("Memory extraction failed", { error });
      }
    }
  }
}
