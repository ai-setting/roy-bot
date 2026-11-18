import type { LLMInvokeRequest, LLMInvokeResult, LLMOutput, StreamEvent } from "./types";
import { globalHookManager, LLMHookPoints } from "../hook/global-hook-manager";

/**
 * LLM Hook 类型（兼容旧接口）
 */
export type LLMHookType = "before-invoke" | "after-invoke" | "stream";

/**
 * LLM Hook 上下文
 */
export interface LLMHookContext {
  /** 请求 */
  request: LLMInvokeRequest;
  /** Provider ID */
  providerId: string;
  /** 模型名称 */
  model: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * Before Invoke Hook
 * 在 LLM 调用之前执行，可以修改请求
 */
export type LLMBeforeInvokeHook = (context: LLMHookContext) => Promise<void>;

/**
 * After Invoke Hook
 * 在 LLM 调用之后执行，可以处理结果
 */
export type LLMAfterInvokeHook = (
  context: LLMHookContext,
  result: LLMInvokeResult
) => Promise<void>;

/**
 * Stream Hook
 * 在流式调用时处理每个事件
 */
export type LLMStreamHook = (
  context: LLMHookContext,
  event: StreamEvent
) => Promise<void>;

/**
 * Hook 注册项
 */
export interface LLMHookRegistration {
  /** Hook 类型 */
  type: LLMHookType;
  /** Hook 名称（可选，用于标识） */
  name?: string;
  /** Before Invoke Hook */
  beforeInvoke?: LLMBeforeInvokeHook;
  /** After Invoke Hook */
  afterInvoke?: LLMAfterInvokeHook;
  /** Stream Hook */
  stream?: LLMStreamHook;
}

/**
 * LLMHookManager
 * 
 * 代理到 globalHookManager 的 LLM Hook 管理器
 * 
 * @deprecated 请直接使用 globalHookManager.register() 注册 hooks
 */
export class LLMHookManager {
  private registrations: LLMHookRegistration[] = [];

  /**
   * 注册 Hook
   */
  register(
    type: LLMHookType,
    handler: LLMBeforeInvokeHook | LLMAfterInvokeHook | LLMStreamHook,
    name?: string
  ): void {
    const registration: LLMHookRegistration = {
      type,
      name,
    };

    switch (type) {
      case "before-invoke":
        registration.beforeInvoke = handler as LLMBeforeInvokeHook;
        break;
      case "after-invoke":
        registration.afterInvoke = handler as LLMAfterInvokeHook;
        break;
      case "stream":
        registration.stream = handler as LLMStreamHook;
        break;
    }

    this.registrations.push(registration);
    
    // 注册到 globalHookManager
    this.registerToGlobal(registration);
  }

  /**
   * 注册单个 registration 到 globalHookManager
   */
  private registerToGlobal(reg: LLMHookRegistration): void {
    const hookName = `llm:${reg.name || `anon-${reg.type}-${this.registrations.indexOf(reg)}`}`;

    if (reg.beforeInvoke) {
      globalHookManager.register(LLMHookPoints.BEFORE_INVOKE, {
        name: hookName,
        priority: 0,
        execute: async (ctx) => {
          await reg.beforeInvoke!(ctx.data as LLMHookContext);
        },
      });
    }

    if (reg.afterInvoke) {
      globalHookManager.register(LLMHookPoints.AFTER_INVOKE, {
        name: hookName,
        priority: 0,
        execute: async (ctx) => {
          const { request, providerId, model, metadata, result } = ctx.data as LLMHookContext & { result: LLMInvokeResult };
          await reg.afterInvoke!({ request, providerId, model, metadata }, result);
        },
      });
    }

    if (reg.stream) {
      globalHookManager.register(LLMHookPoints.ON_STREAM, {
        name: hookName,
        priority: 0,
        execute: async (ctx) => {
          const { request, providerId, model, metadata, event } = ctx.data as LLMHookContext & { event: StreamEvent };
          await reg.stream!({ request, providerId, model, metadata }, event);
        },
      });
    }
  }

  /**
   * 取消注册 Hook
   */
  unregister(hook: LLMBeforeInvokeHook | LLMAfterInvokeHook | LLMStreamHook): void {
    const index = this.registrations.findIndex((h) => {
      return h.beforeInvoke === hook || h.afterInvoke === hook || h.stream === hook;
    });
    
    if (index !== -1) {
      const reg = this.registrations[index];
      this.unregisterFromGlobal(reg);
      this.registrations.splice(index, 1);
    }
  }

  /**
   * 从 globalHookManager 取消注册
   */
  private unregisterFromGlobal(reg: LLMHookRegistration): void {
    const hookName = `llm:${reg.name || `anon-${reg.type}`}`;
    globalHookManager.unregister(LLMHookPoints.BEFORE_INVOKE, hookName);
    globalHookManager.unregister(LLMHookPoints.AFTER_INVOKE, hookName);
    globalHookManager.unregister(LLMHookPoints.ON_STREAM, hookName);
  }

  /**
   * 按名称取消注册 Hook
   */
  unregisterByName(name: string): void {
    const hookName = `llm:${name}`;
    globalHookManager.unregister(LLMHookPoints.BEFORE_INVOKE, hookName);
    globalHookManager.unregister(LLMHookPoints.AFTER_INVOKE, hookName);
    globalHookManager.unregister(LLMHookPoints.ON_STREAM, hookName);
    this.registrations = this.registrations.filter((h) => h.name !== name);
  }

  /**
   * 按类型取消注册所有 Hook
   */
  unregisterByType(type: LLMHookType): void {
    const filtered = this.registrations.filter((h) => h.type === type);
    for (const reg of filtered) {
      this.unregisterFromGlobal(reg);
    }
    this.registrations = this.registrations.filter((h) => h.type !== type);
  }

  /**
   * 清空所有 Hook
   */
  clear(): void {
    for (const reg of this.registrations) {
      this.unregisterFromGlobal(reg);
    }
    this.registrations = [];
  }

  /**
   * 获取所有 Hook
   */
  getHooks(): LLMHookRegistration[] {
    return [...this.registrations];
  }

  /**
   * 按类型获取 Hook
   */
  getHooksByType(type: LLMHookType): LLMHookRegistration[] {
    return this.registrations.filter((h) => h.type === type);
  }
}

/**
 * LLMHooks
 * 
 * 兼容旧接口，内部委托给 globalHookManager
 * 
 * @deprecated 请直接使用 globalHookManager
 */
export class LLMHooks {
  private hookManager = new LLMHookManager();

  /**
   * 注册 Hook
   */
  register(
    type: LLMHookType,
    handler: LLMBeforeInvokeHook | LLMAfterInvokeHook | LLMStreamHook,
    name?: string
  ): void {
    this.hookManager.register(type, handler, name);
  }

  /**
   * 取消注册 Hook
   */
  unregister(hook: LLMBeforeInvokeHook | LLMAfterInvokeHook | LLMStreamHook): void {
    this.hookManager.unregister(hook);
  }

  /**
   * 按名称取消注册 Hook
   */
  unregisterByName(name: string): void {
    this.hookManager.unregisterByName(name);
  }

  /**
   * 按类型取消注册所有 Hook
   */
  unregisterByType(type: LLMHookType): void {
    this.hookManager.unregisterByType(type);
  }

  /**
   * 清空所有 Hook
   */
  clear(): void {
    this.hookManager.clear();
  }

  /**
   * 获取所有 Hook
   */
  getHooks(): LLMHookRegistration[] {
    return this.hookManager.getHooks();
  }

  /**
   * 按类型获取 Hook
   */
  getHooksByType(type: LLMHookType): LLMHookRegistration[] {
    return this.hookManager.getHooksByType(type);
  }

  /**
   * 执行 Before Invoke Hooks
   * 
   * @deprecated 请使用 globalHookManager.execute(LLMHookPoints.BEFORE_INVOKE, ...)
   */
  async executeBeforeInvoke(context: LLMHookContext): Promise<void> {
    await globalHookManager.execute(LLMHookPoints.BEFORE_INVOKE, context);
  }

  /**
   * 执行 After Invoke Hooks
   * 
   * @deprecated 请使用 globalHookManager.execute(LLMHookPoints.AFTER_INVOKE, ...)
   */
  async executeAfterInvoke(
    context: LLMHookContext,
    result: LLMInvokeResult
  ): Promise<void> {
    await globalHookManager.execute(
      LLMHookPoints.AFTER_INVOKE,
      { ...context, result }
    );
  }

  /**
   * 执行 Stream Hooks
   * 
   * @deprecated 请使用 globalHookManager.execute(LLMHookPoints.ON_STREAM, ...)
   */
  async executeStream(
    context: LLMHookContext,
    event: StreamEvent
  ): Promise<void> {
    await globalHookManager.execute(
      LLMHookPoints.ON_STREAM,
      { ...context, event }
    );
  }
}
