import { z } from "zod";
import {
  BaseComponent,
  type ComponentConfig,
} from "../component";
import type {
  Tool,
  ToolContext,
  ToolResult,
  ToolResultMetadata,
  ToolExecuteRequest,
  ToolListFilter,
  ToolRegistration,
} from "./types";
import { ToolRegistry } from "./registry";
import { ToolValidator, setToolReasonConfigComponent } from "./validator";
import { createLogger } from "../log-trace/logger";
import { TracedAs } from "../log-trace/decorator";
import { toolInvokeParamFilter, toolExecResultFilter } from "../log-trace/trace-filters";
import { globalHookManager, ToolHookPoints } from "../hook/global-hook-manager";
import type { ConfigComponent } from "../../config/config-component";
import { toEnvKey, envKeyToConfigKey } from "../../config/env-key";
import { TOOL_CONFIG_REGISTRATION, TOOL_DEFAULTS } from "./tool-config-registration";
import { AskUserError } from "../workflow/types/workflow-hil";
import { isToolUnavailableError } from "../constants";
import { getCurrentTaskId } from "../context/env-context";
import { TempFileManager } from "../../utils/temp-file-manager";

// 创建日志器
const logger = createLogger("tool");

// ============================================================================
// ConfigComponent 实例（用于实时配置读取）
// ============================================================================

/**
 * ConfigComponent 实例（用于实时配置读取）
 * 在 init() 时由外部设置
 */
let configComponentInstance: any = null;

/**
 * 设置 ConfigComponent 实例
 */
export function setToolConfigComponent(component: any): void {
  configComponentInstance = component;
}

/**
 * 获取工具输出最大长度配置（支持热更新）
 * 
 * 配置路径: tool.execution.maxOutputSize
 * 默认值: 5120 (5KB) — 与 LLM Token 窗口匹配，避免工具输出过大占用上下文
 * 
 * @returns 最大输出大小（字节），0 表示不限制
 */
export function getMaxOutputSize(): number {
  if (configComponentInstance) {
    const maxOutputSize = configComponentInstance.get("tool.execution.maxOutputSize");
    if (typeof maxOutputSize === "number" && maxOutputSize >= 0) {
      return maxOutputSize;
    }
  }
  // 默认值：5KB
  return 5120;
}

/**
 * 截断工具输出
 *
 * v5.0: 移除了 v4.6.0 的 ITERATION_TASK_TRIGGER_BEGIN/END marker 识别逻辑。
 *       AutoTaskPlugin v5.0 不再向 tool result 注入 metadata，
 *       而是推送 user 消息，因此 truncateOutput 不需要识别任何 plugin-specific marker。
 *       按原行为截断：保留前 maxSize 字符 + 添加截断通知。
 *
 * @param output 原始输出
 * @param maxSize 最大输出大小
 * @returns 截断后的输出和元数据更新
 */
export function truncateOutput(
  output: string,
  maxSize: number
): { output: string; metadata: Partial<ToolResultMetadata> } {
  if (maxSize <= 0 || output.length <= maxSize) {
    return {
      output,
      metadata: {},
    };
  }

  // 按原行为截断（v5.0 移除 marker 分支）
  const truncatedOutput = output.substring(0, maxSize);
  const truncationNotice = `\n\n[OUTPUT TRUNCATED: ${output.length} → ${maxSize} characters. Use offset/limit parameters or pipe to file for full content.]`;

  return {
    output: truncatedOutput + truncationNotice,
    metadata: {
      output_truncated: true,
      original_output_size: output.length,
      truncated_output_size: maxSize,
    },
  };
}

/**
 * Per-tool default overrides for maxOutputSize.
 *
 * Most tools share the global `tool.execution.maxOutputSize` limit (5KB by
 * default) — but a handful of tools routinely produce much larger outputs and
 * benefit from a larger ceiling. The map below gives those tools a sensible
 * per-tool cap while keeping the default conservative for everything else.
 *
 * The map is intentionally small. New entries should be added only with a
 * clear reason (e.g. "always reads full files of any size").
 */
export const TOOL_MAX_OUTPUT_SIZE_OVERRIDES: Record<string, number> = {
  grep: 51_200,      // 50KB - grep often emits large multi-file results
  read_file: 204_800, // 200KB - reading a file is an explicit user-driven act
  glob: 10_240,       // 10KB - file listings in large repos
};

/**
 * Look up the effective maxOutputSize for a given tool. Resolution order:
 *   1. explicit `overrideMaxSize` (used by tests & Power Users)
 *   2. `TOOL_MAX_OUTPUT_SIZE_OVERRIDES[toolName]`
 *   3. global `tool.execution.maxOutputSize` via config component
 *   4. fallback default 5120
 */
export function getMaxOutputSizeForTool(
  toolName?: string,
  overrideMaxSize?: number
): number {
  if (typeof overrideMaxSize === "number" && overrideMaxSize >= 0) {
    return overrideMaxSize;
  }
  if (toolName && TOOL_MAX_OUTPUT_SIZE_OVERRIDES[toolName] !== undefined) {
    return TOOL_MAX_OUTPUT_SIZE_OVERRIDES[toolName];
  }
  return getMaxOutputSize();
}

/**
 * Inline truncation helper for execution paths that bypass `ToolComponent.execute()`.
 *
 * Two production code paths currently call `tool.execute()` directly instead of
 * routing through `ToolComponent`:
 *   (A) `AgentComponent.executeTool` `isExtraTool` branch
 *   (B) `AgentComponent.executeTool` fallback branch (no ToolComponent)
 *
 * Each of those paths previously skipped truncation entirely. This helper replicates
 * the truncation step that `ToolComponent.execute()` performs, so the two bypass
 * paths re-enter the same safety net without restructuring the call sites.
 *
 * Resolution precedence for the cap:
 *   1. `maxSize` argument (explicit call-site override, wins)
 *   2. `TOOL_MAX_OUTPUT_SIZE_OVERRIDES[toolName]` if `toolName` is supplied
 *   3. global `tool.execution.maxOutputSize` via config component
 *   4. fallback default 5120
 *
 * Tool authors can also opt out of truncation entirely by setting
 * `metadata.skipTruncation === true` on their Tool. When the optional
 * `tool` argument is supplied and carries that flag, the helper returns
 * a shallow clone of the source result without touching `output` or
 * `error` — mirroring the central `ToolComponent.execute()` short-circuit.
 * WorkflowToolNode no longer calls this helper (it deliberately preserves
 * raw payloads for the workflow data layer); only the two AgentComponent
 * bypass paths above use it now.
 *
 * `truncateOutputInline` returns a new ToolResult (the input is shallow-cloned)
 * to avoid surprising downstream mutators that reuse the original object.
 */
export function truncateOutputInline(
  result: ToolResult,
  maxSize?: number,
  overrideMaxSize?: number,
  toolName?: string,
  tool?: Tool
): ToolResult {
  // Cheap clone so callers can't observe unexpected mutations. We seed
  // `execution_time_ms` even when the source result had no metadata so
  // the cloned object satisfies the `ToolResultMetadata` contract that
  // every other call site assumes (required field).
  const cloned: ToolResult = {
    success: result.success,
    output: result.output,
    error: result.error,
    metadata: result.metadata
      ? { ...result.metadata }
      : { execution_time_ms: 0 },
  };

  // Tool authors can opt out of truncation via `metadata.skipTruncation`.
  // When the supplied tool carries the flag we return the shallow clone
  // untouched — covers both the success path's `output` and the failure
  // path's `error` string. This mirrors the central ToolComponent path.
  if (tool?.metadata?.skipTruncation) {
    return cloned;
  }

  const effectiveMax =
    typeof maxSize === "number"
      ? maxSize
      : getMaxOutputSizeForTool(toolName, overrideMaxSize);

  if (effectiveMax <= 0) {
    return cloned;
  }

  // Truncate the success path output if it is a string.
  if (typeof cloned.output === "string") {
    const truncated = truncateOutput(cloned.output, effectiveMax);
    cloned.output = truncated.output;
    cloned.metadata = {
      ...cloned.metadata,
      ...truncated.metadata,
    } as ToolResultMetadata;
  }

  // Errors can also balloon (e.g. a stack-trace from a deep failure) — apply the
  // same cap so they fit in the LLM context window as well.
  if (typeof cloned.error === "string" && cloned.error.length > effectiveMax) {
    const truncated = truncateOutput(cloned.error, effectiveMax);
    cloned.error = truncated.output;
    cloned.metadata = {
      ...cloned.metadata,
      ...truncated.metadata,
    } as ToolResultMetadata;
  }

  return cloned;
}

// ============================================================================
// ToolComponentOptions (统一配置机制)
// ============================================================================

/**
 * ToolComponent 配置选项（通过 options 传递）
 * 
 * 配置加载顺序（优先级从低到高）：
 * 1. File - 配置文件（通过 configPath 指定）
 * 2. Env - 环境变量（通过 envPrefix 配置前缀）
 * 3. Object - 直接传入的 config 对象（最高优先级）
 */
export interface ToolComponentOptions {
  /** ConfigComponent 实例（必填） */
  configComponent: ConfigComponent;
  
  /** 配置文件相对路径（可选，基于 XDG_DATA_HOME） */
  configPath?: string;
  
  /** 环境变量前缀（可选，默认 "TOOL"） */
  envPrefix?: string;
  
  /** 直接传入的配置对象（可选，优先级最高） */
  config?: Partial<ToolComponentConfig>;
}

/**
 * Tool Hook 上下文
 */
export interface ToolHookContext {
  tool?: Tool;
  args?: Record<string, unknown>;
  context?: ToolContext;
  result?: ToolResult;
}

/**
 * ToolComponent 配置
 */
export interface ToolComponentConfig {
  /** 工具目录 */
  toolsDir?: string;
  /** 内置工具 */
  builtInTools?: {
    enabled: boolean;
    loadAll?: boolean;
    names?: string[];
  };
  /** 沙箱配置 */
  sandbox?: {
    enabled: boolean;
    type: "native" | "docker";
    defaultConfig?: Record<string, unknown>;
  };
  /** 执行配置 */
  execution?: {
    timeout?: number;
    maxConcurrency?: number;
  };
}

/**
 * ToolComponent
 * 工具管理核心组件
 */
export class ToolComponent extends BaseComponent {
  readonly name = "tool";
  readonly version = "1.0.0";

  private registry: ToolRegistry;
  private validator: ToolValidator;
  private config?: ToolComponentConfig;
  
  /** ConfigComponent 用于配置管理 */
  private configComponent?: ConfigComponent;
  
  /** 配置变更 watcher 清理函数 */
  private configWatcher?: () => void;

  constructor() {
    super();
    this.registry = new ToolRegistry();
    this.validator = new ToolValidator();
  }

  // ========================================================================
  // Component Lifecycle
  // ========================================================================

  /**
   * 初始化组件
   * 
   * 配置加载优先级（从高到低）：
   * 1. Object - 直接传入的 config 对象
   * 2. Env - 环境变量（通过 envPrefix 配置前缀）
   * 3. File - 配置文件（通过 configPath 指定）
   */
  async init(config?: ComponentConfig): Promise<void> {
    // 调用基类 init，注入 env
    await super.init(config);

    // 从 options 获取 ConfigComponent
    const options = config?.options as unknown as ToolComponentOptions | undefined;
    if (!options?.configComponent) {
      throw new Error("ConfigComponent is required for ToolComponent initialization");
    }

    this.configComponent = options.configComponent;
    // 设置全局 ConfigComponent 实例供 getMaxOutputSize() 使用
    setToolConfigComponent(options.configComponent);
    // ★ Task #5422：接线 reason 逃生开关（tool.reason.required，实时读）
    setToolReasonConfigComponent(options.configComponent);
    await this.registerConfig(options);

    // 加载内置工具
    if (this.config?.builtInTools?.enabled !== false) {
      await this.loadBuiltInTools();
    }

    logger.info(`ToolComponent initialized with ${this.getToolCount()} tools`);
  }

  /**
   * 注册配置到 ConfigComponent
   * 
   * 配置加载顺序（优先级从低到高）：
   * 1. FileSource - 从配置文件加载（最低）
   * 2. EnvSource - 从环境变量加载（中等）
   * 3. MemorySource - 直接配置对象（最高）
   * 
   * 实现步骤：
   * 1. 使用 registerComponent(TOOL_CONFIG_REGISTRATION) 注册配置
   * 2. 使用 load("tool") 加载已注册的配置
   * 3. 设置 TOOL_DEFAULTS 默认值
   * 4. 处理环境变量后备方案
   * 5. 处理 config 对象（最高优先级）
   */
  private async registerConfig(options: ToolComponentOptions): Promise<void> {
    const configComponent = options.configComponent;
    if (!configComponent) return;

    const { configPath, envPrefix, config } = options;
    const prefix = envPrefix !== undefined ? envPrefix : "TOOL";

    // 1. 使用 registerComponent 注册配置（不包含 file source 和 defaults）
    configComponent.registerComponent(TOOL_CONFIG_REGISTRATION);

    // 2. 注册 FileSource（如果提供了 configPath）
    if (configPath) {
      configComponent.registerSource({
        type: "file",
        relativePath: configPath,
        optional: true,
        watch: false
      });
    }

    // 3. 使用 load("tool") 加载配置（从 file source 和 env source）
    await configComponent.load("tool");

    // 4. 处理环境变量后备方案（手动检查未捕获的环境变量）
    const toolKeys = [
      "tool.toolsDir",
      "tool.builtInTools.enabled",
      "tool.builtInTools.loadAll",
      "tool.builtInTools.names",
      "tool.sandbox.enabled",
      "tool.sandbox.type",
      "tool.sandbox.defaultConfig",
      "tool.execution.timeout",
      "tool.execution.maxConcurrency",
      "tool.reason.required",
    ];
    
    // 检查预定义的 toolKeys 对应的环境变量
    for (const key of toolKeys) {
      const envKey = toEnvKey(key, prefix);
      const value = process.env[envKey];
      if (value !== undefined) {
        await configComponent.set(key, value);
      }
    }
    
    // 自动发现其他以 prefix 开头的环境变量
    const envPrefixUpper = prefix.toUpperCase();
    for (const envKey of Object.keys(process.env)) {
      if (!envKey.startsWith(envPrefixUpper + "_")) continue;
      const configKey = envKeyToConfigKey(envKey, prefix, "tool");
      if (configKey && !toolKeys.includes(configKey)) {
        const value = process.env[envKey];
        if (value !== undefined) {
          await configComponent.set(configKey, value);
        }
      }
    }

    // 5. 设置默认值（只有当配置不存在时）
    for (const [key, value] of Object.entries(TOOL_DEFAULTS)) {
      if (configComponent.get(key) === undefined) {
        await configComponent.set(key, value);
      }
    }

    // 6. 处理 config 对象（最高优先级）
    if (config) {
      const flatConfig = this.flattenConfig(config);
      for (const [key, value] of Object.entries(flatConfig)) {
        await configComponent.set(key, value);
      }
    }

    // 7. 注册配置热更新监听
    this.registerConfigWatcher(configComponent);
    
    // 8. 解析最终配置
    const configData: Record<string, unknown> = {};
    for (const key of toolKeys) {
      const value = configComponent.get(key);
      if (value !== undefined) {
        configData[key.replace(/^tool\./, '')] = value;
      }
    }
    // 合并直接传入的 config（优先级更高）
    if (config) {
      Object.assign(configData, config);
    }
    
    const parsed = ToolComponentConfigSchema.safeParse(configData);
    if (parsed.success) {
      this.config = parsed.data as ToolComponentConfig;
    } else {
      // 回退到直接传入的 config
      this.config = config || {};
    }
  }

  /**
   * 将配置对象展平为点号路径
   */
  private flattenConfig(
    obj: Record<string, unknown>,
    prefix = "tool"
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
    
    this.configWatcher = configComponent.watch("tool.*", (event) => {
      this.onConfigChange(event);
    });
  }

  /**
   * 处理配置变更
   */
  protected onConfigChange(event: { key: string; oldValue?: unknown; newValue?: unknown }): void {
    logger.info(`Tool config changed: ${event.key}`, {
      oldValue: event.oldValue,
      newValue: event.newValue
    });
  }

  /**
   * 停止组件
   */
  async onStop(): Promise<void> {
    // 清理配置 watcher
    this.configWatcher?.();
    this.configWatcher = undefined;

    // ★ Task #5422：解除 reason 逃生开关的 ConfigComponent 接线，
    //   避免组件停止后仍持有失效引用（测试隔离同理）
    setToolReasonConfigComponent(null);

    this.setStatus("stopped");
  }

  // ========================================================================
  // Tool Registration
  // ========================================================================

  /**
   * 注册工具
   */
  register(tool: Tool, source: ToolRegistration["source"] = "dynamic"): void {
    // 执行 before.register hooks
    globalHookManager.execute(ToolHookPoints.BEFORE_REGISTER, { tool });

    this.registry.register(tool, {
      tool,
      registeredAt: Date.now(),
      source,
      enabled: true,
    });

    logger.debug(`Registered tool: ${tool.name}`);

    // 执行 after.register hooks
    globalHookManager.execute(ToolHookPoints.AFTER_REGISTER, { tool });
  }

  /**
   * 批量注册工具
   */
  registerMany(tools: Tool[], source: ToolRegistration["source"] = "dynamic"): void {
    for (const tool of tools) {
      this.register(tool, source);
    }
  }

  /**
   * 注销工具
   */
  unregister(name: string): boolean {
    return this.registry.unregister(name);
  }

  /**
   * 获取工具
   */
  getTool(name: string): Tool | undefined {
    return this.registry.getTool(name)?.tool;
  }

  // ========================================================================
  // Tool Discovery
  // ========================================================================

  /**
   * 列出工具
   */
  listTools(filter?: ToolListFilter): Tool[] {
    return this.registry.listTools(filter);
  }

  /**
   * 获取工具数量
   */
  getToolCount(): number {
    return this.registry.getCount();
  }

  /**
   * 检查工具是否存在
   */
  hasTool(name: string): boolean {
    return this.registry.has(name);
  }

  /**
   * 按分类获取工具
   */
  getToolsByCategory(category: string): Tool[] {
    return this.listTools({ category });
  }

  // ========================================================================
  // Tool Execution
  // ========================================================================

  /**
   * 执行工具
   *
   * errorIf：与 AgentComponent.executeTool 对齐 —— 只有「工具不存在 / 被禁用」
   * 才标 ERROR（配置错误），工具自身的运行时失败保持 OK 以免噪音淹没真问题。
   */
  @TracedAs("tool.component.execute", {
    paramFilter: toolInvokeParamFilter,
    resultFilter: toolExecResultFilter,
    logResult: true,
    log: true,
    errorIf: (result: ToolResult | undefined) => {
      const err = result?.error;
      // 判定逻辑集中在 constants.isToolUnavailableError（单一事实来源）
      if (result?.success === false && isToolUnavailableError(err)) {
        return new Error(String(err));
      }
      return undefined;
    },
  })
  async execute(request: ToolExecuteRequest): Promise<ToolResult> {
    const { name, args, context, skipHooks } = request;

    // 获取工具
    const registration = this.registry.getTool(name);
    if (!registration) {
      // ★ 2026-10-16：与 AgentComponent.executeTool 对齐 —— 这类失败是
      // 「调用方以为存在的工具其实没注册」的信号（prompt / 配置与实际工具表不一致），
      // 原来静默返回，trace 的 span status 仍是 ok，排查时完全看不到。
      logger.error(
        `[ToolComponent] Tool not found: "${name}" — ` +
        `registered tools: [${this.registry
          .listTools()
          .map((t: { name: string }) => t.name)
          .join(", ")}]`
      );
      return {
        success: false,
        output: "",
        error: `Tool not found: ${name}`,
      };
    }

    if (!registration.enabled) {
      return {
        success: false,
        output: "",
        error: `Tool disabled: ${name}`,
      };
    }

    const tool = registration.tool;

    // 执行 before.execute hooks
    if (!skipHooks) {
      await globalHookManager.execute(
        ToolHookPoints.BEFORE_EXECUTE,
        { tool, args, context },
        { toolName: tool.name }
      );
    }

    const startTime = Date.now();

    try {
      // 参数验证
      const validationResult = await this.validator.validate(tool, args);
      if (!validationResult.success) {
        return {
          success: false,
          output: "",
          error: validationResult.error,
          metadata: {
            execution_time_ms: Date.now() - startTime,
          },
        };
      }

      // 执行工具
      const result = await tool.execute(validationResult.data!, context);

      // 添加执行时间
      if (!result.metadata) {
        result.metadata = { execution_time_ms: Date.now() - startTime };
      } else {
        result.metadata.execution_time_ms = Date.now() - startTime;
      }

      // 截断输出（如果超过最大限制）
      if (typeof result.output === "string") {
        // skipTruncation metadata opt-in: tools like `workflow_get` declare
        // they must return their full payload. We still inject the current
        // Task ID below, but skip both truncation and temp-file writing.
        if (!tool.metadata?.skipTruncation) {
          const maxOutputSize = getMaxOutputSize();
          let fullOutput: string | null = null;
          if (maxOutputSize > 0) {
            // Save full output BEFORE truncation (for temp file write)
            fullOutput = result.output;
            const { output: truncatedOutput, metadata: truncationMeta } = truncateOutput(result.output, maxOutputSize);
            result.output = truncatedOutput;
            result.metadata = {
              ...result.metadata,
              ...truncationMeta,
            };

            // If output was actually truncated AND tool is not read_file,
            // save full content to a temp file so agent can use read_file to access it.
            if (
              truncationMeta.output_truncated === true &&
              tool.name !== "read_file" &&
              fullOutput !== null
            ) {
              try {
                const tempFilePath = await TempFileManager.getInstance().writeTempFile(
                  fullOutput,
                  tool.name,
                );
                result.metadata = {
                  ...result.metadata,
                  truncation_temp_file: tempFilePath,
                };
                result.output += `\n\n⚠️ 输出被截断（原 ${truncationMeta.original_output_size} 字符，截断到 ${truncationMeta.truncated_output_size} 字符）\n📁 完整内容保存到: ${tempFilePath}\n🔍 使用 read_file 工具按需读取`;
                logger.debug(
                  `[tool-component] Truncated output saved to temp file: ${tempFilePath} (${truncationMeta.original_output_size} bytes)`,
                );
              } catch (err) {
                logger.warn(
                  `[tool-component] Failed to write temp file for truncated output: ${err}`,
                );
                // Continue without temp file — truncation notice still in output
              }
            }
          }
        }

        // 注入当前 Task ID 到 tool 输出中，方便 LLM 感知当前任务上下文
        // 这对 workflow 场景特别重要——跨 agent node 时通过 agentContext 共享引用
        // 可以自动获取到 task_id，无需依赖 LLM 从文本中提取
        const currentTaskId = getCurrentTaskId();
        if (currentTaskId !== undefined) {
          result.output += `\n\n[当前 Task #${currentTaskId}]`;
          result.metadata = {
            ...result.metadata,
            current_task_id: currentTaskId,
          };
        }
      }

      // 执行 after.execute hooks
      if (!skipHooks) {
        await globalHookManager.execute(
          ToolHookPoints.AFTER_EXECUTE,
          { tool, args, context, result },
          { toolName: tool.name }
        );
      }

      return result;
    } catch (error) {
      // 检查是否是 AskUserError - 这是用于工作流暂停的特殊错误，需要向上传播
      // 以便 AgentComponent 和 WorkflowEngine 能够正确处理暂停逻辑
      if (error instanceof AskUserError) {
        throw error; // 重新抛出，让调用栈上层处理
      }

      const errorResult: ToolResult = {
        success: false,
        output: "",
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          execution_time_ms: Date.now() - startTime,
        },
      };

      // 执行 after.execute hooks（即使出错）
      if (!skipHooks) {
        await globalHookManager.execute(
          ToolHookPoints.AFTER_EXECUTE,
          { tool, args, context, result: errorResult },
          { toolName: tool.name }
        );
      }

      // 执行 on.error hooks
      if (!skipHooks) {
        await globalHookManager.execute(
          ToolHookPoints.ON_ERROR,
          { tool, args, context, error },
          { toolName: tool.name }
        );
      }

      return errorResult;
    }
  }

  // ========================================================================
  // Built-in Tools
  // ========================================================================

  /**
   * 加载内置工具
   */
  async loadBuiltInTools(): Promise<void> {
    try {
      const { getAllBuiltInTools } = await import("./built-in/index");
      const tools = getAllBuiltInTools();
      this.registerMany(tools, "built-in");
      logger.info(`Loaded ${tools.length} built-in tools`);
    } catch (err) {
      logger.warn(`Failed to load built-in tools: ${(err as Error).message}`);
    }
  }

  /**
   * 获取 Tool Hook 点列表
   */
  getHookPoints(): string[] {
    return [
      ToolHookPoints.BEFORE_EXECUTE,
      ToolHookPoints.AFTER_EXECUTE,
      ToolHookPoints.BEFORE_REGISTER,
      ToolHookPoints.AFTER_REGISTER,
      ToolHookPoints.ON_ERROR,
    ];
  }
}

// ========================================================================
// Config Schema
// ========================================================================

const ToolComponentConfigSchema = z.object({
  toolsDir: z.string().optional(),
  builtInTools: z
    .object({
      enabled: z.boolean().default(true),
      loadAll: z.boolean().default(true),
      names: z.array(z.string()).optional(),
    })
    .default({}),
  sandbox: z
    .object({
      enabled: z.boolean().default(false),
      type: z.enum(["native", "docker"]).default("native"),
      defaultConfig: z.record(z.unknown()).optional(),
    })
    .default({}),
  execution: z
    .object({
      timeout: z.number().int().positive().default(60000),
      maxConcurrency: z.number().int().positive().default(4),
    })
    .default({}),
});
