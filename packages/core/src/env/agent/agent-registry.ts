/**
 * @fileoverview AgentRegistry - Agent 配置注册与管理
 * 
 * 功能：
 * - 从配置文件加载 agent 定义
 * - 运行时注册/注销 agent
 * - 解析 systemPromptRef（引用 PromptComponent）
 * - 持久化 agent 配置到 YAML 文件
 * 
 * Agent 配置位置：
 * - 默认：~/.local/share/roy-bot/agents/
 * - 可通过 agent.configDir 配置覆盖
 */

import * as realFsPromises from "fs/promises";
import * as realFs from "fs";
import { join } from "path";
import type { ConfigComponent } from "../../config/config-component";
import type { PromptComponent } from "../prompt/prompt-component";
import { z } from "zod";
import yaml from "yaml";
import { getXDGPath } from "../paths";
import { createLogger } from "../log-trace/logger";
import { TracedAs } from "../log-trace/decorator";

const logger = createLogger("agent:registry");

// ============================================================================
// Types
// ============================================================================

/**
 * Agent 类型
 */
export type AgentType = "primary" | "sub" | "workflow";

/**
 * Agent 定义接口
 */
export interface AgentDefinition {
  /** Agent 名称（唯一标识） */
  name: string;
  /** Agent 类型 */
  type: AgentType;
  /** Agent 描述 */
  description?: string;
  /** 引用 PromptComponent 中的 prompt 名称 */
  systemPromptRef?: string;
  /** 内联 system prompt（systemPromptRef 优先） */
  systemPrompt?: string;
  /** 使用的模型 */
  model?: string;
  /** 最大迭代次数 */
  maxIterations?: number;
  /** 最大错误重试次数 */
  maxErrorRetries?: number;
  /** 允许的工具列表（白名单） */
  allowedTools?: string[];
  /** 拒绝的工具列表（黑名单） */
  deniedTools?: string[];
  /** 工具超时（毫秒） */
  toolTimeout?: number;
  /** 工具重试次数 */
  toolRetries?: number;
  /** 死循环检测阈值 */
  doomLoopThreshold?: number;
  /** 是否过滤 history 中的 tool 消息 */
  filterHistory?: boolean;
  /** 关联的已注册 workflow 名称（仅 type=workflow 时有效） */
  workflow?: string;
  /**
   * 入口 agent 名称（仅 type=workflow 时有效）
   *
   * 当 delegate_task 收到 workflow 类型 subagent 时，不会直接执行 workflow，
   * 而是委托给入口 agent（默认 "workflow-runner"）。
   * 入口 agent 负责通过 workflow run 命令执行实际 workflow。
   *
   * 背景：.roy/design/2026-06-29-workflow-subagent-entry-agent-design.md
   */
  entryAgent?: string;
}

/**
 * Agent 配置格式（YAML）
 */
export const AgentConfigSchema = z.object({
  name: z.string(),
  type: z.enum(["primary", "sub", "workflow"]),
  workflow: z.string().optional(),
  entryAgent: z.string().optional(),
  description: z.string().optional(),
  systemPromptRef: z.string().optional(),
  systemPrompt: z.string().optional(),
  model: z.string().optional(),
  maxIterations: z.number().optional(),
  maxErrorRetries: z.number().optional(),
  allowedTools: z.array(z.string()).optional(),
  deniedTools: z.array(z.string()).optional(),
  toolTimeout: z.number().optional(),
  toolRetries: z.number().optional(),
  doomLoopThreshold: z.number().optional(),
  filterHistory: z.boolean().optional(),
}).refine(
  (data) => data.type !== "workflow" || (data.workflow && data.workflow.length > 0),
  { message: "workflow is required when type is 'workflow'" }
);

export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/**
 * Export options
 */
export interface ExportOptions {
  format?: "json" | "yaml";
  includeSource?: boolean;
}

// ============================================================================
// AgentRegistry
// ============================================================================

/**
 * AgentRegistry - Agent 配置注册与管理中心
 * 
 * 负责：
 * - 加载 agent 配置文件
 * - 管理运行时 agent 注册
 * - 提供统一的 agent 查询接口
 * - 解析 systemPromptRef
 */
export class AgentRegistry {
  private agents: Map<string, AgentDefinition> = new Map();
  private configDir: string;
  private configComponent: ConfigComponent | null;
  private promptComponent: PromptComponent | null;
  private resolvePromptComponent?: () => PromptComponent | null;
  private fs: { existsSync: typeof import("fs")["existsSync"] };
  private fsPromises: { readdir: typeof import("fs/promises")["readdir"]; readFile: typeof import("fs/promises")["readFile"]; writeFile: typeof import("fs/promises")["writeFile"]; mkdir: typeof import("fs/promises")["mkdir"]; unlink: typeof import("fs/promises")["unlink"] };

  constructor(options: {
    configComponent: ConfigComponent | null;
    promptComponent?: PromptComponent | null;
    resolvePromptComponent?: () => PromptComponent | null;
    baseDir?: string;
    fs?: { existsSync: typeof import("fs")["existsSync"] };
    fsPromises?: { readdir: typeof import("fs/promises")["readdir"]; readFile: typeof import("fs/promises")["readFile"]; writeFile: typeof import("fs/promises")["writeFile"]; mkdir: typeof import("fs/promises")["mkdir"]; unlink: typeof import("fs/promises")["unlink"] };
  }) {
    this.configComponent = options.configComponent;
    this.promptComponent = options.promptComponent ?? null;
    this.resolvePromptComponent = options.resolvePromptComponent;
    this.fs = options.fs || realFs;
    this.fsPromises = options.fsPromises || realFsPromises;
    
    // 确定配置目录
    const customDir = this.configComponent?.get?.("agent.configDir");
    if (customDir && typeof customDir === "string" && customDir.length > 0) {
      this.configDir = customDir;
    } else if (options.baseDir) {
      // 使用指定的 baseDir
      this.configDir = join(options.baseDir, "agents");
    } else {
      // 使用 XDG data 路径（已包含 APP_NAME）
      this.configDir = join(getXDGPath("data"), "agents");
    }
    
    logger.debug(`[AgentRegistry] Config dir: ${this.configDir}`);
  }

  /**
   * 获取配置目录
   */
  getConfigDir(): string {
    return this.configDir;
  }

  /**
   * 检查 agent 是否存在
   */
  hasAgent(name: string): boolean {
    return this.agents.has(name);
  }

  /**
   * 获取 agent 定义
   */
  get(name: string): AgentDefinition | undefined {
    return this.agents.get(name);
  }

  /**
   * 列出所有 agent
   */
  list(): AgentDefinition[] {
    return Array.from(this.agents.values());
  }

  /**
   * 按类型列出 agent
   */
  listAgentsByType(type: AgentType): AgentDefinition[] {
    return this.list().filter(agent => agent.type === type);
  }

  /**
   * 注册 agent（运行时）
   */
  @TracedAs("agent.registry.register", { recordParams: true, recordResult: true, log: true })
  register(agent: AgentDefinition): void {
    if (!agent.name) {
      throw new Error("Agent name is required");
    }
    
    // ★ P3: Schema 校验 — 运行时注册也验证
    const validation = AgentConfigSchema.safeParse(agent);
    if (!validation.success) {
      throw new Error(
        `Invalid agent config for "${agent.name}": ${validation.error.issues.map(i => i.message).join("; ")}`
      );
    }
    
    this.agents.set(agent.name, { ...agent });
    logger.info(`[AgentRegistry] Registered agent: ${agent.name}`, { type: agent.type });
  }

  /**
   * 注销 agent（运行时）
   */
  @TracedAs("agent.registry.unregister", { recordParams: true, recordResult: true, log: true })
  unregister(name: string): boolean {
    const deleted = this.agents.delete(name);
    if (deleted) {
      logger.info(`[AgentRegistry] Unregistered agent: ${name}`);
    }
    return deleted;
  }

  /**
   * 清空所有 agent
   */
  @TracedAs("agent.registry.clear", { recordParams: false, recordResult: true, log: true })
  clear(): void {
    this.agents.clear();
    logger.info("[AgentRegistry] Cleared all agents");
  }

  /**
   * 获取 system prompt
   * 
   * 优先级：
   * 1. systemPromptRef（引用 PromptComponent）
   * 2. systemPrompt（内联）
   * 3. undefined
   */
  // system prompt 可达数十 KB，且原文在磁盘上 → 不入库
  @TracedAs("agent.registry.getSystemPrompt", { recordParams: true, recordResult: false, log: true })
  async getSystemPrompt(name: string): Promise<string | undefined> {
    const agent = this.agents.get(name);
    if (!agent) {
      return undefined;
    }

    const promptComponent = this.getActivePromptComponent();

    // 优先使用 systemPromptRef
    if (agent.systemPromptRef) {
      try {
        // 优先使用 getPrompt 方法（支持变量渲染 + 触发 prompt.after-render hook）
        // 这样 commands-prompt hook 可以注入 Commands Arsenal 到 prompt 中。
        //
        // ★ 2026-10-16：必须把 agent.type 透传下去 —— commands-prompt hook 只对
        //   primary（面向用户的入口 agent）注入 Commands Arsenal。子 agent
        //   （compact / compact-hint / json-extract / ...）不该看到 user-facing
        //   命令文档，否则 LLM 会去调它们没有的工具（→ `Tool not found: bash`）。
        if (promptComponent?.getPrompt) {
          const rendered = await promptComponent.getPrompt(agent.systemPromptRef, {}, {
            agentType: agent.type,
          });
          if (rendered) {
            logger.debug(`[AgentRegistry] Resolved systemPromptRef via getPrompt: ${agent.systemPromptRef}`);
            return rendered;
          }
        }

        // 回退：直接从 PromptComponent 获取原始内容（不触发 render/hook）
        const prompt = promptComponent?.get?.(agent.systemPromptRef);
        if (prompt) {
          logger.debug(`[AgentRegistry] Resolved systemPromptRef via get: ${agent.systemPromptRef}`);
          return prompt;
        }
        
        // 回退到内联 prompt
        if (agent.systemPrompt) {
          logger.debug(`[AgentRegistry] systemPromptRef not found, falling back to inline`);
          return agent.systemPrompt;
        }
        
        return undefined;
      } catch (error) {
        logger.warn(`[AgentRegistry] Failed to resolve systemPromptRef: ${agent.systemPromptRef}`, { error });
        // 回退到内联 prompt
        return agent.systemPrompt;
      }
    }

    // 使用内联 prompt
    return agent.systemPrompt;
  }

  /**
   * 同步获取内联 system prompt（不解析 systemPromptRef）
   */
  private getActivePromptComponent(): PromptComponent | null {
    return this.resolvePromptComponent?.() ?? this.promptComponent;
  }

  getInlineSystemPrompt(name: string): string | undefined {
    const agent = this.agents.get(name);
    if (!agent) {
      return undefined;
    }
    return agent.systemPrompt;
  }

  /**
   * 获取 workflow 类型 agent 关联的 workflow 名称
   */
  @TracedAs("agent.registry.getWorkflowName", { recordParams: true, recordResult: true })
  getWorkflowName(name: string): string | undefined {
    const agent = this.agents.get(name);
    if (!agent || agent.type !== "workflow") {
      return undefined;
    }
    return agent.workflow;
  }

  /**
   * 获取 workflow 类型 agent 关联的 entry-agent 名称
   *
   * 当 delegate_task 被调用时，workflow 类型的 subagent 不会被直接执行，
   * 而是委托给 entry-agent（默认 "workflow-runner"）。调用方应使用
   * `getEntryAgent(name) ?? "workflow-runner"` 作为兜底。
   *
   * 返回 undefined 的场景：
   * - agent 不存在
   * - agent 不是 workflow 类型（语义上不需要 entryAgent）
   * - agent 未显式配置 entryAgent
   *
   * 背景：.roy/design/2026-06-29-workflow-subagent-entry-agent-design.md
   */
  @TracedAs("agent.registry.getEntryAgent", { recordParams: true, recordResult: true })
  getEntryAgent(name: string): string | undefined {
    const agent = this.agents.get(name);
    if (!agent || agent.type !== "workflow") {
      return undefined;
    }
    return agent.entryAgent;
  }

  /**
   * 注册内置 workflow-runner (Task #2164 beta-compare)
   *
   * workflow-runner 是与 roy / explore 同层的 sub 类型子代理，
   * 负责: 用 workflow_* 工具调用 workflow_run 执行 workflow,
   * 支持 session resume (runId == sessionId) 和 stop。
   *
   * Task #2486 强调契约:
   * - **调用方必须传入 workflow_name**（prompt 中指定具体名字）
   *   **或 指示 sub-agent 自行 search-first**（调用 workflow_tag_list /
   *   workflow_search / workflow_list / workflow_get 选定）。
   * - 不允许绕过 workflow / 盲猜 workflow_name / 跳过 schema 验证。
   *
   * 对比 Task #2146 reference:
   * - reference 用 type=primary 充当 "调度中介"; beta 改为 sub 同层,
   *   与 #2151 M1/M2 review 一致 (避免中介语义 + hidden from agents list)。
   * - 显式 `deniedTools: [delegate_task, stop_task]` 防递归委托 (新增)。
   * - 显式 `systemPromptRef: workflow-runner` 强绑定 prompt (新增)。
   * - 显式 `maxIterations: 30` 防 #2151 M3 silent removal (新增 + 测试锁住)。
   * - Task #2486: description 显式强调 workflow_name 必传 + search-first 兜底
   *   (防 prompt 改了一处 description 没跟上)。
   *
   * 通过 allowedTools 限制只能使用 workflow 工具,
   * 避免 LLM 走捷径直接执行任务而不走 workflow run 路径。
   */
  @TracedAs("agent.registry.registerWorkflowRunner", {
    recordParams: false,
    recordResult: true,
    log: true,
  })
  registerWorkflowRunner(): void {
    const name = "workflow-runner";
    if (this.agents.has(name)) return; // 防止重复注册

    const agent: AgentDefinition = {
      name,
      type: "sub",
      // Task #2486: 强调 workflow_name 是必传的核心输入，缺名时强制走 search-first 兜底
      description:
        "Workflow runner — 接受带 workflow_name（必填）的委托，或指示其按 search-first 流程自行选定（workflow_tag_list + workflow_search + workflow_list + workflow_get），然后通过 workflow_run 执行 workflow；支持 session resume 和 stop；失败接管由 prompt 推理触发 (Task #2251)。**调用方必须在 prompt 中明确指定 workflow 名，或指示 sub-agent 自行搜索选择；禁止盲猜/绕过/跳过 schema 验证** (Task #2486)。",
      systemPromptRef: "workflow-runner",
      // Task #2247: 移除 allowedTools 白名单 — Roy 风格（除 deniedTools 外全部可用）。
      // workflow_* 工具通过 prompt 引导使用，不强制白名单。
      // deniedTools 防递归委托失控（deniedTools 安全约束不变）。
      deniedTools: ["delegate_task", "stop_task"],
      maxIterations: 30,
    };

    this.agents.set(name, agent);
  }

  /**
   * 注册内置 task-organizer agent (Task #2348)
   *
   * task-organizer 是 Roy 系统的"任务树整理"子智能体 (type=sub)，专门负责
   * 维护任务树形态健康：
   *
   * 1. **根任务收敛**：非归档的根任务维持在 10-20 个
   * 2. **根任务 longterm 化**：根任务 100% 为 longterm 类型
   * 3. **重新挂载**：把非 longterm 类型的根任务 re-parent 到语义匹配的 longterm 父任务下
   * 4. **合并 / 归档 / 删除**：处理重复、过期、纯测试任务
   *
   * 工具白名单（15 个任务管理工具）：
   * - 6 个核心 CRUD：task_create / task_get / task_list / task_update / task_delete / task_complete
   * - 2 个观察工具：task_tree / task_search
   * - 2 个批量操作：task_batch_archive / task_batch_delete
   * - 5 个 operation 工具：task_operation_create / get / list / update / delete
   *
   * deniedTools 禁止递归委托（防整理器自己再起子代理导致失控）。
   *
   * 使用方式：
   * - CLI: `roy-bot act "整理任务" --agent task-organizer`
   * - 父 agent: `delegate_task(subagent_type="task-organizer", ...)`
   *
   * 默认 systemPrompt 来自 builtInPrompts['task-organizer']，会被
   * `~/.local/share/roy-bot/prompts/task-organizer.md` 覆盖。
   */
  @TracedAs("agent.registry.registerTaskOrganizer", {
    recordParams: false,
    recordResult: true,
    log: true,
  })
  registerTaskOrganizer(): void {
    const name = "task-organizer";
    if (this.agents.has(name)) return; // 防止重复注册

    const agent: AgentDefinition = {
      name,
      type: "sub",
      description:
        "任务树整理子智能体 — 把非 longterm 类型的根任务重新挂载到 longterm 父任务下，根任务收敛到 10-20 个；维护任务树形态健康（re-parent / merge / archive / delete）。Task #2348。",
      systemPromptRef: "task-organizer",
      // 15 个任务管理工具白名单（核心 CRUD + 观察 + 批量 + operation）
      // 包含 task_tree / task_search / task_batch_* 等任务整理场景必需工具
      allowedTools: [
        // 6 个核心 CRUD
        "task_create",
        "task_get",
        "task_list",
        "task_update",
        "task_delete",
        "task_complete",
        // 2 个观察工具（多颗粒度查看树形 / 关键词搜索）
        "task_tree",
        "task_search",
        // 2 个批量操作
        "task_batch_archive",
        "task_batch_delete",
        // 5 个 operation 工具
        "task_operation_create",
        "task_operation_get",
        "task_operation_list",
        "task_operation_update",
        "task_operation_delete",
      ],
      // 禁止递归委托 + 禁止 stop_task 防失控
      deniedTools: ["delegate_task", "stop_task"],
      maxIterations: 30,
    };

    this.agents.set(name, agent);
  }

  /**
   * 注册内置 json-extract agent
   *
   * json-extract 是 workflow 结构化输出（output.mode=json）专用的子智能体，
   * 由 workflow-json-output-plugin 在 agent:after.react hook 中调用：
   *
   *   agentComponent.run('json-extract', '', {
   *     sessionId,            // 复用主 session 读 history
   *     extraTools: [submit], // 动态注入 workflow_submit_output
   *     persistSession: false, // 不污染 session
   *     abort,
   *   })
   *
   * 设计要点：
   * - type='sub'：一次性调用的子 agent
   * - systemPromptRef='json-extract'：从 builtInPrompts 解析
   * - allowedTools=['workflow_submit_output']：唯一可用工具
   * - maxIterations=5：允许最多 5 次 tool call（provider 不支持 toolChoice=required 时多次重试）
   * - filterHistory=false：必须看到父 session 的全部历史
   */
  registerJsonExtractAgent(): void {
    const name = "json-extract";
    if (this.agents.has(name)) return; // 防止重复注册

    const agent: AgentDefinition = {
      name,
      type: "sub",
      description:
        "JSON 提取子智能体 — 从对话历史中提取结构化 JSON，通过 workflow_submit_output 工具提交",
      systemPromptRef: "json-extract",
      allowedTools: ["workflow_submit_output"],
      deniedTools: [],
      maxIterations: 5,
      filterHistory: false,
    };

    this.agents.set(name, agent);
  }

  /**
   * 注册内置 workflow-extract agent
   *
   * workflow-extract 是 task completion 时从对话历史提取 Workflow 的子智能体，
   * 由 task-tag-plugin 在 task:operation:after.create (completed) hook 中调用：
   *
   *   agentComponent.run('workflow-extract', input, {
   *     sessionId,            // 复用主 session 读 history
   *     persistSession: false, // 不污染 session
   *     abort,
   *   })
   *
   * 设计要点：
   * - type='sub'：一次性调用的子 agent
   * - systemPromptRef='workflow-extract'：从 builtInPrompts 解析
   * - allowedTools=['workflow_get','workflow_list','workflow_add','workflow_validate']：
   *   严格限制为 workflow 工具，避免走捷径
   * - maxIterations=10：允许 generate→validate→fix→add 的迭代循环
   * - filterHistory=false：必须看到父 session 的全部历史
   *
   * 注：用户原始描述提到 'workflow_nodes'，但该工具目前不存在；
   * workflow_get 已能查看任意 workflow 的节点结构，故不引入该工具。
   */
  registerWorkflowExtractAgent(): void {
    const name = "workflow-extract";
    if (this.agents.has(name)) return; // 防止重复注册

    const agent: AgentDefinition = {
      name,
      type: "sub",
      description:
        "Workflow 提取子智能体 — 从父 task 的对话历史中分析需求，迭代式生成并验证 Workflow YAML",
      systemPromptRef: "workflow-extract",
      allowedTools: [
        "workflow_get",
        "workflow_list",
        "workflow_add",
        "workflow_validate",
      ],
      deniedTools: [],
      maxIterations: 10,
      filterHistory: false,
    };

    this.agents.set(name, agent);
  }

  /**
   * 注册内置 workflow-creator (Task #2194)
   *
   * workflow-creator 是与 workflow-runner / workflow-extract 同层的 sub 类型子代理，
   * 专门负责与用户**多轮对话式**协作构建 workflow。
   *
   * 与 workflow-extract 的差异:
   * - workflow-extract: 从已完成 task 对话历史**自动**提取 workflow (one-shot)
   * - workflow-creator: 与用户**多轮对话**，协作设计 + 迭代验证 + 注册 (interactive)
   *
   * 设计要点：
   * - type='sub'：作为 subagent 可被 delegate_task 委托
   * - systemPromptRef='workflow-creator'：从 builtInPrompts 解析
   * - allowedTools=6 个：workflow_list / workflow_get / workflow_search /
   *   workflow_tag_list / workflow_validate / workflow_add
   *   （比 workflow-extract 多 workflow_search + workflow_tag_list）
   * - deniedTools=['delegate_task','stop_task']：禁止嵌套委托（与 roy/explore 一致）
   * - maxIterations=30：支持多轮工具调用（澄清需求→学习→设计→validate→add）
   *
   * 调用方：default 接待员 agent 在用户说"帮我建一个 workflow"时 delegate 过来。
   */
  @TracedAs("agent.registry.registerWorkflowCreator", {
    recordParams: false,
    recordResult: true,
    log: true,
  })
  registerWorkflowCreator(): void {
    const name = "workflow-creator";
    if (this.agents.has(name)) return; // 防止重复注册

    const agent: AgentDefinition = {
      name,
      type: "sub",
      description:
        "Workflow 构建子智能体 — 与用户多轮交互式协作设计、验证并注册 workflow",
      systemPromptRef: "workflow-creator",
      allowedTools: [
        // —— 设计/注册 workflow ——
        "workflow_list",
        "workflow_get",
        "workflow_search",
        "workflow_tag_list",
        "workflow_validate",
        "workflow_add",
        // ★ 2026-10-16：补齐「构建后自验」能力。
        //
        // 背景（Task #4263）：workflow-creator 交付过假阳性 workflow ——
        // 脚本名拼接错 / 回退脚本空跑 / 硬编码 "Total 99 PASS 99" 被 aggregate
        // 当真值，结果是 0/0/0 却报 PASS。归因是「只有 DAG 结构校验，缺少语义校验 +
        // 端到端真跑验证」，而**当时它连跑的能力都没有**：
        //   - 白名单里没有 bash → 无法核对真实脚本路径 / grep 输出标记（契约真实性）
        //   - 白名单里没有 workflow_run → 无法做构建后冒烟
        //
        // 注意这组工具是**修好 delegate 身份 bug（commit 4430815b）之后才真正生效**的：
        // 此前 sub-agent 一律降级为 general、白名单从未被应用，所以它"意外"拿到了
        // bash/workflow_run。若只修身份不补白名单，会从「降级能跑」变成
        // 「身份正确但无法冒烟」—— 故两件事必须配套。
        "bash",                 // 契约真实性校验（ls 真实脚本名 / grep 输出标记）
        "read_file",            // 读脚本内容核对输出格式
        "workflow_run",         // 构建后冒烟真跑（硬门槛）
        "workflow_run_status",  // 轮询冒烟终态
      ],
      // 递归委托禁止：sub-agent 不得再委托，避免无限套娃
      deniedTools: ["delegate_task", "stop_task"],
      // ★ 30 → 60：冒烟真跑 + 失败回环修复需要更多轮次（Task #4263 §4.2 建议）
      maxIterations: 60,
    };

    this.agents.set(name, agent);
  }

  /**
   * 注册内置 compact agent
   *
   * compact 是 session 压缩专用的子 agent，由 SessionComponent.compact() 调用：
   *
   *   agentComponent.run('compact', scenarioHint, {
   *     sessionId,            // 复用主 session 读 history
   *     persistSession: false, // 不污染 session
   *   })
   *
   * 设计要点：
   * - type='sub'：一次性调用的子 agent
   * - systemPromptRef='compact'：从 builtInPrompts 解析
   * - allowedTools=['workflow_submit_output']：唯一可用工具
   * - maxIterations=3：给「首轮没调对 tool」留**一次真正的重试**机会
   *   （2026-10-16 修复：原为 1，首轮失败即终局）
   *
   *   ★ 为什么是 3 而不是 2：max-iteration-reminder 插件在
   *   `iteration === maxIterations - 1` 注入「已达最大迭代，别再调工具」提醒。
   *     - maxIterations=1 → 插件防御性跳过（单轮无前置迭代）
   *     - maxIterations=2 → 在 iteration 1 就注入「别再调工具」，把唯一的重试机会掐死
   *     - maxIterations=3 → 提醒落在 iteration 2，因此 iteration 2 是干净的一次重试，
   *       只有 iteration 3 才被提醒压制
   *   与 json-extract 对齐（它用 5，注释同为「provider 不支持 toolChoice=required 时
   *   多次重试」）——这是同一个问题的既有先例。
   * - filterHistory=false：必须看到父 session 的全部历史
   */
  registerCompactAgent(): void {
    const name = "compact";

    const agent: AgentDefinition = {
      name,
      type: "sub",
      description:
        "压缩子智能体 — 从父 session 的历史消息中提取结构化 checkpoint JSON",
      systemPromptRef: "compact",
      // ★ Task #4933（C 方案）：无工具 —— 纯自然语言直出 checkpoint 正文
      allowedTools: [],
      deniedTools: [],
      maxIterations: 3,
      filterHistory: false,
    };

    // ★ Task #4933（MAJOR 缺口修复）：内置 compact agent 的**工具白名单不可被
    //   用户级 yaml 覆盖**。
    //
    //   背景：initRegistry() 先 `await this.registry.load()`（加载
    //   ~/.local/share/roy-bot/agents/*.yaml），**之后**才 registerCompactAgent()。
    //   原实现首行 `if (this.agents.has(name)) return;` 会让内置注册被跳过
    //   → 用户级 agents/compact.yaml 完全 SHADOW 内置定义。
    //   若用户 yaml 不写 allowedTools → agent-component.ts 的
    //   `if (allowedTools !== undefined && allowedTools !== null)` 不成立
    //   → **不做白名单过滤** → 压缩 agent 拿到全量 Roy 工具集，
    //   与 C 方案「无工具纯自然语言直出」语义冲突（且显著拖慢压缩）。
    //
    //   修复：内置注册**总是覆盖**同名用户定义，但保留用户可自定义的
    //   展示性字段（description），并强制 allowedTools=[] / deniedTools=[]。
    //   （工具白名单是安全/语义边界，不开放给用户级 yaml。）
    const existing = this.agents.get(name);
    if (existing) {
      this.agents.set(name, {
        ...agent,
        // 保留用户自定义的描述（展示性字段，允许覆盖）
        description: existing.description ?? agent.description,
      });
      logger.info(
        `[AgentRegistry] Built-in compact agent overrode user-level definition ` +
        `(tool whitelist enforced: allowedTools=[])`
      );
      return;
    }

    this.agents.set(name, agent);
  }

  /**
   * 注册内置 compact-hint agent
   *
   * compact-hint 是 session 压缩的第一阶段子 agent（Phase 1），
   * 由 SessionComponent.generateCompactHint() 调用：
   *
   *   agentComponent.run('compact-hint', 'Analyze this conversation and generate a compact guidance prompt', {
   *     sessionId,
   *     persistSession: false,
   *   })
   *
   * 设计要点：
   * - type='sub'：一次性调用的子 agent
   * - systemPromptRef='compact-hint'：从 builtInPrompts 解析
   * - allowedTools=[]：纯文本 JSON 输出，无需工具
   * - maxIterations=3：同 compact —— 给首轮没调对 tool 留一次真正的重试机会
   *   （2026-10-16 修复：原为 1；判定依据详见 registerCompactAgent 的说明）
   * - filterHistory=false：读取父 session 全部历史
   */
  registerCompactHintAgent(): void {
    const name = "compact-hint";

    const agent: AgentDefinition = {
      name,
      type: "sub",
      description:
        "压缩提示子智能体 — 分析父 session 历史，生成场景化压缩指导提示",
      systemPromptRef: "compact-hint",
      // ★ Task #4933（C 方案）：无工具 —— 纯自然语言直出 hint
      allowedTools: [],
      deniedTools: [],
      maxIterations: 3,
      filterHistory: false,
    };

    // ★ Task #4933：同 registerCompactAgent —— 内置 compact-hint 的工具白名单
    //   不可被用户级 yaml 覆盖（否则 phase1 会拿到全量 Roy 工具集）。
    const existing = this.agents.get(name);
    if (existing) {
      this.agents.set(name, {
        ...agent,
        description: existing.description ?? agent.description,
      });
      logger.info(
        `[AgentRegistry] Built-in compact-hint agent overrode user-level definition ` +
        `(tool whitelist enforced: allowedTools=[])`
      );
      return;
    }

    this.agents.set(name, agent);
  }

  /**
   * 注册内置 roy agent
   *
   * roy 是 Roy Intelligent OS 的核心子智能体（type='sub'），
   * 提供通用 AI 助手能力：编码、研究、规划、执行、工具使用。
   *
   * 设计要点：
   * - type='sub'：作为 subagent 可被 delegate_task(subagent_type="roy") 调用
   * - systemPromptRef='roy'：从 builtInPrompts['roy'] 解析（bundle-time 内置 prompt）
   * - deniedTools=['delegate_task','stop_task','task_complete']：禁止嵌套 delegation（与 general/explore 一致）
   *   ★ Task #5007 — 加 task_complete：验收权移交 default agent（裁判 ≠ 运动员）。
   *     roy 只负责**执行 + 更新操作记录/进度**；进度达 100% 即视为完成并结束返回，
   *     最终验收（task:after.complete 的 goal 检查 decision model）由 default agent 触发。
   * - 不设 allowedTools：保留 roy 的通用工具能力
   * - 不设 maxIterations：使用默认上限
   *
   * 用户体验：
   * - 新装用户无需 `agent add roy` 即可在 `roy-bot agents list` 中看到 roy
   * - `delegate_task(subagent_type="roy")` 开箱即用
   * - 用户可在 ~/.local/share/roy-bot/agents/roy.yaml 自定义覆盖（默认配置会被覆盖）
   *
   * 实现路径：与 workflow-runner / json-extract / workflow-extract / compact / compact-hint 保持一致
   * （registry 内置 + systemPromptRef 引用 builtInPrompts）。
   */
  registerRoyAgent(): void {
    const name = "roy";
    if (this.agents.has(name)) return; // 防止重复注册

    const agent: AgentDefinition = {
      name,
      type: "sub",
      description:
        "Roy — versatile AI assistant inspired by Jarvis. Built-in general-purpose subagent for coding, research, planning, and complex multi-step tasks. Always available without `agent add roy`.",
      systemPromptRef: "roy",
      // ★ Task #5007 — task_complete / task_cancel 移交 default agent（验收权分离）。
      //   roy 保留 task_create / task_update / task_operation_create（执行 + 记操作记录）。
      //   ★ Task #5073 — task_pre_complete **不禁用**：两阶段验收的提交口
      //     （执行方干完活 → 提交待验证 to_validate → default agent task_complete）。
      //   task_cancel 同样禁用：取消任务也属验收侧能力（运动员不该能抹掉自己的失败）。
      deniedTools: ["delegate_task", "stop_task", "task_complete", "task_cancel"],
    };

    this.agents.set(name, agent);
  }

  /**
   * 加载配置目录中的所有 agent
   */
  @TracedAs("agent.registry.load", { recordParams: false, recordResult: true, log: true })
  async load(): Promise<number> {
    try {
      return await this.loadFromDirectory(this.configDir);
    } catch (error) {
      logger.warn(`[AgentRegistry] Failed to load agents: ${error}`);
      return 0;
    }
  }

  /**
   * 从目录加载 agent 配置文件
   */
  @TracedAs("agent.registry.loadFromDirectory", { recordParams: true, recordResult: true, log: true })
  async loadFromDirectory(directory: string): Promise<number> {
    let loaded = 0;

    try {
      // 检查目录是否存在
      if (!this.fs.existsSync(directory)) {
        logger.debug(`[AgentRegistry] Config directory does not exist: ${directory}`);
        return 0;
      }

      const files = await this.fsPromises.readdir(directory, { withFileTypes: true });
      
      for (const file of files) {
        const fullPath = join(directory, file.name);
        
        // 跳过目录
        if (file.isDirectory()) {
          continue;
        }
        
        if (!isAgentConfigFile(file.name)) {
          continue;
        }

        try {
          const content = await this.fsPromises.readFile(fullPath, "utf-8");
          const agent = this.parseAgentConfig(content, fullPath);
          
          if (agent) {
            this.agents.set(agent.name, agent);
            logger.info(`[AgentRegistry] Loaded agent: ${agent.name} from ${file.name}`);
            loaded++;
          }
        } catch (error) {
          logger.warn(`[AgentRegistry] Failed to load agent from ${file.name}: ${error}`);
        }
      }

      logger.info(`[AgentRegistry] Loaded ${loaded} agents from ${directory}`);
    } catch (error) {
      logger.warn(`[AgentRegistry] Error reading config directory: ${error}`);
    }

    return loaded;
  }

  /**
   * 解析 YAML 配置
   */
  private parseAgentConfig(content: string, source: string): AgentDefinition | null {
    try {
      const parsed = yaml.parse(content);
      const result = AgentConfigSchema.safeParse(parsed);
      if (!result.success) {
        logger.warn(`[AgentRegistry] Invalid agent config: ${source}`, {
          errors: result.error.errors,
        });
        return null;
      }
      return result.data;
    } catch (error) {
      logger.error(`[AgentRegistry] Failed to parse agent config: ${source}`, { error });
      return null;
    }
  }

  /**
   * 保存 agent 到配置文件
   */
  async saveAgent(agent: AgentDefinition): Promise<boolean> {
    try {
      // ★ P1: Schema 校验 — 写入前验证
      const validation = AgentConfigSchema.safeParse(agent);
      if (!validation.success) {
        logger.error(`[AgentRegistry] Invalid agent config for "${agent.name}": ${validation.error.message}`);
        return false;
      }

      // 确保目录存在
      await this.ensureConfigDir();
      
      const yamlContent = this.agentToYaml(agent);
      const filePath = join(this.configDir, `${agent.name}.yaml`);
      
      await this.fsPromises.writeFile(filePath, yamlContent, "utf-8");
      
      // 更新内存中的注册表
      this.agents.set(agent.name, agent);
      
      logger.info(`[AgentRegistry] Saved agent: ${agent.name} to ${filePath}`);
      return true;
    } catch (error) {
      logger.error(`[AgentRegistry] Failed to save agent: ${agent.name}`, { error });
      return false;
    }
  }

  /**
   * 确保配置目录存在
   */
  private async ensureConfigDir(): Promise<void> {
    if (!this.fs.existsSync(this.configDir)) {
      await this.fsPromises.mkdir(this.configDir, { recursive: true });
      logger.debug(`[AgentRegistry] Created config directory: ${this.configDir}`);
    }
  }

  /**
   * 将 agent 转换为 YAML 格式
   */
  private agentToYaml(agent: AgentDefinition): string {
    const config: AgentConfig = {
      name: agent.name,
      type: agent.type,
      ...(agent.description !== undefined ? { description: agent.description } : {}),
      ...(agent.systemPromptRef !== undefined ? { systemPromptRef: agent.systemPromptRef } : {}),
      ...(agent.systemPrompt !== undefined ? { systemPrompt: agent.systemPrompt } : {}),
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      ...(agent.maxIterations !== undefined ? { maxIterations: agent.maxIterations } : {}),
      ...(agent.maxErrorRetries !== undefined ? { maxErrorRetries: agent.maxErrorRetries } : {}),
      ...(agent.allowedTools !== undefined ? { allowedTools: agent.allowedTools } : {}),
      ...(agent.deniedTools !== undefined ? { deniedTools: agent.deniedTools } : {}),
      ...(agent.toolTimeout !== undefined ? { toolTimeout: agent.toolTimeout } : {}),
      ...(agent.toolRetries !== undefined ? { toolRetries: agent.toolRetries } : {}),
      ...(agent.doomLoopThreshold !== undefined ? { doomLoopThreshold: agent.doomLoopThreshold } : {}),
      ...(agent.filterHistory !== undefined ? { filterHistory: agent.filterHistory } : {}),
      ...(agent.workflow !== undefined ? { workflow: agent.workflow } : {}),
      ...(agent.entryAgent !== undefined ? { entryAgent: agent.entryAgent } : {}),
    };
    return yaml.stringify(config).trimEnd() + "\n";
  }

  /**
   * 删除 agent 配置文件
   */
  async deleteAgent(name: string): Promise<boolean> {
    const agent = this.agents.get(name);
    if (!agent) {
      logger.warn(`[AgentRegistry] Agent not found: ${name}`);
      return false;
    }

    try {
      const filePath = join(this.configDir, `${name}.yaml`);
      
      // 检查文件是否存在
      if (this.fs.existsSync(filePath)) {
        await this.fsPromises.unlink(filePath);
        logger.info(`[AgentRegistry] Deleted agent file: ${filePath}`);
      }
      
      // 从内存中移除
      this.agents.delete(name);
      
      return true;
    } catch (error) {
      logger.error(`[AgentRegistry] Failed to delete agent: ${name}`, { error });
      return false;
    }
  }

  /**
   * 导出所有 agent
   */
  exportAgents(options: ExportOptions = {}): AgentDefinition[] {
    const agents = this.list();
    
    if (options.format === "json") {
      // 返回 JSON 字符串
      return agents as unknown as AgentDefinition[];
    }
    
    return agents;
  }

  /**
   * 导出为 JSON 字符串
   */
  exportAgentsAsJson(): string {
    return JSON.stringify(this.list(), null, 2);
  }

  /**
   * 获取 agent 数量
   */
  size(): number {
    return this.agents.size;
  }

  /**
   * 检查配置目录是否存在
   */
  configDirExists(): boolean {
    return this.fs.existsSync(this.configDir);
  }

  /**
   * 获取 agent 配置文件路径
   */
  getAgentFilePath(name: string): string {
    return join(this.configDir, `${name}.yaml`);
  }
}

// ============================================================================
// Default SubAgent Prompt（用于内置 subagent 的默认 prompt）
// ============================================================================

function isAgentConfigFile(fileName: string): boolean {
  return fileName.endsWith(".yaml") || fileName.endsWith(".yml");
}

export const DEFAULT_SUBAGENT_PROMPT = `You are a subagent created by the main agent to handle a specific task.

## Your Role
- You were created to handle: {task_description}
- Complete this task. That's your entire purpose.
- You are NOT the main agent. Don't try to be.

## Rules
1. **Stay focused** - Do your assigned task, nothing else
2. **Complete the task** - Your final message will be automatically reported to the main agent
3. **Don't initiate** - No heartbeats, no proactive actions, no side quests
4. **Be ephemeral** - You may be terminated after task completion. That's fine.
5. **No nested delegation** - Do NOT use delegate_task or stop_task tools. Complete the task yourself.

## Execution
- Use the available tools to complete the task
- If you need more information, ask the main agent through the result
- Return a clear summary of what you did and the results`;
