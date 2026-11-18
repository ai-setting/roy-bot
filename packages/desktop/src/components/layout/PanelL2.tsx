/**
 * PanelL2 - Chat panel with AI agent interaction
 * 
 * Features:
 * - User input for queries
 * - AI response display with streaming support
 * - Message history
 * - Loading and error states
 */
import { useState, useRef, useEffect, FormEvent, useCallback } from 'react';
import { useDesktopEnvironmentContext } from '@/contexts/DesktopEnvironmentContext';
import { useEventStore } from '@/stores/eventStore';
import { MarkdownRenderer } from '../markdown';
import { streamingMessageService, type StreamingMessageState } from '@/core';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  isStreaming?: boolean;
  error?: string;
}

/**
 * Format timestamp to readable time
 */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * PanelL2 - Main chat panel component
 */
export function PanelL2() {
  const { isInitialized, isLoading, error, handleQuery } = useDesktopEnvironmentContext();
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  
  // 当前正在流式更新的消息 ID
  const streamingMessageIdRef = useRef<string | null>(null);
  
  // Subscribe to events (for event display)
  const { subscribe } = useEventStore();
  
  // Subscribe to streaming message service - 持久订阅
  useEffect(() => {
    const unsubscribe = streamingMessageService.onStateChange((state: StreamingMessageState | null) => {
      if (!state) {
        streamingMessageIdRef.current = null;
        return;
      }
      
      // 检查是否是当前正在处理的消息
      if (streamingMessageIdRef.current === state.messageId) {
        // 更新消息内容
        setMessages(prev => prev.map(msg => {
          if (msg.id === state.messageId) {
            return {
              ...msg,
              content: state.content,
              isStreaming: state.isStreaming && !state.isComplete,
              error: state.error,
            };
          }
          return msg;
        }));
        
        // 如果流式完成，清除引用
        if (state.isComplete) {
          streamingMessageIdRef.current = null;
        }
      }
    });
    
    return unsubscribe;
  }, []);
  
  // 同时订阅 eventStore（用于事件展示）
  useEffect(() => {
    const unsubscribe = subscribe();
    return unsubscribe;
  }, [subscribe]);
  
  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Submit handler
  const handleSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault();
    
    const trimmedInput = input.trim();
    if (!trimmedInput || isSubmitting || !isInitialized) {
      return;
    }

    // Add user message
    const userMessage: Message = {
      id: `msg_${Date.now()}_user`,
      role: 'user',
      content: trimmedInput,
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsSubmitting(true);

    // 创建空的 assistant 消息（用于流式更新）
    const assistantMessageId = `msg_${Date.now()}_assistant`;
    streamingMessageIdRef.current = assistantMessageId;
    
    const assistantMessage: Message = {
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      isStreaming: true,
    };
    setMessages(prev => [...prev, assistantMessage]);

    try {
      // 启动流式消息服务
      streamingMessageService.startMessage(assistantMessageId);

      // 调用 agent - 流式事件会通过 DesktopEventSubscriber → eventBus → StreamingMessageService
      const response = await handleQuery(trimmedInput);
      
      // handleQuery 是同步等待的，但流式事件可能在 handleQuery 返回后一段时间内仍陆续到达
      // 检查当前状态，如果还在流式但内容为空，使用 response 作为 fallback
      const currentState = streamingMessageService.getState();
      if (currentState && currentState.isStreaming && !currentState.content && response) {
        streamingMessageService.reset();
        setMessages(prev => prev.map(msg => {
          if (msg.id === assistantMessageId) {
            return {
              ...msg,
              content: response,
              isStreaming: false,
            };
          }
          return msg;
        }));
      }
      
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      
      // 更新消息为错误状态
      setMessages(prev => prev.map(msg => {
        if (msg.id === assistantMessageId) {
          return {
            ...msg,
            content: `错误: ${errorMessage}`,
            isStreaming: false,
            error: errorMessage,
          };
        }
        return msg;
      }));
      
      // 重置流式服务
      streamingMessageService.reset();
    } finally {
      setIsSubmitting(false);
      streamingMessageIdRef.current = null;
    }
  }, [input, isSubmitting, isInitialized, handleQuery]);

  // Loading state
  if (isLoading) {
    return (
      <div 
        data-testid="panel"
        data-default-size={30}
        className="w-full h-full bg-[#16162a] flex flex-col"
      >
        <div className="h-10 px-4 flex items-center border-b border-[#2d2d44] bg-[#1a1a2e]">
          <h2 className="text-sm font-medium text-surface-300">💬 Chat</h2>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-surface-400">
            <span className="animate-pulse">初始化中...</span>
          </div>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div 
        data-testid="panel"
        data-default-size={30}
        className="w-full h-full bg-[#16162a] flex flex-col"
      >
        <div className="h-10 px-4 flex items-center border-b border-[#2d2d44] bg-[#1a1a2e]">
          <h2 className="text-sm font-medium text-surface-300">💬 Chat</h2>
        </div>
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center text-red-400">
            <p className="text-lg mb-2">❌ 初始化失败</p>
            <p className="text-sm text-surface-500">{error.message}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div 
      data-testid="panel"
      data-default-size={30}
      className="w-full h-full bg-[#16162a] flex flex-col"
    >
      {/* Panel Header */}
      <div className="h-10 px-4 flex items-center justify-between border-b border-[#2d2d44] bg-[#1a1a2e]">
        <h2 className="text-sm font-medium text-surface-300">💬 Chat</h2>
        <span className="text-xs text-surface-500">
          {isInitialized ? '✓' : '○'}
        </span>
      </div>

      {/* Messages Area */}
      <div className="flex-1 overflow-auto p-4">
        {messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-surface-500 text-sm">
            <div className="text-center">
              <p className="mb-2">👋 你好！有什么可以帮助你的？</p>
              <p className="text-xs">在下方输入问题开始对话</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
              >
                <div
                  className={`
                    max-w-[80%] rounded-lg p-3
                    ${msg.role === 'user' 
                      ? 'bg-[#6c63ff] text-white' 
                      : 'bg-[#2d2d44] text-surface-200'
                    }
                    ${msg.error ? 'border border-red-500' : ''}
                  `}
                >
                  {msg.role === 'assistant' ? (
                    <div className="markdown-body">
                      <MarkdownRenderer content={msg.content} />
                      {msg.isStreaming && (
                        <span className="streaming-cursor">▋</span>
                      )}
                    </div>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                  )}
                  <p className={`text-xs mt-1 ${msg.role === 'user' ? 'text-purple-200' : 'text-surface-500'}`}>
                    {formatTime(msg.timestamp)}
                  </p>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}
      </div>

      {/* Input Area */}
      <form onSubmit={handleSubmit} className="border-t border-[#2d2d44] p-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入问题..."
            disabled={isSubmitting || !isInitialized}
            className="
              flex-1 px-4 py-2 bg-[#0f0f1a] border border-[#2d2d44] rounded-lg
              text-surface-200 placeholder-surface-500
              focus:outline-none focus:border-[#6c63ff]
              disabled:opacity-50 disabled:cursor-not-allowed
            "
          />
          <button
            type="submit"
            disabled={isSubmitting || !isInitialized || !input.trim()}
            className="
              px-4 py-2 bg-[#6c63ff] hover:bg-[#5a52e0] text-white rounded-lg
              disabled:opacity-50 disabled:cursor-not-allowed
              transition-colors
            "
          >
            {isSubmitting ? '...' : '发送'}
          </button>
        </div>
      </form>
    </div>
  );
}
