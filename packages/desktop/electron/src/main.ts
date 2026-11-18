/**
 * Electron Main Process
 * 
 * Entry point for the Electron desktop application.
 * Sets up window management, IPC handlers, and native integrations.
 * 
 * Architecture:
 * - Main process: Core functionality (@ai-setting/roy-bot-core)
 * - Renderer process: UI only (React)
 * - Communication: IPC via preload script
 */

import { app, BrowserWindow, ipcMain, shell, Menu, Tray, nativeImage } from 'electron';
import path from 'path';
import fs from 'fs';

// Get the directory where this script is located
// In production (asar), we use app.getAppPath() to determine the base path
function getAppBasePath(): string {
  const appPath = app.getAppPath();
  // app.getAppPath() returns the path to the app directory
  // For asar: .../resources/app.asar
  // For unpacked: .../resources/app
  return appPath;
}

// Import DesktopEnvironment (core runs in main process)
import { getEnvironment } from './environment.js';

// Import SimpleStore (replaces electron-store)
import { SimpleStore } from './simple-store.js';

// Configure logging - use app.getPath for cross-platform compatibility
const logDir = path.join(app.getPath('userData'), 'logs');
if (!fs.existsSync(logDir)) {
  fs.mkdirSync(logDir, { recursive: true });
}
const logFile = path.join(logDir, `app-${new Date().toISOString().split('T')[0]}.log`);

function log(level: string, message: string, ...args: unknown[]) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] [${level}] ${message} ${args.map(a => JSON.stringify(a)).join(' ')}\n`;
  fs.appendFileSync(logFile, logMessage);
  console.log(logMessage.trim());
}

// Global references
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

// Determine if we're in development
const isDev = !app.isPackaged;

function createWindow() {
  log('INFO', 'Creating main window...');
  
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    title: 'Roy Agent Desktop',
    webPreferences: {
      // preload.cjs is in the same directory as main.js
      preload: path.join(getAppBasePath(), 'electron/dist/preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // Required for preload scripts
    },
    show: false, // Show when ready
    backgroundColor: '#1a1a2e',
  });

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    log('INFO', 'Window ready to show');
    mainWindow?.show();
  });

  // Load the app
  if (isDev) {
    // Development: load from Vite dev server
    mainWindow.loadURL('http://localhost:1420');
    mainWindow.webContents.openDevTools();
    log('INFO', 'Loaded dev server at http://localhost:1420');
  } else {
    // Production: load from built files
    // In asar: appPath is .../resources/app.asar
    // We need: appPath/dist/index.html
    const appPath = app.getAppPath();
    const indexPath = path.join(appPath, 'dist/index.html');
    log('INFO', `app.getAppPath(): ${appPath}`);
    log('INFO', `isDev: ${isDev}`);
    log('INFO', `Loading production build from: ${indexPath}`);
    mainWindow.loadFile(indexPath);
  }

  // Log webContents errors
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    log('ERROR', `Failed to load: ${errorCode} - ${errorDescription}`);
  });
  
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    log('ERROR', `Render process gone: ${details.reason}`);
  });
  
  // Capture console messages from renderer
  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const levelStr = ['VERBOSE', 'INFO', 'WARN', 'ERROR'][level] || 'LOG';
    log(levelStr, `[Renderer] ${message}`);
  });

  // Handle external links
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Notify renderer of maximize state changes
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:maximizeChanged', true);
  });

  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:maximizeChanged', false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function createTray() {
  // Create a simple tray icon (16x16 data URL)
  const iconDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAACXBIWXMAAAsTAAALEwEAmpwYAAABN0lEQVQ4y6WTvUoDQRSFv7tZYhQVxMLCQrCwsLGwsRP8A/4CC0EQBAuxsLHwF1hYWFhYWNj4BgRBsLCwECwsxMLCQhALsRBbzCTZnd0kFovZ5Cbh3nPPnHvPzDCKoiiK8o8hAPh/ALgPYD+AFQBjAKYBHAFYAPAM4B7AcwBLvq8fAbxFUT8bOIBDAOsAJgGMeV7LAuAYwCGAQwD7AAZcX78E4AnAIoCp6OsHgE0AUwDGXO9lFcAagM8AVgFMeF5LAzAHYAnAaPT1G4A1AOMAxj2vHQJYAPADwCqAcddrKQBmACwDGI++fgWwAmAcwITTtTQAMwCWAYxGX78CWAEwDmDc6VoagBkAywBGI3EtDcA0gGUAI+HXUgBMA1gGMBx+7R3ABIBVAEPh194ADANYBfA6/Fos+vopgGEAKwD6w6+9AhgCsAKgL/zaC4BBACsA+sKvPQM4ALAKoC/8Wj+A4fBr/QAGwq/dAzgAsAKgL/zaPYADACv/i+/HfwA7c7EAAAAASUVORK5CYII=';
  
  try {
    const icon = nativeImage.createFromDataURL(iconDataUrl);
    tray = new Tray(icon);
    
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Roy Agent',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          }
        }
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit();
        }
      }
    ]);
    
    tray.setToolTip('Roy Agent Desktop');
    tray.setContextMenu(contextMenu);
    
    tray.on('click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
    
    log('INFO', 'System tray created');
  } catch (err) {
    log('WARN', 'Failed to create tray:', err);
  }
}

// IPC Handlers
function setupIpcHandlers() {
  log('INFO', 'Setting up IPC handlers...');
  
  // ===== App Info =====
  ipcMain.handle('app:getInfo', () => ({
    name: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
  }));
  
  // ===== Path Utilities =====
  ipcMain.handle('path:getUserData', () => app.getPath('userData'));
  ipcMain.handle('path:getAppData', () => app.getPath('appData'));
  ipcMain.handle('path:getTemp', () => app.getPath('temp'));
  ipcMain.handle('path:getHome', () => app.getPath('home'));
  
  // ===== File System =====
  ipcMain.handle('fs:readFile', async (_event, filePath: string) => {
    try {
      return await fs.promises.readFile(filePath, 'utf-8');
    } catch (err) {
      log('ERROR', 'Failed to read file:', filePath, err);
      throw err;
    }
  });
  
  ipcMain.handle('fs:writeFile', async (_event, filePath: string, data: string) => {
    try {
      await fs.promises.writeFile(filePath, data, 'utf-8');
      return true;
    } catch (err) {
      log('ERROR', 'Failed to write file:', filePath, err);
      throw err;
    }
  });
  
  ipcMain.handle('fs:exists', async (_event, filePath: string) => {
    return fs.existsSync(filePath);
  });
  
  ipcMain.handle('fs:mkdir', async (_event, dirPath: string, options?: { recursive?: boolean }) => {
    try {
      await fs.promises.mkdir(dirPath, options);
      return true;
    } catch (err) {
      log('ERROR', 'Failed to mkdir:', dirPath, err);
      throw err;
    }
  });
  
  ipcMain.handle('fs:readDir', async (_event, dirPath: string) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
      return entries.map(entry => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isFile: entry.isFile(),
        path: path.join(dirPath, entry.name),
      }));
    } catch (err) {
      log('ERROR', 'Failed to read dir:', dirPath, err);
      throw err;
    }
  });
  
  // ===== Shell =====
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    await shell.openExternal(url);
    return true;
  });
  
  // ===== Window Controls =====
  ipcMain.handle('window:minimize', () => {
    mainWindow?.minimize();
  });
  
  ipcMain.handle('window:maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });
  
  ipcMain.handle('window:close', () => {
    mainWindow?.close();
  });
  
  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false;
  });
  
  // ===== Notifications =====
  ipcMain.handle('notification:show', async (_event, { title, body }: { title: string; body: string }) => {
    const { Notification } = await import('electron');
    new Notification({ title, body }).show();
    return true;
  });
  
  // ===== SQLite =====
  ipcMain.handle('sqlite:open', async (_event, dbPath: string) => {
    try {
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(dbPath);
      
      const dbId = `db_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      sqliteConnections.set(dbId, db);
      
      log('INFO', `Opened database: ${dbPath}`);
      return dbId;
    } catch (err) {
      log('ERROR', 'Failed to open database:', dbPath, err);
      throw err;
    }
  });
  
  ipcMain.handle('sqlite:run', async (_event, dbId: string, sql: string, params?: unknown[]) => {
    const db = sqliteConnections.get(dbId);
    if (!db) throw new Error(`Database not found: ${dbId}`);
    
    try {
      const result = db.prepare(sql).run(...(params || []));
      return { lastInsertRowid: result.lastInsertRowid, changes: result.changes };
    } catch (err) {
      log('ERROR', 'SQL error:', sql, err);
      throw err;
    }
  });
  
  ipcMain.handle('sqlite:select', async (_event, dbId: string, sql: string, params?: unknown[]) => {
    const db = sqliteConnections.get(dbId);
    if (!db) throw new Error(`Database not found: ${dbId}`);
    
    try {
      const stmt = db.prepare(sql);
      return params ? stmt.all(...params) : stmt.all();
    } catch (err) {
      log('ERROR', 'SQL error:', sql, err);
      throw err;
    }
  });
  
  ipcMain.handle('sqlite:close', async (_event, dbId: string) => {
    const db = sqliteConnections.get(dbId);
    if (db) {
      db.close();
      sqliteConnections.delete(dbId);
      log('INFO', `Closed database: ${dbId}`);
    }
    return true;
  });
  
  // ===== Key-Value Store =====
  ipcMain.handle('store:get', async (_event, key: string) => {
    return store.get(key);
  });
  
  ipcMain.handle('store:set', async (_event, key: string, value: unknown) => {
    store.set(key, value);
    return true;
  });
  
  ipcMain.handle('store:delete', async (_event, key: string) => {
    store.delete(key);
    return true;
  });
  
  // ===== Desktop Environment (Core) =====
  ipcMain.handle('env:create', async (_event, options?: { envName?: string; configDir?: string }) => {
    try {
      const env = getEnvironment();
      await env.create(options);
      return { success: true };
    } catch (err) {
      log('ERROR', 'Failed to create environment:', err);
      throw err;
    }
  });
  
  ipcMain.handle('env:handleQuery', async (_event, query: string, context?: { sessionId?: string; agentType?: string }) => {
    try {
      const env = getEnvironment();
      return await env.handleQuery(query, context);
    } catch (err) {
      log('ERROR', 'Failed to handle query:', err);
      throw err;
    }
  });
  
  ipcMain.handle('env:getStatus', async () => {
    const env = getEnvironment();
    return env.getStatus();
  });
  
  ipcMain.handle('env:dispose', async () => {
    try {
      const env = getEnvironment();
      await env.dispose();
      return { success: true };
    } catch (err) {
      log('ERROR', 'Failed to dispose environment:', err);
      throw err;
    }
  });
  
  // ===== Desktop Events =====
  // Set up IPC sender for forwarding events to renderer
  ipcMain.handle('env:setIpcSender', async (event) => {
    const env = getEnvironment();
    const sender = (channel: string, ...args: unknown[]) => {
      console.log(`[Main] IPC send: ${channel}`, args);
      event.sender.send(channel, ...args);
    };
    env.setIpcSender(sender);
    // Subscribe to Environment events after IPC sender is set
    env.subscribeToEvents();
    log('INFO', 'IPC sender set for event forwarding');
    return { success: true };
  });
  
  // Get desktop component API
  ipcMain.handle('env:getDesktopComponent', async () => {
    const env = getEnvironment();
    const desktopComp = env.getDesktopComponent();
    if (!desktopComp) {
      return { error: 'DesktopComponent not initialized' };
    }
    return {
      eventTypes: desktopComp.getEventTypes(),
      enabled: desktopComp.isEnabled(),
    };
  });
  
  // Set event types
  ipcMain.handle('env:setEventTypes', async (_event, types: string[]) => {
    const env = getEnvironment();
    const desktopComp = env.getDesktopComponent();
    if (!desktopComp) {
      throw new Error('DesktopComponent not initialized');
    }
    await desktopComp.setEventTypes(types);
    return { success: true };
  });
  
  // Set enabled
  ipcMain.handle('env:setEventsEnabled', async (_event, enabled: boolean) => {
    const env = getEnvironment();
    const desktopComp = env.getDesktopComponent();
    if (!desktopComp) {
      throw new Error('DesktopComponent not initialized');
    }
    await desktopComp.setEnabled(enabled);
    return { success: true };
  });
  
  log('INFO', 'IPC handlers registered');
}

// Store for key-value persistence
let store: {
  get: (key: string) => unknown;
  set: (key: string, value: unknown) => void;
  delete: (key: string) => void;
};

// SQLite connection map
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sqliteConnections = new Map<string, any>();

// Global error handler
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught exception:', error);
  if (error.stack) {
    console.error('[FATAL] Stack trace:', error.stack);
  }
  log('ERROR', 'Uncaught exception:', error.stack || error.message);
});

process.on('unhandledRejection', (reason: unknown) => {
  console.error('[FATAL] Unhandled rejection:', reason);
  if (reason instanceof Error) {
    console.error('[FATAL] Error name:', reason.name);
    console.error('[FATAL] Error message:', reason.message);
    console.error('[FATAL] Stack trace:', reason.stack);
  }
  log('ERROR', 'Unhandled rejection:', reason);
});

// App lifecycle
app.whenReady().then(async () => {
  log('INFO', 'App ready, starting initialization...');
  
  // Initialize store (using SimpleStore to avoid electron-store dependency issues)
  store = new SimpleStore();
  
  setupIpcHandlers();
  createWindow();
  createTray();
  
  app.on('activate', () => {
    // macOS: re-create window when dock icon clicked
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
  
  log('INFO', 'App initialization complete');
});

app.on('window-all-closed', () => {
  // Close all SQLite connections
  for (const [id, db] of sqliteConnections) {
    db.close();
    log('INFO', `Closed database: ${id}`);
  }
  sqliteConnections.clear();
  
  // Dispose environment
  getEnvironment().dispose().catch(err => {
    log('ERROR', 'Failed to dispose environment:', err);
  });
  
  // Quit on all platforms except macOS
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  log('INFO', 'App is quitting...');
});
