/**
 * Plugin Module
 *
 * Provides plugin registry and hook integration for coder enhancements.
 */

import type { Tool, ToolResult } from "@ai-setting/roy-bot-core";

// ============================================================================
// Types
// ============================================================================

/**
 * Tool hook context - passed to plugin hooks
 */
export interface ToolHookContext {
  tool?: Tool;
  args?: Record<string, unknown>;
  result?: ToolResult;
}

/**
 * Tool hook points
 */
export const ToolHookPoints = {
  AFTER_EXECUTE: "tool.after-execute",
  BEFORE_EXECUTE: "tool.before-execute",
} as const;

/**
 * Base plugin interface
 */
export interface BasePlugin {
  name: string;
  description?: string;
  version?: string;
}

/**
 * Tool plugin interface - hooks into tool execution
 */
export interface ToolPlugin extends BasePlugin {
  getHookPoint(): (typeof ToolHookPoints)[keyof typeof ToolHookPoints];
  shouldHandle?(context: ToolHookContext): boolean;
  onAfterExecute?(context: ToolHookContext): void | Promise<void>;
  onBeforeExecute?(context: ToolHookContext): void | Promise<void>;
}

/**
 * Plugin config from CLI
 */
export interface PluginConfig {
  name: string;
  config?: string;
}

/**
 * Parsed plugin arguments
 */
export interface PluginArgs {
  plugins: (string | PluginConfig)[];
  fileTypes: string[];
}

// ============================================================================
// Built-in Plugins
// ============================================================================

/**
 * Built-in plugin registry
 */
export const BUILTIN_PLUGINS = {
  lsp: "LSP code intelligence (diagnostics, completions)",
  "code-check": "External command code checking (linter + type check)",
  reminder: "Max iterations reminder for ReAct loop",
} as const;

/**
 * File type mappings for built-in plugins
 */
const FILE_TYPE_MAP: Record<string, string[]> = {
  typescript: [".ts", ".tsx"],
  javascript: [".js", ".jsx", ".mjs"],
  python: [".py"],
  rust: [".rs"],
  go: [".go"],
  java: [".java"],
  csharp: [".cs"],
};

// ============================================================================
// Plugin Manager
// ============================================================================

/**
 * Plugin registry for managing registered plugins
 */
export class PluginRegistry {
  private plugins: Map<string, ToolPlugin> = new Map();

  /**
   * Register a plugin
   */
  register(plugin: ToolPlugin): void {
    if (this.plugins.has(plugin.name)) {
      throw new Error(`Plugin '${plugin.name}' already registered`);
    }
    this.plugins.set(plugin.name, plugin);
  }

  /**
   * Unregister a plugin
   */
  unregister(name: string): boolean {
    return this.plugins.delete(name);
  }

  /**
   * Get a plugin by name
   */
  get(name: string): ToolPlugin | undefined {
    return this.plugins.get(name);
  }

  /**
   * Get all registered plugins
   */
  getAll(): ToolPlugin[] {
    return Array.from(this.plugins.values());
  }

  /**
   * Get plugins for a specific hook point
   */
  getByHookPoint(hookPoint: string): ToolPlugin[] {
    return this.getAll().filter((p) => p.getHookPoint() === hookPoint);
  }

  /**
   * Check if plugin is registered
   */
  has(name: string): boolean {
    return this.plugins.has(name);
  }

  /**
   * Clear all plugins
   */
  clear(): void {
    this.plugins.clear();
  }
}

// ============================================================================
// CLI Argument Parsing
// ============================================================================

/**
 * Parse plugin CLI arguments
 *
 * Formats:
 * - plugin-name (e.g., "lsp", "linter")
 * - plugin-name:config (e.g., "lsp:typescript", "linter:/path/to/eslintrc.json")
 * - /path/to/plugin.js (custom plugin)
 */
export function parseArgs(args: string[]): PluginArgs {
  const plugins: (string | PluginConfig)[] = [];
  const fileTypes = new Set<string>();

  for (const arg of args) {
    if (arg.startsWith("/") || arg.startsWith(".")) {
      // It's a file path
      plugins.push(arg);

      // Extract file type from path
      const ext = arg.match(/\.[^.]+$/)?.[0];
      if (ext) {
        fileTypes.add(ext);
      }
    } else if (arg.includes(":")) {
      // It's a plugin with config
      const [name, config] = arg.split(":", 2);
      plugins.push({ name, config: config || "" });

      // Extract file types from config
      if (FILE_TYPE_MAP[config]) {
        FILE_TYPE_MAP[config].forEach((t) => fileTypes.add(t));
      } else {
        // Try to extract extension from config
        const ext = config.match(/\.[^.]+$/)?.[0];
        if (ext) {
          fileTypes.add(ext);
        }
      }
    } else {
      // It's just a plugin name
      plugins.push(arg);
    }
  }

  return {
    plugins,
    fileTypes: Array.from(fileTypes),
  };
}

// ============================================================================
// Plugin Execution
// ============================================================================

/**
 * Execute a plugin hook
 */
export async function executePlugin(
  plugin: ToolPlugin,
  context: ToolHookContext
): Promise<void> {
  // Check if plugin should handle this context
  if (plugin.shouldHandle && !plugin.shouldHandle(context)) {
    return;
  }

  // Execute the appropriate hook
  const hookPoint = plugin.getHookPoint();
  if (hookPoint === ToolHookPoints.AFTER_EXECUTE && plugin.onAfterExecute) {
    await plugin.onAfterExecute(context);
  } else if (
    hookPoint === ToolHookPoints.BEFORE_EXECUTE &&
    plugin.onBeforeExecute
  ) {
    await plugin.onBeforeExecute(context);
  }
}

// ============================================================================
// Help
// ============================================================================

/**
 * Get the help message for plugin command
 */
export function getPluginHelp(): string {
  const lines = [
    "",
    "  --plugin <plugins>   Enable coder plugin",
    "",
    "  Built-in plugins:",
  ];

  for (const [name, desc] of Object.entries(BUILTIN_PLUGINS)) {
    lines.push(`    ${name.padEnd(12)} ${desc}`);
  }

  lines.push("", "  Plugin formats:", "    --plugin lsp                    # Enable LSP");
  lines.push("    --plugin lsp:typescript          # LSP for TypeScript");
  lines.push("    --plugin lsp:python              # LSP for Python");
  lines.push("    --plugin code-check             # Enable external command checking");
  lines.push("    --plugin reminder               # Enable iteration reminder");
  lines.push(
    "    --plugin /path/to/plugin.js          # Custom plugin"
  );
  lines.push(
    "    --plugin lsp code-check reminder    # Multiple plugins"
  );

  return lines.join("\n");
}
