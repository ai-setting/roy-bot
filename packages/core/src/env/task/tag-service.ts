/**
 * @fileoverview TagService - Tag 池管理服务
 * 
 * 提供 Tag 的 CRUD、Tag 与 Task 关联、类似任务检索能力
 * 
 * 设计原则：
 * - Tag 池模式：新 Tag 从池中选取，无合适则新增
 * - 混合存储：Task.tags JSON 快速读取 + Tag 表高效检索
 */

import type { Task, TaskTag } from "./types";
import type { TaskStore } from "./storage/sqlite-task-store";
import { createLogger } from "../log-trace/logger";

const logger = createLogger("task:tag");

// ========================================================================
// TagService 接口
// ========================================================================

export interface ListTagsOptions {
  limit?: number;
  offset?: number;
  orderBy?: "count" | "name" | "created_at";
}

export interface SearchTagsOptions {
  query: string;
  limit?: number;
}

export interface TagService {
  // ========== Tag CRUD ==========
  
  /**
   * 创建 Tag（如果已存在则返回现有 Tag）
   */
  createTag(name: string): Promise<TaskTag>;
  
  /**
   * 获取 Tag by ID
   */
  getTag(id: number): Promise<TaskTag | undefined>;
  
  /**
   * 获取 Tag by Name
   */
  getTagByName(name: string): Promise<TaskTag | undefined>;
  
  /**
   * 列出所有 Tag
   */
  listTags(options?: ListTagsOptions): Promise<TaskTag[]>;
  
  /**
   * 搜索 Tag（模糊匹配）
   */
  searchTags(options: SearchTagsOptions): Promise<TaskTag[]>;
  
  /**
   * 删除 Tag（同时删除所有关联）
   */
  deleteTag(id: number): Promise<boolean>;
  
  // ========== Tag 与 Task 关联 ==========
  
  /**
   * 给 Task 添加 Tags
   */
  addTagsToTask(taskId: number, tagIds: number[]): Promise<void>;
  
  /**
   * 从 Task 移除 Tags
   */
  removeTagsFromTask(taskId: number, tagIds: number[]): Promise<void>;
  
  /**
   * 获取 Task 的所有 Tags
   */
  getTagsForTask(taskId: number): Promise<TaskTag[]>;
  
  /**
   * 根据 Tag 名称获取关联的 Task IDs
   */
  getTaskIdsByTags(tagNames: string[]): Promise<number[]>;
  
  // ========== 检索能力（核心改造）==========
  
  /**
   * 根据关键词列表搜索 Task（检索 tags、description、goals、operations）
   * 这是新的核心检索方法
   */
  searchTasksByKeywords(keywords: string[], options?: { limit?: number; excludeTaskId?: number }): Promise<Task[]>;
  
  /**
   * 根据关键词查找类似 Task（排除自身，按相关性排序）
   * 这是新的核心检索方法
   */
  findSimilarTasksByKeywords(keywords: string[], options?: { limit?: number; excludeTaskId?: number }): Promise<Task[]>;
  
  // ========== 同步（混合方案 - 保留用于兼容）==========
  
  /**
   * 同步 Tags 到 Task（根据 tag 名称列表）
   * - 查找或创建 Tag
   * - 更新关联关系
   * - 更新 task.tags JSON 字段
   */
  syncTagsToTask(taskId: number, tagNames: string[]): Promise<void>;
  
  // ========== 以下为保留的兼容方法 ==========
  
  /**
   * 查找类似 Task（基于 Tag 匹配度）- 原始实现，保留兼容
   * @deprecated 使用 findSimilarTasksByKeywords 代替
   */
  findSimilarTasks(taskId: number, limit?: number): Promise<Task[]>;
  
  /**
   * 根据关键词搜索 Task（标题 + 描述）- 原始实现，保留兼容
   * @deprecated 使用 searchTasksByKeywords 代替
   */
  searchTasks(query: string, limit?: number): Promise<Task[]>;
}

// ========================================================================
// TagService 实现
// ========================================================================

/**
 * TagService 实现
 */
export class DefaultTagService implements TagService {
  constructor(private store: TaskStore) {}
  
  // ========== Tag CRUD ==========
  
  async createTag(name: string): Promise<TaskTag> {
    const tag = await this.store.createTag(name);
    logger.debug(`[TagService] Created tag: ${tag.name} (id=${tag.id})`);
    return tag;
  }
  
  async getTag(id: number): Promise<TaskTag | undefined> {
    return this.store.getTag(id);
  }
  
  async getTagByName(name: string): Promise<TaskTag | undefined> {
    return this.store.getTagByName(name);
  }
  
  async listTags(options?: ListTagsOptions): Promise<TaskTag[]> {
    return this.store.listTags(options);
  }
  
  async searchTags(options: SearchTagsOptions): Promise<TaskTag[]> {
    return this.store.searchTags(options);
  }
  
  async deleteTag(id: number): Promise<boolean> {
    const result = await this.store.deleteTag(id);
    if (result) {
      logger.debug(`[TagService] Deleted tag id=${id}`);
    }
    return result;
  }
  
  // ========== Tag 与 Task 关联 ==========
  
  async addTagsToTask(taskId: number, tagIds: number[]): Promise<void> {
    await this.store.addTagsToTask(taskId, tagIds);
    logger.debug(`[TagService] Added ${tagIds.length} tags to task ${taskId}`);
  }
  
  async removeTagsFromTask(taskId: number, tagIds: number[]): Promise<void> {
    await this.store.removeTagsFromTask(taskId, tagIds);
    logger.debug(`[TagService] Removed ${tagIds.length} tags from task ${taskId}`);
  }
  
  async getTagsForTask(taskId: number): Promise<TaskTag[]> {
    return this.store.getTagsForTask(taskId);
  }
  
  async getTaskIdsByTags(tagNames: string[]): Promise<number[]> {
    return this.store.getTaskIdsByTags(tagNames);
  }
  
  // ========== 检索能力（核心改造）==========
  
  /**
   * 根据关键词列表搜索 Task
   * @deprecated 使用 findSimilarTasksByKeywords 代替
   */
  async findSimilarTasks(taskId: number, limit: number = 5): Promise<Task[]> {
    return this.store.findSimilarTasks(taskId, limit);
  }
  
  /**
   * 根据关键词搜索 Task（单字符串）- 原始实现
   * @deprecated 使用 searchTasksByKeywords 代替
   */
  async searchTasks(query: string, limit: number = 20): Promise<Task[]> {
    return this.store.searchTasks(query, limit);
  }
  
  /**
   * 根据关键词列表搜索 Task
   * 检索范围：tags、description、goals、operations
   */
  async searchTasksByKeywords(
    keywords: string[],
    options?: { limit?: number; excludeTaskId?: number }
  ): Promise<Task[]> {
    const result = await this.store.searchTasksByKeywords(keywords, options);
    return result.tasks;
  }
  
  /**
   * 根据关键词查找类似 Task
   */
  async findSimilarTasksByKeywords(
    keywords: string[],
    options?: { limit?: number; excludeTaskId?: number }
  ): Promise<Task[]> {
    return this.store.findSimilarTasksByKeywords(keywords, options);
  }
  
  // ========== 同步 ==========
  
  async syncTagsToTask(taskId: number, tagNames: string[]): Promise<void> {
    // 1. 查找或创建每个 Tag
    const tagIds: number[] = [];
    for (const name of tagNames) {
      let tag = await this.store.getTagByName(name);
      if (!tag) {
        tag = await this.store.createTag(name);
      }
      tagIds.push(tag.id);
    }
    
    // 2. 获取当前 Task 的所有 Tags
    const currentTags = await this.store.getTagsForTask(taskId);
    const currentTagIds = new Set(currentTags.map(t => t.id));
    const newTagIds = new Set(tagIds);
    
    // 3. 计算需要添加和移除的 Tags
    const toAdd = tagIds.filter(id => !currentTagIds.has(id));
    const toRemove = currentTags
      .filter(t => !newTagIds.has(t.id))
      .map(t => t.id);
    
    // 4. 执行同步
    if (toRemove.length > 0) {
      await this.store.removeTagsFromTask(taskId, toRemove);
    }
    if (toAdd.length > 0) {
      await this.store.addTagsToTask(taskId, toAdd);
    }
    
    // 5. 更新 Task.tags JSON 字段
    await this.store.updateTaskTags(taskId, tagNames);
    
    logger.info(`[TagService] Synced tags for task ${taskId}: ${tagNames.join(", ")}`);
  }
}
