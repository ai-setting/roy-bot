/**
 * @fileoverview useDesktopEnvironment Hook
 * 
 * React hook for managing DesktopEnvironmentService lifecycle
 */

import { useEffect, useRef, useState } from 'react';
import { DesktopEnvironmentService } from '../core/DesktopEnvironmentService';

export interface UseDesktopEnvironmentOptions {
  /** 自动初始化（默认 true） */
  autoInit?: boolean;
}

export interface UseDesktopEnvironmentReturn {
  /** EnvironmentService 实例 */
  service: DesktopEnvironmentService | null;
  /** 是否已初始化 */
  isInitialized: boolean;
  /** 是否正在初始化 */
  isLoading: boolean;
  /** 错误信息 */
  error: Error | null;
  /** 初始化方法 */
  initialize: () => Promise<void>;
  /** 清理方法 */
  dispose: () => Promise<void>;
  /** 处理用户查询 */
  handleQuery: (query: string, context?: { sessionId?: string }) => Promise<string>;
}

/**
 * useDesktopEnvironment Hook
 * 
 * 管理 DesktopEnvironmentService 的生命周期
 */
export function useDesktopEnvironment(
  options: UseDesktopEnvironmentOptions = {}
): UseDesktopEnvironmentReturn {
  const { autoInit = true } = options;
  
  const serviceRef = useRef<DesktopEnvironmentService | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  // 初始化
  const initialize = async () => {
    if (serviceRef.current || isLoading) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const service = new DesktopEnvironmentService();
      await service.create();
      serviceRef.current = service;
      setIsInitialized(true);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      console.error('[useDesktopEnvironment] Initialization failed:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // 清理
  const dispose = async () => {
    if (serviceRef.current) {
      await serviceRef.current.dispose();
      serviceRef.current = null;
      setIsInitialized(false);
    }
  };

  // 处理查询
  const handleQuery = async (
    query: string,
    context?: { sessionId?: string }
  ): Promise<string> => {
    if (!serviceRef.current) {
      throw new Error('DesktopEnvironmentService not initialized');
    }
    return serviceRef.current.handleQuery(query, context);
  };

  // 自动初始化
  useEffect(() => {
    if (autoInit) {
      initialize();
    }

    return () => {
      // 组件卸载时清理
      dispose();
    };
  }, []);

  return {
    service: serviceRef.current,
    isInitialized,
    isLoading,
    error,
    initialize,
    dispose,
    handleQuery,
  };
}
