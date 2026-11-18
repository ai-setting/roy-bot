/**
 * @fileoverview StreamingMessageService
 * 
 * 流式消息服务 - 订阅 eventBus 中的 llm.* 事件
 * 管理流式消息状态，提供给 PanelL2 渲染
 */

import { eventBus, type DesktopEvent } from './EventBusAdapter';

export interface StreamingMessageState {
  messageId: string;
  content: string;       // 累积全文
  isStreaming: boolean;   // 是否正在流式
  isComplete: boolean;   // 是否已完成
  error?: string;        // 错误信息
}

/**
 * LLM 事件 Payload 类型
 */
interface LLMTextPayload {
  delta?: string;
  content?: string;
}

interface LLMStartPayload {
  metadata?: {
    model?: string;
    [key: string]: unknown;
  };
}

interface LLMCompletedPayload {
  content: string;
  metadata?: {
    model?: string;
    usage?: unknown;
    [key: string]: unknown;
  };
}

interface LLMErrorPayload {
  message?: string;
  [key: string]: unknown;
}

type LLMEventPayload = LLMTextPayload | LLMStartPayload | LLMCompletedPayload | LLMErrorPayload;

/**
 * StreamingMessageService - 管理流式消息状态
 * 
 * 单例模式，整个应用共享一个实例
 */
class StreamingMessageService {
  private state: StreamingMessageState | null = null;
  private callbacks: Set<(state: StreamingMessageState | null) => void> = new Set();
  private unsubscribeFn: (() => void) | null = null;
  private isSubscribed = false;
  
  // 用于去重：记录已处理的事件 key (timestamp-delta)
  private processedEvents = new Set<string>();

  constructor() {
    // 在构造函数中订阅一次 eventBus
    this.ensureSubscribed();
  }

  /**
   * 确保已订阅 eventBus
   */
  private ensureSubscribed(): void {
    if (this.isSubscribed) return;
    
    this.unsubscribeFn = eventBus.onAny((event: DesktopEvent) => {
      this.handleEvent(event.type, event.data as LLMEventPayload, event.timestamp);
    });
    
    this.isSubscribed = true;
  }

  /**
   * 开始一个新的流式消息
   */
  startMessage(messageId: string): void {
    // 重置去重记录
    this.processedEvents.clear();
    
    this.state = {
      messageId,
      content: '',
      isStreaming: true,
      isComplete: false,
      error: undefined,
    };
    
    this.notifyCallbacks();
  }

  /**
   * 处理 LLM/Agent 事件
   */
  private handleEvent(type: string, payload: LLMEventPayload, timestamp: number): void {
    // 如果没有活跃的流式消息，忽略事件
    if (!this.state) {
      return;
    }

    // 提取事件类型名称
    let eventType = type;
    if (type.startsWith('llm.')) {
      eventType = type.slice(4);
    } else if (type.startsWith('agent.')) {
      eventType = type.slice(6);
    }

    switch (eventType) {
      case 'text': {
        const textPayload = payload as LLMTextPayload;
        
        // 如果有 delta，只追加 delta 部分
        if (textPayload.delta !== undefined) {
          // 去重：检查是否已处理过这个 delta
          const eventKey = `${timestamp}-${textPayload.delta}`;
          if (this.processedEvents.has(eventKey)) {
            return;
          }
          this.processedEvents.add(eventKey);
          
          // delta 是增量，直接累加
          this.state.content += textPayload.delta;
        } else if (textPayload.content !== undefined) {
          // 只有 content 没有 delta，用 content 替换（用于初始内容或重置）
          this.state.content = textPayload.content;
        }
        break;
      }

      case 'llm_complete': {
        // llm.complete 只更新内容，不结束流式
        // 因为可能还有后续的 text 事件
        const completedPayload = payload as LLMCompletedPayload;
        if (completedPayload.content) {
          this.state.content = completedPayload.content;
        }
        break;
      }

      case 'agent_complete': {
        // agent.complete 才是真正的结束
        this.state.isStreaming = false;
        this.state.isComplete = true;
        break;
      }

      case 'complete': {
        // 通用的 complete 事件，也作为结束
        const completedPayload = payload as LLMCompletedPayload;
        if (completedPayload.content) {
          this.state.content = completedPayload.content;
        }
        this.state.isStreaming = false;
        this.state.isComplete = true;
        break;
      }

      case 'error': {
        const errorPayload = payload as LLMErrorPayload;
        this.state.isStreaming = false;
        this.state.isComplete = true;
        this.state.error = errorPayload.message || 'Unknown error';
        break;
      }

      // start, reasoning, tool_call 等事件不处理文本
    }

    this.notifyCallbacks();
  }

  /**
   * 获取当前状态
   */
  getState(): StreamingMessageState | null {
    return this.state;
  }

  /**
   * 重置状态
   */
  reset(): void {
    this.state = null;
    this.notifyCallbacks();
  }

  /**
   * 注册状态变化回调
   * @returns 取消注册函数
   */
  onStateChange(callback: (state: StreamingMessageState | null) => void): () => void {
    this.callbacks.add(callback);
    
    return () => {
      this.callbacks.delete(callback);
    };
  }

  /**
   * 通知所有回调
   */
  private notifyCallbacks(): void {
    for (const callback of this.callbacks) {
      try {
        callback(this.state);
      } catch (err) {
        console.error('[StreamingMessageService] Callback error:', err);
      }
    }
  }
}

// Singleton instance
export const streamingMessageService = new StreamingMessageService();
