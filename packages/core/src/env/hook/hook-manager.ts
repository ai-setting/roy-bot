/**
 * @fileoverview Hook Manager - 统一管理 Component 的 Hook
 * 
 * 提供：
 * - Hook 注册和管理
 * - 按优先级排序执行
 * - 错误隔离
 * - 动态添加/移除
 * - 干预机制（executeWithIntervention）
 */

import type { Hook, HookContext, HookPhase, HookResult } from "./types";

// EnvContext - 用于在线程中获取事件上下文
import { getEnvContext } from "../context";

/**
 * HookManager 配置
 */
export interface HookManagerOptions {
  /** 组件名称（用于上下文） */
  componentName?: string;
  /** 组件版本（用于上下文） */
  componentVersion?: string;
  /** 默认优先级 */
  defaultPriority?: number;
}

/**
 * HookManager
 * 
 * 统一管理 Component 的 Hook
 * 
 * @example
 * ```typescript
 * const manager = new HookManager<MyContext>();
 * 
 * // 注册 Hook
 * manager.register("before-action", {
 *   name: "my-hook",
 *   priority: 10,
 *   execute: async (ctx) => { /* ... *\/ }
 * });
 * 
 * // 执行 Hooks
 * await manager.execute("before-action", data);
 * ```
 */
export class HookManager<T = unknown> {
  private _hooks: Map<string, Hook<T>[]> = new Map();
  private componentName: string;
  private componentVersion: string;
  private defaultPriority: number;

  constructor(options: HookManagerOptions = {}) {
    this.componentName = options.componentName ?? "unknown";
    this.componentVersion = options.componentVersion ?? "0.0.0";
    this.defaultPriority = options.defaultPriority ?? 0;
  }

  /**
   * 注册 Hook 到指定 hook 点
   */
  register(hookPoint: string, hook: Hook<T>): void {
    const hooks = this.getOrCreateHooks(hookPoint);
    hooks.push(hook);
  }

  /**
   * 注册多个 Hook
   */
  registerMany(hookPoint: string, hooks: Hook<T>[]): void {
    const hookList = this.getOrCreateHooks(hookPoint);
    hookList.push(...hooks);
  }

  /**
   * 按名称取消注册 Hook
   * @returns 是否成功取消注册
   */
  unregister(hookPoint: string, name: string): boolean {
    const hooks = this._hooks.get(hookPoint);
    if (!hooks) return false;

    const index = hooks.findIndex((h) => h.name === name);
    if (index === -1) return false;

    hooks.splice(index, 1);
    return true;
  }

  /**
   * 取消注册所有指定 hook 点的 Hook
   */
  unregisterAll(hookPoint: string): void {
    this._hooks.delete(hookPoint);
  }

  /**
   * 执行指定 hook 点的所有 Hook
   * 
   * 支持 pluginEnabled 检查：
   * - 如果 hook 有 pluginName 和 sourceId，则检查 metadata.pluginEnabled[key] 是否为 true
   * - 如果未启用，则跳过该 hook
   * - 如果 hook 没有 pluginName/sourceId，则总是执行
   * 
   * 也会从线程变量 EnvContext 中获取信息补充到 metadata
   */
  async execute(
    hookPoint: string,
    data: T,
    metadata: Record<string, unknown> = {}
  ): Promise<void> {
    const hooks = this._hooks.get(hookPoint);

    // ★ Task #4207 DEBUG: hook 触发追踪（用 ROY_HOOK_DEBUG 环境变量控制）
    const DEBUG_HOOK = process.env.ROY_HOOK_DEBUG === "1";
    if (DEBUG_HOOK) {
      console.error(`[DEBUG hook-manager.execute] hookPoint=${hookPoint}, hooksCount=${hooks?.length ?? 0}`);
    }

    if (!hooks || hooks.length === 0) {
      if (DEBUG_HOOK) console.error(`[DEBUG hook-manager.execute] → EARLY RETURN (no hooks registered for ${hookPoint})`);
      return;
    }

    // 从线程变量获取 EnvContext，补充到 metadata
    const envContext = getEnvContext();
    if (DEBUG_HOOK) {
      console.error(`[DEBUG hook-manager.execute] envContext=${envContext ? "present" : "absent"}`);
      if (envContext) {
        console.error(`[DEBUG hook-manager.execute] envContext.pluginEnabled=${JSON.stringify(envContext.pluginEnabled)}`);
        console.error(`[DEBUG hook-manager.execute] envContext.sourceId=${envContext.sourceId}`);
      }
    }
    if (envContext) {
      metadata.envContext = envContext;
      // 也补充 pluginEnabled（如果 metadata 中没有）
      if (!metadata.pluginEnabled && envContext.pluginEnabled) {
        metadata.pluginEnabled = envContext.pluginEnabled;
      }
    }

    const sortedHooks = this.sortHooks(hooks);
    const ctx = this.createContext(hookPoint, data, metadata, "before");

    // 获取 pluginEnabled 配置
    const pluginEnabled = (metadata.pluginEnabled as Record<string, boolean>) || {};
    if (DEBUG_HOOK) {
      console.error(`[DEBUG hook-manager.execute] final pluginEnabled=${JSON.stringify(pluginEnabled)}`);
      console.error(`[DEBUG hook-manager.execute] sortedHooks=${sortedHooks.length}:`);
      for (const h of sortedHooks) {
        console.error(`[DEBUG hook-manager.execute]   - name=${h.name} pluginName=${h.pluginName} sourceId=${h.sourceId}`);
      }
    }

    for (const hook of sortedHooks) {
      // 检查 pluginEnabled
      if (hook.pluginName && hook.sourceId) {
        const key = `${hook.sourceId}:${hook.pluginName}`;
        const enabled = pluginEnabled[key];
        if (DEBUG_HOOK) {
          console.error(`[DEBUG hook-manager.execute] hook ${hook.name} (${key}) enabled=${enabled}`);
        }
        if (enabled !== true) {
          // 该 plugin 未启用，跳过执行
          if (DEBUG_HOOK) {
            console.error(`[DEBUG hook-manager.execute] → SKIPPED (pluginEnabled[${key}] !== true, got ${JSON.stringify(enabled)})`);
          }
          continue;
        }
      } else if (DEBUG_HOOK) {
        console.error(`[DEBUG hook-manager.execute] hook ${hook.name} has no pluginName/sourceId, ALWAYS EXECUTED`);
      }

      if (DEBUG_HOOK) {
        console.error(`[DEBUG hook-manager.execute] → EXECUTING hook ${hook.name}`);
      }
      await this.safeExecute(hook, ctx);
    }
  }

  /**
   * 执行指定 hook 点的所有 Hook 并收集返回值
   */
  async executeAndCollect<R>(
    hookPoint: string,
    data: T,
    metadata: Record<string, unknown> = {}
  ): Promise<R[]> {
    const hooks = this._hooks.get(hookPoint);
    if (!hooks || hooks.length === 0) return [];

    const sortedHooks = this.sortHooks(hooks);
    const ctx = this.createContext(hookPoint, data, metadata, "before");
    const results: R[] = [];

    for (const hook of sortedHooks) {
      const result = await this.safeExecuteAndReturn(hook, ctx);
      if (result !== undefined) {
        results.push(result as R);
      }
    }

    return results;
  }

  /**
   * 获取指定 hook 点的 Hook 数量
   */
  count(hookPoint: string): number {
    return this._hooks.get(hookPoint)?.length ?? 0;
  }

  /**
   * 清空所有 Hook
   */
  clear(): void {
    this._hooks.clear();
  }

  /**
   * 获取所有已注册的 hook 点
   */
  getHookPoints(): string[] {
    return Array.from(this._hooks.keys());
  }

  /**
   * 检查 hook 点是否有任何 Hook
   */
  hasHooks(hookPoint: string): boolean {
    return this.count(hookPoint) > 0;
  }

  /**
   * 设置组件信息
   */
  setComponentInfo(name: string, version: string): void {
    this.componentName = name;
    this.componentVersion = version;
  }

  /**
   * 获取所有注册的 hooks（只读副本）
   */
  get hooks(): ReadonlyMap<string, Hook<T>[]> {
    return this._hooks;
  }

  // ========================================================================
  // 干预机制
  // ========================================================================

  /**
   * 执行 Hook 并支持干预机制
   * 
   * 如果任何一个 Hook 返回 { stop: true }，执行会停止
   * Hook 可以通过返回 HookResult 来执行干预动作
   * 
   * @param hookPoint Hook 点
   * @param data 数据
   * @param metadata 元数据
   * @returns 执行结果
   */
  async executeWithIntervention(
    hookPoint: string,
    data: T,
    metadata: Record<string, unknown> = {}
  ): Promise<HookResult> {
    const hooks = this._hooks.get(hookPoint);
    if (!hooks || hooks.length === 0) {
      return { stopped: false, results: [] };
    }

    const sortedHooks = this.sortHooks(hooks);
    const ctx = this.createContext(hookPoint, data, metadata, "before");
    const results: unknown[] = [];
    let stopped = false;
    let action: HookResult["action"];

    for (const hook of sortedHooks) {
      if (stopped) break;

      const result = await this.safeExecuteAndReturn(hook, ctx);
      results.push(result);

      // 检查是否需要干预
      if (result && typeof result === "object" && "stopped" in result) {
        const hookResult = result as HookResult;
        if (hookResult.stopped) {
          stopped = true;
          action = hookResult.action;
        }
      }
    }

    return { stopped, action, results };
  }

  // ========================================================================
  // 私有方法
  // ========================================================================

  /**
   * 获取或创建 hook 列表
   */
  private getOrCreateHooks(hookPoint: string): Hook<T>[] {
    let hooks = this._hooks.get(hookPoint);
    if (!hooks) {
      hooks = [];
      this._hooks.set(hookPoint, hooks);
    }
    return hooks;
  }

  /**
   * 按优先级排序 Hook
   * 
   * 优先级相同时保持原顺序（稳定排序）
   */
  private sortHooks(hooks: Hook<T>[]): Hook<T>[] {
    return [...hooks].sort((a, b) => {
      const priorityA = a.priority ?? this.defaultPriority;
      const priorityB = b.priority ?? this.defaultPriority;
      return priorityA - priorityB;
    });
  }

  /**
   * 创建 Hook 上下文
   */
  private createContext(
    hookPoint: string,
    data: T,
    metadata: Record<string, unknown>,
    phase: HookPhase
  ): HookContext<T> {
    return {
      component: {
        name: this.componentName,
        version: this.componentVersion,
      },
      data,
      metadata,
      phase,
      hookPoint,
    };
  }

  /**
   * 安全执行 Hook（错误隔离）
   */
  private async safeExecute(hook: Hook<T>, ctx: HookContext<T>): Promise<void> {
    try {
      const result = hook.execute(ctx);
      
      // 处理 Promise
      if (result && typeof result === 'object' && typeof (result as Promise<unknown>).then === 'function') {
        await result;
      }
    } catch (error) {
      // 记录错误但不中断执行
      console.error(`Hook "${hook.name}" failed:`, error);
    }
  }

  /**
   * 安全执行 Hook 并返回结果
   */
  private async safeExecuteAndReturn<R>(
    hook: Hook<T>,
    ctx: HookContext<T>
  ): Promise<R | undefined> {
    try {
      return await (hook.execute(ctx) as Promise<R>);
    } catch (error) {
      console.error(`Hook "${hook.name}" failed:`, error);
      return undefined;
    }
  }
}
