import { BaseComponent, type ComponentConfig } from "../component";
import { createLogger } from "../log-trace/logger";
import { SkillScanner } from "./scanner";
import { createSkillTool } from "./tool";
import { DEFAULT_SKILL_CONFIG } from "./config";
import type {
  SkillConfig,
  SkillEntry,
  SkillListItem,
} from "./types";
import type { ToolComponent } from "../tool";
import type { Tool } from "../tool/types";
import { SKILL_CONFIG_REGISTRATION, SKILL_DEFAULTS } from "./skill-config-registration";
import type { ConfigComponent } from "../../config/config-component";
import { envKeyToConfigKey } from "../../config/env-key";

const logger = createLogger("skill");

/**
 * SkillComponent 配置选项（通过 options 传递）
 * 
 * 配置加载顺序（优先级从低到高）：
 * 1. File - 配置文件（通过 configPath 指定）
 * 2. Env - 环境变量（通过 envPrefix 配置前缀）
 * 3. Object - 直接传入的 config 对象（最高优先级）
 */
export interface SkillComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: ConfigComponent;
  
  /** 配置文件相对路径（可选，基于 XDG_DATA_HOME） */
  configPath?: string;
  
  /** 环境变量前缀（可选，默认 "SKILL"） */
  envPrefix?: string;
  
  /** 直接传入的配置对象（可选，优先级最高） */
  config?: Partial<SkillConfig>;
}

export class SkillComponent extends BaseComponent {
  name = "skill";
  version = "1.0.0";

  private config!: SkillConfig;
  private toolComponent?: ToolComponent;
  private scanner!: SkillScanner;
  private skillsMap: Map<string, SkillEntry> = new Map();
  private configComponent?: ConfigComponent;
  private configWatcher?: () => void;

  // ========================================================================
  // Lifecycle
  // ========================================================================

  async init(config?: ComponentConfig): Promise<void> {
    await super.init(config);

    // 从 options 获取 ConfigComponent
    const options = config?.options as unknown as SkillComponentOptions | undefined;
    if (!options?.configComponent) {
      throw new Error("ConfigComponent is required for SkillComponent initialization");
    }

    this.configComponent = options.configComponent;
    await this.registerConfig(options);

    // 创建扫描器
    this.scanner = new SkillScanner(this.config);

    logger.info("[SkillComponent] Initialized");
  }

  /**
   * 注册配置到 ConfigComponent
   * 
   * 配置加载顺序（优先级从低到高）：
   * 1. Defaults - 默认值（最低）
   * 2. FileSource - 从配置文件加载
   * 3. EnvSource - 从环境变量加载
   * 4. config 对象 - 直接传入的配置（最高）
   */
  private async registerConfig(options: SkillComponentOptions): Promise<void> {
    const configComponent = this.configComponent;
    if (!configComponent) return;

    const { configPath, envPrefix, config } = options;
    const prefix = envPrefix ?? "SKILL";

    // 1. 使用 registerComponent 注册配置结构（keys 和 sources，不含 defaults）
    configComponent.registerComponent(SKILL_CONFIG_REGISTRATION);

    // 2. 注册 FileSource（如果提供了 configPath）
    if (configPath) {
      configComponent.registerSource({
        type: "file",
        relativePath: configPath,
        optional: true,
        watch: false
      });
    }

    // 3. 注册 EnvSource
    configComponent.registerSource({
      type: "env",
      envPrefix: prefix,
      priority: 20,
      watch: false
    });
    
    // 4. 从 sources 加载配置（FileSource 和 EnvSource）
    await configComponent.load("skill");
    
    // 5. 后备方案：直接读取环境变量（确保所有环境变量都被处理）
    for (const envKey of Object.keys(process.env)) {
      const configKey = envKeyToConfigKey(envKey, prefix, "skill");
      if (!configKey) continue;
      const value = process.env[envKey];
      if (value !== undefined) {
        await configComponent.set(configKey, value);
      }
    }

    // 6. 设置默认值（只有当配置不存在时）
    for (const [key, value] of Object.entries(SKILL_DEFAULTS)) {
      if (configComponent.get(key) === undefined) {
        await configComponent.set(key, value);
      }
    }

    // 7. 直接配置对象（最高优先级）
    if (config) {
      const flatConfig = this.flattenConfig(config);
      for (const [key, value] of Object.entries(flatConfig)) {
        await configComponent.set(key, value);
      }
    }

    // 8. 注册配置热更新监听
    this.registerConfigWatcher(configComponent);

    // 9. 解析最终配置
    this.buildConfig(configComponent);
  }

  /**
   * 构建最终配置对象
   */
  private buildConfig(configComponent: ConfigComponent): void {
    // 解析基本配置
    const recursive = (configComponent.get("skill.recursive") as boolean) ?? true;
    const cacheEnabled = (configComponent.get("skill.cacheEnabled") as boolean) ?? true;

    // 从配置获取 skillPaths（需要解析 JSON 数组）
    const skillPathsConfig = configComponent.get("skill.skillPaths");
    let skillPaths: { type: string; path: string }[] = [];

    if (Array.isArray(skillPathsConfig)) {
      skillPaths = skillPathsConfig as { type: string; path: string }[];
    } else if (typeof skillPathsConfig === "string") {
      try {
        skillPaths = JSON.parse(skillPathsConfig);
      } catch {
        // 解析失败，使用默认值
        skillPaths = DEFAULT_SKILL_CONFIG.skillPaths;
      }
    }

    // 如果没有配置，使用默认值
    if (skillPaths.length === 0) {
      skillPaths = DEFAULT_SKILL_CONFIG.skillPaths;
    }

    this.config = {
      skillPaths: skillPaths as any,
      recursive,
      cacheEnabled,
    };
  }

  /**
   * 将配置对象展平为点号路径
   */
  private flattenConfig(
    obj: Record<string, unknown>,
    prefix = "skill"
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = `${prefix}.${key}`;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        Object.assign(
          result,
          this.flattenConfig(value as Record<string, unknown>, fullKey)
        );
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
    
    this.configWatcher = configComponent.watch("skill.*", (event) => {
      this.onConfigChange(event);
    });
  }

  /**
   * 处理配置变更
   */
  protected onConfigChange(event: { key: string; oldValue?: unknown; newValue?: unknown }): void {
    logger.info(`[SkillComponent] Config changed: ${event.key}`, {
      oldValue: event.oldValue,
      newValue: event.newValue
    });
    // 重新构建配置
    if (this.configComponent) {
      this.buildConfig(this.configComponent);
    }
  }

  async start(): Promise<void> {
    await super.start();

    // 获取 ToolComponent
    this.toolComponent = this.env?.getComponent("tool");
    if (!this.toolComponent) {
      logger.warn("[SkillComponent] ToolComponent not found, skipping tool registration");
      return;
    }

    // 扫描 skills
    await this.scanSkills();

    // 注册 SkillTool
    await this.registerTool();

    this.setStatus("running");
    logger.info(`[SkillComponent] Started with ${this.skillsMap.size} skills`);
  }

  async stop(): Promise<void> {
    // 清理配置 watcher
    if (this.configWatcher) {
      this.configWatcher();
      this.configWatcher = undefined;
    }

    // 取消注册 Tool
    if (this.toolComponent) {
      this.toolComponent.unregister("skill");
    }

    await super.stop();
    logger.info("[SkillComponent] Stopped");
  }

  // ========================================================================
  // Skill Access
  // ========================================================================

  /**
   * 获取指定 skill
   */
  getSkill(name: string): SkillEntry | undefined {
    return this.skillsMap.get(name);
  }

  /**
   * 获取所有 skill 列表（用于 tool description）
   */
  getSkillList(): SkillListItem[] {
    return Array.from(this.skillsMap.values()).map((entry) => ({
      name: entry.name,
      description: entry.description,
      source: entry.source,
    }));
  }

  /**
   * 检查 skill 是否存在
   */
  hasSkill(name: string): boolean {
    return this.skillsMap.has(name);
  }

  /**
   * 获取所有 skills
   */
  getAllSkills(): SkillEntry[] {
    return Array.from(this.skillsMap.values());
  }

  // ========================================================================
  // Scanning & Reload
  // ========================================================================

  /**
   * 扫描所有 skillPaths 并加载 skills
   */
  async scanSkills(): Promise<void> {
    this.scanner = new SkillScanner(this.config);
    this.skillsMap = await this.scanner.scan();
    logger.info(`[SkillComponent] Scanned ${this.skillsMap.size} skills`);
  }

  /**
   * 重新扫描并更新 Tool
   */
  async reload(): Promise<void> {
    if (!this.toolComponent) {
      throw new Error("ToolComponent not available");
    }

    logger.info("[SkillComponent] Reloading skills...");

    // 1. 取消注册旧的 SkillTool
    this.toolComponent.unregister("skill");

    // 2. 重新扫描 skills
    await this.scanSkills();

    // 3. 注册新的 SkillTool
    await this.registerTool();

    logger.info(`[SkillComponent] Reloaded ${this.skillsMap.size} skills`);
  }

  // ========================================================================
  // Tool Registration
  // ========================================================================

  private async registerTool(): Promise<void> {
    if (!this.toolComponent) return;

    const tool = createSkillTool(
      () => this.getSkillList(),
      (name) => this.getSkill(name)
    );

    this.toolComponent.register(tool);
    logger.info("[SkillComponent] Registered SkillTool");
  }
}
