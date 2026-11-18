/**
 * @fileoverview DesktopComponent
 * 
 * Desktop 专用组件：
 * - 订阅 core Environment 事件
 * - 通过 IPC 转发到 renderer
 * - 提供 Desktop 专用配置管理
 */

import { 
  BaseComponent, 
} from "@ai-setting/roy-bot-core";
import type { 
  ComponentConfig, 
  ComponentStatus,
  EnvEvent,
} from "@ai-setting/roy-bot-core";
import { DESKTOP_COMPONENT_DEFAULTS } from "./desktop-component-registration.js";

// ============================================================================
// Types
// ============================================================================

/**
 * DesktopComponent API
 */
export interface DesktopComponentAPI {
  /** 获取订阅的事件类型 */
  getEventTypes(): string[];
  /** 设置订阅的事件类型 */
  setEventTypes(types: string[]): void;
  /** 是否启用事件订阅 */
  isEnabled(): boolean;
  /** 设置启用状态 */
  setEnabled(enabled: boolean): void;
  /** 获取事件处理器 */
  getEventHandler(): (event: EnvEvent) => void;
}

/**
 * DesktopComponent options
 */
export interface DesktopComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: any;
  /** IPC sender（用于转发事件到 renderer）*/
  ipcSender?: (channel: string, ...args: unknown[]) => void;
}

// ============================================================================
// Component
// ============================================================================

/**
 * DesktopComponent
 * 
 * 订阅 core Environment 事件并转发到 renderer
 */
export class DesktopComponent extends BaseComponent implements DesktopComponentAPI {
  readonly name = "desktop";
  readonly version = "1.0.0";

  private configComponent: any;
  private ipcSender?: (channel: string, ...args: unknown[]) => void;
  
  /** 事件处理函数 */
  private eventHandler: (event: EnvEvent) => void;
  
  /** 是否启用 */
  private enabled = true;
  
  /** 订阅的事件类型 */
  private eventTypes: string[] = ["agent.*", "tool.*", "session.*", "llm.*"];

  constructor(options: DesktopComponentOptions) {
    super();
    this.configComponent = options.configComponent;
    this.ipcSender = options.ipcSender;
    
    // 创建事件处理器
    this.eventHandler = this.handleEvent.bind(this);
  }

  /**
   * 初始化组件
   */
  async init(config: ComponentConfig): Promise<void> {
    await super.init(config);
    
    // 注册配置
    if (this.configComponent) {
      await this.registerConfig();
    }
    
    // 读取初始配置
    this.readConfig();
    
    this.setStatus("running");
  }

  /**
   * 注册配置
   */
  private async registerConfig(): Promise<void> {
    if (!this.configComponent) return;

    // 设置默认值
    for (const [key, value] of Object.entries(DESKTOP_COMPONENT_DEFAULTS)) {
      if (this.configComponent.get(key) === undefined) {
        await this.configComponent.set(key, value);
      }
    }

    // 注册配置热更新监听
    if (typeof this.configComponent.watch === "function") {
      this.configComponent.watch("desktop.*", (event: any) => {
        this.onConfigChange(event);
      });
    }
  }

  /**
   * 读取配置
   */
  private readConfig(): void {
    if (!this.configComponent) return;

    this.enabled = this.configComponent.get("desktop.events.enabled") ?? true;
    
    // 获取配置中的事件类型，确保包含 llm.*
    const configTypes = this.configComponent.get("desktop.events.types") ?? [];
    const defaultTypes = ["agent.*", "tool.*", "session.*", "llm.*"];
    
    // 如果配置为空，使用默认值
    if (!configTypes || configTypes.length === 0) {
      this.eventTypes = defaultTypes;
    } else {
      // 确保 llm.* 在配置中
      this.eventTypes = configTypes.includes("llm.*") 
        ? configTypes 
        : [...configTypes, "llm.*"];
    }
    
    console.log("[DesktopComponent] readConfig: eventTypes =", this.eventTypes);
  }

  /**
   * 处理配置变更
   */
  private onConfigChange(event: { key: string; newValue?: unknown }): void {
    console.log(`[DesktopComponent] Config changed: ${event.key} = ${JSON.stringify(event.newValue)}`);
    
    switch (event.key) {
      case "desktop.events.enabled":
        this.enabled = event.newValue as boolean;
        break;
      case "desktop.events.types":
        this.eventTypes = event.newValue as string[];
        // 广播事件类型变更到 renderer
        if (this.ipcSender) {
          this.ipcSender("env:eventTypesChanged", this.eventTypes);
        }
        break;
    }
  }

  /**
   * 处理收到的事件
   */
  private handleEvent(event: EnvEvent): void {
    // 检查是否启用
    if (!this.enabled) {
      console.log('[DesktopComponent] Event blocked: enabled = false, type:', event.type);
      return;
    }
    
    // 检查事件类型是否匹配
    const matched = this.matchesEventType(event.type);
    console.log('[DesktopComponent] Event:', event.type, 'matches:', matched, 'eventTypes:', this.eventTypes);
    
    if (!matched) return;
    
    // 通过 IPC 发送到 renderer
    if (this.ipcSender) {
      console.log('[DesktopComponent] Sending to renderer via IPC:', event.type, 'payload:', JSON.stringify(event.payload).substring(0, 200));
      this.ipcSender("env:event", {
        type: event.type,
        data: event.payload,
        timestamp: event.timestamp,
      });
    } else {
      console.log('[DesktopComponent] WARNING: ipcSender is null, cannot send event');
    }
  }

  /**
   * 检查事件类型是否匹配
   */
  private matchesEventType(eventType: string): boolean {
    for (const pattern of this.eventTypes) {
      if (this.matchPattern(eventType, pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 通配符模式匹配
   */
  private matchPattern(eventType: string, pattern: string): boolean {
    if (pattern === "*") return true;
    
    if (pattern.endsWith(".*")) {
      const prefix = pattern.slice(0, -2);
      return eventType === prefix || eventType.startsWith(prefix + ".");
    }
    
    return eventType === pattern;
  }

  // ==================== Public API ====================

  /**
   * 获取订阅的事件类型
   */
  getEventTypes(): string[] {
    return [...this.eventTypes];
  }

  /**
   * 设置订阅的事件类型
   */
  async setEventTypes(types: string[]): Promise<void> {
    this.eventTypes = types;
    
    // 持久化到配置
    if (this.configComponent) {
      await this.configComponent.set("desktop.events.types", types);
    }
    
    // 广播变更
    if (this.ipcSender) {
      this.ipcSender("env:eventTypesChanged", types);
    }
  }

  /**
   * 是否启用事件订阅
   */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * 设置启用状态
   */
  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    
    // 持久化到配置
    if (this.configComponent) {
      await this.configComponent.set("desktop.events.enabled", enabled);
    }
  }

  /**
   * 获取事件处理器（用于注册到 Environment）
   */
  getEventHandler(): (event: EnvEvent) => void {
    return this.eventHandler;
  }

  /**
   * 停止组件
   */
  async onStop(): Promise<void> {
    this.setStatus("stopped");
  }
}
