import { z, ZodType, ZodError } from "zod";

// ============================================================================
// Tool Context
// ============================================================================

/**
 * 沙箱配置
 */
export interface SandboxConfig {
  /** 是否启用沙箱 */
  enabled: boolean;
  /** 沙箱类型 */
  type: "native" | "docker";
  /** 动作过滤 */
  actionFilter?: {
    /** 包含的动作 */
    include?: string[];
    /** 排除的动作 */
    exclude?: string[];
  };
  /** 文件系统限制 */
  filesystem?: {
    /** 允许读取 */
    allowRead?: string[];
    /** 禁止读取 */
    denyRead?: string[];
    /** 允许写入 */
    allowWrite?: string[];
    /** 禁止写入 */
    denyWrite?: string[];
  };
  /** 网络限制 */
  network?: {
    /** 允许的域名 */
    allowedDomains?: string[];
    /** 禁止的域名 */
    deniedDomains?: string[];
  };
  /** Docker 配置 */
  docker?: {
    /** 镜像 */
    image?: string;
    /** 网络模式 */
    networkMode?: "bridge" | "host" | "none";
    /** 卷挂载 */
    volumes?: Record<string, string>;
  };
}

/**
 * 工具执行上下文
 */
export interface ToolContext {
  /** 工作目录 */
  workdir?: string;
  /** 用户 ID */
  user_id?: string;
  /** 会话 ID */
  session_id?: string;
  /** 消息 ID */
  message_id?: string;
  /** 中断信号 */
  abort?: AbortSignal;
  /**
   * Task #4623 — 本次 run 使用的模型（`providerId/modelId`）。
   *
   * 由 AgentComponent 从 `ctx.context.model` 透传给工具，使
   * `delegate_task` 能把父 agent 的模型继承给 sub-agent。
   */
  model?: string;
  /**
   * Task #4623 — 兜底模型（`providerId/modelId`）。
   *
   * 主模型调用失败（404 / 429 / 配额 / 5xx / 超时 / 重试耗尽）时自动切换。
   */
  fallbackModel?: string;
  /**
   * Task #4724 — 兜底模型**有序列表**（`providerId/modelId`），顺序 = 优先级。
   *
   * 主模型失败时按顺序逐个尝试，全部失败才报错。
   */
  fallbackModels?: string[];
  /** 额外元数据 */
  metadata?: Record<string, unknown>;
  /** 沙箱配置 */
  sandbox?: SandboxConfig;
  /** 沙箱 Provider */
  sandboxProvider?: unknown | null;
}

// ============================================================================
// Tool Result
// ============================================================================

/**
 * 工具结果元数据
 */
export interface ToolResultMetadata {
  /** 执行时间（毫秒） */
  execution_time_ms: number;
  /** 输出大小（字节） */
  output_size?: number;
  /** 标准输出 */
  stdout?: string;
  /** 标准错误 */
  stderr?: string;
  /** 退出码 */
  exit_code?: number;
  /** Token 使用量 */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens?: number;
  };
  /** 输出是否被截断 */
  output_truncated?: boolean;
  /** 原始输出大小（截断前，单位：字符） */
  original_output_size?: number;
  /** 截断后输出大小（单位：字符） */
  truncated_output_size?: number;
  /** 额外元数据 */
  [key: string]: unknown;
}

/**
 * 工具执行结果
 */
export interface ToolResult {
  /** 是否成功 */
  success: boolean;
  /** 输出内容 */
  output: string | Record<string, unknown>;
  /** 错误信息 */
  error?: string;
  /** 结果元数据 */
  metadata?: ToolResultMetadata;
}

// ============================================================================
// Tool Definition
// ============================================================================

/**
 * 工具元数据
 */
export interface ToolMetadata {
  /** 分类 */
  category?: string;
  /** 标签 */
  tags?: string[];
  /** 版本 */
  version?: string;
  /** 作者 */
  author?: string;
  /** 是否实验性 */
  experimental?: boolean;
  /** MCP 工具信息（MCP adapter 使用） */
  mcpTool?: {
    originalName: string;
    originalDescription: string;
    inputSchema?: unknown;
  };
  /**
   * 允许使用该工具的 agent 名称白名单（2026-07 新增）。
   *
   * 设计目标：让某些"工具仅对特定 agent 可见"，例如：
   * - `query_background_process`：只给 default 接待员 agent 使用（因为只有它会委托任务）
   * - 其他 agent（roy / strict-task-agent / explore 等）看不到这个工具，行为不变
   *
   * 匹配规则（listTools filter `allowedAgent` 时）：
   * - `undefined` 或空数组：所有 agent 可见（向后兼容）
   * - 非空数组：当 `allowedAgent` 命中数组中任一元素时可见
   * - 字符串精确匹配，大小写敏感
   *
   * 注意：这是**工具自身的可见性声明**，与 agent 配置中的 `allowedTools`（白名单）、
   * `deniedTools`（黑名单）是**正交**的。两者共同决定最终可见工具集：
   *   1. 工具声明自己允许的 agent（这里）
   *   2. agent 自己声明 allowedTools / deniedTools
   *   3. ToolComponent.listTools({ allowedAgent }) 一次过滤；agent-component 再做 allowedTools/deniedTools 二次过滤
   */
  allowedAgentTypes?: string[];
  /**
   * ★ Task #5333 — 渠道专用工具标记（channel-only tool）。
   *
   * `true` = 该工具**只对特定事件源渠道**有意义，默认对所有 agent 不可见；
   * 只有当前会话的 `AgentContext.extendTools` 显式列出该工具名时才可见。
   *
   * 典型用例：`wecom_respond`（企微出站唯一通道）——
   * 在飞书会话 / 交互式 CLI 里调用必然失败（无企微 chatId，无 wecom 注册表实例），
   * 但它原先在 `getAllBuiltInTools()` 全局注册且无可见性声明 →
   * 所有 agent（含 default 接待员）都被注入了它，LLM 会误调。
   *
   * 与 `allowedAgentTypes` 的区别：
   * - `allowedAgentTypes` 按 **agent 身份** 过滤（谁可见）
   * - `channelOnly` 按 **会话渠道上下文** 过滤（哪个事件源驱动的这一轮可见）
   *
   * 两者正交，都满足才可见。实际判定顺序见 `filterToolsByAgent`：
   * **先 channelOnly**（渠道上下文），**再 allowedAgentTypes**（agent 身份）。
   *
   * ⚠️ 可见性只在 `AgentComponent.getAvailableTools` 一处收敛
   * （`filterToolsByAgent`）。`ToolRegistry.listTools()` 是**存储目录**
   * （`roy-bot tools list` / 调试用），不做 channelOnly 过滤 ——
   * 否则"无 filter 全量返回、有 filter 却隐藏"会造成同一工具在不同
   * 查询路径下存在性不一致。
   */
  channelOnly?: boolean;
  /**
   * Whether this tool explicitly opts out of string output truncation.
   *
   * `true` preserves the complete string output, including the temp-file
   * fallback path in `ToolComponent.execute()`. Use this for tools whose
   * output IS the deliverable (e.g. metadata readers like `workflow_get`):
   * silently truncating their payload defeats the user's intent.
   *
   * `false` or `undefined` preserves the default 5KB cap and truncation
   * notice for backward compatibility.
   */
  skipTruncation?: boolean;
}

/**
 * 工具沙箱配置
 */
export interface ToolSandboxConfig {
  /** 是否启用沙箱 */
  enabled: boolean;
  /** 沙箱配置 */
  config?: Partial<SandboxConfig>;
}

/**
 * 工具权限配置
 */
export interface ToolPermissionConfig {
  /** 是否需要用户确认 */
  requireConfirmation?: boolean;
  /** 权限级别 */
  level?: "safe" | "dangerous" | "critical";
}

/**
 * 工具信息
 */
export interface ToolInfo<Parameters extends ZodType = ZodType> {
  /** 工具名称 */
  name: string;
  /** 工具描述 */
  description: string;
  /** 参数 Schema */
  parameters: Parameters;
  /** 初始化函数（可选） */
  init?: (ctx?: ToolContext) => Promise<void>;
  /** 执行函数 */
  execute: (args: z.infer<Parameters>, ctx: ToolContext) => Promise<ToolResult>;
  /** 参数验证错误格式化（可选） */
  formatValidationError?: (error: ZodError) => string;
  /** 沙箱配置 */
  sandbox?: ToolSandboxConfig;
  /** 权限配置 */
  permission?: ToolPermissionConfig;
  /** 工具元数据 */
  metadata?: ToolMetadata;
}

/**
 * 工具类型别名
 */
export type Tool = ToolInfo;

// ============================================================================
// Tool Registration
// ============================================================================

/**
 * 工具注册来源
 */
export type ToolSource = "built-in" | "plugin" | "dynamic";

/**
 * 工具注册信息
 */
export interface ToolRegistration {
  /** 工具实例 */
  tool: Tool;
  /** 注册时间 */
  registeredAt: number;
  /** 注册来源 */
  source: ToolSource;
  /** 是否启用 */
  enabled: boolean;
}

// ============================================================================
// Tool Execution
// ============================================================================

/**
 * 工具执行请求
 */
export interface ToolExecuteRequest {
  /** 工具名称 */
  name: string;
  /** 参数 */
  args: Record<string, unknown>;
  /** 上下文 */
  context: ToolContext;
  /** 是否跳过 Hook */
  skipHooks?: boolean;
}

// ============================================================================
// Tool List Filter
// ============================================================================

/**
 * 工具列表过滤器
 */
export interface ToolListFilter {
  /** 按名称过滤（支持 glob） */
  name?: string | string[];
  /** 按分类过滤 */
  category?: string;
  /** 按标签过滤 */
  tags?: string[];
  /** 按来源过滤 */
  source?: ToolSource;
  /** 只返回启用的工具 */
  enabledOnly?: boolean;
  /** 排除的工具 */
  exclude?: string[];
  /**
   * 按 agent 名称过滤（2026-07 新增，工具级 agent-可见性过滤）
   *
   * 工作原理：
   * - 若 tool.metadata.allowedAgentTypes 为 undefined 或 [] → 该工具对所有 agent 可见
   * - 若 tool.metadata.allowedAgentTypes 非空 → 仅当 allowedAgent 命中数组中任一字符串时返回
   * - 字符串精确匹配，大小写敏感
   *
   * 调用方传入 agent.name（如 "default"、"roy"、"strict-task-agent"），
   * 通常由 AgentComponent.getAvailableTools(agent) 内部传入。
   */
  allowedAgent?: string;
}

// ============================================================================
// Validation Result
// ============================================================================

/**
 * 参数验证结果
 */
export interface ValidationResult {
  /** 是否成功 */
  success: boolean;
  /** 验证后的数据 */
  data?: Record<string, unknown>;
  /** 错误信息 */
  error?: string;
}
