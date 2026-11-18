/**
 * @fileoverview DesktopEventSubscriber
 * 
 * Renderer 端事件订阅器：
 * - 接收来自 main process 的 core Environment 事件
 * - 发布到 eventBus
 * - EventStore 通过订阅 eventBus 统一接收事件
 * 
 * 架构：
 * Main Process: DesktopComponent → IPC → DesktopEventSubscriber → eventBus → EventStore.subscribe() → UI
 */

import { DesktopEnvironmentAdapter, getDefaultAdapter } from '../electron/DesktopEnvironmentAdapter';
import { eventBus, type DesktopEvent as BusEvent } from './EventBusAdapter';
import type { IPCError } from '../electron/types';

/**
 * DesktopEventSubscriber 配置
 */
export interface DesktopEventSubscriberOptions {
  /** DesktopEnvironmentAdapter 实例 */
  adapter?: DesktopEnvironmentAdapter;
  /** 初始订阅的事件类型（默认从配置读取） */
  initialEventTypes?: string[];
  /** 最大重连次数（默认 5） */
  maxRetries?: number;
  /** 初始重连延迟（毫秒，默认 1000） */
  initialRetryDelay?: number;
}

/**
 * IPC 连接状态
 */
export type IPCConnectionState = 'connected' | 'disconnected' | 'reconnecting' | 'failed';

/**
 * Error event callback
 */
export type ErrorCallback = (error: IPCError) => void;

/**
 * Reconnect callback
 */
export type ReconnectCallback = () => void;

/**
 * Max retries exceeded callback
 */
export type MaxRetriesExceededCallback = () => void;

/**
 * DesktopEventSubscriber
 * 
 * 订阅 core Environment 事件并写入 eventStore
 * 支持 IPC 错误处理和自动重连
 */
export class DesktopEventSubscriber {
  private adapter: DesktopEnvironmentAdapter;
  private unsubscribers: (() => void)[] = [];
  private isInitialized = false;
  
  // Error handling state
  private connectionState: IPCConnectionState = 'disconnected';
  private retryCount = 0;
  private maxRetries: number;
  private initialRetryDelay: number;
  private retryTimeoutId: ReturnType<typeof setTimeout> | null = null;
  
  // Event callbacks
  private errorCallbacks: ErrorCallback[] = [];
  private reconnectCallbacks: ReconnectCallback[] = [];
  private maxRetriesExceededCallbacks: MaxRetriesExceededCallback[] = [];

  constructor(options?: DesktopEventSubscriberOptions) {
    this.adapter = options?.adapter ?? getDefaultAdapter();
    this.maxRetries = options?.maxRetries ?? 5;
    this.initialRetryDelay = options?.initialRetryDelay ?? 1000;
  }

  /**
   * 获取当前连接状态
   */
  getConnectionState(): IPCConnectionState {
    return this.connectionState;
  }

  /**
   * 获取当前重试次数
   */
  getRetryCount(): number {
    return this.retryCount;
  }

  /**
   * 初始化订阅
   */
  async init(): Promise<void> {
    if (this.isInitialized) {
      return;
    }

    // 设置 IPC sender
    try {
      await this.adapter.setupEventForwarding();
      this.connectionState = 'connected';
    } catch (err) {
      this.connectionState = 'disconnected';
    }

    // 订阅事件和错误
    this.subscribeToEvents();
    this.subscribeToErrors();
    await this.loadInitialConfig();

    this.isInitialized = true;
  }

  /**
   * 订阅来自 main process 的事件
   */
  private subscribeToEvents(): void {
    const unsubEvent = this.adapter.onEnvEvent((event) => {
      this.handleEvent(event);
    });
    this.unsubscribers.push(unsubEvent);
  }

  /**
   * 订阅 IPC 错误
   */
  private subscribeToErrors(): void {
    const unsubError = this.adapter.onError((error) => {
      this.handleIPCError(error);
    });
    this.unsubscribers.push(unsubError);
  }

  /**
   * 处理 IPC 错误
   */
  private handleIPCError(error: IPCError): void {
    this.connectionState = 'disconnected';
    
    for (const callback of this.errorCallbacks) {
      try {
        callback(error);
      } catch (err) {
        console.error('[DesktopEventSubscriber] Error in error callback:', err);
      }
    }
    
    this.attemptReconnect();
  }

  /**
   * 尝试重新连接
   */
  private async attemptReconnect(): Promise<void> {
    if (this.retryCount >= this.maxRetries) {
      this.connectionState = 'failed';
      
      for (const callback of this.maxRetriesExceededCallbacks) {
        try {
          callback();
        } catch (err) {
          console.error('[DesktopEventSubscriber] Error in max retries callback:', err);
        }
      }
      return;
    }
    
    this.retryCount++;
    this.connectionState = 'reconnecting';
    
    const delay = this.initialRetryDelay * Math.pow(2, this.retryCount - 1);
    
    this.retryTimeoutId = setTimeout(async () => {
      try {
        await this.adapter.setupEventForwarding();
        this.connectionState = 'connected';
        this.retryCount = 0;
        
        for (const callback of this.reconnectCallbacks) {
          try {
            callback();
          } catch (err) {
            console.error('[DesktopEventSubscriber] Error in reconnect callback:', err);
          }
        }
      } catch (err) {
        this.attemptReconnect();
      }
    }, delay);
  }

  /**
   * 处理收到的事件
   * 
   * Core 发出的事件格式: { type: "llm.text", payload: {...} }
   * 需要转换: payload → data
   */
  private handleEvent(event: { type: string; data?: unknown; payload?: unknown; timestamp: number }): void {
    // Core 事件使用 payload 字段，转换为 data 字段
    const eventData = event.data ?? event.payload;
    
    // 只通过 eventBus 发布事件，让 EventStore 的订阅者统一处理
    // 这样可以利用 EventStore 的去重机制 (processedEvents Set)
    const busEvent: BusEvent = {
      type: event.type,
      data: eventData,
      timestamp: event.timestamp,
    };
    eventBus.publish(busEvent).catch((err) => {
      console.error('[DesktopEventSubscriber] Failed to publish to eventBus:', err);
    });
  }

  /**
   * 加载初始配置
   */
  private async loadInitialConfig(): Promise<void> {
    try {
      await this.adapter.getDesktopComponentInfo();
    } catch {
      // 忽略配置加载错误
    }
  }

  /**
   * 注册错误回调
   */
  onError(callback: ErrorCallback): void {
    this.errorCallbacks.push(callback);
  }

  /**
   * 注册重连成功回调
   */
  onReconnect(callback: ReconnectCallback): void {
    this.reconnectCallbacks.push(callback);
  }

  /**
   * 注册最大重试次数超限回调
   */
  onMaxRetriesExceeded(callback: MaxRetriesExceededCallback): void {
    this.maxRetriesExceededCallbacks.push(callback);
  }

  /**
   * 设置订阅的事件类型
   */
  async setEventTypes(types: string[]): Promise<void> {
    await this.adapter.setEventTypes(types);
  }

  /**
   * 设置是否启用事件
   */
  async setEnabled(enabled: boolean): Promise<void> {
    await this.adapter.setEventsEnabled(enabled);
  }

  /**
   * 获取当前订阅的事件类型
   */
  async getEventTypes(): Promise<string[]> {
    const info = await this.adapter.getDesktopComponentInfo();
    return info?.eventTypes ?? ['agent.*', 'tool.*', 'session.*'];
  }

  /**
   * 手动重置重连状态
   */
  resetReconnectState(): void {
    this.retryCount = 0;
    this.connectionState = 'connected';
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }
  }

  /**
   * 清理订阅
   */
  dispose(): void {
    if (this.retryTimeoutId) {
      clearTimeout(this.retryTimeoutId);
      this.retryTimeoutId = null;
    }
    
    for (const unsub of this.unsubscribers) {
      unsub();
    }
    this.unsubscribers = [];
    
    this.errorCallbacks = [];
    this.reconnectCallbacks = [];
    this.maxRetriesExceededCallbacks = [];
    
    this.isInitialized = false;
    this.connectionState = 'disconnected';
  }
}

// Singleton instance
let subscriberInstance: DesktopEventSubscriber | null = null;

/**
 * 获取默认的 DesktopEventSubscriber 实例
 */
export function getDesktopEventSubscriber(): DesktopEventSubscriber {
  if (!subscriberInstance) {
    subscriberInstance = new DesktopEventSubscriber();
  }
  return subscriberInstance;
}
