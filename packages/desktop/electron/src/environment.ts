/**
 * @fileoverview DesktopEnvironment for Electron Main Process
 * 
 * This module runs in the Electron main process and provides
 * access to the core functionality (@ai-setting/roy-bot-core).
 * 
 * It exposes a simple IPC interface for the renderer to interact with.
 * 
 * Component registration mirrors CLI's EnvironmentService.create() logic.
 */

import path from "path";
import os from "os";
import type {
  BaseEnvironment,
  ComponentRegistration,
} from '@ai-setting/roy-bot-core';
import { DesktopComponent } from './desktop-component.js';

// Type alias for environment
type Environment = BaseEnvironment;

// IPC sender type
type IpcSender = (channel: string, ...args: unknown[]) => void;

// Config directory constants (same as CLI)
const CLI_CONFIG_DIR_NAME = "roy-bot";
const DEFAULT_CONFIG_FILE = "config.jsonc";

/**
 * Get config directory with absolute path (same logic as CLI)
 * 
 * Priority:
 * 1. XDG_CONFIG_HOME/roy-bot (XDG standard)
 * 2. ~/.roy-bot (user home, default)
 */
function getUserConfigDir(): string {
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  if (xdgConfigHome) {
    return path.join(xdgConfigHome, CLI_CONFIG_DIR_NAME);
  }
  return path.join(os.homedir(), ".roy-bot");
}

/**
 * DesktopEnvironment - Main process environment service
 * 
 * Manages the lifecycle of the BaseEnvironment and its components.
 * Renderer process communicates via IPC.
 * 
 * Component registration is aligned with CLI's EnvironmentService.create():
 * All core components are registered in the same order with same config.
 */
export class DesktopEnvironment {
  private environment: Environment | null = null;
  private initialized = false;

  // Components (same as CLI EnvironmentService)
  private configComponent: any = null;
  private sessionComponent: any = null;
  private llmComponent: any = null;
  private toolComponent: any = null;
  private agentComponent: any = null;
  private logTraceComponent: any = null;
  private promptComponent: any = null;
  private taskComponent: any = null;
  private skillComponent: any = null;
  private mcpComponent: any = null;
  private commandsComponent: any = null;
  private memoryComponent: any = null;
  private memoryPlugin: any = null;
  private eventSourceComponent: any = null;
  private workflowComponent: any = null;
  private pluginComponent: any = null;
  private desktopComponent: DesktopComponent | null = null;
  
  // IPC sender for forwarding events to renderer
  private ipcSender: IpcSender | null = null;

  /**
   * Check if environment is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Initialize the environment
   */
  async create(options?: { envName?: string; configDir?: string }): Promise<void> {
    if (this.initialized) {
      console.warn('[DesktopEnvironment] Already initialized');
      return;
    }

    const envName = options?.envName ?? 'roy-desktop';
    
    // Determine config directory with absolute path resolution (same as CLI)
    let configDir = options?.configDir;
    if (!configDir) {
      configDir = getUserConfigDir();
    } else if (!path.isAbsolute(configDir)) {
      configDir = path.join(os.homedir(), configDir);
    }

    console.log(`[DesktopEnvironment] Creating: ${envName}`);
    console.log(`[DesktopEnvironment] Config dir: ${configDir}`);

    // Import core components
    const core = await import('@ai-setting/roy-bot-core');
    
    // Create BaseEnvironment
    this.environment = new core.BaseEnvironment({
      name: envName,
      version: '1.0.0',
    });

    // ========================================================================
    // 1. ConfigComponent - must be first
    // ========================================================================
    this.configComponent = new core.ConfigComponent();
    this.configComponent.setXdgDataHome(configDir);
    await this.configComponent.init({
      name: 'config',
      version: '1.0.0',
      enabled: true,
      env: this.environment,
    });

    // ========================================================================
    // 2. LLMComponent - needs ConfigComponent + configPath
    // ========================================================================
    this.llmComponent = new core.LLMComponent();
    await this.llmComponent.init({
      name: 'llm',
      version: '1.0.0',
      enabled: true,
      env: this.environment,
      options: {
        configComponent: this.configComponent,
        configPath: DEFAULT_CONFIG_FILE,
      },
    });

    // ========================================================================
    // 3. SessionComponent
    // ========================================================================
    this.sessionComponent = new core.SessionComponent();
    await this.sessionComponent.init({
      name: 'session',
      version: '1.0.0',
      enabled: true,
      env: this.environment,
      options: {
        configComponent: this.configComponent,
        config: { storage: { type: 'memory' } },
      },
    });

    // ========================================================================
    // 4. ToolComponent
    // ========================================================================
    this.toolComponent = new core.ToolComponent();
    await this.toolComponent.init({
      name: 'tool',
      version: '1.0.0',
      enabled: true,
      env: this.environment,
      options: { configComponent: this.configComponent },
    });

    // ========================================================================
    // 5. AgentComponent (with configPath for agent config loading)
    // ========================================================================
    this.agentComponent = new core.AgentComponent();
    await this.agentComponent.init({
      name: 'agent',
      version: '1.0.0',
      enabled: true,
      env: this.environment,
      options: {
        configComponent: this.configComponent,
        configPath: DEFAULT_CONFIG_FILE,
      },
    });

    // ========================================================================
    // 6. LogTraceComponent
    // ========================================================================
    this.logTraceComponent = new core.LogTraceComponent();
    await this.logTraceComponent.init({
      name: 'log-trace',
      version: '1.0.0',
      enabled: true,
      env: this.environment,
      options: { 
        configComponent: this.configComponent,
        configPath: DEFAULT_CONFIG_FILE,
      },
    });

    // ========================================================================
    // 7. PromptComponent
    // ========================================================================
    this.promptComponent = new core.PromptComponent();
    await this.promptComponent.init({
      name: 'prompt',
      version: '1.0.0',
      enabled: true,
      env: this.environment,
      options: { configComponent: this.configComponent },
    });

    // ========================================================================
    // 8. TaskComponent
    // ========================================================================
    this.taskComponent = new core.TaskComponent();
    await this.taskComponent.init({
      name: 'task',
      version: '1.0.0',
      enabled: true,
      env: this.environment,
      options: { configComponent: this.configComponent },
    });

    // ========================================================================
    // 9. SkillComponent
    // ========================================================================
    this.skillComponent = new core.SkillComponent();
    await this.skillComponent.init({
      name: 'skill',
      version: '1.0.0',
      enabled: true,
      env: this.environment,
      options: { configComponent: this.configComponent },
    });

    // ========================================================================
    // 10. McpComponent - must be after ToolComponent
    // ========================================================================
    this.mcpComponent = new core.McpComponent();
    await this.mcpComponent.init({
      name: 'mcp',
      version: '1.0.0',
      enabled: true,
      env: this.environment,
      options: { configComponent: this.configComponent },
    });

    // ========================================================================
    // 11. CommandsComponent
    // ========================================================================
    this.commandsComponent = new core.CommandsComponent();
    await this.commandsComponent.init({
      name: 'commands',
      version: '2.0.0',
      enabled: true,
      env: this.environment,
      options: { configComponent: this.configComponent },
    });

    // ========================================================================
    // 12. MemoryComponent (with MemoryPlugin)
    // ========================================================================
    this.memoryPlugin = new core.MemoryPlugin(process.cwd(), {
      enabled: true,
    });
    await this.memoryPlugin.initialize();

    this.memoryComponent = new core.MemoryComponent();
    await this.memoryComponent.init({
      name: 'memory',
      version: '1.0.0',
      enabled: true,
      env: this.environment,
      options: { configComponent: this.configComponent, memoryPlugin: this.memoryPlugin },
    });

    // ========================================================================
    // 13. EventSourceComponent
    // ========================================================================
    this.eventSourceComponent = new core.EventSourceComponent();
    await this.eventSourceComponent.init({
      name: 'event-source',
      version: '1.0.0',
      enabled: true,
      env: this.environment,
      options: { configComponent: this.configComponent },
    });

    // ========================================================================
    // 14. WorkflowComponent - depends on ToolComponent, LLMComponent, SkillComponent
    // ========================================================================
    this.workflowComponent = new core.WorkflowComponent();
    await this.workflowComponent.init({
      env: this.environment,
      options: {
        configComponent: this.configComponent,
        toolComponent: this.toolComponent,
        llmComponent: this.llmComponent,
        logTraceComponent: this.logTraceComponent,
        skillRegistry: this.skillComponent,
      },
    });

    // ========================================================================
    // Register all base components with environment (in order)
    // ========================================================================
    this.environment.registerComponent(this.configComponent);
    this.environment.registerComponent(this.sessionComponent);
    this.environment.registerComponent(this.llmComponent);
    this.environment.registerComponent(this.toolComponent);
    this.environment.registerComponent(this.agentComponent);
    this.environment.registerComponent(this.logTraceComponent);
    this.environment.registerComponent(this.promptComponent);

    // Sync registry agents after prompt registration (CLI pattern)
    await this.agentComponent.syncRegistryAgentsFromConfig();

    this.environment.registerComponent(this.taskComponent);
    this.environment.registerComponent(this.skillComponent);
    this.environment.registerComponent(this.mcpComponent);
    this.environment.registerComponent(this.commandsComponent);
    this.environment.registerComponent(this.memoryComponent);
    this.environment.registerComponent(this.eventSourceComponent);
    this.environment.registerComponent(this.workflowComponent);

    // ========================================================================
    // 15. PluginComponent - must be after all other components
    // ========================================================================
    this.pluginComponent = new core.PluginComponent();
    await this.pluginComponent.init({
      env: this.environment,
      options: { configComponent: this.configComponent },
    });
    this.environment.registerComponent(this.pluginComponent);

    // ========================================================================
    // DesktopComponent (Desktop-specific, registered before env.init/start)
    // ========================================================================
    this.desktopComponent = new DesktopComponent({
      configComponent: this.configComponent,
      ipcSender: this.ipcSender || undefined,
    });
    await this.desktopComponent.init({
      name: 'desktop',
      version: '1.0.0',
      enabled: true,
      env: this.environment,
    });
    this.environment.registerComponent(this.desktopComponent);
    console.log('[DesktopEnvironment] DesktopComponent registered (before env.init)');

    // ========================================================================
    // Initialize and start environment
    // ========================================================================
    await this.environment.init();
    await this.environment.start();

    // Start WorkflowComponent after env.start() (CLI pattern)
    await this.workflowComponent.start();

    // Refresh agent dependencies after all components are started
    await this.agentComponent.refreshDependencies();
    console.log('[DesktopEnvironment] AgentComponent dependencies refreshed after env.start()');

    this.initialized = true;
    console.log('[DesktopEnvironment] Created successfully');
  }

  /**
   * Handle user query
   */
  async handleQuery(
    query: string,
    context?: { sessionId?: string; agentType?: string }
  ): Promise<string> {
    if (!this.environment) {
      throw new Error('Environment not initialized');
    }

    return this.environment.handle_query(query, {
      sessionId: context?.sessionId,
      agentType: context?.agentType,
    } as any);
  }

  /**
   * Get environment status
   */
  getStatus(): { initialized: boolean; envName?: string } {
    return {
      initialized: this.initialized,
      envName: this.environment?.name,
    };
  }

  /**
   * Set IPC sender for forwarding events to renderer
   */
  setIpcSender(sender: IpcSender): void {
    this.ipcSender = sender;
    // Update DesktopComponent IPC sender if already initialized
    if (this.desktopComponent) {
      (this.desktopComponent as any).ipcSender = sender;
    }
  }

  /**
   * Get DesktopComponent instance
   */
  getDesktopComponent(): DesktopComponent | null {
    return this.desktopComponent;
  }

  /**
   * Subscribe to Environment events via DesktopComponent
   * Call this after IPC sender is set up
   */
  subscribeToEvents(): void {
    if (this.environment && this.desktopComponent) {
      this.environment.subscribe(this.desktopComponent.getEventHandler());
      console.log('[DesktopEnvironment] Subscribed to Environment events via DesktopComponent');
    }
  }

  /**
   * Dispose the environment (aligned with CLI)
   */
  async dispose(): Promise<void> {
    if (this.environment) {
      try {
        await this.environment.stop();
      } catch {
        // ignore
      }
    } else {
      // Stop all components in reverse order (same as CLI)
      const components = [
        this.desktopComponent,
        this.pluginComponent,
        this.eventSourceComponent,
        this.memoryComponent,
        this.commandsComponent,
        this.mcpComponent,
        this.skillComponent,
        this.taskComponent,
        this.promptComponent,
        this.logTraceComponent,
        this.agentComponent,
        this.toolComponent,
        this.sessionComponent,
        this.llmComponent,
        this.workflowComponent,
      ];
      for (const component of components) {
        if (component && typeof (component as any).stop === 'function') {
          try {
            await (component as any).stop();
          } catch {
            // ignore
          }
        }
      }
    }

    this.configComponent?.shutdown?.();
    const core = await import('@ai-setting/roy-bot-core');
    core.resetTracerProvider();
    core.closeDatabase();

    this.environment = null;
    this.configComponent = null;
    this.sessionComponent = null;
    this.llmComponent = null;
    this.toolComponent = null;
    this.agentComponent = null;
    this.logTraceComponent = null;
    this.promptComponent = null;
    this.taskComponent = null;
    this.skillComponent = null;
    this.mcpComponent = null;
    this.commandsComponent = null;
    this.memoryComponent = null;
    this.memoryPlugin = null;
    this.eventSourceComponent = null;
    this.workflowComponent = null;
    this.pluginComponent = null;
    this.desktopComponent = null;
    this.initialized = false;

    console.log('[DesktopEnvironment] Disposed');
  }
}

// Singleton instance
let environmentInstance: DesktopEnvironment | null = null;

/**
 * Get or create the singleton environment instance
 */
export function getEnvironment(): DesktopEnvironment {
  if (!environmentInstance) {
    environmentInstance = new DesktopEnvironment();
  }
  return environmentInstance;
}
