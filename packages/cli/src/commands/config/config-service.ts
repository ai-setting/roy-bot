/**
 * @fileoverview ConfigService - 配置服务工具类
 * 
 * 提供配置的导出、导入等功能
 */

import * as fsSync from "fs";
import * as fsPromises from "fs/promises";
import * as path from "path";
import type { ConfigComponent } from "@ai-setting/roy-bot-core";
import { parseJSONC, parseJSONCWithEnv } from "@ai-setting/roy-bot-core/config";

// ConfigComponent 类型（兼容 BaseComponent 返回的 Component | undefined）
type AnyConfigComponent = ConfigComponent | undefined;
import type { OutputService } from "../../services/output.service";
import type { EnvironmentService } from "../../services/environment.service";
import { deepMerge } from "./deep-merge";

export interface ConfigExportOptions {
  /** 导出到文件路径（不指定则返回内容） */
  filePath?: string;
  /** 格式化输出（默认 true） */
  pretty?: boolean;
}

export interface ConfigImportOptions {
  /** 导入源配置文件 */
  sourceFile: string;
  /** 预览模式，不实际写入 */
  dryRun?: boolean;
  /** 显示详细操作信息 */
  verbose?: boolean;
}

export interface ImportResult {
  success: boolean;
  merged: boolean;
  changes: Array<{
    key: string;
    oldValue: unknown;
    newValue: unknown;
  }>;
  filePath: string;
  message?: string;
}

/**
 * ConfigService - 配置服务
 */
export class ConfigService {
  public envService?: EnvironmentService;

  constructor(
    private configComponent: ConfigComponent,
    private output: OutputService
  ) {}

  /**
   * 获取 component 的运行时配置值
   * 
   * 从所有配置源读取配置，合并后返回：
   * - memory source（最高优先级，用户运行时修改）
   * - file source（配置文件）
   * - defaults（注册到 memory 的默认值）
   */
  getComponentConfig(componentName: string): Record<string, unknown> {
    const sources = this.configComponent.getSources();
    
    // 查找 memory source（最高优先级）
    const memorySource = sources.find((s) => s.name === "memory");
    // 查找 file source
    const fileSource = sources.find((s) => s.name === "file");
    
    const prefix = `${componentName}.`;
    const result: Record<string, unknown> = {};
    
    // 1. 先从 file source 读取（作为基础）
    if (fileSource) {
      const fileEntries = fileSource.list();
      for (const entry of fileEntries) {
        if (entry.key === componentName) {
          // component 本身就是根键
          result[entry.key] = entry.value;
        } else if (entry.key.startsWith(prefix)) {
          const restKey = entry.key.slice(prefix.length);
          this.setNestedValue(result, restKey, entry.value);
        }
      }
    }
    
    // 2. 再从 memory source 读取（覆盖 file source）
    if (memorySource) {
      const memoryEntries = memorySource.list();
      for (const entry of memoryEntries) {
        if (entry.key === componentName) {
          // component 本身就是根键
          result[entry.key] = entry.value;
        } else if (entry.key.startsWith(prefix)) {
          const restKey = entry.key.slice(prefix.length);
          this.setNestedValue(result, restKey, entry.value);
        }
      }
    }

    return result;
  }

  /**
   * 获取 component 的 file source 物理路径
   */
  getComponentFilePath(componentName: string): string | undefined {
    const sources = this.configComponent.getSources();
    const fileSource = sources.find((s) => s.name === "file");
    
    if (fileSource && "filePath" in fileSource) {
      return fileSource.filePath as string;
    }
    
    return undefined;
  }

  /**
   * 导出配置到文件
   */
  async exportToFile(
    componentName: string,
    options: ConfigExportOptions
  ): Promise<string> {
    const config = this.getComponentConfig(componentName);
    const content = JSON.stringify(
      { [componentName]: config },
      null,
      options.pretty !== false ? 2 : 0
    );

    if (options.filePath) {
      const dir = path.dirname(options.filePath);
      if (!fsSync.existsSync(dir)) {
        await fsPromises.mkdir(dir, { recursive: true });
      }
      await fsPromises.writeFile(options.filePath, content, "utf-8");
      this.output.log(`✅ 已导出 ${componentName} 配置到 ${options.filePath}`);
    }

    return content;
  }

  /**
   * 从文件导入配置（只写入 file source）
   */
  async importFromFile(
    componentName: string,
    options: ConfigImportOptions
  ): Promise<ImportResult> {
    const result: ImportResult = {
      success: false,
      merged: false,
      changes: [],
      filePath: "",
    };

    // 1. 解析源文件
    let sourceData: Record<string, unknown>;
    try {
      const content = await fsPromises.readFile(options.sourceFile, "utf-8");
      // 源文件也可能是 JSONC 格式，使用 parseJSONCWithEnv 解析
      sourceData = parseJSONCWithEnv(content);
    } catch (error) {
      result.message = `无法读取源文件: ${error}`;
      return result;
    }

    // 提取 component 配置
    const sourceComponentConfig = sourceData[componentName];
    if (!sourceComponentConfig || typeof sourceComponentConfig !== "object") {
      result.message = `源文件中未找到 ${componentName} 配置`;
      return result;
    }

    // 2. 获取目标文件路径
    const targetFilePath = this.getComponentFilePath(componentName);
    if (!targetFilePath) {
      result.message = `无法获取 ${componentName} 的 file source 路径`;
      return result;
    }
    result.filePath = targetFilePath;

    // 3. 读取目标文件现有内容
    let targetData: Record<string, unknown> = {} as Record<string, unknown>;
    try {
      if (fsSync.existsSync(targetFilePath)) {
        const content = await fsPromises.readFile(targetFilePath, "utf-8");
        // 使用 parseJSONC 解析目标文件（保留 JSONC 语法包括 $ 引用）
        // 注意：不使用 parseJSONCWithEnv，否则会替换掉 $ 引用
        targetData = parseJSONC(content);
      }
    } catch (error) {
      // 文件不存在或解析失败，使用空对象
      if (options.verbose) {
        this.output.log(`📝 目标文件不存在或无法解析，将创建新文件`);
      }
    }

    // 4. 深度合并
    const existingComponentConfig = (targetData[componentName] || {}) as Record<string, unknown>;
    const mergedComponentConfig = deepMerge(
      existingComponentConfig,
      sourceComponentConfig as Record<string, unknown>
    );
    
    targetData[componentName] = mergedComponentConfig;

    // 计算变更
    result.changes = this.calculateChanges(
      existingComponentConfig,
      sourceComponentConfig as Record<string, unknown>
    );
    result.merged = result.changes.length > 0;

    if (options.verbose) {
      this.output.log(`📋 发现 ${result.changes.length} 个配置变更`);
      for (const change of result.changes) {
        this.output.log(`   ${change.key}: ${JSON.stringify(change.oldValue)} → ${JSON.stringify(change.newValue)}`);
      }
    }

    // 5. Dry-run 模式
    if (options.dryRun) {
      this.output.log(`🔍 预览模式：${result.changes.length} 个变更待应用`);
      this.output.log(`   目标文件: ${targetFilePath}`);
      result.success = true;
      return result;
    }

    // 6. 写入文件
    try {
      const dir = path.dirname(targetFilePath);
      if (!fsSync.existsSync(dir)) {
        await fsPromises.mkdir(dir, { recursive: true });
      }
      
      const content = JSON.stringify(targetData, null, 2);
      await fsPromises.writeFile(targetFilePath, content, "utf-8");
      
      this.output.log(`✅ 已导入配置到 ${targetFilePath}`);
      this.output.log(`   ${result.changes.length} 个配置项已更新`);
      result.success = true;
    } catch (error) {
      result.message = `写入文件失败: ${error}`;
    }

    return result;
  }

  /**
   * 计算配置变更
   */
  private calculateChanges(
    existing: Record<string, unknown>,
    source: Record<string, unknown>
  ): Array<{ key: string; oldValue: unknown; newValue: unknown }> {
    const changes: Array<{ key: string; oldValue: unknown; newValue: unknown }> = [];

    const flatten = (obj: unknown, prefix = ""): Array<{ key: string; value: unknown }> => {
      const result: Array<{ key: string; value: unknown }> = [];
      if (typeof obj !== "object" || obj === null) {
        return result;
      }
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          result.push(...flatten(v, key));
        } else {
          result.push({ key, value: v });
        }
      }
      return result;
    };

    const sourceEntries = flatten(source);
    const existingEntries = flatten(existing);
    const existingMap = new Map(existingEntries.map((e) => [e.key, e.value]));

    for (const entry of sourceEntries) {
      const oldValue = existingMap.get(entry.key);
      if (JSON.stringify(oldValue) !== JSON.stringify(entry.value)) {
        changes.push({
          key: entry.key,
          oldValue,
          newValue: entry.value,
        });
      }
    }

    return changes;
  }

  /**
   * 设置嵌套值
   */
  private setNestedValue(obj: Record<string, unknown>, key: string, value: unknown): void {
    const keys = key.split(".");
    let current = obj;

    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (!(k in current) || typeof current[k] !== "object" || current[k] === null) {
        current[k] = {};
      }
      current = current[k] as Record<string, unknown>;
    }

    current[keys[keys.length - 1]] = value;
  }
}
