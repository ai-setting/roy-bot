/**
 * @fileoverview PromptComponent
 * 
 * 管理提示词存储、加载和渲染
 * - 内置 prompts 在构建时嵌入到 bundle 中（通过 prompts-index.ts）
 * - 外部 prompts 通过配置从指定路径加载
 * 
 * 配置通过 ConfigComponent 实时获取，支持配置热更新
 */

import { BaseComponent, type ComponentConfig, createHook } from "../component";
import { 
  type PromptConfig, 
  type PromptPath,
  type PromptEntry, 
  type PromptHookContext,
  PromptHookPoints, 
} from "./types";
import { PromptRenderer } from "./renderer";
import { createLogger } from "../log-trace/logger";
import { readFile, readdir } from "fs/promises";
import { join, basename, extname } from "path";
import type { ConfigComponent } from "../../config/config-component";
import { PROMPT_CONFIG_REGISTRATION, PROMPT_DEFAULTS } from "./prompt-config-registration";
import { toEnvKey, envKeyToConfigKey } from "../../config/env-key";
import { builtInPrompts } from "./prompts-index";
import { globalHookManager } from "../hook/global-hook-manager";
import { PromptStore } from "./prompt-store";

const logger = createLogger("prompt");

/**
 * PromptComponent 配置选项（通过 options 传递）
 * 
 * 配置加载顺序（优先级从低到高）：
 * 1. File - 配置文件（通过 configPath 指定）
 * 2. Env - 环境变量（通过 envPrefix 配置前缀）
 * 3. Object - 直接传入的配置对象（最高优先级）
 */
export interface PromptComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: ConfigComponent;
  
  /** 配置文件相对路径（可选，基于 XDG_DATA_HOME） */
  configPath?: string;
  
  /** 环境变量前缀（可选，默认 "PROMPT"） */
  envPrefix?: string;
  
  /** 默认 prompt 名称 */
  defaultName?: string;
  
  /** 外部 prompt 路径列表 */
  promptPaths?: PromptPath[];
  
  /** 变量前缀（默认 "{{"） */
  variablePrefix?: string;
  
  /** 变量后缀（默认 "}}"） */
  variableSuffix?: string;
  
  /** 直接传入的配置对象（可选，优先级最高） */
  config?: Partial<PromptConfig>;
}

/**
 * PromptComponent
 * 
 * 管理提示词存储、加载和渲染
 * 配置通过 ConfigComponent 实时获取，支持配置热更新
 */
export class PromptComponent extends BaseComponent {
  readonly name = "prompt";
  readonly version = "1.0.0";

  // 核心存储：name → entry
  private prompts: Map<string, PromptEntry> = new Map();
  
  private config?: PromptConfig;
  private configComponent?: ConfigComponent;
  private renderer!: PromptRenderer;
  private promptStore?: PromptStore;
  
  /** 配置变更 watcher 清理函数 */
  private configWatcher?: () => void;

  constructor() {
    super();
  }

  // ============================================================================
  // Component Lifecycle
  // ============================================================================

  /**
   * 初始化组件
   * 
   * 配置加载优先级（从高到低）：
   * 1. Object - 直接传入的 config 对象
   * 2. Env - 环境变量（通过 envPrefix 配置前缀）
   * 3. File - 配置文件（通过 configPath 指定）
   */
  async init(config: ComponentConfig): Promise<void> {
    // 调用基类 init，注入 env
    await super.init(config);

    // 从 options 获取 ConfigComponent
    const options = config.options as unknown as PromptComponentOptions | undefined;
    if (!options?.configComponent) {
      throw new Error("ConfigComponent is required for PromptComponent initialization");
    }

    this.configComponent = options.configComponent;
    await this.registerConfig(options);

    // 初始化渲染器
    this.initRenderer();

    this.initPromptStore();

    // 加载 prompts
    await this.loadPrompts();

    this.setStatus("running");
    logger.info(`[PromptComponent] Initialized with ${this.prompts.size} prompts`);
  }

  /**
   * 注册配置到 ConfigComponent
   * 
   * 配置加载顺序（优先级从低到高）：
   * 1. Env - 环境变量（通过 load 加载 + 直接读取）
   * 2. Defaults - 默认值（在环境变量检查之后设置）
   * 3. Config Object - 直接配置对象（最高优先级）
   */
  private async registerConfig(options: PromptComponentOptions): Promise<void> {
    const configComponent = options.configComponent;
    if (!configComponent) return;

    const { config, defaultName, promptPaths, variablePrefix, variableSuffix } = options;

    // 1. 使用 registerComponent 注册配置（会自动注册 sources 和 keys）
    configComponent.registerComponent(PROMPT_CONFIG_REGISTRATION);

    // 2. 使用 load 加载配置（从 env/file source 加载）
    await configComponent.load("prompt");

    // 3. 后备方案：直接读取环境变量（如果 load 未覆盖）
    const prefix = "PROMPT";
    const promptKeys = [
      "prompt.defaultName",
      "prompt.promptPaths",
      "prompt.variablePrefix",
      "prompt.variableSuffix",
      "prompt.strictMode",
    ];

    for (const key of promptKeys) {
      const envKey = toEnvKey(key, prefix);
      const value = process.env[envKey];
      if (value !== undefined) {
        await configComponent.set(key, value);
      }
    }

    // 4. 自动发现其他相关环境变量
    const loadedKeys = new Set(promptKeys);
    for (const envKey of Object.keys(process.env)) {
      const configKey = envKeyToConfigKey(envKey, prefix, "prompt");
      if (!configKey) continue;
      if (loadedKeys.has(configKey)) continue;
      loadedKeys.add(configKey);
      const value = process.env[envKey];
      if (value !== undefined) {
        await configComponent.set(configKey, value);
      }
    }

    // 5. 设置默认值（只有当配置不存在时）
    for (const [key, value] of Object.entries(PROMPT_DEFAULTS)) {
      if (configComponent.get(key) === undefined) {
        await configComponent.set(key, value);
      }
    }

    // 6. 直接配置对象（最高优先级）
    if (config) {
      const flatConfig = this.flattenConfig(config);
      for (const [key, value] of Object.entries(flatConfig)) {
        await configComponent.set(key, value);
      }
    }

    // 6.5 直接选项（也属于最高优先级）
    if (defaultName !== undefined) {
      await configComponent.set("prompt.defaultName", defaultName);
    }
    if (promptPaths !== undefined) {
      await configComponent.set("prompt.promptPaths", promptPaths);
    }
    if (variablePrefix !== undefined) {
      await configComponent.set("prompt.variablePrefix", variablePrefix);
    }
    if (variableSuffix !== undefined) {
      await configComponent.set("prompt.variableSuffix", variableSuffix);
    }

    // 7. 注册配置热更新监听
    this.registerConfigWatcher(configComponent);

    // 8. 从 ConfigComponent 获取最终配置
    // 注意：默认值已通过 registerComponent.defaults 设置到 ConfigComponent
    this.config = {
      defaultName: (configComponent.get("prompt.defaultName") as string) || "default",
      promptPaths: (configComponent.get("prompt.promptPaths") as PromptPath[]) || [],
      variablePrefix: (configComponent.get("prompt.variablePrefix") as string) || "{{",
      variableSuffix: (configComponent.get("prompt.variableSuffix") as string) || "}}",
      strictMode: (configComponent.get("prompt.strictMode") as boolean) || false,
    };
  }

  /**
   * 将配置对象展平为点号路径
   */
  private flattenConfig(
    obj: Record<string, unknown>,
    prefix = "prompt"
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = `${prefix}.${key}`;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(result, this.flattenConfig(value as Record<string, unknown>, fullKey));
      } else {
        result[fullKey] = value;
      }
    }
    return result;
  }

  /**
   * 注册配置热更新监听
   */
  private registerConfigWatcher(configComponent: ConfigComponent): void {
    if (typeof configComponent.watch !== "function") {
      return;
    }
    
    this.configWatcher = configComponent.watch("prompt.*", (event) => {
      this.onConfigChange(event);
    });
  }

  /**
   * 处理配置变更
   */
  private onConfigChange(event: { key: string; oldValue?: unknown; newValue?: unknown }): void {
    const key = event.key;
    const value = event.newValue;
    
    if (value === undefined) return;
    
    logger.debug(`[PromptComponent] Config updated: ${key} = ${JSON.stringify(value)}`);

    // 更新本地配置
    switch (key) {
      case "prompt.defaultName":
        if (this.config) this.config.defaultName = value as string;
        break;
      case "prompt.promptPaths":
        if (this.config) this.config.promptPaths = value as PromptPath[];
        break;
      case "prompt.variablePrefix":
        if (this.config) {
          this.config.variablePrefix = value as string;
          this.initRenderer(); // 重新初始化渲染器
        }
        break;
      case "prompt.variableSuffix":
        if (this.config) {
          this.config.variableSuffix = value as string;
          this.initRenderer(); // 重新初始化渲染器
        }
        break;
      case "prompt.strictMode":
        if (this.config) this.config.strictMode = value as boolean;
        break;
    }
  }

  private initRenderer(): void {
    const config = this.config || {
      defaultName: "default",
      promptPaths: [],
      variablePrefix: "{{",
      variableSuffix: "}}",
      strictMode: false,
    };
    
    this.renderer = new PromptRenderer({
      prefix: config.variablePrefix,
      suffix: config.variableSuffix,
      strict: config.strictMode,
      onMissingVariable: (name) => {
        logger.warn(`Undefined variable: ${name}`);
        return `{{${name}}}`;
      },
    });
  }

  async onStart(): Promise<void> {
    logger.info("[PromptComponent] Started");
  }

  async onStop(): Promise<void> {
    this.configWatcher?.();
    this.configWatcher = undefined;
    this.prompts.clear();
    this.setStatus("stopped");
    logger.info("[PromptComponent] Stopped");
  }

  // ============================================================================
  // Config Access
  // ============================================================================

  private getPromptConfig<T>(key: keyof PromptConfig, defaultValue?: T): T {
    if (this.config && key in this.config) {
      return (this.config[key] as T) ?? defaultValue as T;
    }
    
    return defaultValue as T;
  }

  // ============================================================================
  // Core Methods
  // ============================================================================

  /**
   * 添加 prompt
   */
  add(name: string, content: string, source: PromptEntry["source"] = "inline"): void {
    const entry: PromptEntry = {
      name,
      content,
      source,
      overridable: true,
      loadedAt: Date.now(),
    };

    // 如果已存在且不可覆盖，则跳过
    const existing = this.prompts.get(name);
    if (existing && !existing.overridable) {
      logger.debug(`[PromptComponent] Skip override for non-overridable prompt: ${name}`);
      return;
    }

    this.prompts.set(name, entry);
    logger.debug(`[PromptComponent] Added prompt: ${name} (${source})`);
  }

  /**
   * 获取 prompt 原始内容
   */
  get(name: string): string | undefined {
    return this.prompts.get(name)?.content;
  }

  /**
   * 获取 prompt 条目
   */
  getEntry(name: string): PromptEntry | undefined {
    return this.prompts.get(name);
  }

  /**
   * 检查 prompt 是否存在
   */
  has(name: string): boolean {
    return this.prompts.has(name);
  }

  /**
   * 删除 prompt
   */
  delete(name: string): boolean {
    return this.prompts.delete(name);
  }

  /**
   * 列出所有 prompt 名称
   */
  list(): string[] {
    return Array.from(this.prompts.keys());
  }

  /**
   * 列出所有 prompt 条目（含来源）
   */
  listEntries(): PromptEntry[] {
    return Array.from(this.prompts.values());
  }

  getPromptStore(): PromptStore {
    if (!this.promptStore) {
      this.initPromptStore();
    }
    return this.promptStore!;
  }

  getPromptConfigDir(): string {
    return this.getPromptStore().getConfigDir();
  }

  /**
   * 保存 prompt 到磁盘并注册到内存（跨进程持久化）
   */
  async savePrompt(name: string, content: string): Promise<string> {
    const filePath = await this.getPromptStore().savePrompt(name, content.trim());
    this.add(name, content.trim(), "file");
    const entry = this.prompts.get(name);
    if (entry) {
      entry.filePath = filePath;
    }
    return filePath;
  }

  /**
   * 从磁盘删除 prompt 文件，并从内存移除
   */
  async deletePromptFile(name: string): Promise<boolean> {
    const deleted = await this.getPromptStore().deletePrompt(name);
    if (deleted) {
      this.delete(name);
    }
    return deleted;
  }

  /**
   * 获取数量
   */
  size(): number {
    return this.prompts.size;
  }

  // ============================================================================
  // Render Methods
  // ============================================================================

  /**
   * 获取并渲染 prompt
   *
   * @param context 可选：渲染上下文。`agentType` 会透传到 `PromptHookContext`，
   *                供 `prompt.after-render` hook 判断是否注入 user-facing 内容
   *                （只有 `agentType === "primary"` 才注入 Commands Arsenal）。
   */
  async getPrompt(
    name: string,
    variables: Record<string, string> = {},
    context?: Partial<PromptHookContext>
  ): Promise<string> {
    const defaultName = this.getPromptConfig("defaultName", "default");
    const targetName = this.has(name) ? name : defaultName;
    
    const entry = this.prompts.get(targetName);
    if (!entry) {
      logger.warn(`[PromptComponent] Prompt not found: ${name}, using fallback`);
      return "You are a helpful assistant.";
    }

    return this.render(entry.content, variables, { ...context, name: targetName });
  }

  /**
   * 渲染内容（异步方法）
   */
  async render(content: string, variables: Record<string, string> = {}, context?: Partial<PromptHookContext>): Promise<string> {
    const hookContext: PromptHookContext = {
      name: context?.name || "anonymous",
      originalContent: content,
      renderedContent: content,
      variables,
      // 透传 agent 类型：hook 用它决定是否注入 user-facing 内容（Commands Arsenal）
      ...(context?.agentType ? { agentType: context.agentType } : {}),
    };

    // Hook: before.render (使用全局 hookManager)
    await globalHookManager.execute(PromptHookPoints.BEFORE_RENDER, hookContext);

    // 执行渲染
    hookContext.renderedContent = this.renderer.render(
      hookContext.originalContent,
      variables
    );

    // Hook: after.render (使用全局 hookManager)
    await globalHookManager.execute(PromptHookPoints.AFTER_RENDER, hookContext);

    return hookContext.renderedContent;
  }

  /**
   * 提取内容中的变量
   */
  extractVariables(content: string): string[] {
    return this.renderer.extractVariables(content);
  }

  // ============================================================================
  // Loading
  // ============================================================================

  /**
   * 加载所有 prompts（内置 + 外部）
   */
  private initPromptStore(): void {
    const customDir = this.configComponent?.get?.("prompt.configDir");
    this.promptStore = new PromptStore({
      configDir:
        typeof customDir === "string" && customDir.length > 0
          ? customDir
          : undefined,
    });
  }

  private async loadPrompts(): Promise<void> {
    // 1. 加载内置 prompts
    await this.loadBuiltInPrompts();

    // 2. 加载用户 prompts 目录（~/.local/share/roy-bot/prompts）
    await this.loadUserPrompts();

    // 3. 加载外部 prompts（可覆盖内置）
    await this.loadExternalPrompts();
  }

  /**
   * 从 XDG prompts 目录加载用户持久化 prompt
   */
  private async loadUserPrompts(): Promise<void> {
    const store = this.getPromptStore();
    const prompts = await store.loadAll();

    for (const prompt of prompts) {
      this.add(prompt.name, prompt.content, "file");
      const entry = this.prompts.get(prompt.name);
      if (entry) {
        entry.filePath = prompt.filePath;
      }
    }

    if (prompts.length > 0) {
      logger.info(
        `[PromptComponent] Loaded ${prompts.length} prompts from ${store.getConfigDir()}`
      );
    }
  }

  /**
   * 加载内置 prompts
   * 
   * 使用嵌入的 prompts（在构建时打包到 bundle 中）
   */
  private async loadBuiltInPrompts(): Promise<void> {
    // 遍历嵌入的 prompts 并注册
    for (const [name, content] of Object.entries(builtInPrompts)) {
      if (content) {
        this.prompts.set(name, {
          name,
          content,
          source: "built-in",
          overridable: false,
          loadedAt: Date.now(),
        });
        logger.debug(`[PromptComponent] Loaded built-in prompt: ${name}`);
      }
    }
    
    logger.info(`[PromptComponent] Loaded ${this.prompts.size} built-in prompts`);
  }

  /**
   * 加载外部 prompts
   */
  private async loadExternalPrompts(): Promise<void> {
    const promptPaths = this.getPromptConfig<PromptPath[]>("promptPaths", []);
      
    for (const pathConfig of promptPaths) {
      try {
        if (pathConfig.type === "file") {
          await this.loadFromFile(pathConfig.path, pathConfig.name);
        } else if (pathConfig.type === "directory") {
          await this.loadFromDirectory(
            pathConfig.path,
            pathConfig.extension || ".md",
            pathConfig.recursive !== false
          );
        }
      } catch (error) {
        logger.error(`[PromptComponent] Failed to load from ${pathConfig.path}:`, error);
      }
    }
  }

  /**
   * 从文件加载单个 prompt
   */
  async loadFromFile(filePath: string, name?: string): Promise<boolean> {
    try {
      const content = await readFile(filePath, "utf-8");
      const promptName = name || basename(filePath, extname(filePath));
      
      this.add(promptName, content.trim(), "file");
      const entry = this.prompts.get(promptName);
      if (entry) entry.filePath = filePath;
      
      logger.debug(`[PromptComponent] Loaded prompt from file: ${filePath}`);
      return true;
    } catch (error) {
      logger.error(`[PromptComponent] Failed to load file ${filePath}:`, error);
      return false;
    }
  }

  /**
   * 从目录加载多个 prompt
   */
  async loadFromDirectory(directory: string, extension: string = ".md", recursive: boolean = true): Promise<number> {
    let loaded = 0;

    try {
      const files = await this.findFiles(directory, extension, recursive);
      
      for (const filePath of files) {
        const relativePath = filePath.replace(directory + "/", "");
        const promptName = relativePath
          .replace(/\\/g, "/")
          .replace(new RegExp(escapeRegex(extension) + "$"), "")
          .replace(/\//g, "-");

        const content = await readFile(filePath, "utf-8");
        this.add(promptName, content.trim(), "directory");
        
        const entry = this.prompts.get(promptName);
        if (entry) entry.filePath = filePath;
        
        loaded++;
      }

      logger.info(`[PromptComponent] Loaded ${loaded} prompts from directory: ${directory}`);
    } catch (error) {
      logger.error(`[PromptComponent] Failed to load directory ${directory}:`, error);
    }

    return loaded;
  }

  private async findFiles(dir: string, extension: string, recursive: boolean): Promise<string[]> {
    const files: string[] = [];
    
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        
        if (entry.isDirectory() && recursive) {
          const subFiles = await this.findFiles(fullPath, extension, true);
          files.push(...subFiles);
        } else if (entry.isFile() && entry.name.endsWith(extension)) {
          files.push(fullPath);
        }
      }
    } catch (error) {
      logger.warn(`[PromptComponent] Cannot read directory ${dir}:`, error);
    }
    
    return files;
  }

  // ============================================================================
  // Hooks
  // ============================================================================

  /**
   * 注册 Prompt Hook（公开便捷方法，供外部调用）
   * 
   * 现在使用全局 hookManager，允许外部通过 globalHookManager 注册
   */
  registerPromptHook(
    hookPoint: string,
    name: string,
    fn: (ctx: { data: PromptHookContext; phase: "before" | "after" }) => void | Promise<void>,
    priority?: number
  ): void {
    globalHookManager.register(
      hookPoint,
      createHook({ name, priority }, fn as any)
    );
  }

  /**
   * 取消注册 Prompt Hook
   */
  unregisterPromptHook(hookPoint: string, name: string): boolean {
    return globalHookManager.unregister(hookPoint, name);
  }

  /**
   * 获取 Prompt Hook 点列表
   */
  getHookPoints(): string[] {
    return [PromptHookPoints.BEFORE_RENDER, PromptHookPoints.AFTER_RENDER];
  }
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
