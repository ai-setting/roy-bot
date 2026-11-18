/**
 * @fileoverview DesktopEnvironment Context
 * 
 * React Context for sharing DesktopEnvironmentService across components
 */

import React, { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react';
import { DesktopEnvironmentService } from '../core/DesktopEnvironmentService';
import { getDesktopEventSubscriber, type DesktopEventSubscriber } from '../core/DesktopEventSubscriber';
import { eventStore } from '../stores/eventStore';

// Track the unsubscribe function for cleanup
let eventStoreUnsubscribe: (() => void) | null = null;

/**
 * Get default config directory for desktop.
 * 
 * ⚠️ Electron renderer 进程无法可靠获取 home 目录（contextIsolation 限制）。
 * 因此此函数总是返回 undefined，让 Electron main process 自己决定配置路径。
 * Main process 使用 os.homedir() 能正确获取 Windows/Linux/macOS 的 home 路径。
 */
function getDefaultConfigDir(): string | undefined {
  // 在 Electron 中，让 main process 自己决定配置路径（最可靠）
  // 不要传入错误的路径覆盖 main process 的正确逻辑
  return undefined;
}

interface DesktopEnvironmentContextValue {
  /** EnvironmentService instance */
  service: DesktopEnvironmentService | null;
  /** Whether environment is initialized */
  isInitialized: boolean;
  /** Whether environment is loading */
  isLoading: boolean;
  /** Error if initialization failed */
  error: Error | null;
  /** Handle user query */
  handleQuery: (query: string, context?: { sessionId?: string }) => Promise<string>;
  /** Initialize environment manually */
  initialize: () => Promise<void>;
  /** Dispose environment */
  dispose: () => Promise<void>;
  /** Event subscriber instance */
  eventSubscriber: DesktopEventSubscriber | null;
  /** Set event types to subscribe */
  setEventTypes: (types: string[]) => Promise<void>;
  /** Set events enabled/disabled */
  setEventsEnabled: (enabled: boolean) => Promise<void>;
}

const DesktopEnvironmentContext = createContext<DesktopEnvironmentContextValue | null>(null);

/**
 * Desktop Environment Provider
 * 
 * Wrap your app with this provider to enable DesktopEnvironment access
 */
export function DesktopEnvironmentProvider({ children }: { children: React.ReactNode }) {
  const serviceRef = useRef<DesktopEnvironmentService | null>(null);
  const eventSubscriberRef = useRef<DesktopEventSubscriber | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const initialize = useCallback(async () => {
    if (serviceRef.current || isLoading) {
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const service = new DesktopEnvironmentService();
      const configDir = getDefaultConfigDir();
      console.log('[DesktopEnvironmentProvider] Creating environment with configDir:', configDir);
      await service.create({ configDir });
      serviceRef.current = service;
      
      // Initialize event subscriber after environment is created
      const eventSubscriber = getDesktopEventSubscriber();
      await eventSubscriber.init();
      eventSubscriberRef.current = eventSubscriber;
      console.log('[DesktopEnvironmentProvider] Event subscriber initialized');
      
      // Initialize eventStore subscription to receive events
      // This subscribes to the eventBus, which receives events from DesktopEventSubscriber
      eventStoreUnsubscribe = eventStore.subscribe();
      console.log('[DesktopEnvironmentProvider] Event store subscription initialized');
      
      setIsInitialized(true);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
      console.error('[DesktopEnvironmentProvider] Initialization failed:', err);
    } finally {
      setIsLoading(false);
    }
  }, [isLoading]);

  const dispose = useCallback(async () => {
    if (eventSubscriberRef.current) {
      eventSubscriberRef.current.dispose();
      eventSubscriberRef.current = null;
    }
    if (serviceRef.current) {
      await serviceRef.current.dispose();
      serviceRef.current = null;
      setIsInitialized(false);
    }
    // Unsubscribe from eventStore
    if (eventStoreUnsubscribe) {
      eventStoreUnsubscribe();
      eventStoreUnsubscribe = null;
    }
  }, []);

  const handleQuery = useCallback(async (query: string, context?: { sessionId?: string }) => {
    if (!serviceRef.current) {
      throw new Error('DesktopEnvironmentService not initialized');
    }
    return serviceRef.current.handleQuery(query, context);
  }, []);

  const setEventTypes = useCallback(async (types: string[]) => {
    if (!eventSubscriberRef.current) {
      throw new Error('EventSubscriber not initialized');
    }
    await eventSubscriberRef.current.setEventTypes(types);
  }, []);

  const setEventsEnabled = useCallback(async (enabled: boolean) => {
    if (!eventSubscriberRef.current) {
      throw new Error('EventSubscriber not initialized');
    }
    await eventSubscriberRef.current.setEnabled(enabled);
  }, []);

  // Auto-initialize on mount
  useEffect(() => {
    initialize();

    return () => {
      // Cleanup on unmount
      dispose();
    };
  }, []);

  const value: DesktopEnvironmentContextValue = {
    service: serviceRef.current,
    isInitialized,
    isLoading,
    error,
    handleQuery,
    initialize,
    dispose,
    eventSubscriber: eventSubscriberRef.current,
    setEventTypes,
    setEventsEnabled,
  };

  return (
    <DesktopEnvironmentContext.Provider value={value}>
      {children}
    </DesktopEnvironmentContext.Provider>
  );
}

/**
 * Hook to access DesktopEnvironment
 */
export function useDesktopEnvironmentContext() {
  const context = useContext(DesktopEnvironmentContext);
  if (!context) {
    throw new Error('useDesktopEnvironmentContext must be used within DesktopEnvironmentProvider');
  }
  return context;
}
