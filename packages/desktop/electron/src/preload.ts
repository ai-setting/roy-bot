/**
 * Electron Preload Script
 * 
 * Exposes secure IPC methods to the renderer process via contextBridge.
 * 
 * Architecture:
 * - Main process handles core functionality (DesktopEnvironment)
 * - Renderer process uses these APIs to interact with core
 */

import { contextBridge, ipcRenderer } from 'electron';

// Store handlers by callback reference for proper removal
const eventHandlers = new Map<(...args: unknown[]) => void, (event: Electron.IpcRendererEvent, ...args: unknown[]) => void>();
const errorHandlers = new Map<(...args: unknown[]) => void, (event: Electron.IpcRendererEvent, ...args: unknown[]) => void>();

// Expose protected methods that allow the renderer process to use
// ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // ===== App Info =====
  getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  
  // ===== Path Utilities =====
  getUserDataPath: () => ipcRenderer.invoke('path:getUserData'),
  getAppDataPath: () => ipcRenderer.invoke('path:getAppData'),
  getTempPath: () => ipcRenderer.invoke('path:getTemp'),
  getHomePath: () => ipcRenderer.invoke('path:getHome'),
  
  // ===== File System =====
  readFile: (filePath: string) => ipcRenderer.invoke('fs:readFile', filePath),
  writeFile: (filePath: string, data: string) => ipcRenderer.invoke('fs:writeFile', filePath, data),
  fileExists: (filePath: string) => ipcRenderer.invoke('fs:exists', filePath),
  mkdir: (dirPath: string, options?: { recursive?: boolean }) => 
    ipcRenderer.invoke('fs:mkdir', dirPath, options),
  readDir: (dirPath: string) => ipcRenderer.invoke('fs:readDir', dirPath),
  
  // ===== Shell =====
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  
  // ===== Window Controls =====
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  maximizeWindow: () => ipcRenderer.invoke('window:maximize'),
  closeWindow: () => ipcRenderer.invoke('window:close'),
  isWindowMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  
  // ===== Notifications =====
  showNotification: (title: string, body: string) => 
    ipcRenderer.invoke('notification:show', { title, body }),
  
  // ===== SQLite =====
  sqlite: {
    open: (dbPath: string) => ipcRenderer.invoke('sqlite:open', dbPath),
    run: (dbId: string, sql: string, params?: unknown[]) => 
      ipcRenderer.invoke('sqlite:run', dbId, sql, params),
    select: (dbId: string, sql: string, params?: unknown[]) => 
      ipcRenderer.invoke('sqlite:select', dbId, sql, params),
    close: (dbId: string) => ipcRenderer.invoke('sqlite:close', dbId),
  },
  
  // ===== Key-Value Store =====
  store: {
    get: (key: string) => ipcRenderer.invoke('store:get', key),
    set: (key: string, value: unknown) => ipcRenderer.invoke('store:set', key, value),
    delete: (key: string) => ipcRenderer.invoke('store:delete', key),
  },
  
  // ===== Desktop Environment (Core) =====
  environment: {
    /** Initialize the desktop environment (creates BaseEnvironment) */
    create: (options?: { envName?: string; configDir?: string }) => 
      ipcRenderer.invoke('env:create', options),
    
    /** Handle a user query through the agent */
    handleQuery: (query: string, context?: { sessionId?: string; agentType?: string }) =>
      ipcRenderer.invoke('env:handleQuery', query, context),
    
    /** Get environment status */
    getStatus: () => ipcRenderer.invoke('env:getStatus'),
    
    /** Dispose the environment */
    dispose: () => ipcRenderer.invoke('env:dispose'),
    
    /** Set up IPC sender for event forwarding */
    setIpcSender: () => ipcRenderer.invoke('env:setIpcSender'),
    
    /** Get desktop component API */
    getDesktopComponent: () => ipcRenderer.invoke('env:getDesktopComponent'),
    
    /** Set event types to subscribe */
    setEventTypes: (types: string[]) => ipcRenderer.invoke('env:setEventTypes', types),
    
    /** Set events enabled */
    setEventsEnabled: (enabled: boolean) => ipcRenderer.invoke('env:setEventsEnabled', enabled),
  },
  
  // ===== Window State Listeners =====
  onMaximizeChange: (callback: (isMaximized: boolean) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, isMaximized: boolean) => callback(isMaximized);
    ipcRenderer.on('window:maximizeChanged', handler);
    return () => ipcRenderer.removeListener('window:maximizeChanged', handler);
  },
  
  // ===== Event Listeners (for environment events) =====
  onEvent: (callback: (...args: unknown[]) => void) => {
    // 检查 callback 是否是有效的函数
    if (typeof callback !== 'function') {
      console.error('[Preload] onEvent: callback is not a function:', typeof callback);
      return () => {};
    }
    
    console.log('[Preload] onEvent: registering callback, current handlers:', eventHandlers.size);
    
    // Create handler that wraps the callback
    const handler = function(_event: Electron.IpcRendererEvent, ...args: unknown[]) {
      console.log('[Preload] env:event received, map size:', eventHandlers.size);
      
      // Find callback for this handler - iterate to find the correct one
      let foundCallback: typeof callback | null = null;
      for (const [key, value] of eventHandlers.entries()) {
        if (value === handler) {
          foundCallback = key;
          break;
        }
      }
      
      if (!foundCallback) {
        console.error('[Preload] ERROR: callback not found for handler');
        return;
      }
      
      console.log('[Preload] Found callback, type:', typeof foundCallback);
      
      if (typeof foundCallback !== 'function') {
        console.error('[Preload] ERROR: foundCallback is not a function:', typeof foundCallback);
        return;
      }
      
      try {
        foundCallback(...args);
      } catch (err) {
        console.error('[Preload] callback error:', err);
      }
    };
    
    // Store the handler mapping for later removal
    eventHandlers.set(callback, handler);
    ipcRenderer.on('env:event', handler);
    ipcRenderer.on('env:eventTypesChanged', handler);
    console.log('[Preload] onEvent registered, total handlers:', eventHandlers.size);
    
    // Return unsubscribe function
    return () => {
      const storedHandler = eventHandlers.get(callback);
      if (storedHandler) {
        ipcRenderer.removeListener('env:event', storedHandler);
        ipcRenderer.removeListener('env:eventTypesChanged', storedHandler);
        eventHandlers.delete(callback);
        console.log('[Preload] offEvent: handler removed, remaining:', eventHandlers.size);
      }
    };
  },
  
  offEvent: (callback: (...args: unknown[]) => void) => {
    console.log('[Preload] offEvent called (legacy)');
    const handler = eventHandlers.get(callback);
    if (handler) {
      ipcRenderer.removeListener('env:event', handler);
      ipcRenderer.removeListener('env:eventTypesChanged', handler);
      eventHandlers.delete(callback);
      console.log('[Preload] offEvent: handler removed');
    }
  },
  
  // Error listeners
  onError: (callback: (error: { code: string; message: string; details?: unknown }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, error: { code: string; message: string; details?: unknown }) => callback(error);
    errorHandlers.set(callback, handler);
    ipcRenderer.on('env:error', handler);
  },
  
  offError: (callback: (error: { code: string; message: string; details?: unknown }) => void) => {
    const handler = errorHandlers.get(callback);
    if (handler) {
      ipcRenderer.removeListener('env:error', handler);
      errorHandlers.delete(callback);
    }
  },
  
  // ===== Platform Info =====
  platform: process.platform,
  isElectron: true,
});

// Type definitions for TypeScript
declare global {
  interface Window {
    electronAPI: {
      // App info
      getAppInfo: () => Promise<{ name: string; version: string; platform: string; arch: string }>;
      
      // Path utilities
      getUserDataPath: () => Promise<string>;
      getAppDataPath: () => Promise<string>;
      getTempPath: () => Promise<string>;
      getHomePath: () => Promise<string>;
      
      // File system
      readFile: (filePath: string) => Promise<string>;
      writeFile: (filePath: string, data: string) => Promise<boolean>;
      fileExists: (filePath: string) => Promise<boolean>;
      mkdir: (dirPath: string, options?: { recursive?: boolean }) => Promise<boolean>;
      readDir: (dirPath: string) => Promise<Array<{ name: string; isDirectory: boolean; isFile: boolean; path: string }>>;
      
      // Shell
      openExternal: (url: string) => Promise<boolean>;
      
      // Window controls
      minimizeWindow: () => Promise<void>;
      maximizeWindow: () => Promise<void>;
      closeWindow: () => Promise<void>;
      isWindowMaximized: () => Promise<boolean>;
      
      // Notifications
      showNotification: (title: string, body: string) => Promise<boolean>;
      
      // SQLite
      sqlite: {
        open: (dbPath: string) => Promise<string>;
        run: (dbId: string, sql: string, params?: unknown[]) => Promise<{ lastInsertRowid: number | bigint; changes: number }>;
        select: (dbId: string, sql: string, params?: unknown[]) => Promise<unknown[]>;
        close: (dbId: string) => Promise<boolean>;
      };
      
      // Key-value store
      store: {
        get: (key: string) => Promise<unknown>;
        set: (key: string, value: unknown) => Promise<boolean>;
        delete: (key: string) => Promise<boolean>;
      };
      
      // Desktop Environment (Core)
      environment: {
        create: (options?: { envName?: string; configDir?: string }) => Promise<{ success: boolean }>;
        handleQuery: (query: string, context?: { sessionId?: string; agentType?: string }) => Promise<string>;
        getStatus: () => Promise<{ initialized: boolean; envName?: string }>;
        dispose: () => Promise<{ success: boolean }>;
        setIpcSender: () => Promise<{ success: boolean }>;
        getDesktopComponent: () => Promise<{ eventTypes: string[]; enabled: boolean; error?: string }>;
        setEventTypes: (types: string[]) => Promise<{ success: boolean }>;
        setEventsEnabled: (enabled: boolean) => Promise<{ success: boolean }>;
      };
      
      // Window state listeners
      onMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void;
      
      // Error listeners
      onError: (callback: (error: { code: string; message: string; details?: unknown }) => void) => void;
      offError: (callback: (error: { code: string; message: string; details?: unknown }) => void) => void;
      
      // Platform info
      platform: string;
      isElectron: boolean;
    };
  }
}
