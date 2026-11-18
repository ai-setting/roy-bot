/**
 * @fileoverview Tests for DesktopEnvironmentAdapter
 * 
 * Tests for DesktopEnvironment Electron Adapter
 * 
 * This adapter bridges the DesktopEnvironmentService with Electron's IPC API.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ElectronAPI } from '../../src/electron/types';

// Mock ElectronAPI
const mockElectronAPI: ElectronAPI = {
  getAppInfo: vi.fn(),
  getUserDataPath: vi.fn(),
  getAppDataPath: vi.fn(),
  getTempPath: vi.fn(),
  getHomePath: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  fileExists: vi.fn(),
  mkdir: vi.fn(),
  readDir: vi.fn(),
  openExternal: vi.fn(),
  minimizeWindow: vi.fn(),
  maximizeWindow: vi.fn(),
  closeWindow: vi.fn(),
  isWindowMaximized: vi.fn(),
  showNotification: vi.fn(),
  sqlite: {
    open: vi.fn(),
    run: vi.fn(),
    select: vi.fn(),
    close: vi.fn(),
  },
  store: {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
  },
  onMaximizeChange: vi.fn(),
  platform: 'linux',
  isElectron: true,
  // Environment API (optional for this adapter)
  environment: {
    create: vi.fn().mockResolvedValue({ success: true }),
    handleQuery: vi.fn().mockResolvedValue('response'),
    getStatus: vi.fn().mockResolvedValue({ initialized: true }),
    dispose: vi.fn().mockResolvedValue({ success: true }),
  },
};

beforeEach(() => {
  // Set up the mock on window before importing the adapter
  (globalThis as any).window = { electronAPI: mockElectronAPI };
  vi.clearAllMocks();
});

describe('DesktopEnvironmentAdapter', () => {
  describe('constructor', () => {
    it('should detect Electron environment', async () => {
      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      expect(adapter.isInElectron()).toBe(true);
    });
  });

  describe('getAppInfo()', () => {
    it('should return app info from electronAPI', async () => {
      const mockInfo = { name: 'Roy Agent', version: '1.0.0', platform: 'linux', arch: 'x64' };
      (mockElectronAPI.getAppInfo as any).mockResolvedValue(mockInfo);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const info = await adapter.getAppInfo();

      expect(info).toEqual(mockInfo);
      expect(mockElectronAPI.getAppInfo).toHaveBeenCalledTimes(1);
    });
  });

  describe('getDataPath()', () => {
    it('should return user data path', async () => {
      const mockPath = '/home/user/.roy-bot';
      (mockElectronAPI.getUserDataPath as any).mockResolvedValue(mockPath);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const path = await adapter.getDataPath();

      expect(path).toBe(mockPath);
    });
  });

  describe('getHomePath()', () => {
    it('should return home path', async () => {
      const mockPath = '/home/user';
      (mockElectronAPI.getHomePath as any).mockResolvedValue(mockPath);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const path = await adapter.getHomePath();

      expect(path).toBe(mockPath);
    });
  });

  describe('getTempPath()', () => {
    it('should return temp path', async () => {
      const mockPath = '/tmp';
      (mockElectronAPI.getTempPath as any).mockResolvedValue(mockPath);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const path = await adapter.getTempPath();

      expect(path).toBe(mockPath);
    });
  });

  describe('readConfig()', () => {
    it('should read config file from path', async () => {
      const mockConfig = { theme: 'dark', language: 'en' };
      
      (mockElectronAPI.readFile as any).mockResolvedValue(JSON.stringify(mockConfig));

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const config = await adapter.readConfig('/path/to/config.json');

      expect(config).toEqual(mockConfig);
    });

    it('should return null if config file does not exist', async () => {
      (mockElectronAPI.readFile as any).mockRejectedValue(new Error('File not found'));

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const config = await adapter.readConfig('/path/to/config.json');

      expect(config).toBeNull();
    });
  });

  describe('writeConfig()', () => {
    it('should write config file to path', async () => {
      const config = { theme: 'dark', language: 'en' };
      
      (mockElectronAPI.writeFile as any).mockResolvedValue(true);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const result = await adapter.writeConfig('/path/to/config.json', config);

      expect(result).toBe(true);
    });
  });

  describe('showNotification()', () => {
    it('should show notification via electronAPI', async () => {
      (mockElectronAPI.showNotification as any).mockResolvedValue(true);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const result = await adapter.showNotification('Title', 'Body');

      expect(result).toBe(true);
      expect(mockElectronAPI.showNotification).toHaveBeenCalledWith('Title', 'Body');
    });
  });

  describe('window controls', () => {
    it('should minimize window', async () => {
      (mockElectronAPI.minimizeWindow as any).mockResolvedValue(undefined);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      await adapter.minimizeWindow();

      expect(mockElectronAPI.minimizeWindow).toHaveBeenCalledTimes(1);
    });

    it('should maximize window', async () => {
      (mockElectronAPI.maximizeWindow as any).mockResolvedValue(undefined);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      await adapter.maximizeWindow();

      expect(mockElectronAPI.maximizeWindow).toHaveBeenCalledTimes(1);
    });

    it('should close window', async () => {
      (mockElectronAPI.closeWindow as any).mockResolvedValue(undefined);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      await adapter.closeWindow();

      expect(mockElectronAPI.closeWindow).toHaveBeenCalledTimes(1);
    });

    it('should check window maximized state', async () => {
      (mockElectronAPI.isWindowMaximized as any).mockResolvedValue(true);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const isMax = await adapter.isWindowMaximized();

      expect(isMax).toBe(true);
    });

    it('should subscribe to maximize changes', async () => {
      const mockCallback = vi.fn();
      (mockElectronAPI.onMaximizeChange as any).mockReturnValue(() => {});

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      adapter.onMaximizeChange(mockCallback);

      expect(mockElectronAPI.onMaximizeChange).toHaveBeenCalledWith(mockCallback);
    });
  });

  describe('SQLite operations', () => {
    it('should open database', async () => {
      const dbId = 'db_main';
      
      (mockElectronAPI.getUserDataPath as any).mockResolvedValue('/home/user/.roy-bot');
      (mockElectronAPI.sqlite.open as any).mockResolvedValue(dbId);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const result = await adapter.openDatabase('data.db');

      expect(result).toBe(dbId);
    });

    it('should run SQL statement', async () => {
      const mockResult = { lastInsertRowid: 1, changes: 1 };
      (mockElectronAPI.sqlite.run as any).mockResolvedValue(mockResult);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const result = await adapter.runSQL('db_123', 'INSERT INTO test VALUES (?)', ['value']);

      expect(result).toEqual(mockResult);
    });

    it('should select from database', async () => {
      const mockRows = [{ id: 1, name: 'test' }];
      (mockElectronAPI.sqlite.select as any).mockResolvedValue(mockRows);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const result = await adapter.select<typeof mockRows>('db_123', 'SELECT * FROM test');

      expect(result).toEqual(mockRows);
    });

    it('should close database', async () => {
      (mockElectronAPI.sqlite.close as any).mockResolvedValue(true);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const result = await adapter.closeDatabase('db_123');

      expect(result).toBe(true);
      expect(mockElectronAPI.sqlite.close).toHaveBeenCalledWith('db_123');
    });
  });

  describe('key-value store', () => {
    it('should get value from store', async () => {
      (mockElectronAPI.store.get as any).mockResolvedValue('value');

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const value = await adapter.getStoreValue('key');

      expect(value).toBe('value');
    });

    it('should set value in store', async () => {
      (mockElectronAPI.store.set as any).mockResolvedValue(true);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const result = await adapter.setStoreValue('key', 'value');

      expect(result).toBe(true);
    });

    it('should delete value from store', async () => {
      (mockElectronAPI.store.delete as any).mockResolvedValue(true);

      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      const result = await adapter.deleteStoreValue('key');

      expect(result).toBe(true);
    });
  });

  describe('getPlatform()', () => {
    it('should return platform', async () => {
      const { DesktopEnvironmentAdapter } = await import('../../src/electron/DesktopEnvironmentAdapter');
      const adapter = new DesktopEnvironmentAdapter();
      expect(adapter.getPlatform()).toBe('linux');
    });
  });
});
