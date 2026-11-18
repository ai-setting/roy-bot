/**
 * @fileoverview LSP Client 实现
 * 
 * 使用 vscode-jsonrpc 与 LSP 服务器通信
 */

import { spawn, ChildProcess } from "child_process";
import { createMessageConnection, MessageConnection } from "vscode-jsonrpc";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/lib/node/main.js";
import { pathToFileURL } from "url";
import path from "path";
import fs from "fs";
import { getLanguageId } from "./language-map";
import type { LSPServerInfo, Diagnostic, Range, Position, DiagnosticSeverity } from "../types/linter";

// VSCode LSP 类型
interface PublishDiagnosticsParams {
  uri: string;
  diagnostics: RawDiagnostic[];
}

interface RawDiagnostic {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity?: number;
  code?: number | string;
  source?: string;
  message: string;
}

interface TextDocumentItem {
  uri: string;
  languageId: string;
  version: number;
  text: string;
}

interface DidOpenTextDocumentParams {
  textDocument: TextDocumentItem;
}

/**
 * LSP Client
 * 
 * 封装与 LSP 服务器的 JSON-RPC 通信
 */
export class LSPClient {
  /**
   * JSON-RPC 连接（protected：允许子类在 setupNotificationHandlers 里
   * 注册额外的 server 专属请求/通知处理器，例如 markdown 的 markdown/parse）
   */
  protected connection: MessageConnection;
  /** Server 元信息（protected：子类可读取自身配置）*/
  protected serverInfo: LSPServerInfo;
  /** 工作区 root URI（protected：子类需要在 workspaceFolders 等处使用）*/
  protected rootUri: string;
  private pendingDiagnostics: Map<string, RawDiagnostic[]>;
  private openDocuments: Set<string>;  // 跟踪已打开的文档 URI
  private lastUsed: number;
  private disposed: boolean = false;
  private process: ChildProcess;  // 保存进程引用用于清理
  
  /** 诊断请求序列号（递增） */
  private _requestIdCounter: number = 0;
  
  /** 是否已完成 LSP 初始化握手 */
  private _initialized: boolean = false;
  
  /** 初始化超时时间（毫秒），默认 2000ms（替代原来的硬编码 5000ms） */
  private _initTimeout: number;
  
  /** 初始化 Promise 守卫，防止并发 initialize() 调用 */
  private _initPromise: Promise<void> | null = null;

  constructor(process: ChildProcess, serverInfo: LSPServerInfo, rootUri: string, initTimeout?: number) {
    this._initTimeout = initTimeout ?? 2000;
    this.serverInfo = serverInfo;
    this.rootUri = rootUri;
    this.process = process;  // 保存进程引用
    this.pendingDiagnostics = new Map();
    this.openDocuments = new Set();
    this.lastUsed = Date.now();
    this.disposed = false;

    // 【同步预检】在注册异步 listener 之前，先检查子进程是否已死
    // 避免子进程在 listener 注册前已死（OOM、kill、依赖丢失）时事件被吞掉，
    // 导致 disposed 永远是 false，进而后续写入已死流报 ERR_STREAM_DESTROYED
    // 使用宽松比较 `!= null`（同时排除 null 和 undefined），以便 mock 中省略字段
    // （如 ChildProcess 类型未设 exitCode 时是 undefined）也能通过预检。
    if (!process.pid || process.exitCode != null || process.signalCode != null) {
      this.disposed = true;
      const reason = process.exitCode != null
        ? `exited with code ${process.exitCode}`
        : process.signalCode != null
          ? `killed by signal ${process.signalCode}`
          : "no pid (spawn failed)";
      throw new Error(`LSP process failed to start (${serverInfo.id}): ${reason}`);
    }

    // 监听进程退出事件，防止在进程退出后继续写入
    process.on("exit", (code, signal) => {
      console.debug(`[LSPClient] Server process exited: ${this.serverInfo.id}, code=${code}, signal=${signal}`);
      // 标记为已销毁，避免后续操作
      this.disposed = true;
    });

    // 监听进程错误，及时发现启动失败
    process.on("error", (err) => {
      console.error(`[LSPClient] Server process error: ${this.serverInfo.id} - ${err.message}`);
      this.disposed = true;
    });

    // 创建 JSON-RPC 连接
    const reader = new StreamMessageReader(process.stdout as any);
    const writer = new StreamMessageWriter(process.stdin as any);
    this.connection = createMessageConnection(reader, writer);

    // 设置通知处理器
    this.setupNotificationHandlers();

    // 开始监听
    this.connection.listen();
  }

  /**
   * 分配新的请求序列号
   */
  private allocateRequestId(): number {
    return ++this._requestIdCounter;
  }

  /**
   * 设置通知处理器
   *
   * 子类可重写此方法以注册额外的 server 专属处理器，
   * 通常做法是先调用 `super.setupNotificationHandlers()`
   * 再注册自己的处理器（例如 markdown LSP 的 `markdown/parse` 请求）。
   */
  protected setupNotificationHandlers(): void {
    // 处理 publishDiagnostics 通知
    this.connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: PublishDiagnosticsParams) => {
        const uri = params.uri;
        
        // 获取当前活跃请求的版本号
        // 只有当前活跃请求（发起 didChange 的请求）才能接收这个诊断
        const currentVersion = this.activeRequestId;
        
        // 存储诊断结果，带上版本号标记
        // 这个诊断是针对 currentVersion 对应的请求的
        this.diagnosticsWithVersion.set(uri, {
          version: currentVersion,
          diagnostics: params.diagnostics,
        });
        
        // 保留向后兼容：同时存储到 pendingDiagnostics
        this.pendingDiagnostics.set(uri, params.diagnostics);
      }
    );

    // 处理 window/logMessage 通知（用于调试）
    this.connection.onNotification("window/logMessage", (params: { type: number; message: string }) => {
      // 根据类型过滤日志级别
      // 1 = Error, 2 = Warning, 3 = Info, 4 = Log
      if (params.type <= 3) {
        console.log(`[LSPClient] Server (${params.type}): ${params.message}`);
      }
    });

    // 处理 window/workDoneProgress/create 请求
    this.connection.onRequest("window/workDoneProgress/create", () => {
      return null;
    });

    // 处理 workspace/configuration 请求
    this.connection.onRequest("workspace/configuration", async () => {
      return [this.serverInfo.initializationOptions ?? {}];
    });

    // 处理 workspace/workspaceFolders 请求
    this.connection.onRequest("workspace/workspaceFolders", async () => {
      return [
        {
          name: "workspace",
          uri: this.rootUri,
        },
      ];
    });

    // 处理 client/registerCapability 请求
    this.connection.onRequest("client/registerCapability", async () => {});

    // 处理 client/unregisterCapability 请求
    this.connection.onRequest("client/unregisterCapability", async () => {});
  }

  /**
   * 初始化 LSP 会话
   *
   * 优化说明：
   * - 支持幂等调用：已初始化后再次调用直接返回
   * - 移除硬编码 5000ms 等待，改用可配置的 initTimeout（默认 2000ms）
   * - 使用 Promise.race 实现超时机制，避免永久阻塞
   */
  async initialize(): Promise<void> {
    // 幂等：如果已经初始化，直接返回
    if (this._initialized) {
      return;
    }
    
    // Promise 守卫：防止并发 initialize() 调用
    // 如果已有初始化进行中，复用同一个 Promise
    if (this._initPromise) {
      return this._initPromise;
    }

    // 检查进程是否已经退出
    if (this.disposed || this.process.exitCode !== null) {
      throw new Error(`LSP initialize failed: Server process for ${this.serverInfo.id} has exited`);
    }

    this._initPromise = this._doInitialize();
    return this._initPromise;
  }

  /**
   * 实际的初始化逻辑（由 initialize() 通过 _initPromise 守卫调用）
   */
  private async _doInitialize(): Promise<void> {
    try {
      // 为 TypeScript 服务器准备初始化选项
      let initOptions = this.serverInfo.initializationOptions ?? {};

      // 如果是 TypeScript 服务器，设置全局 TypeScript 路径
      if (this.serverInfo.id === "typescript") {
        const tsPath = this.findGlobalTypeScript();
        if (tsPath) {
          initOptions = {
            ...initOptions,
            // typescript-language-server 配置
            tsserver: {
              path: tsPath,
            },
            // 兼容旧版本
            typescript: {
              tsdk: tsPath,
            },
          };
        }
      }

      await this.connection.sendRequest("initialize", {
        processId: process.pid,
        rootUri: this.rootUri,
        rootPath: this.rootUri,
        workspaceFolders: [
          {
            name: "workspace",
            uri: this.rootUri,
          },
        ],
        initializationOptions: initOptions,
        capabilities: {
          window: {
            workDoneProgress: true,
          },
          workspace: {
            configuration: true,
            workspaceFolders: true,
            didChangeWatchedFiles: {
              dynamicRegistration: true,
            },
          },
          textDocument: {
            synchronization: {
              didOpen: true,
              didChange: true,
            },
            publishDiagnostics: {
              versionSupport: true,
            },
          },
        },
      });

      await this.connection.sendNotification("initialized", {});

      // 使用可配置的超时等待服务器初始化，替代原来的硬编码 5000ms
      // 通过 Promise.race 实现：在 initTimeout 内等待服务器就绪
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          // 超时后继续，不阻塞初始化流程
          // 服务器可能仍在后台初始化，但我们可以继续发送配置
          resolve();
        }, this._initTimeout);

        // 监听 connection 的 end 事件，如果连接提前断开则快速失败
        const onEnd = () => {
          clearTimeout(timer);
          reject(new Error("LSP connection ended during initialization"));
        };
        this.connection.onDispose(onEnd);

        // 使用 unref 让定时器不阻止进程退出
        if (typeof timer === "object" && "unref" in timer) {
          (timer as any).unref();
        }
        
        // 清理 onDispose 回调：Promise settled 后移除
        // 使用 finally 确保无论 resolve/reject 都清理
        const cleanup = () => {
          try { this.connection.onDispose(() => {}); } catch { /* ignore */ }
        };
        // 注意：vscode-jsonrpc 的 onDispose 注册的是永久监听器，
        // 无法直接移除。但 Promise settled 后 onEnd 不会再造成实际影响，
        // 因为 timer 已被 clearTimeout，reject 也已无效果。
        // 这里通过 resolve/reject 的 finally 来标记清理意图。
        Promise.resolve().then(cleanup);
      }).catch(() => {
        // 忽略超时/断开错误，继续初始化流程
      });

      // 发送初始配置
      if (this.serverInfo.initializationOptions) {
        await this.connection.sendNotification("workspace/didChangeConfiguration", {
          settings: this.serverInfo.initializationOptions,
        });
      }

      // 钩子：让子类在 initialize 流程末尾追加 server 专属逻辑
      // （例如 markdown LSP 需要发送 markdown.validate.* 设置启用诊断）
      await this.afterInitialized();

      // 标记初始化完成
      this._initialized = true;
    } catch (error) {
      // 初始化失败时重置 _initPromise，允许重试
      this._initPromise = null;
      throw new Error(`LSP initialize failed: ${error}`);
    }
  }

  /**
   * initialize 流程完成后的扩展钩子
   *
   * 在 server 已 `initialized`、等待完成、且 `initializationOptions` 已通过
   * `workspace/didChangeConfiguration` 发送之后调用。默认空实现，子类可重写。
   */
  protected async afterInitialized(): Promise<void> {
    // 默认无操作，子类按需重写
  }

  /**
   * NEW-2: 发送 JSON-RPC 请求并支持超时控制。
   *
   * 与直接调用 `this.connection.sendRequest` 不同，本方法使用 Promise.race
   * 在 `timeoutMs` 毫秒后强制 reject 防止 LSP server 挂起导致调用方 hang。
   *
   * @param method JSON-RPC 方法名
   * @param params 方法参数
   * @param timeoutMs 超时毫秒数，默认 30000
   * @returns server 响应结果
   * @throws {Error} 超时时抛出 `LSP request timeout: <method>` 错误
   */
  async sendRequest<T = unknown>(
    method: string,
    params?: unknown,
    timeoutMs: number = 30_000,
  ): Promise<T> {
    const responsePromise = this.connection.sendRequest(method, params);
    let timer: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`LSP request timeout: ${method}`)),
        timeoutMs,
      );
      // 防止 timer 阻止进程退出
      timer.unref?.();
    });
    try {
      return (await Promise.race([responsePromise, timeoutPromise])) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * 文档版本号追踪
   * 按 URI 索引，每次文档内容变化时递增
   */
  private documentVersions: Map<string, number> = new Map();
  
  /**
   * 诊断结果存储（带版本标记）
   * 用于解决并发请求时的诊断同步问题
   */
  private diagnosticsWithVersion: Map<string, { version: number; diagnostics: RawDiagnostic[] }> = new Map();
  
  /**
   * 活跃的请求追踪
   * 用于确保每个请求只返回自己的诊断结果
   */
  private activeRequestId: number = 0;

  /**
   * 打开文档
   */
  async openDocument(filePath: string, text?: string): Promise<void> {
    // 检查连接是否仍然有效
    if (this.disposed) {
      throw new Error(`LSP openDocument failed: Connection for ${this.serverInfo.id} has been disposed`);
    }

    this.lastUsed = Date.now();

    const uri = pathToFileURL(filePath).href;

    // 检查文档是否已经打开，避免重复打开
    if (this.openDocuments.has(uri)) {
      // 文档已打开，检查是否需要更新内容
      // 对于诊断场景，我们主要关心内容是否是最新的

      // 如果提供了新文本，发送 didChange 通知
      if (text) {
        const version = (this.documentVersions.get(uri) ?? 1) + 1;
        this.documentVersions.set(uri, version);

        await this.connection.sendNotification("textDocument/didChange", {
          textDocument: {
            uri,
            version,
          },
          contentChanges: [{ text }],
        });
      }
      return;
    }

    // 如果没有提供文本，读取文件
    if (!text) {
      const fs = await import("fs/promises");
      text = await fs.readFile(filePath, "utf-8");
    }

    const languageId = getLanguageId(filePath);

    // 初始化版本号为 1
    this.documentVersions.set(uri, 1);

    // 清空该 URI 的旧诊断，因为新打开的文档可能内容不同
    // TypeScript 语言服务器会发送新的 publishDiagnostics 通知
    this.pendingDiagnostics.delete(uri);

    await this.connection.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId,
        version: 1,
        text,
      },
    } as DidOpenTextDocumentParams);

    // 标记文档为已打开
    this.openDocuments.add(uri);
  }

  /**
   * 获取诊断信息
   * 
   * 使用请求序列号机制确保诊断同步：
   * 1. 分配请求序列号
   * 2. 设置为当前活跃请求
   * 3. 发送 didChange 触发 LSP 服务器重新分析
   * 4. 只返回与当前序列号匹配的诊断
   */
  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    // 检查连接是否仍然有效
    if (this.disposed) {
      console.warn(`[LSPClient] getDiagnostics skipped: Connection for ${this.serverInfo.id} has been disposed`);
      return [];
    }

    this.lastUsed = Date.now();

    // 读取文件的最新内容，确保 LSP 服务器分析的是最新代码
    let fileContent: string;
    try {
      fileContent = await fs.promises.readFile(filePath, "utf-8");
    } catch (error) {
      // 文件不存在或读取失败时返回空诊断
      return [];
    }

    const diagnosticsUri = pathToFileURL(filePath).href;
    
    // 【关键修复】分配请求序列号
    const requestId = this.allocateRequestId();
    
    // 【关键修复】设置当前活跃请求
    // 后续的 publishDiagnostics 通知会被标记上这个序列号
    this.activeRequestId = requestId;
    
    // 【关键修复】清除该 URI 的旧诊断
    // 只有当前请求的诊断才会被返回
    this.diagnosticsWithVersion.delete(diagnosticsUri);
    this.pendingDiagnostics.delete(diagnosticsUri);

    // 确保文档已打开并传入最新内容
    // 这会触发 textDocument/didChange 通知让 LSP 服务器重新分析
    // 注意：openDocument 内部也会递增 documentVersions
    await this.openDocument(filePath, fileContent);

    // 【关键修复】等待服务器处理诊断
    // 只返回与当前请求序列号匹配的诊断
    const maxWait = 30000; // 最多等待 30 秒（大型文件需要更长时间）
    const pollInterval = 500; // 每 500ms 检查一次
    const startTime = Date.now();

    while (Date.now() - startTime < maxWait) {
      // 【关键修复】检查是否有匹配当前请求序列号的诊断
      const versioned = this.diagnosticsWithVersion.get(diagnosticsUri);
      
      // 如果有诊断且版本匹配当前请求，返回诊断
      if (versioned && versioned.diagnostics && versioned.diagnostics.length > 0) {
        // 双重检查：确保版本号仍然匹配（可能已经被新请求覆盖）
        if (versioned.version === requestId) {
          return versioned.diagnostics.map((raw) => this.convertDiagnostic(raw));
        }
        // 版本不匹配，说明有新请求了，继续等待
      }
      
      // 也检查 pendingDiagnostics（向后兼容）
      const rawDiagnostics = this.pendingDiagnostics.get(diagnosticsUri);
      if (rawDiagnostics && rawDiagnostics.length > 0) {
        // 确保版本号匹配
        if (versioned && versioned.version === requestId) {
          return rawDiagnostics.map((raw) => this.convertDiagnostic(raw));
        }
        // 如果 versioned 不存在或版本不匹配，可能有竞态，使用 pendingDiagnostics
        // 但这不如 versioned 可靠
        if (!versioned) {
          return rawDiagnostics.map((raw) => this.convertDiagnostic(raw));
        }
      }
      
      await new Promise((resolve) => setTimeout(resolve, pollInterval));
    }

    // 超时后返回空数组
    return [];
  }

  /**
   * 转换诊断信息
   */
  private convertDiagnostic(raw: RawDiagnostic): Diagnostic {
    return {
      range: {
        start: {
          line: raw.range.start.line,
          character: raw.range.start.character,
        },
        end: {
          line: raw.range.end.line,
          character: raw.range.end.character,
        },
      },
      severity: (raw.severity ?? 1) as DiagnosticSeverity,
      code: raw.code,
      source: raw.source,
      message: raw.message,
    };
  }

  /**
   * 获取服务器 ID
   */
  getServerId(): string {
    return this.serverInfo.id;
  }

  /**
   * 获取最后使用时间
   */
  getLastUsed(): number {
    return this.lastUsed;
  }

  /**
   * 检查连接是否已释放
   */
  isDisposed(): boolean {
    // 除了 disposed 标志，还要检查进程是否已退出
    return this.disposed || this.process.exitCode !== null || this.process.signalCode !== null;
  }

  /**
   * 健康检查 - ping 连接验证
   *
   * 优化说明：
   * - 快速路径：如果 disposed 或进程已退出，立即返回 false
   * - 缩短超时：从 2000ms 降至 1000ms，减少连接复用时的等待
   * - 使用 unref 确保定时器不阻止进程退出
   *
   * @returns true 如果连接健康，false 如果连接已断开
   */
  async ping(): Promise<boolean> {
    // 快速路径：检查 disposed 状态
    if (this.disposed) {
      return false;
    }

    // 快速路径：检查进程是否已退出
    if (this.process.exitCode !== null || this.process.signalCode !== null) {
      this.disposed = true;
      return false;
    }

    try {
      // 设置较短的超时，避免长时间等待
      const timeoutPromise = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1000);
        if (typeof timer === "object" && "unref" in timer) {
          (timer as any).unref();
        }
      });

      const pingPromise = new Promise<boolean>(async (resolve) => {
        try {
          // 尝试发送一个简单的请求来验证连接
          await this.connection.sendRequest("window/showMessageRequest", {
            type: 1,
            message: "health check",
            actions: [],
          });
          resolve(true);
        } catch {
          // 如果请求失败，尝试使用 $/cancelRequest
          try {
            await this.connection.sendRequest("$/cancelRequest", {
              id: null,
            });
            resolve(true);
          } catch {
            resolve(false);
          }
        }
      });

      return await Promise.race([pingPromise, timeoutPromise]);
    } catch {
      return false;
    }
  }

  /**
   * 查找全局安装的 TypeScript 包路径
   */
  private findGlobalTypeScript(): string | null {
    // 尝试从 bun 全局包目录查找
    const bunGlobalPath = path.resolve(process.env.BUN_INSTALL ?? "~/.bun", "lib/node_modules/typescript");
    if (fs.existsSync(bunGlobalPath)) {
      return bunGlobalPath;
    }

    // 尝试从 npm 全局包目录查找
    const npmGlobalPath = path.resolve(process.env.NPM_CONFIG_PREFIX ?? "/usr/local", "lib/node_modules/typescript");
    if (fs.existsSync(npmGlobalPath)) {
      return npmGlobalPath;
    }

    // 尝试项目根目录的 node_modules/typescript
    const projectRoot = path.resolve(__dirname, "../../../../"); // 从 dist/lsp 到项目根
    const projectTSPath = path.join(projectRoot, "node_modules/typescript");
    if (fs.existsSync(projectTSPath)) {
      return projectTSPath;
    }

    // 尝试常见的全局包位置
    const commonPaths = [
      "~/.bun/lib/node_modules/typescript",
      "/usr/local/lib/node_modules/typescript",
      "/root/.npm-global/lib/node_modules/typescript",
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(p)) {
        return p;
      }
    }

    return null;
  }

  /**
   * 关闭连接
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    // 检查进程是否已经退出，避免在已退出的进程上写入导致 ERR_STREAM_DESTROYED
    const processExited = this.process.exitCode !== null;

    // 检查 stdin 是否仍然可写（避免向已销毁的流写入）
    const stdinWritable = !processExited && this.process.stdin && (this.process.stdin as any).writable !== false;

    if (stdinWritable) {
      try {
        // 添加超时机制，避免在测试环境中永久阻塞
        const timeoutPromise = new Promise<void>((resolve) => {
          setTimeout(() => resolve(), 100);
        });
        const shutdownPromise = this.connection.sendRequest("shutdown");
        await Promise.race([shutdownPromise, timeoutPromise]);
      } catch {
        // ignore - 可能服务器不支持 shutdown 或已断开
      }
    }

    // 只有在 stdin 可写时才发送 exit 通知
    if (stdinWritable) {
      try {
        this.connection.sendNotification("exit");
      } catch {
        // ignore
      }
    }

    this.connection.dispose();

    // 确保进程被终止（如果还没有退出）
    if (this.process && !this.process.killed) {
      try {
        this.process.kill("SIGTERM");
        // 给进程一点时间来退出
        setTimeout(() => {
          if (!this.process.killed) {
            this.process.kill("SIGKILL");
          }
        }, 100);
      } catch {
        // 进程可能已经退出，忽略错误
      }
    }
  }

  /**
   * 同步释放资源（用于进程退出时）
   */
  disposeSync(): void {
    if (this.disposed) return;
    this.disposed = true;

    try {
      this.connection.dispose();
    } catch {
      // ignore
    }

    // 强制终止进程
    if (this.process && !this.process.killed) {
      try {
        this.process.kill("SIGKILL");
      } catch {
        // 进程可能已经退出，忽略错误
      }
    }
  }
}

/**
 * 创建 LSP Client 并初始化
 */
export async function createLSPClient(
  process: ChildProcess,
  serverInfo: LSPServerInfo,
  rootUri: string,
  initTimeout?: number
): Promise<LSPClient> {
  // 若 serverInfo 提供了 clientFactory，则用它创建（支持 LSPClient 子类）；
  // 否则走默认实现。
  const client = serverInfo.clientFactory
    ? (serverInfo.clientFactory(process, serverInfo, rootUri, initTimeout) as LSPClient)
    : new LSPClient(process, serverInfo, rootUri, initTimeout);
  await client.initialize();
  return client;
}
