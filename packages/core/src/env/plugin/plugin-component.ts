/**
 * @fileoverview PluginComponent - 统一插件管理组件
 *
 * 提供统一的插件注册、注销、查询接口
 */

import { BaseComponent, type ComponentConfig } from "../component";
import { BasePlugin, type PluginEnv, type HookDefinition, type AgentInstanceConfig, type ToolDefinition, type HookHandler } from "./types";
import { globalHookManager } from "../hook/global-hook-manager";
import { createLogger } from "../log-trace/logger";
import type { ConfigComponent } from "../../config/config-component";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { getEnvContextOrEmpty } from "../context";
import type { AgentComponent } from "../agent/agent-component";
import type { ToolComponent } from "../tool/tool-component";
import {
  EventBusNotificationChannel,
} from "./event-bus-notification-channel";
import type {
  EnvContextLike,
  NotificationChannel,
  NotificationOptions,
  NotificationSendExtras,
} from "./notification-channel";

// ============================================================================
// Helpers: Version Drift Detection (Task #2903)
// ============================================================================

/**
 * 从 resolvedPath（指向 plugin 入口文件）向上查找最近的 package.json 并读取 version。
 *
 * **Task #2903 修复说明（version drift）**：
 * 实际加载的 plugin 代码可能与 plugins.json 声明的 version 不一致 —
 * 例如 `~/.roy-bot/node_modules/@scope/pkg/index.js` 是旧版 cp 副本
 * （v2.5.7），但 plugins.json 记的是新版本（v2.5.9）。这个 helper 通过
 * 入口路径找到最近的 package.json，读出真实 version，给上层做对比。
 *
 * 算法：从 resolvedPath 所在目录开始，向上走 dir.parent 直到文件系统根，
 *          命中第一个 package.json 即返回。
 *
 * 找不到 / 解析失败 → 返回 null（不抛异常）。
 *
 * 导出供测试调用。
 */
export function readActualVersion(resolvedPath: string): string | null {
  let dir = dirname(resolvedPath);
  // 防御：dirname("/") === "/"，会死循环
  const root = dirname(dir);
  while (dir !== root) {
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
        return pkg.version ?? null;
      } catch {
        // 解析失败就继续向上找（万一有 nested package.json）
        // 但实际工程里找到第一个就停更合理 — 防止 confusing
        return null;
      }
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * 对比 declared version vs loaded version，不一致时 warn。
 *
 * **Task #2903 修复说明（startup warn）**：
 * PluginComponent 启动时遍历 plugins.json，对每个插件做一次 version drift 校验。
 * 如果 loaded version 找不到（resolvedPath 无效），返回 { drifted: false } —
 * 这种情况下 import 都成功了，version 字段缺失是 plugin 自己的问题，不归我们管。
 *
 * 返回结构：
 *   { declared, actual, resolvedPath, drifted }
 *
 * - declared: plugins.json 声明的 version
 * - actual: 磁盘上 plugin 入口的 package.json 实际 version（找不到 = null）
 * - resolvedPath: 传入的入口路径（透传，方便用户诊断）
 * - drifted: actual != null && actual !== declared
 *
 * 如果 logger 提供且 drifted=true，会调 logger.warn 输出一行 warning。
 * warning 包含 packageName（推断自 resolvedPath 末段）、declared、actual、resolvedPath。
 *
 * 导出供测试调用。
 */
export interface VersionDriftLogger {
  warn: (msg: string) => void;
}

export function checkVersionDrift(
  declaredVersion: string,
  resolvedPath: string,
  logger?: VersionDriftLogger,
): { declared: string; actual: string | null; resolvedPath: string; drifted: boolean } {
  const actual = readActualVersion(resolvedPath);
  const drifted = actual !== null && actual !== declaredVersion;

  if (drifted && logger) {
    // 推断 packageName：从 resolvedPath 末段（去掉 @scope/ 的话保留整段）
    const pkgName = resolvedPath.includes("/node_modules/")
      ? resolvedPath.split("/node_modules/").pop() ?? resolvedPath
      : resolvedPath;
    logger.warn(
      `⚠️ Plugin '${pkgName}' version mismatch: declared ${declaredVersion} vs loaded ${actual} (path: ${resolvedPath})`
    );
  }

  return { declared: declaredVersion, actual, resolvedPath, drifted };
}

/**
 * PluginComponent 配置选项
 */
export interface PluginComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: ConfigComponent;

  /** 配置文件相对路径（可选） */
  configPath?: string;

  /** 环境变量前缀（可选，默认 "PLUGIN"）*/
  envPrefix?: string;
}

/**
 * PluginComponent - 统一插件管理组件
 *
 * 功能：
 * - 管理所有插件的注册和生命周期
 * - 提供统一的 PluginEnv 给每个插件
 * - 通过 --plugin 参数加载的插件都注册到此组件
 */
export class PluginComponent extends BaseComponent {
  name = "plugin";
  version = "1.0.0";

  /** 插件注册表 */
  private registry = new Map<string, BasePlugin>();

  /** 组件引用缓存 */
  private componentCache = new Map<string, any>();

  /** 日志器 */
  private logger = createLogger("plugin");

  /** ConfigComponent 引用 */
  private configComponent?: ConfigComponent;

  /**
   * NotificationChannel 列表（按顺序遍历，第一个 canRoute=true 的被选中）
   *
   * 默认 = [EventBusNotificationChannel()]
   *
   * LarkCliNotificationChannel（legacy）不在默认列表中 —— 它是 opt-in，
   * 需要通过 setNotificationChannels() 显式注册。
   */
  private notificationChannels: NotificationChannel[] = [
    new EventBusNotificationChannel(),
  ];

  constructor() {
    super();
  }

  /**
   * Initialize the component
   */
  async init(config?: ComponentConfig): Promise<void> {
    await super.init(config);

    const options = config?.options as unknown as PluginComponentOptions | undefined;
    if (!options?.configComponent) {
      throw new Error("ConfigComponent is required for PluginComponent initialization");
    }

    this.configComponent = options.configComponent;
    this.setStatus("running");

    // 启动时从 ~/.roy-bot/plugins.json 加载已安装的插件
    await this.loadInstalledPlugins();

    this.logger.info("[PluginComponent] Initialized");
  }

  /**
   * 从 ~/.roy-bot/plugins.json 读取并加载已安装的插件
   *
   * 对每个插件：
   * 1. 通过 import(packageName) 动态导入插件模块
   * 2. 调用 register() 注册
   */
  private async loadInstalledPlugins(): Promise<void> {
    // 收集所有插件配置来源
    const pluginConfigs: Array<{ source: string; path: string }> = [
      { source: "global", path: join(homedir(), ".roy-bot", "plugins.json") },
      { source: "project", path: join(process.cwd(), ".roy", "plugins.json") },
    ];

    const allPlugins: Array<{ packageName: string; version: string; name: string; description?: string }> = [];

    for (const { source, path } of pluginConfigs) {
      if (!existsSync(path)) {
        this.logger.debug(`[PluginComponent] No plugins.json found at ${path}, skipping`);
        continue;
      }

      try {
        const raw = readFileSync(path, "utf-8");
        const config = JSON.parse(raw);
        const plugins = config.plugins ?? [];
        if (plugins.length > 0) {
          this.logger.info(`[PluginComponent] Found ${plugins.length} plugin(s) in ${source} config: ${path}`);
          allPlugins.push(...plugins);
        }
      } catch (err) {
        this.logger.warn(`[PluginComponent] Failed to read plugins.json at ${path}: ${err}`);
      }
    }

    if (allPlugins.length === 0) {
      this.logger.debug("[PluginComponent] No plugins found in any config, skipping auto-load");
      return;
    }

    this.logger.info(`[PluginComponent] Loading ${allPlugins.length} installed plugin(s) from all configs`);

    for (const entry of allPlugins) {
      try {
        // Task #2903: 传 declaredVersion 给 loadPluginFromPackage，触发 version drift 检查
        await this.loadPluginFromPackage(entry.packageName, entry.version);
      } catch (err) {
        this.logger.error(`[PluginComponent] Failed to load plugin '${entry.packageName}': ${err}`);
      }
    }
  }

  /**
   * 从已安装的 npm 包加载插件
   *
   * 通过 import(packageName) 动态导入插件模块
   * 插件模块应导出实现了 BasePlugin 接口的实例
   *
   * 支持多种导出方式：
   * - default export: 插件实例 / 类
   * - named export 'plugin': 插件实例 / 类
   *
   * 类型检查：优先 instanceof BasePlugin（内部插件），fallback 到 duck-type（外部插件）
   * duck-type 要求：name (string) + init (function) + 可选 dispose (function)
   *
   * **Task #2903 修复说明（version drift warn）**：
   * 加载成功后，如果传入 declaredVersion，对比实际加载的 plugin 入口的
   * package.json version，不一致就 warn（带 resolvedPath 帮助用户诊断）。
   *
   * **Task #2908 修复说明（npm global root fallback）**：
   * import(packageName) 默认不解析 npm global root（不在 Node 模块解析路径
   * 中），所以 `roy-bot install --global <pkg>` 后 `roy-bot run` 永远
   * 找不到 plugin。修复：在 PRIMARY import() 失败后的 fallback chain 头部
   * 插入 npm global root 查询（`npm root -g`）。
   *
   * 完整加载顺序（new）：
   *   PRIMARY: import(packageName)            (Node default resolution)
   *   失败 → fallback chain:
   *     1. <npm global root>/<packageName>/  ← NEW (Task #2899 authoritative)
   *     2. ./.roy/plugins/<packageName>/     (project local)
   *     3. ~/.roy-bot/node_modules/<pkg>/  (cp copy — deprecated but kept for back-compat)
   */
  private async loadPluginFromPackage(
    packageName: string,
    declaredVersion?: string,
  ): Promise<void> {
    // 动态导入插件模块（通过 Node.js/Bun 模块解析）
    let pluginModule: any;
    let resolvedPath: string | null = null; // Task #2903: 记录实际加载的入口路径，用于 version drift 检查
    try {
      pluginModule = await import(packageName);
      // ESM dynamic import 不直接给 resolvedPath；用 require.resolve 兜底（注意：可能与 import 解析路径略有不同）
      try {
        const { createRequire } = await import("node:module");
        const req = createRequire(import.meta.url);
        resolvedPath = req.resolve(packageName);
      } catch {
        // require.resolve 失败（CJS/ESM 差异）→ 不强行猜路径，传 null 给 checkVersionDrift
      }
    } catch (_err) {
      // ───────────────────────────────────────────────────────────────────
      // Task #2908 followup：fallback 0 — npm global root
      // 根因：import(packageName) 失败后，原 chain 不查 npm global root（Task #2899
      //   后的权威安装路径），导致 `roy-bot install --global <pkg>` 后
      //   `roy-bot run` 起不来 plugin service。
      // 修复：在 catch 块**最前面**插入 npm global root fallback。
      //   stdio: ["ignore", "pipe", "ignore"] 避免 npm 输出污染日志。
      // ───────────────────────────────────────────────────────────────────
      let loadedFromGlobalRoot = false;
      try {
        const { execSync } = await import("node:child_process");
        const npmGlobalRoot = execSync("npm root -g", {
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (npmGlobalRoot) {
          const globalPkgPath = join(npmGlobalRoot, packageName);
          if (existsSync(globalPkgPath)) {
            this.logger.debug(`[PluginComponent] Falling back to npm global root: ${globalPkgPath}`);
            pluginModule = await import(globalPkgPath);
            resolvedPath = globalPkgPath;
            loadedFromGlobalRoot = true;
          }
        }
      } catch (npmRootErr) {
        // `npm root -g` 自身失败（npm 不在 PATH 等）→ 静默降级到下一条 fallback
        this.logger.debug(`[PluginComponent] npm root -g failed: ${npmRootErr}`);
      }

      if (!loadedFromGlobalRoot) {
        // 回退 1：尝试从项目 .roy/plugins/<packageName>/ 加载
        const projectPluginPath = join(process.cwd(), ".roy", "plugins", packageName);
        if (existsSync(projectPluginPath)) {
          this.logger.debug(`[PluginComponent] Falling back to project plugin path: ${projectPluginPath}`);
          try {
            pluginModule = await import(projectPluginPath);
            resolvedPath = projectPluginPath; // 已知路径
          } catch (err2) {
            this.logger.warn(`[PluginComponent] Could not import plugin '${packageName}' from project path: ${err2}`);
            return;
          }
        } else {
          // 回退 2：尝试从 ~/.roy-bot/node_modules/<packageName>/ 加载
          //   历史 cp 副本路径，Task #2899 已不再写入此路径，但保留作为
          //   向后兼容（旧安装可能仍留有副本）。
          const globalPluginPath = join(homedir(), ".roy-bot", "node_modules", packageName);
          if (existsSync(globalPluginPath)) {
            this.logger.debug(`[PluginComponent] Falling back to global plugin path: ${globalPluginPath}`);
            try {
              pluginModule = await import(globalPluginPath);
              resolvedPath = globalPluginPath; // 已知路径
            } catch (err3) {
              this.logger.warn(`[PluginComponent] Could not import plugin '${packageName}' from global path: ${err3}`);
              return;
            }
          } else {
            this.logger.warn(`[PluginComponent] Could not import plugin '${packageName}': ${_err}`);
            return;
          }
        }
      }
    }

    // Task #2903: 加载成功后做 version drift 检查（如果 callers 提供了 declaredVersion）
    if (declaredVersion && resolvedPath) {
      checkVersionDrift(declaredVersion, resolvedPath, {
        warn: (msg) => this.logger.warn(`[PluginComponent] ${msg}`),
      });
    }

    /**
     * duck-type 检查 + 实例化辅助函数
     * 返回 pluginInstance 如果是合法 BasePlugin 形状，否则返回 undefined
     */
    const tryCreateInstance = (candidate: any, exportKind: string): BasePlugin | undefined => {
      if (!candidate) return undefined;

      // case 1: 已经是 BasePlugin 实例
      if (candidate instanceof BasePlugin) {
        return candidate;
      }

      // case 2: 是 BasePlugin 子类（class）
      if (typeof candidate === "function" && candidate.prototype instanceof BasePlugin) {
        return new candidate();
      }

      // case 3: 已经是 duck-type 实例 — { name: string, init: function, dispose?: function }
      if (
        typeof candidate === "object" &&
        typeof candidate.name === "string" &&
        typeof candidate.init === "function"
      ) {
        this.logger.debug(`[PluginComponent] Plugin '${packageName}' ${exportKind} matches duck-type BasePlugin interface (instance)`);
        return candidate as BasePlugin;
      }

      // case 4: 是 duck-type class — prototype 上有 init 函数
      if (
        typeof candidate === "function" &&
        typeof candidate.prototype?.init === "function"
      ) {
        this.logger.debug(`[PluginComponent] Plugin '${packageName}' ${exportKind} matches duck-type BasePlugin interface (class)`);
        return new candidate();
      }

      return undefined;
    };

    let pluginInstance: BasePlugin | undefined;

    if (pluginModule.default) {
      pluginInstance = tryCreateInstance(pluginModule.default, "default export");
    }

    if (!pluginInstance && pluginModule.plugin) {
      pluginInstance = tryCreateInstance(pluginModule.plugin, "named export 'plugin'");
    }

    if (!pluginInstance) {
      this.logger.warn(`[PluginComponent] Plugin '${packageName}' does not export a valid plugin instance (expected default export or named export 'plugin' with { name, init, dispose? })`);
      return;
    }

    // 注册插件
    await this.register(pluginInstance);
    this.logger.info(`[PluginComponent] Loaded plugin: ${pluginInstance.name} (from ${packageName})`);
  }

  // ========================================================================
  // Public API
  // ========================================================================

  /**
   * 注册插件
   *
   * 创建 PluginEnv 并调用 plugin.init()
   *
   * @param plugin - 要注册的插件实例
   * @throws 如果插件名称已存在
   */
  async register(plugin: BasePlugin): Promise<void> {
    if (this.registry.has(plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered`);
    }

    // 创建 PluginEnv
    const env = this.createPluginEnv(plugin);

    // 调用 init（统一处理同步和异步）
    try {
      await plugin.init(env);
      this.registry.set(plugin.name, plugin);
      this.logger.info(`Registered plugin: ${plugin.name}`);
    } catch (err) {
      this.logger.error(`Failed to init plugin ${plugin.name}: ${err}`);
      throw err;
    }
  }

  /**
   * 注销插件
   *
   * 调用 plugin.dispose() 并从注册表移除
   *
   * @param name - 插件名称
   * @returns 是否成功注销
   */
  unregister(name: string): boolean {
    const plugin = this.registry.get(name);
    if (!plugin) {
      return false;
    }

    // Remove from registry first, then try to dispose
    this.registry.delete(name);
    try {
      plugin.dispose();
      this.logger.info(`Unregistered plugin: ${name}`);
    } catch (err) {
      this.logger.error(`Failed to dispose plugin ${name}: ${err}`);
    }
    return true;
  }

  /**
   * 获取插件
   *
   * @param name - 插件名称
   * @returns 插件实例，如果不存在则返回 undefined
   */
  get(name: string): BasePlugin | undefined {
    return this.registry.get(name);
  }

  /**
   * 获取所有插件
   *
   * @returns 插件数组
   */
  list(): BasePlugin[] {
    return Array.from(this.registry.values());
  }

  /**
   * 检查插件是否已注册
   *
   * @param name - 插件名称
   */
  has(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * 获取插件配置
   *
   * Overload 1: 无参 → 返回组件自身配置（继承自 BaseComponent.getConfig）
   * Overload 2: 带 name → 返回指定插件配置
   *
   * @param name - 插件名称
   * @returns 插件配置，如果不存在则返回 undefined
   */
  getConfig(): ComponentConfig;
  getConfig(name: string): any;
  getConfig(name?: string): any {
    if (name === undefined) {
      return super.getConfig();
    }
    return this.configComponent?.get(`plugin.${name}`);
  }

  /**
   * 批量注册插件
   *
   * @param plugins - 插件数组
   */
  async registerAll(plugins: BasePlugin[]): Promise<void> {
    for (const plugin of plugins) {
      await this.register(plugin);
    }
  }

  // ========================================================================
  // NotificationChannel Management
  // ========================================================================

  /**
   * 设置 NotificationChannel 列表
   *
   * PluginComponent 按数组顺序选第一个 canRoute=true 的通道处理 notify 调用。
   *
   * 传空数组 → 禁用所有通知通道（notify 会成为 noop）。
   *
   * @example
   * ```ts
   * // 完全替换默认
   * component.setNotificationChannels([
   *   new EventBusNotificationChannel(),
   *   new LarkCliNotificationChannel(),  // opt-in legacy
   * ]);
   * ```
   */
  setNotificationChannels(channels: NotificationChannel[]): void {
    this.notificationChannels = [...channels];
    this.logger.info(
      `[PluginComponent] Notification channels updated: ${this.notificationChannels.map((c) => c.name).join(", ") || "(none)"}`
    );
  }

  /**
   * 获取当前 NotificationChannel 名称列表
   */
  getNotificationChannelNames(): string[] {
    return this.notificationChannels.map((c) => c.name);
  }

  /**
   * 把 notify 调用路由到第一个 canRoute=true 的 channel
   *
   * - channel 异常被 swallow（不污染 Plugin 主流程）
   * - 所有 channel 都不路由 → log warn（不影响 notify 调用方）
   */
  private async routeNotification(
    options: NotificationOptions,
    extras: NotificationSendExtras,
    envContext: EnvContextLike
  ): Promise<void> {
    for (const channel of this.notificationChannels) {
      try {
        if (!channel.canRoute(options, extras, envContext)) {
          continue;
        }
        await channel.send(options, extras, envContext);
        // 命中一个 channel 就退出（不允许 fanout，避免重复通知）
        return;
      } catch (err) {
        this.logger.warn(
          `[PluginComponent] Notification channel '${channel.name}' send threw: ${err}`
        );
        // 不退出，继续尝试下一个 channel
      }
    }
    this.logger.warn(
      `[PluginComponent] No notification channel can route '${options.type}' (plugin: ${extras.pluginName})`
    );
  }

  // ========================================================================
  // Lifecycle
  // ========================================================================

  /**
   * 停止组件
   *
   * 调用所有已注册插件的 dispose() 方法
   */
  async stop(): Promise<void> {
    this.setStatus("stopping");
    this.logger.info("[PluginComponent] Stopping...");

    // 调用所有插件的 dispose()
    for (const [name, plugin] of this.registry) {
      try {
        const result = plugin.dispose();
        if (result instanceof Promise) {
          await result;
        }
        this.logger.debug(`Disposed plugin: ${name}`);
      } catch (err) {
        this.logger.error(`Failed to dispose plugin ${name}: ${err}`);
      }
    }

    // 清空注册表
    this.registry.clear();
    this.componentCache.clear();

    this.setStatus("stopped");
    this.logger.info("[PluginComponent] Stopped");
  }

  // ========================================================================
  // PluginEnv Factory
  // ========================================================================

  /**
   * 创建 PluginEnv
   */
  private createPluginEnv(plugin: BasePlugin): PluginEnv {
    const self = this;

    return {
      getComponent<T>(name: string): T | undefined {
        return self.env?.getComponent(name) as T | undefined;
      },

      registerAgent(config: AgentInstanceConfig): void {
        const agentComponent = self.env?.getComponent<AgentComponent>("agent");
        if (agentComponent) {
          agentComponent.registerAgent(config.name, config);
          self.logger.debug(`Registered agent: ${config.name} (for plugin: ${plugin.name})`);
        } else {
          self.logger.warn(`Cannot register agent ${config.name}: AgentComponent not available`);
        }
      },

      registerTool(tool: ToolDefinition): void {
        const toolComponent = self.env?.getComponent<ToolComponent>("tool");
        if (toolComponent) {
          // ToolDefinition 是 Plugin 侧的简化形态（无 execute），这里通过
          // handler 包装为 ToolComponent.register 期望的 Tool 形状。
          // TODO: 未来统一 Tool 类型（Task #2104 follow-up）
          toolComponent.register({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            execute: async (args: unknown) => tool.handler(args),
          } as unknown as Parameters<ToolComponent["register"]>[0]);
          self.logger.debug(`Registered tool: ${tool.name} (for plugin: ${plugin.name})`);
        } else {
          self.logger.warn(`Cannot register tool ${tool.name}: ToolComponent not available`);
        }
      },

      registerHook(hook: HookDefinition): void {
        // HookHandler returns void|Promise<void>|HookResult|Promise<HookResult>,
        // but HookManager.register expects execute returning void|Promise<void>.
        // Wrap to discard any HookResult so types align.
        globalHookManager.register(hook.point, {
          name: `${plugin.name}:${hook.point}`,
          priority: hook.priority ?? plugin.priority,
          execute: async (ctx) => {
            await hook.handler(ctx as Parameters<HookHandler>[0]);
          },
        });
        self.logger.debug(`Registered hook: ${hook.point} (for plugin: ${plugin.name})`);
      },

      /**
       * 发送通知 → 路由到第一个 canRoute=true 的 NotificationChannel
       *
       * - 默认 EventBusNotificationChannel 通过 env.pushEnvEvent 发事件
       * - 任何 channel 异常被 swallow
       */
      async notify(options: NotificationOptions): Promise<void> {
        const envContext: EnvContextLike = getEnvContextOrEmpty();
        const extras: NotificationSendExtras = {
          pluginName: plugin.name,
          // 注入 self.env（BaseComponent.env）—— channel 可选使用
          envInstance: self.env as unknown as NotificationSendExtras["envInstance"],
        };
        await self.routeNotification(options, extras, envContext);
      },

      logger: createLogger(`plugin:${plugin.name}`),
    };
  }
}
