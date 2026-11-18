/**
 * @fileoverview Tests for ElectronAdapter
 * 
 * TDD RED: Tests for Electron API adapter
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isElectron, getElectronAPI, ElectronAPI, AppInfo, FileEntry } from '../../src/electron/types';

// Mock window.electronAPI
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
};

// Setup window.electronAPI before tests
beforeEach(() => {
  (globalThis as any).window = { electronAPI: mockElectronAPI };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('ElectronAdapter', () => {
  describe('isElectron()', () => {
    it('should return true when electronAPI exists', () => {
      expect(isElectron()).toBe(true);
    });

    it('should return false when electronAPI does not exist', () => {
      delete (globalThis as any).window.electronAPI;
      expect(isElectron()).toBe(false);
    });

    it('should return false when isElectron flag is false', () => {
      (globalThis as any).window = { electronAPI: { ...mockElectronAPI, isElectron: false } };
      expect(isElectron()).toBe(false);
    });
  });

  describe('getElectronAPI()', () => {
    it('should return electronAPI when in Electron environment', () => {
      const api = getElectronAPI();
      expect(api).toBe(mockElectronAPI);
    });

    it('should throw error when not in Electron environment', () => {
      delete (globalThis as any).window.electronAPI;
      expect(() => getElectronAPI()).toThrow('Not running in Electron environment');
    });
  });

  describe('App Info', () => {
    it('should get app info from electronAPI', async () => {
      const mockInfo: AppInfo = { name: 'Roy Agent', version: '1.0.0', platform: 'linux', arch: 'x64' };
      (mockElectronAPI.getAppInfo as any).mockResolvedValue(mockInfo);

      const api = getElectronAPI();
      const info = await api.getAppInfo();

      expect(info).toEqual(mockInfo);
      expect(mockElectronAPI.getAppInfo).toHaveBeenCalledTimes(1);
    });
  });

  describe('Path Utilities', () => {
    it('should get user data path', async () => {
      const mockPath = '/home/user/.roy-bot';
      (mockElectronAPI.getUserDataPath as any).mockResolvedValue(mockPath);

      const api = getElectronAPI();
      const path = await api.getUserDataPath();

      expect(path).toBe(mockPath);
      expect(mockElectronAPI.getUserDataPath).toHaveBeenCalledTimes(1);
    });

    it('should get home path', async () => {
      const mockPath = '/home/user';
      (mockElectronAPI.getHomePath as any).mockResolvedValue(mockPath);

      const api = getElectronAPI();
      const path = await api.getHomePath();

      expect(path).toBe(mockPath);
      expect(mockElectronAPI.getHomePath).toHaveBeenCalledTimes(1);
    });
  });

  describe('File System Operations', () => {
    it('should read file content', async () => {
      const mockContent = 'file content';
      (mockElectronAPI.readFile as any).mockResolvedValue(mockContent);

      const api = getElectronAPI();
      const content = await api.readFile('/path/to/file.txt');

      expect(content).toBe(mockContent);
      expect(mockElectronAPI.readFile).toHaveBeenCalledWith('/path/to/file.txt');
    });

    it('should write file content', async () => {
      (mockElectronAPI.writeFile as any).mockResolvedValue(true);

      const api = getElectronAPI();
      const result = await api.writeFile('/path/to/file.txt', 'content');

      expect(result).toBe(true);
      expect(mockElectronAPI.writeFile).toHaveBeenCalledWith('/path/to/file.txt', 'content');
    });

    it('should check if file exists', async () => {
      (mockElectronAPI.fileExists as any).mockResolvedValue(true);

      const api = getElectronAPI();
      const exists = await api.fileExists('/path/to/file.txt');

      expect(exists).toBe(true);
      expect(mockElectronAPI.fileExists).toHaveBeenCalledWith('/path/to/file.txt');
    });

    it('should create directory recursively', async () => {
      (mockElectronAPI.mkdir as any).mockResolvedValue(true);

      const api = getElectronAPI();
      const result = await api.mkdir('/path/to/new/dir', { recursive: true });

      expect(result).toBe(true);
      expect(mockElectronAPI.mkdir).toHaveBeenCalledWith('/path/to/new/dir', { recursive: true });
    });

    it('should read directory contents', async () => {
      const mockEntries: FileEntry[] = [
        { name: 'file.txt', isDirectory: false, isFile: true, path: '/path/file.txt' },
        { name: 'subdir', isDirectory: true, isFile: false, path: '/path/subdir' },
      ];
      (mockElectronAPI.readDir as any).mockResolvedValue(mockEntries);

      const api = getElectronAPI();
      const entries = await api.readDir('/path');

      expect(entries).toEqual(mockEntries);
      expect(mockElectronAPI.readDir).toHaveBeenCalledWith('/path');
    });
  });

  describe('Window Controls', () => {
    it('should minimize window', async () => {
      (mockElectronAPI.minimizeWindow as any).mockResolvedValue(undefined);

      const api = getElectronAPI();
      await api.minimizeWindow();

      expect(mockElectronAPI.minimizeWindow).toHaveBeenCalledTimes(1);
    });

    it('should maximize window', async () => {
      (mockElectronAPI.maximizeWindow as any).mockResolvedValue(undefined);

      const api = getElectronAPI();
      await api.maximizeWindow();

      expect(mockElectronAPI.maximizeWindow).toHaveBeenCalledTimes(1);
    });

    it('should close window', async () => {
      (mockElectronAPI.closeWindow as any).mockResolvedValue(undefined);

      const api = getElectronAPI();
      await api.closeWindow();

      expect(mockElectronAPI.closeWindow).toHaveBeenCalledTimes(1);
    });

    it('should check if window is maximized', async () => {
      (mockElectronAPI.isWindowMaximized as any).mockResolvedValue(true);

      const api = getElectronAPI();
      const isMax = await api.isWindowMaximized();

      expect(isMax).toBe(true);
      expect(mockElectronAPI.isWindowMaximized).toHaveBeenCalledTimes(1);
    });
  });

  describe('Notifications', () => {
    it('should show notification', async () => {
      (mockElectronAPI.showNotification as any).mockResolvedValue(true);

      const api = getElectronAPI();
      const result = await api.showNotification('Title', 'Body');

      expect(result).toBe(true);
      expect(mockElectronAPI.showNotification).toHaveBeenCalledWith('Title', 'Body');
    });
  });

  describe('SQLite Operations', () => {
    it('should open database', async () => {
      const dbId = 'db_123';
      (mockElectronAPI.sqlite.open as any).mockResolvedValue(dbId);

      const api = getElectronAPI();
      const result = await api.sqlite.open('/path/to/db.sqlite');

      expect(result).toBe(dbId);
      expect(mockElectronAPI.sqlite.open).toHaveBeenCalledWith('/path/to/db.sqlite');
    });

    it('should run SQL statement', async () => {
      const mockResult = { lastInsertRowid: 1, changes: 1 };
      (mockElectronAPI.sqlite.run as any).mockResolvedValue(mockResult);

      const api = getElectronAPI();
      const result = await api.sqlite.run('db_123', 'INSERT INTO test VALUES (?)', ['value']);

      expect(result).toEqual(mockResult);
      expect(mockElectronAPI.sqlite.run).toHaveBeenCalledWith('db_123', 'INSERT INTO test VALUES (?)', ['value']);
    });

    it('should select from database', async () => {
      const mockRows = [{ id: 1, name: 'test' }];
      (mockElectronAPI.sqlite.select as any).mockResolvedValue(mockRows);

      const api = getElectronAPI();
      const result = await api.sqlite.select('db_123', 'SELECT * FROM test');

      expect(result).toEqual(mockRows);
      expect(mockElectronAPI.sqlite.select).toHaveBeenCalledWith('db_123', 'SELECT * FROM test');
    });

    it('should close database', async () => {
      (mockElectronAPI.sqlite.close as any).mockResolvedValue(true);

      const api = getElectronAPI();
      const result = await api.sqlite.close('db_123');

      expect(result).toBe(true);
      expect(mockElectronAPI.sqlite.close).toHaveBeenCalledWith('db_123');
    });
  });

  describe('Store Operations', () => {
    it('should get value from store', async () => {
      (mockElectronAPI.store.get as any).mockResolvedValue('stored_value');

      const api = getElectronAPI();
      const value = await api.store.get('key');

      expect(value).toBe('stored_value');
      expect(mockElectronAPI.store.get).toHaveBeenCalledWith('key');
    });

    it('should set value in store', async () => {
      (mockElectronAPI.store.set as any).mockResolvedValue(true);

      const api = getElectronAPI();
      const result = await api.store.set('key', 'value');

      expect(result).toBe(true);
      expect(mockElectronAPI.store.set).toHaveBeenCalledWith('key', 'value');
    });

    it('should delete value from store', async () => {
      (mockElectronAPI.store.delete as any).mockResolvedValue(true);

      const api = getElectronAPI();
      const result = await api.store.delete('key');

      expect(result).toBe(true);
      expect(mockElectronAPI.store.delete).toHaveBeenCalledWith('key');
    });
  });
});
